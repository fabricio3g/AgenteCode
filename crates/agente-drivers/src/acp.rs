//! Strict Agent Client Protocol (ACP) JSON-RPC 2.0 client driver.
//!
//! Speaks standard ACP (`initialize`, `session/new`, `session/load`,
//! `session/prompt`, `session/cancel`, `session/update`,
//! `session/request_permission`, and workspace-confined `fs/read_text_file` &
//! `fs/write_text_file`) with zero vendor-specific branches.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use agente_protocol::{
    rpc, ApprovalDecisionKind, ApprovalOption, DriverCapabilities, DriverInfo, DriverKind,
    DriverModel, DriverStatus, InputResponseAction, Message, RuntimeEvent, SessionId, TurnId,
    TurnMode, TurnStatus, Usage,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use uuid::Uuid;

use crate::config::{default_auth_hint, ResolvedInstance};
use crate::process::{
    canonical_cwd, passive_probe, resolve_executable, run_cli_output, JsonRpcError,
    JsonRpcHandler, JsonRpcTransport, NoopJsonRpcHandler, SpawnedStdio,
};
use crate::{
    effective_model, flatten_prompt_text, AgentDriver, ApprovalRouter, DriverError, DriverEvent,
    DriverSession, DriverSessionOpen, DriverTurnRequest, InjectedMcpServer,
};

const ACP_MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
const ACP_PROTOCOL_VERSION: u16 = 1;
const ACP_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const OPENCODE_MODELS_TIMEOUT: Duration = Duration::from_secs(6);

/// Driver wrapping any ACP-compliant executable or custom local ACP command.
pub struct AcpDriver {
    instance: ResolvedInstance,
}

impl AcpDriver {
    pub fn new(instance: ResolvedInstance) -> Self {
        Self { instance }
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            models: true,
            thinking: false,
            modes: vec![TurnMode::Plan, TurnMode::Build, TurnMode::Auto],
            native_plan_cards: true,
            approvals: true,
            steer: false,
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
impl AgentDriver for AcpDriver {
    fn instance_id(&self) -> &str {
        &self.instance.instance_id
    }

    fn driver_kind(&self) -> DriverKind {
        self.instance.driver_kind
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
            driver_kind: self.instance.driver_kind,
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
        let Some(program) = self.instance.command.first().map(String::as_str) else {
            info.status = DriverStatus::Missing;
            info.error = Some("no command configured".into());
            return info;
        };
        let Some(resolved) = resolve_executable(program) else {
            info.status = DriverStatus::Missing;
            info.binary_path = None;
            info.error = Some(format!("executable '{program}' was not found on PATH"));
            return info;
        };
        info.binary_path = Some(resolved.to_string_lossy().into_owned());

        if self.instance.driver_kind == DriverKind::OpenCode && self.instance.models.is_empty() {
            if let Ok(stdout) = run_cli_output(
                program,
                &["models".to_string()],
                None,
                &self.instance.env,
                &self.instance.strip_env,
                OPENCODE_MODELS_TIMEOUT,
            )
            .await
            {
                let mut parsed = parse_opencode_models_output(&stdout);
                if !parsed.is_empty() {
                    // `opencode models` prints names only; the effort levels
                    // (minimal … max) come from the ACP session's
                    // `thought_level` option, so ask the live session once and
                    // give every model its levels — otherwise OpenCode never
                    // offered a thinking level at all.
                    let live = probe_acp_live(&self.instance).await;
                    if let Some(levels) = live
                        .models
                        .iter()
                        .find(|model| !model.thinking_levels.is_empty())
                        .map(|model| model.thinking_levels.clone())
                    {
                        for model in &mut parsed {
                            model.thinking_levels = levels.clone();
                        }
                        info.capabilities.thinking = true;
                    }
                    info.models = parsed;
                    info.version = passive_probe(
                        &self.instance.command,
                        &["--version"],
                        &self.instance.env,
                        &self.instance.strip_env,
                    )
                    .await
                    .version;
                    info.status = DriverStatus::Ready;
                    info.error = None;
                    return info;
                }
            }
        }

        let live = probe_acp_live(&self.instance).await;
        if let Some(ver) = live.agent_version {
            info.version = Some(ver);
        }
        if live.needs_auth {
            info.status = DriverStatus::NeedsAuth;
            info.auth_hint = live.auth_hint;
            info.error = None;
            return info;
        }

        if info.version.is_none() {
            let outcome = passive_probe(
                &self.instance.command,
                &["--version"],
                &self.instance.env,
                &self.instance.strip_env,
            )
            .await;
            info.version = outcome.version;
            if !live.init_succeeded {
                if let Some(err) = outcome.error {
                    info.status = DriverStatus::Error;
                    info.error = Some(err);
                    return info;
                }
            }
        }

        info.status = DriverStatus::Ready;
        info.error = None;
        if self.instance.models.is_empty() && !live.models.is_empty() {
            info.models = live.models;
            if info.models.iter().any(|m| !m.thinking_levels.is_empty()) {
                info.capabilities.thinking = true;
            }
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
        let (spawned, stdout, stdin) = SpawnedStdio::spawn(
            &self.instance.command,
            &[],
            &spec.project_dir,
            &self.instance.env,
            &self.instance.strip_env,
        )?;
        let session = AcpSession::connect_io(stdout, stdin, Some(spawned), spec, approvals).await?;
        Ok(Arc::new(session))
    }
}

struct ActiveTurn {
    sink: mpsc::Sender<DriverEvent>,
    assistant_text: String,
    tool_names: HashMap<String, String>,
    tool_has_input: HashSet<String>,
    last_cost_usd: Option<f64>,
}

fn is_non_empty_input(val: &Value) -> bool {
    match val {
        Value::Null => false,
        Value::Object(map) => !map.is_empty(),
        Value::Array(arr) => !arr.is_empty(),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

struct AcpCore {
    session_id: SessionId,
    project_root: PathBuf,
    approvals: ApprovalRouter,
    external_session_id: Mutex<Option<String>>,
    model_config_id: Mutex<Option<String>>,
    current_model: Mutex<Option<String>>,
    thinking_config_id: Mutex<Option<String>>,
    current_thinking: Mutex<Option<String>>,
    active_turn: Mutex<Option<ActiveTurn>>,
    transport: Mutex<Option<Weak<JsonRpcTransport>>>,
    closed_reason: Mutex<Option<String>>,
}

impl AcpCore {
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

struct AcpHandler {
    core: Arc<AcpCore>,
}

impl JsonRpcHandler for AcpHandler {
    fn on_notification(&self, method: String, params: Value) {
        if method != "session/update" {
            return;
        }
        let Some(update) = params.get("update") else {
            return;
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        match kind {
            "agent_message_chunk" => {
                if let Some(text) = extract_text_content(update.get("content")) {
                    if !text.is_empty() {
                        let mut guard = self
                            .core
                            .active_turn
                            .lock()
                            .unwrap_or_else(|p| p.into_inner());
                        if let Some(turn) = guard.as_mut() {
                            turn.assistant_text.push_str(&text);
                            let _ = turn
                                .sink
                                .try_send(DriverEvent::Runtime(RuntimeEvent::AssistantDelta { text }));
                        }
                    }
                }
            }
            "agent_thought_chunk" => {
                if let Some(text) = extract_text_content(update.get("content")) {
                    if !text.is_empty() {
                        self.core
                            .emit(DriverEvent::Runtime(RuntimeEvent::ReasoningDelta { text }));
                    }
                }
            }
            "tool_call" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let name = update
                    .get("title")
                    .and_then(Value::as_str)
                    .or_else(|| update.get("kind").and_then(Value::as_str))
                    .unwrap_or("tool")
                    .to_string();
                let raw_input = update.get("rawInput");
                let has_input = raw_input.is_some_and(is_non_empty_input);
                let arguments = raw_input
                    .map(Value::to_string)
                    .unwrap_or_else(|| "{}".to_string());
                let mut guard = self
                    .core
                    .active_turn
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if let Some(turn) = guard.as_mut() {
                    turn.tool_names.insert(id.clone(), name.clone());
                    if has_input {
                        turn.tool_has_input.insert(id.clone());
                    }
                    let _ = turn
                        .sink
                        .try_send(DriverEvent::Runtime(RuntimeEvent::ToolProposed {
                            id,
                            name,
                            arguments,
                        }));
                }
            }
            "tool_call_update" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("in_progress");
                let title_opt = update
                    .get("title")
                    .and_then(Value::as_str)
                    .or_else(|| update.get("kind").and_then(Value::as_str))
                    .map(str::to_string);
                if let Some(raw_input) = update.get("rawInput").filter(|v| is_non_empty_input(v)) {
                    let proposed = {
                        let mut guard = self
                            .core
                            .active_turn
                            .lock()
                            .unwrap_or_else(|p| p.into_inner());
                        guard.as_mut().and_then(|turn| {
                            let name = if let Some(ref title) = title_opt {
                                turn.tool_names.insert(id.clone(), title.clone());
                                title.clone()
                            } else {
                                turn.tool_names
                                    .get(&id)
                                    .cloned()
                                    .unwrap_or_else(|| "tool".to_string())
                            };
                            if turn.tool_has_input.insert(id.clone()) {
                                Some((name, raw_input.to_string()))
                            } else {
                                None
                            }
                        })
                    };
                    if let Some((name, arguments)) = proposed {
                        self.core
                            .emit(DriverEvent::Runtime(RuntimeEvent::ToolProposed {
                                id: id.clone(),
                                name,
                                arguments,
                            }));
                    }
                }
                let text = extract_tool_update_text(update);
                if status == "completed" || status == "failed" {
                    let mut guard = self
                        .core
                        .active_turn
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    if let Some(turn) = guard.as_mut() {
                        turn.tool_has_input.remove(&id);
                        let name = turn
                            .tool_names
                            .remove(&id)
                            .unwrap_or_else(|| "tool".to_string());
                        let _ = turn
                            .sink
                            .try_send(DriverEvent::Runtime(RuntimeEvent::ToolResult {
                                id,
                                name,
                                content: text,
                                is_error: status == "failed",
                            }));
                    }
                } else if !text.is_empty() {
                    self.core
                        .emit(DriverEvent::Runtime(RuntimeEvent::ToolProgress {
                            id,
                            chunk: text,
                        }));
                }
            }
            "usage_update" => {
                let used = update
                    .get("used")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok());
                let size = update
                    .get("size")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok());
                let cost = update
                    .pointer("/cost/amount")
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite() && *v >= 0.0);
                if let Some(amount) = cost {
                    let mut guard = self
                        .core
                        .active_turn
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    if let Some(turn) = guard.as_mut() {
                        turn.last_cost_usd = Some(amount);
                    }
                }
                if let (Some(used), Some(size)) = (used, size) {
                    if size > 0 {
                        self.core.emit(DriverEvent::Runtime(RuntimeEvent::ContextBudget {
                            used,
                            room: size,
                            window: size,
                            tool_tokens: 0,
                            gap: 0,
                            system_tokens: None,
                            message_tokens: None,
                            tool_result_tokens: None,
                            reserve: None,
                            measured: true,
                        }));
                    }
                }
            }
            "plan" => {
                if let Some(entries) = update.get("entries") {
                    self.core
                        .emit(DriverEvent::Runtime(RuntimeEvent::TodoChanged {
                            todos: entries.clone(),
                        }));
                }
            }
            "current_mode_update" => {
                if let Some(raw_mode) = update.get("currentModeId").and_then(Value::as_str) {
                    if let Some(mode) = parse_mode(raw_mode) {
                        self.core
                            .emit(DriverEvent::Runtime(RuntimeEvent::ModeChanged { mode }));
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
                "session/request_permission" => {
                    handle_permission_request(&core, &transport, id, params).await;
                }
                "elicitation/create" => {
                    handle_elicitation_request(&core, &transport, id, params).await;
                }
                "fs/read_text_file" => {
                    let reply = handle_fs_read(&core.project_root, &params);
                    match reply {
                        Ok(result) => {
                            let _ = transport.reply_result(id, result);
                        }
                        Err((code, msg)) => {
                            let _ = transport.reply_error(id, code, &msg);
                        }
                    }
                }
                "fs/write_text_file" => {
                    let reply = handle_fs_write(&core, &params);
                    match reply {
                        Ok(result) => {
                            let _ = transport.reply_result(id, result);
                        }
                        Err((code, msg)) => {
                            let _ = transport.reply_error(id, code, &msg);
                        }
                    }
                }
                other => {
                    let _ = transport.reply_error(
                        id,
                        rpc::METHOD_NOT_FOUND,
                        &format!("unsupported ACP client method: {other}"),
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
            .unwrap_or_else(|p| p.into_inner()) = reason;
        self.core.approvals.cancel_session(self.core.session_id);
    }
}

async fn handle_elicitation_request(
    core: &AcpCore,
    transport: &JsonRpcTransport,
    rpc_id: Value,
    params: Value,
) {
    let mode = params.get("mode").and_then(Value::as_str).unwrap_or("form");
    if mode == "url" {
        let _ = transport.reply_result(rpc_id, json!({ "action": "decline" }));
        return;
    }
    let message = params
        .get("message")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Questions")
        .to_string();
    let tool_call_id = params
        .get("toolCallId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let schema = params
        .get("requestedSchema")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));

    let request_id = format!("acp-input-{}", Uuid::new_v4().simple());
    let rx = core
        .approvals
        .register_input(core.session_id, request_id.clone());
    core.emit(DriverEvent::Runtime(RuntimeEvent::InputRequested {
        request_id: request_id.clone(),
        message,
        tool_call_id,
        schema,
    }));

    let response = rx.await.ok();
    let outcome = match response {
        Some(resp) if resp.action == InputResponseAction::Accept => json!({
            "action": "accept",
            "content": resp.content.unwrap_or_else(|| json!({})),
        }),
        Some(resp) if resp.action == InputResponseAction::Decline => {
            json!({ "action": "decline" })
        }
        _ => json!({ "action": "cancel" }),
    };
    let _ = transport.reply_result(rpc_id, outcome);
}

async fn handle_permission_request(
    core: &AcpCore,
    transport: &JsonRpcTransport,
    rpc_id: Value,
    params: Value,
) {
    let tool_call = params.get("toolCall");
    let tool_name = tool_call
        .and_then(|t| t.get("title").or_else(|| t.get("kind")))
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let tool_args = tool_call
        .and_then(|t| t.get("rawInput"))
        .map(Value::to_string)
        .unwrap_or_else(|| "{}".to_string());
    let options: Vec<ApprovalOption> = params
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|opt| {
                    let id = opt.get("optionId")?.as_str()?.to_string();
                    let label = opt
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_string();
                    let kind = match opt.get("kind").and_then(Value::as_str).unwrap_or("") {
                        "allow_always" => ApprovalDecisionKind::ApproveAll,
                        "reject_once" | "reject_always" => ApprovalDecisionKind::Deny,
                        _ => ApprovalDecisionKind::ApproveOnce,
                    };
                    Some(ApprovalOption { id, label, kind })
                })
                .collect()
        })
        .unwrap_or_default();

    let request_id = format!("acp-perm-{}", Uuid::new_v4().simple());
    let rx = core.approvals.register(core.session_id, request_id.clone());
    core.emit(DriverEvent::Runtime(RuntimeEvent::ApprovalRequested {
        request_id: request_id.clone(),
        source: "acp".to_string(),
        tool_name: tool_name.clone(),
        tool_args,
        description: tool_name,
        is_dangerous: false,
        file_path: None,
        old_content: None,
        new_content: None,
        child_run_id: None,
        options: options.clone(),
    }));

    let decision = rx.await.ok();
    let outcome = match decision {
        None => json!({ "outcome": { "outcome": "cancelled" } }),
        Some(dec) if dec.decision == ApprovalDecisionKind::Cancel => {
            json!({ "outcome": { "outcome": "cancelled" } })
        }
        Some(dec) => {
            let chosen = dec
                .option_id
                .filter(|id| options.is_empty() || options.iter().any(|opt| opt.id == *id))
                .or_else(|| {
                    options
                        .iter()
                        .find(|opt| opt.kind == dec.decision)
                        .map(|opt| opt.id.clone())
                })
                .unwrap_or_else(|| match dec.decision {
                    ApprovalDecisionKind::ApproveOnce => "allow_once".to_string(),
                    ApprovalDecisionKind::ApproveAll => "allow_always".to_string(),
                    ApprovalDecisionKind::Deny | ApprovalDecisionKind::Cancel => {
                        "reject_once".to_string()
                    }
                });
            json!({ "outcome": { "outcome": "selected", "optionId": chosen } })
        }
    };
    let _ = transport.reply_result(rpc_id, outcome);
}

fn handle_fs_read(project_root: &Path, params: &Value) -> Result<Value, (i32, String)> {
    let raw_path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or((rpc::INVALID_PARAMS, "path is required".to_string()))?;
    let path = resolve_confined_path(project_root, raw_path)?;
    let content = std::fs::read_to_string(&path)
        .map_err(|error| (rpc::INTERNAL_ERROR, format!("read failed: {error}")))?;
    let line = params
        .get("line")
        .and_then(Value::as_u64)
        .map(|n| n.saturating_sub(1) as usize);
    let limit = params.get("limit").and_then(Value::as_u64).map(|n| n as usize);
    let sliced = match (line, limit) {
        (None, None) => content,
        _ => {
            let start = line.unwrap_or(0);
            let lines: Vec<&str> = content.lines().skip(start).collect();
            match limit {
                Some(max) => lines.into_iter().take(max).collect::<Vec<_>>().join("\n"),
                None => lines.join("\n"),
            }
        }
    };
    Ok(json!({ "content": sliced }))
}

fn handle_fs_write(core: &AcpCore, params: &Value) -> Result<Value, (i32, String)> {
    let raw_path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or((rpc::INVALID_PARAMS, "path is required".to_string()))?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or((rpc::INVALID_PARAMS, "content is required".to_string()))?;
    let path = resolve_confined_path(&core.project_root, raw_path)?;
    let before = std::fs::read_to_string(&path).ok();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| (rpc::INTERNAL_ERROR, format!("mkdir failed: {error}")))?;
    }
    std::fs::write(&path, content)
        .map_err(|error| (rpc::INTERNAL_ERROR, format!("write failed: {error}")))?;
    let rel = path
        .strip_prefix(&core.project_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| raw_path.to_string());
    core.emit(DriverEvent::Runtime(RuntimeEvent::FileChanged {
        path: rel,
        summary: "wrote file via ACP".to_string(),
        before,
        after: Some(content.to_string()),
    }));
    Ok(json!({}))
}

fn resolve_confined_path(root: &Path, raw_path: &str) -> Result<PathBuf, (i32, String)> {
    let canon_root = realpath_nearest_ancestor(root);
    let candidate = Path::new(raw_path);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        canon_root.join(candidate)
    };
    let resolved = realpath_nearest_ancestor(&joined);
    if !resolved.starts_with(&canon_root) {
        return Err((
            rpc::INVALID_PARAMS,
            format!("path '{raw_path}' escapes project root"),
        ));
    }
    Ok(resolved)
}

fn realpath_nearest_ancestor(target: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for comp in target.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let mut tail = Vec::new();
    let mut cursor = normalized.clone();
    loop {
        if let Ok(canon) = std::fs::canonicalize(&cursor) {
            let mut out = canon;
            for part in tail.into_iter().rev() {
                out.push(part);
            }
            return out;
        }
        let Some(name) = cursor.file_name().map(|n| n.to_os_string()) else {
            return normalized;
        };
        let Some(parent) = cursor.parent() else {
            return normalized;
        };
        tail.push(name);
        cursor = parent.to_path_buf();
    }
}

/// Active ACP subprocess session.
pub struct AcpSession {
    core: Arc<AcpCore>,
    transport: Arc<JsonRpcTransport>,
    child: Option<SpawnedStdio>,
    turn_lock: AsyncMutex<()>,
}

impl AcpSession {
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
        let core = Arc::new(AcpCore {
            session_id: spec.session_id,
            project_root: PathBuf::from(&cwd),
            approvals,
            external_session_id: Mutex::new(spec.external_session_id.clone()),
            model_config_id: Mutex::new(None),
            current_model: Mutex::new(None),
            thinking_config_id: Mutex::new(None),
            current_thinking: Mutex::new(None),
            active_turn: Mutex::new(None),
            transport: Mutex::new(None),
            closed_reason: Mutex::new(None),
        });
        let handler = Arc::new(AcpHandler {
            core: Arc::clone(&core),
        });
        let transport = JsonRpcTransport::start(reader, writer, ACP_MAX_LINE_BYTES, handler);
        *core.transport.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Arc::downgrade(&transport));

        let mut client_caps = json!({
            "fs": { "readTextFile": true, "writeTextFile": true }
        });
        if spec.interactive {
            client_caps["elicitation"] = json!({ "form": {} });
        }

        let init = transport
            .request(
                "initialize",
                json!({
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    "clientCapabilities": client_caps,
                    "clientInfo": {
                        "name": "agente",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
            )
            .await?;

        let supports_load = init
            .pointer("/agentCapabilities/loadSession")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let supports_http_mcp = init
            .pointer("/agentCapabilities/mcpCapabilities/http")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mcp_servers = acp_mcp_servers_for_caps(&spec.mcp_servers, supports_http_mcp);

        let mut loaded_payload = None;
        let mut loaded_id = None;
        if supports_load {
            if let Some(ext_id) = spec.external_session_id.as_deref() {
                if let Ok(loaded) = transport
                    .request(
                        "session/load",
                        json!({
                            "sessionId": ext_id,
                            "cwd": cwd,
                            "mcpServers": mcp_servers,
                        }),
                    )
                    .await
                {
                    loaded_id = Some(ext_id.to_string());
                    loaded_payload = Some(loaded);
                }
            }
        }

        let (ext_id, session_payload) = match loaded_id {
            Some(id) => (id, loaded_payload.unwrap_or(Value::Null)),
            None => {
                let created = transport
                    .request(
                        "session/new",
                        json!({
                            "cwd": cwd,
                            "mcpServers": mcp_servers,
                        }),
                    )
                    .await?;
                let id = created
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| DriverError::Protocol("ACP session/new returned no sessionId".into()))?
                    .to_string();
                (id, created)
            }
        };

        *core
            .external_session_id
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(ext_id.clone());

        let model_config_id = extract_acp_model_config_id(&session_payload);
        *core
            .model_config_id
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = model_config_id.clone();

        let thinking_config_id = extract_acp_thinking_config_id(&session_payload);
        *core
            .thinking_config_id
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = thinking_config_id;

        if let Some((cfg_id, target_mode)) = extract_acp_mode_target(&session_payload, spec.mode) {
            let _ = match cfg_id {
                Some(config_id) => {
                    transport
                        .request(
                            "session/set_config_option",
                            json!({
                                "sessionId": ext_id,
                                "configId": config_id,
                                "value": target_mode,
                            }),
                        )
                        .await
                }
                None => {
                    transport
                        .request(
                            "session/set_mode",
                            json!({
                                "sessionId": ext_id,
                                "modeId": target_mode,
                            }),
                        )
                        .await
                }
            };
        }

        if let Some(model) = effective_model(spec.model.as_deref()) {
            apply_acp_model(&transport, &ext_id, model_config_id.as_deref(), model).await;
            *core
                .current_model
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(model.to_string());
        }

        Ok(Self {
            core,
            transport,
            child,
            turn_lock: AsyncMutex::new(()),
        })
    }
}

#[async_trait]
impl DriverSession for AcpSession {
    async fn start_turn(
        &self,
        request: DriverTurnRequest,
        sink: mpsc::Sender<DriverEvent>,
    ) -> Result<(), DriverError> {
        let _turn_guard = self.turn_lock.lock().await;
        let ext_id = self
            .external_session_id()
            .ok_or_else(|| DriverError::Protocol("ACP session not initialized".into()))?;
        let _ = sink
            .send(DriverEvent::ExternalSessionBound(ext_id.clone()))
            .await;

        if let Some(req_model) = effective_model(request.model.as_deref()) {
            let needs_switch = {
                let current = self
                    .core
                    .current_model
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                current.as_deref() != Some(req_model)
            };
            if needs_switch {
                let model_config_id = self
                    .core
                    .model_config_id
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                if apply_acp_model(
                    &self.transport,
                    &ext_id,
                    model_config_id.as_deref(),
                    req_model,
                )
                .await
                {
                    *self
                        .core
                        .current_model
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) = Some(req_model.to_string());
                    let _ = sink
                        .send(DriverEvent::Runtime(RuntimeEvent::ModelChanged {
                            model: req_model.to_string(),
                            provider: None,
                        }))
                        .await;
                }
            }
        }

        if let Some(raw_thinking) = request
            .thinking_level
            .as_deref()
            .map(str::trim)
            .filter(|lvl| !lvl.is_empty() && !lvl.eq_ignore_ascii_case("auto"))
        {
            let thinking_cfg_id = self
                .core
                .thinking_config_id
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if let Some(cfg_id) = thinking_cfg_id {
                let needs_switch = {
                    let current = self
                        .core
                        .current_thinking
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    current.as_deref() != Some(raw_thinking)
                };
                if needs_switch
                    && self
                        .transport
                        .request(
                            "session/set_config_option",
                            json!({
                                "sessionId": ext_id,
                                "configId": cfg_id,
                                "value": raw_thinking,
                            }),
                        )
                        .await
                        .is_ok()
                {
                    *self
                        .core
                        .current_thinking
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) = Some(raw_thinking.to_string());
                }
            }
        }

        {
            let mut active = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            *active = Some(ActiveTurn {
                sink: sink.clone(),
                assistant_text: String::new(),
                tool_names: HashMap::new(),
                tool_has_input: HashSet::new(),
                last_cost_usd: None,
            });
        }

        let prompt_text = flatten_prompt_text(&request.prompt);
        let response = self
            .transport
            .request(
                "session/prompt",
                json!({
                    "sessionId": ext_id,
                    "prompt": [{ "type": "text", "text": prompt_text }],
                }),
            )
            .await;

        let finished = self
            .core
            .active_turn
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let (assistant_text, last_cost_usd) = finished
            .map(|t| (t.assistant_text, t.last_cost_usd))
            .unwrap_or_default();

        match response {
            Ok(result) => {
                let mut total_tokens = 0u32;
                if let Some(usage_val) = result.get("usage") {
                    let input_tokens = usage_val
                        .get("inputTokens")
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok())
                        .unwrap_or(0);
                    let completion_tokens = usage_val
                        .get("outputTokens")
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok())
                        .unwrap_or(0);
                    let cache_read_tokens = usage_val
                        .get("cachedReadTokens")
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok())
                        .unwrap_or(0);
                    let cache_creation_tokens = usage_val
                        .get("cachedWriteTokens")
                        .or_else(|| usage_val.get("cacheWriteTokens"))
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok())
                        .unwrap_or(0);
                    let raw_total = usage_val
                        .get("totalTokens")
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok())
                        .unwrap_or(0);
                    total_tokens = if raw_total > 0 {
                        raw_total
                    } else {
                        input_tokens
                            .saturating_add(completion_tokens)
                            .saturating_add(cache_read_tokens)
                            .saturating_add(cache_creation_tokens)
                    };
                    if total_tokens > 0 {
                        let usage = Usage {
                            prompt_tokens: input_tokens,
                            completion_tokens,
                            cache_read_tokens,
                            cache_creation_tokens,
                            context_tokens: input_tokens
                                .saturating_add(cache_read_tokens)
                                .saturating_add(cache_creation_tokens),
                        };
                        let _ = sink
                            .send(DriverEvent::Runtime(RuntimeEvent::CallUsage {
                                usage: usage.clone(),
                                cost_usd: last_cost_usd,
                                cost_estimated: false,
                            }))
                            .await;
                        let _ = sink
                            .send(DriverEvent::Runtime(RuntimeEvent::Usage { usage }))
                            .await;
                    }
                }
                let stop_reason = result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn");
                let status = if stop_reason == "cancelled" {
                    TurnStatus::Cancelled
                } else {
                    TurnStatus::Completed
                };
                let _ = sink
                    .send(DriverEvent::TurnComplete {
                        status,
                        assistant_text,
                        tokens: total_tokens,
                        error: None,
                    })
                    .await;
                Ok(())
            }
            Err(error) => {
                let mut msg = error.to_string();
                if let Some(child) = &self.child {
                    let stderr = child.stderr_summary();
                    if !stderr.is_empty() {
                        msg = format!("{msg}: {stderr}");
                    }
                } else if let Some(closed) = self
                    .core
                    .closed_reason
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                {
                    msg = format!("{msg}: {closed}");
                }
                let _ = sink
                    .send(DriverEvent::TurnComplete {
                        status: TurnStatus::Failed,
                        assistant_text,
                        tokens: 0,
                        error: Some(msg.clone()),
                    })
                    .await;
                Err(DriverError::Protocol(msg))
            }
        }
    }

    async fn steer(&self, _message: Message) -> bool {
        false
    }

    async fn cancel(&self, _turn_id: TurnId) -> bool {
        self.core.approvals.cancel_session(self.core.session_id);
        let Some(ext_id) = self.external_session_id() else {
            return false;
        };
        self.transport
            .notify("session/cancel", json!({ "sessionId": ext_id }))
            .is_ok()
    }

    fn external_session_id(&self) -> Option<String> {
        self.core
            .external_session_id
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    async fn close(&self) {
        self.core.approvals.cancel_session(self.core.session_id);
        self.transport.close();
        if let Some(child) = &self.child {
            child.shutdown_gracefully(Duration::from_millis(150)).await;
        }
    }
}

#[derive(Default)]
struct AcpProbeOutcome {
    models: Vec<DriverModel>,
    agent_version: Option<String>,
    init_succeeded: bool,
    needs_auth: bool,
    auth_hint: Option<String>,
}

async fn apply_acp_model(
    transport: &JsonRpcTransport,
    ext_id: &str,
    model_config_id: Option<&str>,
    model: &str,
) -> bool {
    if let Some(config_id) = model_config_id {
        if transport
            .request(
                "session/set_config_option",
                json!({
                    "sessionId": ext_id,
                    "configId": config_id,
                    "value": model,
                }),
            )
            .await
            .is_ok()
        {
            return true;
        }
    }
    transport
        .request(
            "session/set_model",
            json!({
                "sessionId": ext_id,
                "modelId": model,
            }),
        )
        .await
        .is_ok()
}

fn collect_config_option_entries(entry: &Value) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let Some(options) = entry.get("options").and_then(Value::as_array) else {
        return out;
    };
    for item in options {
        if let Some(nested) = item.get("options").and_then(Value::as_array) {
            for sub in nested {
                if let Some(val) = sub
                    .get("value")
                    .or_else(|| sub.get("id"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let label = sub
                        .get("name")
                        .or_else(|| sub.get("label"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(val);
                    out.push((val, label));
                }
            }
        } else if let Some(val) = item
            .get("value")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let label = item
                .get("name")
                .or_else(|| item.get("label"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(val);
            out.push((val, label));
        }
    }
    out
}

fn config_option_matches(entry: &Value, expected_category: &str, alt_ids: &[&str]) -> bool {
    let cat = entry
        .get("category")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if cat.eq_ignore_ascii_case(expected_category) {
        return true;
    }
    let id = entry
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    alt_ids.iter().any(|cand| id.eq_ignore_ascii_case(cand))
}

/// Extract the `configOptions[].id` used for model selection, when advertised.
pub fn extract_acp_model_config_id(session_result: &Value) -> Option<String> {
    let items = session_result.get("configOptions").and_then(Value::as_array)?;
    items.iter().find_map(|entry| {
        if config_option_matches(entry, "model", &["model"]) {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        } else {
            None
        }
    })
}

/// Extract the `configOptions[].id` used for reasoning/thought effort, when advertised.
pub fn extract_acp_thinking_config_id(session_result: &Value) -> Option<String> {
    let items = session_result.get("configOptions").and_then(Value::as_array)?;
    items.iter().find_map(|entry| {
        if config_option_matches(
            entry,
            "thought_level",
            &["thought_level", "reasoning_effort", "thinking", "reasoning"],
        ) {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        } else {
            None
        }
    })
}

/// Parse available models from ACP `session/new` (supports both modern `configOptions`
/// and `models.availableModels`).
pub fn parse_acp_models(session_result: &Value) -> Vec<DriverModel> {
    let config_items = session_result.get("configOptions").and_then(Value::as_array);
    let thinking_levels: Vec<String> = config_items
        .and_then(|items| {
            items.iter().find(|entry| {
                config_option_matches(
                    entry,
                    "thought_level",
                    &["thought_level", "reasoning_effort", "thinking", "reasoning"],
                )
            })
        })
        .map(|entry| {
            let mut seen_levels = HashSet::new();
            collect_config_option_entries(entry)
                .into_iter()
                // "default" is the absence of a choice: the picker draws its
                // own Default, so it is not a level of its own.
                .filter(|&(val, _)| !val.eq_ignore_ascii_case("default"))
                .filter(|&(val, _)| seen_levels.insert(val))
                .map(|(val, _)| val.to_string())
                .collect()
        })
        .unwrap_or_default();

    let mut seen = HashSet::new();
    let mut out = Vec::new();

    if let Some(model_cfg) = config_items.and_then(|items| {
        items
            .iter()
            .find(|entry| config_option_matches(entry, "model", &["model"]))
    }) {
        let current_value = model_cfg
            .get("currentValue")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        for (val, label) in collect_config_option_entries(model_cfg) {
            if !seen.insert(val.to_string()) {
                continue;
            }
            out.push(DriverModel {
                id: val.to_string(),
                label: label.to_string(),
                is_default: current_value == Some(val),
                thinking_levels: thinking_levels.clone(),
            });
        }
        if !out.is_empty() {
            return out;
        }
    }

    let current_id = session_result
        .pointer("/models/currentModelId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(avail) = session_result
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
    {
        for item in avail {
            let Some(id) = item
                .get("modelId")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if !seen.insert(id.to_string()) {
                continue;
            }
            let label = item
                .get("name")
                .or_else(|| item.get("displayName"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(id);
            out.push(DriverModel {
                id: id.to_string(),
                label: label.to_string(),
                is_default: current_id == Some(id),
                thinking_levels: thinking_levels.clone(),
            });
        }
    }

    out
}

fn matches_acp_mode(id: &str, label: &str, mode: TurnMode) -> bool {
    let id_norm = id.trim().trim_start_matches('#').to_ascii_lowercase();
    let label_norm = label.trim().to_ascii_lowercase();
    match mode {
        TurnMode::Plan => {
            id_norm.contains("plan")
                || id_norm.contains("architect")
                || label_norm.contains("plan")
        }
        TurnMode::Build => {
            matches!(
                id_norm.as_str(),
                "agent" | "code" | "build" | "default" | "ask" | "edit"
            ) || matches!(
                label_norm.as_str(),
                "agent" | "code" | "build" | "default" | "ask" | "edit"
            )
        }
        TurnMode::Auto => {
            id_norm.contains("auto")
                || id_norm.contains("bypass")
                || id_norm.contains("yolo")
                || id_norm.contains("autopilot")
                || id_norm.contains("full")
                || label_norm.contains("auto")
                || label_norm.contains("bypass")
        }
    }
}

/// Match an Agente `TurnMode` against either `configOptions` (returns `(Some(config_id), value)`)
/// or `modes.availableModes` (returns `(None, mode_id)`).
pub fn extract_acp_mode_target(
    session_result: &Value,
    mode: TurnMode,
) -> Option<(Option<String>, String)> {
    if let Some(items) = session_result.get("configOptions").and_then(Value::as_array) {
        if let Some(entry) = items
            .iter()
            .find(|entry| config_option_matches(entry, "mode", &["mode"]))
        {
            if let Some(config_id) = entry
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                for (val, label) in collect_config_option_entries(entry) {
                    if matches_acp_mode(val, label, mode) {
                        return Some((Some(config_id.to_string()), val.to_string()));
                    }
                }
            }
        }
    }

    if let Some(modes) = session_result
        .pointer("/modes/availableModes")
        .and_then(Value::as_array)
    {
        for entry in modes {
            let Some(id) = entry
                .get("id")
                .or_else(|| entry.get("value"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let label = entry
                .get("name")
                .or_else(|| entry.get("label"))
                .and_then(Value::as_str)
                .unwrap_or(id);
            if matches_acp_mode(id, label, mode) {
                return Some((None, id.to_string()));
            }
        }
    }

    None
}

/// Detect whether a JSON-RPC error from `session/new` means authentication is required.
pub fn is_acp_auth_error(err: &JsonRpcError) -> bool {
    if err.code == -32000 {
        return true;
    }
    let details = err
        .data
        .as_ref()
        .and_then(|d| d.get("details"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let combined = format!("{} {details}", err.message).to_ascii_lowercase();
    combined.contains("auth")
        || combined.contains("login")
        || combined.contains("sign in")
        || combined.contains("unauthorized")
        || combined.contains("api key")
        || combined.contains("credentials")
}

/// Format an actionable sign-in hint from ACP `authMethods` / error details.
pub fn format_acp_auth_hint(
    err: &JsonRpcError,
    init_result: Option<&Value>,
    fallback: Option<&str>,
) -> String {
    let details = err
        .data
        .as_ref()
        .and_then(|d| d.get("details"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let methods = err
        .data
        .as_ref()
        .and_then(|d| d.get("authMethods"))
        .or_else(|| init_result.and_then(|v| v.get("authMethods")))
        .and_then(Value::as_array);

    let mut method_names: Vec<String> = Vec::new();
    if let Some(items) = methods {
        for item in items {
            let label = item
                .get("description")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(text) = label {
                if !method_names.iter().any(|existing| existing == text) {
                    method_names.push(text.to_string());
                }
            }
        }
    }

    if let Some(detail) = details {
        let collapsed: String = detail.split_whitespace().collect::<Vec<_>>().join(" ");
        if let Some(hint) = fallback {
            if !collapsed.eq_ignore_ascii_case(hint) && !collapsed.contains(hint) {
                return format!("{collapsed} {hint}");
            }
        }
        return collapsed;
    }

    if let Some(hint) = fallback {
        if !method_names.is_empty() {
            return format!("{hint} (Auth methods: {})", method_names.join(", "));
        }
        return hint.to_string();
    }

    if !method_names.is_empty() {
        return format!("Authentication required ({})", method_names.join(", "));
    }

    err.message.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_ansi_escapes(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if matches!(chars.peek(), Some('[')) {
                chars.next();
                for inner in chars.by_ref() {
                    if ('@'..='~').contains(&inner) {
                        break;
                    }
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Parse `opencode models` plain-text output (`provider/model` per line) into [`DriverModel`]s.
pub fn parse_opencode_models_output(stdout: &str) -> Vec<DriverModel> {
    let clean = strip_ansi_escapes(stdout);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in clean.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.contains(char::is_whitespace)
            || !trimmed.contains('/')
            || trimmed.contains("://")
            || trimmed.starts_with('[')
            || trimmed.starts_with('-')
            || trimmed.starts_with('#')
        {
            continue;
        }
        if !seen.insert(trimmed.to_string()) {
            continue;
        }
        out.push(DriverModel {
            id: trimmed.to_string(),
            label: trimmed.to_string(),
            is_default: false,
            thinking_levels: Vec::new(),
        });
    }
    out
}

async fn probe_acp_live(instance: &ResolvedInstance) -> AcpProbeOutcome {
    let temp_dir = std::env::temp_dir().to_string_lossy().into_owned();
    let Ok((spawned, stdout, stdin)) = SpawnedStdio::spawn(
        &instance.command,
        &[],
        &temp_dir,
        &instance.env,
        &instance.strip_env,
    ) else {
        return AcpProbeOutcome::default();
    };

    let transport = JsonRpcTransport::start(
        stdout,
        stdin,
        ACP_MAX_LINE_BYTES,
        Arc::new(NoopJsonRpcHandler),
    );
    let temp_cwd = canonical_cwd(&temp_dir);

    let probe_res = tokio::time::timeout(ACP_PROBE_TIMEOUT, async {
        let init = transport
            .request_detailed(
                "initialize",
                json!({
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false }
                    },
                    "clientInfo": {
                        "name": "agente",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
            )
            .await;

        let Ok(init_val) = init else {
            return (init.err(), None);
        };

        let session = transport
            .request_detailed(
                "session/new",
                json!({
                    "cwd": temp_cwd,
                    "mcpServers": [],
                }),
            )
            .await;
        (None, Some((init_val, session)))
    })
    .await;

    transport.close();
    drop(transport);
    spawned.shutdown_gracefully(Duration::from_millis(150)).await;

    match probe_res {
        Ok((Some(init_err), _)) => {
            if is_acp_auth_error(&init_err) {
                AcpProbeOutcome {
                    needs_auth: true,
                    auth_hint: Some(format_acp_auth_hint(
                        &init_err,
                        None,
                        default_auth_hint(&instance.instance_id),
                    )),
                    ..AcpProbeOutcome::default()
                }
            } else {
                tracing::debug!(
                    instance = %instance.instance_id,
                    error = %init_err.message,
                    "ACP live initialize probe failed"
                );
                AcpProbeOutcome::default()
            }
        }
        Ok((None, Some((init_val, session_res)))) => {
            let agent_version = init_val
                .pointer("/agentInfo/version")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            match session_res {
                Ok(created) => AcpProbeOutcome {
                    models: parse_acp_models(&created),
                    agent_version,
                    init_succeeded: true,
                    needs_auth: false,
                    auth_hint: None,
                },
                Err(rpc_err) => {
                    if is_acp_auth_error(&rpc_err) {
                        AcpProbeOutcome {
                            models: Vec::new(),
                            agent_version,
                            init_succeeded: true,
                            needs_auth: true,
                            auth_hint: Some(format_acp_auth_hint(
                                &rpc_err,
                                Some(&init_val),
                                default_auth_hint(&instance.instance_id),
                            )),
                        }
                    } else {
                        tracing::debug!(
                            instance = %instance.instance_id,
                            error = %rpc_err.message,
                            "ACP session/new probe failed"
                        );
                        AcpProbeOutcome {
                            agent_version,
                            init_succeeded: true,
                            ..AcpProbeOutcome::default()
                        }
                    }
                }
            }
        }
        _ => {
            tracing::debug!(instance = %instance.instance_id, "ACP live probe timed out");
            AcpProbeOutcome::default()
        }
    }
}

fn acp_mcp_servers_for_caps(servers: &[InjectedMcpServer], supports_http_mcp: bool) -> Vec<Value> {
    if servers.is_empty() {
        return Vec::new();
    }
    if supports_http_mcp {
        acp_mcp_servers(servers)
    } else {
        acp_stdio_bridge_servers(servers)
    }
}

fn acp_mcp_servers(servers: &[InjectedMcpServer]) -> Vec<Value> {
    servers
        .iter()
        .map(|srv| {
            let mut headers = Vec::new();
            if let Some(token) = &srv.bearer_token {
                headers.push(json!({ "name": "Authorization", "value": format!("Bearer {token}") }));
            }
            json!({
                "type": "http",
                "name": srv.name,
                "url": srv.url,
                "headers": headers,
            })
        })
        .collect()
}

fn acp_stdio_bridge_servers(servers: &[InjectedMcpServer]) -> Vec<Value> {
    let exe = std::env::current_exe()
        .ok()
        .and_then(|path| path.into_os_string().into_string().ok())
        .unwrap_or_else(|| "agente".to_string());
    servers
        .iter()
        .map(|srv| {
            let mut env = Vec::new();
            if let Some(token) = &srv.bearer_token {
                env.push(json!({
                    "name": "AGENTE_MCP_BEARER_TOKEN",
                    "value": token,
                }));
            }
            json!({
                "name": srv.name,
                "command": exe,
                "args": ["mcp-bridge", "--url", srv.url],
                "env": env,
            })
        })
        .collect()
}

fn extract_text_content(value: Option<&Value>) -> Option<String> {
    let content = value?;
    if let Some(text) = content.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(arr) = content.as_array() {
        let joined: Vec<&str> = arr
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect();
        if !joined.is_empty() {
            return Some(joined.join("\n"));
        }
    }
    None
}

fn extract_tool_update_text(update: &Value) -> String {
    if let Some(arr) = update.get("content").and_then(Value::as_array) {
        let parts: Vec<String> = arr
            .iter()
            .filter_map(|item| {
                extract_text_content(item.get("content")).or_else(|| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
            })
            .collect();
        if !parts.is_empty() {
            return parts.join("\n");
        }
    }
    update
        .get("rawOutput")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn parse_mode(raw: &str) -> Option<TurnMode> {
    match raw.to_ascii_lowercase().as_str() {
        "plan" => Some(TurnMode::Plan),
        "build" | "supervised" | "default" => Some(TurnMode::Build),
        "auto" | "full" | "bypasspermissions" => Some(TurnMode::Auto),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn acp_session_handles_stream_permissions_and_confined_fs() {
        let dir = std::env::temp_dir().join(format!("agente-acp-drv-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hello.txt"), "hello world").unwrap();

        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (c_read, c_write) = tokio::io::split(client_side);
        let (s_read, mut s_write) = tokio::io::split(server_side);

        let session_id = SessionId::new();
        let approvals = ApprovalRouter::new();
        let approvals_reply = approvals.clone();

        let mock_agent = tokio::spawn(async move {
            let mut lines = BufReader::new(s_read).lines();
            let init: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(init["method"], "initialize");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": init["id"],
                            "result": {
                                "protocolVersion": 1,
                                "agentCapabilities": { "loadSession": true }
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let new_sess: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(new_sess["method"], "session/new");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": new_sess["id"],
                            "result": { "sessionId": "ext-acp-1" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let prompt: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(prompt["method"], "session/prompt");

            s_write
                .write_all(
                    format!(
                        "{}\n{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": 9001,
                            "method": "fs/read_text_file",
                            "params": { "path": "hello.txt" }
                        }),
                        json!({
                            "jsonrpc": "2.0",
                            "id": 9002,
                            "method": "fs/read_text_file",
                            "params": { "path": "../../secret.txt" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let mut fs_replies = HashMap::new();
            for _ in 0..2 {
                let r: Value =
                    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                fs_replies.insert(r["id"].as_u64().unwrap(), r);
            }
            assert_eq!(fs_replies[&9001]["result"]["content"], "hello world");
            assert!(fs_replies[&9002]["error"].is_object());

            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": 9003,
                            "method": "session/request_permission",
                            "params": {
                                "sessionId": "ext-acp-1",
                                "toolCall": { "toolCallId": "tc1", "title": "run tests", "kind": "execute" },
                                "options": [
                                    { "optionId": "custom-allow", "name": "Allow once", "kind": "allow_once" },
                                    { "optionId": "custom-deny", "name": "Deny", "kind": "reject_once" }
                                ]
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let perm_reply: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(perm_reply["id"], 9003);
            assert_eq!(perm_reply["result"]["outcome"]["optionId"], "custom-allow");

            s_write
                .write_all(
                    format!(
                        "{}\n{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": "ext-acp-1",
                                "update": {
                                    "sessionUpdate": "agent_message_chunk",
                                    "content": { "type": "text", "text": "All done." }
                                }
                            }
                        }),
                        json!({
                            "jsonrpc": "2.0",
                            "id": prompt["id"],
                            "result": { "stopReason": "end_turn" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let session = AcpSession::connect_io(
            c_read,
            c_write,
            None,
            DriverSessionOpen {
                session_id,
                project_dir: dir.to_string_lossy().into_owned(),
                external_session_id: None,
                mode: TurnMode::Build,
                model: None,
                mcp_servers: Vec::new(),
                interactive: true,
            },
            approvals,
        )
        .await
        .unwrap();

        assert_eq!(session.external_session_id().as_deref(), Some("ext-acp-1"));
        let (tx, mut rx) = mpsc::channel(64);
        let cwd_str = dir.to_string_lossy().into_owned();
        let turn_task = tokio::spawn(async move {
            session
                .start_turn(
                    DriverTurnRequest {
                        session_id,
                        turn_id: TurnId::new(),
                        prompt: Message::user("check hello.txt"),
                        model: None,
                        thinking_level: None,
                        mode: TurnMode::Build,
                        cwd: cwd_str,
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
                    assert_eq!(options[0].id, "custom-allow");
                    assert!(approvals_reply.respond(agente_protocol::ApprovalDecision {
                        request_id,
                        decision: ApprovalDecisionKind::ApproveOnce,
                        option_id: Some("custom-allow".into()),
                    }));
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
        assert_eq!(final_text, "All done.");
        turn_task.await.unwrap();
        mock_agent.await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn acp_cancel_unblocks_pending_permission() {
        let dir = std::env::temp_dir().join(format!("agente-acp-cancel-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();

        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (c_read, c_write) = tokio::io::split(client_side);
        let (s_read, mut s_write) = tokio::io::split(server_side);

        let session_id = SessionId::new();
        let approvals = ApprovalRouter::new();

        let mock_agent = tokio::spawn(async move {
            let mut lines = BufReader::new(s_read).lines();
            let init: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": init["id"],
                            "result": { "protocolVersion": 1, "agentCapabilities": {} }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let new_sess: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": new_sess["id"],
                            "result": { "sessionId": "ext-acp-cancel" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let prompt: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();

            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": 77,
                            "method": "session/request_permission",
                            "params": {
                                "sessionId": "ext-acp-cancel",
                                "toolCall": { "toolCallId": "tc1", "title": "shell rm", "kind": "execute" },
                                "options": [{ "optionId": "allow", "name": "Allow", "kind": "allow_once" }]
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            // Expect permission cancel reply and session/cancel notification (either order)
            let mut got_perm_reply = false;
            let mut got_cancel_note = false;
            while !(got_perm_reply && got_cancel_note) {
                let frame: Value =
                    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                if frame.get("id") == Some(&json!(77)) {
                    assert_eq!(frame["result"]["outcome"]["outcome"], "cancelled");
                    got_perm_reply = true;
                } else if frame.get("method") == Some(&json!("session/cancel")) {
                    got_cancel_note = true;
                }
            }

            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": prompt["id"],
                            "result": { "stopReason": "cancelled" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let session = Arc::new(
            AcpSession::connect_io(
                c_read,
                c_write,
                None,
                DriverSessionOpen {
                    session_id,
                    project_dir: dir.to_string_lossy().into_owned(),
                    external_session_id: None,
                    mode: TurnMode::Build,
                    model: None,
                    mcp_servers: Vec::new(),
                    interactive: true,
                },
                approvals,
            )
            .await
            .unwrap(),
        );

        let (tx, mut rx) = mpsc::channel(64);
        let run_sess = Arc::clone(&session);
        let turn_id = TurnId::new();
        let cwd_str = dir.to_string_lossy().into_owned();
        let turn_task = tokio::spawn(async move {
            run_sess
                .start_turn(
                    DriverTurnRequest {
                        session_id,
                        turn_id,
                        prompt: Message::user("do something"),
                        model: None,
                        thinking_level: None,
                        mode: TurnMode::Build,
                        cwd: cwd_str,
                        mcp_servers: Vec::new(),
                    },
                    tx,
                )
                .await
                .unwrap();
        });

        while let Some(ev) = rx.recv().await {
            match ev {
                DriverEvent::Runtime(RuntimeEvent::ApprovalRequested { .. }) => {
                    assert!(session.cancel(turn_id).await);
                }
                DriverEvent::TurnComplete { status, .. } => {
                    assert_eq!(status, TurnStatus::Cancelled);
                    break;
                }
                _ => {}
            }
        }
        turn_task.await.unwrap();
        mock_agent.await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn acp_mcp_servers_uses_http_when_supported_else_stdio_bridge() {
        let servers = vec![InjectedMcpServer {
            name: "agente-orchestrator".into(),
            url: "http://127.0.0.1:43210/mcp".into(),
            bearer_token: Some("secret-token".into()),
        }];

        let http = acp_mcp_servers_for_caps(&servers, true);
        assert_eq!(http.len(), 1);
        assert_eq!(http[0]["type"], "http");
        assert_eq!(http[0]["url"], "http://127.0.0.1:43210/mcp");
        assert_eq!(http[0]["headers"][0]["name"], "Authorization");
        assert_eq!(http[0]["headers"][0]["value"], "Bearer secret-token");

        let stdio = acp_mcp_servers_for_caps(&servers, false);
        assert_eq!(stdio.len(), 1);
        assert_eq!(stdio[0]["name"], "agente-orchestrator");
        assert!(stdio[0].get("type").is_none());
        assert_eq!(
            stdio[0]["args"],
            json!(["mcp-bridge", "--url", "http://127.0.0.1:43210/mcp"])
        );
        assert_eq!(stdio[0]["env"][0]["name"], "AGENTE_MCP_BEARER_TOKEN");
        assert_eq!(stdio[0]["env"][0]["value"], "secret-token");
    }

    #[test]
    fn parses_acp_models_from_config_options_flat_and_grouped_with_thoughts() {
        let session_result = json!({
            "sessionId": "s-1",
            "configOptions": [
                {
                    "id": "thought_level",
                    "category": "thought_level",
                    "options": [
                        { "value": "low", "name": "Low" },
                        { "value": "high", "name": "High" }
                    ]
                },
                {
                    "id": "model",
                    "category": "model",
                    "currentValue": "gemini-3-pro",
                    "options": [
                        { "value": "gemini-3-flash", "name": "Gemini 3 Flash" },
                        {
                            "group": "Pro",
                            "options": [
                                { "value": "gemini-3-pro", "name": "Gemini 3 Pro" }
                            ]
                        }
                    ]
                }
            ]
        });

        assert_eq!(
            extract_acp_model_config_id(&session_result).as_deref(),
            Some("model")
        );
        let models = parse_acp_models(&session_result);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gemini-3-flash");
        assert!(!models[0].is_default);
        assert_eq!(models[0].thinking_levels, vec!["low", "high"]);
        assert_eq!(models[1].id, "gemini-3-pro");
        assert_eq!(models[1].label, "Gemini 3 Pro");
        assert!(models[1].is_default);
    }

    #[test]
    fn opencode_effort_option_becomes_thinking_levels_without_default() {
        // What `opencode acp` (v2.4) answers to `session/new`: the effort
        // option is `effort` in the `thought_level` category, and lists
        // "default" beside the real levels.
        let session_result = json!({
            "sessionId": "s-oc",
            "configOptions": [
                {
                    "id": "model",
                    "category": "model",
                    "currentValue": "opencode/big-pickle",
                    "options": [{ "value": "opencode/big-pickle", "name": "Big Pickle" }]
                },
                {
                    "id": "effort",
                    "category": "thought_level",
                    "currentValue": "default",
                    "options": [
                        { "value": "minimal" }, { "value": "low" }, { "value": "medium" },
                        { "value": "high" }, { "value": "xhigh" }, { "value": "max" },
                        { "value": "default" }
                    ]
                }
            ]
        });

        assert_eq!(extract_acp_thinking_config_id(&session_result).as_deref(), Some("effort"));
        let models = parse_acp_models(&session_result);
        assert_eq!(models[0].thinking_levels, vec!["minimal", "low", "medium", "high", "xhigh", "max"]);
    }

    #[test]
    fn parses_acp_models_from_legacy_available_models_and_modes() {
        let session_result = json!({
            "sessionId": "s-2",
            "models": {
                "currentModelId": "gpt-6-luna",
                "availableModels": [
                    { "modelId": "gpt-4.1", "name": "GPT-4.1" },
                    { "modelId": "gpt-6-luna", "name": "GPT-6 Luna" }
                ]
            },
            "modes": {
                "availableModes": [
                    { "id": "https://agentclientprotocol.com#agent", "name": "Agent" },
                    { "id": "https://agentclientprotocol.com#plan", "name": "Plan" }
                ]
            }
        });

        assert_eq!(extract_acp_model_config_id(&session_result), None);
        let models = parse_acp_models(&session_result);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-4.1");
        assert!(!models[0].is_default);
        assert_eq!(models[1].id, "gpt-6-luna");
        assert!(models[1].is_default);

        assert_eq!(
            extract_acp_mode_target(&session_result, TurnMode::Plan),
            Some((None, "https://agentclientprotocol.com#plan".to_string()))
        );
        assert_eq!(
            extract_acp_mode_target(&session_result, TurnMode::Build),
            Some((None, "https://agentclientprotocol.com#agent".to_string()))
        );
    }

    #[test]
    fn detects_acp_auth_error_and_formats_hint() {
        let err = JsonRpcError {
            code: -32000,
            message: "Authentication required".into(),
            data: Some(json!({
                "details": "Use CLI to authenticate first.",
                "authMethods": [
                    { "name": "OAuth", "description": "Sign in via browser" }
                ]
            })),
        };
        assert!(is_acp_auth_error(&err));
        let hint = format_acp_auth_hint(&err, None, Some("Run `qwen` in terminal."));
        assert!(hint.contains("Use CLI to authenticate first."));
        assert!(hint.contains("Run `qwen` in terminal."));
    }

    #[test]
    fn parses_opencode_models_output_stripping_ansi_and_noise() {
        let raw = "\u{1b}[32manthropic/claude-sonnet-4-5\u{1b}[0m\nopenai/gpt-5.4\nhttps://example.com\n# heading\nopenai/gpt-5.4\n  \n";
        let models = parse_opencode_models_output(raw);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "anthropic/claude-sonnet-4-5");
        assert_eq!(models[1].id, "openai/gpt-5.4");
    }

    #[tokio::test]
    async fn acp_connect_applies_config_option_model_and_mode() {
        let dir =
            std::env::temp_dir().join(format!("agente-acp-cfg-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();

        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (c_read, c_write) = tokio::io::split(client_side);
        let (s_read, mut s_write) = tokio::io::split(server_side);

        let mock_agent = tokio::spawn(async move {
            let mut lines = BufReader::new(s_read).lines();
            let init: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": init["id"],
                            "result": { "protocolVersion": 1, "agentCapabilities": {} }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let new_sess: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": new_sess["id"],
                            "result": {
                                "sessionId": "ext-cfg-1",
                                "configOptions": [
                                    {
                                        "id": "model_cfg",
                                        "category": "model",
                                        "currentValue": "m1",
                                        "options": [{ "value": "m1", "name": "Model 1" }, { "value": "m2", "name": "Model 2" }]
                                    }
                                ],
                                "modes": {
                                    "availableModes": [{ "id": "plan", "name": "Plan" }]
                                }
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let set_mode: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(set_mode["method"], "session/set_mode");
            assert_eq!(set_mode["params"]["modeId"], "plan");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({ "jsonrpc": "2.0", "id": set_mode["id"], "result": {} })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let set_cfg: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(set_cfg["method"], "session/set_config_option");
            assert_eq!(set_cfg["params"]["configId"], "model_cfg");
            assert_eq!(set_cfg["params"]["value"], "m2");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({ "jsonrpc": "2.0", "id": set_cfg["id"], "result": {} })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let session = AcpSession::connect_io(
            c_read,
            c_write,
            None,
            DriverSessionOpen {
                session_id: SessionId::new(),
                project_dir: dir.to_string_lossy().into_owned(),
                external_session_id: None,
                mode: TurnMode::Plan,
                model: Some("m2".into()),
                mcp_servers: Vec::new(),
                interactive: true,
            },
            ApprovalRouter::new(),
        )
        .await
        .unwrap();
        assert_eq!(session.external_session_id().as_deref(), Some("ext-cfg-1"));
        mock_agent.await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn acp_start_turn_applies_thought_level_config_option() {
        let dir =
            std::env::temp_dir().join(format!("agente-acp-think-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();

        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (c_read, c_write) = tokio::io::split(client_side);
        let (s_read, mut s_write) = tokio::io::split(server_side);

        let mock_agent = tokio::spawn(async move {
            let mut lines = BufReader::new(s_read).lines();
            let init: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": init["id"],
                            "result": { "protocolVersion": 1, "agentCapabilities": {} }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let new_sess: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": new_sess["id"],
                            "result": {
                                "sessionId": "ext-think-1",
                                "configOptions": [
                                    {
                                        "id": "thought_cfg",
                                        "category": "thought_level",
                                        "currentValue": "low",
                                        "options": [
                                            { "value": "low", "name": "Low" },
                                            { "value": "high", "name": "High" }
                                        ]
                                    }
                                ]
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let set_think: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(set_think["method"], "session/set_config_option");
            assert_eq!(set_think["params"]["configId"], "thought_cfg");
            assert_eq!(set_think["params"]["value"], "high");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({ "jsonrpc": "2.0", "id": set_think["id"], "result": {} })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let prompt: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(prompt["method"], "session/prompt");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": prompt["id"],
                            "result": { "stopReason": "end_turn" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let session_id = SessionId::new();
        let session = AcpSession::connect_io(
            c_read,
            c_write,
            None,
            DriverSessionOpen {
                session_id,
                project_dir: dir.to_string_lossy().into_owned(),
                external_session_id: None,
                mode: TurnMode::Build,
                model: None,
                mcp_servers: Vec::new(),
                interactive: true,
            },
            ApprovalRouter::new(),
        )
        .await
        .unwrap();

        let (tx, mut rx) = mpsc::channel(16);
        let cwd_str = dir.to_string_lossy().into_owned();
        session
            .start_turn(
                DriverTurnRequest {
                    session_id,
                    turn_id: TurnId::new(),
                    prompt: Message::user("think hard"),
                    model: None,
                    thinking_level: Some("high".into()),
                    mode: TurnMode::Build,
                    cwd: cwd_str,
                    mcp_servers: Vec::new(),
                },
                tx,
            )
            .await
            .unwrap();
        while let Some(ev) = rx.recv().await {
            if matches!(ev, DriverEvent::TurnComplete { .. }) {
                break;
            }
        }
        mock_agent.await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn acp_session_handles_elicitation_late_raw_input_and_usage() {
        let dir = std::env::temp_dir().join(format!(
            "agente-acp-elicit-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (c_read, c_write) = tokio::io::split(client_side);
        let (s_read, mut s_write) = tokio::io::split(server_side);

        let session_id = SessionId::new();
        let approvals = ApprovalRouter::new();
        let approvals_reply = approvals.clone();

        let mock_agent = tokio::spawn(async move {
            let mut lines = BufReader::new(s_read).lines();
            let init: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(init["method"], "initialize");
            assert!(
                init["params"]["clientCapabilities"]["elicitation"]["form"].is_object(),
                "interactive ACP client must advertise elicitation.form"
            );
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": init["id"],
                            "result": { "protocolVersion": 1, "agentCapabilities": {} }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let new_sess: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": new_sess["id"],
                            "result": { "sessionId": "ext-elicit-1" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let prompt: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();

            // 1. Initial pending tool_call with empty rawInput, followed by tool_call_update carrying rawInput
            s_write
                .write_all(
                    format!(
                        "{}\n{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": "ext-elicit-1",
                                "update": {
                                    "sessionUpdate": "tool_call",
                                    "toolCallId": "q-call-1",
                                    "title": "question",
                                    "kind": "other",
                                    "status": "pending",
                                    "rawInput": {}
                                }
                            }
                        }),
                        json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": "ext-elicit-1",
                                "update": {
                                    "sessionUpdate": "tool_call_update",
                                    "toolCallId": "q-call-1",
                                    "title": "question",
                                    "status": "in_progress",
                                    "rawInput": { "questions": [{ "question": "Pick a color", "header": "Color" }] }
                                }
                            }
                        }),
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            // 2. elicitation/create request
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": 91,
                            "method": "elicitation/create",
                            "params": {
                                "mode": "form",
                                "sessionId": "ext-elicit-1",
                                "toolCallId": "q-call-1",
                                "message": "Questions",
                                "requestedSchema": {
                                    "type": "object",
                                    "properties": {
                                        "q0": {
                                            "type": "string",
                                            "title": "Color",
                                            "oneOf": [{ "const": "Blue", "title": "Blue" }]
                                        }
                                    }
                                }
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let elicit_reply: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(elicit_reply["id"], 91);
            assert_eq!(elicit_reply["result"]["action"], "accept");
            assert_eq!(elicit_reply["result"]["content"]["q0"], "Blue");

            // 3. Complete tool, report usage_update, then prompt result with token usage
            s_write
                .write_all(
                    format!(
                        "{}\n{}\n{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": "ext-elicit-1",
                                "update": {
                                    "sessionUpdate": "tool_call_update",
                                    "toolCallId": "q-call-1",
                                    "status": "completed",
                                    "content": [{ "type": "content", "content": { "type": "text", "text": "Blue" } }]
                                }
                            }
                        }),
                        json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": "ext-elicit-1",
                                "update": {
                                    "sessionUpdate": "usage_update",
                                    "used": 1200,
                                    "size": 100000,
                                    "cost": { "amount": 0.0, "currency": "USD" }
                                }
                            }
                        }),
                        json!({
                            "jsonrpc": "2.0",
                            "id": prompt["id"],
                            "result": {
                                "stopReason": "end_turn",
                                "usage": {
                                    "inputTokens": 400,
                                    "outputTokens": 25,
                                    "cachedReadTokens": 800,
                                    "totalTokens": 1225
                                }
                            }
                        }),
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let session = AcpSession::connect_io(
            c_read,
            c_write,
            None,
            DriverSessionOpen {
                session_id,
                project_dir: dir.to_string_lossy().into_owned(),
                external_session_id: None,
                mode: TurnMode::Build,
                model: None,
                mcp_servers: Vec::new(),
                interactive: true,
            },
            approvals,
        )
        .await
        .unwrap();

        let (tx, mut rx) = mpsc::channel(64);
        let cwd_str = dir.to_string_lossy().into_owned();
        let turn_task = tokio::spawn(async move {
            session
                .start_turn(
                    DriverTurnRequest {
                        session_id,
                        turn_id: TurnId::new(),
                        prompt: Message::user("Ask a color"),
                        model: None,
                        thinking_level: None,
                        mode: TurnMode::Build,
                        cwd: cwd_str,
                        mcp_servers: Vec::new(),
                    },
                    tx,
                )
                .await
                .unwrap();
        });

        let mut proposed_args = Vec::new();
        let mut saw_budget = false;
        let mut saw_usage = false;
        let mut final_tokens = 0u32;

        while let Some(ev) = rx.recv().await {
            match ev {
                DriverEvent::Runtime(RuntimeEvent::ToolProposed { name, arguments, .. }) => {
                    assert_eq!(name, "question");
                    proposed_args.push(arguments);
                }
                DriverEvent::Runtime(RuntimeEvent::InputRequested {
                    request_id,
                    message,
                    schema,
                    ..
                }) => {
                    assert_eq!(message, "Questions");
                    assert!(schema["properties"]["q0"].is_object());
                    assert!(approvals_reply.respond_input(agente_protocol::InputResponse {
                        request_id,
                        action: InputResponseAction::Accept,
                        content: Some(json!({ "q0": "Blue" })),
                    }));
                }
                DriverEvent::Runtime(RuntimeEvent::ContextBudget { used, room, .. }) => {
                    assert_eq!(used, 1200);
                    assert_eq!(room, 100000);
                    saw_budget = true;
                }
                DriverEvent::Runtime(RuntimeEvent::Usage { usage }) => {
                    assert_eq!(usage.prompt_tokens, 400);
                    assert_eq!(usage.completion_tokens, 25);
                    assert_eq!(usage.cache_read_tokens, 800);
                    assert_eq!(usage.context_tokens, 1200);
                    saw_usage = true;
                }
                DriverEvent::TurnComplete { tokens, .. } => {
                    final_tokens = tokens;
                    break;
                }
                _ => {}
            }
        }

        assert_eq!(proposed_args.len(), 2);
        assert_eq!(proposed_args[0], "{}");
        assert!(proposed_args[1].contains("Pick a color"));
        assert!(saw_budget);
        assert!(saw_usage);
        assert_eq!(final_tokens, 1225);

        turn_task.await.unwrap();
        mock_agent.await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    #[ignore = "spawns locally installed opencode CLI with free model opencode/beam-free"]
    async fn acp_live_opencode_question_and_free_model() {
        let dir = std::env::temp_dir().join(format!(
            "agente-opencode-live-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let instance = crate::config::DriversConfig::default()
            .resolve_all()
            .unwrap()
            .into_iter()
            .find(|d| d.instance_id == "opencode")
            .expect("builtin opencode driver");
        let driver = AcpDriver::new(instance);
        let session_id = SessionId::new();
        let approvals = ApprovalRouter::new();
        let session = driver
            .open_session(
                DriverSessionOpen {
                    session_id,
                    project_dir: dir.to_string_lossy().into_owned(),
                    external_session_id: None,
                    mode: TurnMode::Build,
                    model: Some("opencode/beam-free".to_string()),
                    mcp_servers: Vec::new(),
                    interactive: true,
                },
                approvals.clone(),
            )
            .await
            .expect("open opencode session");

        let (tx, mut rx) = mpsc::channel(128);
        let cwd_str = dir.to_string_lossy().into_owned();
        let run_session = Arc::clone(&session);
        let turn_task = tokio::spawn(async move {
            run_session
                .start_turn(
                    DriverTurnRequest {
                        session_id,
                        turn_id: TurnId::new(),
                        prompt: Message::user(
                            "Call the question tool once asking for a color with options Red and Blue, then reply confirming the chosen color in one sentence.",
                        ),
                        model: Some("opencode/beam-free".to_string()),
                        thinking_level: None,
                        mode: TurnMode::Build,
                        cwd: cwd_str,
                        mcp_servers: Vec::new(),
                    },
                    tx,
                )
                .await
        });

        let mut saw_question_input = false;
        let mut saw_elicitation = false;
        let mut completed_ok = false;

        let deadline = tokio::time::sleep(Duration::from_secs(60));
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                _ = &mut deadline => panic!("timed out waiting for opencode/beam-free live elicitation turn"),
                maybe_ev = rx.recv() => {
                    let Some(ev) = maybe_ev else { break };
                    match ev {
                        DriverEvent::Runtime(RuntimeEvent::ToolProposed { name, arguments, .. }) => {
                            if name == "question" && arguments.contains("questions") {
                                saw_question_input = true;
                            }
                        }
                        DriverEvent::Runtime(RuntimeEvent::InputRequested { request_id, schema, .. }) => {
                            saw_elicitation = true;
                            let mut answers = serde_json::Map::new();
                            if let Some(props) = schema.get("properties").and_then(Value::as_object) {
                                for (key, prop) in props {
                                    if key.ends_with("_custom") {
                                        continue;
                                    }
                                    if let Some(first) = prop.get("oneOf")
                                        .and_then(Value::as_array)
                                        .and_then(|arr| arr.first())
                                        .and_then(|item| item.get("const"))
                                        .cloned()
                                    {
                                        answers.insert(key.clone(), first);
                                    } else if let Some(first) = prop.pointer("/items/anyOf/0/const").cloned() {
                                        answers.insert(key.clone(), Value::Array(vec![first]));
                                    } else if prop.get("type").and_then(Value::as_str) == Some("string") {
                                        answers.insert(key.clone(), Value::String("Red".to_string()));
                                    }
                                }
                            }
                            assert!(approvals.respond_input(agente_protocol::InputResponse {
                                request_id,
                                action: InputResponseAction::Accept,
                                content: Some(Value::Object(answers)),
                            }));
                        }
                        DriverEvent::Runtime(RuntimeEvent::ToolResult { name, content, is_error, .. }) => {
                            if name == "question" {
                                assert!(!is_error, "question tool unexpectedly failed: {content}");
                            }
                        }
                        DriverEvent::TurnComplete { status, .. } => {
                            completed_ok = status == TurnStatus::Completed;
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        let _ = session.close().await;
        turn_task.await.unwrap().expect("opencode turn completed");
        assert!(saw_elicitation, "expected opencode to send elicitation/create");
        assert!(saw_question_input, "expected question tool rawInput from tool_call_update");
        assert!(completed_ok);
        let _ = std::fs::remove_dir_all(dir);
    }
}
