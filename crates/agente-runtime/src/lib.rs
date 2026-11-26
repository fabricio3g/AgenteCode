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
mod config;
mod edits;
pub mod import;
mod sessions;
mod turns;

#[cfg(test)]
mod tests;

pub use agente_drivers::{
    AgentDriver, ApprovalRouter, DriverError, DriverRegistry, DriverSession, DriversConfig,
    InjectedMcpServer,
};
pub use config::{
    OrchestratorContext, OrchestratorProvider, ProfileSource, ProfileTurn, RuntimeConfig,
};
pub use turns::TurnHandle;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use agente_core::mcp::client::McpManager;
use agente_protocol::{
    RunId, RuntimeEvent, RuntimeEventEnvelope, SessionId, SessionSnapshot, TurnId, PROTOCOL_VERSION,
};
use chrono::Utc;
use thiserror::Error;
use tokio::sync::broadcast;

use config::LiveSettings;
pub(crate) use sessions::chat_message_count;
use sessions::SessionContext;
#[cfg(test)]
use turns::effective_mode;
pub(crate) use turns::{TurnControl, TurnGuard};

pub(crate) const EVENT_CAPACITY: usize = 1_024;
/// Events kept for subscribers that fall behind before they see `Lagged`.
const BROADCAST_CAPACITY: usize = 4_096;

pub struct RuntimeSupervisor;

impl RuntimeSupervisor {
    pub fn start(config: RuntimeConfig) -> RuntimeHandle {
        if let Some(store) = &config.session_store {
            tracing::info!(
                root = %store.root().display(),
                "session persistence enabled"
            );
        }
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        let live = LiveSettings::from_config(&config);
        let driver_registry = config
            .driver_registry
            .clone()
            .unwrap_or_else(|| Arc::new(DriverRegistry::load_default()));
        RuntimeHandle {
            inner: Arc::new(RuntimeInner {
                config,
                sessions: RwLock::new(HashMap::new()),
                commit_locks: Mutex::new(HashMap::new()),
                contexts: Mutex::new(HashMap::new()),
                project_mcps: Mutex::new(HashMap::new()),
                turns: Mutex::new(HashMap::new()),
                driver_sessions: Mutex::new(HashMap::new()),
                bound_instances: Mutex::new(HashMap::new()),
                session_depths: Mutex::new(HashMap::new()),
                driver_registry,
                approval_router: ApprovalRouter::new(),
                child_ids: Mutex::new(HashMap::new()),
                sequence: AtomicU64::new(0),
                task_sequence: AtomicU64::new(0),
                system_prompts: Mutex::new(HashMap::new()),
                context_gaps: Mutex::new(HashMap::new()),
                events,
                edits: Mutex::new(edits::EditLog::default()),
                live: RwLock::new(Arc::new(live)),
            }),
        }
    }
}

#[derive(Clone)]
pub(crate) struct BoundDriverSession {
    pub(crate) instance_id: String,
    pub(crate) session: Arc<dyn DriverSession>,
}

#[derive(Clone)]
pub struct RuntimeHandle {
    pub(crate) inner: Arc<RuntimeInner>,
}

pub(crate) struct RuntimeInner {
    pub(crate) config: RuntimeConfig,
    pub(crate) sessions: RwLock<HashMap<SessionId, SessionSnapshot>>,
    /// Order commits within a session without holding the global map across disk I/O.
    pub(crate) commit_locks: Mutex<HashMap<SessionId, Arc<Mutex<()>>>>,
    /// Per-session project folder and permissions (mode, approve-all grants).
    pub(crate) contexts: Mutex<HashMap<SessionId, SessionContext>>,
    pub(crate) project_mcps: Mutex<HashMap<String, Arc<McpManager>>>,
    pub(crate) turns: Mutex<HashMap<TurnId, TurnControl>>,
    pub(crate) driver_sessions: Mutex<HashMap<SessionId, BoundDriverSession>>,
    pub(crate) bound_instances: Mutex<HashMap<SessionId, String>>,
    pub(crate) session_depths: Mutex<HashMap<SessionId, u32>>,
    pub(crate) driver_registry: Arc<DriverRegistry>,
    pub(crate) approval_router: ApprovalRouter,
    pub(crate) child_ids: Mutex<HashMap<String, RunId>>,
    pub(crate) sequence: AtomicU64,
    pub(crate) task_sequence: AtomicU64,
    /// Executor system prompt per project folder, built once each (MCP tools
    /// never appear in it — the legacy loop registers MCP adapters on its
    /// own registry).
    pub(crate) system_prompts: Mutex<HashMap<String, String>>,
    /// What each session's provider counted beyond our estimate last time.
    /// Carried into the next turn so its first request is gated on a
    /// calibrated number instead of a blind char/4 estimate.
    pub(crate) context_gaps: Mutex<HashMap<SessionId, usize>>,
    /// Every event of every turn, for clients that attach to the runtime
    /// rather than to one turn (a daemon, a second window).
    pub(crate) events: broadcast::Sender<RuntimeEventEnvelope>,
    /// Undo/redo of each session's file edits.
    pub(crate) edits: Mutex<edits::EditLog>,
    pub(crate) live: RwLock<Arc<LiveSettings>>,
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("a Tokio runtime is required to start a turn")]
    MissingExecutor,
    #[error("turn event stream is closed")]
    EventStreamClosed,
    #[error("session {0} already has an active turn")]
    SessionBusy(SessionId),
    #[error("session store: {0}")]
    Store(String),
    #[error("{0}")]
    Edits(String),
    #[error("{0}")]
    NotAllowed(String),
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error("{0}")]
    Driver(#[from] DriverError),
}

impl RuntimeInner {
    pub(crate) fn lock_turns(&self) -> std::sync::MutexGuard<'_, HashMap<TurnId, TurnControl>> {
        self.turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn lock_driver_sessions(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<SessionId, BoundDriverSession>> {
        self.driver_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn close_bound_driver_session(&self, session_id: SessionId) {
        let removed = self.lock_driver_sessions().remove(&session_id);
        if let Some(bound) = removed {
            if let Ok(executor) = tokio::runtime::Handle::try_current() {
                executor.spawn(async move {
                    bound.session.close().await;
                });
            }
        }
    }

    pub(crate) fn read_sessions(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, HashMap<SessionId, SessionSnapshot>> {
        self.sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn write_sessions(
        &self,
    ) -> std::sync::RwLockWriteGuard<'_, HashMap<SessionId, SessionSnapshot>> {
        self.sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn lock_children(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunId>> {
        self.child_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Drop child-id mappings whose subagent already reached a terminal state,
    /// keeping the map bounded to live children. Unknown ids are kept.
    pub(crate) fn prune_finished_children(&self) {
        let mut children = self.lock_children();
        children.retain(|legacy_id, _| {
            self.config
                .subagent_registry
                .get(legacy_id)
                .is_none_or(|snapshot| !snapshot.status.is_terminal())
        });
    }

    pub(crate) fn cached_system_prompt(&self, project_dir: &str) -> String {
        let mut cache = self
            .system_prompts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(prompt) = cache.get(project_dir) {
            return prompt.clone();
        }
        let registry = agente_core::tools::ToolRegistry::new(project_dir);
        let prompt = agente_core::context::executor_system_prompt_with_tools(
            project_dir,
            "",
            &registry.definitions(),
        );
        cache.insert(project_dir.to_string(), prompt.clone());
        prompt
    }

    pub(crate) fn project_mcp(&self, project_dir: &str) -> Arc<McpManager> {
        let live = self.live();
        let mut projects = self
            .project_mcps
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(manager) = projects.get(project_dir) {
            return Arc::clone(manager);
        }
        let base = live
            .mcp_manager
            .clone()
            .unwrap_or_else(|| Arc::new(McpManager::from_sources(&live.app_config.mcp, "", &[])));
        let manager =
            Arc::new(base.for_project(project_dir, &live.app_config.approved_mcp_servers));
        projects.insert(project_dir.to_string(), Arc::clone(&manager));
        if let Ok(executor) = tokio::runtime::Handle::try_current() {
            let connecting = Arc::clone(&manager);
            executor.spawn(async move {
                connecting.connect_project().await;
            });
        }
        manager
    }

    pub(crate) fn live(&self) -> Arc<LiveSettings> {
        self.live
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The tokenizer gap the previous turn measured for this session.
    pub(crate) fn context_gap(&self, session_id: SessionId) -> usize {
        self.context_gaps
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&session_id)
            .copied()
            .unwrap_or(0)
    }

    /// Remember what the provider counted beyond our estimate, per session.
    pub(crate) fn remember_context_gap(&self, session_id: SessionId, gap: usize) {
        self.context_gaps
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session_id, gap);
    }

    pub(crate) fn lock_edits(&self) -> std::sync::MutexGuard<'_, edits::EditLog> {
        self.edits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Send to runtime-wide subscribers. No subscribers is not an error.
    pub(crate) fn publish(&self, envelope: &RuntimeEventEnvelope) {
        let _ = self.events.send(envelope.clone());
    }

    pub(crate) fn envelope(
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

    /// A child's run id: its subagent id when that is a UUID (it always is
    /// for spawned children), so a client can match `task_output` /
    /// `kill_task` calls, which name the subagent id, to the child's card.
    pub(crate) fn child_id(&self, legacy_id: &str) -> RunId {
        *self
            .lock_children()
            .entry(legacy_id.to_string())
            .or_insert_with(|| legacy_id.parse().unwrap_or_default())
    }
}

impl RuntimeHandle {
    pub(crate) fn envelope(
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
