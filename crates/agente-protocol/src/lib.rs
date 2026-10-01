//! Stable, dependency-light contracts shared by every Agente client.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 2: turn options (profile, mode, origin, project), steering without
/// cancelling, per-call spend, compaction and generation progress events.
pub const PROTOCOL_VERSION: u16 = 2;

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            pub const fn from_uuid(value: Uuid) -> Self {
                Self(value)
            }

            pub const fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl std::str::FromStr for $name {
            type Err = uuid::Error;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(value).map(Self)
            }
        }
    };
}

id_type!(SessionId);
id_type!(TurnId);
id_type!(RunId);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default)]
    pub call_type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Message {
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    /// Ordered provider-native blocks needed for lossless tool/reasoning replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<ProviderContinuation>,
    /// Media sent with a user message (images, audio, video, PDFs). Each is
    /// a stored copy on disk; providers encode it at request time, so saved
    /// sessions carry references, not bytes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

/// What kind of media an attachment is, which decides how each provider
/// format carries it and which models accept it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    Audio,
    Video,
    Pdf,
}

impl AttachmentKind {
    /// models.dev / OpenRouter modality name.
    pub fn modality(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
            Self::Pdf => "pdf",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
            Self::Pdf => "PDF",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Attachment {
    pub kind: AttachmentKind,
    /// MIME type (`image/png`, `audio/mpeg`, `video/mp4`, `application/pdf`).
    pub mime: String,
    /// Original file name, for display.
    pub name: String,
    /// Absolute path of the stored copy.
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProviderContinuation {
    pub provider_id: String,
    pub model_id: String,
    pub blocks: Vec<serde_json::Value>,
}

impl ProviderContinuation {
    pub fn matches(&self, provider: &str, model: &str) -> bool {
        self.provider_id == provider && self.model_id == model
    }
}

impl Message {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }
    }
}

/// How much a turn's origin is trusted. A turn can never do more than its
/// least-trusted origin allows; handoffs between bots keep the lowest level.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    /// Anyone in a public room: answers only, no tools that change anything.
    Public,
    /// An allow-listed person: chat, search and artifacts, no shell or files.
    Trusted,
    /// The person who runs this Agente.
    #[default]
    Owner,
}

/// Where a turn came from: a client (tui, desktop, web) or a bot channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Origin {
    pub channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(default)]
    pub trust: Trust,
}

impl Default for Origin {
    fn default() -> Self {
        Self {
            channel: "local".to_string(),
            sender: None,
            trust: Trust::Owner,
        }
    }
}

/// Plan (read-only), build (can change files and run commands, asking for
/// risky ones) or auto (build with every call approved).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnMode {
    Plan,
    Build,
    Auto,
}

/// Home turns expose only client-owned tools, never the coding tool registry.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct HomeTurnPolicy {
    pub max_iterations: u32,
    pub max_tool_calls: u32,
    pub max_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ClientToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    #[serde(default)]
    pub mutating: bool,
    #[serde(default)]
    pub sequential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RegisterClientTools {
    pub session_id: SessionId,
    pub tools: Vec<ClientToolDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ClientToolCall {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub request_id: String,
    pub call_id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ClientToolResult {
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub request_id: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct StartTurn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<HomeTurnPolicy>,
    pub session_id: SessionId,
    #[serde(default)]
    pub conversation: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    /// Profile (a bot or a client preset) whose prompt, tools and model apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Mode for this turn; the session keeps it until another turn sets one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<TurnMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    /// Project folder for this session, when it differs from the runtime's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    /// The new message (attachments included) to add to the session's saved
    /// conversation, so a client need not send the whole conversation back.
    /// Ignored when `conversation` is given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Message>,
    /// Replaces the runtime's system prompt for a session that has none yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UserInput {
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecisionKind {
    ApproveOnce,
    ApproveAll,
    Deny,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalDecision {
    pub request_id: String,
    pub decision: ApprovalDecisionKind,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub cache_read_tokens: u32,
    pub cache_creation_tokens: u32,
    /// Full prompt size of the last request (uncached + cache read + cache
    /// write): the context in use. 0 when unreported.
    #[serde(default)]
    pub context_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEvent {
    TurnStarted,
    Thinking,
    AssistantDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    AssistantMessage {
        text: String,
    },
    ToolProposed {
        id: String,
        name: String,
        arguments: String,
    },
    ToolProgress {
        id: String,
        chunk: String,
    },
    ToolHeartbeat {
        id: String,
    },
    ToolResult {
        id: String,
        name: String,
        content: String,
        is_error: bool,
    },
    ApprovalRequested {
        request_id: String,
        source: String,
        tool_name: String,
        tool_args: String,
        description: String,
        is_dangerous: bool,
        file_path: Option<String>,
        /// The file as it is and as the edit would leave it, for a diff.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        old_content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        new_content: Option<String>,
        /// The subagent asking, when it is not the turn's own loop.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        child_run_id: Option<RunId>,
    },
    FileChanged {
        path: String,
        summary: String,
        before: Option<String>,
        after: Option<String>,
    },
    TodoChanged {
        todos: serde_json::Value,
    },
    ChildStarted {
        run_id: RunId,
        kind: String,
        description: String,
    },
    ChildDelta {
        run_id: RunId,
        text: String,
    },
    ChildTool {
        run_id: RunId,
        call_id: String,
        name: String,
        content: String,
        finished: bool,
        is_error: bool,
    },
    ChildFinished {
        run_id: RunId,
        summary: String,
        is_error: bool,
    },
    /// A background subagent ended; the parent should be told (it joins the
    /// conversation now, or after the running turn).
    ChildCompletedNotice {
        run_id: RunId,
        kind: String,
        status: String,
        summary: String,
    },
    ContextCompacted {
        summary: String,
        revision: u64,
        /// Estimated context before and after.
        #[serde(default)]
        tokens_before: u32,
        #[serde(default)]
        tokens_after: u32,
        /// Summarized by the model rather than trimmed.
        #[serde(default)]
        smart: bool,
    },
    Usage {
        usage: Usage,
    },
    /// One model call finished (the envelope's `parent_run_id` names the
    /// subagent that made it). Summing these gives the session's real spend.
    CallUsage {
        usage: Usage,
        /// `None` when no price is known for the model.
        cost_usd: Option<f64>,
        /// The cost is a catalog-price estimate, not the provider's charge.
        cost_estimated: bool,
    },
    /// Messages sent with `steer` joined the running turn.
    UserMessagesInjected {
        messages: Vec<String>,
    },
    CompactionStarted {
        /// Summarized by the model rather than trimmed.
        smart: bool,
    },
    /// Output streamed so far in the current model call, for liveness.
    GenerationProgress {
        output_bytes: u64,
        tool_name: Option<String>,
    },
    Retry {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
    },
    SteeringQueued,
    Diagnostic {
        message: String,
    },
    TurnFinished {
        revision: u64,
    },
    TurnCancelled {
        revision: u64,
        partial_text: String,
    },
    TurnFailed {
        message: String,
    },
}

impl RuntimeEvent {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::TurnFinished { .. } | Self::TurnCancelled { .. } | Self::TurnFailed { .. }
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeEventEnvelope {
    pub protocol_version: u16,
    pub sequence: u64,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<RunId>,
    pub timestamp: DateTime<Utc>,
    pub event: RuntimeEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TurnOutcome {
    pub turn_id: TurnId,
    pub session_id: SessionId,
    pub status: TurnStatus,
    pub revision: u64,
    pub tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SessionSnapshot {
    pub session_id: SessionId,
    pub revision: u64,
    pub conversation: Vec<Message>,
}

/// What a session list shows: one per saved session, whatever client made it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionInfo {
    pub session_id: SessionId,
    /// Short generated label; empty until one is made.
    #[serde(default)]
    pub title: String,
    /// First user message, trimmed: the fallback label.
    #[serde(default)]
    pub first_prompt: String,
    pub project_dir: String,
    pub created_at: DateTime<Utc>,
    pub last_active: DateTime<Utc>,
    #[serde(default)]
    pub message_count: usize,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub thinking_level: String,
    /// The bot or client preset the session belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ChildSnapshot {
    pub run_id: RunId,
    pub status: String,
    pub summary: Option<String>,
}

/// JSON Schema of every type a client sends or receives, as one document
/// (`definitions` keyed by type name). Desktop turns it into TypeScript types
/// (`apps/desktop/shared/agente-protocol.schema.json` → `.gen.ts`); a test
/// keeps the committed copy in step with this crate.
pub fn protocol_schema() -> serde_json::Value {
    let mut generator = schemars::gen::SchemaSettings::draft07().into_generator();
    generator.subschema_for::<StartTurn>();
    generator.subschema_for::<RegisterClientTools>();
    generator.subschema_for::<ClientToolCall>();
    generator.subschema_for::<ClientToolResult>();
    generator.subschema_for::<UserInput>();
    generator.subschema_for::<ApprovalDecision>();
    generator.subschema_for::<RuntimeEventEnvelope>();
    generator.subschema_for::<TurnOutcome>();
    generator.subschema_for::<SessionSnapshot>();
    generator.subschema_for::<ChildSnapshot>();
    generator.subschema_for::<SessionInfo>();
    let definitions = generator.take_definitions();
    serde_json::json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "AgenteProtocol",
        "description": format!("Agente runtime protocol v{PROTOCOL_VERSION}"),
        "definitions": definitions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_envelope_round_trips() {
        let envelope = RuntimeEventEnvelope {
            protocol_version: PROTOCOL_VERSION,
            sequence: 7,
            session_id: SessionId::new(),
            turn_id: TurnId::new(),
            parent_run_id: None,
            timestamp: Utc::now(),
            event: RuntimeEvent::AssistantDelta { text: "hi".into() },
        };
        let encoded = serde_json::to_string(&envelope).unwrap();
        let decoded: RuntimeEventEnvelope = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.sequence, 7);
        assert_eq!(decoded.protocol_version, PROTOCOL_VERSION);
    }

    /// The schema Desktop generates its types from must match this crate.
    /// Refresh it with `UPDATE_PROTOCOL_SCHEMA=1 cargo test -p agente-protocol`.
    #[test]
    fn committed_schema_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/shared/agente-protocol.schema.json");
        let current = serde_json::to_string_pretty(&protocol_schema()).unwrap() + "\n";
        if std::env::var_os("UPDATE_PROTOCOL_SCHEMA").is_some() {
            std::fs::write(&path, &current).unwrap();
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == current,
            "{} is stale: run UPDATE_PROTOCOL_SCHEMA=1 cargo test -p agente-protocol, \
             then npm run gen:protocol in apps/desktop",
            path.display()
        );
    }
}
