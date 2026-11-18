use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use agente_protocol::{FunctionCall, Message, ProviderContinuation, Role, ToolCall};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub steps: Vec<PlanStep>,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub id: String,
    pub description: String,
    pub status: StepStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentMode {
    Plan,
    Build,
}

impl std::fmt::Display for AgentMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentMode::Plan => write!(f, "Plan"),
            AgentMode::Build => write!(f, "Build"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentState {
    Idle,
    Planning,
    Executing,
    WaitingApproval,
    StreamingResponse,
    Error(String),
}

impl std::fmt::Display for AgentState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentState::Idle => write!(f, "idle"),
            AgentState::Planning => write!(f, "planning"),
            AgentState::Executing => write!(f, "executing"),
            AgentState::WaitingApproval => write!(f, "waiting"),
            AgentState::StreamingResponse => write!(f, "thinking"),
            AgentState::Error(e) => write!(f, "error: {e}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FileChangeStatus {
    Created,
    Modified,
    Deleted,
}

impl std::fmt::Display for FileChangeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileChangeStatus::Created => write!(f, "+"),
            FileChangeStatus::Modified => write!(f, "~"),
            FileChangeStatus::Deleted => write!(f, "-"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModifiedFile {
    pub path: String,
    pub additions: usize,
    pub deletions: usize,
    pub status: FileChangeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatEntry {
    pub id: Uuid,
    pub role: Role,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<String>,
    pub is_error: bool,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub response_duration: Option<f64>,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub interrupted: bool,
    /// Model reasoning/thinking for this turn (UI only; collapsed by default).
    #[serde(default)]
    pub reasoning: Option<String>,
    /// When set, this entry renders as a subagent card (`subagent_id` is the
    /// child's task id). Kept on the entry so subagent cards survive session
    /// reloads without a new enum variant.
    #[serde(default)]
    pub subagent_id: Option<String>,
    /// Subagent type badge shown on the card (explore / plan / general-purpose).
    #[serde(default)]
    pub subagent_type: Option<String>,
    /// Per-edit `(+additions, -deletions)` for file-mutating tool results,
    /// filled in by the TUI when the matching `FileChange` event arrives so
    /// the collapsed card header can show a `+N/-M` badge.
    #[serde(default)]
    pub diff_stats: Option<(usize, usize)>,
    /// Media sent with a user message (shown under the bubble text).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<agente_protocol::Attachment>,
}

fn default_mode() -> String {
    "Plan".to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalAction {
    ApproveOnce,
    ApproveAll,
    Deny,
    Cancel,
}

#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    /// Unique id used to route the user's response back to the waiting agent
    /// (parent or subagent) through the shared [`ApprovalBroker`].
    pub request_id: String,
    pub tool_name: String,
    pub tool_args: String,
    pub description: String,
    pub is_dangerous: bool,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: Uuid,
    pub project_dir: String,
    pub messages: Vec<Message>,
    pub current_plan: Option<Plan>,
    pub iteration_count: u32,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_active: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl std::fmt::Display for TodoStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TodoStatus::Pending => write!(f, "pending"),
            TodoStatus::InProgress => write!(f, "in_progress"),
            TodoStatus::Completed => write!(f, "completed"),
            TodoStatus::Cancelled => write!(f, "cancelled"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TodoPriority {
    High,
    Medium,
    Low,
}

impl std::fmt::Display for TodoPriority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TodoPriority::High => write!(f, "high"),
            TodoPriority::Medium => write!(f, "medium"),
            TodoPriority::Low => write!(f, "low"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    pub id: String,
    pub content: String,
    pub status: TodoStatus,
    pub priority: TodoPriority,
}

impl Todo {
    pub fn new(content: String, priority: TodoPriority) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            content,
            status: TodoStatus::Pending,
            priority,
        }
    }
}

/// What a chat click region refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ClickKind {
    #[default]
    Message,
    Thinking,
    Tool,
    /// Header row of a folded run of consecutive tool cards (click expands the
    /// whole group; members render as a dense stack beneath it).
    ToolGroup,
    /// Action button to open an asset in system viewer.
    OpenAsset,
    /// Subagent card (click opens the live detail modal).
    Subagent,
    /// A message the user sent (click opens revert / fork / copy).
    Prompt,
    /// A tool still running (click opens its live output).
    LiveTool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClickRegion {
    pub entry_id: Uuid,
    /// Screen-row start (inclusive), already scroll-corrected for the visible viewport.
    pub y_start: u16,
    /// Screen-row end (inclusive).
    pub y_end: u16,
    pub is_reasoning: bool,
    #[serde(default)]
    pub kind: ClickKind,
    /// Tool name of the card this region belongs to, so click/Enter can pick
    /// the right default fold for tools like `shell`/`read_file`.
    #[serde(default)]
    pub tool_name: Option<String>,
    /// User message is currently shown truncated (click toggles expand).
    #[serde(default)]
    pub user_truncated: bool,
    /// Content-line index in the full chat document (for selection mapping).
    #[serde(default)]
    pub content_start: usize,
    #[serde(default)]
    pub content_end: usize,
    /// Provider call id of a running tool (`ClickKind::LiveTool`).
    #[serde(default)]
    pub live_call: Option<String>,
    /// Path to the media file or asset to open on click.
    #[serde(default)]
    pub asset_path: Option<String>,
}
