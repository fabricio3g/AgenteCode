//! Claude Code CLI driver using bidirectional NDJSON `stream-json`.
//!
//! Launches `claude -p --input-format stream-json --output-format stream-json
//! --verbose --permission-prompt-tool stdio` directly without shell wrapping,
//! bridges `can_use_tool` control requests through [`ApprovalRouter`], and
//! normalizes tool calls, deltas, usage, cost, and rate-limit errors into
//! [`RuntimeEvent`]s.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agente_protocol::{
    rpc, ApprovalDecisionKind, ApprovalOption, DriverCapabilities, DriverInfo, DriverKind,
    DriverModel, DriverStatus, Message, RuntimeEvent, SessionId, TurnId, TurnMode, TurnStatus,
    Usage,
};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use uuid::Uuid;

use crate::config::ResolvedInstance;
use crate::process::{
    canonical_cwd, passive_probe, resolve_executable, JsonLineWriter, SpawnedStdio,
};
use crate::{
    effective_model, flatten_prompt_text, AgentDriver, ApprovalRouter, DriverError, DriverEvent,
    DriverSession, DriverSessionOpen, DriverTurnRequest, InjectedMcpServer,
};

const CLAUDE_MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
const CLAUDE_AUTH_HINT: &str = "Run `claude auth login` in your terminal to sign in.";
const CLAUDE_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Driver backing the `claude` CLI and extended Claude profiles.
pub struct ClaudeDriver {
    instance: ResolvedInstance,
}

impl ClaudeDriver {
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
            compact: true,
            rewind_conversation: false,
            mcp_injection: true,
            session_import: false,
            attachments: Vec::new(),
            usage: true,
            cost: true,
        }
    }
}

/// Normalize an effort level for Claude Code's `--effort` CLI flag.
pub fn effective_claude_effort(level: Option<&str>) -> Option<&'static str> {
    let normalized = level.map(str::trim).unwrap_or("").to_ascii_lowercase();
    match normalized.as_str() {
        "minimal" | "low" => Some("low"),
        "medium" | "med" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

#[async_trait]
impl AgentDriver for ClaudeDriver {
    fn instance_id(&self) -> &str {
        &self.instance.instance_id
    }

    fn driver_kind(&self) -> DriverKind {
        DriverKind::Claude
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
            driver_kind: DriverKind::Claude,
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
        let live = probe_claude_live(&self.instance).await;
        if live.needs_auth {
            info.status = DriverStatus::NeedsAuth;
            info.auth_hint = Some(CLAUDE_AUTH_HINT.to_string());
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
        let program = self
            .instance
            .command
            .first()
            .map(String::as_str)
            .unwrap_or("claude");
        if resolve_executable(program).is_none() {
            return Err(DriverError::Unavailable(
                self.instance.instance_id.clone(),
                format!("executable '{program}' not found"),
            ));
        }
        Ok(Arc::new(ClaudeSession::lazy(
            self.instance.clone(),
            spec,
            approvals,
        )))
    }
}

struct TurnStreamState {
    sink: mpsc::Sender<DriverEvent>,
    done_tx: Option<oneshot::Sender<TurnOutcomeData>>,
    assistant_text: String,
    streamed_msg_ids: HashSet<String>,
    tool_names: HashMap<String, String>,
    cancelled: bool,
}

struct TurnOutcomeData {
    status: TurnStatus,
    assistant_text: String,
    tokens: u32,
    error: Option<String>,
}

struct LiveClaudeProcess {
    writer: JsonLineWriter,
    child: Option<SpawnedStdio>,
    reader_abort: tokio::task::AbortHandle,
    mode: TurnMode,
    model: Option<String>,
    thinking_level: Option<String>,
    alive: Arc<Mutex<bool>>,
}

struct ClaudeCore {
    session_id: SessionId,
    approvals: ApprovalRouter,
    external_session_id: Mutex<Option<String>>,
    active_turn: Mutex<Option<TurnStreamState>>,
}

/// Active or lazily-spawned Claude Code CLI session.
pub struct ClaudeSession {
    instance: Option<ResolvedInstance>,
    core: Arc<ClaudeCore>,
    live: AsyncMutex<Option<LiveClaudeProcess>>,
    turn_lock: AsyncMutex<()>,
}

impl ClaudeSession {
    fn lazy(
        instance: ResolvedInstance,
        spec: DriverSessionOpen,
        approvals: ApprovalRouter,
    ) -> Self {
        Self {
            instance: Some(instance),
            core: Arc::new(ClaudeCore {
                session_id: spec.session_id,
                approvals,
                external_session_id: Mutex::new(spec.external_session_id),
                active_turn: Mutex::new(None),
            }),
            live: AsyncMutex::new(None),
            turn_lock: AsyncMutex::new(()),
        }
    }

    /// Attach directly to an existing bidirectional NDJSON stream (for tests).
    pub fn from_io<R, W>(
        reader: R,
        writer: W,
        session_id: SessionId,
        external_session_id: Option<String>,
        mode: TurnMode,
        model: Option<String>,
        approvals: ApprovalRouter,
    ) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let core = Arc::new(ClaudeCore {
            session_id,
            approvals,
            external_session_id: Mutex::new(external_session_id),
            active_turn: Mutex::new(None),
        });
        let live = start_io_process(reader, writer, None, Arc::clone(&core), mode, model, None);
        Self {
            instance: None,
            core,
            live: AsyncMutex::new(Some(live)),
            turn_lock: AsyncMutex::new(()),
        }
    }

    async fn ensure_process(&self, req: &DriverTurnRequest) -> Result<JsonLineWriter, DriverError> {
        let mut live_guard = self.live.lock().await;
        let requested_model = effective_model(req.model.as_deref()).map(str::to_string);
        let requested_effort =
            effective_claude_effort(req.thinking_level.as_deref()).map(str::to_string);

        if let Some(existing) = live_guard.as_ref() {
            let is_alive = *existing.alive.lock().unwrap_or_else(|p| p.into_inner());
            let same_config = self.instance.is_none()
                || (existing.mode == req.mode
                    && existing.model == requested_model
                    && existing.thinking_level == requested_effort);
            if is_alive && same_config {
                return Ok(existing.writer.clone());
            }
        }

        if let Some(old) = live_guard.take() {
            old.reader_abort.abort();
            if let Some(child) = old.child {
                child.kill().await;
            }
        }

        let Some(instance) = &self.instance else {
            return Err(DriverError::Protocol("Claude stream closed".into()));
        };

        let mut args = vec![
            "-p".to_string(),
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--permission-prompt-tool".to_string(),
            "stdio".to_string(),
            "--permission-mode".to_string(),
            claude_permission_mode(req.mode).to_string(),
        ];
        if let Some(model) = &requested_model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        if let Some(effort) = &requested_effort {
            args.push("--effort".to_string());
            args.push(effort.clone());
        }
        if let Some(ext_id) = self.external_session_id() {
            args.push("--resume".to_string());
            args.push(ext_id);
        }
        if !req.mcp_servers.is_empty() {
            args.push("--mcp-config".to_string());
            args.push(build_mcp_config_json(&req.mcp_servers));
        }

        let cwd = canonical_cwd(&req.cwd);
        let (spawned, stdout, stdin) = SpawnedStdio::spawn(
            &instance.command,
            &args,
            &cwd,
            &instance.env,
            &instance.strip_env,
        )?;
        let proc_handle = start_io_process(
            stdout,
            stdin,
            Some(spawned),
            Arc::clone(&self.core),
            req.mode,
            requested_model,
            requested_effort,
        );
        let writer = proc_handle.writer.clone();
        *live_guard = Some(proc_handle);
        Ok(writer)
    }
}

fn start_io_process<R, W>(
    reader: R,
    writer: W,
    child: Option<SpawnedStdio>,
    core: Arc<ClaudeCore>,
    mode: TurnMode,
    model: Option<String>,
    thinking_level: Option<String>,
) -> LiveClaudeProcess
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let writer = JsonLineWriter::spawn(writer);
    let writer_for_reader = writer.clone();
    let alive = Arc::new(Mutex::new(true));
    let alive_flag = Arc::clone(&alive);

    let reader_task = tokio::spawn(async move {
        let mut lines = BufReader::new(reader);
        let close_err = loop {
            match rpc::read_bounded_line(&mut lines, CLAUDE_MAX_LINE_BYTES).await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(frame) => handle_claude_frame(&core, &writer_for_reader, frame),
                        Err(_) => {
                            tracing::debug!(line = %line, "ignoring non-JSON line from claude stdout");
                        }
                    }
                }
                Ok(None) => break None,
                Err(error) => break Some(error.to_string()),
            }
        };
        *alive_flag.lock().unwrap_or_else(|p| p.into_inner()) = false;
        core.approvals.cancel_session(core.session_id);
        let finished = core.active_turn.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(mut turn) = finished {
            if let Some(tx) = turn.done_tx.take() {
                let status = if turn.cancelled {
                    TurnStatus::Cancelled
                } else {
                    TurnStatus::Failed
                };
                let _ = tx.send(TurnOutcomeData {
                    status,
                    assistant_text: turn.assistant_text,
                    tokens: 0,
                    error: if turn.cancelled {
                        None
                    } else {
                        Some(
                            close_err
                                .unwrap_or_else(|| "Claude CLI exited before completing turn".into()),
                        )
                    },
                });
            }
        }
    });

    LiveClaudeProcess {
        writer,
        child,
        reader_abort: reader_task.abort_handle(),
        mode,
        model,
        thinking_level,
        alive,
    }
}

fn handle_claude_frame(core: &Arc<ClaudeCore>, writer: &JsonLineWriter, frame: Value) {
    let kind = frame.get("type").and_then(Value::as_str).unwrap_or("");
    if let Some(sid) = frame.get("session_id").and_then(Value::as_str) {
        let mut ext = core
            .external_session_id
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if ext.as_deref() != Some(sid) {
            *ext = Some(sid.to_string());
            let turn = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(t) = turn.as_ref() {
                let _ = t
                    .sink
                    .try_send(DriverEvent::ExternalSessionBound(sid.to_string()));
            }
        }
    }

    match kind {
        "system" => {}
        "stream_event" => {
            let Some(event) = frame.get("event") else {
                return;
            };
            let ev_type = event.get("type").and_then(Value::as_str).unwrap_or("");
            if ev_type == "message_start" {
                if let Some(id) = event.pointer("/message/id").and_then(Value::as_str) {
                    let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(turn) = guard.as_mut() {
                        turn.streamed_msg_ids.insert(id.to_string());
                    }
                }
            } else if ev_type == "content_block_delta" {
                let Some(delta) = event.get("delta") else {
                    return;
                };
                let d_type = delta.get("type").and_then(Value::as_str).unwrap_or("");
                if d_type == "text_delta" {
                    if let Some(text) = delta.get("text").and_then(Value::as_str) {
                        let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
                        if let Some(turn) = guard.as_mut() {
                            turn.assistant_text.push_str(text);
                            let _ = turn.sink.try_send(DriverEvent::Runtime(
                                RuntimeEvent::AssistantDelta {
                                    text: text.to_string(),
                                },
                            ));
                        }
                    }
                } else if d_type == "thinking_delta" {
                    if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                        let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
                        if let Some(turn) = guard.as_mut() {
                            let _ = turn.sink.try_send(DriverEvent::Runtime(
                                RuntimeEvent::ReasoningDelta {
                                    text: text.to_string(),
                                },
                            ));
                        }
                    }
                }
            }
        }
        "assistant" => {
            let msg = frame.get("message");
            let msg_id = msg
                .and_then(|m| m.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(blocks) = msg.and_then(|m| m.get("content")).and_then(Value::as_array) else {
                return;
            };
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            let Some(turn) = guard.as_mut() else {
                return;
            };
            let already_streamed = !msg_id.is_empty() && turn.streamed_msg_ids.contains(msg_id);
            for block in blocks {
                let b_type = block.get("type").and_then(Value::as_str).unwrap_or("");
                match b_type {
                    "text" if !already_streamed => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                turn.assistant_text.push_str(text);
                                let _ = turn.sink.try_send(DriverEvent::Runtime(
                                    RuntimeEvent::AssistantDelta {
                                        text: text.to_string(),
                                    },
                                ));
                            }
                        }
                    }
                    "thinking" if !already_streamed => {
                        if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                            if !text.is_empty() {
                                let _ = turn.sink.try_send(DriverEvent::Runtime(
                                    RuntimeEvent::ReasoningDelta {
                                        text: text.to_string(),
                                    },
                                ));
                            }
                        }
                    }
                    "tool_use" => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let raw_name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        let name = normalize_claude_tool_name(raw_name).to_string();
                        let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                        turn.tool_names.insert(id.clone(), name.clone());
                        let _ = turn.sink.try_send(DriverEvent::Runtime(
                            RuntimeEvent::ToolProposed {
                                id,
                                name: name.clone(),
                                arguments: input.to_string(),
                            },
                        ));
                        if name == "todo_write" {
                            if let Some(todos) = input.get("todos") {
                                let _ = turn.sink.try_send(DriverEvent::Runtime(
                                    RuntimeEvent::TodoChanged {
                                        todos: todos.clone(),
                                    },
                                ));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        "user" => {
            let Some(blocks) = frame.pointer("/message/content").and_then(Value::as_array) else {
                return;
            };
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            let Some(turn) = guard.as_mut() else {
                return;
            };
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let id = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let name = turn
                    .tool_names
                    .remove(&id)
                    .unwrap_or_else(|| "tool".to_string());
                let content = extract_tool_result_text(block.get("content"));
                let is_error = block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let _ = turn
                    .sink
                    .try_send(DriverEvent::Runtime(RuntimeEvent::ToolResult {
                        id,
                        name,
                        content,
                        is_error,
                    }));
            }
        }
        "control_request" => {
            let Some(req) = frame.get("request") else {
                return;
            };
            if req.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
                return;
            }
            let claude_req_id = frame
                .get("request_id")
                .or_else(|| req.get("request_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if claude_req_id.is_empty() {
                return;
            }
            let raw_tool = req
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let tool_name = normalize_claude_tool_name(raw_tool).to_string();
            let input = req.get("input").cloned().unwrap_or_else(|| json!({}));
            let file_path = input
                .get("file_path")
                .or_else(|| input.get("path"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let old_content = input
                .get("old_string")
                .and_then(Value::as_str)
                .map(str::to_string);
            let new_content = input
                .get("new_string")
                .or_else(|| input.get("content"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let is_dangerous = tool_name == "shell"
                && input
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(looks_dangerous_command);
            let description = req
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("Run {tool_name}"));

            let perm_id = format!("claude-perm-{}", Uuid::new_v4().simple());
            let rx = core.approvals.register(core.session_id, perm_id.clone());
            {
                let guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(turn) = guard.as_ref() {
                    let _ = turn.sink.try_send(DriverEvent::Runtime(
                        RuntimeEvent::ApprovalRequested {
                            request_id: perm_id,
                            source: "claude".to_string(),
                            tool_name,
                            tool_args: input.to_string(),
                            description,
                            is_dangerous,
                            file_path,
                            old_content,
                            new_content,
                            child_run_id: None,
                            options: vec![
                                ApprovalOption {
                                    id: "allow".to_string(),
                                    label: "Allow".to_string(),
                                    kind: ApprovalDecisionKind::ApproveOnce,
                                },
                                ApprovalOption {
                                    id: "deny".to_string(),
                                    label: "Deny".to_string(),
                                    kind: ApprovalDecisionKind::Deny,
                                },
                            ],
                        },
                    ));
                }
            }

            let writer_clone = writer.clone();
            tokio::spawn(async move {
                let decision = rx.await.ok();
                let allowed = matches!(
                    decision.map(|d| d.decision),
                    Some(ApprovalDecisionKind::ApproveOnce | ApprovalDecisionKind::ApproveAll)
                );
                let payload = if allowed {
                    json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": claude_req_id,
                            "response": {
                                "behavior": "allow",
                                "updatedInput": input,
                            }
                        }
                    })
                } else {
                    json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": claude_req_id,
                            "response": {
                                "behavior": "deny",
                                "message": "Permission denied by user",
                            }
                        }
                    })
                };
                let _ = writer_clone.send(payload);
            });
        }
        "result" => {
            let usage_obj = frame.get("usage");
            let prompt_tokens = usage_obj
                .and_then(|u| u.get("input_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            let completion_tokens = usage_obj
                .and_then(|u| u.get("output_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            let cache_read_tokens = usage_obj
                .and_then(|u| u.get("cache_read_input_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            let cache_creation_tokens = usage_obj
                .and_then(|u| u.get("cache_creation_input_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            let context_tokens = prompt_tokens
                .saturating_add(cache_read_tokens)
                .saturating_add(cache_creation_tokens);
            let usage = Usage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                context_tokens,
            };
            let total_tokens = context_tokens.saturating_add(completion_tokens);
            let cost_usd = frame.get("total_cost_usd").and_then(Value::as_f64);
            let is_error = frame
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || frame.get("subtype").and_then(Value::as_str) == Some("error_during_execution");
            let result_text = frame
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();

            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(mut turn) = guard.take() {
                if total_tokens > 0 {
                    let _ = turn
                        .sink
                        .try_send(DriverEvent::Runtime(RuntimeEvent::Usage {
                            usage: usage.clone(),
                        }));
                    let _ = turn
                        .sink
                        .try_send(DriverEvent::Runtime(RuntimeEvent::CallUsage {
                            usage,
                            cost_usd,
                            cost_estimated: false,
                        }));
                }
                if is_error && looks_like_usage_limit(&result_text) {
                    let _ = turn.sink.try_send(DriverEvent::Runtime(
                        RuntimeEvent::UsageLimitReached {
                            message: result_text.clone(),
                            reset_at: None,
                        },
                    ));
                }
                if !is_error && turn.assistant_text.is_empty() && !result_text.is_empty() {
                    turn.assistant_text = result_text.clone();
                    let _ = turn
                        .sink
                        .try_send(DriverEvent::Runtime(RuntimeEvent::AssistantDelta {
                            text: result_text.clone(),
                        }));
                }
                let status = if turn.cancelled {
                    TurnStatus::Cancelled
                } else if is_error {
                    TurnStatus::Failed
                } else {
                    TurnStatus::Completed
                };
                if let Some(tx) = turn.done_tx.take() {
                    let _ = tx.send(TurnOutcomeData {
                        status,
                        assistant_text: turn.assistant_text,
                        tokens: total_tokens,
                        error: is_error.then_some(if result_text.is_empty() {
                            "Claude turn failed".to_string()
                        } else {
                            result_text
                        }),
                    });
                }
            }
        }
        _ => {}
    }
}

#[async_trait]
impl DriverSession for ClaudeSession {
    async fn start_turn(
        &self,
        request: DriverTurnRequest,
        sink: mpsc::Sender<DriverEvent>,
    ) -> Result<(), DriverError> {
        let _turn_guard = self.turn_lock.lock().await;
        let writer = self.ensure_process(&request).await?;
        let (done_tx, done_rx) = oneshot::channel();
        {
            let mut active = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            *active = Some(TurnStreamState {
                sink: sink.clone(),
                done_tx: Some(done_tx),
                assistant_text: String::new(),
                streamed_msg_ids: HashSet::new(),
                tool_names: HashMap::new(),
                cancelled: false,
            });
        }

        let prompt_text = flatten_prompt_text(&request.prompt);
        if let Err(error) = writer.send(json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt_text,
            }
        })) {
            let _ = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take();
            return Err(error);
        }

        let outcome = done_rx.await.unwrap_or(TurnOutcomeData {
            status: TurnStatus::Failed,
            assistant_text: String::new(),
            tokens: 0,
            error: Some("Claude turn channel closed unexpectedly".into()),
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
        let live = self.live.lock().await;
        let Some(proc_handle) = live.as_ref() else {
            return false;
        };
        let has_turn = self
            .core
            .active_turn
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some();
        if !has_turn {
            return false;
        }
        proc_handle
            .writer
            .send(json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": flatten_prompt_text(&message),
                }
            }))
            .is_ok()
    }

    async fn cancel(&self, _turn_id: TurnId) -> bool {
        self.core.approvals.cancel_session(self.core.session_id);
        {
            let mut guard = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                turn.cancelled = true;
            }
        }
        let live = self.live.lock().await;
        let Some(proc_handle) = live.as_ref() else {
            return false;
        };
        proc_handle
            .writer
            .send(json!({
                "type": "control_request",
                "request_id": format!("int-{}", Uuid::new_v4().simple()),
                "request": { "subtype": "interrupt" }
            }))
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
        let mut live = self.live.lock().await;
        if let Some(proc_handle) = live.take() {
            proc_handle.reader_abort.abort();
            if let Some(child) = proc_handle.child {
                child.kill().await;
            }
        }
    }
}

fn claude_permission_mode(mode: TurnMode) -> &'static str {
    match mode {
        TurnMode::Plan => "plan",
        TurnMode::Build => "default",
        TurnMode::Auto => "bypassPermissions",
    }
}

fn build_mcp_config_json(servers: &[InjectedMcpServer]) -> String {
    let mut map = Map::new();
    for srv in servers {
        let mut entry = Map::new();
        entry.insert("type".to_string(), json!("http"));
        entry.insert("url".to_string(), json!(srv.url));
        if let Some(token) = &srv.bearer_token {
            entry.insert(
                "headers".to_string(),
                json!({ "Authorization": format!("Bearer {token}") }),
            );
        }
        map.insert(srv.name.clone(), Value::Object(entry));
    }
    json!({ "mcpServers": map }).to_string()
}

fn normalize_claude_tool_name(raw: &str) -> &str {
    match raw {
        "Bash" => "shell",
        "Read" => "read_file",
        "Edit" | "MultiEdit" => "edit_file",
        "Write" => "write_file",
        "Grep" => "grep",
        "Glob" => "find",
        "TodoWrite" => "todo_write",
        "WebFetch" => "web_fetch",
        "WebSearch" => "web_search",
        other => other,
    }
}

fn extract_tool_result_text(value: Option<&Value>) -> String {
    let Some(content) = value else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(arr) = content.as_array() {
        return arr
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
    }
    content.to_string()
}

fn looks_dangerous_command(cmd: &str) -> bool {
    let lower = cmd.to_ascii_lowercase();
    lower.contains("rm -rf")
        || lower.contains("git push --force")
        || lower.contains("git reset --hard")
        || lower.contains("drop table")
        || lower.contains("mkfs")
}

#[derive(Default)]
struct ClaudeProbeOutcome {
    models: Vec<DriverModel>,
    needs_auth: bool,
    error: Option<String>,
}

/// Parse models reported by Claude Code's `control_request: initialize` response.
pub fn parse_claude_initialize_models(payload: &Value) -> Vec<DriverModel> {
    let Some(items) = payload.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    let default_resolved = items.iter().find_map(|item| {
        let value = item.get("value").and_then(Value::as_str).map(str::trim)?;
        if value.eq_ignore_ascii_case("default") {
            item.get("resolvedModel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        } else {
            None
        }
    });

    let mut seen = HashSet::new();
    let mut marked_default = false;
    let mut out = Vec::new();
    for item in items {
        let Some(raw_id) = item.get("value").and_then(Value::as_str) else {
            continue;
        };
        let id = raw_id.trim();
        if id.is_empty() || id.eq_ignore_ascii_case("default") || !seen.insert(id.to_string()) {
            continue;
        }
        let label = item
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string();
        let resolved = item
            .get("resolvedModel")
            .and_then(Value::as_str)
            .map(str::trim);
        let is_default = !marked_default
            && default_resolved
                .as_deref()
                .zip(resolved)
                .is_some_and(|(a, b)| a == b);
        if is_default {
            marked_default = true;
        }
        let thinking_levels = item
            .get("supportedEffortLevels")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(Value::as_str)
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

fn looks_like_claude_auth_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("auth")
        || lower.contains("login")
        || lower.contains("logged out")
        || lower.contains("sign in")
        || lower.contains("unauthorized")
        || lower.contains("api key")
        || lower.contains("credentials")
}

async fn probe_claude_live(instance: &ResolvedInstance) -> ClaudeProbeOutcome {
    let args = vec![
        "-p".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-prompt-tool".to_string(),
        "stdio".to_string(),
    ];
    let temp_dir = std::env::temp_dir().to_string_lossy().into_owned();
    let Ok((spawned, stdout, stdin)) = SpawnedStdio::spawn(
        &instance.command,
        &args,
        &temp_dir,
        &instance.env,
        &instance.strip_env,
    ) else {
        return ClaudeProbeOutcome::default();
    };

    let writer = JsonLineWriter::spawn(stdin);
    if writer
        .send(json!({
            "type": "control_request",
            "request_id": "probe_init",
            "request": { "subtype": "initialize" }
        }))
        .is_err()
    {
        writer.close();
        drop(writer);
        spawned.shutdown_gracefully(Duration::from_millis(150)).await;
        return ClaudeProbeOutcome::default();
    }

    let read_outcome = tokio::time::timeout(CLAUDE_PROBE_TIMEOUT, async {
        let mut lines = BufReader::new(stdout);
        loop {
            match rpc::read_bounded_line(&mut lines, CLAUDE_MAX_LINE_BYTES).await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if frame.get("type").and_then(Value::as_str) != Some("control_response") {
                        continue;
                    }
                    let Some(resp) = frame.get("response") else {
                        continue;
                    };
                    if resp.get("request_id").and_then(Value::as_str) != Some("probe_init") {
                        continue;
                    }
                    if resp.get("subtype").and_then(Value::as_str) == Some("error") {
                        let msg = resp
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Claude initialize failed");
                        return ClaudeProbeOutcome {
                            needs_auth: looks_like_claude_auth_error(msg),
                            error: looks_like_claude_auth_error(msg).then(|| msg.to_string()),
                            models: Vec::new(),
                        };
                    }
                    let payload = resp.get("response").unwrap_or(&Value::Null);
                    let models = parse_claude_initialize_models(payload);
                    let account_missing = matches!(payload.get("account"), None | Some(Value::Null));
                    return ClaudeProbeOutcome {
                        needs_auth: account_missing && models.is_empty(),
                        error: None,
                        models,
                    };
                }
                Ok(None) | Err(_) => return ClaudeProbeOutcome::default(),
            }
        }
    })
    .await;

    writer.close();
    drop(writer);
    spawned.shutdown_gracefully(Duration::from_millis(150)).await;

    match read_outcome {
        Ok(outcome) => outcome,
        Err(_) => {
            tracing::debug!(instance = %instance.instance_id, "Claude live model probe timed out");
            ClaudeProbeOutcome::default()
        }
    }
}

fn looks_like_usage_limit(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("rate limit")
        || lower.contains("usage limit")
        || lower.contains("quota")
        || lower.contains("overloaded")
        || lower.contains("429")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn normalizes_claude_effort_levels() {
        assert_eq!(effective_claude_effort(None), None);
        assert_eq!(effective_claude_effort(Some("auto")), None);
        assert_eq!(effective_claude_effort(Some("off")), None);
        assert_eq!(effective_claude_effort(Some("minimal")), Some("low"));
        assert_eq!(effective_claude_effort(Some("low")), Some("low"));
        assert_eq!(effective_claude_effort(Some("med")), Some("medium"));
        assert_eq!(effective_claude_effort(Some("high")), Some("high"));
        assert_eq!(effective_claude_effort(Some("xhigh")), Some("xhigh"));
        assert_eq!(effective_claude_effort(Some("max")), Some("max"));
    }

    #[test]
    fn parses_claude_initialize_models_resolving_default_and_effort_levels() {
        let payload = json!({
            "models": [
                {
                    "value": "default",
                    "displayName": "Default (recommended)",
                    "resolvedModel": "claude-opus-5[1m]"
                },
                {
                    "value": "opus[1m]",
                    "displayName": "Opus",
                    "resolvedModel": "claude-opus-5[1m]",
                    "supportedEffortLevels": ["low", "medium", "high", "max"]
                },
                {
                    "value": "sonnet",
                    "displayName": "Sonnet",
                    "resolvedModel": "claude-sonnet-5",
                    "supportedEffortLevels": ["low", "medium", "high"]
                }
            ]
        });
        let models = parse_claude_initialize_models(&payload);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "opus[1m]");
        assert_eq!(models[0].label, "Opus");
        assert!(models[0].is_default);
        assert_eq!(
            models[0].thinking_levels,
            vec!["low", "medium", "high", "max"]
        );
        assert_eq!(models[1].id, "sonnet");
        assert!(!models[1].is_default);
    }

    #[tokio::test]
    async fn claude_stream_handles_deltas_tools_permissions_and_usage() {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (c_read, c_write) = tokio::io::split(client_side);
        let (s_read, mut s_write) = tokio::io::split(server_side);

        let session_id = SessionId::new();
        let approvals = ApprovalRouter::new();
        let approvals_reply = approvals.clone();

        let session = Arc::new(ClaudeSession::from_io(
            c_read,
            c_write,
            session_id,
            None,
            TurnMode::Build,
            None,
            approvals,
        ));

        let mock_cli = tokio::spawn(async move {
            let mut lines = BufReader::new(s_read).lines();
            let user_line: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(user_line["type"], "user");

            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "type": "system",
                            "subtype": "init",
                            "session_id": "claude-sess-42"
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            s_write
                .write_all(
                    format!(
                        "{}\n{}\n",
                        json!({
                            "type": "assistant",
                            "session_id": "claude-sess-42",
                            "message": {
                                "id": "m1",
                                "content": [{
                                    "type": "tool_use",
                                    "id": "tu-1",
                                    "name": "Bash",
                                    "input": { "command": "cargo test" }
                                }]
                            }
                        }),
                        json!({
                            "type": "control_request",
                            "request_id": "ctrl-1",
                            "request": {
                                "subtype": "can_use_tool",
                                "tool_name": "Bash",
                                "input": { "command": "cargo test" }
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let ctrl_resp: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ctrl_resp["type"], "control_response");
            assert_eq!(ctrl_resp["response"]["request_id"], "ctrl-1");
            assert_eq!(ctrl_resp["response"]["response"]["behavior"], "allow");

            s_write
                .write_all(
                    format!(
                        "{}\n{}\n{}\n{}\n{}\n",
                        json!({
                            "type": "user",
                            "message": {
                                "content": [{
                                    "type": "tool_result",
                                    "tool_use_id": "tu-1",
                                    "content": "ok",
                                    "is_error": false
                                }]
                            }
                        }),
                        json!({
                            "type": "stream_event",
                            "event": { "type": "message_start", "message": { "id": "m2" } }
                        }),
                        json!({
                            "type": "stream_event",
                            "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Tests passed." } }
                        }),
                        json!({
                            "type": "assistant",
                            "message": { "id": "m2", "content": [{ "type": "text", "text": "Tests passed." }] }
                        }),
                        json!({
                            "type": "result",
                            "subtype": "success",
                            "is_error": false,
                            "total_cost_usd": 0.012,
                            "usage": { "input_tokens": 100, "output_tokens": 25 }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let (tx, mut rx) = mpsc::channel(64);
        let run_session = Arc::clone(&session);
        let turn_task = tokio::spawn(async move {
            run_session
                .start_turn(
                    DriverTurnRequest {
                        session_id,
                        turn_id: TurnId::new(),
                        prompt: Message::user("run tests"),
                        model: None,
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

        let mut saw_tool = false;
        let mut saw_cost = false;
        let mut final_text = String::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                DriverEvent::Runtime(RuntimeEvent::ToolProposed { name, .. }) => {
                    assert_eq!(name, "shell");
                    saw_tool = true;
                }
                DriverEvent::Runtime(RuntimeEvent::ApprovalRequested { request_id, .. }) => {
                    assert!(approvals_reply.respond(agente_protocol::ApprovalDecision {
                        request_id,
                        decision: ApprovalDecisionKind::ApproveOnce,
                        option_id: None,
                    }));
                }
                DriverEvent::Runtime(RuntimeEvent::CallUsage { cost_usd, .. }) => {
                    assert_eq!(cost_usd, Some(0.012));
                    saw_cost = true;
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

        assert!(saw_tool);
        assert!(saw_cost);
        assert_eq!(final_text, "Tests passed.");
        assert_eq!(
            session.external_session_id().as_deref(),
            Some("claude-sess-42")
        );
        turn_task.await.unwrap();
        mock_cli.await.unwrap();
    }

    #[tokio::test]
    async fn claude_cancel_unblocks_pending_permission_and_classifies_rate_limit() {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (c_read, c_write) = tokio::io::split(client_side);
        let (s_read, mut s_write) = tokio::io::split(server_side);

        let session_id = SessionId::new();
        let approvals = ApprovalRouter::new();
        let session = Arc::new(ClaudeSession::from_io(
            c_read,
            c_write,
            session_id,
            None,
            TurnMode::Build,
            None,
            approvals,
        ));

        let mock_cli = tokio::spawn(async move {
            let mut lines = BufReader::new(s_read).lines();
            let _user: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "type": "control_request",
                            "request_id": "ctrl-cancel",
                            "request": {
                                "subtype": "can_use_tool",
                                "tool_name": "Edit",
                                "input": { "file_path": "a.rs", "old_string": "a", "new_string": "b" }
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let mut got_deny = false;
            let mut got_interrupt = false;
            while !(got_deny && got_interrupt) {
                let frame: Value =
                    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                if frame["type"] == "control_response" {
                    assert_eq!(frame["response"]["response"]["behavior"], "deny");
                    got_deny = true;
                } else if frame["type"] == "control_request"
                    && frame["request"]["subtype"] == "interrupt"
                {
                    got_interrupt = true;
                }
            }

            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "type": "result",
                            "subtype": "error_during_execution",
                            "is_error": true,
                            "result": "API 429 rate limit exceeded"
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let (tx, mut rx) = mpsc::channel(64);
        let run_sess = Arc::clone(&session);
        let turn_id = TurnId::new();
        let turn_task = tokio::spawn(async move {
            let _ = run_sess
                .start_turn(
                    DriverTurnRequest {
                        session_id,
                        turn_id,
                        prompt: Message::user("edit"),
                        model: None,
                        thinking_level: None,
                        mode: TurnMode::Build,
                        cwd: ".".into(),
                        mcp_servers: Vec::new(),
                    },
                    tx,
                )
                .await;
        });

        let mut saw_limit = false;
        while let Some(ev) = rx.recv().await {
            match ev {
                DriverEvent::Runtime(RuntimeEvent::ApprovalRequested { .. }) => {
                    assert!(session.cancel(turn_id).await);
                }
                DriverEvent::Runtime(RuntimeEvent::UsageLimitReached { message, .. }) => {
                    assert!(message.contains("rate limit"));
                    saw_limit = true;
                }
                DriverEvent::TurnComplete { status, .. } => {
                    assert_eq!(status, TurnStatus::Cancelled);
                    break;
                }
                _ => {}
            }
        }
        assert!(saw_limit);
        turn_task.await.unwrap();
        mock_cli.await.unwrap();
    }
}
