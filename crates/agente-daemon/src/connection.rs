//! One client connection: JSON-RPC 2.0, one message per line, over any byte
//! stream (a Unix socket in production, an in-memory pipe in tests).
//!
//! Requests map onto [`RuntimeHandle`]. Events reach the client as `event`
//! notifications: the turns this connection starts stream losslessly from
//! their own channel; `events.subscribe` adds every other turn of the chosen
//! sessions from the runtime-wide stream (how a second window attaches).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use agente_acp::rpc::{self, FrameError, Incoming};
use agente_bot::BotStore;
use agente_protocol::{ApprovalDecision, SessionId, StartTurn, Trust, TurnId, UserInput};

use crate::Service;
use agente_runtime::{RuntimeError, RuntimeHandle, TurnHandle};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

/// Messages queued for the client before sends start to wait on it.
const OUTBOX_CAPACITY: usize = 4_096;

/// The session is running a turn.
const BUSY: i32 = -32001;
/// The caller may not do this.
const NOT_ALLOWED: i32 = -32003;

pub(crate) type Failure = (i32, String);

struct Connection {
    runtime: RuntimeHandle,
    bots: Arc<BotStore>,
    outbox: mpsc::Sender<Value>,
    /// Turns started here: their events come from the turn's own channel, so
    /// the subscription must not send them a second time.
    own_turns: Mutex<HashSet<TurnId>>,
    subscription: Mutex<Option<JoinHandle<()>>>,
}

/// Serve one client until it disconnects.
pub async fn serve_connection<R, W>(service: Service, reader: R, writer: W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (outbox, mut outgoing) = mpsc::channel::<Value>(OUTBOX_CAPACITY);
    let writer_task = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(message) = outgoing.recv().await {
            let mut line = serde_json::to_vec(&message).unwrap_or_default();
            line.push(b'\n');
            if writer.write_all(&line).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
    });

    let connection = Arc::new(Connection {
        runtime: service.runtime,
        bots: service.bots,
        outbox,
        own_turns: Mutex::new(HashSet::new()),
        subscription: Mutex::new(None),
    });

    let mut lines = BufReader::new(reader).lines();
    let result = loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
        };
        if line.trim().is_empty() {
            continue;
        }
        match rpc::classify(&line) {
            Ok(Incoming::Request { id, method, params }) => {
                let outcome = if method == "runtime.configure" {
                    // Waits for the MCP servers the patch names, so the next
                    // turn already sees their tools.
                    connection
                        .runtime
                        .configure_and_connect(params)
                        .await
                        .map(|()| json!({ "ok": true }))
                        .map_err(runtime_failure)
                } else {
                    connection.handle(&method, params)
                };
                let reply = match outcome {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    Err((code, message)) => error_reply(id, code, &message),
                };
                connection.send(reply).await;
            }
            // Nothing the daemon waits on arrives as a notification or a
            // response yet; ignore them rather than fail the connection.
            Ok(Incoming::Notification { .. } | Incoming::Response { .. }) => {}
            Err(FrameError::Parse(error)) => {
                connection
                    .send(error_reply(
                        Value::Null,
                        rpc::PARSE_ERROR,
                        &format!("parse error: {error}"),
                    ))
                    .await;
            }
            Err(FrameError::NotAMessage) => {
                connection
                    .send(error_reply(
                        Value::Null,
                        rpc::INVALID_REQUEST,
                        "expected a JSON-RPC message object",
                    ))
                    .await;
            }
            Err(FrameError::UnsupportedProtocol(id)) => {
                connection
                    .send(error_reply(id, rpc::INVALID_REQUEST, "jsonrpc must be 2.0"))
                    .await;
            }
        }
    };

    if let Some(task) = connection.lock_subscription().take() {
        task.abort();
    }
    drop(connection);
    let _ = writer_task.await;
    result
}

fn error_reply(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub(crate) fn parse<T: DeserializeOwned>(params: Value) -> Result<T, Failure> {
    serde_json::from_value(params).map_err(|error| (rpc::INVALID_PARAMS, error.to_string()))
}

pub(crate) fn runtime_failure(error: RuntimeError) -> Failure {
    let code = match error {
        RuntimeError::SessionBusy(_) => BUSY,
        RuntimeError::NotAllowed(_) => NOT_ALLOWED,
        RuntimeError::Config(_) => rpc::INVALID_PARAMS,
        _ => rpc::INTERNAL_ERROR,
    };
    (code, error.to_string())
}

fn to_json(value: impl serde::Serialize) -> Result<Value, Failure> {
    serde_json::to_value(value).map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))
}

#[derive(Deserialize)]
struct SessionParams {
    session_id: SessionId,
}

#[derive(Deserialize)]
struct TurnParams {
    turn_id: TurnId,
}

#[derive(Deserialize)]
struct SteerParams {
    turn_id: TurnId,
    content: String,
}

#[derive(Deserialize)]
struct ExecParams {
    session_id: SessionId,
    tool: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Deserialize)]
struct RewindParams {
    session_id: SessionId,
    conversation_index: usize,
}

#[derive(Deserialize, Default)]
struct SubscribeParams {
    /// Only these sessions; all sessions when absent.
    #[serde(default)]
    session_ids: Option<Vec<SessionId>>,
}

#[derive(Deserialize)]
struct ProjectParams {
    project_dir: String,
}

#[derive(Deserialize)]
struct ProcessParams {
    project_dir: String,
    id: String,
    #[serde(default)]
    tail_chars: Option<usize>,
}

/// A background process as clients list it.
fn process_json(process: &agente_core::tools::processes::BackgroundProcess) -> Value {
    use agente_core::tools::processes::ProcessStatus;
    let (status, exit_code) = match process.status() {
        ProcessStatus::Running => ("running", None),
        ProcessStatus::Exited(code) => ("exited", code),
        ProcessStatus::Stopped => ("stopped", None),
    };
    json!({
        "id": process.id,
        "command": process.command,
        "project_dir": process.project_dir,
        "started_at": process.started_at,
        "status": status,
        "exit_code": exit_code,
        "urls": process.urls(),
    })
}

fn find_process(
    params: &ProcessParams,
) -> Result<std::sync::Arc<agente_core::tools::processes::BackgroundProcess>, Failure> {
    agente_core::tools::processes::find(&params.project_dir, &params.id).ok_or_else(|| {
        (
            rpc::INVALID_PARAMS,
            format!("no background process {}", params.id),
        )
    })
}

#[derive(Deserialize)]
struct ClientStateParams {
    session_id: SessionId,
    client: String,
    state: Value,
    #[serde(default)]
    title: Option<String>,
}

impl Connection {
    fn lock_subscription(&self) -> std::sync::MutexGuard<'_, Option<JoinHandle<()>>> {
        self.subscription
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_own_turns(&self) -> std::sync::MutexGuard<'_, HashSet<TurnId>> {
        self.own_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn send(&self, message: Value) {
        // The writer only stops when the client is gone; nothing to do then.
        let _ = self.outbox.send(message).await;
    }

    fn handle(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, Failure> {
        let runtime = &self.runtime;
        match method {
            "initialize" => Ok(json!({
                "protocol_version": agente_protocol::PROTOCOL_VERSION,
                "server": "agente",
                "version": env!("CARGO_PKG_VERSION"),
            })),
            "session.list" => to_json(runtime.session_infos()),
            "session.get" => {
                let SessionParams { session_id } = parse(params)?;
                Ok(json!({
                    "snapshot": to_json(runtime.session_snapshot(session_id))?,
                    "meta": to_json(runtime.session_meta(session_id))?,
                }))
            }
            "session.delete" => {
                let SessionParams { session_id } = parse(params)?;
                let deleted = runtime
                    .delete_session(session_id)
                    .map_err(runtime_failure)?;
                Ok(json!({ "deleted": deleted }))
            }
            "session.compact" => {
                let SessionParams { session_id } = parse(params)?;
                to_json(runtime.compact(session_id).map_err(runtime_failure)?)
            }
            "session.fork" => {
                let SessionParams { session_id } = parse(params)?;
                to_json(runtime.fork_session(session_id))
            }
            "turn.start" => {
                let start: StartTurn = parse(params)?;
                let turn = runtime.start_turn(start).map_err(runtime_failure)?;
                Ok(json!({ "turn_id": self.pump(turn) }))
            }
            "turn.exec" => {
                // Whoever can open the socket is the owner: it is created
                // readable by this user only.
                let ExecParams {
                    session_id,
                    tool,
                    arguments,
                } = parse(params)?;
                let turn = runtime
                    .exec_tool(session_id, &tool, arguments, Trust::Owner)
                    .map_err(runtime_failure)?;
                Ok(json!({ "turn_id": self.pump(turn) }))
            }
            "turn.cancel" => {
                let TurnParams { turn_id } = parse(params)?;
                Ok(json!({ "ok": runtime.cancel(turn_id) }))
            }
            "turn.steer" => {
                let SteerParams { turn_id, content } = parse(params)?;
                Ok(json!({ "ok": runtime.steer(turn_id, UserInput { content }) }))
            }
            "approval.respond" => {
                let decision: ApprovalDecision = parse(params)?;
                Ok(json!({ "ok": runtime.approve(decision) }))
            }
            "edits.undo" => {
                let SessionParams { session_id } = parse(params)?;
                Ok(json!({ "paths": runtime.undo(session_id).map_err(runtime_failure)? }))
            }
            "edits.redo" => {
                let SessionParams { session_id } = parse(params)?;
                Ok(json!({ "paths": runtime.redo(session_id).map_err(runtime_failure)? }))
            }
            "edits.rewind" => {
                let RewindParams {
                    session_id,
                    conversation_index,
                } = parse(params)?;
                let reverted = runtime
                    .rewind(session_id, conversation_index)
                    .map_err(runtime_failure)?;
                Ok(json!({ "reverted": reverted }))
            }
            "events.subscribe" => {
                let SubscribeParams { session_ids } = if params.is_null() {
                    SubscribeParams::default()
                } else {
                    parse(params)?
                };
                self.subscribe(session_ids.map(|ids| ids.into_iter().collect()));
                Ok(json!({ "ok": true }))
            }
            "client_state.save" => {
                let ClientStateParams {
                    session_id,
                    client,
                    state,
                    title,
                } = parse(params)?;
                runtime
                    .save_client_state(session_id, &client, state, title)
                    .map_err(runtime_failure)?;
                Ok(json!({ "ok": true }))
            }
            "processes.list" => {
                let ProjectParams { project_dir } = parse(params)?;
                let list = agente_core::tools::processes::list(&project_dir);
                Ok(Value::Array(
                    list.iter().map(|process| process_json(process)).collect(),
                ))
            }
            "processes.output" => {
                let params: ProcessParams = parse(params)?;
                let process = find_process(&params)?;
                Ok(json!({ "output": process.output(params.tail_chars.unwrap_or(64 * 1024)) }))
            }
            "processes.stop" => {
                let params: ProcessParams = parse(params)?;
                let process = find_process(&params)?;
                Ok(json!({ "stopped": agente_core::tools::processes::stop(&process) }))
            }
            "bots.chat" => {
                let start = crate::bots::chat_turn(&self.bots, params)?;
                let session_id = start.session_id;
                let turn = runtime.start_turn(start).map_err(runtime_failure)?;
                Ok(json!({ "turn_id": self.pump(turn), "session_id": session_id }))
            }
            bots if bots.starts_with("bots.") => crate::bots::handle(&self.bots, method, params),
            "routines.run_now" => {
                let service = Service {
                    runtime: self.runtime.clone(),
                    bots: Arc::clone(&self.bots),
                };
                let turn = crate::routines::run_now(&service, params)?;
                let session_id = turn.session_id();
                Ok(json!({ "turn_id": self.pump(turn), "session_id": session_id }))
            }
            routines if routines.starts_with("routines.") => {
                crate::routines::handle(&self.bots, method, params)
            }
            _ => Err((rpc::METHOD_NOT_FOUND, format!("unknown method {method}"))),
        }
    }

    /// Forward a turn this client started: every event, then its outcome.
    fn pump(self: &Arc<Self>, mut turn: TurnHandle) -> TurnId {
        let turn_id = turn.turn_id();
        self.lock_own_turns().insert(turn_id);
        let connection = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(envelope) = turn.recv().await {
                let terminal = envelope.event.is_terminal();
                if let Ok(params) = serde_json::to_value(&envelope) {
                    connection.send(notification("event", params)).await;
                }
                if terminal {
                    break;
                }
            }
            if let Some(outcome) = turn.outcome().await {
                if let Ok(params) = serde_json::to_value(&outcome) {
                    connection.send(notification("turn.outcome", params)).await;
                }
            }
        });
        turn_id
    }

    /// Replace this client's subscription to other turns' events.
    fn subscribe(self: &Arc<Self>, sessions: Option<HashSet<SessionId>>) {
        let mut events = self.runtime.subscribe();
        let connection = Arc::clone(self);
        let task = tokio::spawn(async move {
            loop {
                let envelope = match events.recv().await {
                    Ok(envelope) => envelope,
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        // The client should re-read the sessions it shows.
                        connection
                            .send(notification("events.lagged", json!({ "missed": missed })))
                            .await;
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let wanted = sessions
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&envelope.session_id));
                if !wanted || connection.lock_own_turns().contains(&envelope.turn_id) {
                    continue;
                }
                if let Ok(params) = serde_json::to_value(&envelope) {
                    connection.send(notification("event", params)).await;
                }
            }
        });
        if let Some(previous) = self.lock_subscription().replace(task) {
            previous.abort();
        }
    }
}
