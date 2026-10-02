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
use agente_protocol::{
    ApprovalDecision, Attachment, Message, RunId, SessionId, StartTurn, Trust, TurnId,
};

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
    client_tools: Arc<crate::client_tools::ClientTools>,
}

/// What `initialize` answers: the protocol and server versions.
pub(crate) fn initialize_result() -> Value {
    json!({
        "protocol_version": agente_protocol::PROTOCOL_VERSION,
        "server": "agente",
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": ["bots", "routines", "project", "processes", "sessions", "turns", "edits", "desktop_v1", "home_turns_v1", "provider_settings_v1"],
    })
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
        client_tools: Arc::default(),
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
                if method == "models.discover" {
                    // A slow models endpoint must not hold up the connection.
                    let connection = Arc::clone(&connection);
                    tokio::spawn(async move {
                        let outcome = connection.discover_models(params).await;
                        let reply = match outcome {
                            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            Err((code, message)) => error_reply(id, code, &message),
                        };
                        connection.send(reply).await;
                    });
                    continue;
                }
                let outcome = if method == "mcp.control" {
                    #[derive(Deserialize)]
                    struct Params {
                        project_dir: String,
                        name: String,
                        action: String,
                    }
                    match parse::<Params>(params) {
                        Ok(Params {
                            project_dir,
                            name,
                            action,
                        }) => connection
                            .runtime
                            .control_mcp(&project_dir, &name, &action)
                            .await
                            .map(|()| json!({ "ok": true }))
                            .map_err(runtime_failure),
                        Err(error) => Err(error),
                    }
                } else if method == "runtime.configure" {
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
    connection.client_tools.disconnect(&connection.runtime);
    drop(connection);
    let _ = writer_task.await;
    result
}

pub(crate) fn error_reply(id: Value, code: i32, message: &str) -> Value {
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
struct OpenSessionParams {
    session_id: SessionId,
    project_dir: String,
}

#[derive(Deserialize)]
struct ForkParams {
    session_id: SessionId,
    #[serde(default)]
    conversation_index: Option<usize>,
}

#[derive(Deserialize)]
struct TurnParams {
    turn_id: TurnId,
}

#[derive(Deserialize)]
struct SteerParams {
    turn_id: TurnId,
    content: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
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
    /// `models.discover {provider}` → the provider's live list, enriched,
    /// each model with its thinking profile.
    async fn discover_models(&self, params: Value) -> Result<Value, Failure> {
        #[derive(Deserialize)]
        struct Params {
            provider: String,
        }
        let Params { provider } = parse(params)?;
        let models = self
            .runtime
            .discover_models(&provider)
            .await
            .map_err(runtime_failure)?;
        Ok(json!({
            "provider": provider,
            "models": models.iter().map(agente_core::models::model_json).collect::<Vec<_>>(),
        }))
    }

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
            "initialize" => Ok(initialize_result()),
            "runtime.settings" => Ok(runtime.settings()),
            "models.info" => {
                #[derive(Deserialize)]
                struct Params {
                    provider: String,
                    model: String,
                }
                let Params { provider, model } = parse(params)?;
                let info = runtime.model_info(&provider, &model);
                Ok(json!({
                    "id": info.id,
                    "name": info.name,
                    "provider_id": info.provider_id,
                    "capabilities": info.capabilities,
                    "cost": info.cost,
                    "limits": info.limits,
                    "reasoning_options": info.reasoning_options,
                    "reasoning_stream_field": info.reasoning_stream_field,
                    "transport": agente_core::models::transport_json(&info),
                }))
            }
            "providers.list" => Ok(json!({
                "providers": agente_core::providers::spec::all(),
            })),
            "providers.status" => Ok(runtime.provider_status()),
            "providers.connect" => {
                #[derive(Deserialize)]
                struct Params {
                    id: String,
                    #[serde(default)]
                    api_key: Option<String>,
                    #[serde(default)]
                    base_url: Option<String>,
                }
                let Params {
                    id,
                    api_key,
                    base_url,
                } = parse(params)?;
                runtime
                    .connect_provider(&id, api_key, base_url)
                    .map_err(runtime_failure)?;
                Ok(runtime.provider_status())
            }
            "providers.disconnect" => {
                #[derive(Deserialize)]
                struct Params {
                    id: String,
                }
                let Params { id } = parse(params)?;
                runtime.disconnect_provider(&id).map_err(runtime_failure)?;
                Ok(runtime.provider_status())
            }
            "providers.set_default" => {
                #[derive(Deserialize)]
                struct Params {
                    provider: String,
                    model: String,
                }
                let Params { provider, model } = parse(params)?;
                runtime
                    .set_default_model(&provider, &model)
                    .map_err(runtime_failure)?;
                Ok(runtime.provider_status())
            }
            "models.thinking" => {
                #[derive(Deserialize)]
                struct Params {
                    provider: String,
                    model: String,
                }
                let Params { provider, model } = parse(params)?;
                to_json(runtime.thinking_profile(&provider, &model))
            }
            "thinking.template" => {
                #[derive(Deserialize)]
                struct Params {
                    template: String,
                }
                let Params { template } = parse(params)?;
                to_json(agente_core::providers::llamacpp::template_profile(
                    &template,
                ))
            }
            "thinking.request" => {
                #[derive(Deserialize)]
                struct Params {
                    provider: String,
                    model: String,
                    level: String,
                }
                let Params {
                    provider,
                    model,
                    level,
                } = parse(params)?;
                if let Some(error) = runtime.model_info(&provider, &model).api.route_error {
                    return Err((rpc::INVALID_PARAMS, error));
                }
                Ok(json!({ "body": runtime.thinking_request(&provider, &model, &level) }))
            }
            "media.import" => crate::project::import_media(params),
            "children.cancel" => {
                #[derive(Deserialize)]
                struct Params {
                    run_id: RunId,
                }
                let Params { run_id } = parse(params)?;
                Ok(json!({ "ok": runtime.cancel_child(run_id) }))
            }
            "session.list" => to_json(runtime.session_infos()),
            "session.get" => {
                let SessionParams { session_id } = parse(params)?;
                Ok(json!({
                    "snapshot": to_json(runtime.session_snapshot(session_id))?,
                    "meta": to_json(runtime.session_meta(session_id))?,
                }))
            }
            "session.open" => {
                let OpenSessionParams {
                    session_id,
                    project_dir,
                } = parse(params)?;
                Ok(
                    json!({ "snapshot": runtime.open_session(session_id, &project_dir).map_err(runtime_failure)? }),
                )
            }
            "session.checkpoints" => {
                let SessionParams { session_id } = parse(params)?;
                Ok(runtime.checkpoints(session_id))
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
                let ForkParams {
                    session_id,
                    conversation_index,
                } = parse(params)?;
                if runtime.is_busy(session_id) {
                    return Err((BUSY, "wait for the turn to finish before forking".into()));
                }
                if conversation_index.is_some_and(|index| {
                    index > runtime.session_snapshot(session_id).conversation.len()
                }) {
                    return Err((
                        rpc::INVALID_PARAMS,
                        "conversation index is beyond this session".into(),
                    ));
                }
                let fork = runtime.fork_session(session_id);
                if let Some(index) = conversation_index {
                    runtime
                        .rewind(fork.session_id, index)
                        .map_err(runtime_failure)?;
                }
                to_json(runtime.session_snapshot(fork.session_id))
            }
            "client_tools.register" => {
                let registration: agente_protocol::RegisterClientTools = parse(params)?;
                if runtime.is_busy(registration.session_id) {
                    return Err((BUSY, "Home session is busy".into()));
                }
                self.client_tools
                    .register(registration.session_id, registration.tools)
                    .map_err(|error| (rpc::INVALID_PARAMS, error))?;
                Ok(json!({"ok": true}))
            }
            "client_tools.result" => {
                self.client_tools
                    .result(parse(params)?)
                    .map_err(|error| (rpc::INVALID_PARAMS, error))?;
                Ok(json!({"ok": true}))
            }
            "turn.start" => {
                let start: StartTurn = parse(params)?;
                // Nothing to answer: a blank prompt would start a whole turn
                // of the model exploring on its own.
                if start.conversation.is_empty()
                    && start.prompt.as_ref().is_some_and(|prompt| {
                        prompt.content.trim().is_empty() && prompt.attachments.is_empty()
                    })
                {
                    return Err((rpc::INVALID_PARAMS, "Empty message".into()));
                }
                let turn = if let Some(policy) = &start.home {
                    if policy.max_iterations == 0
                        || policy.max_iterations > 500
                        || policy.max_tool_calls > 1000
                        || policy.max_time_ms == 0
                        || policy.max_time_ms > 3_600_000
                    {
                        return Err((rpc::INVALID_PARAMS, "Invalid Home turn budgets".into()));
                    }
                    let turn_id = TurnId::new();
                    let extra = self
                        .client_tools
                        .tools(start.session_id, turn_id, policy, self.outbox.clone())
                        .map_err(|error| (rpc::INVALID_PARAMS, error))?;
                    let timeout = policy.max_time_ms;
                    let turn = runtime
                        .start_turn_with_tools(
                            start,
                            turn_id,
                            Some(agente_core::agent::TurnTools {
                                extra,
                                only: Some(Vec::new()),
                                ..Default::default()
                            }),
                        )
                        .map_err(runtime_failure)?;
                    let runtime = runtime.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;
                        runtime.cancel(turn_id);
                    });
                    turn
                } else {
                    runtime.start_turn(start).map_err(runtime_failure)?
                };
                let conversation_index = turn.conversation_index;
                Ok(json!({ "turn_id": self.pump(turn), "conversation_index": conversation_index }))
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
                let SteerParams {
                    turn_id,
                    content,
                    attachments,
                } = parse(params)?;
                let mut message = Message::user(content);
                message.attachments = attachments;
                Ok(json!({ "ok": runtime.steer_message(turn_id, message) }))
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
            bots if bots.starts_with("bots.") => {
                crate::bots::handle(&self.bots, runtime, method, params)
            }
            "routines.run_now" => {
                let service = Service {
                    runtime: self.runtime.clone(),
                    bots: Arc::clone(&self.bots),
                };
                let turn = crate::routines::run_now(&service, params)?;
                let session_id = turn.session_id();
                Ok(json!({ "turn_id": self.pump(turn), "session_id": session_id }))
            }
            "project.info" | "project.init" | "project.expand_prompt" | "mcp.status" => {
                crate::project::handle(runtime, method, params)
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
