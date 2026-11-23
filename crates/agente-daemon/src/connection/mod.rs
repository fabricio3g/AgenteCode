//! One client connection: JSON-RPC 2.0, one message per line, over any byte
//! stream (a Unix socket in production, an in-memory pipe in tests).
//!
//! Requests map onto [`RuntimeHandle`]. Events reach the client as `event`
//! notifications: the turns this connection starts stream losslessly from
//! their own channel; `events.subscribe` adds every other turn of the chosen
//! sessions from the runtime-wide stream (how a second window attaches).

mod handlers;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use agente_protocol::rpc::{self, Incoming};
use agente_protocol::{SessionId, TurnId};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use crate::Service;
use agente_runtime::{RuntimeError, RuntimeHandle, TurnHandle};

/// Messages queued for the client before sends start to wait on it.
const OUTBOX_CAPACITY: usize = 4_096;
/// Maximum size of a single inbound JSON-RPC line after auth (64 MiB).
const MAX_RPC_LINE_BYTES: usize = 64 * 1024 * 1024;

/// The session is running a turn.
const BUSY: i32 = -32001;
/// The caller may not do this.
const NOT_ALLOWED: i32 = -32003;

pub(crate) type Failure = (i32, String);

struct Connection {
    runtime: RuntimeHandle,
    outbox: mpsc::Sender<Value>,
    /// Turns started here: their events come from the turn's own channel, so
    /// the subscription must not send them a second time.
    own_turns: Mutex<HashSet<TurnId>>,
    subscription: Mutex<Option<JoinHandle<()>>>,
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    client_tools: Arc<crate::client_tools::ClientTools>,
    complements: Mutex<crate::complements::Complements>,
}

/// What `initialize` answers: the protocol and server versions.
pub(crate) fn initialize_result() -> Value {
    json!({
        "protocol_version": agente_protocol::PROTOCOL_VERSION,
        "server": "agente",
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": ["project", "processes", "sessions", "turns", "edits", "desktop_v1", "home_turns_v1", "provider_settings_v1", "complements_v1"],
    })
}

/// Serve one client until it disconnects.
pub async fn serve_connection<R, W>(service: Service, reader: R, writer: W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (outbox, mut outgoing) = mpsc::channel::<Value>(OUTBOX_CAPACITY);
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let writer_task = tokio::spawn(async move {
        let mut writer = writer;
        loop {
            let message = tokio::select! {
                biased;
                _ = &mut shutdown_rx => {
                    outgoing.close();
                    break;
                }
                message = outgoing.recv() => match message {
                    Some(message) => message,
                    None => return,
                },
            };
            let mut line = serde_json::to_vec(&message).unwrap_or_default();
            line.push(b'\n');
            if writer.write_all(&line).await.is_err() || writer.flush().await.is_err() {
                return;
            }
        }
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
        outbox,
        own_turns: Mutex::new(HashSet::new()),
        subscription: Mutex::new(None),
        tasks: Mutex::new(Vec::new()),
        client_tools: Arc::default(),
        complements: Mutex::default(),
    });

    let mut reader = BufReader::new(reader);
    let result = loop {
        let line = match rpc::read_bounded_line(&mut reader, MAX_RPC_LINE_BYTES).await {
            Ok(Some(line)) => line,
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
        };
        if line.trim().is_empty() {
            continue;
        }
        match rpc::classify(&line) {
            Ok(Incoming::Request { id, method, params }) => {
                if matches!(
                    method.as_str(),
                    "models.discover"
                        | "models.refresh_catalog"
                        | "providers.test"
                        | "session.compact"
                        | "session.generate_title"
                        | "llm.complete"
                        | "turn.start"
                        | "mcp.control"
                        | "runtime.configure"
                        | "processes.start"
                ) {
                    // Long-running and network-bound RPCs must never block the
                    // JSON-RPC reader loop (so turn.cancel, approval.respond,
                    // and client_tools.result stay responsive across all tabs).
                    let task_connection = Arc::clone(&connection);
                    connection.spawn_task(async move {
                        let connection = task_connection;
                        let outcome = match method.as_str() {
                            "turn.start" => connection.start_turn_async(params).await,
                            "session.compact" => connection.compact_session(params).await,
                            "models.discover" => connection.discover_models(params).await,
                            "models.refresh_catalog" => connection.refresh_catalog().await,
                            "providers.test" => connection.test_provider(params).await,
                            "session.generate_title" => connection.generate_title(params).await,
                            "llm.complete" => connection.llm_complete(params).await,
                            "mcp.control" => connection.control_mcp(params).await,
                            "runtime.configure" => connection
                                .runtime
                                .configure_and_connect(params)
                                .await
                                .map(|()| json!({ "ok": true }))
                                .map_err(runtime_failure),
                            "processes.start" => connection.start_process(params).await,
                            _ => unreachable!(),
                        };
                        let reply = match outcome {
                            Ok(result) => rpc::result_reply(id, result),
                            Err((code, message)) => error_reply(id, code, &message),
                        };
                        connection.send(reply).await;
                    });
                    continue;
                }
                let outcome = connection.handle(&method, params);
                let reply = match outcome {
                    Ok(result) => rpc::result_reply(id, result),
                    Err((code, message)) => error_reply(id, code, &message),
                };
                connection.send(reply).await;
            }
            // Nothing the daemon waits on arrives as a notification or a
            // response yet; ignore them rather than fail the connection.
            Ok(Incoming::Notification { .. } | Incoming::Response { .. }) => {}
            Err(error) => {
                connection.send(error.into_error_reply()).await;
            }
        }
    };

    if let Some(task) = connection.lock_subscription().take() {
        task.abort();
    }
    for task in connection.lock_tasks().drain(..) {
        task.abort();
    }
    connection.client_tools.disconnect(&connection.runtime);
    connection.lock_complements().clear();
    drop(connection);
    let _ = shutdown_tx.send(());
    let _ = writer_task.await;
    result
}

pub(crate) fn error_reply(id: Value, code: i32, message: &str) -> Value {
    rpc::error_reply(id, code, message)
}

fn notification(method: &str, params: Value) -> Value {
    rpc::notification(method, params)
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

    fn lock_tasks(&self) -> std::sync::MutexGuard<'_, Vec<tokio::task::AbortHandle>> {
        self.tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_complements(&self) -> std::sync::MutexGuard<'_, crate::complements::Complements> {
        self.complements
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn spawn_task(
        &self,
        future: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> tokio::task::AbortHandle {
        let mut tasks = self.lock_tasks();
        tasks.retain(|task| !task.is_finished());
        let handle = tokio::spawn(future).abort_handle();
        tasks.push(handle.clone());
        handle
    }

    async fn send(&self, message: Value) {
        // The writer only stops when the client is gone; nothing to do then.
        let _ = self.outbox.send(message).await;
    }

    /// Forward a turn this client started: every event, then its outcome.
    fn pump(
        self: &Arc<Self>,
        mut turn: TurnHandle,
        timeout: Option<tokio::task::AbortHandle>,
    ) -> TurnId {
        let turn_id = turn.turn_id();
        self.lock_own_turns().insert(turn_id);
        let connection = Arc::clone(self);
        self.spawn_task(async move {
            let mut guard = PumpGuard {
                connection: Arc::clone(&connection),
                turn_id,
                timeout,
            };
            while let Some(envelope) = turn.recv().await {
                let terminal = envelope.event.is_terminal();
                if let Ok(params) = serde_json::to_value(&envelope) {
                    connection.send(notification("event", params)).await;
                }
                if terminal {
                    break;
                }
            }
            let outcome = turn.outcome().await;
            guard.cleanup();
            if let Some(outcome) = outcome {
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

struct OwnTurnGuard<'a> {
    connection: &'a Connection,
    turn_id: TurnId,
    armed: bool,
}

impl<'a> OwnTurnGuard<'a> {
    fn new(connection: &'a Connection, turn_id: TurnId) -> Self {
        connection.lock_own_turns().insert(turn_id);
        Self {
            connection,
            turn_id,
            armed: true,
        }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for OwnTurnGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.connection.client_tools.finish_turn(self.turn_id);
            self.connection.lock_own_turns().remove(&self.turn_id);
        }
    }
}

struct PumpGuard {
    connection: Arc<Connection>,
    turn_id: TurnId,
    timeout: Option<tokio::task::AbortHandle>,
}

impl PumpGuard {
    fn cleanup(&mut self) {
        if let Some(timeout) = self.timeout.take() {
            timeout.abort();
        }
        self.connection.client_tools.finish_turn(self.turn_id);
        self.connection.lock_own_turns().remove(&self.turn_id);
    }
}

impl Drop for PumpGuard {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use agente_runtime::{RuntimeConfig, RuntimeSupervisor};
    use tokio::io::{duplex, AsyncBufReadExt};
    use tokio::time::{timeout, Duration};

    fn test_service() -> Service {
        let runtime =
            RuntimeSupervisor::start(RuntimeConfig::from_app_config(&AppConfig::default(), "."));
        Service { runtime }
    }

    #[tokio::test]
    async fn disconnect_aborts_tasks_and_finishes_without_hanging() {
        let service = test_service();
        let (server_side, client_side) = duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_side);
        let (client_read, mut client_write) = tokio::io::split(client_side);

        let server =
            tokio::spawn(async move { serve_connection(service, server_read, server_write).await });

        let session_id = SessionId::new();
        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "turn.start",
            "params": {
                "session_id": session_id,
                "prompt": { "role": "user", "content": "hi" },
                "provider": "definitely-not-a-provider"
            }
        });
        let mut line = serde_json::to_string(&request).unwrap();
        line.push('\n');
        client_write.write_all(line.as_bytes()).await.unwrap();
        client_write.flush().await.unwrap();

        // Wait for the turn.start reply (skipping any event notifications emitted
        // once the pump starts), then disconnect immediately.
        let mut lines = BufReader::new(client_read).lines();
        loop {
            let reply_line = timeout(Duration::from_secs(5), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let frame: Value = serde_json::from_str(&reply_line).unwrap();
            if frame.get("id") == Some(&json!(1)) {
                break;
            }
        }
        drop(client_write);
        drop(lines);

        timeout(Duration::from_secs(5), server)
            .await
            .expect("serve_connection must not hang on disconnect")
            .expect("server task panicked")
            .expect("clean EOF should return Ok(())");
    }

    #[tokio::test]
    async fn subscribed_turn_does_not_duplicate_turn_started_and_cleans_own_turns() {
        let service = test_service();
        let (server_side, client_side) = duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_side);
        let (client_read, mut client_write) = tokio::io::split(client_side);

        let server =
            tokio::spawn(async move { serve_connection(service, server_read, server_write).await });

        let mut lines = BufReader::new(client_read).lines();
        async fn send_frame(
            writer: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
            value: Value,
        ) {
            let mut text = serde_json::to_string(&value).unwrap();
            text.push('\n');
            writer.write_all(text.as_bytes()).await.unwrap();
            writer.flush().await.unwrap();
        }

        let session_id = SessionId::new();
        send_frame(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "events.subscribe",
                "params": { "session_ids": [session_id] }
            }),
        )
        .await;
        let sub_reply: Value = serde_json::from_str(
            &timeout(Duration::from_secs(5), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(sub_reply["id"], 1);

        send_frame(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "turn.start",
                "params": {
                    "session_id": session_id,
                    "prompt": { "role": "user", "content": "hi" },
                    "provider": "definitely-not-a-provider"
                }
            }),
        )
        .await;

        let mut turn_started_count = 0usize;
        let mut saw_outcome = false;
        while !saw_outcome {
            let frame_line = timeout(Duration::from_secs(5), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let frame: Value = serde_json::from_str(&frame_line).unwrap();
            if frame.get("method").and_then(Value::as_str) == Some("event")
                && frame.pointer("/params/event/type").and_then(Value::as_str)
                    == Some("turn_started")
            {
                turn_started_count += 1;
            }
            if frame.get("method").and_then(Value::as_str) == Some("turn.outcome") {
                saw_outcome = true;
            }
        }
        assert_eq!(
            turn_started_count, 1,
            "TurnStarted must not be duplicated between pump and events.subscribe"
        );
        drop(client_write);
        drop(lines);
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn home_turn_timeout_task_is_aborted_when_turn_finishes_early() {
        let service = test_service();
        let (outbox, _outgoing) = mpsc::channel::<Value>(32);
        let connection = Arc::new(Connection {
            runtime: service.runtime,
            outbox,
            own_turns: Mutex::new(HashSet::new()),
            subscription: Mutex::new(None),
            tasks: Mutex::new(Vec::new()),
            client_tools: Arc::default(),
            complements: Mutex::default(),
        });

        let session_id = SessionId::new();
        connection
            .client_tools
            .register(session_id, Vec::new())
            .unwrap();

        let timeout_handle = connection.spawn_task(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
        });
        assert!(!timeout_handle.is_finished());

        let turn_id = TurnId::new();
        connection.lock_own_turns().insert(turn_id);
        let mut guard = PumpGuard {
            connection: Arc::clone(&connection),
            turn_id,
            timeout: Some(timeout_handle.clone()),
        };
        guard.cleanup();
        tokio::task::yield_now().await;

        assert!(
            timeout_handle.is_finished(),
            "timeout task must be aborted when turn finishes early"
        );
        assert!(connection.lock_own_turns().is_empty());
    }
}
