//! Stable, dependency-light contracts shared by every Agente client.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default)]
    pub call_type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartTurn {
    pub session_id: SessionId,
    #[serde(default)]
    pub conversation: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInput {
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecisionKind {
    ApproveOnce,
    ApproveAll,
    Deny,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecision {
    pub request_id: String,
    pub decision: ApprovalDecisionKind,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub cache_read_tokens: u32,
    pub cache_creation_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    ContextCompacted {
        summary: String,
        revision: u64,
    },
    Usage {
        usage: Usage,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnOutcome {
    pub turn_id: TurnId,
    pub session_id: SessionId,
    pub status: TurnStatus,
    pub revision: u64,
    pub tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub session_id: SessionId,
    pub revision: u64,
    pub conversation: Vec<Message>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildSnapshot {
    pub run_id: RunId,
    pub status: String,
    pub summary: Option<String>,
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
}
