//! Pluggable coding-CLI drivers for the Agente runtime.
//!
//! External engines (ACP agents, Claude Code, Codex, and custom profiles)
//! implement [`AgentDriver`] and [`DriverSession`] so [`agente_runtime`] can
//! run, approve, steer, resume, and cancel them behind the exact same
//! [`RuntimeEvent`] stream used by the built-in `agente-core` engine.

pub mod acp;
pub mod claude;
pub mod codex;
pub mod config;
pub mod pi;
pub mod process;
pub mod registry;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agente_protocol::{
    ApprovalDecision, ApprovalDecisionKind, AttachmentKind, DriverCapabilities, DriverInfo,
    DriverKind, DriverStatus, InputResponse, InputResponseAction, Message, RuntimeEvent, SessionId,
    TurnId, TurnMode, TurnStatus,
};
use async_trait::async_trait;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

pub use config::{DriversConfig, ResolvedInstance};
pub use registry::DriverRegistry;

/// Instance ID reserved for Agente's built-in `agente-core` loop.
pub const BUILTIN_AGENTE_INSTANCE: &str = "agente";

/// Errors returned by driver registration, probing, and turn execution.
#[derive(Debug, Error)]
pub enum DriverError {
    #[error("driver instance '{0}' not found")]
    NotFound(String),
    #[error("driver instance '{0}' is disabled")]
    Disabled(String),
    #[error("driver instance '{0}' is unavailable: {1}")]
    Unavailable(String, String),
    #[error("invalid driver configuration: {0}")]
    InvalidConfig(String),
    #[error("failed to launch driver: {0}")]
    Spawn(String),
    #[error("driver protocol error: {0}")]
    Protocol(String),
    #[error("driver I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("driver turn cancelled")]
    Cancelled,
}

/// Authenticated Streamable HTTP MCP endpoint injected into a driver session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectedMcpServer {
    pub name: String,
    pub url: String,
    pub bearer_token: Option<String>,
}

/// Parameters supplied when opening or resuming an external driver session.
#[derive(Debug, Clone)]
pub struct DriverSessionOpen {
    pub session_id: SessionId,
    pub project_dir: String,
    pub external_session_id: Option<String>,
    pub mode: TurnMode,
    pub model: Option<String>,
    pub mcp_servers: Vec<InjectedMcpServer>,
    pub interactive: bool,
}

/// Parameters supplied to start one turn inside an open [`DriverSession`].
#[derive(Debug, Clone)]
pub struct DriverTurnRequest {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub prompt: Message,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub mode: TurnMode,
    pub cwd: String,
    pub mcp_servers: Vec<InjectedMcpServer>,
}

/// Normalized events emitted by an external [`DriverSession`] during a turn.
#[derive(Debug, Clone)]
pub enum DriverEvent {
    Runtime(RuntimeEvent),
    ExternalSessionBound(String),
    BackgroundWork(bool),
    TurnComplete {
        status: TurnStatus,
        assistant_text: String,
        tokens: u32,
        error: Option<String>,
    },
}

/// Shared request-id router bridging UI/daemon `approval.respond` and
/// `input.respond` calls to live external [`DriverSession`] waits.
type PendingApprovals = HashMap<String, (SessionId, oneshot::Sender<ApprovalDecision>)>;
type PendingInputs = HashMap<String, (SessionId, oneshot::Sender<InputResponse>)>;

#[derive(Clone, Default)]
pub struct ApprovalRouter {
    pending: Arc<Mutex<PendingApprovals>>,
    pending_inputs: Arc<Mutex<PendingInputs>>,
}

impl ApprovalRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        session_id: SessionId,
        request_id: impl Into<String>,
    ) -> oneshot::Receiver<ApprovalDecision> {
        let (tx, rx) = oneshot::channel();
        let mut guard = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(request_id.into(), (session_id, tx));
        rx
    }

    pub fn respond(&self, decision: ApprovalDecision) -> bool {
        let entry = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&decision.request_id);
        match entry {
            Some((_, sender)) => sender.send(decision).is_ok(),
            None => false,
        }
    }

    pub fn register_input(
        &self,
        session_id: SessionId,
        request_id: impl Into<String>,
    ) -> oneshot::Receiver<InputResponse> {
        let (tx, rx) = oneshot::channel();
        let mut guard = self
            .pending_inputs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(request_id.into(), (session_id, tx));
        rx
    }

    pub fn respond_input(&self, response: InputResponse) -> bool {
        let entry = self
            .pending_inputs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&response.request_id);
        match entry {
            Some((_, sender)) => sender.send(response).is_ok(),
            None => false,
        }
    }

    /// Resolve every pending approval and user-input request belonging to
    /// `session_id` as cancelled so a blocked child CLI unblocks immediately.
    pub fn cancel_session(&self, session_id: SessionId) {
        let drained: Vec<(String, oneshot::Sender<ApprovalDecision>)> = {
            let mut guard = self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let keys: Vec<String> = guard
                .iter()
                .filter(|(_, (sid, _))| *sid == session_id)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| guard.remove(&k).map(|(_, tx)| (k, tx)))
                .collect()
        };
        for (request_id, sender) in drained {
            let _ = sender.send(ApprovalDecision {
                request_id,
                decision: ApprovalDecisionKind::Cancel,
                option_id: None,
            });
        }

        let drained_inputs: Vec<(String, oneshot::Sender<InputResponse>)> = {
            let mut guard = self
                .pending_inputs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let keys: Vec<String> = guard
                .iter()
                .filter(|(_, (sid, _))| *sid == session_id)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| guard.remove(&k).map(|(_, tx)| (k, tx)))
                .collect()
        };
        for (request_id, sender) in drained_inputs {
            let _ = sender.send(InputResponse {
                request_id,
                action: InputResponseAction::Cancel,
                content: None,
            });
        }
    }

    pub fn remove(&self, request_id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(request_id);
    }

    pub fn remove_input(&self, request_id: &str) {
        self.pending_inputs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(request_id);
    }
}

/// Active connection/process handle for an external session.
#[async_trait]
pub trait DriverSession: Send + Sync {
    async fn start_turn(
        &self,
        request: DriverTurnRequest,
        sink: mpsc::Sender<DriverEvent>,
    ) -> Result<(), DriverError>;

    async fn steer(&self, message: Message) -> bool;

    async fn cancel(&self, turn_id: TurnId) -> bool;

    fn external_session_id(&self) -> Option<String>;

    fn has_pending_background_work(&self) -> bool {
        false
    }

    async fn close(&self);
}

/// Pluggable coding-CLI backend registered in [`DriverRegistry`].
#[async_trait]
pub trait AgentDriver: Send + Sync {
    fn instance_id(&self) -> &str;

    fn driver_kind(&self) -> DriverKind;

    fn descriptor(&self) -> DriverInfo;

    async fn probe(&self) -> DriverInfo;

    async fn open_session(
        &self,
        spec: DriverSessionOpen,
        approvals: ApprovalRouter,
    ) -> Result<Arc<dyn DriverSession>, DriverError>;
}

/// Static descriptor for the built-in `agente-core` engine.
pub fn builtin_agente_info() -> DriverInfo {
    DriverInfo {
        instance_id: BUILTIN_AGENTE_INSTANCE.to_string(),
        driver_kind: DriverKind::Agente,
        label: "Agente Core".to_string(),
        status: DriverStatus::Ready,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        binary_path: None,
        error: None,
        auth_hint: None,
        builtin: true,
        enabled: true,
        use_for: Some("Built-in Agente runtime with direct provider APIs, compaction, and subagents.".to_string()),
        capabilities: DriverCapabilities {
            models: true,
            thinking: true,
            modes: vec![TurnMode::Plan, TurnMode::Build, TurnMode::Auto],
            native_plan_cards: true,
            approvals: true,
            steer: true,
            resume: true,
            fork: true,
            compact: true,
            rewind_conversation: true,
            mcp_injection: true,
            session_import: true,
            attachments: vec![
                AttachmentKind::Image,
                AttachmentKind::Audio,
                AttachmentKind::Video,
                AttachmentKind::Pdf,
            ],
            usage: true,
            cost: true,
        },
        models: Vec::new(),
        config: None,
    }
}

/// Normalize a model choice so `"default"` or blank strings are omitted cleanly.
pub fn effective_model(model: Option<&str>) -> Option<&str> {
    model
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("default"))
}

/// Extract text prompt content along with simple file-path notes for attachments
/// when a driver only consumes plain text or accepts paths inline.
pub fn flatten_prompt_text(message: &Message) -> String {
    if message.attachments.is_empty() {
        return message.content.clone();
    }
    let mut text = message.content.clone();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for att in &message.attachments {
        text.push_str(&format!("\n[Attached {}: {}]", att.kind.label(), att.path));
    }
    text
}
