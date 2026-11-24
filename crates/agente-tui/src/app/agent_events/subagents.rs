//! Subagent lifecycle, streaming progress, completion notices, and swarm board events.

use agente_core::agent::AgentEvent;
use agente_core::types::{AgentState, Role};

use crate::app::App;

impl App {
    pub(super) fn apply_subagent_event(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::BoardChanged { board } => {
                self.state.agent.board = Some(board);
                self.sync_swarm_lanes();
            }
            AgentEvent::SubagentStarted {
                id,
                subagent_type,
                description,
                model,
                seat,
            } => {
                let snapshot = self.state.subagent_registry.get(&id);
                let status = snapshot
                    .as_ref()
                    .map(|snap| snap.status.as_str().to_string())
                    .unwrap_or_else(|| "running".to_string());
                let meta = snapshot
                    .as_ref()
                    .map(|snap| (Some(snap.started_at), snap.worktree.clone()));
                let card_model = snapshot
                    .as_ref()
                    .map(|snap| snap.model_label())
                    .filter(|model| !model.is_empty())
                    .unwrap_or_else(|| {
                        agente_core::subagent::types::model_label(seat.as_deref(), &model)
                    });
                if let Some(card) = self.state.agent.subagents.get_mut(&id) {
                    card.subagent_type = subagent_type.clone();
                    card.description = description.clone();
                    card.status = status;
                    if !card_model.is_empty() {
                        card.model = card_model;
                    }
                    if let Some((started_at, worktree)) = meta {
                        if card.started_at.is_none() {
                            card.started_at = started_at;
                        }
                        card.worktree = worktree;
                    }
                } else {
                    let (started_at, worktree) = meta.unwrap_or((None, None));
                    self.state.agent.subagents.insert(
                        id.clone(),
                        crate::state::SubagentUiState {
                            subagent_type: subagent_type.clone(),
                            description: description.clone(),
                            status,
                            model: card_model,
                            started_at,
                            worktree,
                            ..Default::default()
                        },
                    );
                    self.state.session.add_subagent_entry(
                        id.clone(),
                        subagent_type.clone(),
                        description.clone(),
                    );
                }
                self.sync_swarm_lanes();
                tracing::info!(
                    subagent_id = %id,
                    subagent_type = %subagent_type,
                    "Subagent started"
                );
            }
            AgentEvent::SubagentText { id, text } => {
                let card = self.subagent_card_or_placeholder(&id);
                card.streaming_text.push_str(&text);
            }
            AgentEvent::SubagentToolCallStart {
                id,
                call_id,
                name,
                args,
            } => {
                let card = self.subagent_card_or_placeholder(&id);
                card.preparing_tool = None;
                card.tool_rows.push(crate::state::SubagentToolRow {
                    call_id,
                    name,
                    args,
                    result: None,
                    is_error: false,
                    finished: false,
                });
            }
            AgentEvent::SubagentToolCallProgress { id, call_id, chunk } => {
                if let Some(row) = self
                    .subagent_card_or_placeholder(&id)
                    .tool_rows
                    .iter_mut()
                    .rev()
                    .find(|row| row.call_id == call_id)
                {
                    let result = row.result.get_or_insert_with(String::new);
                    const MAX_SUBAGENT_TOOL_OUTPUT: usize = 16 * 1024;
                    let remaining = MAX_SUBAGENT_TOOL_OUTPUT.saturating_sub(result.len());
                    let end = chunk
                        .char_indices()
                        .map(|(index, _)| index)
                        .chain(std::iter::once(chunk.len()))
                        .take_while(|index| *index <= remaining)
                        .last()
                        .unwrap_or(0);
                    result.push_str(&chunk[..end]);
                }
            }
            AgentEvent::SubagentToolCallResult {
                id,
                call_id,
                name,
                result,
                is_error,
            } => {
                if let Some(row) = self
                    .subagent_card_or_placeholder(&id)
                    .tool_rows
                    .iter_mut()
                    .rev()
                    .find(|r| r.call_id == call_id || (call_id.is_empty() && r.name == name))
                {
                    row.result = Some(result);
                    row.is_error = is_error;
                    row.finished = true;
                }
            }
            AgentEvent::SubagentDone {
                id,
                summary,
                is_error,
            } => {
                self.state.agent.remove_approvals_from(
                    &agente_core::agent::ApprovalSource::Subagent { id: id.clone() },
                );
                let status = match (
                    is_error,
                    self.state
                        .agent
                        .subagents
                        .get(&id)
                        .map(|s| s.status.as_str()),
                ) {
                    (true, Some("cancelled")) => "cancelled",
                    (true, _) => "failed",
                    (false, _) => "completed",
                };
                let registry_snapshot = self.state.subagent_registry.get(&id);
                let card = self.subagent_card_or_placeholder(&id);
                card.status = status.to_string();
                card.summary = Some(summary.clone());
                card.finished_at = Some(chrono::Utc::now());
                if let Some(snap) = registry_snapshot {
                    card.worktree = snap.worktree.clone();
                    if card.model.is_empty() {
                        card.model = snap.model.clone();
                    }
                }
                if let Some(entry) = self
                    .state
                    .session
                    .chat_history
                    .iter_mut()
                    .find(|e| e.subagent_id.as_deref() == Some(id.as_str()))
                {
                    entry.is_error = is_error;
                    entry.content = summary.clone();
                }
                tracing::info!(
                    subagent_id = %id,
                    status = status,
                    "Subagent finished"
                );
            }
            AgentEvent::SubagentCompletedNotice {
                id,
                subagent_type,
                status,
                summary,
            } => {
                let text = agente_core::subagent::completion_notice_text(
                    &id,
                    &subagent_type,
                    &status,
                    &summary,
                );
                let mode_str = self.state.agent.current_turn_mode.to_string();
                self.state
                    .session
                    .add_assistant_message(text.clone(), mode_str, None, None);
                let turn_running = !matches!(
                    self.state.agent.state,
                    AgentState::Idle | AgentState::Error(_)
                );
                if turn_running {
                    self.state.session.queue_notice(text);
                } else {
                    self.state
                        .session
                        .conversation
                        .push(agente_core::types::Message {
                            role: Role::User,
                            content: text,
                            tool_calls: None,
                            tool_call_id: None,
                            thinking: None,
                            thinking_signature: None,
                            continuation: None,
                            attachments: Vec::new(),
                        });
                    let _ = self.start_chat_turn();
                }
                tracing::info!(
                    subagent_id = %id,
                    status = %status,
                    "Subagent completion notice injected"
                );
            }
            _ => {}
        }
    }

    /// True when a child's edits land in the parent workspace and may be
    /// tracked as parent changes.
    pub(super) fn subagent_shares_parent_workspace(&self, id: &str) -> bool {
        if let Some(snapshot) = self.state.subagent_registry.get(id) {
            return snapshot.worktree.is_none();
        }
        self.state
            .agent
            .subagents
            .get(id)
            .is_some_and(|card| card.worktree.is_none())
    }

    /// Live card for a child, materializing a placeholder when its
    /// `SubagentStarted` was missed.
    pub(super) fn subagent_card_or_placeholder(
        &mut self,
        id: &str,
    ) -> &mut crate::state::SubagentUiState {
        if !self.state.agent.subagents.contains_key(id) {
            self.state.agent.subagents.insert(
                id.to_string(),
                crate::state::SubagentUiState {
                    subagent_type: "unknown".to_string(),
                    description: "Subagent activity (start event missed)".to_string(),
                    status: "running".to_string(),
                    ..Default::default()
                },
            );
            self.state.session.add_subagent_entry(
                id.to_string(),
                "unknown".to_string(),
                "Subagent activity (start event missed)".to_string(),
            );
        }
        self.state
            .agent
            .subagents
            .get_mut(id)
            .expect("subagent card just inserted")
    }

    /// Give every subagent working a board card its lane (card, feeds, the
    /// newest finding touching it), so its transcript card reads as part of
    /// the swarm. Runs when the board changes and when a child appears.
    fn sync_swarm_lanes(&mut self) {
        let Some(board) = self.state.agent.board.as_ref() else {
            return;
        };
        for (id, card) in self.state.agent.subagents.iter_mut() {
            if let Some(lane) = crate::state::SwarmLane::of(board, id) {
                card.swarm = Some(lane);
            }
        }
    }
}
