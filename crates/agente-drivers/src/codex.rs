//! Codex CLI driver speaking persistent `codex app-server` JSON-RPC 2.0.
//!
//! Uses a 128 MiB bounded line limit to handle large thread resumes safely,
//! maps `TurnMode` to native `approvalPolicy` and `sandbox` policies, routes
//! server-initiated command and file-change approvals via [`ApprovalRouter`],
//! and supports mid-turn steering (`turn/steer`) and interruption (`turn/interrupt`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use agente_protocol::{
    rpc, ApprovalDecisionKind, ApprovalOption, DriverCapabilities, DriverInfo, DriverKind,
    DriverModel, DriverStatus, Message, RuntimeEvent, SessionId, TurnId, TurnMode, TurnStatus,
    Usage,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use uuid::Uuid;

use crate::config::ResolvedInstance;
use crate::process::{
    canonical_cwd, passive_probe, resolve_executable, JsonRpcHandler, JsonRpcTransport,
    NoopJsonRpcHandler, SpawnedStdio,
};
use crate::{
    effective_model, flatten_prompt_text, AgentDriver, ApprovalRouter, DriverError, DriverEvent,
    DriverSession, DriverSessionOpen, DriverTurnRequest, InjectedMcpServer,
};

const CODEX_MAX_LINE_BYTES: usize = 128 * 1024 * 1024;
const CODEX_AUTH_HINT: &str = "Run `codex login` in your terminal to sign in.";
const CODEX_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Driver backing the `codex` CLI (`codex app-server`).
pub struct CodexDriver {
    instance: ResolvedInstance,
}

impl CodexDriver {
    pub fn new(instance: ResolvedInstance) -> Self {
        Self { instance }
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            models: true,
            thinking: true,
            modes: vec![TurnMode::Plan, TurnMode::Build, TurnMode::Auto],
            native_plan_cards: false,
            approvals: true,
            steer: true,
            resume: true,
            fork: false,
            compact: false,
            rewind_conversation: false,
            mcp_injection: true,
            session_import: false,
            attachments: Vec::new(),
            usage: true,
            cost: false,
        }
    }
}

#[async_trait]
impl AgentDriver for CodexDriver {
    fn instance_id(&self) -> &str {
        &self.instance.instance_id
    }

    fn driver_kind(&self) -> DriverKind {
        DriverKind::Codex
    }

    fn descriptor(&self) -> DriverInfo {
        let program = self.instance.command.first().map(String::as_str).unwrap_or("");
        let resolved = resolve_executable(program);
        let status = if !self.instance.enabled {
            DriverStatus::Disabled
        } else if resolved.is_some() {
            DriverStatus::Ready
        } else {
            DriverStatus::Missing
        };
        DriverInfo {
            instance_id: self.instance.instance_id.clone(),
            driver_kind: DriverKind::Codex,
            label: self.instance.label.clone(),
            status,
            version: None,
            binary_path: resolved.map(|p| p.to_string_lossy().into_owned()),
            error: None,
            auth_hint: None,
            builtin: self.instance.builtin,
            enabled: self.instance.enabled,
            use_for: self.instance.use_for.clone(),
            capabilities: self.capabilities(),
            models: self.instance.models.clone(),
            config: None,
        }
    }

    async fn probe(&self) -> DriverInfo {
        let mut info = self.descriptor();
        if !self.instance.enabled {
            return info;
        }
        let outcome = passive_probe(
            &self.instance.command,
            &["--version"],
            &self.instance.env,
            &self.instance.strip_env,
        )
        .await;
        info.binary_path = outcome.binary_path;
        info.version = outcome.version;
        if info.binary_path.is_none() {
            info.status = DriverStatus::Missing;
            info.error = outcome.error;
            return info;
        }
        if let Some(err) = outcome.error {
            info.status = DriverStatus::Error;
            info.error = Some(err);
            return info;
        }

        info.status = DriverStatus::Ready;
        let live = probe_codex_live(&self.instance).await;
        if live.needs_auth {
            info.status = DriverStatus::NeedsAuth;
            info.auth_hint = Some(CODEX_AUTH_HINT.to_string());
            info.error = live.error;
        } else if self.instance.models.is_empty() && !live.models.is_empty() {
            info.models = live.models;
        }
        info
    }

    async fn open_session(
        &self,
        spec: DriverSessionOpen,
        approvals: ApprovalRouter,
    ) -> Result<Arc<dyn DriverSession>, DriverError> {
        if !self.instance.enabled {
            return Err(DriverError::Disabled(self.instance.instance_id.clone()));
        }
        let mut extra_args = Vec::new();
        if !self.instance.command.iter().any(|arg| arg == "app-server") {
            extra_args.push("app-server".to_string());
        }
        let mut spawn_env = self.instance.env.clone();
        append_codex_mcp_args(&spec.mcp_servers, &mut extra_args, &mut spawn_env);
        let (spawned, stdout, stdin) = SpawnedStdio::spawn(
            &self.instance.command,
            &extra_args,
            &spec.project_dir,
            &spawn_env,
            &self.instance.strip_env,
        )?;
        let session =
            CodexSession::connect_io(stdout, stdin, Some(spawned), spec, approvals).await?;
        Ok(Arc::new(session))
    }
}

fn mcp_token_env_name(server_name: &str) -> String {
    let sanitized: String = server_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("AGENTE_MCP_TOKEN_{sanitized}")
}

fn append_codex_mcp_args(
    servers: &[InjectedMcpServer],
    extra_args: &mut Vec<String>,
    spawn_env: &mut BTreeMap<String, String>,
) {
    for srv in servers {
        extra_args.push("-c".to_string());
        extra_args.push(format!("mcp_servers.{}.url={:?}", srv.name, srv.url));
        if let Some(token) = &srv.bearer_token {
            let env_key = mcp_token_env_name(&srv.name);
            spawn_env.insert(env_key.clone(), token.clone());
            extra_args.push("-c".to_string());
            extra_args.push(format!(
                "mcp_servers.{}.bearer_token_env_var={:?}",
                srv.name, env_key
            ));
        }
    }
}

struct ActiveCodexTurn {
    sink: mpsc::Sender<DriverEvent>,
    done_tx: Option<oneshot::Sender<TurnOutcome>>,
    native_turn_id: Option<String>,
    assistant_text: String,
    streamed_items: HashSet<String>,
    tool_names: HashMap<String, String>,
    cancelled: bool,
}

struct TurnOutcome {
    status: TurnStatus,
    assistant_text: String,
    tokens: u32,
    error: Option<String>,
}

struct CodexCore {
    session_id: SessionId,
    approvals: ApprovalRouter,
    thread_id: Mutex<Option<String>>,
    active_turn: Mutex<Option<ActiveCodexTurn>>,
    transport: Mutex<Option<Weak<JsonRpcTransport>>>,
    closed_reason: Mutex<Option<String>>,
}

impl CodexCore {
    fn transport(&self) -> Option<Arc<JsonRpcTransport>> {
        self.transport
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .and_then(Weak::upgrade)
    }

    fn emit(&self, event: DriverEvent) {
        let guard = self.active_turn.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(turn) = guard.as_ref() {
            let _ = turn.sink.try_send(event);
        }
    }
}

struct CodexHandler {
    core: Arc<CodexCore>,
}

impl JsonRpcHandler for CodexHandler {
    fn on_notification(&self, method: String, params: Value) {
        match method.as_str() {
            "turn/started" => {
                if let Some(tid) = params.pointer("/turn/id").and_then(Value::as_str) {
                    let mut guard = self
                        .core
                        .active_turn
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    if let Some(turn) = guard.as_mut() {
                        turn.native_turn_id = Some(tid.to_string());
                    }
                }
            }
            "item/agentMessage/delta" => {
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if delta.is_empty() {
                    return;
                }
                let item_id = params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let mut guard = self
                    .core
                    .active_turn
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if let Some(turn) = guard.as_mut() {
                    if let Some(id) = item_id {
                        turn.streamed_items.insert(id);
                    }
                    turn.assistant_text.push_str(&delta);
                    let _ = turn
                        .sink
                        .try_send(DriverEvent::Runtime(RuntimeEvent::AssistantDelta {
                            text: delta,
                        }));
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        self.core
                            .emit(DriverEvent::Runtime(RuntimeEvent::ReasoningDelta {
                                text: delta.to_string(),
                            }));
                    }
                }
            }
            "item/commandExecution/outputDelta" => {
                let id = params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .unwrap_or("cmd")
                    .to_string();
                let chunk = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !chunk.is_empty() {
                    self.core
                        .emit(DriverEvent::Runtime(RuntimeEvent::ToolProgress {
                            id,
                            chunk,
                        }));
                }
            }
            "item/started" => {
                if let Some(item) = params.get("item") {
                    handle_codex_item_started(&self.core, item);
                }
            }
            "item/completed" => {
                if let Some(item) = params.get("item") {
                    handle_codex_item_completed(&self.core, item);
                }
            }
            "turn/plan/updated" => {
                if let Some(plan) = params.get("plan").and_then(Value::as_array) {
                    let todos: Vec<Value> = plan
                        .iter()
                        .map(|entry| {
                            let content = entry
                                .get("step")
                                .or_else(|| entry.get("content"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let status = entry
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("pending");
                            json!({ "content": content, "status": status })
                        })
                        .collect();
                    self.core
                        .emit(DriverEvent::Runtime(RuntimeEvent::TodoChanged {
                            todos: Value::Array(todos),
                        }));
                }
            }
            "thread/tokenUsage/updated" => {
                if let Some(usage) = extract_codex_usage(&params) {
                    self.core
                        .emit(DriverEvent::Runtime(RuntimeEvent::Usage { usage }));
                }
            }
            "turn/completed" => {
                let turn_obj = params.get("turn");
                let raw_status = turn_obj
                    .and_then(|t| t.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let error_msg = turn_obj
                    .and_then(|t| t.get("error"))
                    .filter(|e| !e.is_null())
                    .and_then(|e| {
                        e.get("message")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .or_else(|| Some(e.to_string()))
                    });
                let total_tokens = extract_codex_usage(&params)
                    .map(|u| u.context_tokens.saturating_add(u.completion_tokens))
                    .unwrap_or(0);

                let mut guard = self
                    .core
                    .active_turn
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if let Some(mut active) = guard.take() {
                    if let Some(msg) = &error_msg {
                        if looks_like_usage_limit(msg) {
                            let _ = active.sink.try_send(DriverEvent::Runtime(
                                RuntimeEvent::UsageLimitReached {
                                    message: msg.clone(),
                                    reset_at: None,
                                },
                            ));
                        }
                    }
                    let status = if active.cancelled || raw_status == "interrupted" {
                        TurnStatus::Cancelled
                    } else if raw_status == "failed" || error_msg.is_some() {
                        TurnStatus::Failed
                    } else {
                        TurnStatus::Completed
                    };
                    if let Some(tx) = active.done_tx.take() {
                        let _ = tx.send(TurnOutcome {
                            status,
                            assistant_text: active.assistant_text,
                            tokens: total_tokens,
                            error: error_msg,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    fn on_request(&self, id: Value, method: String, params: Value) {
        let core = Arc::clone(&self.core);
        tokio::spawn(async move {
            let Some(transport) = core.transport() else {
                return;
            };
            match method.as_str() {
                "item/commandExecution/requestApproval" => {
                    handle_codex_approval(&core, &transport, id, "shell", &params).await;
                }
                "item/fileChange/requestApproval" => {
                    handle_codex_approval(&core, &transport, id, "edit_file", &params).await;
                }
                other => {
                    let _ = transport.reply_error(
                        id,
                        rpc::METHOD_NOT_FOUND,
                        &format!("unsupported Codex client request: {other}"),
                    );
                }
            }
        });
    }

    fn on_closed(&self, reason: Option<String>) {
        *self
            .core
            .closed_reason
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = reason.clone();
        self.core.approvals.cancel_session(self.core.session_id);
        let mut guard = self
            .core
            .active_turn
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(mut active) = guard.take() {
            if let Some(tx) = active.done_tx.take() {
                let status = if active.cancelled {
                    TurnStatus::Cancelled
                } else {
                    TurnStatus::Failed
                };
                let _ = tx.send(TurnOutcome {
                    status,
                    assistant_text: active.assistant_text,
                    tokens: 0,
                    error: if active.cancelled {
                        None
                    } else {
                        Some(reason.unwrap_or_else(|| "Codex app-server closed unexpectedly".into()))
                    },
                });
            }
        }
    }
}

fn handle_codex_item_started(core: &CodexCore, item: &Value) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("item")
        .to_string();
    match item_type {
        "commandExecution" => {
            let command = item
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                turn.tool_names.insert(id.clone(), "shell".to_string());
                let _ = turn
                    .sink
                    .try_send(DriverEvent::Runtime(RuntimeEvent::ToolProposed {
                        id,
                        name: "shell".to_string(),
                        arguments: json!({ "command": command }).to_string(),
                    }));
            }
        }
        "fileChange" => {
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                turn.tool_names.insert(id.clone(), "edit_file".to_string());
                let _ = turn
                    .sink
                    .try_send(DriverEvent::Runtime(RuntimeEvent::ToolProposed {
                        id,
                        name: "edit_file".to_string(),
                        arguments: item
                            .get("changes")
                            .map(Value::to_string)
                            .unwrap_or_else(|| "{}".to_string()),
                    }));
            }
        }
        "mcpToolCall" => {
            let name = item
                .get("tool")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("mcp_tool")
                .to_string();
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                turn.tool_names.insert(id.clone(), name.clone());
                let _ = turn
                    .sink
                    .try_send(DriverEvent::Runtime(RuntimeEvent::ToolProposed {
                        id,
                        name,
                        arguments: item
                            .get("arguments")
                            .map(Value::to_string)
                            .unwrap_or_else(|| "{}".to_string()),
                    }));
            }
        }
        "contextCompaction" => {
            core.emit(DriverEvent::Runtime(RuntimeEvent::CompactionStarted {
                smart: true,
                model: None,
            }));
        }
        _ => {}
    }
}

fn handle_codex_item_completed(core: &CodexCore, item: &Value) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("item")
        .to_string();
    match item_type {
        "agentMessage" => {
            let text = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                return;
            }
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                if !turn.streamed_items.contains(&id) {
                    turn.assistant_text.push_str(&text);
                    let _ = turn
                        .sink
                        .try_send(DriverEvent::Runtime(RuntimeEvent::AssistantDelta { text }));
                }
            }
        }
        "commandExecution" => {
            let exit_code = item.get("exitCode").and_then(Value::as_i64).unwrap_or(0);
            let status = item.get("status").and_then(Value::as_str).unwrap_or("");
            let output = item
                .get("aggregatedOutput")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                let name = turn
                    .tool_names
                    .remove(&id)
                    .unwrap_or_else(|| "shell".to_string());
                let _ = turn
                    .sink
                    .try_send(DriverEvent::Runtime(RuntimeEvent::ToolResult {
                        id,
                        name,
                        content: output,
                        is_error: status == "failed" || exit_code != 0,
                    }));
            }
        }
        "fileChange" => {
            let status = item.get("status").and_then(Value::as_str).unwrap_or("");
            let mut changed_paths = Vec::new();
            if let Some(changes) = item.get("changes").and_then(Value::as_array) {
                for change in changes {
                    if let Some(path) = change.get("path").and_then(Value::as_str) {
                        changed_paths.push(path.to_string());
                        let diff = change
                            .get("diff")
                            .and_then(Value::as_str)
                            .unwrap_or("modified")
                            .to_string();
                        core.emit(DriverEvent::Runtime(RuntimeEvent::FileChanged {
                            path: path.to_string(),
                            summary: diff,
                            before: None,
                            after: None,
                        }));
                    }
                }
            }
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                let name = turn
                    .tool_names
                    .remove(&id)
                    .unwrap_or_else(|| "edit_file".to_string());
                let _ = turn
                    .sink
                    .try_send(DriverEvent::Runtime(RuntimeEvent::ToolResult {
                        id,
                        name,
                        content: changed_paths.join(", "),
                        is_error: status == "failed",
                    }));
            }
        }
        "mcpToolCall" => {
            let status = item.get("status").and_then(Value::as_str).unwrap_or("");
            let content = item
                .get("result")
                .or_else(|| item.get("error"))
                .map(Value::to_string)
                .unwrap_or_default();
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                let name = turn
                    .tool_names
                    .remove(&id)
                    .unwrap_or_else(|| "mcp_tool".to_string());
                let _ = turn
                    .sink
                    .try_send(DriverEvent::Runtime(RuntimeEvent::ToolResult {
                        id,
                        name,
                        content,
                        is_error: status == "failed",
                    }));
            }
        }
        _ => {}
    }
}

async fn handle_codex_approval(
    core: &CodexCore,
    transport: &JsonRpcTransport,
    rpc_id: Value,
    tool_name: &str,
    params: &Value,
) {
    let request_id = format!("codex-perm-{}", Uuid::new_v4().simple());
    let description = params
        .get("reason")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| params.get("command").and_then(Value::as_str))
        .unwrap_or(tool_name)
        .to_string();
    let command = params.get("command").and_then(Value::as_str);
    let args = if let Some(cmd) = command {
        json!({ "command": cmd, "cwd": params.get("cwd") }).to_string()
    } else {
        params.to_string()
    };

    let options = vec![
        ApprovalOption {
            id: "accept".to_string(),
            label: "Allow once".to_string(),
            kind: ApprovalDecisionKind::ApproveOnce,
        },
        ApprovalOption {
            id: "acceptForSession".to_string(),
            label: "Allow for session".to_string(),
            kind: ApprovalDecisionKind::ApproveAll,
        },
        ApprovalOption {
            id: "decline".to_string(),
            label: "Decline".to_string(),
            kind: ApprovalDecisionKind::Deny,
        },
        ApprovalOption {
            id: "cancel".to_string(),
            label: "Cancel".to_string(),
            kind: ApprovalDecisionKind::Cancel,
        },
    ];

    let rx = core.approvals.register(core.session_id, request_id.clone());
    core.emit(DriverEvent::Runtime(RuntimeEvent::ApprovalRequested {
        request_id,
        source: "codex".to_string(),
        tool_name: tool_name.to_string(),
        tool_args: args,
        description,
        is_dangerous: false,
        file_path: None,
        old_content: None,
        new_content: None,
        child_run_id: None,
        options: options.clone(),
    }));

    let decision = rx.await.ok();
    let chosen = match decision {
        None => "cancel".to_string(),
        Some(dec) => dec
            .option_id
            .filter(|id| options.iter().any(|opt| opt.id == *id))
            .unwrap_or_else(|| match dec.decision {
                ApprovalDecisionKind::ApproveOnce => "accept".to_string(),
                ApprovalDecisionKind::ApproveAll => "acceptForSession".to_string(),
                ApprovalDecisionKind::Deny => "decline".to_string(),
                ApprovalDecisionKind::Cancel => "cancel".to_string(),
            }),
    };
    let _ = transport.reply_result(rpc_id, json!({ "decision": chosen }));
}

/// Active `codex app-server` JSON-RPC 2.0 session.
pub struct CodexSession {
    core: Arc<CodexCore>,
    transport: Arc<JsonRpcTransport>,
    child: Option<SpawnedStdio>,
    turn_lock: AsyncMutex<()>,
}

impl CodexSession {
    /// Connect over arbitrary bidirectional streams (used in production pipes and in-memory tests).
    pub async fn connect_io<R, W>(
        reader: R,
        writer: W,
        child: Option<SpawnedStdio>,
        spec: DriverSessionOpen,
        approvals: ApprovalRouter,
    ) -> Result<Self, DriverError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let cwd = canonical_cwd(&spec.project_dir);
        let core = Arc::new(CodexCore {
            session_id: spec.session_id,
            approvals,
            thread_id: Mutex::new(spec.external_session_id.clone()),
            active_turn: Mutex::new(None),
            transport: Mutex::new(None),
            closed_reason: Mutex::new(None),
        });
        let handler = Arc::new(CodexHandler {
            core: Arc::clone(&core),
        });
        let transport = JsonRpcTransport::start(reader, writer, CODEX_MAX_LINE_BYTES, handler);
        *core.transport.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Arc::downgrade(&transport));

        let _ = transport
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "agente",
                        "title": "Agente",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true },
                }),
            )
            .await?;
        let _ = transport.notify("initialized", json!({}));

        let mut resumed_id = None;
        if let Some(ext_id) = spec.external_session_id.as_deref() {
            let mut params = serde_json::Map::new();
            params.insert("threadId".into(), json!(ext_id));
            params.insert("cwd".into(), json!(cwd));
            params.insert("approvalPolicy".into(), json!(approval_policy_for(spec.mode)));
            params.insert("sandbox".into(), json!(sandbox_for(spec.mode)));
            if let Some(model) = effective_model(spec.model.as_deref()) {
                params.insert("model".into(), json!(model));
            }
            if transport
                .request("thread/resume", Value::Object(params))
                .await
                .is_ok()
            {
                resumed_id = Some(ext_id.to_string());
            }
        }

        let thread_id = match resumed_id {
            Some(id) => id,
            None => {
                let mut params = serde_json::Map::new();
                params.insert("cwd".into(), json!(cwd));
                params.insert("approvalPolicy".into(), json!(approval_policy_for(spec.mode)));
                params.insert("sandbox".into(), json!(sandbox_for(spec.mode)));
                if let Some(model) = effective_model(spec.model.as_deref()) {
                    params.insert("model".into(), json!(model));
                }
                let started = transport
                    .request("thread/start", Value::Object(params))
                    .await?;
                started
                    .pointer("/thread/id")
                    .or_else(|| started.get("threadId"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        DriverError::Protocol("Codex thread/start returned no thread.id".into())
                    })?
                    .to_string()
            }
        };

        *core.thread_id.lock().unwrap_or_else(|p| p.into_inner()) = Some(thread_id);

        Ok(Self {
            core,
            transport,
            child,
            turn_lock: AsyncMutex::new(()),
        })
    }
}

#[async_trait]
impl DriverSession for CodexSession {
    async fn start_turn(
        &self,
        request: DriverTurnRequest,
        sink: mpsc::Sender<DriverEvent>,
    ) -> Result<(), DriverError> {
        let _turn_guard = self.turn_lock.lock().await;
        let thread_id = self
            .external_session_id()
            .ok_or_else(|| DriverError::Protocol("Codex thread not initialized".into()))?;
        let _ = sink
            .send(DriverEvent::ExternalSessionBound(thread_id.clone()))
            .await;

        let (done_tx, done_rx) = oneshot::channel();
        {
            let mut active = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            *active = Some(ActiveCodexTurn {
                sink: sink.clone(),
                done_tx: Some(done_tx),
                native_turn_id: None,
                assistant_text: String::new(),
                streamed_items: HashSet::new(),
                tool_names: HashMap::new(),
                cancelled: false,
            });
        }

        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), json!(thread_id));
        params.insert(
            "input".into(),
            json!([{ "type": "text", "text": flatten_prompt_text(&request.prompt) }]),
        );
        params.insert("cwd".into(), json!(canonical_cwd(&request.cwd)));
        params.insert("approvalPolicy".into(), json!(approval_policy_for(request.mode)));
        params.insert("sandboxPolicy".into(), json!({ "type": sandbox_policy_type(request.mode) }));
        if let Some(model) = effective_model(request.model.as_deref()) {
            params.insert("model".into(), json!(model));
        }
        if let Some(thinking) = request
            .thinking_level
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty() && *v != "auto" && *v != "off")
        {
            params.insert("effort".into(), json!(thinking));
        }

        if let Err(error) = self
            .transport
            .request("turn/start", Value::Object(params))
            .await
        {
            let _ = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take();
            let mut msg = error.to_string();
            if let Some(child) = &self.child {
                let stderr = child.stderr_summary();
                if !stderr.is_empty() {
                    msg = format!("{msg}: {stderr}");
                }
            }
            let _ = sink
                .send(DriverEvent::TurnComplete {
                    status: TurnStatus::Failed,
                    assistant_text: String::new(),
                    tokens: 0,
                    error: Some(msg.clone()),
                })
                .await;
            return Err(DriverError::Protocol(msg));
        }

        let outcome = done_rx.await.unwrap_or(TurnOutcome {
            status: TurnStatus::Failed,
            assistant_text: String::new(),
            tokens: 0,
            error: Some(
                self.core
                    .closed_reason
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .unwrap_or_else(|| "Codex turn channel closed unexpectedly".into()),
            ),
        });
        let err_msg = outcome.error.clone();
        let _ = sink
            .send(DriverEvent::TurnComplete {
                status: outcome.status,
                assistant_text: outcome.assistant_text,
                tokens: outcome.tokens,
                error: outcome.error,
            })
            .await;
        match err_msg {
            Some(msg) => Err(DriverError::Protocol(msg)),
            None => Ok(()),
        }
    }

    async fn steer(&self, message: Message) -> bool {
        self.core.approvals.cancel_session(self.core.session_id);
        let Some(thread_id) = self.external_session_id() else {
            return false;
        };
        let native_turn_id = {
            let guard = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            guard.as_ref().and_then(|t| t.native_turn_id.clone())
        };
        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), json!(thread_id));
        if let Some(tid) = native_turn_id {
            params.insert("expectedTurnId".into(), json!(tid));
        }
        params.insert(
            "input".into(),
            json!([{ "type": "text", "text": flatten_prompt_text(&message) }]),
        );
        self.transport
            .request("turn/steer", Value::Object(params))
            .await
            .is_ok()
    }

    async fn cancel(&self, _turn_id: TurnId) -> bool {
        self.core.approvals.cancel_session(self.core.session_id);
        let native_turn_id = {
            let mut guard = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let Some(turn) = guard.as_mut() else {
                return false;
            };
            turn.cancelled = true;
            turn.native_turn_id.clone()
        };
        let Some(thread_id) = self.external_session_id() else {
            return false;
        };
        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), json!(thread_id));
        if let Some(tid) = native_turn_id {
            params.insert("turnId".into(), json!(tid));
        }
        self.transport
            .request("turn/interrupt", Value::Object(params))
            .await
            .is_ok()
    }

    fn external_session_id(&self) -> Option<String> {
        self.core
            .thread_id
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    async fn close(&self) {
        self.core.approvals.cancel_session(self.core.session_id);
        self.transport.close();
        if let Some(child) = &self.child {
            child.kill().await;
        }
    }
}

fn approval_policy_for(mode: TurnMode) -> &'static str {
    match mode {
        TurnMode::Plan | TurnMode::Build => "on-request",
        TurnMode::Auto => "never",
    }
}

fn sandbox_for(mode: TurnMode) -> &'static str {
    match mode {
        TurnMode::Plan => "read-only",
        TurnMode::Build => "workspace-write",
        TurnMode::Auto => "danger-full-access",
    }
}

fn sandbox_policy_type(mode: TurnMode) -> &'static str {
    match mode {
        TurnMode::Plan => "readOnly",
        TurnMode::Build => "workspaceWrite",
        TurnMode::Auto => "dangerFullAccess",
    }
}

fn extract_codex_usage(params: &Value) -> Option<Usage> {
    let info = params.get("tokenUsage").or_else(|| params.get("usage"))?;
    let last = info.get("last").or_else(|| info.get("total")).unwrap_or(info);
    let prompt_tokens = last
        .get("inputTokens")
        .or_else(|| last.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let cache_read_tokens = last
        .get("cachedInputTokens")
        .or_else(|| last.get("cached_input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let completion_tokens = last
        .get("outputTokens")
        .or_else(|| last.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    Some(Usage {
        prompt_tokens,
        completion_tokens,
        cache_read_tokens,
        cache_creation_tokens: 0,
        context_tokens: prompt_tokens.saturating_add(cache_read_tokens),
    })
}

#[derive(Default)]
struct CodexProbeOutcome {
    models: Vec<DriverModel>,
    needs_auth: bool,
    error: Option<String>,
}

/// Parse visible models from Codex `app-server` `model/list` RPC result.
pub fn parse_codex_models(result: &Value) -> Vec<DriverModel> {
    let Some(items) = result.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if item.get("hidden").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(raw_id) = item
            .get("model")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let id = raw_id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let label = item
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string();
        let is_default = item
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let thinking_levels = item
            .get("supportedReasoningEfforts")
            .and_then(Value::as_array)
            .map(|efforts| {
                efforts
                    .iter()
                    .filter_map(|e| e.get("reasoningEffort").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        out.push(DriverModel {
            id: id.to_string(),
            label,
            is_default,
            thinking_levels,
        });
    }
    out
}

fn looks_like_codex_auth_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("auth")
        || lower.contains("login")
        || lower.contains("sign in")
        || lower.contains("unauthorized")
        || lower.contains("credential")
        || lower.contains("api key")
        || lower.contains("token")
}

async fn probe_codex_live(instance: &ResolvedInstance) -> CodexProbeOutcome {
    let mut extra_args = Vec::new();
    if !instance.command.iter().any(|arg| arg == "app-server") {
        extra_args.push("app-server".to_string());
    }
    let temp_dir = std::env::temp_dir().to_string_lossy().into_owned();
    let Ok((spawned, stdout, stdin)) = SpawnedStdio::spawn(
        &instance.command,
        &extra_args,
        &temp_dir,
        &instance.env,
        &instance.strip_env,
    ) else {
        return CodexProbeOutcome::default();
    };

    let transport = JsonRpcTransport::start(
        stdout,
        stdin,
        CODEX_MAX_LINE_BYTES,
        Arc::new(NoopJsonRpcHandler),
    );

    let probe_res = tokio::time::timeout(CODEX_PROBE_TIMEOUT, async {
        transport
            .request_detailed(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "agente",
                        "title": "Agente",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true },
                }),
            )
            .await?;
        let _ = transport.notify("initialized", json!({}));
        transport
            .request_detailed(
                "model/list",
                json!({
                    "limit": 100,
                    "includeHidden": false,
                }),
            )
            .await
    })
    .await;

    transport.close();
    drop(transport);
    spawned.shutdown_gracefully(Duration::from_millis(150)).await;

    match probe_res {
        Ok(Ok(result)) => CodexProbeOutcome {
            models: parse_codex_models(&result),
            needs_auth: false,
            error: None,
        },
        Ok(Err(rpc_err)) => {
            if rpc_err.code == -32000 || looks_like_codex_auth_error(&rpc_err.message) {
                CodexProbeOutcome {
                    models: Vec::new(),
                    needs_auth: true,
                    error: Some(rpc_err.message),
                }
            } else {
                tracing::debug!(
                    instance = %instance.instance_id,
                    error = %rpc_err.message,
                    "Codex live model/list probe failed"
                );
                CodexProbeOutcome::default()
            }
        }
        Err(_) => {
            tracing::debug!(instance = %instance.instance_id, "Codex live model probe timed out");
            CodexProbeOutcome::default()
        }
    }
}

fn looks_like_usage_limit(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("usage limit")
        || lower.contains("rate limit")
        || lower.contains("quota")
        || lower.contains("429")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn parses_codex_model_list_skipping_hidden_and_mapping_efforts() {
        let result = json!({
            "data": [
                {
                    "id": "gpt-hidden",
                    "model": "gpt-hidden",
                    "hidden": true
                },
                {
                    "id": "gpt-6-astra",
                    "model": "gpt-6-astra",
                    "displayName": "GPT-6 Astra",
                    "isDefault": true,
                    "hidden": false,
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Fast" },
                        { "reasoningEffort": "medium", "description": "Balanced" },
                        { "reasoningEffort": "high", "description": "Deep" }
                    ]
                }
            ]
        });
        let models = parse_codex_models(&result);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-6-astra");
        assert_eq!(models[0].label, "GPT-6 Astra");
        assert!(models[0].is_default);
        assert_eq!(models[0].thinking_levels, vec!["low", "medium", "high"]);
    }

    #[tokio::test]
    async fn codex_app_server_streams_approvals_steer_and_completes() {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (c_read, c_write) = tokio::io::split(client_side);
        let (s_read, mut s_write) = tokio::io::split(server_side);

        let session_id = SessionId::new();
        let approvals = ApprovalRouter::new();
        let approvals_reply = approvals.clone();

        let mock_server = tokio::spawn(async move {
            let mut lines = BufReader::new(s_read).lines();
            let init: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(init["method"], "initialize");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({ "jsonrpc": "2.0", "id": init["id"], "result": {} })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let initialized: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(initialized["method"], "initialized");

            let start_thread: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(start_thread["method"], "thread/start");
            assert!(start_thread["params"].get("model").is_none());
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": start_thread["id"],
                            "result": { "thread": { "id": "codex-th-9" } }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let start_turn: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(start_turn["method"], "turn/start");
            assert_eq!(start_turn["params"]["threadId"], "codex-th-9");
            s_write
                .write_all(
                    format!(
                        "{}\n{}\n",
                        json!({ "jsonrpc": "2.0", "id": start_turn["id"], "result": {} }),
                        json!({
                            "jsonrpc": "2.0",
                            "method": "turn/started",
                            "params": { "threadId": "codex-th-9", "turn": { "id": "turn-1" } }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            // Command approval request + delta + steer + completion
            s_write
                .write_all(
                    format!(
                        "{}\n{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "method": "item/started",
                            "params": {
                                "threadId": "codex-th-9",
                                "item": { "type": "commandExecution", "id": "cmd-1", "command": "cargo check" }
                            }
                        }),
                        json!({
                            "jsonrpc": "2.0",
                            "id": 501,
                            "method": "item/commandExecution/requestApproval",
                            "params": {
                                "itemId": "cmd-1",
                                "threadId": "codex-th-9",
                                "turnId": "turn-1",
                                "command": "cargo check",
                                "cwd": ".",
                                "reason": "Verify build"
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let mut got_approval = false;
            let mut got_steer = false;
            while !(got_approval && got_steer) {
                let frame: Value =
                    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                if frame.get("id") == Some(&json!(501)) {
                    assert_eq!(frame["result"]["decision"], "accept");
                    got_approval = true;
                } else if frame.get("method") == Some(&json!("turn/steer")) {
                    assert_eq!(frame["params"]["expectedTurnId"], "turn-1");
                    s_write
                        .write_all(
                            format!(
                                "{}\n",
                                json!({ "jsonrpc": "2.0", "id": frame["id"], "result": {} })
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    got_steer = true;
                } else {
                    panic!("unexpected frame from client: {frame}");
                }
            }

            s_write
                .write_all(
                    format!(
                        "{}\n{}\n{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "method": "item/completed",
                            "params": {
                                "threadId": "codex-th-9",
                                "item": { "type": "commandExecution", "id": "cmd-1", "status": "completed", "exitCode": 0, "aggregatedOutput": "ok" }
                            }
                        }),
                        json!({
                            "jsonrpc": "2.0",
                            "method": "item/agentMessage/delta",
                            "params": { "threadId": "codex-th-9", "itemId": "msg-1", "delta": "Build green." }
                        }),
                        json!({
                            "jsonrpc": "2.0",
                            "method": "turn/completed",
                            "params": { "threadId": "codex-th-9", "turn": { "status": "completed", "error": null } }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let session = Arc::new(
            CodexSession::connect_io(
                c_read,
                c_write,
                None,
                DriverSessionOpen {
                    session_id,
                    project_dir: ".".into(),
                    external_session_id: None,
                    mode: TurnMode::Build,
                    model: Some("default".into()),
                    mcp_servers: Vec::new(),
                    interactive: true,
                },
                approvals,
            )
            .await
            .unwrap(),
        );

        assert_eq!(session.external_session_id().as_deref(), Some("codex-th-9"));
        let (tx, mut rx) = mpsc::channel(64);
        let run_sess = Arc::clone(&session);
        let turn_task = tokio::spawn(async move {
            run_sess
                .start_turn(
                    DriverTurnRequest {
                        session_id,
                        turn_id: TurnId::new(),
                        prompt: Message::user("check build"),
                        model: Some("default".into()),
                        thinking_level: None,
                        mode: TurnMode::Build,
                        cwd: ".".into(),
                        mcp_servers: Vec::new(),
                    },
                    tx,
                )
                .await
                .unwrap();
        });

        let mut final_text = String::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                DriverEvent::Runtime(RuntimeEvent::ApprovalRequested {
                    request_id,
                    options,
                    ..
                }) => {
                    assert_eq!(options[0].id, "accept");
                    assert!(approvals_reply.respond(agente_protocol::ApprovalDecision {
                        request_id,
                        decision: ApprovalDecisionKind::ApproveOnce,
                        option_id: Some("accept".into()),
                    }));
                    assert!(session.steer(Message::user("also check tests")).await);
                }
                DriverEvent::TurnComplete {
                    status,
                    assistant_text,
                    ..
                } => {
                    assert_eq!(status, TurnStatus::Completed);
                    final_text = assistant_text;
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(final_text, "Build green.");
        turn_task.await.unwrap();
        mock_server.await.unwrap();
    }

    #[test]
    fn codex_mcp_injection_uses_env_var_and_never_leaks_token_on_argv() {
        let mut args = Vec::new();
        let mut env = BTreeMap::new();
        append_codex_mcp_args(
            &[InjectedMcpServer {
                name: "agente-orchestrator".into(),
                url: "http://127.0.0.1:41234/mcp".into(),
                bearer_token: Some("tok-very-secret".into()),
            }],
            &mut args,
            &mut env,
        );
        assert_eq!(
            args,
            vec![
                "-c",
                "mcp_servers.agente-orchestrator.url=\"http://127.0.0.1:41234/mcp\"",
                "-c",
                "mcp_servers.agente-orchestrator.bearer_token_env_var=\"AGENTE_MCP_TOKEN_AGENTE_ORCHESTRATOR\"",
            ]
        );
        assert!(!args.iter().any(|a| a.contains("tok-very-secret")));
        assert_eq!(
            env.get("AGENTE_MCP_TOKEN_AGENTE_ORCHESTRATOR").map(String::as_str),
            Some("tok-very-secret")
        );
    }
}
