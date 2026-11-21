//! Agent task event processing: tick drain, stale-task gating, and dispatch.

mod discovery;
mod subagents;
#[cfg(test)]
mod tests;
mod turn;

use agente_core::agent::AgentEvent;

use super::App;

/// Keep the UI fair under token/tool bursts. An unbounded drain can keep this
/// thread inside `try_recv` indefinitely while producers are faster than the
/// renderer, starving keyboard and mouse polling; filling the budget schedules
/// the next poll with a zero timeout, so input is still serviced between
/// batches while a large backlog drains quickly.
const MAX_AGENT_EVENTS_PER_TICK: usize = 1024;

impl App {
    /// Process a bounded event batch. Returns true when the budget was filled,
    /// which tells the run loop to poll input without blocking before draining
    /// the next batch.
    pub(super) fn process_agent_events(&mut self) -> bool {
        let mut processed = 0;
        while processed < MAX_AGENT_EVENTS_PER_TICK {
            let Ok(task_event) = self.agent_rx.try_recv() else {
                break;
            };
            processed += 1;
            self.route_agent_event(task_event);
        }
        processed == MAX_AGENT_EVENTS_PER_TICK
    }

    /// Apply one event to the tab whose state is in `self.state` (the
    /// active tab, or a background tab swapped in by `route_agent_event`).
    pub(super) fn apply_agent_event(&mut self, task_event: agente_core::agent::AgentTaskEvent) {
        let is_session_background_event = matches!(
            task_event.event,
            AgentEvent::SubagentStarted { .. }
                | AgentEvent::SubagentText { .. }
                | AgentEvent::SubagentToolCallStart { .. }
                | AgentEvent::SubagentToolCallProgress { .. }
                | AgentEvent::SubagentToolCallResult { .. }
                | AgentEvent::SubagentDone { .. }
                | AgentEvent::SubagentCompletedNotice { .. }
                | AgentEvent::BoardChanged { .. }
                | AgentEvent::GenerationProgress {
                    subagent_id: Some(_),
                    ..
                }
                | AgentEvent::FileChange {
                    subagent_id: Some(_),
                    ..
                }
                | AgentEvent::TodoUpdate {
                    subagent_id: Some(_),
                    ..
                }
                | AgentEvent::ApprovalRequested {
                    source: agente_core::agent::ApprovalSource::Subagent { .. },
                    ..
                }
        );
        let owned_background = is_session_background_event
            && self
                .tabs
                .active_owns(task_event.task_id, self.current_task_id);
        if task_event.task_id != 0
            && task_event.task_id != self.current_task_id
            && !owned_background
        {
            tracing::debug!(task_id = task_event.task_id, "Ignoring stale agent event");
            return;
        }

        let event = task_event.event;
        self.state.agent.mark_agent_event();
        if !matches!(
            &event,
            AgentEvent::CompactionStarted { .. } | AgentEvent::ToolHeartbeat { .. }
        ) {
            self.state.agent.compacting = None;
        }
        if !matches!(
            &event,
            AgentEvent::TextDelta(_)
                | AgentEvent::ReasoningDelta(_)
                | AgentEvent::ToolCallProgress { .. }
                | AgentEvent::SubagentText { .. }
                | AgentEvent::ToolHeartbeat { .. }
                | AgentEvent::SubagentToolCallProgress { .. }
                | AgentEvent::GenerationProgress { .. }
        ) {
            self.state.ui.needs_render = true;
        }

        match event {
            event @ (AgentEvent::ModelCatalogUpdated { .. }
            | AgentEvent::ModelsDiscovered { .. }
            | AgentEvent::ModelDiscoveryFailed { .. }) => {
                self.apply_discovery_event(event);
            }
            event @ (AgentEvent::BoardChanged { .. }
            | AgentEvent::SubagentStarted { .. }
            | AgentEvent::SubagentText { .. }
            | AgentEvent::SubagentToolCallStart { .. }
            | AgentEvent::SubagentToolCallProgress { .. }
            | AgentEvent::SubagentToolCallResult { .. }
            | AgentEvent::SubagentDone { .. }
            | AgentEvent::SubagentCompletedNotice { .. }) => {
                self.apply_subagent_event(event);
            }
            event => self.apply_turn_event(event),
        }
    }
}
