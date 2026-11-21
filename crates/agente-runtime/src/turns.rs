//! Turn execution, active-turn controls, steering, approvals, and direct tool runs.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use agente_core::agent::UserInbox;
use agente_core::permissions::ApprovalBroker;
use agente_core::types::{AgentMode, ApprovalAction};
use agente_core::AbortController;
use agente_protocol::{
    ApprovalDecision, ApprovalDecisionKind, Message, Role, RunId, RuntimeEvent,
    RuntimeEventEnvelope, SessionId, SessionSnapshot, StartTurn, Trust, TurnId, TurnMode,
    TurnOutcome, TurnStatus, UserInput,
};
use chrono::Utc;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::config::ProfileTurn;
use crate::sessions::{chat_message_count, first_prompt};
use crate::{bridge, RuntimeError, RuntimeHandle, RuntimeInner, EVENT_CAPACITY};

pub(crate) struct TurnGuard {
    inner: Arc<RuntimeInner>,
    turn_id: TurnId,
}

impl TurnGuard {
    pub(crate) fn new(inner: Arc<RuntimeInner>, turn_id: TurnId) -> Self {
        Self { inner, turn_id }
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.inner.lock_turns().remove(&self.turn_id);
    }
}

pub(crate) struct TurnControl {
    pub(crate) trust: Trust,
    pub(crate) cancel: AbortController,
    /// Steering input the running loop picks up at its next step; whatever
    /// is still here when the turn ends is committed as user messages.
    pub(crate) inbox: UserInbox,
    pub(crate) events: mpsc::Sender<RuntimeEventEnvelope>,
    pub(crate) session_id: SessionId,
}

pub struct TurnHandle {
    pub(crate) turn_id: TurnId,
    pub(crate) session_id: SessionId,
    pub conversation_index: Option<usize>,
    pub(crate) events: mpsc::Receiver<RuntimeEventEnvelope>,
    pub(crate) outcome: Option<oneshot::Receiver<TurnOutcome>>,
}

impl TurnHandle {
    pub fn turn_id(&self) -> TurnId {
        self.turn_id
    }

    pub fn session_id(&self) -> SessionId {
        self.session_id
    }

    pub async fn recv(&mut self) -> Option<RuntimeEventEnvelope> {
        self.events.recv().await
    }

    pub async fn outcome(&mut self) -> Option<TurnOutcome> {
        match self.outcome.take() {
            Some(outcome) => outcome.await.ok(),
            None => None,
        }
    }
}

/// The mode a turn may use: what it asked for (or the session's default),
/// capped by trust. Anyone but the owner is read-only. The flag says whether
/// every call is approved without asking (`auto`); `None` keeps the session's
/// current setting.
pub(crate) fn effective_mode(
    requested: Option<TurnMode>,
    default: AgentMode,
    trust: Trust,
) -> (AgentMode, Option<bool>) {
    if trust < Trust::Owner {
        return (AgentMode::Plan, Some(false));
    }
    match requested {
        Some(TurnMode::Plan) => (AgentMode::Plan, Some(false)),
        Some(TurnMode::Build) => (AgentMode::Build, Some(false)),
        Some(TurnMode::Auto) => (AgentMode::Build, Some(true)),
        None => (default, None),
    }
}

fn replace_system_prompt(conversation: &mut Vec<Message>, prompt: String) {
    match conversation
        .iter_mut()
        .find(|message| message.role == agente_protocol::Role::System)
    {
        Some(message) => message.content = prompt,
        None => ensure_system_prompt(conversation, &prompt),
    }
}

fn ensure_system_prompt(conversation: &mut Vec<Message>, prompt: &str) {
    if conversation
        .iter()
        .any(|message| message.role == agente_protocol::Role::System)
    {
        return;
    }
    conversation.insert(
        0,
        Message {
            role: agente_protocol::Role::System,
            content: prompt.to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
    );
}

impl RuntimeHandle {
    pub fn start_turn(&self, start: StartTurn) -> Result<TurnHandle, RuntimeError> {
        self.start_turn_with_tools(start, TurnId::new(), None)
    }

    /// Client tools belong to this turn only. Home must supply an empty native allowlist.
    pub fn start_turn_with_tools(
        &self,
        start: StartTurn,
        turn_id: TurnId,
        client_tools: Option<agente_core::agent::TurnTools>,
    ) -> Result<TurnHandle, RuntimeError> {
        if tokio::runtime::Handle::try_current().is_err() {
            return Err(RuntimeError::MissingExecutor);
        }
        let session_id = start.session_id;
        let (event_tx, event_rx) = mpsc::channel(EVENT_CAPACITY);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let cancel = AbortController::new();
        let inbox = UserInbox::default();

        // One active parent turn per session. The reservation is inserted
        // under the same lock as the check so two concurrent starts cannot
        // both pass; overlapping turns would otherwise each commit a full
        // conversation and silently drop the other's results.
        {
            let mut turns = self.inner.lock_turns();
            if turns
                .values()
                .any(|control| control.session_id == session_id)
            {
                return Err(RuntimeError::SessionBusy(session_id));
            }
            turns.insert(
                turn_id,
                TurnControl {
                    trust: start
                        .origin
                        .as_ref()
                        .map_or(Trust::Owner, |origin| origin.trust),
                    cancel: cancel.clone(),
                    inbox: Arc::clone(&inbox),
                    events: event_tx.clone(),
                    session_id,
                },
            );
        }
        let turn_guard = TurnGuard::new(Arc::clone(&self.inner), turn_id);

        // Single snapshot read: reuse the existing conversation and revision
        // instead of cloning the whole session twice per start. A cache miss
        // recovers from the durable store first so a resumed session continues
        // its persisted conversation and revision.
        let existing = self.inner.lookup_session(session_id);
        let mut conversation = if start.conversation.is_empty() {
            let mut conversation = existing.conversation.clone();
            conversation.extend(start.prompt);
            conversation
        } else {
            start.conversation
        };
        let context = self
            .inner
            .session_context(session_id, start.project_dir.as_deref());
        let trust = start
            .origin
            .as_ref()
            .map_or(Trust::Owner, |origin| origin.trust);
        let (mode, auto_approve) = effective_mode(start.mode, self.inner.config.mode, trust);
        {
            let mut engine = context
                .engine
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            engine.set_mode(mode);
            if let Some(auto_approve) = auto_approve {
                engine.set_auto_approve(auto_approve);
            }
        }
        let home = start.home.clone();
        let persona = start.profile.as_deref().and_then(|profile| {
            let persona = self.inner.config.profile_source.as_ref()?.persona(profile);
            if persona.is_none() {
                tracing::debug!(%session_id, profile, "turn names an unknown profile");
            }
            persona
        });
        let has_persona = persona.is_some();
        match (start.system_prompt, persona) {
            (Some(prompt), _) if home.is_some() => replace_system_prompt(&mut conversation, prompt),
            (Some(prompt), _) => ensure_system_prompt(&mut conversation, &prompt),
            // A bot's persona holds its memory: rebuilt every turn, so an
            // edit made last turn is what it knows now.
            (None, Some(persona)) => {
                let registry = agente_core::tools::ToolRegistry::new(&context.project_dir);
                let prompt = agente_core::context::bot_system_prompt(
                    &persona,
                    &context.project_dir,
                    &registry.definitions(),
                );
                replace_system_prompt(&mut conversation, prompt);
            }
            (None, None) => ensure_system_prompt(
                &mut conversation,
                &self.inner.cached_system_prompt(&context.project_dir),
            ),
        }
        // Project instructions (AGENTS.md) as a user-message reminder;
        // idempotent, so it also re-attaches after compaction dropped it.
        if home.is_none()
            && !agente_core::context::conversation_has_reminder(
                conversation.iter().map(|m| m.content.as_str()),
            )
        {
            if let Some(reminder) = agente_core::context::agents_md_reminder(&context.project_dir) {
                let insert_at = conversation
                    .iter()
                    .position(|m| m.role == agente_protocol::Role::System)
                    .map(|i| i + 1)
                    .unwrap_or(0);
                conversation.insert(
                    insert_at,
                    agente_protocol::Message {
                        role: agente_protocol::Role::User,
                        content: reminder,
                        tool_calls: None,
                        tool_call_id: None,
                        thinking: None,
                        thinking_signature: None,
                        continuation: None,
                        attachments: Vec::new(),
                    },
                );
            }
        }
        let conversation_index = conversation
            .iter()
            .rposition(|message| message.role == Role::User);
        let revision = existing.revision;
        let snapshot = SessionSnapshot {
            session_id,
            revision,
            conversation: conversation.clone(),
        };
        {
            let commit_lock = self.inner.commit_lock(session_id);
            let _commit = commit_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.inner
                .write_sessions()
                .insert(session_id, snapshot.clone());
            // Preserve the initial durable checkpoint without blocking other sessions.
            self.inner.persist_snapshot(&snapshot);
        }

        let live = self.inner.live();

        let provider = start
            .provider
            .unwrap_or_else(|| live.default_provider.clone());
        let model = start.model.unwrap_or_else(|| live.default_model.clone());
        let thinking = start
            .thinking_level
            .unwrap_or_else(|| live.default_thinking_level.clone());
        let mut turn_tools = client_tools.unwrap_or_else(|| {
            match (
                has_persona,
                start.profile.as_deref(),
                &self.inner.config.profile_source,
            ) {
                (true, Some(profile), Some(source)) => agente_core::agent::TurnTools {
                    mcp_turn_id: None,
                    extra: source.tools(
                        profile,
                        &ProfileTurn {
                            origin: start.origin.clone().unwrap_or_default(),
                            provider: provider.clone(),
                            model: model.clone(),
                            thinking_level: thinking.clone(),
                        },
                    ),
                    only: source.tool_names(profile),
                    // A bot's commands never see the host's keys or tokens, and
                    // run boxed wherever this machine can box them.
                    shell_env: if agente_core::sandbox::available() {
                        agente_core::tools::ShellEnv::Boxed(source.sandbox(profile))
                    } else {
                        agente_core::tools::ShellEnv::Clean
                    },
                },
                _ if home.is_some() => agente_core::agent::TurnTools {
                    only: Some(Vec::new()),
                    ..Default::default()
                },
                _ => agente_core::agent::TurnTools::default(),
            }
        });
        {
            let (provider, model, thinking) = (provider.clone(), model.clone(), thinking.clone());
            let profile = start.profile.clone();
            let prompt = first_prompt(&conversation);
            let count = chat_message_count(&conversation);
            self.inner
                .update_meta(session_id, &context.project_dir, |info| {
                    info.project_dir = context.project_dir.clone();
                    info.provider = provider;
                    info.model = model;
                    info.thinking_level = thinking;
                    if profile.is_some() {
                        info.profile = profile;
                    }
                    if info.first_prompt.is_empty() {
                        info.first_prompt = prompt;
                    }
                    info.message_count = count;
                    info.last_active = Utc::now();
                });
        }
        self.inner
            .lock_edits()
            .begin_turn(session_id, conversation.len());
        let task_id = self
            .inner
            .task_sequence
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1);
        let (legacy_tx, legacy_rx) = std::sync::mpsc::channel();

        turn_tools.mcp_turn_id = Some(turn_id.as_uuid());
        let _legacy_task = agente_core::agent::spawn_chat_task(
            session_id.as_uuid(),
            task_id,
            legacy_tx,
            conversation,
            provider,
            model,
            thinking,
            context.project_dir.clone(),
            home.as_ref()
                .map_or(live.max_iterations, |policy| policy.max_iterations),
            Arc::clone(&live.provider_registry),
            live.catalog.clone(),
            context.engine.clone(),
            cancel.signal(),
            self.inner.config.approval_broker.clone(),
            Some(self.inner.project_mcp(&context.project_dir)),
            self.inner.config.subagent_registry.clone(),
            live.subagents.clone(),
            live.smart_compaction,
            live.compaction_model.clone(),
            // The gap this session measured last turn.
            self.inner.context_gap(session_id),
            live.max_parallel_subagents,
            inbox,
            turn_tools,
        );

        let started = self.envelope(session_id, turn_id, None, RuntimeEvent::TurnStarted);
        self.inner.publish(&started);
        if event_tx.try_send(started).is_err() {
            // Stop the spawned loop and release the reservation: the caller never receives a handle.
            cancel.abort();
            return Err(RuntimeError::EventStreamClosed);
        }

        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            let _turn_guard = turn_guard;
            bridge::forward_legacy_events(
                inner, session_id, turn_id, legacy_rx, event_tx, outcome_tx,
            );
        });

        Ok(TurnHandle {
            turn_id,
            session_id,
            conversation_index,
            events: event_rx,
            outcome: Some(outcome_rx),
        })
    }

    pub fn cancel(&self, turn_id: TurnId) -> bool {
        let turns = self.inner.lock_turns();
        if let Some(control) = turns.get(&turn_id) {
            control.cancel.abort();
            true
        } else {
            false
        }
    }

    pub fn approve(&self, decision: ApprovalDecision) -> bool {
        let action = match decision.decision {
            ApprovalDecisionKind::ApproveOnce => ApprovalAction::ApproveOnce,
            ApprovalDecisionKind::ApproveAll => ApprovalAction::ApproveAll,
            ApprovalDecisionKind::Deny => ApprovalAction::Deny,
            ApprovalDecisionKind::Cancel => ApprovalAction::Cancel,
        };
        self.inner
            .config
            .approval_broker
            .respond(&decision.request_id, action)
    }

    /// Hand input to the running turn: the loop reads it at its next step
    /// (after a tool round, or right after the reply it is streaming) and
    /// answers it in the same turn. Nothing is cancelled.
    pub fn steer(&self, turn_id: TurnId, input: UserInput) -> bool {
        self.steer_message(turn_id, Message::user(input.content))
    }

    /// Change active-turn controls. Request settings apply at the next safe
    /// completion boundary; permissions change immediately for future tools.
    pub fn update_turn(
        &self,
        turn_id: TurnId,
        thinking: Option<String>,
        mode: Option<TurnMode>,
    ) -> bool {
        let (session_id, trust, inbox) = {
            let turns = self.inner.lock_turns();
            let Some(control) = turns
                .get(&turn_id)
                .filter(|control| !control.inbox.is_closed())
            else {
                return false;
            };
            (
                control.session_id,
                control.trust,
                Arc::clone(&control.inbox),
            )
        };
        if let Some(mode) = mode {
            let context = self.inner.session_context(session_id, None);
            let (mode, auto) = effective_mode(Some(mode), self.inner.config.mode, trust);
            let mut engine = context
                .engine
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            engine.set_mode(mode);
            if let Some(auto) = auto {
                engine.set_auto_approve(auto);
            }
        }
        inbox.update_settings(thinking);
        true
    }

    pub fn steer_message(&self, turn_id: TurnId, message: Message) -> bool {
        let turns = self.inner.lock_turns();
        let Some(control) = turns.get(&turn_id) else {
            return false;
        };
        if control.inbox.is_closed() {
            return false;
        }
        control.inbox.lock().push(message);
        control.inbox.interrupt_thinking();
        let envelope = self.envelope(
            control.session_id,
            turn_id,
            None,
            RuntimeEvent::SteeringQueued,
        );
        self.inner.publish(&envelope);
        if let Err(error) = control.events.try_send(envelope) {
            tracing::debug!(%error, "steering notification dropped: event stream closed or full");
        }
        true
    }

    /// Every event of every turn from now on. A receiver that falls more than
    /// a few thousand events behind gets `Lagged` and should re-read the
    /// session snapshot.
    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEventEnvelope> {
        self.inner.events.subscribe()
    }

    pub fn cancel_child(&self, run_id: RunId) -> bool {
        let legacy = self
            .inner
            .lock_children()
            .iter()
            .find_map(|(legacy, id)| (*id == run_id).then(|| legacy.clone()));
        legacy.is_some_and(|id| self.inner.config.subagent_registry.cancel(&id))
    }

    /// Run one tool the user asked for directly (the TUI's `!command`),
    /// outside the model loop: no model call, no approval prompt, and the
    /// conversation is left as it is. It occupies the session like a turn, so
    /// `cancel` stops it and no turn can start meanwhile. Owner only.
    pub fn exec_tool(
        &self,
        session_id: SessionId,
        tool: &str,
        arguments: serde_json::Value,
        trust: Trust,
    ) -> Result<TurnHandle, RuntimeError> {
        self.exec_tool_with_id(session_id, TurnId::new(), tool, arguments, trust)
    }

    pub fn exec_tool_with_id(
        &self,
        session_id: SessionId,
        turn_id: TurnId,
        tool: &str,
        arguments: serde_json::Value,
        trust: Trust,
    ) -> Result<TurnHandle, RuntimeError> {
        if trust < Trust::Owner {
            return Err(RuntimeError::NotAllowed(format!(
                "only the owner can run {tool} directly"
            )));
        }
        if tokio::runtime::Handle::try_current().is_err() {
            return Err(RuntimeError::MissingExecutor);
        }
        let (event_tx, event_rx) = mpsc::channel(EVENT_CAPACITY);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let cancel = AbortController::new();
        {
            let mut turns = self.inner.lock_turns();
            if turns
                .values()
                .any(|control| control.session_id == session_id)
            {
                return Err(RuntimeError::SessionBusy(session_id));
            }
            turns.insert(
                turn_id,
                TurnControl {
                    trust: Trust::Owner,
                    cancel: cancel.clone(),
                    inbox: UserInbox::default(),
                    events: event_tx.clone(),
                    session_id,
                },
            );
        }
        let turn_guard = TurnGuard::new(Arc::clone(&self.inner), turn_id);
        let project_dir = self.inner.session_context(session_id, None).project_dir;
        let inner = Arc::clone(&self.inner);
        let tool = tool.to_string();
        let call_id = format!("direct-{turn_id}");
        tokio::spawn(async move {
            let emit = |event: RuntimeEvent| {
                let envelope = inner.envelope(session_id, turn_id, None, event);
                inner.publish(&envelope);
                // A client that stopped reading must not stall the tool.
                let _ = event_tx.try_send(envelope);
            };
            emit(RuntimeEvent::TurnStarted);
            emit(RuntimeEvent::ToolProposed {
                id: call_id.clone(),
                name: tool.clone(),
                arguments: arguments.to_string(),
            });
            let progress_inner = Arc::clone(&inner);
            let progress_tx = event_tx.clone();
            let progress_id = call_id.clone();
            let context = agente_core::tools::ToolExecutionContext::new(cancel.signal())
                .with_progress(move |progress| {
                    let chunk = match progress.stream {
                        agente_core::tools::ToolOutputStream::Stdout => progress.content,
                        agente_core::tools::ToolOutputStream::Stderr => {
                            format!("[stderr] {}", progress.content)
                        }
                    };
                    let envelope = progress_inner.envelope(
                        session_id,
                        turn_id,
                        None,
                        RuntimeEvent::ToolProgress {
                            id: progress_id.clone(),
                            chunk,
                        },
                    );
                    progress_inner.publish(&envelope);
                    let _ = progress_tx.try_send(envelope);
                });
            let result = agente_core::tools::ToolRegistry::new(&project_dir)
                .execute_with_context(&tool, arguments, context)
                .await;
            let (content, is_error) = match result {
                Ok(content) => (content, false),
                Err(error) => (format!("Error: {error}"), true),
            };
            emit(RuntimeEvent::ToolResult {
                id: call_id,
                name: tool,
                content: content.clone(),
                is_error,
            });
            let revision = inner.lookup_session(session_id).revision;
            let cancelled = cancel.signal().is_aborted();
            emit(if cancelled {
                RuntimeEvent::TurnCancelled {
                    revision,
                    partial_text: content,
                }
            } else {
                RuntimeEvent::TurnFinished { revision }
            });
            drop(turn_guard);
            let _ = outcome_tx.send(TurnOutcome {
                turn_id,
                session_id,
                status: if cancelled {
                    TurnStatus::Cancelled
                } else {
                    TurnStatus::Completed
                },
                revision,
                tokens: 0,
                error: None,
            });
        });
        Ok(TurnHandle {
            turn_id,
            session_id,
            conversation_index: None,
            events: event_rx,
            outcome: Some(outcome_rx),
        })
    }

    /// Whether a turn is running in the session.
    pub fn is_busy(&self, session_id: SessionId) -> bool {
        self.inner
            .lock_turns()
            .values()
            .any(|control| control.session_id == session_id)
    }

    pub fn approval_broker(&self) -> ApprovalBroker {
        self.inner.config.approval_broker.clone()
    }
}
