//! Shared configuration and event-sending types for the agent channel.

use std::sync::mpsc::Sender;
use std::sync::Arc;

use crate::cancellation::AbortSignal;
use crate::catalog::ModelCatalog;
use crate::mcp::client::McpManager;
use crate::permissions::{ApprovalBroker, SharedPermissionEngine};
use crate::providers::ProviderRegistry;
use crate::subagent::{CustomSubagent, SubagentHost};
use crate::todo::TodoInput;
use crate::types::{Message, ToolCall};

use crate::agent::events::{AgentEvent, AgentTaskEvent};

/// One tool call that passed preparation: permission-checked, args parsed,
/// pre-execution state (file snapshot: cleaned path + content) captured.
pub(crate) struct PreparedToolCall {
    pub(crate) tool_call: ToolCall,
    pub(crate) args: serde_json::Value,
    pub(crate) file_before: Option<(String, Option<String>)>,
}

/// Result of one tool call, visible to the subagent host so it can build its
/// own outcomes for hosted tools (`task`, `task_output`, `kill_task`).
pub(crate) struct ToolCallOutcome {
    pub attachments: Vec<agente_protocol::Attachment>,
    pub(crate) tool_call_id: String,
    pub(crate) tool_name: String,
    pub(crate) content: String,
    pub(crate) is_error: bool,
    pub(crate) path_changed: Option<String>,
    pub(crate) changed_path: Option<String>,
    pub(crate) file_before: Option<String>,
    pub(crate) file_after: Option<String>,
    pub(crate) todos: Option<Vec<TodoInput>>,
}

impl ToolCallOutcome {
    /// An errored outcome for a call that was not executed (permission
    /// denial, missing args, skipped by an early batch break).
    pub(crate) fn error(
        tool_call_id: String,
        tool_name: impl Into<String>,
        message: impl std::fmt::Display,
    ) -> Self {
        Self {
            tool_call_id,
            tool_name: tool_name.into(),
            content: format!("Error: {message}"),
            is_error: true,
            path_changed: None,
            changed_path: None,
            file_before: None,
            file_after: None,
            todos: None,
            attachments: Vec::new(),
        }
    }
}

/// Fully-resolved configuration for one agent loop run. Shared by the parent
/// (`spawn_chat_task`) and every subagent (`SubagentHost`).
///
/// The loop writes plain `AgentEvent`s to `sender`/`task_id` and emits its own
/// terminal events (`Done`/`Cancelled`). Children run against a private channel
/// that a forwarder re-emits as `Subagent*` events, so the loop itself never
/// needs to know whether it is the parent or a child.
/// Messages the user sent while a turn runs ("send now"). The loop takes
/// them at the next step boundary — after a tool round, or instead of
/// finishing — so the model sees them without the turn being cancelled.
pub type UserInbox = Arc<UserInboxState>;

/// Shared input queue and a request-local wakeup. Interrupting a completion
/// never aborts the turn, its tools, or its children.
#[derive(Debug, Default)]
pub struct UserInboxState {
    messages: parking_lot::Mutex<Vec<crate::types::Message>>,
    interrupt: tokio::sync::Notify,
    closed: std::sync::atomic::AtomicBool,
    thinking: parking_lot::Mutex<Option<String>>,
    settings_changed: std::sync::atomic::AtomicBool,
}

impl UserInboxState {
    pub fn lock(&self) -> parking_lot::MutexGuard<'_, Vec<crate::types::Message>> {
        self.messages.lock()
    }

    /// Seal the inbox while its owner commits the terminal conversation.
    pub fn close(&self) -> Vec<Message> {
        self.closed
            .store(true, std::sync::atomic::Ordering::Release);
        std::mem::take(&mut *self.messages.lock())
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn update_settings(&self, thinking: Option<String>) {
        if let Some(thinking) = thinking {
            *self.thinking.lock() = Some(thinking);
        }
        self.settings_changed
            .store(true, std::sync::atomic::Ordering::Release);
        self.interrupt_thinking();
    }

    pub(crate) fn take_thinking(&self) -> Option<String> {
        self.settings_changed
            .store(false, std::sync::atomic::Ordering::Release);
        self.thinking.lock().take()
    }

    pub(crate) fn has_settings_update(&self) -> bool {
        self.settings_changed
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn interrupt_thinking(&self) {
        self.interrupt.notify_one();
    }

    pub(crate) async fn wait_interrupt(&self) {
        self.interrupt.notified().await;
    }
}

/// What a host adds to, or limits in, one turn's tools: a bot's own tools,
/// the toolsets it may use and its commands' environment. Subagents inherit
/// the limits (`only`, `shell_env`) but never the extra tools.
#[derive(Default)]
pub struct TurnTools {
    /// Tools only this turn gets (a bot's memory and handoff tools). Always kept.
    pub extra: Vec<Box<dyn crate::tools::Tool>>,
    /// When set, only these built-in tools are kept; the entry `"mcp"` also
    /// lets MCP tools in. `None` keeps every tool.
    pub only: Option<Vec<String>>,
    /// The environment of the commands this turn's tools start (and its
    /// subagents'). Bot turns run `Clean`: none of the host's keys.
    pub shell_env: crate::tools::ShellEnv,
}

pub(crate) struct AgentRunConfig {
    pub session_id: uuid::Uuid,
    pub task_id: u64,
    pub sender: Sender<AgentTaskEvent>,
    pub messages: Vec<Message>,
    pub provider_id: String,
    pub model: String,
    pub thinking_level: String,
    pub project_dir: String,
    /// Iteration budget for the loop. `None` means unbounded:
    /// the loop runs until the model stops calling tools and only the
    /// wall-clock watchdog, cancel signal, or loop guard can stop it.
    /// Subagent children default to `None`; an explicit `Some(n)` still caps.
    /// The parent turn always passes `Some` (config default 500).
    pub max_iterations: Option<u32>,
    pub registry: Arc<ProviderRegistry>,
    pub catalog: Option<Arc<ModelCatalog>>,
    pub permission_engine: SharedPermissionEngine,
    pub cancel_signal: AbortSignal,
    pub approval_broker: ApprovalBroker,
    pub mcp_manager: Option<Arc<McpManager>>,
    pub subagent_host: Option<SubagentHost>,
    /// Custom `.agente/agents/*.md` roster. Parents load it once per turn and
    /// pass it down so a child's worktree checkout does not re-scan the disk.
    pub custom_agents: Vec<CustomSubagent>,
    pub tool_policy: Option<crate::subagent::ToolPolicy>,
    pub is_subagent: bool,
    pub depth: u32,
    /// Identical-tool-call repeats before the loop injects a nudge
    /// ("action stationarity", see `loop_detection`).
    pub loop_nudge_after: u32,
    /// Identical-tool-call repeats before the loop stops the turn.
    pub loop_stop_after: u32,
    /// Compact with an LLM summary instead of trimming (user setting).
    pub smart_compaction: bool,
    pub compaction_model: Option<crate::config::SubagentModel>,
    /// Mid-turn user messages (parent turns only).
    pub user_inbox: Option<UserInbox>,
    /// Tools the host adds for this turn only (a bot's memory and handoff
    /// tools). Children never inherit them.
    pub extra_tools: Vec<Box<dyn crate::tools::Tool>>,
    /// See [`TurnTools::only`]. Children inherit it.
    pub only_tools: Option<Vec<String>>,
    /// See [`TurnTools::shell_env`]. Children inherit it.
    pub shell_env: crate::tools::ShellEnv,
}

/// Tag an event with its task id and swallow send failures (the TUI may be
/// gone while a final event is still emitted).
pub(crate) fn send_event(sender: &Sender<AgentTaskEvent>, task_id: u64, event: AgentEvent) {
    let _ = sender.send(AgentTaskEvent { task_id, event });
}

/// Forward the provider's per-turn usage to the TUI. Subagent turns do not
/// report their own usage — the parent's usage accounting is the source of
/// truth for the status bar.
#[allow(clippy::too_many_arguments)]
pub(crate) fn send_turn_usage(
    sender: &Sender<AgentTaskEvent>,
    task_id: u64,
    is_subagent: bool,
    last_prompt_tokens: &u32,
    last_completion_tokens: &u32,
    total_cache_read_tokens: &u32,
    total_cache_creation_tokens: &u32,
    last_context_tokens: &u32,
) {
    if is_subagent {
        return;
    }
    send_event(
        sender,
        task_id,
        AgentEvent::TurnUsage {
            prompt_tokens: *last_prompt_tokens,
            completion_tokens: *last_completion_tokens,
            cache_read_tokens: *total_cache_read_tokens,
            cache_creation_tokens: *total_cache_creation_tokens,
            context_tokens: *last_context_tokens,
        },
    );
}
