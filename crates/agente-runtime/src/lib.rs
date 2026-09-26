//! Authoritative supervised runtime shared by headless, TUI, ACP, and Node clients.
//!
//! Session durability: with [`RuntimeConfig::with_session_store`] (or
//! [`RuntimeConfig::with_persistence_dir`]) the supervisor writes an atomic
//! [`SessionSnapshot`] through the store at every commit point — the initial
//! insert in `start_turn`, and every `commit_conversation`/`replace_conversation`
//! (Done, Cancelled, Error, source-closed, context compaction). Snapshot reads
//! fall back to `SessionStore::recover` on a cache miss, so sessions survive
//! process restarts. Without a store the runtime stays purely in-memory.

mod bridge;
mod compat;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use agente_core::catalog::ModelCatalog;
use agente_core::config::AppConfig;
use agente_core::mcp::client::McpManager;
use agente_core::permissions::{
    shared_permission_engine_with_config, ApprovalBroker, SharedPermissionEngine,
};
use agente_core::providers::ProviderRegistry;
use agente_core::subagent::SubagentRegistry;
use agente_core::types::{AgentMode, ApprovalAction};
use agente_core::AbortController;
use agente_protocol::{
    ApprovalDecision, ApprovalDecisionKind, ChildSnapshot, Message, RunId, RuntimeEvent,
    RuntimeEventEnvelope, SessionId, SessionSnapshot, StartTurn, TurnId, TurnOutcome, UserInput,
    PROTOCOL_VERSION,
};
use agente_session::{SessionStore, SessionStoreError};
use chrono::Utc;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

const EVENT_CAPACITY: usize = 1_024;

#[derive(Clone)]
pub struct RuntimeConfig {
    pub project_dir: String,
    /// Resolved agent mode. Unknown config strings fail closed to Plan.
    pub mode: AgentMode,
    pub default_provider: String,
    pub default_model: String,
    pub default_thinking_level: String,
    pub max_iterations: u32,
    pub provider_registry: Arc<ProviderRegistry>,
    pub catalog: Option<ModelCatalog>,
    pub permission_engine: SharedPermissionEngine,
    pub approval_broker: ApprovalBroker,
    pub mcp_manager: Option<Arc<tokio::sync::Mutex<McpManager>>>,
    pub subagent_registry: SubagentRegistry,
    /// Per-subagent-type model overrides from the user's config.
    pub subagent_models: agente_core::config::SubagentModels,
    /// LLM-summary compaction instead of trimming (user setting).
    pub smart_compaction: bool,
    /// Subagents allowed to run at once.
    pub max_parallel_subagents: usize,
    /// Optional durable session store. When set, every session commit writes
    /// an atomic snapshot through the store and cache misses recover from it,
    /// so sessions survive process restarts. `None` keeps the runtime purely
    /// in-memory (`from_app_config` leaves it unset — persistence is opt-in).
    pub session_store: Option<SessionStore>,
}

impl RuntimeConfig {
    pub fn from_app_config(app_config: &AppConfig, project_dir: impl Into<String>) -> Self {
        let project_dir = project_dir.into();
        // Fail closed: only an explicit "build" grants write access, mirroring
        // agente-core's parse_mode. Unknown strings run in Plan mode.
        let mode = match app_config.default_mode.as_deref() {
            // `auto` = the TUI's build-with-auto-approve; headless runs build.
            Some(value)
                if value.eq_ignore_ascii_case("build") || value.eq_ignore_ascii_case("auto") =>
            {
                AgentMode::Build
            }
            _ => AgentMode::Plan,
        };
        let default_provider = app_config
            .default_provider
            .clone()
            .unwrap_or_else(|| "deepseek".to_string());
        let default_model = app_config
            .default_model
            .clone()
            .or_else(|| app_config.executor_model.clone())
            .unwrap_or_else(|| "deepseek-flash".to_string());
        Self {
            project_dir: project_dir.clone(),
            mode,
            default_provider,
            default_model,
            default_thinking_level: app_config
                .default_thinking_level
                .clone()
                .unwrap_or_else(|| agente_core::thinking::THINKING_OFF.to_string()),
            max_iterations: app_config.max_iterations(),
            provider_registry: Arc::new(ProviderRegistry::from_config(app_config)),
            catalog: app_config.catalog.clone(),
            permission_engine: shared_permission_engine_with_config(
                mode,
                &app_config.auto_approve,
                &project_dir,
            ),
            approval_broker: ApprovalBroker::new(),
            mcp_manager: None,
            subagent_registry: SubagentRegistry::new(),
            subagent_models: app_config.subagent_models.clone(),
            smart_compaction: app_config.smart_compaction,
            max_parallel_subagents: app_config.parallel_subagents(),
            session_store: None,
        }
    }

    pub fn with_mcp_manager(mut self, manager: Arc<tokio::sync::Mutex<McpManager>>) -> Self {
        self.mcp_manager = Some(manager);
        self
    }

    /// Route session persistence through an existing store. `SessionStore` is
    /// cheap to clone and internally locked — clones share the same per-session
    /// log writers — so no further wrapping is needed.
    pub fn with_session_store(mut self, store: SessionStore) -> Self {
        self.session_store = Some(store);
        self
    }

    /// Enable persistence in `dir`, creating the directory if needed.
    ///
    /// Fallible on purpose: a store whose directory cannot be created is a
    /// configuration error the caller should surface, not silently degrade.
    pub fn with_persistence_dir(self, dir: impl Into<PathBuf>) -> Result<Self, SessionStoreError> {
        let store = SessionStore::open(dir)?;
        Ok(self.with_session_store(store))
    }

    /// Enable persistence under `{project_dir}/.agente/sessions` — the
    /// standard location. Opt-in: [`RuntimeConfig::from_app_config`] never
    /// calls this.
    pub fn with_default_persistence(self) -> Result<Self, SessionStoreError> {
        let dir = Path::new(&self.project_dir)
            .join(".agente")
            .join("sessions");
        self.with_persistence_dir(dir)
    }
}

pub struct RuntimeSupervisor;

impl RuntimeSupervisor {
    pub fn start(config: RuntimeConfig) -> RuntimeHandle {
        if let Some(store) = &config.session_store {
            tracing::info!(
                root = %store.root().display(),
                "session persistence enabled"
            );
        }
        RuntimeHandle {
            inner: Arc::new(RuntimeInner {
                config,
                sessions: RwLock::new(HashMap::new()),
                turns: Mutex::new(HashMap::new()),
                child_ids: Mutex::new(HashMap::new()),
                sequence: AtomicU64::new(0),
                task_sequence: AtomicU64::new(0),
                system_prompt: Mutex::new(None),
            }),
        }
    }
}

#[derive(Clone)]
pub struct RuntimeHandle {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    config: RuntimeConfig,
    sessions: RwLock<HashMap<SessionId, SessionSnapshot>>,
    turns: Mutex<HashMap<TurnId, TurnControl>>,
    child_ids: Mutex<HashMap<String, RunId>>,
    sequence: AtomicU64,
    task_sequence: AtomicU64,
    /// Executor system prompt built once per supervisor (the project dir is
    /// fixed for the runtime's lifetime and MCP tools never appear in this
    /// prompt — the legacy loop registers MCP adapters on its own registry).
    system_prompt: Mutex<Option<String>>,
}

impl RuntimeInner {
    fn lock_turns(&self) -> std::sync::MutexGuard<'_, HashMap<TurnId, TurnControl>> {
        self.turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_sessions(&self) -> std::sync::RwLockReadGuard<'_, HashMap<SessionId, SessionSnapshot>> {
        self.sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_sessions(
        &self,
    ) -> std::sync::RwLockWriteGuard<'_, HashMap<SessionId, SessionSnapshot>> {
        self.sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_children(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunId>> {
        self.child_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Drop child-id mappings whose subagent already reached a terminal state,
    /// keeping the map bounded to live children. Unknown ids are kept.
    fn prune_finished_children(&self) {
        let mut children = self.lock_children();
        children.retain(|legacy_id, _| {
            self.config
                .subagent_registry
                .get(legacy_id)
                .is_none_or(|snapshot| !snapshot.status.is_terminal())
        });
    }

    fn cached_system_prompt(&self) -> String {
        let mut cache = self
            .system_prompt
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(prompt) = cache.as_ref() {
            return prompt.clone();
        }
        let registry = agente_core::tools::ToolRegistry::new(&self.config.project_dir);
        let prompt = agente_core::context::executor_system_prompt_with_tools(
            &self.config.project_dir,
            "",
            &registry.definitions(),
        );
        *cache = Some(prompt.clone());
        prompt
    }

    /// In-memory snapshot for `session_id`, falling back to a durable recovery
    /// through the configured store on a cache miss. Recovered sessions with
    /// durable content are cached back into the in-memory map so subsequent
    /// commits keep the revision counter monotonic across restarts.
    fn lookup_session(&self, session_id: SessionId) -> SessionSnapshot {
        if let Some(snapshot) = self.read_sessions().get(&session_id) {
            return snapshot.clone();
        }
        let Some(store) = self.config.session_store.as_ref() else {
            return empty_snapshot(session_id);
        };
        match store.recover(session_id) {
            Ok(recovered) => {
                let snapshot = recovered.snapshot;
                // Cache only sessions with durable content: a bare miss must
                // keep returning an empty, uncached snapshot (previous
                // behavior for unknown ids).
                if !snapshot.conversation.is_empty() || snapshot.revision > 0 {
                    self.write_sessions().insert(session_id, snapshot.clone());
                }
                snapshot
            }
            Err(error) => {
                tracing::warn!(
                    session = %session_id,
                    %error,
                    "session recovery failed; treating as empty"
                );
                empty_snapshot(session_id)
            }
        }
    }

    /// Write a session snapshot through the configured store. Persistence
    /// failures never propagate: the in-memory session remains authoritative
    /// and the next commit retries. A no-op without a configured store.
    fn persist_snapshot(&self, snapshot: &SessionSnapshot) {
        let Some(store) = self.config.session_store.as_ref() else {
            return;
        };
        // The snapshot's revision doubles as the store sequence: revisions are
        // per-session, monotonic, and survive restarts via recovery, so a newer
        // snapshot can never strand future log events behind a stale sequence.
        if let Err(error) = store.write_snapshot(snapshot, snapshot.revision) {
            tracing::warn!(
                session = %snapshot.session_id,
                revision = snapshot.revision,
                %error,
                "session snapshot persistence failed; continuing from memory"
            );
        }
    }

    fn envelope(
        &self,
        session_id: SessionId,
        turn_id: TurnId,
        parent_run_id: Option<RunId>,
        event: RuntimeEvent,
    ) -> RuntimeEventEnvelope {
        RuntimeEventEnvelope {
            protocol_version: PROTOCOL_VERSION,
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            session_id,
            turn_id,
            parent_run_id,
            timestamp: Utc::now(),
            event,
        }
    }

    fn child_id(&self, legacy_id: &str) -> RunId {
        *self
            .lock_children()
            .entry(legacy_id.to_string())
            .or_default()
    }
}

struct TurnControl {
    cancel: AbortController,
    steering: Vec<UserInput>,
    events: mpsc::Sender<RuntimeEventEnvelope>,
    session_id: SessionId,
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("a Tokio runtime is required to start a turn")]
    MissingExecutor,
    #[error("turn event stream is closed")]
    EventStreamClosed,
    #[error("session {0} already has an active turn")]
    SessionBusy(SessionId),
}

pub struct TurnHandle {
    turn_id: TurnId,
    session_id: SessionId,
    events: mpsc::Receiver<RuntimeEventEnvelope>,
    outcome: Option<oneshot::Receiver<TurnOutcome>>,
}

impl TurnHandle {
    pub fn turn_id(&self) -> TurnId {
        self.turn_id
    }

    pub fn session_id(&self) -> SessionId {
        self.session_id
    }

    pub fn events(&mut self) -> &mut mpsc::Receiver<RuntimeEventEnvelope> {
        &mut self.events
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

impl RuntimeHandle {
    pub fn start_turn(&self, start: StartTurn) -> Result<TurnHandle, RuntimeError> {
        if tokio::runtime::Handle::try_current().is_err() {
            return Err(RuntimeError::MissingExecutor);
        }
        let turn_id = TurnId::new();
        let session_id = start.session_id;
        let (event_tx, event_rx) = mpsc::channel(EVENT_CAPACITY);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let cancel = AbortController::new();

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
                    cancel: cancel.clone(),
                    steering: Vec::new(),
                    events: event_tx.clone(),
                    session_id,
                },
            );
        }

        // Single snapshot read: reuse the existing conversation and revision
        // instead of cloning the whole session twice per start. A cache miss
        // recovers from the durable store first so a resumed session continues
        // its persisted conversation and revision.
        let existing = self.inner.lookup_session(session_id);
        let mut conversation = if start.conversation.is_empty() {
            existing.conversation.clone()
        } else {
            start.conversation
        };
        ensure_system_prompt(&mut conversation, &self.inner.cached_system_prompt());
        // Project instructions (AGENTS.md) as a user-message reminder;
        // idempotent, so it also re-attaches after compaction dropped it.
        if !agente_core::context::conversation_has_reminder(
            conversation.iter().map(|m| m.content.as_str()),
        ) {
            if let Some(reminder) =
                agente_core::context::agents_md_reminder(&self.inner.config.project_dir)
            {
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
                    },
                );
            }
        }
        let revision = existing.revision;
        let snapshot = SessionSnapshot {
            session_id,
            revision,
            conversation: conversation.clone(),
        };
        {
            let mut sessions = self.inner.write_sessions();
            sessions.insert(session_id, snapshot.clone());
            // Persist under the sessions write lock: the initial insert is the
            // first commit point (a crash before the turn ends must not lose
            // the user's input), and holding the lock keeps the durable copy
            // ordered with the in-memory revision.
            self.inner.persist_snapshot(&snapshot);
        }

        let provider = start
            .provider
            .unwrap_or_else(|| self.inner.config.default_provider.clone());
        let model = start
            .model
            .unwrap_or_else(|| self.inner.config.default_model.clone());
        let thinking = start
            .thinking_level
            .unwrap_or_else(|| self.inner.config.default_thinking_level.clone());
        let task_id = self
            .inner
            .task_sequence
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1);
        let (legacy_tx, legacy_rx) = std::sync::mpsc::channel();

        let _legacy_task = agente_core::agent::spawn_chat_task(
            session_id.as_uuid(),
            task_id,
            legacy_tx,
            compat::conversation_to_core(conversation),
            provider,
            model,
            thinking,
            self.inner.config.project_dir.clone(),
            self.inner.config.max_iterations,
            Arc::clone(&self.inner.config.provider_registry),
            self.inner.config.catalog.clone(),
            self.inner.config.permission_engine.clone(),
            cancel.signal(),
            self.inner.config.approval_broker.clone(),
            self.inner.config.mcp_manager.clone(),
            self.inner.config.subagent_registry.clone(),
            self.inner.config.subagent_models.clone(),
            self.inner.config.smart_compaction,
            self.inner.config.max_parallel_subagents,
        );

        let started = self.envelope(session_id, turn_id, None, RuntimeEvent::TurnStarted);
        if event_tx.try_send(started).is_err() {
            // Release the reservation: the caller never receives a handle.
            self.inner.lock_turns().remove(&turn_id);
            return Err(RuntimeError::EventStreamClosed);
        }

        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            bridge::forward_legacy_events(
                inner, session_id, turn_id, legacy_rx, event_tx, outcome_tx,
            );
        });

        Ok(TurnHandle {
            turn_id,
            session_id,
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

    /// Queue steering input into the authoritative session and stop the current
    /// turn at its next cancellation point. The client starts the follow-up turn.
    pub fn steer(&self, turn_id: TurnId, input: UserInput) -> bool {
        let mut turns = self.inner.lock_turns();
        let Some(control) = turns.get_mut(&turn_id) else {
            return false;
        };
        control.steering.push(input);
        let envelope = self.envelope(
            control.session_id,
            turn_id,
            None,
            RuntimeEvent::SteeringQueued,
        );
        if let Err(error) = control.events.try_send(envelope) {
            tracing::debug!(%error, "steering notification dropped: event stream closed or full");
        }
        control.cancel.abort();
        true
    }

    pub fn session_snapshot(&self, session_id: SessionId) -> SessionSnapshot {
        self.inner.lookup_session(session_id)
    }

    pub fn fork_session(&self, source: SessionId) -> SessionSnapshot {
        let source = self.session_snapshot(source);
        let session_id = SessionId::new();
        let snapshot = SessionSnapshot {
            session_id,
            revision: 0,
            conversation: source.conversation,
        };
        self.inner
            .write_sessions()
            .insert(session_id, snapshot.clone());
        snapshot
    }

    pub fn child_snapshot(&self, run_id: RunId) -> Option<ChildSnapshot> {
        let legacy_id = self
            .inner
            .lock_children()
            .iter()
            .find_map(|(legacy, mapped)| (*mapped == run_id).then(|| legacy.clone()))?;
        let snapshot = self.inner.config.subagent_registry.get(&legacy_id)?;
        Some(ChildSnapshot {
            run_id,
            status: format!("{:?}", snapshot.status).to_lowercase(),
            summary: snapshot.summary,
        })
    }

    pub fn approval_broker(&self) -> ApprovalBroker {
        self.inner.config.approval_broker.clone()
    }

    fn envelope(
        &self,
        session_id: SessionId,
        turn_id: TurnId,
        parent_run_id: Option<RunId>,
        event: RuntimeEvent,
    ) -> RuntimeEventEnvelope {
        self.inner
            .envelope(session_id, turn_id, parent_run_id, event)
    }
}

fn empty_snapshot(session_id: SessionId) -> SessionSnapshot {
    SessionSnapshot {
        session_id,
        revision: 0,
        conversation: Vec::new(),
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
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::agent::{AgentEvent, AgentTaskEvent};
    use agente_core::subagent::{SubagentSnapshot, SubagentStatus};
    use agente_protocol::{Role, TurnStatus};

    fn test_config() -> RuntimeConfig {
        RuntimeConfig::from_app_config(&AppConfig::default(), "D:/proj")
    }

    #[test]
    fn headless_turn_uses_the_selected_provider_model() {
        let config = AppConfig {
            default_provider: Some("openrouter".into()),
            default_model: Some("stealth/space-bunny-alpha".into()),
            executor_model: Some("openai/gpt-4o-mini".into()),
            ..AppConfig::default()
        };
        let runtime = RuntimeConfig::from_app_config(&config, "D:/proj");
        assert_eq!(runtime.default_provider, "openrouter");
        assert_eq!(runtime.default_model, "stealth/space-bunny-alpha");
    }

    #[test]
    fn mode_parsing_fails_closed_to_plan() {
        let mut config = AppConfig {
            default_mode: Some("build".into()),
            ..AppConfig::default()
        };

        assert_eq!(
            RuntimeConfig::from_app_config(&config, "p").mode,
            AgentMode::Build
        );
        config.default_mode = Some("BUILD".into());
        assert_eq!(
            RuntimeConfig::from_app_config(&config, "p").mode,
            AgentMode::Build
        );

        for unknown in [Some("plan".to_string()), Some("garbage".to_string()), None] {
            config.default_mode = unknown.clone();
            assert_eq!(
                RuntimeConfig::from_app_config(&config, "p").mode,
                AgentMode::Plan,
                "unexpected mode for {unknown:?}"
            );
        }
    }

    #[test]
    fn system_prompt_is_cached_across_calls() {
        let handle = RuntimeSupervisor::start(test_config());
        let first = handle.inner.cached_system_prompt();
        let second = handle.inner.cached_system_prompt();
        assert_eq!(first, second);
        assert!(first.contains("tool"), "prompt should list tools");
    }

    #[test]
    fn prune_finished_children_drops_only_terminal_entries() {
        let handle = RuntimeSupervisor::start(test_config());
        let inner = &handle.inner;

        inner.child_id("child-running");
        inner.child_id("child-done");
        inner.child_id("child-unknown");
        let snapshot = |id: &str| SubagentSnapshot {
            id: id.into(),
            subagent_type: "explore".into(),
            description: String::new(),
            prompt: String::new(),
            status: SubagentStatus::Running,
            summary: None,
            conversation: Vec::new(),
            model: String::new(),
            depth: 0,
            background: false,
            started_at: Utc::now(),
            finished_at: None,
            cwd: None,
            worktree: None,
        };
        inner
            .config
            .subagent_registry
            .insert(snapshot("child-running"));
        inner
            .config
            .subagent_registry
            .insert(snapshot("child-done"));
        inner.config.subagent_registry.finish(
            "child-done",
            SubagentStatus::Completed,
            String::new(),
            Vec::new(),
        );

        inner.prune_finished_children();

        let children = inner.lock_children();
        assert!(children.contains_key("child-running"));
        assert!(children.contains_key("child-unknown"));
        assert!(!children.contains_key("child-done"));
    }

    // ------------------------------------------------------------------
    // Durable session persistence
    // ------------------------------------------------------------------

    fn temp_store_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("agente-runtime-{tag}-{}", SessionId::new()))
    }

    fn persistent_config(tag: &str) -> (RuntimeConfig, PathBuf) {
        let root = temp_store_dir(tag);
        let config = test_config()
            .with_persistence_dir(root.clone())
            .expect("store opens in a fresh tempdir");
        (config, root)
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
        }
    }

    fn contents_of(conversation: &[Message]) -> Vec<&str> {
        conversation
            .iter()
            .map(|message| message.content.as_str())
            .collect()
    }

    /// Drive one fake turn to `Done` through the bridge forwarder (the same
    /// pattern the bridge tests use) and return the turn outcome.
    async fn drive_done_turn(
        inner: &Arc<RuntimeInner>,
        session_id: SessionId,
        answer: &str,
        tokens: u32,
        steering: &[&str],
    ) -> TurnOutcome {
        let turn_id = TurnId::new();
        let (event_tx, mut event_rx) = mpsc::channel(EVENT_CAPACITY);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        inner.lock_turns().insert(
            turn_id,
            TurnControl {
                cancel: AbortController::new(),
                steering: steering
                    .iter()
                    .map(|text| UserInput {
                        content: (*text).to_string(),
                    })
                    .collect(),
                events: event_tx.clone(),
                session_id,
            },
        );

        let (legacy_tx, legacy_rx) = std::sync::mpsc::channel();
        legacy_tx
            .send(AgentTaskEvent {
                task_id: 1,
                event: AgentEvent::Done {
                    conversation: vec![core_assistant_message(answer)],
                    tokens,
                },
            })
            .unwrap();
        drop(legacy_tx);

        let inner_for_bridge = Arc::clone(inner);
        tokio::task::spawn_blocking(move || {
            crate::bridge::forward_legacy_events(
                inner_for_bridge,
                session_id,
                turn_id,
                legacy_rx,
                event_tx,
                outcome_tx,
            );
        });

        let outcome = outcome_rx.await.unwrap();
        // Drain the event channel so the forwarder's sends never block.
        while event_rx.recv().await.is_some() {}
        outcome
    }

    #[tokio::test]
    async fn done_turn_persists_session_for_recovery() {
        let (config, root) = persistent_config("done-persist");
        let handle = RuntimeSupervisor::start(config);
        let session_id = SessionId::new();

        let outcome = drive_done_turn(
            &handle.inner,
            session_id,
            "answer",
            42,
            &["queued steering"],
        )
        .await;
        assert_eq!(outcome.status, TurnStatus::Completed);
        assert_eq!(outcome.tokens, 42);
        assert_eq!(outcome.revision, 1);

        // A fresh store instance over the same directory (i.e. another
        // process) lists the session and recovers the committed conversation.
        let store = SessionStore::open(&root).unwrap();
        assert!(store.list_sessions().unwrap().contains(&session_id));
        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.revision, 1);
        assert_eq!(
            contents_of(&recovered.snapshot.conversation),
            vec!["answer", "queued steering"]
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn second_supervisor_recovers_session_and_continues_revisions() {
        let (config, root) = persistent_config("second-supervisor");
        let session_id = SessionId::new();
        {
            let first = RuntimeSupervisor::start(config);
            let outcome =
                drive_done_turn(&first.inner, session_id, "answer", 7, &["queued steering"]).await;
            assert_eq!(outcome.revision, 1);
        } // The first supervisor (and its in-memory sessions) is gone.

        let second = RuntimeSupervisor::start(
            test_config()
                .with_persistence_dir(root.clone())
                .expect("store reopens"),
        );

        // session/load across the restart: recovered from the store, with the
        // revision seeded from the durable snapshot.
        let snapshot = second.session_snapshot(session_id);
        assert_eq!(snapshot.revision, 1);
        assert_eq!(
            contents_of(&snapshot.conversation),
            vec!["answer", "queued steering"]
        );

        // fork_session recovers too; the fork itself starts at revision 0.
        let fork = second.fork_session(session_id);
        assert_ne!(fork.session_id, session_id);
        assert_eq!(fork.revision, 0);
        assert_eq!(fork.conversation.len(), 2);

        // Revision continuity: the next commit on the recovered session
        // increments past the recovered revision instead of restarting at 1.
        let outcome = drive_done_turn(&second.inner, session_id, "second answer", 3, &[]).await;
        assert_eq!(outcome.revision, 2);

        let store = SessionStore::open(&root).unwrap();
        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.revision, 2);
        assert_eq!(
            contents_of(&recovered.snapshot.conversation),
            vec!["second answer"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn persistence_failure_does_not_break_turns() {
        let (config, root) = persistent_config("unwritable");
        let handle = RuntimeSupervisor::start(config);
        // The store directory vanishes after startup (e.g. the user deleted
        // `.agente` mid-run): every snapshot write now fails.
        std::fs::remove_dir_all(&root).unwrap();

        let session_id = SessionId::new();
        let outcome = drive_done_turn(&handle.inner, session_id, "answer", 9, &[]).await;
        assert_eq!(
            outcome.status,
            TurnStatus::Completed,
            "a persistence failure must not fail the turn"
        );
        assert_eq!(outcome.revision, 1);

        // The authoritative in-memory session is intact.
        let snapshot = handle.session_snapshot(session_id);
        assert_eq!(snapshot.revision, 1);
        assert_eq!(contents_of(&snapshot.conversation), vec!["answer"]);

        // A supervisor reopened over the missing directory recovers nothing
        // and degrades to an empty session instead of erroring.
        let reopened = RuntimeSupervisor::start(
            test_config()
                .with_persistence_dir(root.clone())
                .expect("store reopens"),
        );
        let missing = reopened.session_snapshot(session_id);
        assert_eq!(missing.revision, 0);
        assert!(missing.conversation.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn start_turn_recovers_session_and_persists_initial_snapshot() {
        let (config, root) = persistent_config("start-turn");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        // Seed the store the way a previous process would have left it.
        store
            .write_snapshot(
                &SessionSnapshot {
                    session_id,
                    revision: 3,
                    conversation: vec![Message::user("resumed question")],
                },
                3,
            )
            .unwrap();

        let handle = RuntimeSupervisor::start(config);
        let start = StartTurn {
            session_id,
            conversation: Vec::new(),
            // Unknown providers fail fast in the agent loop before any network
            // access, keeping this test offline and deterministic.
            provider: Some("definitely-not-a-provider".to_string()),
            model: None,
            thinking_level: None,
        };
        let mut turn = handle.start_turn(start).expect("turn starts");

        // The initial insert is a commit point: the recovered conversation
        // (plus the runtime system prompt) is durable before any event fires.
        // No await point has run yet, so the background turn cannot have
        // committed its error and raced this read.
        let persisted = store.recover(session_id).unwrap();
        assert_eq!(persisted.snapshot.revision, 3);
        assert_eq!(persisted.snapshot.conversation.len(), 2);
        assert_eq!(persisted.snapshot.conversation[0].role, Role::System);
        assert_eq!(
            persisted.snapshot.conversation[1].content,
            "resumed question"
        );

        // The turn fails fast but still commits, continuing the recovered
        // revision.
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(30), turn.outcome())
            .await
            .expect("turn finishes")
            .expect("outcome delivered");
        assert_eq!(outcome.status, TurnStatus::Failed);
        assert_eq!(outcome.revision, 4, "revision continues after recovery");

        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.revision, 4);
        assert_eq!(recovered.snapshot.conversation.len(), 2);
        // The in-memory snapshot matches the durable copy.
        assert_eq!(handle.session_snapshot(session_id).revision, 4);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Two overlapping turns on one session would each commit a full
    /// conversation; the second start is rejected until the first settles.
    #[tokio::test]
    async fn start_turn_rejects_a_second_active_turn_for_the_same_session() {
        let handle = RuntimeSupervisor::start(test_config());
        let session_id = SessionId::new();
        let start = |session_id| StartTurn {
            session_id,
            conversation: Vec::new(),
            // Unknown provider fails fast before any network access.
            provider: Some("definitely-not-a-provider".to_string()),
            model: None,
            thinking_level: None,
        };

        let mut first = handle
            .start_turn(start(session_id))
            .expect("first turn starts");
        match handle.start_turn(start(session_id)) {
            Err(RuntimeError::SessionBusy(busy)) => assert_eq!(busy, session_id),
            other => panic!(
                "expected SessionBusy, got {:?}",
                other.map(|_| ()).map_err(|e| e.to_string())
            ),
        }

        // A different session is unaffected.
        let other_session = SessionId::new();
        let _other = handle
            .start_turn(start(other_session))
            .expect("another session can run concurrently");

        let _ = first.outcome().await;
        // The reservation is released when the turn settles.
        let _resumed = handle
            .start_turn(start(session_id))
            .expect("session starts a new turn after the first finishes");
    }
}
