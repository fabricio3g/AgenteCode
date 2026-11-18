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
mod edits;
pub mod import;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use agente_core::agent::UserInbox;
use agente_core::catalog::ModelCatalog;
use agente_core::config::{AppConfig, AutoApproveConfig};
use agente_core::mcp::client::McpManager;
use agente_core::permissions::{
    shared_permission_engine_with_config, ApprovalBroker, SharedPermissionEngine,
};
use agente_core::providers::ProviderRegistry;
use agente_core::subagent::SubagentRegistry;
use agente_core::types::{AgentMode, ApprovalAction};
use agente_core::AbortController;
use agente_protocol::{
    ApprovalDecision, ApprovalDecisionKind, Message, Origin, Role, RunId, RuntimeEvent,
    RuntimeEventEnvelope, SessionId, SessionInfo, SessionSnapshot, StartTurn, Trust, TurnId,
    TurnMode, TurnOutcome, TurnStatus, UserInput, PROTOCOL_VERSION,
};
use agente_session::{SessionMeta, SessionStore, SessionStoreError};
use chrono::Utc;
use thiserror::Error;
use tokio::sync::{broadcast, mpsc, oneshot};

const EVENT_CAPACITY: usize = 1_024;
/// Events kept for subscribers that fall behind before they see `Lagged`.
const BROADCAST_CAPACITY: usize = 4_096;

/// Where a turn's `profile` gets its persona. The daemon backs this with the
/// bot store; without one, a profile is only recorded on the session.
pub trait ProfileSource: Send + Sync {
    /// Who `profile` is (see `agente_core::context::bot_system_prompt`), or
    /// `None` when there is no such profile.
    fn persona(&self, profile: &str) -> Option<String>;

    /// Tools only this profile's turns get (a bot's memory and handoffs).
    fn tools(&self, _profile: &str, _turn: &ProfileTurn) -> Vec<Box<dyn agente_core::tools::Tool>> {
        Vec::new()
    }

    /// The built-in tools this profile may use (a bot's toolsets), `"mcp"`
    /// for MCP tools; `None` for every tool. Its own `tools` are always kept.
    fn tool_names(&self, _profile: &str) -> Option<Vec<String>> {
        None
    }

    /// The box this profile's commands run in, when this machine has one
    /// (see `agente_core::sandbox`); without one they run with a clean
    /// environment instead.
    fn sandbox(&self, _profile: &str) -> agente_core::sandbox::SandboxPolicy {
        agente_core::sandbox::SandboxPolicy::default()
    }
}

/// The turn a profile's tools are made for.
#[derive(Debug, Clone)]
pub struct ProfileTurn {
    /// Who started it (a handoff from another bot says so here).
    pub origin: Origin,
    pub provider: String,
    pub model: String,
    pub thinking_level: String,
}

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
    /// Auto-approve rules, for the engines of sessions in other projects.
    pub auto_approve: AutoApproveConfig,
    pub approval_broker: ApprovalBroker,
    pub subagent_registry: SubagentRegistry,
    /// Per-subagent-type model overrides from the user's config.
    pub subagent_models: agente_core::config::SubagentModels,
    /// LLM-summary compaction instead of trimming (user setting).
    pub smart_compaction: bool,
    pub compaction_model: Option<agente_core::config::SubagentModel>,
    /// Subagents allowed to run at once.
    pub max_parallel_subagents: usize,
    /// Optional durable session store. When set, every session commit writes
    /// an atomic snapshot through the store and cache misses recover from it,
    /// so sessions survive process restarts. `None` keeps the runtime purely
    /// in-memory (`from_app_config` leaves it unset — persistence is opt-in).
    pub session_store: Option<SessionStore>,
    /// The config the settings above came from; `configure` updates a copy
    /// of it and rebuilds them.
    pub app_config: AppConfig,
    /// Personas for turns that name a profile (a bot).
    pub profile_source: Option<Arc<dyn ProfileSource>>,
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
                .unwrap_or_else(|| agente_core::thinking::THINKING_AUTO.to_string()),
            max_iterations: app_config.max_iterations(),
            provider_registry: Arc::new(ProviderRegistry::from_config(app_config)),
            catalog: app_config.catalog.clone(),
            auto_approve: app_config.auto_approve.clone(),
            approval_broker: ApprovalBroker::new(),
            subagent_registry: SubagentRegistry::new(),
            subagent_models: app_config.subagent_models.clone(),
            smart_compaction: app_config.smart_compaction,
            compaction_model: app_config.compaction_model.clone(),
            max_parallel_subagents: app_config.parallel_subagents(),
            session_store: None,
            app_config: app_config.clone(),
            profile_source: None,
        }
    }

    pub fn with_profile_source(mut self, source: Arc<dyn ProfileSource>) -> Self {
        self.profile_source = Some(source);
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

    /// Persist in the user-wide store (`~/.agente/store`, or under
    /// `AGENTE_CONFIG_DIR`): one place for every project, client and bot.
    pub fn with_user_store(self) -> Result<Self, SessionStoreError> {
        let root = AppConfig::config_dir()
            .unwrap_or_else(|| PathBuf::from(".agente"))
            .join("store");
        self.with_persistence_dir(root)
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
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        let live = LiveSettings::from_config(&config);
        RuntimeHandle {
            inner: Arc::new(RuntimeInner {
                config,
                sessions: RwLock::new(HashMap::new()),
                commit_locks: Mutex::new(HashMap::new()),
                contexts: Mutex::new(HashMap::new()),
                project_mcps: Mutex::new(HashMap::new()),
                turns: Mutex::new(HashMap::new()),
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
pub struct RuntimeHandle {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    config: RuntimeConfig,
    sessions: RwLock<HashMap<SessionId, SessionSnapshot>>,
    /// Order commits within a session without holding the global map across disk I/O.
    commit_locks: Mutex<HashMap<SessionId, Arc<Mutex<()>>>>,
    /// Per-session project folder and permissions (mode, approve-all grants).
    contexts: Mutex<HashMap<SessionId, SessionContext>>,
    project_mcps: Mutex<HashMap<String, Arc<McpManager>>>,
    turns: Mutex<HashMap<TurnId, TurnControl>>,
    child_ids: Mutex<HashMap<String, RunId>>,
    sequence: AtomicU64,
    task_sequence: AtomicU64,
    /// Executor system prompt per project folder, built once each (MCP tools
    /// never appear in it — the legacy loop registers MCP adapters on its
    /// own registry).
    system_prompts: Mutex<HashMap<String, String>>,
    /// What each session's provider counted beyond our estimate last time.
    /// Carried into the next turn so its first request is gated on a
    /// calibrated number instead of a blind char/4 estimate.
    context_gaps: Mutex<HashMap<SessionId, usize>>,
    /// Every event of every turn, for clients that attach to the runtime
    /// rather than to one turn (a daemon, a second window).
    events: broadcast::Sender<RuntimeEventEnvelope>,
    /// Undo/redo of each session's file edits.
    edits: Mutex<edits::EditLog>,
    live: RwLock<Arc<LiveSettings>>,
}

/// Settings a client can change while the runtime runs (`configure`):
/// providers and their keys, defaults, and loop limits. Each turn reads an immutable
/// shared snapshot when it starts; running turns keep theirs.
#[derive(Clone)]
struct LiveSettings {
    app_config: AppConfig,
    /// Providers that arrived through `configure`: registered even when the
    /// curated allowlist does not name them.
    client_providers: std::collections::BTreeSet<String>,
    provider_registry: Arc<ProviderRegistry>,
    catalog: Option<Arc<ModelCatalog>>,
    default_provider: String,
    default_model: String,
    default_thinking_level: String,
    max_iterations: u32,
    smart_compaction: bool,
    compaction_model: Option<agente_core::config::SubagentModel>,
    max_parallel_subagents: usize,
    subagent_models: agente_core::config::SubagentModels,
    /// MCP servers from the config (`mcp`), including tools a client serves
    /// itself (Agente Desktop's browser tools). `None`: the runtime's own.
    mcp_manager: Option<Arc<McpManager>>,
}

impl LiveSettings {
    fn from_config(config: &RuntimeConfig) -> Self {
        Self {
            app_config: config.app_config.clone(),
            client_providers: Default::default(),
            provider_registry: Arc::clone(&config.provider_registry),
            catalog: config.catalog.clone().map(Arc::new),
            default_provider: config.default_provider.clone(),
            default_model: config.default_model.clone(),
            default_thinking_level: config.default_thinking_level.clone(),
            max_iterations: config.max_iterations,
            smart_compaction: config.smart_compaction,
            compaction_model: config.compaction_model.clone(),
            max_parallel_subagents: config.max_parallel_subagents,
            subagent_models: config.subagent_models.clone(),
            mcp_manager: None,
        }
    }

    /// Rebuild everything from an updated app config, keeping what the
    /// config cannot carry (keys loaded from auth.json, the model catalog).
    fn from_app_config(
        mut app_config: AppConfig,
        client_providers: std::collections::BTreeSet<String>,
        previous: &LiveSettings,
    ) -> Self {
        app_config.auth_store = previous.app_config.auth_store.clone();
        app_config.catalog = previous.app_config.catalog.clone();
        let rebuilt = RuntimeConfig::from_app_config(&app_config, "");
        for id in &client_providers {
            if let Some(provider) = app_config.provider.get(id) {
                rebuilt
                    .provider_registry
                    .register_client_provider(id, provider, &app_config);
            }
        }
        // Live model lists outlive a reconfigure; the next discovery replaces them.
        for (provider, models) in previous.provider_registry.runtime_snapshot() {
            if rebuilt.provider_registry.get(&provider).is_some() {
                rebuilt
                    .provider_registry
                    .replace_runtime_models(&provider, models);
            }
        }
        Self {
            provider_registry: Arc::clone(&rebuilt.provider_registry),
            catalog: previous.catalog.clone(),
            default_provider: rebuilt.default_provider,
            default_model: rebuilt.default_model,
            default_thinking_level: rebuilt.default_thinking_level,
            max_iterations: rebuilt.max_iterations,
            smart_compaction: rebuilt.smart_compaction,
            compaction_model: rebuilt.compaction_model,
            max_parallel_subagents: rebuilt.max_parallel_subagents,
            subagent_models: rebuilt.subagent_models,
            mcp_manager: previous.mcp_manager.clone(),
            app_config,
            client_providers,
        }
    }
}

/// Settings calls accept only the providers Agente offers itself.
fn known_provider(id: &str) -> Result<(), RuntimeError> {
    if agente_core::providers::spec::offered(id) {
        Ok(())
    } else {
        Err(RuntimeError::Config(format!("unknown provider `{id}`")))
    }
}

/// Save a fresh live list where the TUI's picker reads it, so a model a
/// provider retires leaves both surfaces whichever one refreshed.
fn remember_listing(provider: &str, models: &[agente_core::providers::ModelInfo]) {
    let Some(spec) = agente_core::providers::spec::get(provider) else {
        return;
    };
    if !spec.offered || !agente_core::models::live_membership(&spec.id) {
        return;
    }
    let ids: Vec<String> = models.iter().map(|model| model.id.clone()).collect();
    if let Err(error) = AppConfig::edit_global(|config| {
        config.discovered_models.insert(spec.id.clone(), ids);
    }) {
        tracing::warn!(provider = %spec.id, %error, "Could not save the model list");
    }
}

#[derive(Clone)]
struct SessionContext {
    project_dir: String,
    engine: SharedPermissionEngine,
}

fn new_info(session_id: SessionId, project_dir: &str) -> SessionInfo {
    let now = Utc::now();
    SessionInfo {
        session_id,
        title: String::new(),
        first_prompt: String::new(),
        project_dir: project_dir.to_string(),
        created_at: now,
        last_active: now,
        message_count: 0,
        provider: String::new(),
        model: String::new(),
        thinking_level: String::new(),
        profile: None,
    }
}

/// The first thing the user asked, flattened and trimmed to a list label.
/// Injected reminders (project instructions) are not the user's words.
fn first_prompt(conversation: &[Message]) -> String {
    const MAX_CHARS: usize = 60;
    let Some(message) = conversation.iter().find(|m| {
        m.role == Role::User
            && !m.content.trim().is_empty()
            && !m
                .content
                .contains(agente_core::context::PROJECT_REMINDER_MARKER)
    }) else {
        return String::new();
    };
    let flat = message
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.chars().count() <= MAX_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(MAX_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// User and assistant messages: what a person would count as the chat.
fn chat_message_count(conversation: &[Message]) -> usize {
    conversation
        .iter()
        .filter(|m| matches!(m.role, Role::User | Role::Assistant))
        .count()
}

/// The mode a turn may use: what it asked for (or the session's default),
/// capped by trust. Anyone but the owner is read-only. The flag says whether
/// every call is approved without asking (`auto`); `None` keeps the session's
/// current setting.
fn effective_mode(
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

    fn cached_system_prompt(&self, project_dir: &str) -> String {
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

    fn project_mcp(&self, project_dir: &str) -> Arc<McpManager> {
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

    /// The session's project and permission engine, set up on first use.
    /// The runtime's own project keeps the shared engine; another project
    /// gets its own, so its approvals and mode never leak across projects.
    fn session_context(&self, session_id: SessionId, project_dir: Option<&str>) -> SessionContext {
        let mut contexts = self
            .contexts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved_project = self
            .config
            .session_store
            .as_ref()
            .and_then(|store| store.read_meta(session_id).ok().flatten())
            .map(|meta| meta.info.project_dir);
        let wanted = project_dir
            .or(saved_project.as_deref())
            .unwrap_or(&self.config.project_dir);
        if let Some(context) = contexts.get(&session_id) {
            if project_dir.is_none() || context.project_dir == wanted {
                return context.clone();
            }
        }
        if let Some(store) = &self.config.session_store {
            if let Ok(Some(meta)) = store.read_meta(session_id) {
                if let Some(history) = meta.clients.get("runtime_edits") {
                    self.lock_edits().restore(session_id, history.clone());
                }
            }
        }
        // Each session has its own engine: its mode, auto-approve and
        // approve-all grants never leak into another session.
        let engine = shared_permission_engine_with_config(
            self.config.mode,
            &self.config.auto_approve,
            wanted,
        );
        let context = SessionContext {
            project_dir: wanted.to_string(),
            engine,
        };
        contexts.insert(session_id, context.clone());
        context
    }

    /// Update the session's saved list entry (creating it on first use).
    /// Failures are logged: metadata never fails a turn.
    fn update_meta(
        &self,
        session_id: SessionId,
        project_dir: &str,
        change: impl FnOnce(&mut SessionInfo),
    ) {
        let Some(store) = self.config.session_store.as_ref() else {
            return;
        };
        let mut meta = match store.read_meta(session_id) {
            Ok(Some(meta)) => meta,
            Ok(None) => SessionMeta {
                info: new_info(session_id, project_dir),
                clients: Default::default(),
            },
            Err(error) => {
                tracing::warn!(session = %session_id, %error, "session metadata unreadable; not updated");
                return;
            }
        };
        change(&mut meta.info);
        if let Err(error) = store.write_meta(&meta) {
            tracing::warn!(session = %session_id, %error, "session metadata not saved");
        }
    }

    fn live(&self) -> Arc<LiveSettings> {
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

    fn lock_edits(&self) -> std::sync::MutexGuard<'_, edits::EditLog> {
        self.edits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Send to runtime-wide subscribers. No subscribers is not an error.
    fn publish(&self, envelope: &RuntimeEventEnvelope) {
        let _ = self.events.send(envelope.clone());
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
    fn commit_lock(&self, session_id: SessionId) -> Arc<Mutex<()>> {
        self.commit_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(session_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn persist_edits(&self, session_id: SessionId) {
        let Some(store) = &self.config.session_store else {
            return;
        };
        let value = self.lock_edits().snapshot(session_id);
        let Ok(Some(mut meta)) = store.read_meta(session_id) else {
            return;
        };
        if meta.clients.get("runtime_edits") == Some(&value) {
            return;
        }
        meta.clients.insert("runtime_edits".into(), value);
        if let Err(error) = store.write_meta(&meta) {
            tracing::warn!(%session_id, %error, "session edit history persistence failed");
        }
    }

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

    /// A child's run id: its subagent id when that is a UUID (it always is
    /// for spawned children), so a client can match `task_output` /
    /// `kill_task` calls, which name the subagent id, to the child's card.
    fn child_id(&self, legacy_id: &str) -> RunId {
        *self
            .lock_children()
            .entry(legacy_id.to_string())
            .or_insert_with(|| legacy_id.parse().unwrap_or_default())
    }
}

struct CompactionReservation {
    inner: Arc<RuntimeInner>,
    turn_id: TurnId,
}
impl Drop for CompactionReservation {
    fn drop(&mut self) {
        self.inner.lock_turns().remove(&self.turn_id);
    }
}

struct TurnControl {
    trust: Trust,
    cancel: AbortController,
    /// Steering input the running loop picks up at its next step; whatever
    /// is still here when the turn ends is committed as user messages.
    inbox: UserInbox,
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
    #[error("session store: {0}")]
    Store(String),
    #[error("{0}")]
    Edits(String),
    #[error("{0}")]
    NotAllowed(String),
    #[error("invalid configuration: {0}")]
    Config(String),
}

pub struct TurnHandle {
    turn_id: TurnId,
    session_id: SessionId,
    pub conversation_index: Option<usize>,
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
            live.subagent_models.clone(),
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
        let turns = self.inner.lock_turns();
        let Some(control) = turns
            .get(&turn_id)
            .filter(|control| !control.inbox.is_closed())
        else {
            return false;
        };
        if let Some(mode) = mode {
            let context = self.inner.session_context(control.session_id, None);
            let (mode, auto) = effective_mode(Some(mode), self.inner.config.mode, control.trust);
            let mut engine = context
                .engine
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            engine.set_mode(mode);
            if let Some(auto) = auto {
                engine.set_auto_approve(auto);
            }
        }
        control.inbox.update_settings(thinking);
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

    /// Change settings for turns that start from now on. `patch` is a partial
    /// app config (`agente.json` shape): `provider` entries are added or
    /// replaced by id, every other key it names replaces the current value.
    /// Keys loaded from `~/.agente/auth.json` are kept.
    pub fn configure(&self, patch: serde_json::Value) -> Result<(), RuntimeError> {
        if let Some(manager) = self.configure_inner(patch)? {
            // Connect in the background when a runtime is around; otherwise
            // the servers connect on the next configure_and_connect.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move { manager.connect_all().await });
            }
        }
        Ok(())
    }

    /// Client-editable settings, without provider credentials.
    pub fn settings(&self) -> serde_json::Value {
        let live = self.inner.live();
        let config = &live.app_config;
        serde_json::json!({
            "smart_compaction": config.smart_compaction,
            "compaction_model": config.compaction_model,
            "max_parallel_subagents": config.max_parallel_subagents.unwrap_or(8),
            "subagent_models": config.subagent_models,
            "allow_media": config.allow_media,
            "approved_mcp_servers": config.approved_mcp_servers,
        })
    }

    /// Each offered provider: whether a key is on hand (auth.json, config or
    /// env — never the key itself) and where its requests go, plus the saved
    /// default provider and model.
    pub fn provider_status(&self) -> serde_json::Value {
        let live = self.inner.live();
        let config = &live.app_config;
        let providers: Vec<_> = agente_core::providers::spec::all()
            .iter()
            .filter(|spec| spec.offered)
            .map(|spec| {
                serde_json::json!({
                    "id": spec.id,
                    "connected": config.has_api_key(&spec.id),
                    "stored_key": config.auth_store.has(&spec.id),
                    "base_url": config.resolve_base_url(&spec.id),
                })
            })
            .collect();
        serde_json::json!({
            "providers": providers,
            "default_provider": live.default_provider,
            "default_model": live.default_model,
        })
    }

    /// Save a provider's key to auth.json and its endpoint override to
    /// config.json — the stores the TUI's `/connect` uses — so every client
    /// and the next turn see it. An empty `base_url` clears the override.
    pub fn connect_provider(
        &self,
        id: &str,
        api_key: Option<String>,
        base_url: Option<String>,
    ) -> Result<(), RuntimeError> {
        known_provider(id)?;
        let key = api_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
        let edit = base_url.map(|url| {
            let url = url.trim().to_string();
            move |config: &mut AppConfig| {
                let entry = config.provider.entry(id.to_string()).or_default();
                entry.options.base_url = (!url.is_empty()).then(|| url.clone());
            }
        });
        self.save_settings(
            |auth| {
                if let Some(key) = &key {
                    auth.set_key(id, key.clone());
                }
            },
            edit,
        )
    }

    /// Forget a provider's saved key (env keys stay in effect).
    pub fn disconnect_provider(&self, id: &str) -> Result<(), RuntimeError> {
        known_provider(id)?;
        self.save_settings(|auth| auth.remove(id), None::<fn(&mut AppConfig)>)
    }

    /// The provider and model turns use when the client names none.
    pub fn set_default_model(&self, provider: &str, model: &str) -> Result<(), RuntimeError> {
        known_provider(provider)?;
        let (provider, model) = (provider.to_string(), model.to_string());
        self.save_settings(
            |_| {},
            Some(move |config: &mut AppConfig| {
                config.default_provider = Some(provider.clone());
                config.default_model = Some(model.clone());
            }),
        )
    }

    /// Write auth.json (when `auth` changed it) and the global config.json
    /// (when there is an `edit`), then apply both to the live settings.
    fn save_settings(
        &self,
        auth: impl FnOnce(&mut agente_core::auth::AuthStore),
        edit: Option<impl Fn(&mut AppConfig)>,
    ) -> Result<(), RuntimeError> {
        let failed = |error: std::io::Error| RuntimeError::Config(error.to_string());
        let mut live = self
            .inner
            .live
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut store = agente_core::auth::AuthStore::load();
        let before = serde_json::to_string(&store).ok();
        auth(&mut store);
        if serde_json::to_string(&store).ok() != before {
            store.save().map_err(failed)?;
        }
        let mut config = live.app_config.clone();
        if let Some(edit) = &edit {
            AppConfig::edit_global(edit).map_err(failed)?;
            edit(&mut config);
        }
        Arc::make_mut(&mut live).app_config.auth_store = store;
        let client_providers = live.client_providers.clone();
        let next = LiveSettings::from_app_config(config, client_providers, &live);
        *live = Arc::new(next);
        Ok(())
    }

    pub fn model_info(&self, provider: &str, model: &str) -> agente_core::providers::ModelInfo {
        let live = self.inner.live();
        agente_core::providers::resolve_model_info(
            &live.provider_registry,
            live.catalog.as_deref(),
            provider,
            model,
        )
    }

    /// The models.dev rows a picker lists beside the provider's live ids
    /// ([`agente_core::models::catalog_extras`]): `(id, name, status)`.
    /// Empty when the catalog has not loaded.
    pub fn catalog_models(
        &self,
        provider: &str,
    ) -> Vec<(String, String, agente_core::catalog::ModelStatus)> {
        let live = self.inner.live();
        live.catalog
            .as_deref()
            .map(|catalog| {
                agente_core::models::catalog_extras(catalog, provider)
                    .into_iter()
                    .map(|model| (model.id.clone(), model.name.clone(), model.status.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// List a provider's models live and keep them as the snapshot turns and
    /// [`Self::model_info`] resolve against.
    pub async fn discover_models(
        &self,
        provider: &str,
    ) -> Result<Vec<agente_core::providers::ModelInfo>, RuntimeError> {
        let live = self.inner.live();
        let baseline = ProviderRegistry::from_config(&live.app_config);
        let models = agente_core::models::discover(
            &live.provider_registry,
            &baseline,
            live.catalog.as_deref(),
            provider,
        )
        .await
        .map_err(RuntimeError::Config)?;
        remember_listing(provider, &models);
        Ok(models)
    }

    /// The thinking choices a model offers (see `agente_core::thinking`).
    pub fn thinking_profile(
        &self,
        provider: &str,
        model: &str,
    ) -> agente_core::thinking::ThinkingProfile {
        let (info, format) = self.request_model(provider, model);
        agente_core::thinking::profile_for(&info, format)
    }

    /// The thinking fields a request for `level` carries on this model —
    /// what a client merges into a request it sends itself.
    pub fn thinking_request(
        &self,
        provider: &str,
        model: &str,
        level: &str,
    ) -> serde_json::Map<String, serde_json::Value> {
        let (info, format) = self.request_model(provider, model);
        agente_core::thinking::request_patch(&info, format, level)
    }

    /// A model as a request resolves it, with the wire format it goes out in.
    fn request_model(
        &self,
        provider: &str,
        model: &str,
    ) -> (
        agente_core::providers::ModelInfo,
        agente_core::providers::ApiFormat,
    ) {
        let live = self.inner.live();
        let mut info = self.model_info(provider, model);
        let format = match live.provider_registry.get(provider) {
            Some(registered) => {
                info.options = registered.get_request_options(&info);
                registered.request_api_format(&info)
            }
            None => info
                .api
                .resolved_format
                .or(info.api.format)
                .unwrap_or_default(),
        };
        (info, format)
    }

    pub fn cancel_child(&self, run_id: RunId) -> bool {
        let legacy = self
            .inner
            .lock_children()
            .iter()
            .find_map(|(legacy, id)| (*id == run_id).then(|| legacy.clone()));
        legacy.is_some_and(|id| self.inner.config.subagent_registry.cancel(&id))
    }

    /// Apply a patch; returns the MCP manager built from it, if it named
    /// `mcp`, still to be connected.
    fn configure_inner(
        &self,
        patch: serde_json::Value,
    ) -> Result<Option<Arc<McpManager>>, RuntimeError> {
        let invalid = |message: String| RuntimeError::Config(message);
        let serde_json::Value::Object(patch) = patch else {
            return Err(invalid("configure expects a JSON object".into()));
        };
        let patch_mcp = patch.contains_key("mcp");
        let patch_approvals = patch.contains_key("approved_mcp_servers");
        let mut live = self
            .inner
            .live
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut merged =
            serde_json::to_value(&live.app_config).map_err(|error| invalid(error.to_string()))?;
        let mut client_providers = live.client_providers.clone();
        if let Some(serde_json::Value::Object(providers)) = patch.get("provider") {
            client_providers.extend(providers.keys().cloned());
        }
        for (key, value) in patch {
            match (key.as_str(), value, merged.get_mut(&key)) {
                (
                    "provider" | "mcp",
                    serde_json::Value::Object(providers),
                    Some(serde_json::Value::Object(current)),
                ) => {
                    current.extend(providers);
                }
                (_, value, _) => {
                    merged[key.as_str()] = value;
                }
            }
        }
        let app_config: AppConfig =
            serde_json::from_value(merged).map_err(|error| invalid(error.to_string()))?;
        let mut next = LiveSettings::from_app_config(app_config, client_providers, &live);
        let mut added = None;
        if patch_mcp {
            let mut manager = McpManager::new();
            for (name, server) in &next.app_config.mcp {
                manager.add_client(name.clone(), server.clone());
            }
            let manager = Arc::new(manager);
            if let Some(old) = next.mcp_manager.replace(Arc::clone(&manager)) {
                old.disconnect_all();
            }
            added = Some(manager);
        }
        *live = Arc::new(next);
        if patch_mcp || patch_approvals {
            self.inner
                .project_mcps
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clear();
        }
        Ok(added)
    }

    /// Like [`Self::configure`], and waits until MCP servers the patch named
    /// are connected, so the next turn already has their tools.
    pub async fn configure_and_connect(
        &self,
        patch: serde_json::Value,
    ) -> Result<(), RuntimeError> {
        if let Some(manager) = self.configure_inner(patch)? {
            manager.connect_all().await;
        }
        Ok(())
    }

    /// Every session this runtime knows: in memory, and saved in its store.
    pub fn list_sessions(&self) -> Vec<SessionId> {
        let mut ids: Vec<SessionId> = self.inner.read_sessions().keys().copied().collect();
        if let Some(store) = &self.inner.config.session_store {
            match store.list_sessions() {
                Ok(saved) => ids.extend(saved),
                Err(error) => tracing::warn!(%error, "listing saved sessions failed"),
            }
        }
        ids.sort_by_key(|id| id.as_uuid());
        ids.dedup();
        ids
    }

    /// The MCP servers turns can use, and how each is doing.
    pub fn mcp_snapshots(&self) -> Vec<agente_core::mcp::ServerSnapshot> {
        let live = self.inner.live();
        live.mcp_manager
            .clone()
            .map(|manager| manager.snapshots())
            .unwrap_or_default()
    }

    pub fn project_mcp_snapshots(
        &self,
        project_dir: &str,
    ) -> Vec<agente_core::mcp::ServerSnapshot> {
        self.inner.project_mcp(project_dir).snapshots()
    }

    pub async fn control_mcp(
        &self,
        project_dir: &str,
        name: &str,
        action: &str,
    ) -> Result<(), RuntimeError> {
        let manager = self.inner.project_mcp(project_dir);
        let server = manager
            .snapshots()
            .into_iter()
            .find(|server| server.name == name)
            .ok_or_else(|| RuntimeError::Config(format!("unknown MCP server {name}")))?;
        match action {
            "disable" => manager.disable(name),
            "approve" => {
                if server.source != agente_core::mcp::ServerSource::ProjectFile {
                    return Err(RuntimeError::Config(
                        "only project MCP servers need approval".into(),
                    ));
                }
                let mut approved = self.inner.live().app_config.approved_mcp_servers.clone();
                let key = agente_core::mcp::approval_key(project_dir, name);
                if !approved.contains(&key) {
                    approved.push(key);
                }
                self.configure(serde_json::json!({ "approved_mcp_servers": approved }))?;
                self.inner.project_mcp(project_dir).reconnect(name).await;
            }
            "reconnect" if server.status != agente_core::mcp::ServerStatus::NeedsApproval => {
                manager.reconnect(name).await
            }
            _ => {
                return Err(RuntimeError::Config(
                    "choose approve, reconnect or disable".into(),
                ))
            }
        }
        Ok(())
    }

    /// Saved sessions' list entries, most recently active first.
    pub fn session_infos(&self) -> Vec<SessionInfo> {
        let Some(store) = &self.inner.config.session_store else {
            return Vec::new();
        };
        store.list_infos().unwrap_or_else(|error| {
            tracing::warn!(%error, "listing session infos failed");
            Vec::new()
        })
    }

    /// A saved session's list entry and what each client keeps about it.
    pub fn session_meta(&self, session_id: SessionId) -> Option<SessionMeta> {
        self.inner
            .config
            .session_store
            .as_ref()?
            .read_meta(session_id)
            .ok()
            .flatten()
    }

    /// Save what one client keeps about a session (its view of it), and
    /// optionally a new title. Needs a store.
    pub fn save_client_state(
        &self,
        session_id: SessionId,
        client: &str,
        state: serde_json::Value,
        title: Option<String>,
    ) -> Result<(), RuntimeError> {
        let store = self
            .inner
            .config
            .session_store
            .as_ref()
            .ok_or_else(|| RuntimeError::Store("persistence is off".into()))?;
        let mut meta = store
            .read_meta(session_id)
            .map_err(|error| RuntimeError::Store(error.to_string()))?
            .unwrap_or_else(|| SessionMeta {
                info: new_info(session_id, &self.inner.config.project_dir),
                clients: Default::default(),
            });
        meta.clients.insert(client.to_string(), state);
        if let Some(title) = title {
            meta.info.title = title;
        }
        store
            .write_meta(&meta)
            .map_err(|error| RuntimeError::Store(error.to_string()))
    }

    /// Forget a session, in memory and on disk. Refused while a turn runs.
    pub fn delete_session(&self, session_id: SessionId) -> Result<bool, RuntimeError> {
        if self.is_busy(session_id) {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        let mut existed = self.inner.write_sessions().remove(&session_id).is_some();
        self.inner.lock_edits().forget(session_id);
        self.inner
            .contexts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&session_id);
        if let Some(store) = &self.inner.config.session_store {
            existed |= store
                .delete(session_id)
                .map_err(|error| RuntimeError::Store(error.to_string()))?;
        }
        Ok(existed)
    }

    /// Shrink the session's conversation now (trimming older turns, keeping
    /// recent ones), like the automatic compaction between model calls.
    /// Refused while a turn runs. Returns the new snapshot.
    fn reserve_compaction(
        &self,
        session_id: SessionId,
    ) -> Result<CompactionReservation, RuntimeError> {
        let mut turns = self.inner.lock_turns();
        if turns
            .values()
            .any(|control| control.session_id == session_id)
        {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        let turn_id = TurnId::new();
        let inbox = UserInbox::default();
        inbox.close();
        let (events, _rx) = mpsc::channel(1);
        turns.insert(
            turn_id,
            TurnControl {
                trust: Trust::Owner,
                cancel: AbortController::new(),
                inbox,
                events,
                session_id,
            },
        );
        Ok(CompactionReservation {
            inner: Arc::clone(&self.inner),
            turn_id,
        })
    }

    pub async fn compact_smart(
        &self,
        session_id: SessionId,
    ) -> Result<(SessionSnapshot, bool, Option<agente_core::llm::Usage>), RuntimeError> {
        let _reservation = self.reserve_compaction(session_id)?;
        let snapshot = self.inner.lookup_session(session_id);
        let meta = self.session_meta(session_id).ok_or_else(|| {
            RuntimeError::Config(
                "Choose a model and start a conversation before smart compaction".into(),
            )
        })?;
        let live = self.inner.live();
        let provider_id = live
            .compaction_model
            .as_ref()
            .map_or(meta.info.provider.as_str(), |chosen| {
                chosen.provider.as_str()
            });
        let model_id = live
            .compaction_model
            .as_ref()
            .map_or(meta.info.model.as_str(), |chosen| chosen.model.as_str());
        let provider = live.provider_registry.get(provider_id).ok_or_else(|| {
            RuntimeError::Config("The conversation provider is unavailable".into())
        })?;
        let mut model = agente_core::providers::resolve_model_info(
            &live.provider_registry,
            live.catalog.as_deref(),
            provider_id,
            model_id,
        );
        model.options = provider.get_request_options(&model);
        let tokens_before = agente_core::context::estimate_message_tokens(&snapshot.conversation);
        let strategy = agente_core::context::CompactionStrategy::manual(
            model.limits.context as usize,
            tokens_before,
        );
        let summarizer = Arc::new(agente_core::providers::ProviderSummarizer::new(
            provider,
            model,
            agente_core::providers::RequestContext::new(session_id.as_uuid()),
        ));
        let result = agente_core::context::ContextCompactor::new(strategy)
            .with_summarizer(summarizer.clone())
            .compact_async_forced(snapshot.conversation.clone())
            .await;
        let smart = matches!(
            result.summary.metadata.summary_type,
            agente_core::context::SummaryType::Semantic
        );
        let tokens_after = agente_core::context::estimate_message_tokens(&result.messages);
        if tokens_after >= tokens_before {
            return Ok((
                snapshot,
                false,
                if summarizer.attempted() {
                    summarizer.usage()
                } else {
                    Some(agente_core::llm::Usage::default())
                },
            ));
        }
        self.inner.lock_edits().compacted(session_id);
        self.inner.persist_edits(session_id);
        let revision = bridge::replace_conversation(&self.inner, session_id, result.messages);
        self.inner.publish(&self.envelope(
            session_id,
            TurnId::new(),
            None,
            RuntimeEvent::ContextCompacted {
                summary: result.summary.content,
                revision,
                tokens_before: tokens_before as u32,
                tokens_after: tokens_after as u32,
                smart,
            },
        ));
        Ok((
            self.inner.lookup_session(session_id),
            smart,
            if summarizer.attempted() {
                summarizer.usage()
            } else {
                Some(agente_core::llm::Usage::default())
            },
        ))
    }

    pub fn compact(&self, session_id: SessionId) -> Result<SessionSnapshot, RuntimeError> {
        let _reservation = self.reserve_compaction(session_id)?;
        let snapshot = self.inner.lookup_session(session_id);
        let before = snapshot.conversation.len();
        let tokens_before =
            agente_core::context::estimate_message_tokens(&snapshot.conversation) as u32;
        // The session's own model decides how much room there is.
        let window = self
            .session_meta(session_id)
            .filter(|meta| !meta.info.provider.is_empty())
            .map(|meta| {
                self.model_info(&meta.info.provider, &meta.info.model)
                    .limits
                    .context
            })
            .unwrap_or(0) as usize;
        let result = agente_core::context::ContextCompactor::new(
            agente_core::context::CompactionStrategy::manual(window, tokens_before as usize),
        )
        .compact_forced(snapshot.conversation);
        if result.messages.len() == before && result.summary.tokens_saved == 0 {
            return Ok(self.inner.lookup_session(session_id));
        }
        let after = result.messages.len();
        let tokens_saved = result.summary.tokens_saved as u32;
        self.inner.session_context(session_id, None);
        self.inner.lock_edits().compacted(session_id);
        self.inner.persist_edits(session_id);
        let revision = bridge::replace_conversation(&self.inner, session_id, result.messages);
        let envelope = self.envelope(
            session_id,
            TurnId::new(),
            None,
            RuntimeEvent::ContextCompacted {
                summary: format!("{} messages compacted", before.saturating_sub(after)),
                revision,
                tokens_before,
                tokens_after: tokens_before.saturating_sub(tokens_saved),
                smart: false,
            },
        );
        self.inner.publish(&envelope);
        Ok(self.inner.lookup_session(session_id))
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
        if trust < Trust::Owner {
            return Err(RuntimeError::NotAllowed(format!(
                "only the owner can run {tool} directly"
            )));
        }
        if tokio::runtime::Handle::try_current().is_err() {
            return Err(RuntimeError::MissingExecutor);
        }
        let turn_id = TurnId::new();
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
            inner.lock_turns().remove(&turn_id);
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

    /// Restore the files the session's last turn changed. Refused while a
    /// turn runs, or when a file changed since (it is never overwritten).
    /// Returns the restored paths.
    pub fn undo(&self, session_id: SessionId) -> Result<Vec<String>, RuntimeError> {
        self.edit_files(session_id, |log, project| log.undo(session_id, project))
    }

    /// Re-apply the edits the last undo took back.
    pub fn redo(&self, session_id: SessionId) -> Result<Vec<String>, RuntimeError> {
        self.edit_files(session_id, |log, project| log.redo(session_id, project))
    }

    /// Go back to before `conversation_index` (a user message): undo the file
    /// edits of every turn from there on and drop those messages. Returns how
    /// many turns' edits were reverted.
    pub fn rewind(
        &self,
        session_id: SessionId,
        conversation_index: usize,
    ) -> Result<usize, RuntimeError> {
        if self.is_busy(session_id) {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        if conversation_index > self.inner.lookup_session(session_id).conversation.len() {
            return Err(RuntimeError::Config(
                "conversation index is beyond this session".into(),
            ));
        }
        let project_dir = self.inner.session_context(session_id, None).project_dir;
        let reverted = self
            .inner
            .lock_edits()
            .rewind(session_id, conversation_index, &project_dir)
            .map_err(RuntimeError::Edits)?;
        let mut conversation = self.inner.lookup_session(session_id).conversation;
        conversation.truncate(conversation_index);
        bridge::replace_conversation(&self.inner, session_id, conversation);
        self.inner.persist_edits(session_id);
        Ok(reverted)
    }

    fn edit_files(
        &self,
        session_id: SessionId,
        change: impl FnOnce(&mut edits::EditLog, &str) -> Result<Vec<String>, String>,
    ) -> Result<Vec<String>, RuntimeError> {
        if self.is_busy(session_id) {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        let project_dir = self.inner.session_context(session_id, None).project_dir;
        let paths =
            change(&mut self.inner.lock_edits(), &project_dir).map_err(RuntimeError::Edits)?;
        self.inner.persist_edits(session_id);
        Ok(paths)
    }

    /// Whether a turn is running in the session.
    pub fn is_busy(&self, session_id: SessionId) -> bool {
        self.inner
            .lock_turns()
            .values()
            .any(|control| control.session_id == session_id)
    }

    pub fn session_snapshot(&self, session_id: SessionId) -> SessionSnapshot {
        self.inner.lookup_session(session_id)
    }

    /// Bind a client session before its first turn (including direct tools).
    pub fn open_session(
        &self,
        session_id: SessionId,
        project_dir: &str,
    ) -> Result<SessionSnapshot, RuntimeError> {
        if self.is_busy(session_id) {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        if !std::path::Path::new(project_dir).is_dir() {
            return Err(RuntimeError::Config(format!(
                "project folder does not exist: {project_dir}"
            )));
        }
        self.inner.session_context(session_id, Some(project_dir));
        let snapshot = self.session_snapshot(session_id);
        self.inner.update_meta(session_id, project_dir, |info| {
            info.project_dir = project_dir.to_string()
        });
        Ok(snapshot)
    }

    pub fn checkpoints(&self, session_id: SessionId) -> serde_json::Value {
        let project = self
            .session_meta(session_id)
            .map(|meta| meta.info.project_dir);
        self.inner.session_context(session_id, project.as_deref());
        self.inner.lock_edits().checkpoints(session_id)
    }

    pub fn fork_session(&self, source: SessionId) -> SessionSnapshot {
        let source = self.session_snapshot(source);
        let project_dir = self
            .inner
            .session_context(source.session_id, None)
            .project_dir;
        let session_id = SessionId::new();
        let snapshot = SessionSnapshot {
            session_id,
            revision: 0,
            conversation: source.conversation,
        };
        self.inner
            .write_sessions()
            .insert(session_id, snapshot.clone());
        self.inner.session_context(session_id, Some(&project_dir));
        self.inner.update_meta(session_id, &project_dir, |_| {});
        self.inner.persist_snapshot(&snapshot);
        snapshot
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

#[cfg(test)]
mod tests {
    #[test]
    fn saved_edits_recover_the_project_and_remain_undoable_after_restart() {
        let (config, root) = persistent_config("edits-recovery");
        let project = root.join("other-project");
        std::fs::create_dir_all(&project).unwrap();
        let session = agente_protocol::SessionId::new();
        let runtime = super::RuntimeSupervisor::start(config);
        runtime
            .open_session(session, project.to_str().unwrap())
            .unwrap();
        runtime.inner.lock_edits().begin_turn(session, 3);
        std::fs::write(project.join("a.txt"), "keep\nnew\n").unwrap();
        runtime.inner.lock_edits().end_turn(
            session,
            vec![super::edits::FileEdit {
                path: "a.txt".into(),
                before: Some("keep\nold\n".into()),
                after: Some("keep\nnew\n".into()),
            }],
        );
        runtime.inner.persist_edits(session);
        drop(runtime);
        let restored = super::RuntimeSupervisor::start(persistent_config_at(&root));
        let checkpoints = restored.checkpoints(session);
        assert_eq!(checkpoints[0]["additions"], 1);
        assert_eq!(checkpoints[0]["deletions"], 1);
        assert_eq!(restored.undo(session).unwrap(), vec!["a.txt"]);
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "keep\nold\n"
        );
        drop(restored);
        let restored = super::RuntimeSupervisor::start(persistent_config_at(&root));
        restored.redo(session).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "keep\nnew\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }
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
        let first = handle.inner.cached_system_prompt("D:/proj");
        let second = handle.inner.cached_system_prompt("D:/proj");
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

    fn persistent_config_at(root: &Path) -> RuntimeConfig {
        test_config()
            .with_persistence_dir(root.to_path_buf())
            .expect("store reopens")
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
                trust: Trust::Owner,
                cancel: AbortController::new(),
                inbox: {
                    let inbox = UserInbox::default();
                    inbox
                        .lock()
                        .extend(steering.iter().map(|text| Message::user(*text)));
                    inbox
                },
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
            ..StartTurn::default()
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
            ..StartTurn::default()
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

    #[test]
    fn trust_below_owner_is_read_only() {
        use agente_protocol::{Trust, TurnMode};
        assert_eq!(
            effective_mode(Some(TurnMode::Build), AgentMode::Plan, Trust::Owner),
            (AgentMode::Build, Some(false))
        );
        assert_eq!(
            effective_mode(Some(TurnMode::Auto), AgentMode::Plan, Trust::Owner),
            (AgentMode::Build, Some(true))
        );
        assert_eq!(
            effective_mode(None, AgentMode::Build, Trust::Owner),
            (AgentMode::Build, None)
        );
        for trust in [Trust::Trusted, Trust::Public] {
            for requested in [Some(TurnMode::Build), Some(TurnMode::Auto), None] {
                assert_eq!(
                    effective_mode(requested, AgentMode::Build, trust),
                    (AgentMode::Plan, Some(false)),
                    "{trust:?} must never build"
                );
            }
        }
    }

    #[test]
    fn sessions_in_other_projects_get_their_own_permissions() {
        let handle = RuntimeSupervisor::start(test_config());
        let home = handle.inner.session_context(SessionId::new(), None);
        assert_eq!(home.project_dir, "D:/proj");
        let other_home = handle.inner.session_context(SessionId::new(), None);
        assert!(
            !Arc::ptr_eq(&home.engine, &other_home.engine),
            "sessions in one project still get their own engine"
        );

        let session = SessionId::new();
        let other = handle.inner.session_context(session, Some("D:/other"));
        assert_eq!(other.project_dir, "D:/other");
        assert!(!Arc::ptr_eq(&other.engine, &home.engine));
        // The same session keeps its context when a later turn names no project.
        let again = handle.inner.session_context(session, None);
        assert!(Arc::ptr_eq(&other.engine, &again.engine));
    }

    #[test]
    fn active_controls_are_scoped_and_keep_untrusted_turns_read_only() {
        let handle = RuntimeSupervisor::start(test_config());
        let session_id = SessionId::new();
        let other = handle.inner.session_context(SessionId::new(), None);
        let context = handle.inner.session_context(session_id, None);
        let turn_id = TurnId::new();
        let cancel = AbortController::new();
        let inbox = UserInbox::default();
        handle.inner.lock_turns().insert(
            turn_id,
            TurnControl {
                trust: Trust::Owner,
                cancel: cancel.clone(),
                inbox: inbox.clone(),
                events: mpsc::channel(1).0,
                session_id,
            },
        );
        assert!(handle.update_turn(turn_id, Some("high".into()), Some(TurnMode::Auto)));
        assert_eq!(context.engine.read().unwrap().mode, AgentMode::Build);
        assert!(context.engine.read().unwrap().auto_approve());
        assert_eq!(other.engine.read().unwrap().mode, AgentMode::Build);
        assert!(!cancel.signal().is_aborted());
        assert!(handle.update_turn(turn_id, None, Some(TurnMode::Build)));
        assert!(!context.engine.read().unwrap().auto_approve());
        assert!(handle.update_turn(turn_id, None, Some(TurnMode::Plan)));
        assert_eq!(context.engine.read().unwrap().mode, AgentMode::Plan);
        handle.inner.lock_turns().get_mut(&turn_id).unwrap().trust = Trust::Public;
        assert!(handle.update_turn(turn_id, None, Some(TurnMode::Auto)));
        assert_eq!(context.engine.read().unwrap().mode, AgentMode::Plan);
        assert!(!context.engine.read().unwrap().auto_approve());
        inbox.close();
        assert!(!handle.update_turn(turn_id, None, Some(TurnMode::Auto)));
    }

    #[tokio::test]
    async fn steering_joins_the_running_turn_without_cancelling_it() {
        let handle = RuntimeSupervisor::start(test_config());
        let mut attached = handle.subscribe();
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let cancel = AbortController::new();
        let inbox = UserInbox::default();
        let (events, mut turn_events) = mpsc::channel(8);
        handle.inner.lock_turns().insert(
            turn_id,
            TurnControl {
                trust: Trust::Owner,
                cancel: cancel.clone(),
                inbox: Arc::clone(&inbox),
                events,
                session_id,
            },
        );

        assert!(handle.steer(
            turn_id,
            UserInput {
                content: "also check the tests".into()
            }
        ));

        assert!(!cancel.signal().is_aborted(), "steering must not cancel");
        assert_eq!(contents_of(&inbox.lock()), vec!["also check the tests"]);
        let own = turn_events.recv().await.expect("turn channel event");
        assert!(matches!(own.event, RuntimeEvent::SteeringQueued));
        let broadcast = attached.recv().await.expect("runtime-wide event");
        assert!(matches!(broadcast.event, RuntimeEvent::SteeringQueued));
        assert_eq!(broadcast.turn_id, turn_id);
        assert!(!handle.steer(
            TurnId::new(),
            UserInput {
                content: "x".into()
            }
        ));
    }

    #[test]
    fn list_and_delete_cover_memory_and_disk() {
        let (config, dir) = persistent_config("list-delete");
        let handle = RuntimeSupervisor::start(config);
        let session_id = SessionId::new();
        let snapshot = SessionSnapshot {
            session_id,
            revision: 1,
            conversation: vec![Message::user("hello")],
        };
        handle
            .inner
            .write_sessions()
            .insert(session_id, snapshot.clone());
        handle.inner.persist_snapshot(&snapshot);

        let restarted = RuntimeSupervisor::start(persistent_config_at(&dir));
        assert_eq!(restarted.list_sessions(), vec![session_id]);

        // A running turn blocks deletion.
        restarted.inner.lock_turns().insert(
            TurnId::new(),
            TurnControl {
                trust: Trust::Owner,
                cancel: AbortController::new(),
                inbox: UserInbox::default(),
                events: mpsc::channel(1).0,
                session_id,
            },
        );
        assert!(matches!(
            restarted.delete_session(session_id),
            Err(RuntimeError::SessionBusy(_))
        ));
        restarted.inner.lock_turns().clear();

        assert!(restarted.delete_session(session_id).unwrap());
        assert!(restarted.list_sessions().is_empty());
        assert!(RuntimeSupervisor::start(persistent_config_at(&dir))
            .list_sessions()
            .is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn compact_shrinks_a_long_conversation_and_bumps_the_revision() {
        let handle = RuntimeSupervisor::start(test_config());
        let mut attached = handle.subscribe();
        let session_id = SessionId::new();
        let long = "lorem ipsum dolor sit amet ".repeat(400);
        let conversation = (0..40)
            .map(|i| {
                if i % 2 == 0 {
                    Message::user(format!("{i} {long}"))
                } else {
                    let mut reply = Message::user(format!("{i} {long}"));
                    reply.role = Role::Assistant;
                    reply
                }
            })
            .collect::<Vec<_>>();
        handle.inner.write_sessions().insert(
            session_id,
            SessionSnapshot {
                session_id,
                revision: 3,
                conversation,
            },
        );

        let compacted = handle.compact(session_id).unwrap();
        assert!(
            compacted.conversation.len() < 40,
            "{}",
            compacted.conversation.len()
        );
        assert_eq!(compacted.revision, 4);
        assert!(matches!(
            attached.try_recv().map(|e| e.event),
            Ok(RuntimeEvent::ContextCompacted { revision: 4, .. })
        ));
    }

    #[tokio::test]
    async fn a_turn_saves_the_session_list_entry() {
        let (config, dir) = persistent_config("meta");
        let handle = RuntimeSupervisor::start(config);
        let session_id = SessionId::new();
        let mut turn = handle
            .start_turn(StartTurn {
                session_id,
                conversation: vec![Message::user("  summarize   the release notes  ")],
                // Unknown provider fails fast, before any network access.
                provider: Some("definitely-not-a-provider".into()),
                profile: Some("colina".into()),
                ..StartTurn::default()
            })
            .expect("turn starts");
        let _ = turn.outcome().await;

        let infos = handle.session_infos();
        assert_eq!(infos.len(), 1);
        let info = &infos[0];
        assert_eq!(info.session_id, session_id);
        assert_eq!(info.first_prompt, "summarize the release notes");
        assert_eq!(info.provider, "definitely-not-a-provider");
        assert_eq!(info.profile.as_deref(), Some("colina"));
        assert_eq!(info.project_dir, "D:/proj");

        handle
            .save_client_state(
                session_id,
                "tui",
                serde_json::json!({"x": 1}),
                Some("Release notes".into()),
            )
            .unwrap();
        let meta = handle.session_meta(session_id).unwrap();
        assert_eq!(meta.info.title, "Release notes");
        assert_eq!(meta.clients["tui"], serde_json::json!({"x": 1}));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn exec_tool_runs_a_direct_command_without_touching_the_conversation() {
        let dir = std::env::temp_dir().join(format!("agente-exec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let handle = RuntimeSupervisor::start(RuntimeConfig::from_app_config(
            &AppConfig::default(),
            dir.to_string_lossy().to_string(),
        ));
        let session_id = SessionId::new();

        assert!(matches!(
            handle.exec_tool(
                session_id,
                "shell",
                serde_json::json!({"command": "echo hi"}),
                Trust::Public
            ),
            Err(RuntimeError::NotAllowed(_))
        ));

        let mut run = handle
            .exec_tool(
                session_id,
                "shell",
                serde_json::json!({"command": "echo hi"}),
                Trust::Owner,
            )
            .expect("owner can run a command");
        let mut result = None;
        while let Some(envelope) = run.recv().await {
            if let RuntimeEvent::ToolResult {
                content, is_error, ..
            } = &envelope.event
            {
                result = Some((content.clone(), *is_error));
            }
            if envelope.event.is_terminal() {
                break;
            }
        }
        let (content, is_error) = result.expect("a tool result");
        assert!(!is_error, "{content}");
        assert!(content.contains("hi"), "{content}");
        assert_eq!(run.outcome().await.unwrap().status, TurnStatus::Completed);
        assert!(handle.session_snapshot(session_id).conversation.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn live_reads_share_an_immutable_snapshot_and_configure_keeps_old_turn_settings() {
        let handle = RuntimeSupervisor::start(test_config());
        let first = handle.inner.live();
        assert!(Arc::ptr_eq(&first, &handle.inner.live()));
        let old_limit = first.max_iterations;
        handle
            .configure(serde_json::json!({ "max_iterations": old_limit + 1 }))
            .unwrap();
        let next = handle.inner.live();
        assert!(!Arc::ptr_eq(&first, &next));
        assert_eq!(first.max_iterations, old_limit);
        assert_eq!(next.max_iterations, old_limit + 1);
    }

    #[test]
    fn configure_adds_a_provider_and_changes_the_defaults() {
        let handle = RuntimeSupervisor::start(test_config());
        handle
            .configure(serde_json::json!({
                "provider": {
                    "local-llama": {
                        "name": "Local llama.cpp",
                        "api_format": "openai",
                        "options": { "base_url": "http://127.0.0.1:11435/v1", "api_key": "k" },
                        "models": { "qwen3-8b": { "name": "Qwen3 8B" } }
                    }
                },
                "default_provider": "local-llama",
                "default_model": "qwen3-8b",
                "smart_compaction": true
            }))
            .unwrap();
        let live = handle.inner.live();
        assert_eq!(live.default_provider, "local-llama");
        assert_eq!(live.default_model, "qwen3-8b");
        assert!(live.smart_compaction);
        let local = live
            .provider_registry
            .get("local-llama")
            .expect("registered");
        assert_eq!(local.info().base_url, "http://127.0.0.1:11435/v1");

        // A later patch adds to the providers instead of replacing them.
        handle
            .configure(serde_json::json!({ "provider": { "other": { "api_format": "openai" } } }))
            .unwrap();
        let live = handle.inner.live();
        assert!(live.app_config.provider.contains_key("local-llama"));
        assert!(live.app_config.provider.contains_key("other"));
        assert_eq!(live.default_provider, "local-llama", "untouched keys stay");

        assert!(matches!(
            handle.configure(serde_json::json!([1])),
            Err(RuntimeError::Config(_))
        ));
        assert!(matches!(
            handle.configure(serde_json::json!({ "smart_compaction": "yes" })),
            Err(RuntimeError::Config(_))
        ));
    }

    #[tokio::test]
    async fn a_prompt_is_appended_and_a_session_can_bring_its_own_system_prompt() {
        let handle = RuntimeSupervisor::start(test_config());
        let session_id = SessionId::new();
        let start = |prompt: &str, system: Option<&str>| StartTurn {
            session_id,
            prompt: Some(Message::user(prompt)),
            system_prompt: system.map(str::to_string),
            // Unknown provider fails fast, before any network access.
            provider: Some("definitely-not-a-provider".into()),
            ..StartTurn::default()
        };
        let mut first = handle
            .start_turn(start("first", Some("You are the Code section.")))
            .unwrap();
        let _ = first.outcome().await;
        let mut second = handle.start_turn(start("second", None)).unwrap();
        let _ = second.outcome().await;

        let conversation = handle.session_snapshot(session_id).conversation;
        assert_eq!(conversation[0].role, Role::System);
        assert_eq!(conversation[0].content, "You are the Code section.");
        let users: Vec<_> = conversation
            .iter()
            .filter(|m| m.role == Role::User)
            .map(|m| m.content.as_str())
            .collect();
        assert_eq!(users, vec!["first", "second"]);
    }

    /// A bot's persona (and so its memory) is read afresh on every turn.
    #[tokio::test]
    async fn a_profile_turn_uses_the_current_persona() {
        struct Personas(std::sync::Mutex<String>);
        impl ProfileSource for Personas {
            fn persona(&self, profile: &str) -> Option<String> {
                (profile == "colina").then(|| self.0.lock().unwrap().clone())
            }
        }
        let personas = Arc::new(Personas(std::sync::Mutex::new(
            "You are Colina (@colina).\nMemory: likes tea.".into(),
        )));
        let handle = RuntimeSupervisor::start(test_config().with_profile_source(personas.clone()));
        let session_id = SessionId::new();
        let start = |prompt: &str, profile: &str| StartTurn {
            session_id,
            prompt: Some(Message::user(prompt)),
            profile: Some(profile.into()),
            // Unknown provider fails fast, before any network access.
            provider: Some("definitely-not-a-provider".into()),
            ..StartTurn::default()
        };
        let system = || {
            handle.session_snapshot(session_id).conversation[0]
                .content
                .clone()
        };

        let _ = handle
            .start_turn(start("hi", "colina"))
            .unwrap()
            .outcome()
            .await;
        assert!(system().starts_with("You are Colina (@colina).\nMemory: likes tea."));
        assert!(system().contains("Read before you act."));

        *personas.0.lock().unwrap() = "You are Colina (@colina).\nMemory: likes coffee.".into();
        let _ = handle
            .start_turn(start("again", "colina"))
            .unwrap()
            .outcome()
            .await;
        assert!(system().contains("likes coffee"));
        assert!(!system().contains("likes tea"));

        // An unknown profile keeps the prompt the session has.
        let _ = handle
            .start_turn(start("third", "nobody"))
            .unwrap()
            .outcome()
            .await;
        assert!(system().contains("likes coffee"));
    }

    #[tokio::test]
    async fn configure_can_add_mcp_servers_a_client_serves() {
        let handle = RuntimeSupervisor::start(test_config());
        assert!(handle.inner.live().mcp_manager.is_none());
        // Nothing listens on port 9: connecting fails, configuring does not.
        handle
            .configure_and_connect(serde_json::json!({
                "mcp": { "desktop": { "type": "http", "url": "http://127.0.0.1:9/mcp" } }
            }))
            .await
            .unwrap();
        let manager = handle
            .inner
            .live()
            .mcp_manager
            .clone()
            .expect("manager built");
        assert!(manager.tools().is_empty());
        // Settings that do not name mcp keep the manager.
        handle
            .configure(serde_json::json!({ "smart_compaction": true }))
            .unwrap();
        assert!(Arc::ptr_eq(
            &manager,
            &handle.inner.live().mcp_manager.clone().unwrap()
        ));
    }
}
