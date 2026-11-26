//! Turn execution, active-turn controls, steering, approvals, and direct tool runs.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use agente_core::agent::UserInbox;
use agente_core::permissions::ApprovalBroker;
use agente_core::types::{AgentMode, ApprovalAction};
use agente_core::AbortController;
use agente_drivers::{
    effective_model, AgentDriver, DriverError, DriverEvent, DriverSession, DriverSessionOpen,
    DriverTurnRequest, InjectedMcpServer, BUILTIN_AGENTE_INSTANCE,
};
use agente_protocol::{
    ApprovalDecision, ApprovalDecisionKind, DriverKind, InputResponse, Message, Role, RunId,
    RuntimeEvent, RuntimeEventEnvelope, SessionId, SessionSnapshot, StartTurn, Trust, TurnId,
    TurnMode, TurnOutcome, TurnStatus, UserInput,
};
use chrono::Utc;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::config::{OrchestratorContext, ProfileTurn};
use crate::sessions::{chat_message_count, first_prompt};
use crate::{
    bridge, BoundDriverSession, RuntimeError, RuntimeHandle, RuntimeInner, EVENT_CAPACITY,
};

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

pub(crate) struct ExternalTurnControl {
    pub(crate) supports_steer: bool,
    pub(crate) session: Option<Arc<dyn DriverSession>>,
}

pub(crate) struct TurnControl {
    pub(crate) trust: Trust,
    pub(crate) cancel: AbortController,
    /// Steering input the running loop picks up at its next step; whatever
    /// is still here when the turn ends is committed as user messages.
    pub(crate) inbox: UserInbox,
    pub(crate) events: mpsc::Sender<RuntimeEventEnvelope>,
    pub(crate) session_id: SessionId,
    pub(crate) external_driver: Option<ExternalTurnControl>,
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
    fn resolve_instance_id(&self, session_id: SessionId, requested: Option<&str>) -> String {
        if let Some(id) = requested.map(str::trim).filter(|id| !id.is_empty()) {
            return id.to_string();
        }
        if let Some(bound) = self.inner.lock_driver_sessions().get(&session_id) {
            return bound.instance_id.clone();
        }
        if let Some(bound_id) = self
            .inner
            .bound_instances
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&session_id)
        {
            return bound_id.clone();
        }
        if let Some(meta) = self.session_meta(session_id) {
            if let Some(id) = meta
                .info
                .instance_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
            {
                return id.to_string();
            }
        }
        BUILTIN_AGENTE_INSTANCE.to_string()
    }

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
        let resolved_instance_id = self.resolve_instance_id(session_id, start.instance_id.as_deref());
        let external_driver = if resolved_instance_id != BUILTIN_AGENTE_INSTANCE {
            let driver = self
                .inner
                .driver_registry
                .get(&resolved_instance_id)
                .ok_or_else(|| DriverError::NotFound(resolved_instance_id.clone()))?;
            let descriptor = driver.descriptor();
            if !descriptor.enabled {
                return Err(DriverError::Disabled(resolved_instance_id).into());
            }
            Some((driver, descriptor.capabilities.steer))
        } else {
            None
        };

        let (event_tx, event_rx) = mpsc::channel(EVENT_CAPACITY);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let cancel = AbortController::new();
        let inbox = UserInbox::default();

        let existing_external_session = external_driver.as_ref().and_then(|_| {
            let guard = self.inner.lock_driver_sessions();
            guard
                .get(&session_id)
                .filter(|bound| bound.instance_id == resolved_instance_id)
                .map(|bound| Arc::clone(&bound.session))
        });

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
                    external_driver: external_driver.as_ref().map(|(_, supports_steer)| {
                        ExternalTurnControl {
                            supports_steer: *supports_steer,
                            session: existing_external_session,
                        }
                    }),
                },
            );
        }
        let turn_guard = TurnGuard::new(Arc::clone(&self.inner), turn_id);

        if let Some((driver, _supports_steer)) = external_driver {
            return self.start_external_turn(ExternalTurnStart {
                driver,
                instance_id: resolved_instance_id,
                start,
                turn_id,
                turn_guard,
                cancel,
                event_tx,
                event_rx,
                outcome_tx,
                outcome_rx,
            });
        }

        // Switching back to built-in `agente`: release any idle external CLI session.
        self.inner.close_bound_driver_session(session_id);
        self.inner
            .bound_instances
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id, BUILTIN_AGENTE_INSTANCE.to_string());

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
        if home.is_none() {
            agente_core::context::inject_project_reminder(&mut conversation, &context.project_dir);
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
        let has_custom_tools = client_tools.is_some();
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
        if home.is_none() && !has_persona && !has_custom_tools {
            if let Some(orchestrator) = &self.inner.config.orchestrator {
                let session_auto = context
                    .engine
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .auto_approve();
                let effective_turn_mode = match (mode, session_auto) {
                    (AgentMode::Plan, _) => TurnMode::Plan,
                    (AgentMode::Build, true) => TurnMode::Auto,
                    (AgentMode::Build, false) => TurnMode::Build,
                };
                let ctx = OrchestratorContext {
                    session_id,
                    project_dir: context.project_dir.clone(),
                    mode: effective_turn_mode,
                    depth: self.session_depth(session_id),
                };
                turn_tools.extra.extend(orchestrator.builtin_tools(&ctx));
            }
        }
        {
            let (provider, model, thinking) = (provider.clone(), model.clone(), thinking.clone());
            let profile = start.profile.clone();
            let worktree = start.worktree.clone();
            let prompt = first_prompt(&conversation);
            let count = chat_message_count(&conversation);
            self.inner
                .update_meta(session_id, &context.project_dir, |info| {
                    info.project_dir = context.project_dir.clone();
                    info.provider = provider;
                    info.model = model;
                    info.thinking_level = thinking;
                    info.instance_id = Some(BUILTIN_AGENTE_INSTANCE.to_string());
                    info.driver_kind = Some(DriverKind::Agente);
                    info.external_session_id = None;
                    if let Some(worktree) = worktree {
                        info.worktree = Some(worktree);
                    }
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
        let turn_prompt = conversation_index.map(|index| conversation[index].content.as_str());
        self.inner
            .lock_edits()
            .begin_turn(session_id, conversation.len(), turn_prompt);
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
        let (found, session_id, driver_session) = {
            let turns = self.inner.lock_turns();
            match turns.get(&turn_id) {
                Some(control) => {
                    control.cancel.abort();
                    (
                        true,
                        Some(control.session_id),
                        control
                            .external_driver
                            .as_ref()
                            .and_then(|ext| ext.session.clone()),
                    )
                }
                None => (false, None, None),
            }
        };
        if let Some(session_id) = session_id {
            self.inner.approval_router.cancel_session(session_id);
        }
        if let Some(session) = driver_session {
            if let Ok(executor) = tokio::runtime::Handle::try_current() {
                executor.spawn(async move {
                    let _ = session.cancel(turn_id).await;
                });
            }
        }
        found
    }

    pub fn approve(&self, decision: ApprovalDecision) -> bool {
        if self.inner.approval_router.respond(decision.clone()) {
            return true;
        }
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

    pub fn respond_input(&self, response: InputResponse) -> bool {
        self.inner.approval_router.respond_input(response)
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
        enum SteerTarget {
            Builtin {
                session_id: SessionId,
                events: mpsc::Sender<RuntimeEventEnvelope>,
            },
            External {
                session_id: SessionId,
                session: Arc<dyn DriverSession>,
                events: mpsc::Sender<RuntimeEventEnvelope>,
            },
        }
        let target = {
            let turns = self.inner.lock_turns();
            let Some(control) = turns.get(&turn_id) else {
                return false;
            };
            if control.inbox.is_closed() {
                return false;
            }
            if let Some(ext) = &control.external_driver {
                if !ext.supports_steer {
                    return false;
                }
                let Some(session) = ext.session.as_ref() else {
                    return false;
                };
                SteerTarget::External {
                    session_id: control.session_id,
                    session: Arc::clone(session),
                    events: control.events.clone(),
                }
            } else {
                control.inbox.lock().push(message.clone());
                control.inbox.interrupt_thinking();
                SteerTarget::Builtin {
                    session_id: control.session_id,
                    events: control.events.clone(),
                }
            }
        };
        match target {
            SteerTarget::Builtin { session_id, events } => {
                let envelope =
                    self.envelope(session_id, turn_id, None, RuntimeEvent::SteeringQueued);
                self.inner.publish(&envelope);
                if let Err(error) = events.try_send(envelope) {
                    tracing::debug!(
                        %error,
                        "steering notification dropped: event stream closed or full"
                    );
                }
                true
            }
            SteerTarget::External {
                session_id,
                session,
                events,
            } => {
                let Ok(executor) = tokio::runtime::Handle::try_current() else {
                    return false;
                };
                let queued =
                    self.envelope(session_id, turn_id, None, RuntimeEvent::SteeringQueued);
                self.inner.publish(&queued);
                let _ = events.try_send(queued);
                let inner = Arc::clone(&self.inner);
                executor.spawn(async move {
                    let text = message.content.clone();
                    if session.steer(message).await {
                        let injected = inner.envelope(
                            session_id,
                            turn_id,
                            None,
                            RuntimeEvent::UserMessagesInjected {
                                messages: vec![text],
                            },
                        );
                        inner.publish(&injected);
                        let _ = events.try_send(injected);
                    }
                });
                true
            }
        }
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
                    external_driver: None,
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

struct ExternalTurnStart {
    driver: Arc<dyn AgentDriver>,
    instance_id: String,
    start: StartTurn,
    turn_id: TurnId,
    turn_guard: TurnGuard,
    cancel: AbortController,
    event_tx: mpsc::Sender<RuntimeEventEnvelope>,
    event_rx: mpsc::Receiver<RuntimeEventEnvelope>,
    outcome_tx: oneshot::Sender<TurnOutcome>,
    outcome_rx: oneshot::Receiver<TurnOutcome>,
}

struct ExternalTurnRunnerSpec {
    inner: Arc<RuntimeInner>,
    turn_guard: TurnGuard,
    session_id: SessionId,
    turn_id: TurnId,
    instance_id: String,
    project_dir: String,
    cwd: String,
    driver: Arc<dyn AgentDriver>,
    resume_external_id: Option<String>,
    conversation: Vec<Message>,
    turn_mode: TurnMode,
    model: Option<String>,
    thinking_level: Option<String>,
    interactive: bool,
    mcp_servers: Vec<InjectedMcpServer>,
    prompt: Message,
    cancel: AbortController,
    event_tx: mpsc::Sender<RuntimeEventEnvelope>,
    outcome_tx: oneshot::Sender<TurnOutcome>,
}

impl RuntimeHandle {
    fn start_external_turn(&self, req: ExternalTurnStart) -> Result<TurnHandle, RuntimeError> {
        let ExternalTurnStart {
            driver,
            instance_id,
            start,
            turn_id,
            turn_guard,
            cancel,
            event_tx,
            event_rx,
            outcome_tx,
            outcome_rx,
        } = req;
        let session_id = start.session_id;
        let existing = self.inner.lookup_session(session_id);
        let conversation = if start.conversation.is_empty() {
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
        let turn_mode = match (trust < Trust::Owner, start.mode) {
            (true, _) => TurnMode::Plan,
            (false, Some(mode)) => mode,
            (false, None) => match self.inner.config.mode {
                AgentMode::Build => TurnMode::Build,
                AgentMode::Plan => TurnMode::Plan,
            },
        };
        let conversation_index = conversation
            .iter()
            .rposition(|message| message.role == Role::User);
        let prompt = conversation_index
            .map(|idx| conversation[idx].clone())
            .unwrap_or_else(|| Message::user(""));
        let snapshot = SessionSnapshot {
            session_id,
            revision: existing.revision,
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
            self.inner.persist_snapshot(&snapshot);
        }
        self.inner
            .bound_instances
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id, instance_id.clone());

        let resume_external_id = self.session_meta(session_id).and_then(|meta| {
            if meta.info.instance_id.as_deref() == Some(instance_id.as_str()) {
                meta.info.external_session_id
            } else {
                None
            }
        });
        let cwd = start
            .worktree
            .as_ref()
            .map(|wt| wt.path.clone())
            .unwrap_or_else(|| context.project_dir.clone());
        let requested_model = effective_model(start.model.as_deref()).map(str::to_string);
        let driver_kind = driver.driver_kind();
        {
            let (inst_id, model_meta, thinking_meta) = (
                instance_id.clone(),
                requested_model.clone().unwrap_or_default(),
                start.thinking_level.clone().unwrap_or_default(),
            );
            let profile_meta = start.profile.clone();
            let worktree_meta = start.worktree.clone();
            let first = first_prompt(&conversation);
            let count = chat_message_count(&conversation);
            self.inner
                .update_meta(session_id, &context.project_dir, |info| {
                    if info.instance_id.as_deref() != Some(inst_id.as_str()) {
                        info.external_session_id = None;
                    }
                    info.project_dir = context.project_dir.clone();
                    info.instance_id = Some(inst_id.clone());
                    info.driver_kind = Some(driver_kind);
                    info.provider = inst_id;
                    info.model = model_meta;
                    info.thinking_level = thinking_meta;
                    if let Some(worktree) = worktree_meta {
                        info.worktree = Some(worktree);
                    }
                    if profile_meta.is_some() {
                        info.profile = profile_meta;
                    }
                    if info.first_prompt.is_empty() {
                        info.first_prompt = first;
                    }
                    info.message_count = count;
                    info.last_active = Utc::now();
                });
        }
        let orchestrator_ctx = OrchestratorContext {
            session_id,
            project_dir: context.project_dir.clone(),
            mode: turn_mode,
            depth: self.session_depth(session_id),
        };
        let mcp_servers: Vec<InjectedMcpServer> = self
            .inner
            .config
            .orchestrator
            .as_ref()
            .and_then(|provider| provider.mcp_for_session(&orchestrator_ctx))
            .into_iter()
            .collect();
        let turn_prompt = conversation_index.map(|index| conversation[index].content.as_str());
        self.inner
            .lock_edits()
            .begin_turn(session_id, conversation.len(), turn_prompt);

        let started = self.envelope(session_id, turn_id, None, RuntimeEvent::TurnStarted);
        self.inner.publish(&started);
        if event_tx.try_send(started).is_err() {
            cancel.abort();
            return Err(RuntimeError::EventStreamClosed);
        }

        let interactive = start
            .origin
            .as_ref()
            .is_none_or(|origin| origin.channel != "orchestrator");

        let spec = ExternalTurnRunnerSpec {
            inner: Arc::clone(&self.inner),
            turn_guard,
            session_id,
            turn_id,
            instance_id,
            project_dir: context.project_dir,
            cwd,
            driver,
            resume_external_id,
            conversation,
            turn_mode,
            model: requested_model,
            thinking_level: start.thinking_level,
            interactive,
            mcp_servers,
            prompt,
            cancel,
            event_tx,
            outcome_tx,
        };
        tokio::spawn(run_external_turn(spec));

        Ok(TurnHandle {
            turn_id,
            session_id,
            conversation_index,
            events: event_rx,
            outcome: Some(outcome_rx),
        })
    }
}

fn emit_runtime(
    inner: &RuntimeInner,
    event_tx: &mpsc::Sender<RuntimeEventEnvelope>,
    session_id: SessionId,
    turn_id: TurnId,
    event: RuntimeEvent,
) {
    let envelope = inner.envelope(session_id, turn_id, None, event);
    inner.publish(&envelope);
    let _ = event_tx.try_send(envelope);
}

fn persist_external_session_id(
    inner: &RuntimeInner,
    session_id: SessionId,
    project_dir: &str,
    external_session_id: String,
) {
    inner.update_meta(session_id, project_dir, |info| {
        info.external_session_id = Some(external_session_id);
    });
}

async fn run_external_turn(spec: ExternalTurnRunnerSpec) {
    let ExternalTurnRunnerSpec {
        inner,
        turn_guard,
        session_id,
        turn_id,
        instance_id,
        project_dir,
        cwd,
        driver,
        resume_external_id,
        mut conversation,
        turn_mode,
        model,
        thinking_level,
        interactive,
        mcp_servers,
        prompt,
        cancel,
        event_tx,
        outcome_tx,
    } = spec;

    let stale_session = {
        let mut guard = inner.lock_driver_sessions();
        match guard.get(&session_id) {
            Some(bound) if bound.instance_id != instance_id => guard.remove(&session_id),
            _ => None,
        }
    };
    if let Some(old) = stale_session {
        old.session.close().await;
    }

    let existing_session = {
        let guard = inner.lock_driver_sessions();
        guard
            .get(&session_id)
            .filter(|bound| bound.instance_id == instance_id)
            .map(|bound| Arc::clone(&bound.session))
    };

    let session = match existing_session {
        Some(session) => session,
        None => {
            let open_spec = DriverSessionOpen {
                session_id,
                project_dir: cwd.clone(),
                external_session_id: resume_external_id,
                mode: turn_mode,
                model: model.clone(),
                mcp_servers: mcp_servers.clone(),
                interactive,
            };
            match driver
                .open_session(open_spec, inner.approval_router.clone())
                .await
            {
                Ok(session) => {
                    let replaced = inner.lock_driver_sessions().insert(
                        session_id,
                        BoundDriverSession {
                            instance_id: instance_id.clone(),
                            session: Arc::clone(&session),
                        },
                    );
                    if let Some(old) = replaced {
                        if !Arc::ptr_eq(&old.session, &session) {
                            old.session.close().await;
                        }
                    }
                    if let Some(ext_id) = session.external_session_id() {
                        persist_external_session_id(&inner, session_id, &project_dir, ext_id);
                    }
                    session
                }
                Err(error) => {
                    let message = error.to_string();
                    emit_runtime(
                        &inner,
                        &event_tx,
                        session_id,
                        turn_id,
                        RuntimeEvent::TurnFailed {
                            message: message.clone(),
                        },
                    );
                    let revision = inner.lookup_session(session_id).revision;
                    drop(turn_guard);
                    let _ = outcome_tx.send(TurnOutcome {
                        turn_id,
                        session_id,
                        status: TurnStatus::Failed,
                        revision,
                        tokens: 0,
                        error: Some(message),
                    });
                    return;
                }
            }
        }
    };

    {
        let mut turns = inner.lock_turns();
        if let Some(control) = turns.get_mut(&turn_id) {
            if let Some(ext) = control.external_driver.as_mut() {
                ext.session = Some(Arc::clone(&session));
            }
        }
    }

    if cancel.signal().is_aborted() {
        let _ = session.cancel(turn_id).await;
        inner.approval_router.cancel_session(session_id);
        let revision = inner.lookup_session(session_id).revision;
        emit_runtime(
            &inner,
            &event_tx,
            session_id,
            turn_id,
            RuntimeEvent::TurnCancelled {
                revision,
                partial_text: String::new(),
            },
        );
        drop(turn_guard);
        let _ = outcome_tx.send(TurnOutcome {
            turn_id,
            session_id,
            status: TurnStatus::Cancelled,
            revision,
            tokens: 0,
            error: None,
        });
        return;
    }

    let (driver_tx, mut driver_rx) = mpsc::channel(EVENT_CAPACITY);
    let turn_session = Arc::clone(&session);
    let turn_request = DriverTurnRequest {
        session_id,
        turn_id,
        prompt,
        model,
        thinking_level,
        mode: turn_mode,
        cwd,
        mcp_servers,
    };
    let runner = tokio::spawn(async move { turn_session.start_turn(turn_request, driver_tx).await });

    let mut streamed_text = String::new();
    let mut completion: Option<(TurnStatus, String, u32, Option<String>)> = None;
    while let Some(ev) = driver_rx.recv().await {
        match ev {
            DriverEvent::ExternalSessionBound(ext_id) => {
                persist_external_session_id(&inner, session_id, &project_dir, ext_id);
            }
            DriverEvent::BackgroundWork(_) => {}
            DriverEvent::Runtime(runtime_ev) => {
                match &runtime_ev {
                    RuntimeEvent::AssistantDelta { text } => streamed_text.push_str(text),
                    RuntimeEvent::AssistantMessage { text } if !text.is_empty() => {
                        streamed_text = text.clone();
                    }
                    RuntimeEvent::ModelChanged { model, provider } => {
                        let new_model = model.clone();
                        let new_provider = provider.clone();
                        inner.update_meta(session_id, &project_dir, |info| {
                            info.model = new_model;
                            if let Some(p) = new_provider {
                                info.provider = p;
                            }
                        });
                    }
                    _ => {}
                }
                if !runtime_ev.is_terminal() {
                    emit_runtime(&inner, &event_tx, session_id, turn_id, runtime_ev);
                }
            }
            DriverEvent::TurnComplete {
                status,
                assistant_text,
                tokens,
                error,
            } => {
                completion = Some((status, assistant_text, tokens, error));
            }
        }
    }

    let runner_res = runner.await;
    let (mut status, mut assistant_text, tokens, mut error) = match completion {
        Some(done) => done,
        None => match runner_res {
            Ok(Ok(())) => (TurnStatus::Completed, String::new(), 0, None),
            Ok(Err(DriverError::Cancelled)) => (TurnStatus::Cancelled, String::new(), 0, None),
            Ok(Err(err)) => (TurnStatus::Failed, String::new(), 0, Some(err.to_string())),
            Err(join_err) => (TurnStatus::Failed, String::new(), 0, Some(join_err.to_string())),
        },
    };

    if cancel.signal().is_aborted() && status != TurnStatus::Cancelled {
        status = TurnStatus::Cancelled;
        error = None;
    }
    if assistant_text.is_empty() && !streamed_text.is_empty() {
        assistant_text = streamed_text;
    }
    if let Some(ext_id) = session.external_session_id() {
        persist_external_session_id(&inner, session_id, &project_dir, ext_id);
    }

    inner.approval_router.cancel_session(session_id);
    {
        let turns = inner.lock_turns();
        if let Some(control) = turns.get(&turn_id) {
            control.inbox.close();
        }
    }

    let revision = if status == TurnStatus::Completed && !assistant_text.is_empty() {
        conversation.push(Message {
            role: Role::Assistant,
            content: assistant_text.clone(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        });
        bridge::replace_conversation(&inner, session_id, conversation)
    } else {
        inner.lookup_session(session_id).revision
    };

    let terminal_event = match status {
        TurnStatus::Completed => RuntimeEvent::TurnFinished { revision },
        TurnStatus::Cancelled => RuntimeEvent::TurnCancelled {
            revision,
            partial_text: assistant_text.clone(),
        },
        TurnStatus::Failed => RuntimeEvent::TurnFailed {
            message: error
                .clone()
                .unwrap_or_else(|| "External driver turn failed".to_string()),
        },
    };
    emit_runtime(&inner, &event_tx, session_id, turn_id, terminal_event);
    drop(turn_guard);
    let _ = outcome_tx.send(TurnOutcome {
        turn_id,
        session_id,
        status,
        revision,
        tokens,
        error,
    });
}
