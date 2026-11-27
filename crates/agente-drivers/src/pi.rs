//! Pi coding agent CLI driver speaking Pi's native `--mode rpc` JSONL protocol.
//!
//! Launches `pi --mode rpc` over stdio (strict `\n` line framing), supports
//! dynamic live model discovery via `get_available_models` + `get_state`,
//! mid-turn `steer`, `abort`, thinking levels, session resume (`--session`),
//! and streaming tool + reasoning + usage events.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agente_protocol::{
    rpc, DriverCapabilities, DriverInfo, DriverKind, DriverModel, DriverStatus, Message,
    RuntimeEvent, TurnId, TurnMode, TurnStatus, Usage,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use uuid::Uuid;

use crate::config::ResolvedInstance;
use crate::process::{passive_probe, resolve_executable, JsonLineWriter, SpawnedStdio};
use crate::{
    effective_model, flatten_prompt_text, AgentDriver, ApprovalRouter, DriverError, DriverEvent,
    DriverSession, DriverSessionOpen, DriverTurnRequest,
};

const PI_MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
const PI_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const PI_AUTH_HINT: &str =
    "Run `pi` and use `/login` (or configure a provider API key) to enable models.";

/// Driver wrapping the `pi` CLI (`pi --mode rpc`).
pub struct PiDriver {
    instance: ResolvedInstance,
}

impl PiDriver {
    pub fn new(instance: ResolvedInstance) -> Self {
        Self { instance }
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            models: true,
            thinking: true,
            modes: vec![TurnMode::Auto],
            native_plan_cards: false,
            approvals: false,
            steer: true,
            resume: true,
            fork: false,
            compact: false,
            rewind_conversation: false,
            mcp_injection: false,
            session_import: false,
            attachments: Vec::new(),
            usage: true,
            cost: true,
        }
    }
}

#[async_trait]
impl AgentDriver for PiDriver {
    fn instance_id(&self) -> &str {
        &self.instance.instance_id
    }

    fn driver_kind(&self) -> DriverKind {
        DriverKind::Pi
    }

    fn descriptor(&self) -> DriverInfo {
        let program = self
            .instance
            .command
            .first()
            .map(String::as_str)
            .unwrap_or("");
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
            driver_kind: DriverKind::Pi,
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
        let live = probe_pi_live(&self.instance).await;
        if live.needs_auth && self.instance.models.is_empty() {
            info.status = DriverStatus::NeedsAuth;
            info.auth_hint = Some(PI_AUTH_HINT.to_string());
        } else if self.instance.models.is_empty() && !live.models.is_empty() {
            info.models = live.models;
        }
        info
    }

    async fn open_session(
        &self,
        spec: DriverSessionOpen,
        _approvals: ApprovalRouter,
    ) -> Result<Arc<dyn DriverSession>, DriverError> {
        if !self.instance.enabled {
            return Err(DriverError::Disabled(self.instance.instance_id.clone()));
        }
        let mut extra_args = pi_rpc_args(&self.instance.command, false);
        if let Some(session_file) = spec.external_session_id.as_deref() {
            extra_args.push("--session".to_string());
            extra_args.push(session_file.to_string());
        }
        let (spawned, stdout, stdin) = SpawnedStdio::spawn(
            &self.instance.command,
            &extra_args,
            &spec.project_dir,
            &self.instance.env,
            &self.instance.strip_env,
        )?;
        let session = PiSession::connect_io(stdout, stdin, Some(spawned), spec).await?;
        Ok(Arc::new(session))
    }
}

fn pi_rpc_args(command: &[String], no_session: bool) -> Vec<String> {
    let mut args = Vec::new();
    let has_mode = command
        .windows(2)
        .any(|pair| pair[0] == "--mode" && pair[1] == "rpc");
    if !has_mode {
        args.push("--mode".to_string());
        args.push("rpc".to_string());
    }
    if no_session && !command.iter().any(|arg| arg == "--no-session") {
        args.push("--no-session".to_string());
    }
    args
}

fn pi_reasoning_levels(reasoning: bool) -> Vec<String> {
    if reasoning {
        vec![
            "off".to_string(),
            "minimal".to_string(),
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
            "xhigh".to_string(),
        ]
    } else {
        Vec::new()
    }
}

fn normalize_pi_thinking_level(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "off" | "none" | "disabled" => Some("off"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" | "med" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" | "very_high" => Some("xhigh"),
        _ => None,
    }
}

/// Parse Pi `get_available_models` `data` object into normalized [`DriverModel`]s.
pub fn parse_pi_models(data: &Value, active_model_id: Option<&str>) -> Vec<DriverModel> {
    let Some(items) = data.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    let active_trimmed = active_model_id.map(str::trim).filter(|s| !s.is_empty());
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let Some(model_id) = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let provider = item
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let encoded_id = match provider {
            Some(prov) => format!("{prov}/{model_id}"),
            None => model_id.to_string(),
        };
        if !seen.insert(encoded_id.clone()) {
            continue;
        }
        let label = item
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(model_id)
            .to_string();
        let reasoning = item
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let is_default =
            active_trimmed.is_some_and(|active| active == encoded_id || active == model_id);
        out.push(DriverModel {
            id: encoded_id,
            label,
            is_default,
            thinking_levels: pi_reasoning_levels(reasoning),
        });
    }
    out
}

#[derive(Default)]
struct PiProbeOutcome {
    models: Vec<DriverModel>,
    needs_auth: bool,
}

async fn probe_pi_live(instance: &ResolvedInstance) -> PiProbeOutcome {
    let extra_args = pi_rpc_args(&instance.command, true);
    let temp_dir = std::env::temp_dir().to_string_lossy().into_owned();
    let Ok((spawned, stdout, stdin)) = SpawnedStdio::spawn(
        &instance.command,
        &extra_args,
        &temp_dir,
        &instance.env,
        &instance.strip_env,
    ) else {
        return PiProbeOutcome::default();
    };

    let writer = JsonLineWriter::spawn(stdin);
    if writer
        .send(json!({ "id": "probe_models", "type": "get_available_models" }))
        .is_err()
    {
        writer.close();
        drop(writer);
        spawned
            .shutdown_gracefully(Duration::from_millis(150))
            .await;
        return PiProbeOutcome::default();
    }

    let probe_res = tokio::time::timeout(PI_PROBE_TIMEOUT, async {
        let mut lines = BufReader::new(stdout);
        let mut models_data: Option<Value> = None;
        let mut requested_state = false;
        let mut active_key: Option<String> = None;

        while let Ok(Some(line)) = rpc::read_bounded_line(&mut lines, PI_MAX_LINE_BYTES).await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if frame.get("type").and_then(Value::as_str) != Some("response") {
                continue;
            }
            let id = frame.get("id").and_then(Value::as_str);
            if id == Some("probe_models") {
                if frame.get("success").and_then(Value::as_bool) != Some(true) {
                    return PiProbeOutcome::default();
                }
                let data = frame.get("data").cloned().unwrap_or(Value::Null);
                let count = data
                    .get("models")
                    .and_then(Value::as_array)
                    .map(|a| a.len())
                    .unwrap_or(0);
                models_data = Some(data);
                if count == 0 {
                    return PiProbeOutcome {
                        models: Vec::new(),
                        needs_auth: true,
                    };
                }
                requested_state = writer
                    .send(json!({ "id": "probe_state", "type": "get_state" }))
                    .is_ok();
                if !requested_state {
                    break;
                }
            } else if requested_state && id == Some("probe_state") {
                if let Some(model_obj) = frame.pointer("/data/model") {
                    if let Some(mid) = model_obj.get("id").and_then(Value::as_str) {
                        active_key =
                            Some(match model_obj.get("provider").and_then(Value::as_str) {
                                Some(prov) if !prov.is_empty() => format!("{prov}/{mid}"),
                                _ => mid.to_string(),
                            });
                    }
                }
                break;
            }
        }

        let Some(data) = models_data else {
            return PiProbeOutcome::default();
        };
        let models = parse_pi_models(&data, active_key.as_deref());
        PiProbeOutcome {
            needs_auth: models.is_empty(),
            models,
        }
    })
    .await;

    writer.close();
    drop(writer);
    spawned
        .shutdown_gracefully(Duration::from_millis(150))
        .await;

    match probe_res {
        Ok(outcome) => outcome,
        Err(_) => {
            tracing::debug!(instance = %instance.instance_id, "Pi live model probe timed out");
            PiProbeOutcome::default()
        }
    }
}

struct TurnOutcome {
    status: TurnStatus,
    assistant_text: String,
    tokens: u32,
    error: Option<String>,
}

struct ActivePiTurn {
    sink: mpsc::Sender<DriverEvent>,
    done_tx: Option<oneshot::Sender<TurnOutcome>>,
    assistant_text: String,
    tool_names: HashMap<String, String>,
    last_error: Option<String>,
    last_tokens: u32,
    cancelled: bool,
}

struct PiCore {
    external_session_id: Mutex<Option<String>>,
    current_model: Mutex<Option<String>>,
    provider_by_model_id: Mutex<HashMap<String, String>>,
    pending_rpc: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    active_turn: Mutex<Option<ActivePiTurn>>,
    closed_reason: Mutex<Option<String>>,
}

impl PiCore {
    fn emit(&self, event: DriverEvent) {
        let guard = self.active_turn.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(turn) = guard.as_ref() {
            let _ = turn.sink.try_send(event);
        }
    }

    fn finish_turn(&self, force_error: Option<String>) {
        let finished = self
            .active_turn
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let Some(mut turn) = finished else {
            return;
        };
        let err = force_error.or(turn.last_error);
        let status = if turn.cancelled {
            TurnStatus::Cancelled
        } else if err.is_some() {
            TurnStatus::Failed
        } else {
            TurnStatus::Completed
        };
        if let Some(done) = turn.done_tx.take() {
            let _ = done.send(TurnOutcome {
                status,
                assistant_text: turn.assistant_text,
                tokens: turn.last_tokens,
                error: err,
            });
        }
    }

    fn fail_pending_rpc(&self, reason: &str) {
        let mut guard = self.pending_rpc.lock().unwrap_or_else(|p| p.into_inner());
        for (_, tx) in guard.drain() {
            let _ = tx.send(Err(reason.to_string()));
        }
    }
}

/// Active Pi subprocess session speaking `--mode rpc` NDJSON.
pub struct PiSession {
    core: Arc<PiCore>,
    writer: JsonLineWriter,
    child: Option<SpawnedStdio>,
    reader_abort: tokio::task::AbortHandle,
    turn_lock: AsyncMutex<()>,
}

impl PiSession {
    /// Connect over arbitrary bidirectional streams (used for stdio and unit tests).
    pub async fn connect_io<R, W>(
        reader: R,
        writer: W,
        child: Option<SpawnedStdio>,
        spec: DriverSessionOpen,
    ) -> Result<Self, DriverError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let writer = JsonLineWriter::spawn(writer);
        let core = Arc::new(PiCore {
            external_session_id: Mutex::new(spec.external_session_id.clone()),
            current_model: Mutex::new(None),
            provider_by_model_id: Mutex::new(HashMap::new()),
            pending_rpc: Mutex::new(HashMap::new()),
            active_turn: Mutex::new(None),
            closed_reason: Mutex::new(None),
        });
        let reader_core = Arc::clone(&core);
        let reader_task = tokio::spawn(async move {
            let mut lines = BufReader::new(reader);
            let close_reason = loop {
                match rpc::read_bounded_line(&mut lines, PI_MAX_LINE_BYTES).await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
                        if trimmed.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(frame) => handle_pi_frame(&reader_core, frame),
                            Err(_) => {
                                tracing::debug!(line = %trimmed, "ignoring non-JSON line from pi");
                            }
                        }
                    }
                    Ok(None) => break None,
                    Err(err) => break Some(err.to_string()),
                }
            };
            if let Some(reason) = close_reason.clone() {
                *reader_core
                    .closed_reason
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(reason);
            }
            reader_core.fail_pending_rpc("pi RPC stream closed");
            reader_core.finish_turn(close_reason);
        });

        let session = Self {
            core,
            writer,
            child,
            reader_abort: reader_task.abort_handle(),
            turn_lock: AsyncMutex::new(()),
        };

        if let Ok(state) = session.rpc_call("get_state", json!({})).await {
            if let Some(sf) = state
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                *session
                    .core
                    .external_session_id
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(sf.to_string());
            }
            if let Some(model_obj) = state.get("model") {
                if let Some(mid) = model_obj.get("id").and_then(Value::as_str) {
                    let active = match model_obj.get("provider").and_then(Value::as_str) {
                        Some(prov) if !prov.is_empty() => format!("{prov}/{mid}"),
                        _ => mid.to_string(),
                    };
                    *session
                        .core
                        .current_model
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) = Some(active);
                }
            }
        }

        if let Some(model) = effective_model(spec.model.as_deref()) {
            let _ = session.apply_model(model).await;
        }

        Ok(session)
    }

    async fn rpc_call(&self, cmd_type: &str, payload: Value) -> Result<Value, DriverError> {
        let id = format!("pi-{}", Uuid::new_v4().simple());
        let (tx, rx) = oneshot::channel();
        self.core
            .pending_rpc
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), tx);

        let mut obj = match payload {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        obj.insert("id".to_string(), json!(id));
        obj.insert("type".to_string(), json!(cmd_type));

        if let Err(err) = self.writer.send(Value::Object(obj)) {
            self.core
                .pending_rpc
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            return Err(err);
        }

        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(Ok(data))) => Ok(data),
            Ok(Ok(Err(msg))) => Err(DriverError::Protocol(format!("{cmd_type}: {msg}"))),
            Ok(Err(_)) => Err(DriverError::Protocol(format!("{cmd_type}: channel closed"))),
            Err(_) => {
                self.core
                    .pending_rpc
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err(DriverError::Protocol(format!("{cmd_type}: timed out")))
            }
        }
    }

    async fn resolve_provider_model(&self, model: &str) -> Option<(String, String)> {
        if let Some((prov, mid)) = model.split_once('/') {
            let prov = prov.trim();
            let mid = mid.trim();
            if !prov.is_empty() && !mid.is_empty() {
                return Some((prov.to_string(), mid.to_string()));
            }
        }
        if let Some(prov) = self
            .core
            .provider_by_model_id
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(model)
            .cloned()
        {
            return Some((prov, model.to_string()));
        }
        if let Ok(data) = self.rpc_call("get_available_models", json!({})).await {
            let mut map = self
                .core
                .provider_by_model_id
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if let Some(items) = data.get("models").and_then(Value::as_array) {
                for item in items {
                    if let (Some(id), Some(prov)) = (
                        item.get("id").and_then(Value::as_str),
                        item.get("provider").and_then(Value::as_str),
                    ) {
                        map.insert(id.to_string(), prov.to_string());
                    }
                }
            }
            if let Some(prov) = map.get(model).cloned() {
                return Some((prov, model.to_string()));
            }
        }
        None
    }

    async fn apply_model(&self, model: &str) -> Result<(String, Option<String>), DriverError> {
        let Some((provider, model_id)) = self.resolve_provider_model(model).await else {
            return Err(DriverError::Protocol(format!(
                "set_model: could not resolve provider for '{model}'"
            )));
        };
        let _ = self
            .rpc_call(
                "set_model",
                json!({ "provider": provider, "modelId": model_id }),
            )
            .await?;
        let canonical = format!("{provider}/{model_id}");
        *self
            .core
            .current_model
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(canonical.clone());
        Ok((canonical, Some(provider)))
    }
}

#[async_trait]
impl DriverSession for PiSession {
    async fn start_turn(
        &self,
        request: DriverTurnRequest,
        sink: mpsc::Sender<DriverEvent>,
    ) -> Result<(), DriverError> {
        let _turn_guard = self.turn_lock.lock().await;
        if let Some(ext_id) = self.external_session_id() {
            let _ = sink.send(DriverEvent::ExternalSessionBound(ext_id)).await;
        }

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
                if let Ok((canonical, provider)) = self.apply_model(req_model).await {
                    let _ = sink
                        .send(DriverEvent::Runtime(RuntimeEvent::ModelChanged {
                            model: canonical,
                            provider,
                        }))
                        .await;
                }
            }
        }

        if let Some(raw_thinking) = request.thinking_level.as_deref() {
            if let Some(level) = normalize_pi_thinking_level(raw_thinking) {
                let _ = self
                    .rpc_call("set_thinking_level", json!({ "level": level }))
                    .await;
            }
        }

        let (done_tx, done_rx) = oneshot::channel();
        {
            let mut active = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            *active = Some(ActivePiTurn {
                sink: sink.clone(),
                done_tx: Some(done_tx),
                assistant_text: String::new(),
                tool_names: HashMap::new(),
                last_error: None,
                last_tokens: 0,
                cancelled: false,
            });
        }

        let prompt_text = flatten_prompt_text(&request.prompt);
        if let Err(err) = self
            .rpc_call("prompt", json!({ "message": prompt_text }))
            .await
        {
            let msg = err.to_string();
            let _ = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take();
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
                    .unwrap_or_else(|| "Pi turn ended unexpectedly".into()),
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
        let is_active = self
            .core
            .active_turn
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some();
        if !is_active {
            return false;
        }
        self.rpc_call("steer", json!({ "message": flatten_prompt_text(&message) }))
            .await
            .is_ok()
    }

    async fn cancel(&self, _turn_id: TurnId) -> bool {
        {
            let mut active = self
                .core
                .active_turn
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let Some(turn) = active.as_mut() else {
                return false;
            };
            turn.cancelled = true;
        }
        self.writer
            .send(json!({ "id": format!("abort-{}", Uuid::new_v4().simple()), "type": "abort" }))
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
        self.core.fail_pending_rpc("driver session closed");
        self.writer.close();
        self.reader_abort.abort();
        if let Some(child) = &self.child {
            child.shutdown_gracefully(Duration::from_millis(150)).await;
        }
    }
}

fn handle_pi_frame(core: &PiCore, frame: Value) {
    let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
    match frame_type {
        "response" => {
            if let Some(id) = frame.get("id").and_then(Value::as_str) {
                let waiter = core
                    .pending_rpc
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(id);
                if let Some(waiter) = waiter {
                    let success = frame
                        .get("success")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if success {
                        let _ = waiter.send(Ok(frame.get("data").cloned().unwrap_or(Value::Null)));
                    } else {
                        let msg = frame
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Pi RPC request failed")
                            .to_string();
                        let _ = waiter.send(Err(msg));
                    }
                }
            }
        }
        "message_update" => {
            let Some(ev) = frame.get("assistantMessageEvent") else {
                return;
            };
            let ev_type = ev.get("type").and_then(Value::as_str).unwrap_or("");
            let delta = ev.get("delta").and_then(Value::as_str).unwrap_or("");
            if delta.is_empty() {
                return;
            }
            match ev_type {
                "text_delta" => {
                    let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(turn) = guard.as_mut() {
                        turn.assistant_text.push_str(delta);
                        let _ = turn.sink.try_send(DriverEvent::Runtime(
                            RuntimeEvent::AssistantDelta {
                                text: delta.to_string(),
                            },
                        ));
                    }
                }
                "thinking_delta" => {
                    core.emit(DriverEvent::Runtime(RuntimeEvent::ReasoningDelta {
                        text: delta.to_string(),
                    }));
                }
                _ => {}
            }
        }
        "tool_execution_start" => {
            let id = frame
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let raw_name = frame
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let name = normalize_pi_tool_name(raw_name).to_string();
            let arguments = frame
                .get("args")
                .map(Value::to_string)
                .unwrap_or_else(|| "{}".to_string());
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                turn.tool_names.insert(id.clone(), name.clone());
                let _ = turn
                    .sink
                    .try_send(DriverEvent::Runtime(RuntimeEvent::ToolProposed {
                        id,
                        name,
                        arguments,
                    }));
            }
        }
        "tool_execution_update" => {
            let id = frame
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let chunk = extract_pi_tool_text(frame.get("partialResult"));
            if !chunk.is_empty() {
                core.emit(DriverEvent::Runtime(RuntimeEvent::ToolProgress {
                    id,
                    chunk,
                }));
            }
        }
        "tool_execution_end" => {
            let id = frame
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let raw_name = frame
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let content = extract_pi_tool_text(frame.get("result"));
            let is_error = frame
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                let name = turn
                    .tool_names
                    .remove(&id)
                    .unwrap_or_else(|| normalize_pi_tool_name(raw_name).to_string());
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
        "message_end" => {
            let Some(msg) = frame.get("message") else {
                return;
            };
            if msg.get("role").and_then(Value::as_str) != Some("assistant") {
                return;
            }
            let stop_reason = msg.get("stopReason").and_then(Value::as_str);
            let err_message = msg
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            let (usage_opt, cost_opt) = extract_pi_usage(msg.get("usage"));
            let mut guard = core.active_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(turn) = guard.as_mut() {
                if stop_reason == Some("aborted") {
                    turn.cancelled = true;
                } else if stop_reason == Some("error") {
                    turn.last_error =
                        err_message.or_else(|| Some("Pi assistant message failed".to_string()));
                } else if let Some(err) = err_message {
                    turn.last_error = Some(err);
                }
                if let Some(usage) = usage_opt {
                    turn.last_tokens = usage.context_tokens;
                    let _ = turn
                        .sink
                        .try_send(DriverEvent::Runtime(RuntimeEvent::Usage {
                            usage: usage.clone(),
                        }));
                    if cost_opt.is_some() {
                        let _ = turn
                            .sink
                            .try_send(DriverEvent::Runtime(RuntimeEvent::CallUsage {
                                usage,
                                cost_usd: cost_opt,
                                cost_estimated: false,
                            }));
                    }
                }
            }
        }
        "agent_end" => {
            core.finish_turn(None);
        }
        _ => {}
    }
}

fn normalize_pi_tool_name(raw: &str) -> &str {
    match raw {
        "bash" => "shell",
        "read" => "read_file",
        "edit" => "edit_file",
        "write" => "write_file",
        other => other,
    }
}

fn extract_pi_tool_text(value: Option<&Value>) -> String {
    let Some(val) = value else {
        return String::new();
    };
    if let Some(text) = val.as_str() {
        return text.to_string();
    }
    if let Some(arr) = val.get("content").and_then(Value::as_array) {
        return arr
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Some(text) = val.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    String::new()
}

fn extract_pi_usage(value: Option<&Value>) -> (Option<Usage>, Option<f64>) {
    let Some(u) = value else {
        return (None, None);
    };
    let input = u.get("input").and_then(Value::as_u64).unwrap_or(0) as u32;
    let output = u.get("output").and_then(Value::as_u64).unwrap_or(0) as u32;
    let cache_read = u.get("cacheRead").and_then(Value::as_u64).unwrap_or(0) as u32;
    let cache_creation = u.get("cacheWrite").and_then(Value::as_u64).unwrap_or(0) as u32;
    let total = u
        .get("totalTokens")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or_else(|| input.saturating_add(output).saturating_add(cache_read));
    let cost_usd = u.pointer("/cost/total").and_then(Value::as_f64);
    (
        Some(Usage {
            prompt_tokens: input,
            completion_tokens: output,
            cache_read_tokens: cache_read,
            cache_creation_tokens: cache_creation,
            context_tokens: total,
        }),
        cost_usd,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_protocol::SessionId;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn parses_pi_models_with_provider_prefix_and_reasoning_levels() {
        let data = json!({
            "models": [
                {
                    "id": "claude-sonnet-4-5",
                    "name": "Claude Sonnet 4.5",
                    "provider": "anthropic",
                    "reasoning": true
                },
                {
                    "id": "gpt-4.1",
                    "name": "GPT-4.1",
                    "provider": "openai",
                    "reasoning": false
                }
            ]
        });
        let models = parse_pi_models(&data, Some("anthropic/claude-sonnet-4-5"));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "anthropic/claude-sonnet-4-5");
        assert_eq!(models[0].label, "Claude Sonnet 4.5");
        assert!(models[0].is_default);
        assert_eq!(
            models[0].thinking_levels,
            vec!["off", "minimal", "low", "medium", "high", "xhigh"]
        );
        assert_eq!(models[1].id, "openai/gpt-4.1");
        assert!(!models[1].is_default);
        assert!(models[1].thinking_levels.is_empty());
    }

    #[tokio::test]
    async fn pi_rpc_session_handles_models_thinking_streaming_tools_steer_and_abort() {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (c_read, c_write) = tokio::io::split(client_side);
        let (s_read, mut s_write) = tokio::io::split(server_side);

        let session_id = SessionId::new();
        let mock_pi = tokio::spawn(async move {
            let mut lines = BufReader::new(s_read).lines();

            let state_req: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(state_req["type"], "get_state");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "id": state_req["id"],
                            "type": "response",
                            "command": "get_state",
                            "success": true,
                            "data": {
                                "sessionFile": "/tmp/pi-sess-1.jsonl",
                                "model": { "id": "claude-sonnet-4-5", "provider": "anthropic" }
                            }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let set_model: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(set_model["type"], "set_model");
            assert_eq!(set_model["provider"], "openai");
            assert_eq!(set_model["modelId"], "gpt-5.4");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "id": set_model["id"],
                            "type": "response",
                            "command": "set_model",
                            "success": true,
                            "data": { "id": "gpt-5.4", "provider": "openai" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let set_think: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(set_think["type"], "set_thinking_level");
            assert_eq!(set_think["level"], "high");
            s_write
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "id": set_think["id"],
                            "type": "response",
                            "command": "set_thinking_level",
                            "success": true
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let prompt_req: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(prompt_req["type"], "prompt");
            s_write
                .write_all(
                    format!(
                        "{}\n{}\n{}\n{}\n{}\n",
                        json!({
                            "id": prompt_req["id"],
                            "type": "response",
                            "command": "prompt",
                            "success": true
                        }),
                        json!({
                            "type": "message_update",
                            "assistantMessageEvent": { "type": "thinking_delta", "delta": "Checking" }
                        }),
                        json!({
                            "type": "tool_execution_start",
                            "toolCallId": "tc-pi-1",
                            "toolName": "bash",
                            "args": { "command": "cargo test" }
                        }),
                        json!({
                            "type": "tool_execution_update",
                            "toolCallId": "tc-pi-1",
                            "toolName": "bash",
                            "partialResult": { "content": [{ "type": "text", "text": "running..." }] }
                        }),
                        json!({
                            "type": "tool_execution_end",
                            "toolCallId": "tc-pi-1",
                            "toolName": "bash",
                            "result": { "content": [{ "type": "text", "text": "ok" }] },
                            "isError": false
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let steer_req: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(steer_req["type"], "steer");
            s_write
                .write_all(
                    format!(
                        "{}\n{}\n{}\n{}\n",
                        json!({
                            "id": steer_req["id"],
                            "type": "response",
                            "command": "steer",
                            "success": true
                        }),
                        json!({
                            "type": "message_update",
                            "assistantMessageEvent": { "type": "text_delta", "delta": "Done!" }
                        }),
                        json!({
                            "type": "message_end",
                            "message": {
                                "role": "assistant",
                                "stopReason": "stop",
                                "usage": { "input": 50, "output": 12, "cacheRead": 10, "cost": { "total": 0.004 } }
                            }
                        }),
                        json!({
                            "type": "agent_end",
                            "messages": []
                        })
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let session = Arc::new(
            PiSession::connect_io(
                c_read,
                c_write,
                None,
                DriverSessionOpen {
                    session_id,
                    project_dir: ".".into(),
                    external_session_id: None,
                    mode: TurnMode::Auto,
                    model: None,
                    mcp_servers: Vec::new(),
                    interactive: true,
                },
            )
            .await
            .unwrap(),
        );
        assert_eq!(
            session.external_session_id().as_deref(),
            Some("/tmp/pi-sess-1.jsonl")
        );

        let (tx, mut rx) = mpsc::channel(64);
        let run_sess = Arc::clone(&session);
        let turn_task = tokio::spawn(async move {
            run_sess
                .start_turn(
                    DriverTurnRequest {
                        session_id,
                        turn_id: TurnId::new(),
                        prompt: Message::user("run checks"),
                        model: Some("openai/gpt-5.4".into()),
                        thinking_level: Some("high".into()),
                        mode: TurnMode::Auto,
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
        let mut saw_model_change = false;
        let mut final_text = String::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                DriverEvent::Runtime(RuntimeEvent::ModelChanged { model, provider }) => {
                    assert_eq!(model, "openai/gpt-5.4");
                    assert_eq!(provider.as_deref(), Some("openai"));
                    saw_model_change = true;
                }
                DriverEvent::Runtime(RuntimeEvent::ToolResult { name, .. }) => {
                    assert_eq!(name, "shell");
                    saw_tool = true;
                    assert!(session.steer(Message::user("wrap up")).await);
                }
                DriverEvent::Runtime(RuntimeEvent::CallUsage { cost_usd, .. }) => {
                    assert_eq!(cost_usd, Some(0.004));
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

        assert!(saw_model_change);
        assert!(saw_tool);
        assert!(saw_cost);
        assert_eq!(final_text, "Done!");
        turn_task.await.unwrap();
        mock_pi.await.unwrap();
    }
}
