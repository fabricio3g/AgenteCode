use std::collections::HashMap;
use std::sync::{mpsc, Arc};

use agente_core::agent::{AgentEvent, AgentTaskEvent, ApprovalSource};
use agente_protocol::{
    Message, RunId, RuntimeEvent, RuntimeEventEnvelope, SessionId, SessionSnapshot, TurnId,
    TurnOutcome, TurnStatus, Usage,
};
use tokio::sync::{mpsc as tokio_mpsc, oneshot};

use crate::{compat, RuntimeInner};

/// Deltas buffered while the event channel is full are capped so a client that
/// stops draining cannot grow the forwarder without bound.
const MAX_BUFFERED_TEXT_BYTES: usize = 1 << 20;
const MAX_BUFFERED_TOOL_PROGRESS_BYTES: usize = 256 * 1024;
const TRUNCATION_MARKER: &str = "\n…[truncated: client fell behind]…\n";

fn push_buffered_text(buffer: &mut String, text: &str) {
    if buffer.len() + text.len() <= MAX_BUFFERED_TEXT_BYTES {
        buffer.push_str(text);
    } else if !buffer.ends_with(TRUNCATION_MARKER) {
        buffer.push_str(TRUNCATION_MARKER);
    }
}

pub(crate) fn forward_legacy_events(
    inner: Arc<RuntimeInner>,
    session_id: SessionId,
    turn_id: TurnId,
    receiver: mpsc::Receiver<AgentTaskEvent>,
    sender: tokio_mpsc::Sender<RuntimeEventEnvelope>,
    outcome_sender: oneshot::Sender<TurnOutcome>,
) {
    tracing::info!(%session_id, %turn_id, "Forwarding agent turn events");
    let mut forwarder = EventForwarder::new(Arc::clone(&inner), session_id, turn_id, sender);
    let mut terminal_outcome = None;
    let mut turn_edits = Vec::new();

    while let Ok(task_event) = receiver.recv() {
        if let AgentEvent::FileChange {
            subagent_id: None,
            path,
            before,
            after,
            ..
        } = &task_event.event
        {
            turn_edits.push(crate::edits::FileEdit {
                path: path.clone(),
                before: before.clone(),
                after: after.clone(),
            });
        }
        match task_event.event {
            AgentEvent::Done {
                conversation,
                tokens,
            } => {
                let revision = commit_conversation(
                    &inner,
                    session_id,
                    turn_id,
                    compat::conversation_from_core(conversation),
                    &mut forwarder,
                );
                forwarder.emit(RuntimeEvent::TurnFinished { revision });
                terminal_outcome = Some(TurnOutcome {
                    turn_id,
                    session_id,
                    status: TurnStatus::Completed,
                    revision,
                    tokens,
                    error: None,
                });
                break;
            }
            AgentEvent::Cancelled {
                conversation,
                tokens,
                partial_text,
            } => {
                let revision = commit_conversation(
                    &inner,
                    session_id,
                    turn_id,
                    compat::conversation_from_core(conversation),
                    &mut forwarder,
                );
                forwarder.emit(RuntimeEvent::TurnCancelled {
                    revision,
                    partial_text,
                });
                terminal_outcome = Some(TurnOutcome {
                    turn_id,
                    session_id,
                    status: TurnStatus::Cancelled,
                    revision,
                    tokens,
                    error: None,
                });
                break;
            }
            AgentEvent::Error {
                message,
                conversation,
            } => {
                // The loop hands back its latest transcript; commit that
                // instead of the last known snapshot so executed tool work
                // survives a provider failure. A panic carries no transcript:
                // fall back to the last known conversation plus any steering
                // queued before the failure.
                let committed = if conversation.is_empty() {
                    inner
                        .read_sessions()
                        .get(&session_id)
                        .map(|snapshot| snapshot.conversation.clone())
                        .unwrap_or_default()
                } else {
                    compat::conversation_from_core(conversation)
                };
                let revision =
                    commit_conversation(&inner, session_id, turn_id, committed, &mut forwarder);
                forwarder.emit(RuntimeEvent::TurnFailed {
                    message: message.clone(),
                });
                terminal_outcome = Some(TurnOutcome {
                    turn_id,
                    session_id,
                    status: TurnStatus::Failed,
                    revision,
                    tokens: 0,
                    error: Some(message),
                });
                break;
            }
            AgentEvent::ContextCompacted {
                summary,
                compacted_conversation,
                tokens_before,
                tokens_after,
                smart,
            } => {
                inner.lock_edits().compacted(session_id);
                inner.persist_edits(session_id);
                let revision = replace_conversation(
                    &inner,
                    session_id,
                    compat::conversation_from_core(compacted_conversation),
                );
                forwarder.emit(RuntimeEvent::ContextCompacted {
                    summary,
                    revision,
                    tokens_before,
                    tokens_after,
                    smart,
                });
            }
            event => {
                if let Some((event, parent)) = map_event(&inner, event) {
                    forwarder.emit_from(event, parent);
                }
            }
        }
    }

    if terminal_outcome.is_none() {
        let message = "agent event source closed before a terminal outcome".to_string();
        // Preserve steering queued before the source vanished, same as the
        // explicit error path.
        let last_known = inner
            .read_sessions()
            .get(&session_id)
            .map(|snapshot| snapshot.conversation.clone())
            .unwrap_or_default();
        let revision = commit_conversation(&inner, session_id, turn_id, last_known, &mut forwarder);
        forwarder.emit(RuntimeEvent::TurnFailed {
            message: message.clone(),
        });
        terminal_outcome = Some(TurnOutcome {
            turn_id,
            session_id,
            status: TurnStatus::Failed,
            revision,
            tokens: 0,
            error: Some(message),
        });
    }

    forwarder.flush();
    inner.lock_edits().end_turn(session_id, turn_edits);
    inner.persist_edits(session_id);
    inner.lock_turns().remove(&turn_id);
    inner.prune_finished_children();
    if let Some(outcome) = terminal_outcome {
        tracing::info!(%session_id, %turn_id, status = ?outcome.status, revision = outcome.revision, tokens = outcome.tokens, "Agent turn ended");
        if outcome_sender.send(outcome).is_err() {
            tracing::debug!("turn outcome receiver dropped before delivery");
        }
    }
}

/// The protocol event for a core event, and the subagent it came from
/// (`None` = the turn's own loop). `None` overall = not forwarded.
fn map_event(inner: &RuntimeInner, event: AgentEvent) -> Option<(RuntimeEvent, Option<RunId>)> {
    let child = |id: &Option<String>| id.as_deref().map(|id| inner.child_id(id));
    let from_child = match &event {
        AgentEvent::FileChange { subagent_id, .. }
        | AgentEvent::TodoUpdate { subagent_id, .. }
        | AgentEvent::CallUsage { subagent_id, .. }
        | AgentEvent::GenerationProgress { subagent_id, .. } => child(subagent_id),
        _ => None,
    };
    let mapped = match event {
        AgentEvent::Thinking => RuntimeEvent::Thinking,
        AgentEvent::TextDelta(text) => RuntimeEvent::AssistantDelta { text },
        AgentEvent::ReasoningDelta(text) => RuntimeEvent::ReasoningDelta { text },
        AgentEvent::AssistantText(text) => RuntimeEvent::AssistantMessage { text },
        AgentEvent::ToolCallStart { id, name, args } => RuntimeEvent::ToolProposed {
            id,
            name,
            arguments: args,
        },
        AgentEvent::ToolCallProgress { id, chunk } => RuntimeEvent::ToolProgress { id, chunk },
        AgentEvent::ToolHeartbeat { id } => RuntimeEvent::ToolHeartbeat { id },
        AgentEvent::ToolCallResult {
            id,
            name,
            result,
            is_error,
        } => RuntimeEvent::ToolResult {
            id,
            name,
            content: result,
            is_error,
        },
        // A child's changes and todos carry its run id (`parent_run_id`), so
        // clients never mistake its checkout or plan for the session's.
        AgentEvent::FileChange {
            path,
            diff_summary,
            before,
            after,
            ..
        } => RuntimeEvent::FileChanged {
            path,
            summary: diff_summary,
            before,
            after,
        },
        AgentEvent::TodoUpdate { todos, .. } => RuntimeEvent::TodoChanged {
            todos: serde_json::to_value(todos).unwrap_or(serde_json::Value::Null),
        },
        AgentEvent::CallUsage {
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            cost_usd,
            cost_estimated,
            ..
        } => RuntimeEvent::CallUsage {
            usage: Usage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                context_tokens: 0,
            },
            cost_usd,
            cost_estimated,
        },
        AgentEvent::CompactionStarted { smart, model } => {
            RuntimeEvent::CompactionStarted { smart, model }
        }
        AgentEvent::UserMessagesInjected { messages } => {
            RuntimeEvent::UserMessagesInjected { messages }
        }
        AgentEvent::GenerationProgress {
            output_bytes,
            tool_name,
            ..
        } => RuntimeEvent::GenerationProgress {
            output_bytes: output_bytes as u64,
            tool_name,
        },
        AgentEvent::TurnUsage {
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            context_tokens,
        } => RuntimeEvent::Usage {
            usage: Usage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                context_tokens,
            },
        },
        AgentEvent::Retry {
            attempt,
            max_attempts,
            delay_ms,
        } => RuntimeEvent::Retry {
            attempt,
            max_attempts,
            delay_ms,
        },
        AgentEvent::ModelsDiscovered { provider, models } => RuntimeEvent::Diagnostic {
            message: format!("discovered {} models for {provider}", models.len()),
        },
        AgentEvent::ModelDiscoveryFailed { provider, error } => RuntimeEvent::Diagnostic {
            message: format!("model discovery failed for {provider}: {error}"),
        },
        AgentEvent::ModelCatalogUpdated { result } => RuntimeEvent::Diagnostic {
            message: match result {
                Ok(catalog) => {
                    format!("model metadata refreshed: {} models", catalog.model_count())
                }
                Err(error) => error,
            },
        },
        AgentEvent::ApprovalRequested { source, request } => RuntimeEvent::ApprovalRequested {
            request_id: request.request_id,
            child_run_id: match &source {
                ApprovalSource::Parent => None,
                ApprovalSource::Subagent { id } => Some(inner.child_id(id)),
            },
            source: match source {
                ApprovalSource::Parent => "parent".to_string(),
                ApprovalSource::Subagent { id } => format!("subagent:{id}"),
            },
            tool_name: request.tool_name,
            tool_args: request.tool_args,
            description: request.description,
            is_dangerous: request.is_dangerous,
            file_path: request.file_path,
            old_content: request.old_content,
            new_content: request.new_content,
        },
        AgentEvent::SubagentStarted {
            id,
            subagent_type,
            description,
            model,
        } => RuntimeEvent::ChildStarted {
            run_id: inner.child_id(&id),
            kind: subagent_type,
            description,
            model,
        },
        AgentEvent::SubagentText { id, text } => RuntimeEvent::ChildDelta {
            run_id: inner.child_id(&id),
            text,
        },
        AgentEvent::SubagentToolCallStart {
            id,
            call_id,
            name,
            args,
        } => RuntimeEvent::ChildTool {
            run_id: inner.child_id(&id),
            call_id,
            name,
            content: args,
            finished: false,
            is_error: false,
        },
        AgentEvent::SubagentToolCallProgress { id, call_id, chunk } => RuntimeEvent::ChildTool {
            run_id: inner.child_id(&id),
            call_id,
            name: String::new(),
            content: chunk,
            finished: false,
            is_error: false,
        },
        AgentEvent::SubagentToolCallResult {
            id,
            call_id,
            name,
            result,
            is_error,
        } => RuntimeEvent::ChildTool {
            run_id: inner.child_id(&id),
            call_id,
            name,
            content: result,
            finished: true,
            is_error,
        },
        AgentEvent::SubagentCompletedNotice {
            id,
            subagent_type,
            status,
            summary,
        } => RuntimeEvent::ChildCompletedNotice {
            run_id: inner.child_id(&id),
            kind: subagent_type,
            status,
            summary,
        },
        AgentEvent::SubagentDone {
            id,
            summary,
            is_error,
        } => RuntimeEvent::ChildFinished {
            run_id: inner.child_id(&id),
            summary,
            is_error,
        },
        AgentEvent::Done { .. }
        | AgentEvent::Cancelled { .. }
        | AgentEvent::ContextCompacted { .. }
        | AgentEvent::Error { .. } => return None,
    };
    Some((mapped, from_child))
}

fn commit_conversation(
    inner: &RuntimeInner,
    session_id: SessionId,
    turn_id: TurnId,
    mut conversation: Vec<Message>,
    forwarder: &mut EventForwarder,
) -> u64 {
    // Steering that arrived too late for the loop to read is still the
    // user's input: keep it in the session.
    let pending = inner
        .lock_turns()
        .get(&turn_id)
        .map(|control| control.inbox.close())
        .unwrap_or_default();
    let messages = pending
        .iter()
        .map(|message| message.content.clone())
        .collect::<Vec<_>>();
    conversation.extend(pending);
    let revision = replace_conversation(inner, session_id, conversation);
    if !messages.is_empty() {
        forwarder.emit(RuntimeEvent::UserMessagesInjected { messages });
    }
    revision
}

pub(crate) fn replace_conversation(
    inner: &RuntimeInner,
    session_id: SessionId,
    conversation: Vec<Message>,
) -> u64 {
    let commit_lock = inner.commit_lock(session_id);
    let _commit = commit_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut sessions = inner.write_sessions();
    let revision = sessions
        .get(&session_id)
        .map_or(1, |snapshot| snapshot.revision.saturating_add(1));
    let snapshot = SessionSnapshot {
        session_id,
        revision,
        conversation,
    };
    let count = crate::chat_message_count(&snapshot.conversation);
    sessions.insert(session_id, snapshot.clone());
    drop(sessions);
    // The per-session lock preserves revision order; fsync never owns the global map.
    inner.persist_snapshot(&snapshot);
    let project_dir = inner.session_context(session_id, None).project_dir;
    inner.update_meta(session_id, &project_dir, |info| {
        info.message_count = count;
        info.last_active = chrono::Utc::now();
    });
    revision
}

struct EventForwarder {
    inner: Arc<RuntimeInner>,
    session_id: SessionId,
    turn_id: TurnId,
    sender: tokio_mpsc::Sender<RuntimeEventEnvelope>,
    assistant: String,
    reasoning: String,
    progress: HashMap<String, String>,
}

impl EventForwarder {
    fn new(
        inner: Arc<RuntimeInner>,
        session_id: SessionId,
        turn_id: TurnId,
        sender: tokio_mpsc::Sender<RuntimeEventEnvelope>,
    ) -> Self {
        Self {
            inner,
            session_id,
            turn_id,
            sender,
            assistant: String::new(),
            reasoning: String::new(),
            progress: HashMap::new(),
        }
    }

    fn emit(&mut self, event: RuntimeEvent) {
        self.emit_from(event, None);
    }

    fn emit_from(&mut self, event: RuntimeEvent, parent: Option<RunId>) {
        // Deltas buffered during a channel-full window must never be delivered
        // after a newer non-delta event: flush them first, unconditionally,
        // before any non-delta send (even when the channel has space again).
        if !matches!(
            event,
            RuntimeEvent::AssistantDelta { .. }
                | RuntimeEvent::ReasoningDelta { .. }
                | RuntimeEvent::ToolProgress { .. }
        ) {
            self.flush();
        }
        let envelope = self
            .inner
            .envelope(self.session_id, self.turn_id, parent, event);
        // Runtime-wide subscribers get every event as it happens; only the
        // turn's own channel coalesces deltas while its client is behind.
        self.inner.publish(&envelope);
        match self.sender.try_send(envelope) {
            Ok(()) => {}
            Err(tokio_mpsc::error::TrySendError::Closed(_)) => {}
            Err(tokio_mpsc::error::TrySendError::Full(envelope)) => match envelope.event {
                RuntimeEvent::AssistantDelta { text } => {
                    push_buffered_text(&mut self.assistant, &text);
                }
                RuntimeEvent::ReasoningDelta { text } => {
                    push_buffered_text(&mut self.reasoning, &text);
                }
                RuntimeEvent::ToolProgress { id, chunk } => {
                    let buffer = self.progress.entry(id).or_default();
                    if buffer.len() + chunk.len() <= MAX_BUFFERED_TOOL_PROGRESS_BYTES {
                        buffer.push_str(&chunk);
                    } else if !buffer.ends_with(TRUNCATION_MARKER) {
                        buffer.push_str(TRUNCATION_MARKER);
                    }
                }
                // Liveness ticks are worthless late: drop rather than block.
                RuntimeEvent::GenerationProgress { .. } => {}
                // Deltas were already flushed above, so the send can only be
                // waiting on a full channel, never on stale buffered content.
                event => {
                    let envelope =
                        self.inner
                            .envelope(self.session_id, self.turn_id, parent, event);
                    let _ = self.sender.blocking_send(envelope);
                }
            },
        }
    }

    fn flush(&mut self) {
        if !self.assistant.is_empty() {
            let text = std::mem::take(&mut self.assistant);
            let envelope = self.inner.envelope(
                self.session_id,
                self.turn_id,
                None,
                RuntimeEvent::AssistantDelta { text },
            );
            let _ = self.sender.blocking_send(envelope);
        }
        if !self.reasoning.is_empty() {
            let text = std::mem::take(&mut self.reasoning);
            let envelope = self.inner.envelope(
                self.session_id,
                self.turn_id,
                None,
                RuntimeEvent::ReasoningDelta { text },
            );
            let _ = self.sender.blocking_send(envelope);
        }
        for (id, chunk) in std::mem::take(&mut self.progress) {
            let envelope = self.inner.envelope(
                self.session_id,
                self.turn_id,
                None,
                RuntimeEvent::ToolProgress { id, chunk },
            );
            let _ = self.sender.blocking_send(envelope);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RuntimeConfig, RuntimeSupervisor, TurnControl};
    use agente_core::AbortController;
    use agente_protocol::Role;

    fn test_inner() -> Arc<RuntimeInner> {
        let config =
            RuntimeConfig::from_app_config(&agente_core::config::AppConfig::default(), "D:/proj");
        RuntimeSupervisor::start(config).inner
    }

    fn user_message(content: &str) -> Message {
        Message {
            role: Role::User,
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }
    }

    fn core_assistant_message(content: &str) -> agente_core::types::Message {
        agente_core::types::Message {
            role: agente_core::types::Role::Assistant,
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }
    }

    fn task_event(event: AgentEvent) -> AgentTaskEvent {
        AgentTaskEvent { task_id: 1, event }
    }

    /// Inserts a turn control with one steering input already queued.
    fn insert_steering_turn(
        inner: &RuntimeInner,
        session_id: SessionId,
        turn_id: TurnId,
        events: tokio_mpsc::Sender<RuntimeEventEnvelope>,
    ) {
        inner.lock_turns().insert(
            turn_id,
            TurnControl {
                trust: agente_protocol::Trust::Owner,
                cancel: AbortController::new(),
                inbox: {
                    let inbox = agente_core::agent::UserInbox::default();
                    inbox.lock().push(Message::user("queued steering"));
                    inbox
                },
                events,
                session_id,
            },
        );
    }

    #[tokio::test]
    async fn steering_is_committed_on_done() {
        let inner = test_inner();
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (tx_env, mut rx_env) = tokio_mpsc::channel(64);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        insert_steering_turn(&inner, session_id, turn_id, tx_env.clone());

        let (legacy_tx, legacy_rx) = std::sync::mpsc::channel();
        legacy_tx
            .send(task_event(AgentEvent::Done {
                conversation: vec![core_assistant_message("answer")],
                tokens: 42,
            }))
            .unwrap();
        drop(legacy_tx);

        let inner2 = Arc::clone(&inner);
        tokio::task::spawn_blocking(move || {
            forward_legacy_events(inner2, session_id, turn_id, legacy_rx, tx_env, outcome_tx);
        });

        let outcome = outcome_rx.await.unwrap();
        assert_eq!(outcome.status, TurnStatus::Completed);
        assert_eq!(outcome.tokens, 42);

        {
            let sessions = inner.read_sessions();
            let conversation = &sessions.get(&session_id).unwrap().conversation;
            assert_eq!(conversation.len(), 2);
            assert_eq!(conversation[0].content, "answer");
            assert_eq!(conversation[1].role, Role::User);
            assert_eq!(conversation[1].content, "queued steering");
        }
        assert!(inner.lock_turns().get(&turn_id).is_none());
        // Even input arriving after the final completion needs a receipt,
        // before the terminal event, so clients do not resubmit it.
        let mut events = Vec::new();
        while let Some(envelope) = rx_env.recv().await {
            events.push(envelope.event);
        }
        let receipt = events.iter().position(|event| matches!(event, RuntimeEvent::UserMessagesInjected { messages } if messages == &["queued steering"])).unwrap();
        let terminal = events
            .iter()
            .position(|event| matches!(event, RuntimeEvent::TurnFinished { .. }))
            .unwrap();
        assert!(receipt < terminal);
    }

    #[tokio::test]
    async fn steering_is_committed_on_error() {
        let inner = test_inner();
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (tx_env, mut rx_env) = tokio_mpsc::channel(64);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        insert_steering_turn(&inner, session_id, turn_id, tx_env.clone());
        replace_conversation(&inner, session_id, vec![user_message("earlier turn")]);

        let (legacy_tx, legacy_rx) = std::sync::mpsc::channel();
        legacy_tx
            .send(task_event(AgentEvent::Error {
                message: "provider exploded".to_string(),
                conversation: Vec::new(),
            }))
            .unwrap();
        drop(legacy_tx);

        let inner2 = Arc::clone(&inner);
        tokio::task::spawn_blocking(move || {
            forward_legacy_events(inner2, session_id, turn_id, legacy_rx, tx_env, outcome_tx);
        });

        let outcome = outcome_rx.await.unwrap();
        assert_eq!(outcome.status, TurnStatus::Failed);
        assert_eq!(outcome.error.as_deref(), Some("provider exploded"));

        {
            let sessions = inner.read_sessions();
            let conversation = &sessions.get(&session_id).unwrap().conversation;
            assert_eq!(conversation.len(), 2, "steering must survive a failed turn");
            assert_eq!(conversation[0].content, "earlier turn");
            assert_eq!(conversation[1].content, "queued steering");
        }
        while rx_env.recv().await.is_some() {}
    }

    /// A failure after executed tool work must commit the loop's transcript,
    /// not the last pre-turn snapshot: otherwise a resumed session forgets
    /// the tools it already ran.
    #[tokio::test]
    async fn error_commits_the_loop_transcript_when_provided() {
        let inner = test_inner();
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (tx_env, mut rx_env) = tokio_mpsc::channel(64);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        insert_steering_turn(&inner, session_id, turn_id, tx_env.clone());
        replace_conversation(&inner, session_id, vec![user_message("earlier turn")]);

        let (legacy_tx, legacy_rx) = std::sync::mpsc::channel();
        legacy_tx
            .send(task_event(AgentEvent::Error {
                message: "provider exploded".to_string(),
                conversation: vec![user_message("executed tool work")],
            }))
            .unwrap();
        drop(legacy_tx);

        let inner2 = Arc::clone(&inner);
        tokio::task::spawn_blocking(move || {
            forward_legacy_events(inner2, session_id, turn_id, legacy_rx, tx_env, outcome_tx);
        });

        let outcome = outcome_rx.await.unwrap();
        assert_eq!(outcome.status, TurnStatus::Failed);

        {
            let sessions = inner.read_sessions();
            let conversation = &sessions.get(&session_id).unwrap().conversation;
            assert_eq!(
                conversation[0].content, "executed tool work",
                "the loop transcript must replace the last known snapshot"
            );
            assert_eq!(conversation[1].content, "queued steering");
        }
        while rx_env.recv().await.is_some() {}
    }

    #[tokio::test]
    async fn closed_event_source_still_commits_steering() {
        let inner = test_inner();
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (tx_env, mut rx_env) = tokio_mpsc::channel(64);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        insert_steering_turn(&inner, session_id, turn_id, tx_env.clone());
        replace_conversation(&inner, session_id, vec![user_message("history")]);

        let (_legacy_tx, legacy_rx) = std::sync::mpsc::channel::<AgentTaskEvent>();
        drop(_legacy_tx);

        let inner2 = Arc::clone(&inner);
        tokio::task::spawn_blocking(move || {
            forward_legacy_events(inner2, session_id, turn_id, legacy_rx, tx_env, outcome_tx);
        });

        let outcome = outcome_rx.await.unwrap();
        assert_eq!(outcome.status, TurnStatus::Failed);
        {
            let sessions = inner.read_sessions();
            let conversation = &sessions.get(&session_id).unwrap().conversation;
            assert_eq!(conversation.len(), 2);
            assert_eq!(conversation[1].content, "queued steering");
        }
        while rx_env.recv().await.is_some() {}
    }

    #[tokio::test]
    async fn buffered_deltas_are_capped() {
        let inner = test_inner();
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (tx, _rx) = tokio_mpsc::channel(1);
        let mut forwarder = EventForwarder::new(Arc::clone(&inner), session_id, turn_id, tx);

        forwarder.emit(RuntimeEvent::Thinking); // fills the single slot
        let chunk = "x".repeat(100_000);
        for _ in 0..40 {
            forwarder.emit(RuntimeEvent::AssistantDelta {
                text: chunk.clone(),
            });
            forwarder.emit(RuntimeEvent::ReasoningDelta {
                text: chunk.clone(),
            });
            forwarder.emit(RuntimeEvent::ToolProgress {
                id: "t1".to_string(),
                chunk: chunk.clone(),
            });
        }

        assert!(forwarder.assistant.len() <= MAX_BUFFERED_TEXT_BYTES + TRUNCATION_MARKER.len());
        assert!(forwarder.assistant.ends_with(TRUNCATION_MARKER));
        assert!(forwarder.reasoning.len() <= MAX_BUFFERED_TEXT_BYTES + TRUNCATION_MARKER.len());
        let progress = forwarder.progress.get("t1").unwrap();
        assert!(progress.len() <= MAX_BUFFERED_TOOL_PROGRESS_BYTES + TRUNCATION_MARKER.len());
        assert!(progress.ends_with(TRUNCATION_MARKER));
    }

    #[tokio::test]
    async fn buffered_deltas_flush_before_non_delta_events() {
        let inner = test_inner();
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (tx, mut rx) = tokio_mpsc::channel(1);
        let mut forwarder = EventForwarder::new(Arc::clone(&inner), session_id, turn_id, tx);

        forwarder.emit(RuntimeEvent::Thinking); // fills the single slot
        forwarder.emit(RuntimeEvent::AssistantDelta {
            text: "streamed".to_string(),
        }); // buffered: channel full

        let emitter = tokio::task::spawn_blocking(move || {
            // Channel still full: this flushes the buffered delta first, then
            // blocks until the ToolResult slot frees up.
            forwarder.emit(RuntimeEvent::ToolResult {
                id: "t1".to_string(),
                name: "shell".to_string(),
                content: "out".to_string(),
                is_error: false,
            });
        });

        let mut order: Vec<String> = Vec::new();
        while let Some(envelope) = rx.recv().await {
            match envelope.event {
                RuntimeEvent::Thinking => order.push("thinking".to_string()),
                RuntimeEvent::AssistantDelta { text } => order.push(format!("delta:{text}")),
                RuntimeEvent::ToolResult { .. } => {
                    order.push("tool_result".to_string());
                    break;
                }
                _ => order.push("other".to_string()),
            }
            if order.len() > 10 {
                break;
            }
        }
        emitter.await.unwrap();

        eprintln!("ORDER: {order:?}");
        let delta_pos = order
            .iter()
            .position(|event| event.starts_with("delta:"))
            .expect("buffered delta must be delivered");
        let result_pos = order
            .iter()
            .position(|event| event == "tool_result")
            .expect("tool result must be delivered");
        assert!(delta_pos < result_pos, "ordering violated: {order:?}");
    }

    #[tokio::test]
    async fn subscribers_see_child_spend_tagged_with_its_run() {
        let inner = test_inner();
        let mut attached = inner.events.subscribe();
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (tx_env, mut rx_env) = tokio_mpsc::channel(64);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        inner.lock_turns().insert(
            turn_id,
            TurnControl {
                trust: agente_protocol::Trust::Owner,
                cancel: AbortController::new(),
                inbox: agente_core::agent::UserInbox::default(),
                events: tx_env.clone(),
                session_id,
            },
        );

        let (legacy_tx, legacy_rx) = std::sync::mpsc::channel();
        let usage = |subagent_id: Option<&str>| AgentEvent::CallUsage {
            prompt_tokens: 10,
            completion_tokens: 5,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost_usd: Some(0.01),
            cost_estimated: true,
            subagent_id: subagent_id.map(str::to_string),
        };
        legacy_tx.send(task_event(usage(None))).unwrap();
        legacy_tx.send(task_event(usage(Some("child-1")))).unwrap();
        legacy_tx
            .send(task_event(AgentEvent::UserMessagesInjected {
                messages: vec!["more".into()],
            }))
            .unwrap();
        legacy_tx
            .send(task_event(AgentEvent::Done {
                conversation: vec![core_assistant_message("answer")],
                tokens: 15,
            }))
            .unwrap();
        drop(legacy_tx);

        let inner2 = Arc::clone(&inner);
        tokio::task::spawn_blocking(move || {
            forward_legacy_events(inner2, session_id, turn_id, legacy_rx, tx_env, outcome_tx);
        });
        assert_eq!(outcome_rx.await.unwrap().status, TurnStatus::Completed);

        let mut seen = Vec::new();
        while let Ok(envelope) = attached.try_recv() {
            seen.push(envelope);
        }
        let spends: Vec<_> = seen
            .iter()
            .filter(|e| matches!(e.event, RuntimeEvent::CallUsage { .. }))
            .collect();
        assert_eq!(spends.len(), 2);
        assert_eq!(spends[0].parent_run_id, None);
        assert_eq!(spends[1].parent_run_id, Some(inner.child_id("child-1")));
        assert!(seen
            .iter()
            .any(|e| matches!(&e.event, RuntimeEvent::UserMessagesInjected { messages } if messages == &["more"])));
        assert!(seen
            .iter()
            .any(|e| matches!(e.event, RuntimeEvent::TurnFinished { .. })));
        while rx_env.recv().await.is_some() {}
    }
}
