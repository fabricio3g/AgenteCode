//! Two clients on one runtime, over in-memory pipes: what Desktop and an
//! attached terminal do over the real socket.

use std::time::Duration;

use agente_core::config::AppConfig;
use agente_daemon::{serve_connection, BotProfiles, Service};
use agente_runtime::{RuntimeConfig, RuntimeSupervisor};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines};

struct Client {
    writer: tokio::io::WriteHalf<DuplexStream>,
    lines: Lines<BufReader<tokio::io::ReadHalf<DuplexStream>>>,
    next_id: u64,
}

impl Client {
    fn connect(service: &Service) -> Self {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_side);
        tokio::spawn(serve_connection(service.clone(), server_read, server_write));
        let (read, writer) = tokio::io::split(client_side);
        Self {
            writer,
            lines: BufReader::new(read).lines(),
            next_id: 0,
        }
    }

    async fn send_raw(&mut self, line: &str) {
        self.writer.write_all(line.as_bytes()).await.unwrap();
        self.writer.write_all(b"\n").await.unwrap();
    }

    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(10), self.lines.next_line())
            .await
            .expect("a message within 10s")
            .unwrap()
            .expect("connection open");
        serde_json::from_str(&line).unwrap()
    }

    /// Send a request and return its response, keeping notifications that
    /// arrive first.
    async fn request(&mut self, method: &str, params: Value) -> (Value, Vec<Value>) {
        self.next_id += 1;
        let id = self.next_id;
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.send_raw(&message.to_string()).await;
        let mut notes = Vec::new();
        loop {
            let message = self.next().await;
            if message["id"] == json!(id) {
                return (message, notes);
            }
            notes.push(message);
        }
    }

    /// Notifications until one `pred` accepts (inclusive).
    async fn until(&mut self, mut seen: Vec<Value>, pred: impl Fn(&Value) -> bool) -> Vec<Value> {
        if seen.iter().any(&pred) {
            return seen;
        }
        loop {
            let message = self.next().await;
            let done = pred(&message);
            seen.push(message);
            if done {
                return seen;
            }
        }
    }
}

fn runtime(tag: &str) -> (Service, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("agente-daemon-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let bots = std::sync::Arc::new(agente_bot::BotStore::open(dir.join("bots")).unwrap());
    let profiles = std::sync::Arc::new(BotProfiles::new(bots.clone()));
    let config = RuntimeConfig::from_app_config(&AppConfig::default(), dir.to_string_lossy())
        .with_profile_source(profiles.clone());
    let runtime = RuntimeSupervisor::start(config);
    profiles.attach(runtime.clone());
    let service = Service { runtime, bots };
    (service, dir)
}

fn event_type(message: &Value) -> Option<&str> {
    (message["method"] == "event")
        .then(|| message["params"]["event"]["type"].as_str())
        .flatten()
}

#[tokio::test]
async fn a_started_command_streams_to_its_client_and_to_subscribers() {
    let (runtime, dir) = runtime("stream");
    let mut desktop = Client::connect(&runtime);
    let mut watcher = Client::connect(&runtime);

    let (hello, _) = desktop.request("initialize", json!({})).await;
    assert_eq!(hello["result"]["server"], "agente");
    assert_eq!(
        hello["result"]["protocol_version"],
        agente_protocol::PROTOCOL_VERSION
    );

    let (subscribed, _) = watcher.request("events.subscribe", Value::Null).await;
    assert_eq!(subscribed["result"]["ok"], true);

    let session_id = agente_protocol::SessionId::new().to_string();
    let (started, notes) = desktop
        .request(
            "turn.exec",
            json!({ "session_id": session_id, "tool": "shell", "arguments": { "command": "echo daemon-ok" } }),
        )
        .await;
    let turn_id = started["result"]["turn_id"]
        .as_str()
        .expect("turn id")
        .to_string();

    // The client that started it: every event, then the outcome.
    let seen = desktop
        .until(notes, |m| m["method"] == "turn.outcome")
        .await;
    let result = seen
        .iter()
        .find(|m| event_type(m) == Some("tool_result"))
        .expect("tool result event");
    assert!(result["params"]["event"]["content"]
        .as_str()
        .unwrap()
        .contains("daemon-ok"));
    assert!(seen.iter().any(|m| event_type(m) == Some("turn_finished")));
    let outcome = seen.iter().find(|m| m["method"] == "turn.outcome").unwrap();
    assert_eq!(outcome["params"]["status"], "completed");
    let finished = seen
        .iter()
        .filter(|m| event_type(m) == Some("turn_finished"))
        .count();
    assert_eq!(finished, 1, "own turns are not sent twice");

    // Another client watching sees the same turn.
    let watched = watcher
        .until(Vec::new(), |m| event_type(m) == Some("turn_finished"))
        .await;
    assert!(watched
        .iter()
        .all(|m| m["params"]["turn_id"] == json!(turn_id)));
    assert!(watched.iter().any(|m| event_type(m) == Some("tool_result")));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn bad_requests_are_answered_and_the_connection_survives() {
    let (runtime, dir) = runtime("errors");
    let mut client = Client::connect(&runtime);

    client.send_raw("{ not json").await;
    let parse = client.next().await;
    assert_eq!(parse["error"]["code"], -32700);

    let (unknown, _) = client.request("no.such.method", json!({})).await;
    assert_eq!(unknown["error"]["code"], -32601);

    let (bad_params, _) = client
        .request("session.delete", json!({ "session_id": 7 }))
        .await;
    assert_eq!(bad_params["error"]["code"], -32602);

    let (listed, _) = client.request("session.list", Value::Null).await;
    assert_eq!(listed["result"], json!([]));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn background_processes_are_listed_read_and_stopped_per_project() {
    let (runtime, dir) = runtime("processes");
    let project = dir.to_string_lossy().to_string();
    let mut client = Client::connect(&runtime);
    let session_id = agente_protocol::SessionId::new().to_string();
    let (_, notes) = client
        .request(
            "turn.exec",
            json!({ "session_id": session_id, "tool": "shell",
                    "arguments": { "command": "echo server up at http://localhost:7777; sleep 30", "background": true } }),
        )
        .await;
    client.until(notes, |m| m["method"] == "turn.outcome").await;

    let (listed, _) = client
        .request("processes.list", json!({ "project_dir": project }))
        .await;
    let list = listed["result"].as_array().unwrap();
    assert_eq!(list.len(), 1, "{listed}");
    assert_eq!(list[0]["status"], "running");
    assert_eq!(list[0]["urls"], json!(["http://localhost:7777"]));
    let id = list[0]["id"].as_str().unwrap().to_string();

    let (output, _) = client
        .request(
            "processes.output",
            json!({ "project_dir": project, "id": id }),
        )
        .await;
    assert!(output["result"]["output"]
        .as_str()
        .unwrap()
        .contains("server up"));

    let (other, _) = client
        .request("processes.list", json!({ "project_dir": "/elsewhere" }))
        .await;
    assert_eq!(other["result"], json!([]));

    let (stopped, _) = client
        .request(
            "processes.stop",
            json!({ "project_dir": project, "id": id }),
        )
        .await;
    assert_eq!(stopped["result"]["stopped"], true);
    let (after, _) = client
        .request("processes.list", json!({ "project_dir": project }))
        .await;
    assert_eq!(after["result"][0]["status"], "stopped");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn colina_chats_in_one_permanent_session_with_her_persona() {
    let (service, dir) = runtime("bots");
    let mut client = Client::connect(&service);

    let (list, _) = client.request("bots.list", json!({})).await;
    assert_eq!(list["result"][0]["handle"], "colina");
    assert_eq!(list["result"][0]["session_id"], Value::Null);

    // An unknown provider fails fast, before any network access.
    let chat =
        json!({ "handle": "colina", "text": "hello", "provider": "definitely-not-a-provider" });
    let (first, notes) = client.request("bots.chat", chat.clone()).await;
    let session_id = first["result"]["session_id"].clone();
    assert!(session_id.is_string(), "{first}");
    client.until(notes, |m| m["method"] == "turn.outcome").await;
    let (second, notes) = client.request("bots.chat", chat).await;
    assert_eq!(second["result"]["session_id"], session_id, "{second}");
    client.until(notes, |m| m["method"] == "turn.outcome").await;

    let (session, _) = client
        .request("session.get", json!({ "session_id": session_id }))
        .await;
    let system = session["result"]["snapshot"]["conversation"][0]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(system.starts_with("You are Colina (@colina)"), "{system}");

    let (refused, _) = client
        .request("bots.delete", json!({ "handle": "colina" }))
        .await;
    assert!(refused["error"]["message"]
        .as_str()
        .unwrap()
        .contains("built in"));
    let _ = std::fs::remove_dir_all(dir);
}

/// The real transport: a Unix socket, or a named pipe on Windows.
#[tokio::test]
async fn agente_serve_answers_on_its_local_socket() {
    let (service, dir) = runtime("local");
    #[cfg(unix)]
    let path = std::path::PathBuf::from(format!("/tmp/ag-serve-{}.sock", std::process::id()));
    #[cfg(windows)]
    let path = std::path::PathBuf::from(format!(r"\\.\pipe\agente-test-{}", std::process::id()));
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn({
        let path = path.clone();
        async move {
            agente_daemon::serve_local(service, &path, async {
                let _ = stopped.await;
            })
            .await
        }
    });
    let mut serving = false;
    for _ in 0..100 {
        if agente_daemon::is_serving(&path).await {
            serving = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(serving, "no server on {}", path.display());

    #[cfg(unix)]
    let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    #[cfg(windows)]
    let stream = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(path.as_os_str())
        .unwrap();
    let (read, mut write) = tokio::io::split(stream);
    write
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n")
        .await
        .unwrap();
    let mut lines = BufReader::new(read).lines();
    let reply: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(reply["result"]["server"], "agente");

    // A second daemon on the same path is refused.
    let (other, _) = runtime("local-2");
    let second = agente_daemon::serve_local(other, &path, async {}).await;
    assert!(matches!(
        second,
        Err(agente_daemon::ServeError::AlreadyRunning(_))
    ));

    let _ = stop.send(());
    server.await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
