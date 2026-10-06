//! The real engine: one `agente_core::agent::spawn_chat_task` per turn.
//!
//! Ports the Electron main-process agent (`main/agente/*`) without the Node
//! hop. Everything the core already does comes along for free: provider specs
//! and transport policy, prompt caching, thinking profiles, tool batching
//! (parallel reads / sequential writes), the approval broker, subagents,
//! compaction with before/after tokens, loop detection, spend accounting and
//! MCP servers. The UI only starts turns, drains `AgentEvent`s and answers
//! approvals, exactly like the TUI does.

use std::sync::Arc;

use agente_core::agent::{ApprovalSource, AgentEvent, AgentTaskEvent, spawn_chat_task};
use agente_core::cancellation::AbortController;
use agente_core::config::AppConfig;
use agente_core::mcp::client::McpManager;
use agente_core::permissions::{
    ApprovalBroker, SharedPermissionEngine, shared_permission_engine_with_config,
};
use agente_core::providers::ProviderRegistry;
use agente_core::subagent::SubagentRegistry;
use agente_core::types::{AgentMode as CoreMode, ApprovalAction, Message};
use agente_core::agent::UserInbox;
use tokio::runtime::Runtime;

use crate::backend::AgentMode;

/// One live turn's inputs. Conversions from UI state happen in `app.rs`.
pub struct TurnSpec {
    pub conversation: Vec<Message>,
    pub provider: String,
    pub model: String,
    pub thinking_level: String,
    pub mode: AgentMode,
    pub project_dir: String,
    pub auto_approve: bool,
}

fn core_mode(mode: AgentMode) -> CoreMode {
    match mode {
        AgentMode::Plan => CoreMode::Plan,
        AgentMode::Build => CoreMode::Build,
    }
}

/// Owns the runtime, the provider registry and the turn channel. One instance
/// for the whole app, like the Electron main process's agent runtime.
pub struct Engine {
    runtime: Runtime,
    config: AppConfig,
    registry: Arc<ProviderRegistry>,
    permission: SharedPermissionEngine,
    broker: ApprovalBroker,
    subagents: SubagentRegistry,
    mcp: Option<Arc<McpManager>>,
    inbox: UserInbox,
    cancel: AbortController,
    task_id: u64,
    handle: Option<tokio::task::JoinHandle<()>>,
    tx: std::sync::mpsc::Sender<AgentTaskEvent>,
    rx: std::sync::mpsc::Receiver<AgentTaskEvent>,
}

impl Engine {
    /// Loads `~/.agente/config.json` plus the project's `agente.json`, builds
    /// the provider registry, and connects configured MCP servers in the
    /// background.
    pub fn new(project_dir: &str) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("agente-engine")
            .build()
            .expect("engine runtime builds");
        let config = AppConfig::load(project_dir);
        let registry = Arc::new(ProviderRegistry::from_config(&config));
        let permission = shared_permission_engine_with_config(
            CoreMode::Plan,
            &config.auto_approve,
            project_dir,
        );
        let mcp = {
            let manager = Arc::new(McpManager::from_sources(
                &config.mcp,
                project_dir,
                &config.approved_mcp_servers,
            ));
            if !manager.is_empty() {
                let connecting = Arc::clone(&manager);
                runtime.spawn(async move {
                    connecting.connect_all().await;
                });
                Some(manager)
            } else {
                None
            }
        };
        let (tx, rx) = std::sync::mpsc::channel();
        Self {
            runtime,
            config,
            registry,
            permission,
            broker: ApprovalBroker::new(),
            subagents: SubagentRegistry::new(),
            mcp,
            inbox: UserInbox::default(),
            cancel: AbortController::new(),
            task_id: 0,
            handle: None,
            tx,
            rx,
        }
    }

    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    pub fn config_mut(&mut self) -> &mut AppConfig {
        &mut self.config
    }

    /// Reloads the registry after a config change (provider keys, models).
    pub fn reload_providers(&mut self) {
        self.registry = Arc::new(ProviderRegistry::from_config(&self.config));
    }

    /// Saves `~/.agente/config.json` — the same file the TUI reads.
    pub fn save_config(&self) -> std::io::Result<()> {
        self.config.save()
    }

    pub fn registry(&self) -> Arc<ProviderRegistry> {
        Arc::clone(&self.registry)
    }

    /// The permission engine the running turn consults.
    pub fn permission(&self) -> SharedPermissionEngine {
        Arc::clone(&self.permission)
    }

    /// Sets the mode the next turn runs under.
    pub fn set_mode(&self, mode: AgentMode) {
        self.permission
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .set_mode(core_mode(mode));
    }

    /// Session-wide auto-approve, the same switch Electron's header carries.
    pub fn set_auto_approve(&self, auto_approve: bool) {
        self.permission
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .set_auto_approve(auto_approve);
    }

    /// A model's live metadata, for the composer's capability checks.
    pub fn model_info(&self, provider: &str, model: &str) -> Option<agente_core::providers::ModelInfo> {
        self.registry.get_model(provider, model)
    }

    /// Providers that have a usable key.
    pub fn configured_providers(&self) -> Vec<String> {
        self.registry
            .provider_ids()
            .into_iter()
            .filter(|id| self.registry.has_api_key(id))
            .collect()
    }

    /// Starts a turn. Returns its task id, or None when one is already running
    /// or the provider/model pair is incomplete.
    pub fn start_turn(&mut self, spec: TurnSpec) -> Option<u64> {
        if self.running() {
            return None;
        }
        if spec.provider.trim().is_empty() || spec.model.trim().is_empty() {
            return None;
        }
        self.task_id += 1;
        let task_id = self.task_id;
        self.cancel.abort();
        self.cancel = AbortController::new();
        let signal = self.cancel.signal();
        let session_id = uuid::Uuid::new_v4();
        let project_dir = spec.project_dir.clone();
        let sender = self.tx.clone();
        let registry = Arc::clone(&self.registry);
        let catalog = self.config.catalog.clone().map(Arc::new);
        let permission = Arc::clone(&self.permission);
        let broker = self.broker.clone();
        let mcp = self.mcp.clone();
        let max_iterations = self.config.max_iterations();
        let subagent_models = self.config.subagent_models.clone();
        let smart_compaction = self.config.smart_compaction;
        let compaction_model = self.config.compaction_model.clone();
        let parallel = self.config.parallel_subagents();
        let inbox = Arc::clone(&self.inbox);
        let subagents = self.subagents.clone();
        let mode = spec.mode;
        let auto_approve = spec.auto_approve;

        self.set_mode(mode);
        self.set_auto_approve(auto_approve);

        let _guard = self.runtime.enter();
        let handle = spawn_chat_task(
            session_id,
            task_id,
            sender,
            spec.conversation,
            spec.provider,
            spec.model,
            spec.thinking_level,
            project_dir,
            max_iterations,
            registry,
            catalog,
            permission,
            signal,
            broker,
            mcp,
            subagents,
            subagent_models,
            smart_compaction,
            compaction_model,
            parallel,
            inbox,
            agente_core::agent::TurnTools::default(),
        );
        self.handle = Some(handle);
        Some(task_id)
    }

    pub fn running(&self) -> bool {
        self.handle.as_ref().is_some_and(|handle| !handle.is_finished())
    }

    /// Drains queued engine events for this frame.
    pub fn drain(&mut self) -> Vec<AgentTaskEvent> {
        let mut events = Vec::new();
        while let Ok(event) = self.rx.try_recv() {
            events.push(event);
        }
        events
    }

    /// Answers a pending approval by id.
    pub fn respond(&self, request_id: &str, action: ApprovalAction) -> bool {
        self.broker.respond(request_id, action)
    }

    /// How many approvals are waiting, from the broker's own count.
    pub fn pending_approvals(&self) -> usize {
        self.broker.pending_count()
    }

    /// Hands a message to the running turn; the loop takes it at its next step
    /// boundary and emits `UserMessagesInjected`.
    pub fn steer(&self, text: &str, display: Option<String>) -> bool {
        if !self.running() {
            return false;
        }
        let mut message = Message::user(text);
        if let Some(display) = display {
            // The transcript shows what was typed; the model sees the same.
            message.content = display;
        }
        self.inbox.lock().push(message);
        self.inbox.interrupt_thinking();
        true
    }

    /// Stops the running turn: cancel signal, hard abort, drop approvals.
    pub fn stop(&mut self) {
        self.cancel.abort();
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
        self.broker.cancel_all();
    }

    /// The current thinking level the running turn was started with.
    pub fn update_thinking(&self, level: &str) {
        self.inbox.update_settings(Some(level.to_owned()));
    }

    /// Runs one short future on the engine runtime and waits for it. Used by
    /// the panels that call a core tool directly (processes, the terminal).
    pub fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }

    /// Configured MCP servers with their status, for the `/mcp` summary.
    pub fn mcp_snapshots(&self) -> Vec<agente_core::mcp::client::ServerSnapshot> {
        self.mcp
            .as_ref()
            .map(|manager| manager.snapshots())
            .unwrap_or_default()
    }
}

/// True when the event came from the parent agent's own loop (not a child).
pub fn is_parent(source: &ApprovalSource) -> bool {
    matches!(source, ApprovalSource::Parent)
}

/// Maps an `AgentEvent` to a short status label for the activity strip.
pub fn event_label(event: &AgentEvent) -> Option<&'static str> {
    match event {
        AgentEvent::Thinking => Some("thinking"),
        AgentEvent::TextDelta(_) => Some("streaming"),
        AgentEvent::ToolCallStart { .. } => Some("running tool"),
        AgentEvent::ToolCallResult { .. } => Some("tool finished"),
        AgentEvent::CompactionStarted { .. } => Some("compacting"),
        AgentEvent::ContextCompacted { .. } => Some("compacted"),
        AgentEvent::Retry { .. } => Some("retrying"),
        AgentEvent::ApprovalRequested { .. } => Some("waiting for approval"),
        _ => None,
    }
}
