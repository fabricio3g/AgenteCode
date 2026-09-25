//! Agent task event processing.

use agente_core::agent::AgentEvent;
use agente_core::types::{self, AgentState, Role};

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
            // Discovery events use task_id 0; chat events must match the
            // current turn, otherwise they belong to a stale/canceled task.
            // Subagent events are exempt: background subagents legitimately
            // outlive the parent turn that spawned them.
            let is_subagent_event = matches!(
                task_event.event,
                AgentEvent::SubagentStarted { .. }
                    | AgentEvent::SubagentText { .. }
                    | AgentEvent::SubagentToolCallStart { .. }
                    | AgentEvent::SubagentToolCallProgress { .. }
                    | AgentEvent::SubagentToolCallResult { .. }
                    | AgentEvent::SubagentDone { .. }
                    | AgentEvent::SubagentCompletedNotice { .. }
                    | AgentEvent::GenerationProgress { subagent_id: Some(_), .. }
                    // Child-origin effects carry their source, so a late one
                    // from a previous turn is attributed, not confused with
                    // the parent's own events.
                    | AgentEvent::FileChange { subagent_id: Some(_), .. }
                    | AgentEvent::TodoUpdate { subagent_id: Some(_), .. }
                    // A child's own approval is tagged with its origin.
                    | AgentEvent::ApprovalRequested {
                        source: agente_core::agent::ApprovalSource::Subagent { .. },
                        ..
                    }
            );
            if task_event.task_id != 0
                && task_event.task_id != self.current_task_id
                && !is_subagent_event
            {
                tracing::debug!(task_id = task_event.task_id, "Ignoring stale agent event");
                continue;
            }
            let event = task_event.event;
            // Keep the stuck-guard clock fresh on every event so silent turns
            // (no thinking_start_time) still force-reset after STUCK_TIMEOUT.
            self.state.agent.mark_agent_event();
            // Streaming updates use the existing 33 ms animation paint cadence.
            // Marking every delta urgent bypasses that limiter and starves input
            // under bursts. Lifecycle changes still paint immediately.
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
                AgentEvent::Thinking => {
                    self.state.agent.preparing_tool = None;
                    if self.state.agent.thinking_start_time.is_none() {
                        self.state.agent.thinking_start_time = Some(chrono::Utc::now());
                    }
                    self.state.agent.streaming_text.clear();
                    self.state.agent.reasoning_text.clear();
                    self.state.agent.state = AgentState::StreamingResponse;
                }
                AgentEvent::AssistantText(text) => {
                    self.state.agent.retry_status = None;
                    self.state.agent.streaming_text.clear();
                    self.state.add_assistant_message(text);
                    self.state.agent.state = AgentState::Executing;
                }
                AgentEvent::TextDelta(delta) => {
                    self.state.agent.retry_status = None;
                    self.state.agent.streaming_text.push_str(&delta);
                }
                AgentEvent::ReasoningDelta(delta) => {
                    self.state.agent.retry_status = None;
                    self.state.agent.reasoning_text.push_str(&delta);
                }
                AgentEvent::GenerationProgress {
                    subagent_id,
                    tool_name,
                    ..
                } => {
                    if let Some(id) = subagent_id {
                        let child = self.subagent_card_or_placeholder(&id);
                        child.preparing_tool = tool_name;
                    } else {
                        self.state.agent.preparing_tool = tool_name;
                        self.state.agent.retry_status = None;
                    }
                }
                AgentEvent::Retry {
                    attempt,
                    max_attempts,
                    delay_ms,
                } => {
                    self.state.agent.retry_status = Some(crate::state::RetryStatus {
                        attempt,
                        max_attempts,
                        delay_ms,
                    });
                }
                AgentEvent::ToolCallStart { id, name, args } => {
                    self.state.agent.preparing_tool = None;
                    self.state.agent.current_tool_start = Some(std::time::Instant::now());
                    let direct = id.starts_with("direct-");
                    self.state
                        .agent
                        .start_live_tool(id, name.clone(), args.clone(), direct);
                    if !direct && name != "todo_write" {
                        self.state.add_tool_call(name, args);
                    }
                }
                AgentEvent::ToolCallProgress { id, chunk } => {
                    self.state.agent.append_live_tool_output(&id, &chunk);
                }
                AgentEvent::ToolHeartbeat { .. } => {
                    // Liveness only — the stuck-guard clock was already
                    // refreshed above; nothing to render.
                }
                AgentEvent::ToolCallResult {
                    id,
                    name,
                    result,
                    is_error,
                } => {
                    let live = self.state.agent.finish_live_tool(&id);
                    let duration_ms = self
                        .state
                        .agent
                        .current_tool_start
                        .take()
                        .map(|t| t.elapsed().as_millis() as f64);
                    if live.as_ref().map(|call| call.direct).unwrap_or(false) {
                        let command = live
                            .as_ref()
                            .and_then(|call| {
                                serde_json::from_str::<serde_json::Value>(&call.args)
                                    .ok()
                                    .and_then(|args| {
                                        args.get("command")
                                            .and_then(|value| value.as_str())
                                            .map(str::to_string)
                                    })
                            })
                            .unwrap_or_else(|| "shell".to_string());
                        let display = if result.trim().is_empty() {
                            "(no output)".to_string()
                        } else {
                            result.trim().to_string()
                        };
                        self.state
                            .add_system_message(format!("$ {command}\n{display}"));
                        self.state.agent.clear_stream_buffers();
                        self.state.agent.clear_approvals();
                        self.state.agent.end_parent_turn();
                        self.queue_session_snapshot();
                        self.drain_queues_and_continue();
                        continue;
                    }
                    // present_plan → store the plan but do NOT open the
                    // actionable card while the agent is still running. It is
                    // promoted to Review on the terminal event (Done/Error/
                    // Cancelled), so a live agent never shows a review card it
                    // could keep mutating under.
                    if !is_error && name == "present_plan" {
                        if let Some((path, title, body)) =
                            agente_core::tools::parse_plan_ready_output(&result)
                        {
                            self.state.plan_review.store_plan(path, title, body);
                            self.state.ui.show_welcome_screen = false;
                        }
                    }
                    // Strip machine trailer from chat display
                    let result = if result.is_empty() {
                        live.map(|call| call.output).unwrap_or(result)
                    } else {
                        result
                    };
                    let display = if name == "present_plan" {
                        result
                            .split("\n__PLAN_READY__\n")
                            .next()
                            .unwrap_or(&result)
                            .trim()
                            .to_string()
                    } else {
                        result
                    };
                    if name != "todo_write" || is_error {
                        self.state
                            .add_tool_result(&name, display, is_error, duration_ms);
                    }
                }
                AgentEvent::FileChange {
                    subagent_id,
                    path,
                    diff_summary: _,
                    before,
                    after,
                } => {
                    // An isolated child's checkout is a different workspace:
                    // keep its edits out of the parent's tracked files and
                    // undo stack. Only shared-root children count as parent
                    // changes, and an unknown child is treated as isolated.
                    if let Some(id) = subagent_id {
                        if !self.subagent_shares_parent_workspace(&id) {
                            continue;
                        }
                    }
                    // Stamp the finished write/edit card with this edit's
                    // +A/-B collapsed header before the
                    // stats update the session change summary.
                    let stats = crate::state::diff_line_counts(before.as_deref(), after.as_deref());
                    self.state.track_file_change(&path, before, after);
                    if let Some(stats) = stats {
                        self.state.stamp_tool_diff_stats(stats);
                    }
                }
                AgentEvent::TodoUpdate { subagent_id, todos } => {
                    // A child's plan is not the parent's plan.
                    if subagent_id.is_none() {
                        self.state.todo.todos.update(todos);
                        self.state.refresh_plan_in_chat();
                    }
                }
                AgentEvent::Done {
                    conversation,
                    tokens: _,
                } => {
                    // Refresh `total_tokens` from the new transcript so the
                    // status bar reflects the *real* context size after this
                    // turn (and any auto-compact that ran inside it).
                    self.state
                        .agent
                        .recompute_total_from_conversation(&conversation);
                    self.state.session.conversation = conversation;
                    // Flush background-child completion notices queued
                    // mid-turn: the replace above would otherwise clobber a
                    // direct push, and the model must see them next turn.
                    let had_notices = self.state.session.drain_notices();
                    // Commit any leftover streamed answer before clearing.
                    if !self.state.agent.streaming_text.is_empty() {
                        let text = self.state.agent.streaming_text.clone();
                        self.state.agent.streaming_text.clear();
                        self.state.add_assistant_message(text);
                    } else {
                        self.state.flush_live_reasoning();
                    }
                    self.state.agent.clear_stream_buffers();
                    self.state
                        .agent
                        .remove_approvals_from(&agente_core::agent::ApprovalSource::Parent);
                    self.state.agent.end_parent_turn();
                    self.state.plan_review.promote();
                    self.state.persist_config();
                    self.queue_session_snapshot();
                    self.maybe_spawn_session_title();

                    let started = self.drain_queues_and_continue();
                    // A background child finished during the turn: resume the
                    // model so it consumes the result now instead of waiting
                    // for the next user message.
                    if had_notices && !started {
                        let _ = self.start_chat_turn();
                    }
                }
                AgentEvent::Cancelled {
                    conversation,
                    tokens: _,
                    partial_text,
                } => {
                    if !partial_text.is_empty() {
                        self.state.agent.streaming_text = partial_text;
                        self.state.add_interrupted_message();
                    } else {
                        self.state.flush_live_reasoning();
                    }
                    self.state
                        .agent
                        .recompute_total_from_conversation(&conversation);
                    self.state.session.conversation = conversation;
                    let had_notices = self.state.session.drain_notices();
                    self.state.agent.clear_stream_buffers();
                    self.state
                        .agent
                        .remove_approvals_from(&agente_core::agent::ApprovalSource::Parent);
                    self.state.agent.end_parent_turn();
                    self.state.plan_review.promote();
                    self.state.persist_config();
                    self.queue_session_snapshot();

                    let started = self.drain_queues_and_continue();
                    if had_notices && !started {
                        let _ = self.start_chat_turn();
                    }
                }
                AgentEvent::ContextCompacted {
                    summary,
                    compacted_conversation,
                } => {
                    // Auto-compact shrinks the in-flight transcript. Replace
                    // the persisted transcript immediately and refresh the
                    // bar so it stops showing the pre-compact size before the
                    // turn finishes.
                    self.state.session.conversation = compacted_conversation.clone();
                    self.state
                        .agent
                        .recompute_total_from_conversation(&compacted_conversation);
                    self.state.add_system_message(summary);
                }
                AgentEvent::TurnUsage {
                    prompt_tokens,
                    completion_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                } => {
                    self.state.agent.record_turn_usage(
                        prompt_tokens,
                        completion_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                    );
                    // The provider's prompt-token count is the true context
                    // size of the last request. Adopt it when reported so the
                    // header tracks the turn live instead of freezing until
                    // Done; fall back to the local estimate when the provider
                    // reports no usage.
                    if prompt_tokens > 0 {
                        self.state.agent.total_tokens = prompt_tokens;
                    }
                }
                AgentEvent::Error {
                    message: msg,
                    conversation,
                } => {
                    // The loop's failure transcript includes tool work it
                    // already executed; adopt it so a follow-up turn resumes
                    // with the call and result, not the pre-turn snapshot.
                    if !conversation.is_empty() {
                        self.state
                            .agent
                            .recompute_total_from_conversation(&conversation);
                        self.state.session.conversation = conversation;
                    }
                    let mode_str = self.state.agent.current_turn_mode.to_string();
                    let reasoning = self.state.take_reasoning();
                    let partial = std::mem::take(&mut self.state.agent.streaming_text);
                    let content = if partial.trim().is_empty() {
                        format!("Error: {msg}")
                    } else {
                        format!("{partial}\n\nError: {msg}")
                    };
                    self.state.session.chat_history.push(types::ChatEntry {
                        id: uuid::Uuid::new_v4(),
                        role: Role::Assistant,
                        content,
                        tool_name: None,
                        tool_args: None,
                        is_error: true,
                        timestamp: chrono::Utc::now(),
                        response_duration: None,
                        mode: mode_str,
                        interrupted: !partial.trim().is_empty(),
                        reasoning,
                        subagent_id: None,
                        subagent_type: None,
                        diff_stats: None,
                    });
                    self.state.agent.clear_stream_buffers();
                    self.state
                        .agent
                        .remove_approvals_from(&agente_core::agent::ApprovalSource::Parent);
                    self.state.agent.end_parent_turn();
                    self.state.plan_review.promote();
                    self.queue_session_snapshot();

                    self.drain_queues_and_continue();
                }
                AgentEvent::ModelCatalogUpdated { result } => match result {
                    Ok(catalog) => {
                        self.state.config.update_model_catalog(&catalog);
                        self.state.clamp_thinking_level_for_current_model();
                        if self.state.input.show_thinking_selector {
                            self.open_thinking_selector();
                        }
                        self.state.ui.show_toast("Model metadata refreshed");
                    }
                    Err(error) => {
                        self.state.config.catalog_refresh_status =
                            crate::state::DiscoveryStatus::Failed(error.clone());
                        self.state.ui.show_toast(error);
                    }
                },
                AgentEvent::ModelsDiscovered { provider, models } => {
                    if !self.state.config.is_provider_connected(&provider) {
                        continue;
                    }
                    tracing::info!(
                        provider = %provider,
                        model_count = models.len(),
                        "Models discovered"
                    );
                    self.state.set_discovered_models(&provider, models.clone());
                    self.state.input.model_selector_selected = 0;
                    self.state.clamp_thinking_level_for_current_model();
                    self.state.ui.show_toast(format!(
                        "{}: {} models refreshed",
                        provider,
                        models.len()
                    ));
                    // Only set current provider if none is selected yet (avoids race at startup)
                    if self.state.config.current_provider.is_empty() {
                        self.state.config.current_provider = provider.clone();
                    }
                    let pending = self.state.config.pending_after_connect.as_deref()
                        == Some(provider.as_str());
                    if pending {
                        self.state.config.pending_after_connect = None;
                    }
                    // Open model picker after explicit connect/activate, or when
                    // current model is empty for this provider.
                    if pending || self.state.config.current_model.is_empty() {
                        self.refresh_model_selection_after_discovery(&provider);
                    }
                    self.state.persist_config();
                }
                AgentEvent::ModelDiscoveryFailed { provider, error } => {
                    if !self.state.config.is_provider_connected(&provider) {
                        continue;
                    }
                    self.state.set_discovery_failed(&provider, error.clone());
                    self.state.ui.show_toast(format!("{provider}: {error}"));
                    let pending = self.state.config.pending_after_connect.as_deref()
                        == Some(provider.as_str());
                    if pending {
                        self.state.config.pending_after_connect = None;
                        // Offer to fix the key instead of an empty model modal.
                        let auth_fail = {
                            let lower = error.to_lowercase();
                            lower.contains("401")
                                || lower.contains("403")
                                || lower.contains("unauthorized")
                                || lower.contains("api key")
                                || lower.contains("authentication")
                        };
                        if auth_fail {
                            // Demote until a good key is provided.
                            self.state.disconnect_provider(&provider, false);
                        }
                        self.state
                            .open_enter_key(&provider, String::new(), true, error);
                    }
                    if self.state.config.current_provider.is_empty() {
                        self.state.config.current_provider = provider.clone();
                    }
                }
                AgentEvent::ApprovalRequested { source, request } => {
                    self.state.agent.enqueue_approval(source, request);
                }
                AgentEvent::SubagentStarted {
                    id,
                    subagent_type,
                    description,
                } => {
                    // Card status mirrors the registry snapshot so a queued
                    // spawn reads pending, not running. A re-sent Started
                    // (dequeue launch) refreshes the existing card without
                    // duplicating its chat entry.
                    let snapshot = self.state.subagent_registry.get(&id);
                    let status = snapshot
                        .as_ref()
                        .map(|snap| snap.status.as_str().to_string())
                        .unwrap_or_else(|| "running".to_string());
                    let meta = snapshot.as_ref().map(|snap| {
                        (
                            snap.model.clone(),
                            Some(snap.started_at),
                            snap.worktree.clone(),
                        )
                    });
                    if let Some(card) = self.state.agent.subagents.get_mut(&id) {
                        card.subagent_type = subagent_type.clone();
                        card.description = description.clone();
                        card.status = status;
                        if let Some((model, started_at, worktree)) = meta {
                            if !model.is_empty() {
                                card.model = model;
                            }
                            if card.started_at.is_none() {
                                card.started_at = started_at;
                            }
                            card.worktree = worktree;
                        }
                    } else {
                        let (model, started_at, worktree) =
                            meta.unwrap_or((String::new(), None, None));
                        self.state.agent.subagents.insert(
                            id.clone(),
                            crate::state::SubagentUiState {
                                id: id.clone(),
                                subagent_type: subagent_type.clone(),
                                description: description.clone(),
                                status,
                                model,
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
                    tracing::info!(
                        subagent_id = %id,
                        subagent_type = %subagent_type,
                        "Subagent started"
                    );
                }
                AgentEvent::SubagentText { id, text } => {
                    // Core caps the forwarded stream; cap again here so a
                    // placeholder card built before the cap still stays bounded.
                    const MAX_STREAM_BYTES: usize = 256 * 1024;
                    let card = self.subagent_card_or_placeholder(&id);
                    if card.streaming_text.len() < MAX_STREAM_BYTES {
                        card.streaming_text.push_str(&text);
                    }
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
                    // Don't yank the view if the user scrolled up mid-stream.
                    self.state.ui.follow_bottom_if_pinned();
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
                    // Push completion notice: the background child finished
                    // with no waiter, so the model learns the outcome without
                    // polling `task_output`.
                    let text = agente_core::subagent::completion_notice_text(
                        &id,
                        &subagent_type,
                        &status,
                        &summary,
                    );
                    // Visible done-row. Bypass the `AppState` helper: it
                    // forces auto-scroll, which would yank a user reading
                    // history for every background completion.
                    let mode_str = self.state.agent.current_turn_mode.to_string();
                    self.state
                        .session
                        .add_assistant_message(text.clone(), mode_str, None, None);
                    self.state.ui.follow_bottom_if_pinned();
                    // Model-facing injection. A running turn's terminal event
                    // replaces the conversation wholesale, so a direct push
                    // now would be clobbered — queue for the turn boundary.
                    // Idle: the transcript is stable, push immediately.
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
                            });
                        // A background child finished with the parent idle:
                        // resume the model so it consumes the result instead
                        // of leaving it unread until the next user message.
                        let _ = self.start_chat_turn();
                    }
                    tracing::info!(
                        subagent_id = %id,
                        status = %status,
                        "Subagent completion notice injected"
                    );
                }
            }
        }
        processed == MAX_AGENT_EVENTS_PER_TICK
    }

    /// True when a child's edits land in the parent workspace and may be
    /// tracked as parent changes. Isolated children (own worktree) and
    /// unknown children never touch parent tracking or the undo stack.
    fn subagent_shares_parent_workspace(&self, id: &str) -> bool {
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
    /// `SubagentStarted` was missed (out-of-order delivery, `/clear`,
    /// session reload). Dropping these updates instead leaves a running
    /// child with no visible card at all.
    fn subagent_card_or_placeholder(&mut self, id: &str) -> &mut crate::state::SubagentUiState {
        if !self.state.agent.subagents.contains_key(id) {
            self.state.agent.subagents.insert(
                id.to_string(),
                crate::state::SubagentUiState {
                    id: id.to_string(),
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

    pub(super) fn refresh_model_selection_after_discovery(&mut self, provider: &str) {
        let entries = self.state.get_models_for_provider(provider);
        if entries.is_empty() {
            return;
        }

        // Single model → auto-select, no modal.
        if entries.len() == 1 {
            self.state.config.current_provider = entries[0].provider.clone();
            self.state.config.current_model = entries[0].model_id.clone();
            self.state.clamp_thinking_level_for_current_model();
            self.state.input.show_model_selector = false;
            self.state.persist_config();
            return;
        }

        // Keep existing selection if still valid for this provider.
        if !self.state.config.current_model.is_empty()
            && self.state.config.current_provider == provider
            && entries
                .iter()
                .any(|e| e.model_id == self.state.config.current_model)
        {
            return;
        }

        self.state.input.model_selector_query = provider.to_string();
        self.state.input.show_model_selector = true;
        self.state.input.model_selector_selected = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::agent::{AgentEvent, AgentTaskEvent};
    use agente_core::config::AppConfig;

    #[test]
    fn parallel_subagent_results_match_call_id_before_tool_name() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/subagent-routing".into(),
            runtime,
        )
        .unwrap();
        let rows = ["first", "second"]
            .into_iter()
            .map(|id| crate::state::SubagentToolRow {
                call_id: id.into(),
                name: "shell".into(),
                args: "{}".into(),
                result: None,
                is_error: false,
                finished: false,
            })
            .collect();
        app.state.agent.subagents.insert(
            "child".into(),
            crate::state::SubagentUiState {
                tool_rows: rows,
                status: "running".into(),
                ..Default::default()
            },
        );
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::SubagentToolCallResult {
                    id: "child".into(),
                    call_id: "first".into(),
                    name: "shell".into(),
                    result: "first result".into(),
                    is_error: false,
                },
            })
            .unwrap();
        app.process_agent_events();
        let rows = &app.state.agent.subagents["child"].tool_rows;
        assert_eq!(rows[0].result.as_deref(), Some("first result"));
        assert!(rows[1].result.is_none());
    }

    #[test]
    fn subagent_updates_materialize_card_when_start_was_missed() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/subagent-placeholder".to_string(),
            runtime,
        )
        .unwrap();

        // No SubagentStarted ever arrives (out-of-order delivery, /clear,
        // reload) — updates must still surface a card, not vanish.
        for event in [
            AgentEvent::SubagentText {
                id: "ghost".into(),
                text: "reading files".into(),
            },
            AgentEvent::SubagentToolCallStart {
                id: "ghost".into(),
                call_id: "c1".into(),
                name: "read_file".into(),
                args: "{}".into(),
            },
            AgentEvent::SubagentToolCallResult {
                id: "ghost".into(),
                call_id: "c1".into(),
                name: "read_file".into(),
                result: "contents".into(),
                is_error: false,
            },
            AgentEvent::SubagentDone {
                id: "ghost".into(),
                summary: "done exploring".into(),
                is_error: false,
            },
        ] {
            app.agent_tx
                .send(AgentTaskEvent { task_id: 0, event })
                .unwrap();
        }
        app.process_agent_events();

        let card = app
            .state
            .agent
            .subagents
            .get("ghost")
            .expect("card must materialize without SubagentStarted");
        assert!(card.streaming_text.contains("reading files"));
        assert_eq!(card.tool_rows.len(), 1);
        assert_eq!(card.tool_rows[0].result.as_deref(), Some("contents"));
        assert_eq!(card.status, "completed");
        assert!(app
            .state
            .session
            .chat_history
            .iter()
            .any(|e| e.subagent_id.as_deref() == Some("ghost")));
    }

    #[test]
    fn child_carried_events_survive_a_follow_up_turn_while_child_runs() {
        use agente_core::agent::ApprovalSource;
        use agente_core::todo::TodoInput;
        use agente_core::types::ApprovalRequest;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/subagent-stale".to_string(),
            runtime,
        )
        .unwrap();

        // A background child spawned during turn 0 outlives it; the user
        // starts turn 2 while the child still runs.
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::SubagentStarted {
                    id: "child".into(),
                    subagent_type: "explore".into(),
                    description: "research".into(),
                },
            })
            .unwrap();
        app.process_agent_events();
        app.current_task_id = 2;

        // Everything the child emits still bears the spawning turn's id, but
        // its origin is tagged. A shared-root child's file edit counts as a
        // parent change; its todo list never replaces the parent plan.
        for event in [
            AgentEvent::FileChange {
                subagent_id: Some("child".into()),
                path: "src/a.rs".into(),
                diff_summary: "+1/-0".into(),
                before: Some("old".into()),
                after: Some("new".into()),
            },
            AgentEvent::TodoUpdate {
                subagent_id: Some("child".into()),
                todos: vec![TodoInput {
                    content: "child task".into(),
                    status: "in_progress".into(),
                    priority: "high".into(),
                }],
            },
            AgentEvent::ApprovalRequested {
                source: ApprovalSource::Subagent { id: "child".into() },
                request: ApprovalRequest {
                    request_id: "r1".into(),
                    tool_name: "shell".into(),
                    tool_args: "{}".into(),
                    description: "child wants shell".into(),
                    is_dangerous: false,
                    old_content: None,
                    new_content: None,
                    file_path: None,
                },
            },
        ] {
            app.agent_tx
                .send(AgentTaskEvent { task_id: 1, event })
                .unwrap();
        }
        app.process_agent_events();

        assert!(
            app.state.session.file_originals.contains_key("src/a.rs"),
            "a shared-root child file edit must not be dropped as stale"
        );
        assert_eq!(
            app.state.todo.todos.get_all().len(),
            0,
            "a child todo list must never replace the parent plan"
        );
        assert!(
            !app.state.agent.approval_queue.is_empty(),
            "child approval must surface even on a newer turn"
        );
    }

    #[test]
    fn isolated_child_changes_never_touch_parent_tracking() {
        use agente_core::subagent::WorktreeInfo;
        use agente_core::todo::TodoInput;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/subagent-worktree".to_string(),
            runtime,
        )
        .unwrap();
        app.state.agent.subagents.insert(
            "wt-child".into(),
            crate::state::SubagentUiState {
                status: "running".into(),
                worktree: Some(WorktreeInfo::synthetic(
                    "/repo",
                    "/repo/.agente/worktrees/explore-abc",
                    "agente/explore-abc",
                    "deadbeef",
                    false,
                )),
                ..Default::default()
            },
        );
        app.current_task_id = 2;

        for event in [
            AgentEvent::FileChange {
                subagent_id: Some("wt-child".into()),
                path: "src/a.rs".into(),
                diff_summary: "+1/-0".into(),
                before: Some("old".into()),
                after: Some("new".into()),
            },
            AgentEvent::TodoUpdate {
                subagent_id: Some("wt-child".into()),
                todos: vec![TodoInput {
                    content: "isolated task".into(),
                    status: "in_progress".into(),
                    priority: "high".into(),
                }],
            },
        ] {
            app.agent_tx
                .send(AgentTaskEvent { task_id: 1, event })
                .unwrap();
        }
        app.process_agent_events();

        assert!(
            app.state.session.file_originals.is_empty(),
            "an isolated checkout's edit is not a parent file change"
        );
        assert_eq!(app.state.todo.todos.get_all().len(), 0);
    }

    #[test]
    fn unrelated_stale_events_are_still_dropped_without_live_children() {
        use agente_core::todo::TodoInput;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/subagent-stale-control".to_string(),
            runtime,
        )
        .unwrap();
        app.current_task_id = 2;

        for event in [
            AgentEvent::FileChange {
                subagent_id: None,
                path: "src/a.rs".into(),
                diff_summary: "+1/-0".into(),
                before: Some("old".into()),
                after: Some("new".into()),
            },
            AgentEvent::TodoUpdate {
                subagent_id: None,
                todos: vec![TodoInput {
                    content: "stale task".into(),
                    status: "pending".into(),
                    priority: "low".into(),
                }],
            },
        ] {
            app.agent_tx
                .send(AgentTaskEvent { task_id: 1, event })
                .unwrap();
        }
        app.process_agent_events();

        assert!(app.state.session.file_originals.is_empty());
        assert_eq!(app.state.todo.todos.get_all().len(), 0);
    }

    #[test]
    fn event_drain_yields_when_a_producer_fills_the_queue() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/event-drain".to_string(),
            runtime,
        )
        .unwrap();

        for _ in 0..=MAX_AGENT_EVENTS_PER_TICK {
            app.agent_tx
                .send(AgentTaskEvent {
                    task_id: 0,
                    event: AgentEvent::Thinking,
                })
                .unwrap();
        }

        assert!(app.process_agent_events(), "the first batch must yield");
        assert!(
            !app.process_agent_events(),
            "the remaining event must drain without claiming more backlog"
        );
    }

    #[test]
    fn plan_review_opens_only_after_terminal_event() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/plan-handoff".to_string(),
            runtime,
        )
        .unwrap();
        let result = "Plan ready\n\n__PLAN_READY__\n.agente/plan.md\n__PLAN_TITLE__\nMy Plan\n__PLAN_BODY__\n# My Plan\n\nsteps\n";
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::ToolCallResult {
                    id: "plan".into(),
                    name: "present_plan".into(),
                    result: result.into(),
                    is_error: false,
                },
            })
            .unwrap();
        app.process_agent_events();
        assert!(app.state.plan_review.has_pending());
        assert_eq!(
            app.state.plan_review.phase,
            crate::state::PlanReviewPhase::Idle
        );

        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::Done {
                    conversation: Vec::new(),
                    tokens: 0,
                },
            })
            .unwrap();
        app.process_agent_events();
        assert_eq!(
            app.state.plan_review.phase,
            crate::state::PlanReviewPhase::Review
        );
    }

    #[test]
    fn streaming_deltas_do_not_bypass_frame_throttle() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app =
            App::new_for_test(AppConfig::default(), "/tmp/frame-throttle".into(), runtime).unwrap();
        app.state.agent.state = AgentState::StreamingResponse;
        app.state.ui.needs_render = false;
        app.inject_agent_event(AgentEvent::TextDelta("hello".into()));
        app.inject_agent_event(AgentEvent::ReasoningDelta("thinking".into()));
        app.process_agent_events();
        assert!(!app.state.ui.needs_render);
        assert_eq!(app.state.agent.streaming_text, "hello");
        assert_eq!(app.state.agent.reasoning_text, "thinking");

        // An already-pending keyboard paint must never be suppressed.
        app.state.ui.needs_render = true;
        app.inject_agent_event(AgentEvent::TextDelta(" world".into()));
        app.process_agent_events();
        assert!(app.state.ui.needs_render);

        app.state.ui.needs_render = false;
        app.inject_agent_event(AgentEvent::Error {
            message: "failed".into(),
            conversation: Vec::new(),
        });
        app.process_agent_events();
        assert!(app.state.ui.needs_render);
    }

    #[test]
    fn error_preserves_partial_output_and_clears_owned_task() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/error-terminal".to_string(),
            runtime,
        )
        .unwrap();
        app.state.agent.state = AgentState::StreamingResponse;
        app.state.agent.streaming_text = "partial answer".into();
        app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::Error {
                    message: "provider failed".into(),
                    conversation: Vec::new(),
                },
            })
            .unwrap();

        app.process_agent_events();

        assert!(matches!(app.state.agent.state, AgentState::Idle));
        assert!(app.state.agent.task_handle.is_none());
        assert!(app.state.agent.streaming_text.is_empty());
        let entry = app.state.session.chat_history.last().unwrap();
        assert!(entry.content.contains("partial answer"));
        assert!(entry.content.contains("provider failed"));
        assert!(entry.is_error && entry.interrupted);
    }

    /// A failure after executed tool work must adopt the loop's transcript so
    /// the next turn resumes with the call and result, not the pre-turn
    /// snapshot.
    #[test]
    fn error_adopts_the_loop_transcript() {
        let mut app = notice_test_app("/tmp/error-transcript");
        app.state.agent.state = AgentState::StreamingResponse;
        app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::Error {
                    message: "provider failed".into(),
                    conversation: vec![agente_core::types::Message {
                        role: Role::User,
                        content: "executed tool work".into(),
                        tool_calls: None,
                        tool_call_id: None,
                        thinking: None,
                        thinking_signature: None,
                        continuation: None,
                    }],
                },
            })
            .unwrap();

        app.process_agent_events();

        assert_eq!(app.state.session.conversation.len(), 1);
        assert_eq!(
            app.state.session.conversation[0].content,
            "executed tool work"
        );
        assert!(matches!(app.state.agent.state, AgentState::Idle));
    }

    #[test]
    fn generation_progress_keeps_parent_and_child_tool_activity_separate() {
        let mut app = notice_test_app("/tmp/generation-progress");
        app.inject_agent_event(AgentEvent::GenerationProgress {
            subagent_id: None,
            output_bytes: 100,
            tool_name: Some("shell".into()),
        });
        app.inject_agent_event(AgentEvent::GenerationProgress {
            subagent_id: Some("child".into()),
            output_bytes: 200,
            tool_name: Some("read".into()),
        });
        app.process_agent_events();

        assert_eq!(app.state.agent.preparing_tool.as_deref(), Some("shell"));
        assert_eq!(
            app.state.agent.subagents["child"].preparing_tool.as_deref(),
            Some("read")
        );

        app.inject_agent_event(AgentEvent::GenerationProgress {
            subagent_id: None,
            output_bytes: 300,
            tool_name: None,
        });
        app.process_agent_events();
        assert!(app.state.agent.preparing_tool.is_none());
        assert_eq!(
            app.state.agent.subagents["child"].preparing_tool.as_deref(),
            Some("read")
        );
    }

    /// The provider's per-request prompt count is the true context size: each
    /// TurnUsage must move the header readout, not just feed cost accounting.
    #[test]
    fn turn_usage_moves_the_live_context_readout() {
        let mut app = notice_test_app("/tmp/turn-usage-live");
        app.state.agent.total_tokens = 1_000;
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::TurnUsage {
                    prompt_tokens: 48_000,
                    completion_tokens: 200,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                },
            })
            .unwrap();
        app.process_agent_events();
        assert_eq!(app.state.agent.total_tokens, 48_000);
        assert_eq!(app.state.agent.last_turn_prompt_tokens, 48_000);

        // Providers that report no usage must not zero the estimate.
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::TurnUsage {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                },
            })
            .unwrap();
        app.process_agent_events();
        assert_eq!(app.state.agent.total_tokens, 48_000);
    }

    /// A cancellation terminal must settle the phase even with a real task
    /// handle installed: removing approvals once recomputed `Executing` from
    /// the dead handle and left further input queued forever.
    #[test]
    fn cancelled_turn_with_real_handle_settles_to_idle() {
        let mut app = notice_test_app("/tmp/cancel-terminal");
        app.state.agent.state = AgentState::StreamingResponse;
        app.state.agent.streaming_text = "half".into();
        app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::Cancelled {
                    conversation: Vec::new(),
                    tokens: 0,
                    partial_text: "half".into(),
                },
            })
            .unwrap();
        app.process_agent_events();

        assert!(
            matches!(app.state.agent.state, AgentState::Idle),
            "{:?}",
            app.state.agent.state
        );
        assert!(app.state.agent.task_handle.is_none());
    }

    /// A direct shell command ends the turn itself; that path must also abort
    /// the stored handle before settling the phase.
    #[test]
    fn direct_shell_completion_with_real_handle_settles_to_idle() {
        let mut app = notice_test_app("/tmp/direct-terminal");
        app.state.agent.state = AgentState::Executing;
        app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
        app.state.agent.start_live_tool(
            "direct-1".into(),
            "shell".into(),
            "{\"command\":\"echo hi\"}".into(),
            true,
        );
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::ToolCallResult {
                    id: "direct-1".into(),
                    name: "shell".into(),
                    result: "hi".into(),
                    is_error: false,
                },
            })
            .unwrap();
        app.process_agent_events();

        assert!(
            matches!(app.state.agent.state, AgentState::Idle),
            "{:?}",
            app.state.agent.state
        );
        assert!(app.state.agent.task_handle.is_none());
    }

    /// A still-pending child approval keeps the phase at `WaitingApproval`
    /// once the parent turn ends; it must not be cleared with the parent's.
    #[test]
    fn child_approval_keeps_waiting_approval_after_parent_turn_ends() {
        use agente_core::agent::ApprovalSource;
        use agente_core::types::ApprovalRequest;

        let mut app = notice_test_app("/tmp/child-approval-terminal");
        app.state.agent.state = AgentState::Executing;
        app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::ApprovalRequested {
                    source: ApprovalSource::Subagent { id: "child".into() },
                    request: ApprovalRequest {
                        request_id: "r1".into(),
                        tool_name: "shell".into(),
                        tool_args: "{}".into(),
                        description: "child wants shell".into(),
                        is_dangerous: false,
                        old_content: None,
                        new_content: None,
                        file_path: None,
                    },
                },
            })
            .unwrap();
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::Done {
                    conversation: Vec::new(),
                    tokens: 0,
                },
            })
            .unwrap();
        app.process_agent_events();

        assert!(
            matches!(app.state.agent.state, AgentState::WaitingApproval),
            "{:?}",
            app.state.agent.state
        );
        assert!(app.state.agent.task_handle.is_none());
        assert!(!app.state.agent.approval_queue.is_empty());
    }

    fn completed_notice(id: &str, subagent_type: &str, status: &str, summary: &str) -> AgentEvent {
        AgentEvent::SubagentCompletedNotice {
            id: id.into(),
            subagent_type: subagent_type.into(),
            status: status.into(),
            summary: summary.into(),
        }
    }

    fn notice_test_app(dir: &str) -> App {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        App::new_for_test(AppConfig::default(), dir.to_string(), runtime).unwrap()
    }

    /// A re-sent Started (dequeue launch) refreshes the card status without
    /// duplicating its chat entry; a queued spawn reads pending from the
    /// registry snapshot instead of the default running.
    #[test]
    fn subagent_started_upsert_tracks_queue_then_launch() {
        use agente_core::subagent::{SubagentSnapshot, SubagentStatus};

        let mut app = notice_test_app("/tmp/started-upsert");
        app.state.subagent_registry.insert(SubagentSnapshot {
            id: "q-1".into(),
            subagent_type: "explore".into(),
            description: "queued work".into(),
            prompt: "Inspect retry logic. Return file paths and findings.".into(),
            status: SubagentStatus::Pending,
            summary: None,
            conversation: Vec::new(),
            model: "m".into(),
            depth: 1,
            background: true,
            started_at: chrono::Utc::now(),
            finished_at: None,
            cwd: None,
            worktree: None,
        });
        let started = || AgentEvent::SubagentStarted {
            id: "q-1".into(),
            subagent_type: "explore".into(),
            description: "queued work".into(),
        };
        app.inject_agent_event(started());
        app.process_agent_events();
        assert_eq!(app.state.agent.subagents["q-1"].status, "pending");

        // Launch flips the snapshot and re-announces: card follows, entry stays single.
        app.state
            .subagent_registry
            .update("q-1", |snap| snap.status = SubagentStatus::Running);
        app.inject_agent_event(started());
        app.process_agent_events();
        assert_eq!(app.state.agent.subagents["q-1"].status, "running");
        assert_eq!(
            app.state
                .session
                .chat_history
                .iter()
                .filter(|e| e.subagent_id.as_deref() == Some("q-1"))
                .count(),
            1
        );
    }
    /// A background completion with nobody waiting must reach the model
    /// without polling: idle agent → direct conversation injection plus a
    /// visible done-row.
    #[test]
    fn completed_notice_injects_conversation_message_when_idle() {
        let mut app = notice_test_app("/tmp/notice-idle");
        app.state.agent.state = AgentState::Idle;
        app.inject_agent_event(completed_notice(
            "s-1",
            "explore",
            "completed",
            "found the bug",
        ));
        app.process_agent_events();

        let last = app
            .state
            .session
            .conversation
            .last()
            .expect("notice must join the conversation");
        assert!(matches!(last.role, Role::User), "notice is model-facing");
        assert!(last.content.contains("s-1"), "{}", last.content);
        assert!(last.content.contains("found the bug"), "{}", last.content);
        assert!(
            app.state.session.pending_notices.is_empty(),
            "idle injection needs no queue"
        );
        assert!(
            app.state
                .session
                .chat_history
                .iter()
                .any(|e| e.content.contains("resume_from:s-1")),
            "a visible done-row must render"
        );
    }

    /// An idle completion notice must not only join the conversation: the
    /// model has to be resumed so it actually consumes the result instead of
    /// leaving it unread until the next user message.
    #[test]
    fn idle_completion_notice_resumes_the_model() {
        let mut app = notice_test_app("/tmp/notice-resume");
        app.state.agent.state = AgentState::Idle;
        app.state.config.current_provider = "test-provider".into();
        app.state.config.current_model = "test-model".into();

        let before = app.current_task_id;
        // Starting a turn calls `tokio::spawn`, which needs a runtime context;
        // drive the notice through the app's own runtime.
        let runtime = std::mem::replace(
            &mut app.runtime,
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap(),
        );
        runtime.block_on(async {
            app.inject_agent_event(completed_notice(
                "s-3",
                "general-purpose",
                "completed",
                "background work done",
            ));
            app.process_agent_events();
        });
        app.runtime = runtime;

        assert_eq!(app.current_task_id, before + 1, "a resume turn must start");
        assert!(
            app.state.agent.task_handle.is_some(),
            "the resume turn task must be spawned"
        );
        assert!(matches!(
            app.state.agent.state,
            AgentState::StreamingResponse
        ));
    }

    /// A notice arriving mid-turn must survive the terminal `Done`, which
    /// replaces the conversation wholesale: queue now, drain at the boundary.
    #[test]
    fn completed_notice_queues_while_turn_runs_and_drains_on_done() {
        let mut app = notice_test_app("/tmp/notice-queued");
        app.state.agent.state = AgentState::StreamingResponse;
        app.inject_agent_event(completed_notice("s-2", "plan", "completed", "plan ready"));
        app.process_agent_events();

        assert!(
            app.state.session.conversation.is_empty(),
            "mid-turn notice must not push directly (Done would clobber it)"
        );
        assert_eq!(app.state.session.pending_notices.len(), 1);

        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::Done {
                    conversation: Vec::new(),
                    tokens: 0,
                },
            })
            .unwrap();
        app.process_agent_events();

        assert_eq!(app.state.session.conversation.len(), 1);
        assert!(
            app.state.session.conversation[0]
                .content
                .contains("plan ready"),
            "{:?}",
            app.state.session.conversation[0].content
        );
        assert!(app.state.session.pending_notices.is_empty());
    }
}
