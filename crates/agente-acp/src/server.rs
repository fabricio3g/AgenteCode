//! The ACP connection: inbound dispatch, turn pumping, and approval routing.
//!
//! The reader loop classifies each line (see [`crate::rpc`]) and dispatches:
//!
//! - requests are answered with a result or an error object carrying the
//!   original id — `-32602` for bad params, `-32601` for unknown methods,
//!   `-32603` for runtime failures;
//! - notifications mutate state and are never answered (`session/cancel`);
//! - responses resolve agent-issued `session/request_permission` requests via
//!   a pending map of generated JSON-RPC id → runtime approval id.
//!
//! Each `session/prompt` spawns a pump task owning the turn's event stream.
//! The pump forwards `session/update` notifications, issues permission
//! requests, and answers the prompt with `{"stopReason": …}` once a terminal
//! event arrives. Pumps are tracked per turn and aborted when no terminal
//! event can ever arrive (e.g. a cancel for an already-finished turn). All
//! writes serialize through one shared sink mutex.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agente_protocol::{
    ApprovalDecision, ApprovalDecisionKind, Message, RuntimeEvent, RuntimeEventEnvelope, SessionId,
    StartTurn, TurnId,
};
use agente_runtime::RuntimeHandle;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;

use crate::rpc::{self, FrameError, Incoming};
use crate::updates;
use crate::AcpError;

/// ACP wire protocol version (distinct from `agente_protocol::PROTOCOL_VERSION`).
const ACP_PROTOCOL_VERSION: u16 = 1;

/// Maximum size of a single inbound JSON-RPC line (64 MiB).
const MAX_RPC_LINE_BYTES: usize = 64 * 1024 * 1024;

/// Boxed sink so the server state is one concrete type for both stdio and
/// in-memory test transports.
type Sink = Box<dyn AsyncWrite + Unpin + Send>;
type SharedSink = Arc<AsyncMutex<Sink>>;

pub(crate) struct ServerState {
    runtime: RuntimeHandle,
    sink: SharedSink,
    /// Ids for agent-issued requests (`session/request_permission`).
    next_outgoing_id: AtomicU64,
    /// Generated JSON-RPC id → `(turn_id, runtime approval request_id)`.
    pending_approvals: Mutex<HashMap<u64, (TurnId, String)>>,
    /// Session → most recent active turn (`session/cancel` names a session).
    active_turns: Mutex<HashMap<SessionId, TurnId>>,
    /// Turn → JSON-RPC id of the `session/prompt` awaiting its `stopReason`.
    pending_prompts: Mutex<HashMap<TurnId, Value>>,
    /// Turn → abort handle of its update pump.
    forwarders: Mutex<HashMap<TurnId, tokio::task::AbortHandle>>,
}

impl ServerState {
    pub(crate) fn new(
        runtime: RuntimeHandle,
        writer: impl AsyncWrite + Unpin + Send + 'static,
    ) -> Self {
        Self {
            runtime,
            sink: Arc::new(AsyncMutex::new(Box::new(writer))),
            next_outgoing_id: AtomicU64::new(0),
            pending_approvals: Mutex::new(HashMap::new()),
            active_turns: Mutex::new(HashMap::new()),
            pending_prompts: Mutex::new(HashMap::new()),
            forwarders: Mutex::new(HashMap::new()),
        }
    }

    fn lock_pending_approvals(&self) -> std::sync::MutexGuard<'_, HashMap<u64, (TurnId, String)>> {
        self.pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_active_turns(&self) -> std::sync::MutexGuard<'_, HashMap<SessionId, TurnId>> {
        self.active_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_pending_prompts(&self) -> std::sync::MutexGuard<'_, HashMap<TurnId, Value>> {
        self.pending_prompts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_forwarders(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<TurnId, tokio::task::AbortHandle>> {
        self.forwarders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn shutdown(&self) {
        let mut turns_to_cancel: Vec<TurnId> = self
            .lock_active_turns()
            .drain()
            .map(|(_, turn)| turn)
            .collect();
        turns_to_cancel.extend(self.lock_pending_prompts().drain().map(|(turn, _)| turn));
        for (turn, handle) in self.lock_forwarders().drain() {
            turns_to_cancel.push(turn);
            handle.abort();
        }
        self.lock_pending_approvals().clear();
        for turn_id in turns_to_cancel {
            self.runtime.cancel(turn_id);
        }
    }

    async fn send(&self, frame: &Value) -> Result<(), AcpError> {
        let mut sink = self.sink.lock().await;
        let mut line = serde_json::to_string(frame)?;
        line.push('\n');
        sink.write_all(line.as_bytes())
            .await
            .map_err(AcpError::Io)?;
        sink.flush().await.map_err(AcpError::Io)
    }

    async fn send_result(&self, id: &Value, result: Value) -> Result<(), AcpError> {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    async fn send_error(&self, id: &Value, code: i32, message: &str) -> Result<(), AcpError> {
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }))
        .await
    }

    async fn send_notification(&self, method: &str, params: Value) -> Result<(), AcpError> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }
}

/// Serve ACP over `reader`/`writer` with a fresh state. Only a closed stream
/// terminates the loop; per-message failures are answered and survived.
pub(crate) async fn serve_over<R, W>(
    runtime: RuntimeHandle,
    reader: R,
    writer: W,
) -> Result<(), AcpError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let state = Arc::new(ServerState::new(runtime, writer));
    serve_with_state(state, reader).await
}

/// Serve ACP over `reader` with an existing state (shared with pump tasks).
pub(crate) async fn serve_with_state<R: AsyncRead + Unpin>(
    state: Arc<ServerState>,
    reader: R,
) -> Result<(), AcpError> {
    let mut reader = BufReader::new(reader);
    let result = async {
        while let Some(line) = rpc::read_bounded_line(&mut reader, MAX_RPC_LINE_BYTES).await? {
            if line.trim().is_empty() {
                continue;
            }
            match rpc::classify(&line) {
                Ok(incoming) => dispatch(&state, incoming).await?,
                Err(FrameError::Parse(error)) => {
                    state
                        .send_error(
                            &Value::Null,
                            rpc::PARSE_ERROR,
                            &format!("parse error: {error}"),
                        )
                        .await?;
                }
                Err(FrameError::NotAMessage) => {
                    state
                        .send_error(
                            &Value::Null,
                            rpc::INVALID_REQUEST,
                            "expected a JSON-RPC message object",
                        )
                        .await?;
                }
                Err(FrameError::UnsupportedProtocol(id)) => {
                    state
                        .send_error(&id, rpc::INVALID_REQUEST, "jsonrpc must be 2.0")
                        .await?;
                }
            }
        }
        Ok(())
    }
    .await;
    state.shutdown();
    result
}

/// Route one classified frame. Returns `Err` only for sink failures (the
/// client is gone); every per-message failure is answered in-band instead.
async fn dispatch(state: &Arc<ServerState>, incoming: Incoming) -> Result<(), AcpError> {
    match incoming {
        Incoming::Request { id, method, params } => handle_request(state, id, method, params).await,
        Incoming::Notification { method, params } => {
            handle_notification(state, method, params).await;
            Ok(())
        }
        Incoming::Response { id, result, error } => {
            handle_response(state, id, result, error).await;
            Ok(())
        }
    }
}

/// A request failure answered as a JSON-RPC error with the original id.
type RequestFailure = (i32, String);

fn invalid_params(message: impl Into<String>) -> RequestFailure {
    (rpc::INVALID_PARAMS, message.into())
}

fn internal_error(message: impl Into<String>) -> RequestFailure {
    (rpc::INTERNAL_ERROR, message.into())
}

async fn handle_request(
    state: &Arc<ServerState>,
    id: Value,
    method: String,
    params: Value,
) -> Result<(), AcpError> {
    if method == "session/prompt" {
        return handle_prompt(state, id, params).await;
    }
    let outcome: Result<Value, RequestFailure> = match method.as_str() {
        "initialize" => Ok(initialize_result()),
        "session/new" => Ok(json!({ "sessionId": SessionId::new().to_string() })),
        "session/load" => load_session(state, &params),
        "session/fork" => fork_session(state, &params),
        "session/approve" => legacy_approve(state, &params),
        other => Err((rpc::METHOD_NOT_FOUND, format!("method not found: {other}"))),
    };
    match outcome {
        Ok(result) => state.send_result(&id, result).await,
        Err((code, message)) => state.send_error(&id, code, &message).await,
    }
}

/// ACP `initialize` response: protocol version plus the capability surface of
/// this agent (session loading, text-embedded prompts, no MCP transports) and
/// no auth methods.
fn initialize_result() -> Value {
    json!({
        "protocolVersion": ACP_PROTOCOL_VERSION,
        "agentCapabilities": {
            "loadSession": true,
            "promptCapabilities": { "embeddedContext": true },
            "mcpCapabilities": { "http": false, "sse": false }
        },
        "authMethods": []
    })
}

fn load_session(state: &ServerState, params: &Value) -> Result<Value, RequestFailure> {
    let session_id = parse_session_id(params).map_err(invalid_params)?;
    serde_json::to_value(state.runtime.session_snapshot(session_id))
        .map_err(|error| internal_error(error.to_string()))
}

fn fork_session(state: &ServerState, params: &Value) -> Result<Value, RequestFailure> {
    let source = parse_session_id(params).map_err(invalid_params)?;
    serde_json::to_value(state.runtime.fork_session(source))
        .map_err(|error| internal_error(error.to_string()))
}

/// Legacy approval route kept for older clients: `{requestId, decision}` where
/// `decision` is `approve_once | approve_all | deny | cancel` (ACP option
/// spellings are accepted as aliases).
fn legacy_approve(state: &ServerState, params: &Value) -> Result<Value, RequestFailure> {
    let request_id = params
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("requestId is required"))?;
    let decision = params
        .get("decision")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("decision is required"))?;
    let decision = match decision {
        "approve_once" | "allow_once" => ApprovalDecisionKind::ApproveOnce,
        "approve_all" | "allow_always" => ApprovalDecisionKind::ApproveAll,
        "deny" | "reject_once" | "reject_always" => ApprovalDecisionKind::Deny,
        "cancel" => ApprovalDecisionKind::Cancel,
        other => {
            return Err(invalid_params(format!(
                "unknown approval decision: {other}"
            )))
        }
    };
    let accepted = state.runtime.approve(ApprovalDecision {
        request_id: request_id.to_string(),
        decision,
    });
    state
        .lock_pending_approvals()
        .retain(|_, (_, pending_id)| pending_id != request_id);
    Ok(json!({ "accepted": accepted }))
}

/// `session/prompt`: start a runtime turn and spawn its pump. The response is
/// deferred until the turn's terminal event (see [`pump_turn`]).
async fn handle_prompt(state: &Arc<ServerState>, id: Value, params: Value) -> Result<(), AcpError> {
    let session_id = match parse_session_id(&params) {
        Ok(session_id) => session_id,
        Err(message) => return state.send_error(&id, rpc::INVALID_PARAMS, &message).await,
    };
    let prompt = match prompt_text(&params) {
        Ok(prompt) => prompt,
        Err(message) => return state.send_error(&id, rpc::INVALID_PARAMS, &message).await,
    };
    let mut conversation = state.runtime.session_snapshot(session_id).conversation;
    conversation.push(Message::user(prompt));
    let start = StartTurn {
        session_id,
        conversation,
        provider: optional_string(&params, "provider"),
        model: optional_string(&params, "model"),
        thinking_level: optional_string(&params, "thinkingLevel"),
        ..StartTurn::default()
    };
    let turn = match state.runtime.start_turn(start) {
        Ok(turn) => turn,
        Err(error) => {
            return state
                .send_error(&id, rpc::INTERNAL_ERROR, &error.to_string())
                .await
        }
    };
    let turn_id = turn.turn_id();
    let turn_session = turn.session_id();
    state.lock_active_turns().insert(turn_session, turn_id);
    state.lock_pending_prompts().insert(turn_id, id);
    let mut forwarders = state.lock_forwarders();
    let pump_state = Arc::clone(state);
    let pump = tokio::spawn(pump_turn(pump_state, turn_session, turn_id, turn));
    if !pump.is_finished() {
        forwarders.insert(turn_id, pump.abort_handle());
    }
    Ok(())
}

async fn handle_notification(state: &Arc<ServerState>, method: String, params: Value) {
    match method.as_str() {
        "initialized" => {} // spec handshake acknowledgement; nothing to do
        "session/cancel" => handle_cancel(state, params).await,
        other => tracing::debug!(method = %other, "ignoring unknown notification"),
    }
}

/// `session/cancel` notification: cancel the named turn, or the session's most
/// recent active turn when `turnId` is absent. Never answered — but when the
/// runtime has no such turn (so no terminal event can arrive) a pending prompt
/// is resolved with `stopReason: "cancelled"` and its pump is aborted here.
async fn handle_cancel(state: &Arc<ServerState>, params: Value) {
    let session_id = match parse_session_id(&params) {
        Ok(session_id) => session_id,
        Err(message) => {
            tracing::warn!(%message, "session/cancel without a usable sessionId; ignored");
            return;
        }
    };
    let explicit_turn = params
        .get("turnId")
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<TurnId>().ok());
    if let Some(raw) = params
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|_| explicit_turn.is_none())
    {
        tracing::warn!(%raw, "session/cancel carried an invalid turnId; using the latest turn");
    }
    let turn_id = match explicit_turn {
        Some(turn_id) => Some(turn_id),
        None => state.lock_active_turns().get(&session_id).copied(),
    };
    let Some(turn_id) = turn_id else {
        tracing::debug!(%session_id, "session/cancel for a session with no active turn");
        return;
    };
    state
        .lock_pending_approvals()
        .retain(|_, (pending_turn, _)| *pending_turn != turn_id);
    if state.runtime.cancel(turn_id) {
        // The runtime will deliver a terminal `TurnCancelled` envelope; the
        // pump resolves the pending prompt then. Forwarding stays alive so the
        // cancellation tail still streams.
        return;
    }
    let reply = state.lock_pending_prompts().remove(&turn_id);
    if let Some(id) = reply {
        if let Err(error) = state
            .send(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "stopReason": "cancelled" }
            }))
            .await
        {
            tracing::warn!(%error, "failed to resolve a cancelled prompt");
        }
        if let Some(handle) = state.lock_forwarders().remove(&turn_id) {
            handle.abort();
        }
        let mut active = state.lock_active_turns();
        if active.get(&session_id) == Some(&turn_id) {
            active.remove(&session_id);
        }
    }
}

/// Route a client response (id, no method) to the runtime approval broker.
/// Only `session/request_permission` requests expect answers; anything else is
/// a stray frame and is dropped.
async fn handle_response(
    state: &Arc<ServerState>,
    id: Value,
    result: Option<Value>,
    error: Option<Value>,
) {
    let Some(jsonrpc_id) = id.as_u64() else {
        tracing::debug!(?id, "ignoring response with a non-numeric id");
        return;
    };
    let Some((_, approval_id)) = state.lock_pending_approvals().remove(&jsonrpc_id) else {
        tracing::debug!(
            jsonrpc_id,
            "ignoring response with no pending agent request"
        );
        return;
    };
    if error.is_some() {
        tracing::debug!(
            jsonrpc_id,
            "client errored a permission request; cancelling it"
        );
    }
    let decision = updates::decision_from_response(result.as_ref(), error.is_some());
    let accepted = state.runtime.approve(ApprovalDecision {
        request_id: approval_id,
        decision,
    });
    tracing::debug!(
        ?decision,
        accepted,
        "routed permission outcome to the runtime"
    );
}

/// Issue a `session/request_permission` request for a runtime approval.
async fn send_permission_request(
    state: &Arc<ServerState>,
    session_id: SessionId,
    turn_id: TurnId,
    request_id: &str,
    tool_name: &str,
    tool_args: &str,
) {
    let jsonrpc_id = state
        .next_outgoing_id
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    state
        .lock_pending_approvals()
        .insert(jsonrpc_id, (turn_id, request_id.to_string()));
    let params = updates::request_permission_params(session_id, request_id, tool_name, tool_args);
    let frame = json!({
        "jsonrpc": "2.0",
        "id": jsonrpc_id,
        "method": "session/request_permission",
        "params": params
    });
    if let Err(error) = state.send(&frame).await {
        tracing::warn!(%error, "failed to send session/request_permission");
        state.lock_pending_approvals().remove(&jsonrpc_id);
    }
}

/// Source of runtime envelopes for one turn. Abstracted so tests can drive the
/// pump from a plain channel instead of a live `TurnHandle`.
trait TurnEventStream: Send {
    fn next_envelope(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Option<RuntimeEventEnvelope>> + Send + '_>>;
}

impl TurnEventStream for agente_runtime::TurnHandle {
    fn next_envelope(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Option<RuntimeEventEnvelope>> + Send + '_>> {
        Box::pin(self.recv())
    }
}

impl TurnEventStream for tokio::sync::mpsc::Receiver<RuntimeEventEnvelope> {
    fn next_envelope(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Option<RuntimeEventEnvelope>> + Send + '_>> {
        Box::pin(self.recv())
    }
}

/// How a turn ended, from the pump's point of view.
#[derive(Debug)]
enum TurnResolution {
    Finished,
    Cancelled,
    Failed(String),
    /// The event stream closed (or the sink broke) without a terminal event.
    Closed,
}

fn terminal_resolution(event: &RuntimeEvent) -> Option<TurnResolution> {
    match event {
        RuntimeEvent::TurnFinished { .. } => Some(TurnResolution::Finished),
        RuntimeEvent::TurnCancelled { .. } => Some(TurnResolution::Cancelled),
        RuntimeEvent::TurnFailed { message } => Some(TurnResolution::Failed(message.clone())),
        _ => None,
    }
}

/// Forward one turn's envelopes to the client until the turn terminates.
///
/// Terminal events resolve the turn's pending `session/prompt` response
/// (`end_turn` / `cancelled` / a `-32603` error carrying the failure message)
/// after the corresponding `session/update` was written, then drop the turn's
/// tracking entries. A sink failure cleans up the same way: the client cannot
/// hear more updates, so the response would be lost anyway.
async fn pump_turn(
    state: Arc<ServerState>,
    session_id: SessionId,
    turn_id: TurnId,
    mut events: impl TurnEventStream,
) {
    loop {
        let Some(envelope) = events.next_envelope().await else {
            state
                .finish_turn(session_id, turn_id, TurnResolution::Closed)
                .await;
            return;
        };
        let terminal = terminal_resolution(&envelope.event);
        if let RuntimeEvent::ApprovalRequested {
            request_id,
            tool_name,
            tool_args,
            ..
        } = &envelope.event
        {
            send_permission_request(
                &state,
                envelope.session_id,
                turn_id,
                request_id,
                tool_name,
                tool_args,
            )
            .await;
        }
        // A subagent's file changes, plan and spend are not the session's.
        let from_child = envelope.parent_run_id.is_some();
        if let Some(update) = (!from_child)
            .then(|| updates::update_for_event(&envelope.event))
            .flatten()
        {
            let params = updates::session_update_params(envelope.session_id, update);
            if state
                .send_notification("session/update", params)
                .await
                .is_err()
            {
                state
                    .finish_turn(
                        envelope.session_id,
                        turn_id,
                        terminal.unwrap_or(TurnResolution::Closed),
                    )
                    .await;
                return;
            }
        }
        if let Some(resolution) = terminal {
            state
                .finish_turn(envelope.session_id, turn_id, resolution)
                .await;
            return;
        }
    }
}

impl ServerState {
    /// Resolve a turn's pending prompt response exactly once and drop the
    /// turn's tracking entries. Called by the pump on the terminal event and
    /// by `session/cancel` when no terminal event can arrive.
    async fn finish_turn(
        &self,
        session_id: SessionId,
        turn_id: TurnId,
        resolution: TurnResolution,
    ) {
        self.lock_pending_approvals()
            .retain(|_, (pending_turn, _)| *pending_turn != turn_id);
        let reply = self.lock_pending_prompts().remove(&turn_id);
        if let Some(id) = reply {
            let frame = match &resolution {
                TurnResolution::Finished => json!({
                    "jsonrpc": "2.0", "id": id, "result": { "stopReason": "end_turn" }
                }),
                TurnResolution::Cancelled | TurnResolution::Closed => json!({
                    "jsonrpc": "2.0", "id": id, "result": { "stopReason": "cancelled" }
                }),
                TurnResolution::Failed(message) => json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": rpc::INTERNAL_ERROR, "message": message }
                }),
            };
            if let Err(error) = self.send(&frame).await {
                tracing::warn!(%error, "failed to deliver the prompt response");
            }
        }
        self.lock_forwarders().remove(&turn_id);
        let mut active = self.lock_active_turns();
        if active.get(&session_id) == Some(&turn_id) {
            active.remove(&session_id);
        }
    }
}

/// The user's prompt: either a plain string (legacy) or an array of ACP
/// content blocks. Text blocks are concatenated; other block kinds (image,
/// audio, resource…) are ignored — the runtime conversation is text-only.
fn prompt_text(params: &Value) -> Result<String, String> {
    match params.get("prompt") {
        None | Some(Value::Null) => Err("prompt is required".to_string()),
        Some(Value::String(text)) => Ok(text.clone()),
        Some(Value::Array(blocks)) => {
            let mut parts: Vec<&str> = Vec::new();
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        parts.push(text);
                    }
                }
            }
            Ok(parts.join("\n"))
        }
        Some(_) => Err("prompt must be a string or an array of content blocks".to_string()),
    }
}

fn parse_session_id(params: &Value) -> Result<SessionId, String> {
    let raw = params
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "sessionId is required".to_string())?;
    raw.parse::<SessionId>()
        .map_err(|error| format!("invalid sessionId: {error}"))
}

fn optional_string(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use agente_core::types::ApprovalAction;
    use agente_core::types::ApprovalRequest;
    use agente_protocol::Role;
    use agente_runtime::{RuntimeConfig, RuntimeSupervisor};
    use tokio::io::{duplex, AsyncBufReadExt};
    use tokio::time::{timeout, Duration};

    const TEST_TIMEOUT: Duration = Duration::from_secs(10);

    fn test_runtime() -> RuntimeHandle {
        RuntimeSupervisor::start(RuntimeConfig::from_app_config(
            &AppConfig::default(),
            "D:/proj",
        ))
    }

    /// The client end of an in-memory connection to a running server.
    struct TestClient {
        writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
        reader:
            tokio::io::Lines<tokio::io::BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
    }

    impl TestClient {
        async fn send(&mut self, value: &Value) {
            let mut line = serde_json::to_string(value).unwrap();
            line.push('\n');
            self.writer.write_all(line.as_bytes()).await.unwrap();
            self.writer.flush().await.unwrap();
        }

        async fn send_raw(&mut self, raw: &str) {
            self.writer
                .write_all(format!("{raw}\n").as_bytes())
                .await
                .unwrap();
            self.writer.flush().await.unwrap();
        }

        async fn read(&mut self) -> Value {
            let line = timeout(TEST_TIMEOUT, self.reader.next_line())
                .await
                .expect("timed out waiting for a server frame")
                .expect("server read failed")
                .expect("server closed the connection");
            serde_json::from_str(&line).expect("server frame is not valid JSON")
        }
    }

    /// A connection whose state is reachable, so tests can seed tracking maps
    /// and spawn pumps sharing the same sink.
    struct Connection {
        client: TestClient,
        state: Arc<ServerState>,
        server: tokio::task::JoinHandle<Result<(), AcpError>>,
    }

    async fn start_connection(runtime: RuntimeHandle) -> Connection {
        let (server_side, client_side) = duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_side);
        let state = Arc::new(ServerState::new(runtime, server_write));
        let serve_state = Arc::clone(&state);
        let server = tokio::spawn(async move { serve_with_state(serve_state, server_read).await });
        let (client_read, client_write) = tokio::io::split(client_side);
        Connection {
            client: TestClient {
                writer: client_write,
                reader: BufReader::new(client_read).lines(),
            },
            state,
            server,
        }
    }

    /// Spawn a pump over a synthetic event channel so turns can be driven
    /// without a live agent.
    fn spawn_pump(
        connection: &Connection,
        session_id: SessionId,
        turn_id: TurnId,
        prompt_reply: Option<Value>,
    ) -> (
        tokio::sync::mpsc::Sender<RuntimeEventEnvelope>,
        tokio::task::JoinHandle<()>,
    ) {
        if let Some(reply) = prompt_reply {
            connection
                .state
                .pending_prompts
                .lock()
                .unwrap()
                .insert(turn_id, reply);
        }
        let (tx, rx) = tokio::sync::mpsc::channel::<RuntimeEventEnvelope>(32);
        let pump = tokio::spawn(pump_turn(
            Arc::clone(&connection.state),
            session_id,
            turn_id,
            rx,
        ));
        (tx, pump)
    }

    /// Build an envelope without a chrono dependency (the timestamp round-trips
    /// through serde).
    fn envelope(
        session_id: SessionId,
        turn_id: TurnId,
        event: RuntimeEvent,
    ) -> RuntimeEventEnvelope {
        serde_json::from_value(json!({
            "protocol_version": 1,
            "sequence": 1,
            "session_id": session_id.to_string(),
            "turn_id": turn_id.to_string(),
            "timestamp": "2024-01-01T00:00:00Z",
            "event": event
        }))
        .unwrap()
    }

    #[test]
    fn prompt_text_accepts_strings_and_content_blocks() {
        assert_eq!(prompt_text(&json!({ "prompt": "hello" })).unwrap(), "hello");
        assert_eq!(
            prompt_text(&json!({
                "prompt": [
                    { "type": "text", "text": "a" },
                    { "type": "text", "text": "b" }
                ]
            }))
            .unwrap(),
            "a\nb"
        );
        // Non-text blocks are ignored.
        assert_eq!(
            prompt_text(&json!({ "prompt": [{ "type": "image", "data": "x" }] })).unwrap(),
            ""
        );
        assert!(prompt_text(&json!({})).is_err());
        assert!(prompt_text(&json!({ "prompt": Value::Null })).is_err());
        assert!(prompt_text(&json!({ "prompt": 42 })).is_err());
    }

    #[tokio::test]
    async fn malformed_lines_are_rejected_and_survive() {
        let mut connection = start_connection(test_runtime()).await;
        connection.client.send_raw("this is not json").await;
        connection.client.send_raw("[1, 2, 3]").await;

        let parse_error = connection.client.read().await;
        assert_eq!(parse_error["id"], Value::Null);
        assert_eq!(parse_error["error"]["code"], rpc::PARSE_ERROR);

        let invalid = connection.client.read().await;
        assert_eq!(invalid["id"], Value::Null);
        assert_eq!(invalid["error"]["code"], rpc::INVALID_REQUEST);

        // The loop must still be alive and answering requests.
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 1);
        assert!(reply.get("result").is_some());
        connection.server.abort();
    }

    #[tokio::test]
    async fn notifications_get_no_response_and_survive() {
        let mut connection = start_connection(test_runtime()).await;
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "method": "initialized" }))
            .await;
        // Cancel for an unknown session: ignored silently.
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": SessionId::new().to_string() }
            }))
            .await;
        // Unknown notification: ignored silently.
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "method": "x/unknown" }))
            .await;
        // Still alive: the next request is answered and nothing preceded it.
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "id": 9, "method": "initialize", "params": {} }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(
            reply["id"], 9,
            "notifications must not produce frames before the response"
        );
        assert!(reply.get("result").is_some());
        connection.server.abort();
    }

    #[tokio::test]
    async fn initialize_matches_acp_v1_shape() {
        let mut connection = start_connection(test_runtime()).await;
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": 1, "clientCapabilities": {} }
            }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 1);
        assert!(reply.get("error").is_none());
        let result = &reply["result"];
        assert_eq!(result["protocolVersion"], 1);
        assert_eq!(ACP_PROTOCOL_VERSION, 1);
        assert_eq!(result["agentCapabilities"]["loadSession"], true);
        assert_eq!(
            result["agentCapabilities"]["promptCapabilities"]["embeddedContext"],
            true
        );
        assert_eq!(
            result["agentCapabilities"]["mcpCapabilities"]["http"],
            false
        );
        assert_eq!(result["agentCapabilities"]["mcpCapabilities"]["sse"], false);
        assert_eq!(result["authMethods"], json!([]));
        connection.server.abort();
    }

    #[tokio::test]
    async fn request_errors_carry_the_original_id() {
        let mut connection = start_connection(test_runtime()).await;
        // Unknown method → -32601.
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "id": 5, "method": "session/unknown" }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 5);
        assert_eq!(reply["error"]["code"], rpc::METHOD_NOT_FOUND);

        // Bad params → -32602 (never a `runtime/error` notification).
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "id": 6, "method": "session/load", "params": {} }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 6);
        assert_eq!(reply["error"]["code"], rpc::INVALID_PARAMS);

        // A wrong jsonrpc version is answered with the original id.
        connection
            .client
            .send(&json!({ "jsonrpc": "1.0", "id": 7, "method": "initialize" }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["error"]["code"], rpc::INVALID_REQUEST);
        connection.server.abort();
    }

    #[tokio::test]
    async fn legacy_session_approve_answers_with_accepted() {
        let mut connection = start_connection(test_runtime()).await;
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0", "id": 3, "method": "session/approve",
                "params": { "requestId": "no-such-approval", "decision": "approve_once" }
            }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 3);
        assert_eq!(reply["result"]["accepted"], false);

        // Unknown decision → -32602.
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0", "id": 4, "method": "session/approve",
                "params": { "requestId": "x", "decision": "sometimes" }
            }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 4);
        assert_eq!(reply["error"]["code"], rpc::INVALID_PARAMS);
        connection.server.abort();
    }

    #[tokio::test]
    async fn content_block_prompt_starts_turn_and_reports_failure() {
        let runtime = test_runtime();
        let mut connection = start_connection(runtime.clone()).await;
        let session_id = SessionId::new();
        // "no-such-provider" fails before any network access, so the turn ends
        // deterministically with TurnFailed.
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "session/prompt",
                "params": {
                    "sessionId": session_id.to_string(),
                    "prompt": [
                        { "type": "text", "text": "hello" },
                        { "type": "image", "data": "ignored" },
                        { "type": "text", "text": "world" }
                    ],
                    "provider": "no-such-provider"
                }
            }))
            .await;
        // The terminal event streams `turn_finished`, then the prompt response
        // arrives as a JSON-RPC error carrying the failure message.
        let mut saw_turn_finished = false;
        let reply = loop {
            let frame = connection.client.read().await;
            if frame.get("id").is_some() {
                break frame;
            }
            assert_eq!(frame["method"], "session/update");
            saw_turn_finished |= frame["params"]["update"]["sessionUpdate"] == "turn_finished";
        };
        assert!(
            saw_turn_finished,
            "terminal event must stream turn_finished first"
        );
        assert_eq!(reply["id"], 1);
        assert_eq!(
            reply["error"]["code"],
            rpc::INTERNAL_ERROR,
            "turn should fail: {reply}"
        );

        // The content blocks were concatenated into the user message.
        let conversation = runtime.session_snapshot(session_id).conversation;
        let user_text: Vec<&str> = conversation
            .iter()
            .filter(|message| message.role == Role::User)
            .map(|message| message.content.as_str())
            .collect();
        assert_eq!(user_text, vec!["hello\nworld"]);
        connection.server.abort();
    }

    #[tokio::test]
    async fn pump_streams_updates_and_resolves_the_prompt() {
        let mut connection = start_connection(test_runtime()).await;
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (events, pump) = spawn_pump(&connection, session_id, turn_id, Some(json!(42)));

        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::AssistantDelta {
                    text: "partial ".into(),
                },
            ))
            .await
            .unwrap();
        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::ToolProposed {
                    id: "t1".into(),
                    name: "read_file".into(),
                    arguments: r#"{"path":"a.rs"}"#.into(),
                },
            ))
            .await
            .unwrap();
        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::ToolResult {
                    id: "t1".into(),
                    name: "read_file".into(),
                    content: "ok".into(),
                    is_error: false,
                },
            ))
            .await
            .unwrap();
        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::TurnFinished { revision: 3 },
            ))
            .await
            .unwrap();
        drop(events);

        let delta = connection.client.read().await;
        assert_eq!(delta["method"], "session/update");
        assert_eq!(delta["params"]["sessionId"], session_id.to_string());
        assert_eq!(
            delta["params"]["update"]["sessionUpdate"],
            "agent_message_chunk"
        );
        assert_eq!(delta["params"]["update"]["content"]["text"], "partial ");

        let tool_call = connection.client.read().await;
        assert_eq!(tool_call["params"]["update"]["sessionUpdate"], "tool_call");
        assert_eq!(tool_call["params"]["update"]["toolCallId"], "t1");
        assert_eq!(tool_call["params"]["update"]["kind"], "read");
        assert_eq!(tool_call["params"]["update"]["status"], "pending");

        let tool_done = connection.client.read().await;
        assert_eq!(
            tool_done["params"]["update"]["sessionUpdate"],
            "tool_call_update"
        );
        assert_eq!(tool_done["params"]["update"]["status"], "completed");

        let finished = connection.client.read().await;
        assert_eq!(
            finished["params"]["update"]["sessionUpdate"],
            "turn_finished"
        );

        let response = connection.client.read().await;
        assert_eq!(response["id"], 42);
        assert_eq!(response["result"]["stopReason"], "end_turn");

        // The pump exits on its own after the terminal event.
        timeout(TEST_TIMEOUT, pump)
            .await
            .expect("pump did not exit")
            .expect("pump panicked");
        assert!(connection.state.pending_prompts.lock().unwrap().is_empty());
        assert!(connection.state.active_turns.lock().unwrap().is_empty());
        connection.server.abort();
    }

    #[tokio::test]
    async fn pump_reports_cancellation_and_failures() {
        let mut connection = start_connection(test_runtime()).await;
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (events, pump) = spawn_pump(&connection, session_id, turn_id, Some(json!(7)));

        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::TurnCancelled {
                    revision: 2,
                    partial_text: "par".into(),
                },
            ))
            .await
            .unwrap();
        let finished = connection.client.read().await;
        assert_eq!(
            finished["params"]["update"]["sessionUpdate"],
            "turn_finished"
        );
        let response = connection.client.read().await;
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["stopReason"], "cancelled");
        timeout(TEST_TIMEOUT, pump).await.unwrap().unwrap();

        // A failed turn answers with a JSON-RPC error carrying the message.
        let turn_id = TurnId::new();
        let (events, pump) = spawn_pump(&connection, session_id, turn_id, Some(json!(8)));
        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::TurnFailed {
                    message: "provider exploded".into(),
                },
            ))
            .await
            .unwrap();
        let finished = connection.client.read().await;
        assert_eq!(
            finished["params"]["update"]["sessionUpdate"],
            "turn_finished"
        );
        let response = connection.client.read().await;
        assert_eq!(response["id"], 8);
        assert_eq!(response["error"]["code"], rpc::INTERNAL_ERROR);
        assert_eq!(response["error"]["message"], "provider exploded");
        timeout(TEST_TIMEOUT, pump).await.unwrap().unwrap();
        connection.server.abort();
    }

    #[tokio::test]
    async fn request_permission_round_trips_to_the_runtime() {
        let runtime = test_runtime();
        let broker = runtime.approval_broker();
        let receiver = broker.request(&ApprovalRequest {
            request_id: "approval-1".into(),
            tool_name: "shell".into(),
            tool_args: r#"{"command":"cargo test"}"#.into(),
            description: "run tests".into(),
            is_dangerous: false,
            old_content: None,
            new_content: None,
            file_path: None,
        });
        let mut connection = start_connection(runtime).await;
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (events, _pump) = spawn_pump(&connection, session_id, turn_id, None);
        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::ApprovalRequested {
                    request_id: "approval-1".into(),
                    source: "parent".into(),
                    tool_name: "shell".into(),
                    tool_args: r#"{"command":"cargo test"}"#.into(),
                    description: "run tests".into(),
                    is_dangerous: false,
                    file_path: None,
                    child_run_id: None,
                    old_content: None,
                    new_content: None,
                },
            ))
            .await
            .unwrap();

        let request = connection.client.read().await;
        assert_eq!(request["method"], "session/request_permission");
        assert!(
            request["id"].is_u64(),
            "agent requests need a generated numeric id"
        );
        assert_eq!(request["params"]["sessionId"], session_id.to_string());
        assert_eq!(request["params"]["toolCall"]["toolCallId"], "approval-1");
        assert_eq!(request["params"]["toolCall"]["kind"], "execute");
        assert_eq!(request["params"]["toolCall"]["status"], "pending");
        assert_eq!(request["params"]["toolCall"]["title"], "shell cargo test");

        // The client picks an option; the decision must reach the broker.
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": { "outcome": { "outcome": "selected", "optionId": "allow_once" } }
            }))
            .await;
        let action = timeout(TEST_TIMEOUT, receiver)
            .await
            .expect("broker was never answered")
            .expect("broker dropped the request");
        assert!(matches!(action, ApprovalAction::ApproveOnce));
        assert!(connection
            .state
            .pending_approvals
            .lock()
            .unwrap()
            .is_empty());
        connection.server.abort();
    }

    #[tokio::test]
    async fn request_permission_cancelled_outcome_denies_by_cancelling() {
        let runtime = test_runtime();
        let broker = runtime.approval_broker();
        let receiver = broker.request(&ApprovalRequest {
            request_id: "approval-2".into(),
            tool_name: "write_file".into(),
            tool_args: r#"{"path":"x.rs"}"#.into(),
            description: "write".into(),
            is_dangerous: false,
            old_content: None,
            new_content: None,
            file_path: Some("x.rs".into()),
        });
        let mut connection = start_connection(runtime).await;
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (events, _pump) = spawn_pump(&connection, session_id, turn_id, None);
        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::ApprovalRequested {
                    request_id: "approval-2".into(),
                    source: "parent".into(),
                    tool_name: "write_file".into(),
                    tool_args: r#"{"path":"x.rs"}"#.into(),
                    description: "write".into(),
                    is_dangerous: false,
                    file_path: Some("x.rs".into()),
                    child_run_id: None,
                    old_content: None,
                    new_content: None,
                },
            ))
            .await
            .unwrap();
        let request = connection.client.read().await;
        assert_eq!(request["params"]["toolCall"]["kind"], "edit");
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": { "outcome": { "outcome": "cancelled" } }
            }))
            .await;
        let action = timeout(TEST_TIMEOUT, receiver).await.unwrap().unwrap();
        assert!(matches!(action, ApprovalAction::Cancel));
        connection.server.abort();
    }

    #[tokio::test]
    async fn session_cancel_resolves_an_unanswerable_prompt_and_aborts_its_pump() {
        let runtime = test_runtime();
        let mut connection = start_connection(runtime).await;
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        connection
            .state
            .active_turns
            .lock()
            .unwrap()
            .insert(session_id, turn_id);
        // Seed a pending prompt and a live pump, as `session/prompt` would.
        let (_events, pump) = spawn_pump(&connection, session_id, turn_id, Some(json!(77)));
        connection
            .state
            .forwarders
            .lock()
            .unwrap()
            .insert(turn_id, pump.abort_handle());

        // The runtime has no such turn, so no terminal event can arrive: the
        // cancel path must resolve the prompt and abort the pump itself.
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": session_id.to_string() }
            }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 77);
        assert_eq!(reply["result"]["stopReason"], "cancelled");
        timeout(TEST_TIMEOUT, pump)
            .await
            .expect("pump was not aborted")
            .expect_err("pump should have been aborted");
        assert!(connection.state.active_turns.lock().unwrap().is_empty());
        assert!(connection.state.forwarders.lock().unwrap().is_empty());

        // Explicit turnId targets that turn even without an active session.
        let other = TurnId::new();
        let (_events, pump) = spawn_pump(&connection, session_id, other, Some(json!(78)));
        connection
            .state
            .forwarders
            .lock()
            .unwrap()
            .insert(other, pump.abort_handle());
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": session_id.to_string(), "turnId": other.to_string() }
            }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 78);
        assert_eq!(reply["result"]["stopReason"], "cancelled");
        timeout(TEST_TIMEOUT, pump).await.unwrap().unwrap_err();

        // The loop is still alive afterwards.
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }))
            .await;
        assert_eq!(connection.client.read().await["id"], 1);
        connection.server.abort();
    }

    #[tokio::test]
    async fn stray_responses_are_ignored_without_breaking_the_loop() {
        let mut connection = start_connection(test_runtime()).await;
        // A response for an id we never issued must be dropped silently.
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "id": 404, "result": { "outcome": {} } }))
            .await;
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "id": "not-numeric", "result": {} }))
            .await;
        connection
            .client
            .send(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }))
            .await;
        let reply = connection.client.read().await;
        assert_eq!(reply["id"], 1);
        connection.server.abort();
    }

    #[tokio::test]
    async fn pending_approvals_are_pruned_on_legacy_approve_and_turn_finish() {
        let mut connection = start_connection(test_runtime()).await;
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        let (events, pump) = spawn_pump(&connection, session_id, turn_id, Some(json!(55)));

        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::ApprovalRequested {
                    request_id: "req-legacy".into(),
                    source: "parent".into(),
                    tool_name: "shell".into(),
                    tool_args: "{}".into(),
                    description: "run".into(),
                    is_dangerous: false,
                    file_path: None,
                    child_run_id: None,
                    old_content: None,
                    new_content: None,
                },
            ))
            .await
            .unwrap();
        let perm1 = connection.client.read().await;
        assert_eq!(perm1["method"], "session/request_permission");
        assert_eq!(connection.state.lock_pending_approvals().len(), 1);

        // Answering via legacy session/approve prunes the pending entry.
        connection
            .client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 90,
                "method": "session/approve",
                "params": { "requestId": "req-legacy", "decision": "deny" }
            }))
            .await;
        let approve_reply = connection.client.read().await;
        assert_eq!(approve_reply["id"], 90);
        assert!(connection.state.lock_pending_approvals().is_empty());

        // An unanswered approval when the turn finishes is pruned by finish_turn.
        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::ApprovalRequested {
                    request_id: "req-unanswered".into(),
                    source: "parent".into(),
                    tool_name: "shell".into(),
                    tool_args: "{}".into(),
                    description: "run".into(),
                    is_dangerous: false,
                    file_path: None,
                    child_run_id: None,
                    old_content: None,
                    new_content: None,
                },
            ))
            .await
            .unwrap();
        let perm2 = connection.client.read().await;
        assert_eq!(perm2["method"], "session/request_permission");
        assert_eq!(connection.state.lock_pending_approvals().len(), 1);

        events
            .send(envelope(
                session_id,
                turn_id,
                RuntimeEvent::TurnFinished { revision: 1 },
            ))
            .await
            .unwrap();
        drop(events);
        timeout(TEST_TIMEOUT, pump).await.unwrap().unwrap();
        assert!(connection.state.lock_pending_approvals().is_empty());
        connection.server.abort();
    }

    #[tokio::test]
    async fn stdin_eof_aborts_forwarders_and_clears_tracking_maps() {
        let connection = start_connection(test_runtime()).await;
        let session_id = SessionId::new();
        let turn_id = TurnId::new();
        connection
            .state
            .lock_active_turns()
            .insert(session_id, turn_id);
        connection
            .state
            .lock_pending_approvals()
            .insert(1, (turn_id, "req-eof".into()));
        let (_events, pump) = spawn_pump(&connection, session_id, turn_id, Some(json!(99)));
        connection
            .state
            .lock_forwarders()
            .insert(turn_id, pump.abort_handle());

        // Close the client side to simulate stdin EOF.
        drop(connection.client);
        timeout(TEST_TIMEOUT, connection.server)
            .await
            .expect("server did not exit on EOF")
            .expect("server task panicked")
            .expect("server returned an error on clean EOF");
        timeout(TEST_TIMEOUT, pump)
            .await
            .expect("pump was not aborted on EOF")
            .expect_err("pump should have been aborted");
        assert!(connection.state.lock_active_turns().is_empty());
        assert!(connection.state.lock_forwarders().is_empty());
        assert!(connection.state.lock_pending_prompts().is_empty());
        assert!(connection.state.lock_pending_approvals().is_empty());
    }
}
