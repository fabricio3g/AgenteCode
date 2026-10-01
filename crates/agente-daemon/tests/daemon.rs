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

/// Prints a local URL, then keeps running (sh on Unix, cmd.exe on Windows).
#[cfg(unix)]
const LONG_RUNNING_SERVER: &str = "echo server up at http://localhost:7777; sleep 30";
#[cfg(windows)]
const LONG_RUNNING_SERVER: &str =
    "echo server up at http://localhost:7777 & ping -n 30 127.0.0.1 > nul";

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
                    "arguments": { "command": LONG_RUNNING_SERVER, "background": true } }),
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
    // A pipe client retries while the server is between instances
    // (ERROR_PIPE_BUSY), as Node's net.connect does for Desktop.
    #[cfg(windows)]
    let stream = {
        let mut attempt = 0;
        loop {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(path.as_os_str()) {
                Ok(stream) => break stream,
                Err(error) if error.raw_os_error() == Some(231) && attempt < 50 => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(error) => panic!("{error}"),
            }
        }
    };
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

#[tokio::test]
async fn home_profile_skips_project_instructions_and_requires_registered_tools() {
    let (service, dir) = runtime("home-profile");
    std::fs::write(dir.join("AGENTS.md"), "PROJECT SECRET MUST NOT REACH HOME").unwrap();
    let mut client = Client::connect(&service);
    let session = agente_protocol::SessionId::new();
    let policy = json!({"max_iterations": 1, "max_tool_calls": 2, "max_time_ms": 1000});
    let start = json!({"session_id":session, "home":policy, "provider":"missing-fixture", "model":"fixture", "system_prompt":"Home document assistant", "prompt":{"role":"user","content":"Build a document"}});
    let (missing, _) = client.request("turn.start", start.clone()).await;
    assert!(missing.get("error").is_some());
    let (registered, _) = client
        .request(
            "client_tools.register",
            json!({"session_id":session,"tools":[]}),
        )
        .await;
    assert_eq!(registered["result"]["ok"], true);
    let (started, notes) = client.request("turn.start", start).await;
    assert!(started.get("result").is_some());
    client
        .until(notes, |message| message["method"] == "turn.outcome")
        .await;
    let (state, _) = client
        .request("session.get", json!({"session_id":session}))
        .await;
    let snapshot = &state["result"]["snapshot"]["conversation"];
    assert!(snapshot.to_string().contains("Home document assistant"));
    assert!(!snapshot.to_string().contains("PROJECT SECRET"));
    let mut other = Client::connect(&service);
    let (foreign, _) = other.request("turn.start", json!({"session_id":session,"home":policy,"prompt":{"role":"user","content":"Follow up"}})).await;
    assert!(foreign.get("error").is_some());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn providers_connect_to_the_shared_key_store_and_disconnect() {
    let (runtime, dir) = runtime("providers");
    // The stores the TUI shares; never the developer's own.
    let previous_config_dir = std::env::var_os("AGENTE_CONFIG_DIR");
    std::env::set_var("AGENTE_CONFIG_DIR", dir.join("config"));
    let mut client = Client::connect(&runtime);

    let (unknown, _) = client
        .request(
            "providers.connect",
            json!({ "id": "no-such", "api_key": "k" }),
        )
        .await;
    assert_eq!(unknown["error"]["code"], -32602);

    let (connected, _) = client
        .request(
            "providers.connect",
            json!({ "id": "deepseek", "api_key": " sk-test ", "base_url": "https://example.test/v1" }),
        )
        .await;
    let deepseek = |status: &Value| {
        status["result"]["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "deepseek")
            .cloned()
            .unwrap()
    };
    let entry = deepseek(&connected);
    assert_eq!(entry["connected"], true);
    assert_eq!(entry["stored_key"], true);
    assert_eq!(entry["base_url"], "https://example.test/v1");
    assert!(
        !connected.to_string().contains("sk-test"),
        "status never carries keys"
    );
    let auth = std::fs::read_to_string(dir.join("config/auth.json")).unwrap();
    assert!(auth.contains("sk-test") && !auth.contains(" sk-test"));
    let saved = std::fs::read_to_string(dir.join("config/config.json")).unwrap();
    assert!(saved.contains("https://example.test/v1") && !saved.contains("sk-test"));

    let (defaulted, _) = client
        .request(
            "providers.set_default",
            json!({ "provider": "deepseek", "model": "deepseek-chat" }),
        )
        .await;
    assert_eq!(defaulted["result"]["default_provider"], "deepseek");
    assert_eq!(defaulted["result"]["default_model"], "deepseek-chat");

    let (gone, _) = client
        .request("providers.disconnect", json!({ "id": "deepseek" }))
        .await;
    assert_eq!(deepseek(&gone)["stored_key"], false);
    match previous_config_dir {
        Some(path) => std::env::set_var("AGENTE_CONFIG_DIR", path),
        None => std::env::remove_var("AGENTE_CONFIG_DIR"),
    }
    let _ = std::fs::remove_dir_all(dir);
}
