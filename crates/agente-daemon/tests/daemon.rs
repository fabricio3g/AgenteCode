//! Two clients on one runtime, over in-memory pipes: what Desktop and an
//! attached terminal do over the real socket.

use std::time::Duration;

use agente_core::config::AppConfig;
use agente_daemon::{serve_connection, Service};
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
    let config = RuntimeConfig::from_app_config(&AppConfig::default(), dir.to_string_lossy());
    let runtime = RuntimeSupervisor::start(config);
    let service = Service { runtime };
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
async fn home_complement_calls_wait_for_approval_and_use_the_connected_server() {
    const SERVER: &str = r#"
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self): self.send_error(405)
    def do_DELETE(self): self.send_response(200); self.end_headers()
    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.endswith("/chat/completions"):
            if any(m["role"] == "tool" for m in msg["messages"]):
                delta = {"content": "Saved by the complement."}
                finish = "stop"
            else:
                tool = next(t["function"]["name"] for t in msg["tools"] if t["function"]["name"].startswith("complement_"))
                delta = {"tool_calls": [{"index": 0, "id": "call_save", "type": "function", "function": {"name": tool, "arguments": "{}"}}]}
                finish = "tool_calls"
            frames = [{"choices": [{"index": 0, "delta": delta}]},
                      {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}]
            body = "".join("data: " + json.dumps(frame) + "\n\n" for frame in frames) + "data: [DONE]\n\n"
            return self.reply(200, body, "text/event-stream")
        if self.headers.get("Authorization") != "Bearer test-token":
            return self.send_error(401)
        method = msg.get("method")
        if "id" not in msg:
            return self.reply(202, "")
        if method == "initialize":
            result = {"protocolVersion": msg["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "fixture", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "save", "inputSchema": {"type": "object"}}]}
        else:
            result = {"content": [{"type": "text", "text": "fixture saved"}]}
        self.reply(200, json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}))
    def reply(self, status, body, content_type="application/json"):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
"#;
    let Some(mut server) = ["python", "python3"].into_iter().find_map(|program| {
        tokio::process::Command::new(program)
            .args(["-u", "-c", SERVER])
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .ok()
    }) else {
        eprintln!("Python unavailable; skipping MCP fixture");
        return;
    };
    let mut stdout = BufReader::new(server.stdout.take().unwrap()).lines();
    let port = stdout.next_line().await.unwrap().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let (service, dir) = runtime("home-complement");
    service.runtime.configure(json!({"provider":{"complement-fixture":{"api_format":"openai","options":{"base_url":format!("{base}/v1"),"api_key":"test"},"models":{"fixture":{"name":"Fixture"}}}}})).unwrap();
    let mut desktop = Client::connect(&service);
    let id = "0123456789ab";
    let (sync, _) = desktop.request("complements.sync", json!({
        "servers": {(id): {"name":"Fixture Service","mcp":{"url":format!("{base}/mcp"),"headers":{"Authorization":"Bearer test-token"}}}}
    })).await;
    assert!(sync["result"][id]["status"].is_string(), "{sync}");
    let mut other = Client::connect(&service);
    let (status, _) = other.request("complements.status", Value::Null).await;
    assert_eq!(status["result"], json!({}));

    let session = agente_protocol::SessionId::new();
    desktop
        .request(
            "client_tools.register",
            json!({"session_id":session,"tools":[]}),
        )
        .await;
    let (started, notes) = desktop.request("turn.start", json!({
        "session_id":session,"provider":"complement-fixture","model":"fixture","mode":"auto",
        "home":{"max_iterations":3,"max_tool_calls":1,"max_time_ms":9000,"complements":true},
        "prompt":{"role":"user","content":"Save using the fixture service."}
    })).await;
    assert!(started["result"]["turn_id"].is_string(), "{started}");
    let notes = desktop
        .until(notes, |message| {
            event_type(message) == Some("approval_requested") || message["method"] == "turn.outcome"
        })
        .await;
    let approval = &notes.last().unwrap()["params"]["event"];
    assert_eq!(
        approval["tool_name"], "complement_0123456789ab_save",
        "{notes:?}"
    );
    assert!(!notes
        .iter()
        .any(|message| event_type(message) == Some("tool_result")));
    let (response, notes) = desktop
        .request(
            "approval.respond",
            json!({"request_id":approval["request_id"],"decision":"approve_once"}),
        )
        .await;
    assert_eq!(response["result"]["ok"], true);
    let notes = desktop
        .until(notes, |message| message["method"] == "turn.outcome")
        .await;
    assert!(
        notes
            .iter()
            .any(|message| message["params"]["event"]["content"] == "fixture saved"),
        "{notes:?}"
    );
    let (removed, _) = desktop
        .request("complements.sync", json!({"servers":{}}))
        .await;
    assert_eq!(removed["result"], json!({}));
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

    // Desktop's Settings → Search reach the core's web_search the same way.
    let (synced, _) = client
        .request(
            "web.sync",
            json!({ "provider": "aggregator", "keys": { "tavily": " tv-key " }, "max_results": 5 }),
        )
        .await;
    assert_eq!(synced["result"]["provider"], "tavily", "{synced}");
    let web = std::fs::read_to_string(dir.join("config/web.json")).unwrap();
    assert!(
        web.contains("\"tavily\"") && web.contains("\"max_results\": 5"),
        "{web}"
    );
    assert!(!web.contains("tv-key"), "keys never go in web.json");
    let auth = std::fs::read_to_string(dir.join("config/auth.json")).unwrap();
    assert!(
        auth.contains("web:tavily") && auth.contains("\"tv-key\""),
        "{auth}"
    );
    let (cleared, _) = client
        .request("web.sync", json!({ "provider": "auto", "keys": {} }))
        .await;
    assert_eq!(cleared["result"]["provider"], "duckduckgo", "{cleared}");
    let auth = std::fs::read_to_string(dir.join("config/auth.json")).unwrap();
    assert!(
        !auth.contains("tv-key"),
        "a key Desktop dropped leaves the core"
    );

    match previous_config_dir {
        Some(path) => std::env::set_var("AGENTE_CONFIG_DIR", path),
        None => std::env::remove_var("AGENTE_CONFIG_DIR"),
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn manual_compaction_returns_token_receipt_without_an_event_subscription() {
    use agente_protocol::{Message, SessionId, StartTurn};
    let (service, dir) = runtime("manual-compaction");
    let session_id = SessionId::new();
    let mut turn = service
        .runtime
        .start_turn(StartTurn {
            session_id,
            provider: Some("missing-provider-fixture".into()),
            conversation: (0..10)
                .map(|index| {
                    Message::user(format!("Old turn {index}: {}", "evidence ".repeat(1000)))
                })
                .chain(std::iter::once(Message::user("Keep the latest question")))
                .collect(),
            ..StartTurn::default()
        })
        .unwrap();
    turn.outcome().await.unwrap();
    let mut client = Client::connect(&service);
    let (response, _) = client
        .request(
            "session.compact",
            json!({"session_id": session_id, "smart": false}),
        )
        .await;
    assert!(response.get("error").is_none(), "{response}");
    let receipt = &response["result"]["compaction"];
    assert!(receipt["tokens_before"].as_u64().unwrap() > receipt["tokens_after"].as_u64().unwrap());
    assert_eq!(receipt["model_tokens"], 0);
    assert_eq!(receipt["smart"], false);
    assert_eq!(receipt["estimated"], true);
    assert!(response["result"]["conversation"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["content"] == "Keep the latest question"));
    // Calling again still yields a receipt, even when nothing remains to trim.
    let (response, _) = client
        .request(
            "session.compact",
            json!({"session_id": session_id, "smart": false}),
        )
        .await;
    assert!(response["result"]["compaction"].is_object());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn manual_compaction_defaults_to_llm_and_uses_the_configured_cached_model() {
    use agente_protocol::{Message, SessionId, StartTurn};
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        let (end, length) = loop {
            let n = socket.read(&mut buffer).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let length = String::from_utf8_lossy(&bytes[..end])
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                break (end + 4, length);
            }
        };
        while bytes.len() < end + length {
            let n = socket.read(&mut buffer).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
        }
        let request: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
        let payload = concat!("data: {\"choices\":[{\"delta\":{\"content\":\"Checkpoint: preserve the evidence and finish the latest question.\"}}]}\n\n", "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":20,\"total_tokens\":1020,\"prompt_tokens_details\":{\"cached_tokens\":800}}}\n\n", "data: [DONE]\n\n");
        write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",payload.len()).unwrap();
        tx.send(request).unwrap();
    });
    let (mut service, dir) = runtime("cached-compaction-model");
    service.runtime = RuntimeSupervisor::start(
        RuntimeConfig::from_app_config(&AppConfig::default(), dir.to_string_lossy())
            .with_persistence_dir(dir.join("sessions"))
            .unwrap(),
    );
    service.runtime.configure(json!({"provider":{"checkpoint-fixture":{"api_format":"openai","options":{"base_url":endpoint,"api_key":"test"},"transport":{"cache":{"prompt_cache_key":true}},"models":{"checkpoint-model":{"name":"Checkpoint"}}}},"compaction_model":{"provider":"checkpoint-fixture","model":"checkpoint-model"}})).unwrap();
    let session_id = SessionId::new();
    let mut turn = service
        .runtime
        .start_turn(StartTurn {
            session_id,
            provider: Some("missing-parent-fixture".into()),
            conversation: (0..10)
                .map(|index| Message::user(format!("Evidence {index}: {}", "detail ".repeat(1000))))
                .collect(),
            ..StartTurn::default()
        })
        .unwrap();
    turn.outcome().await.unwrap();
    let mut client = Client::connect(&service);
    // No smart flag: the public manual action must call the LLM.
    let (response, _) = client
        .request("session.compact", json!({"session_id":session_id}))
        .await;
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(response["result"]["compaction"]["smart"], true);
    assert_eq!(response["result"]["compaction"]["model_tokens"], 1020);
    assert_eq!(response["result"]["compaction"]["cache_read_tokens"], 800);
    let request = rx.await.unwrap();
    assert_eq!(request["model"], "checkpoint-model");
    assert_eq!(request["prompt_cache_key"], session_id.to_string());
    assert!(!request["messages"].as_array().unwrap().is_empty());
    server.join().unwrap();
    service
        .runtime
        .configure(json!({"compaction_model":null}))
        .unwrap();
    assert!(service.runtime.settings()["compaction_model"].is_null());
    let _ = std::fs::remove_dir_all(dir);
}
