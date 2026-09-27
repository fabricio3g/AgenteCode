//! MCP connections over `rmcp`: one independent connection per server.
//!
//! The manager is shared as `Arc<McpManager>` and synchronizes internally,
//! with no lock held across I/O — connecting a slow server never blocks a
//! turn, and tool calls (on any server) run concurrently. Status is kept
//! per server for the `/mcp` dialog.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use rmcp::model::{CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation};
use rmcp::service::{NotificationContext, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{ClientHandler, RoleClient, ServiceExt};
use serde_json::Value;

use super::{full_tool_name, McpConfig, McpTool, ServerSource};

/// Bound on the handshake + `tools/list` for one server.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// stderr lines kept per local server, for failure reports.
const STDERR_TAIL: usize = 20;
/// Characters of tool output handed to the model before the registry's own
/// truncation (binary payloads are summarized, never inlined).
const MAX_INLINE_TEXT: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerStatus {
    /// `enabled: false`.
    Disabled,
    /// From the project's `.mcp.json`, waiting for the user's approval.
    NeedsApproval,
    Connecting,
    Ready,
    Failed(String),
}

/// A server's state for display.
#[derive(Debug, Clone)]
pub struct ServerSnapshot {
    pub name: String,
    pub source: ServerSource,
    /// Command line or URL.
    pub target: String,
    pub remote: bool,
    pub status: ServerStatus,
    pub tools: usize,
    /// Last non-empty stderr line of a local server (why it failed, usually).
    pub last_stderr: Option<String>,
}

/// Receives server notifications; `tools/list_changed` marks the tool list
/// stale so the next turn re-lists it.
#[derive(Clone)]
struct Handler {
    stale: Arc<AtomicBool>,
}

impl ClientHandler for Handler {
    fn get_info(&self) -> ClientConfig {
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("agente", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.stale.store(true, Ordering::SeqCst);
    }
}

struct Connection {
    service: RunningService<RoleClient, Handler>,
    tools: RwLock<Vec<McpTool>>,
    stale: Arc<AtomicBool>,
}

struct Server {
    name: String,
    config: McpConfig,
    source: ServerSource,
    status: RwLock<ServerStatus>,
    connection: RwLock<Option<Arc<Connection>>>,
    stderr: Arc<Mutex<VecDeque<String>>>,
}

impl Server {
    fn snapshot(&self) -> ServerSnapshot {
        let tools = self
            .connection
            .read()
            .as_ref()
            .map_or(0, |c| c.tools.read().len());
        ServerSnapshot {
            name: self.name.clone(),
            source: self.source,
            target: self.config.target(),
            remote: self.config.is_remote(),
            status: self.status.read().clone(),
            tools,
            last_stderr: self.stderr.lock().back().cloned(),
        }
    }

    async fn connect(&self) {
        *self.status.write() = ServerStatus::Connecting;
        self.disconnect();
        let result = tokio::time::timeout(CONNECT_TIMEOUT, self.open()).await;
        let status = match result {
            Ok(Ok(connection)) => {
                *self.connection.write() = Some(Arc::new(connection));
                tracing::info!(server = %self.name, "MCP server connected");
                ServerStatus::Ready
            }
            Ok(Err(e)) => {
                tracing::warn!(server = %self.name, error = %e, "MCP server failed to connect");
                ServerStatus::Failed(e.to_string())
            }
            Err(_) => {
                tracing::warn!(server = %self.name, "MCP server connect timed out");
                ServerStatus::Failed(format!("timed out after {}s", CONNECT_TIMEOUT.as_secs()))
            }
        };
        *self.status.write() = status;
    }

    async fn open(&self) -> anyhow::Result<Connection> {
        let stale = Arc::new(AtomicBool::new(false));
        let handler = Handler {
            stale: Arc::clone(&stale),
        };
        let service = if self.config.is_remote() {
            let url = self
                .config
                .url
                .clone()
                .filter(|u| !u.trim().is_empty())
                .ok_or_else(|| anyhow::anyhow!("no url configured"))?;
            let mut transport_config = StreamableHttpClientTransportConfig::with_uri(
                crate::util::expand_env_templates(&url),
            );
            let mut headers = HashMap::new();
            for (key, value) in &self.config.headers {
                let value = crate::util::expand_env_templates(value);
                if key.eq_ignore_ascii_case("authorization") {
                    // The transport sends `Bearer <token>` itself.
                    let token = value
                        .strip_prefix("Bearer ")
                        .or_else(|| value.strip_prefix("bearer "))
                        .unwrap_or(&value);
                    transport_config = transport_config.auth_header(token.to_string());
                    continue;
                }
                match (
                    http::HeaderName::from_bytes(key.as_bytes()),
                    http::HeaderValue::from_str(&value),
                ) {
                    (Ok(name), Ok(value)) => {
                        headers.insert(name, value);
                    }
                    _ => tracing::warn!(server = %self.name, header = %key, "invalid MCP header"),
                }
            }
            if !headers.is_empty() {
                transport_config = transport_config.custom_headers(headers);
            }
            let transport = StreamableHttpClientTransport::from_config(transport_config);
            handler.serve(transport).await?
        } else {
            let argv = self.config.argv();
            let (program, args) = argv
                .split_first()
                .ok_or_else(|| anyhow::anyhow!("no command configured"))?;
            let mut command = tokio::process::Command::new(program);
            command.args(args);
            for (key, value) in &self.config.env {
                command.env(key, crate::util::expand_env_templates(value));
            }
            command.kill_on_drop(true);
            let (transport, stderr) = TokioChildProcess::builder(command)
                .stderr(std::process::Stdio::piped())
                .spawn()?;
            if let Some(stderr) = stderr {
                self.stderr.lock().clear();
                spawn_stderr_reader(self.name.clone(), stderr, Arc::clone(&self.stderr));
            }
            handler.serve(transport).await?
        };
        let tools = list_tools(&self.name, &self.config, &service).await?;
        Ok(Connection {
            service,
            tools: RwLock::new(tools),
            stale,
        })
    }

    fn disconnect(&self) {
        if let Some(connection) = self.connection.write().take() {
            connection.service.cancellation_token().cancel();
        }
    }

    /// Re-list tools after the server announced a change.
    async fn refresh_if_stale(&self) {
        let Some(connection) = self.connection.read().clone() else {
            return;
        };
        if !connection.stale.swap(false, Ordering::SeqCst) {
            return;
        }
        match list_tools(&self.name, &self.config, &connection.service).await {
            Ok(tools) => *connection.tools.write() = tools,
            Err(e) => tracing::warn!(server = %self.name, error = %e, "MCP tool re-list failed"),
        }
    }
}

fn spawn_stderr_reader(
    server: String,
    stderr: tokio::process::ChildStderr,
    tail: Arc<Mutex<VecDeque<String>>>,
) {
    use tokio::io::AsyncBufReadExt;
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            tracing::debug!(target: "mcp::stderr", server = %server, "{line}");
            let mut tail = tail.lock();
            if tail.len() == STDERR_TAIL {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });
}

async fn list_tools(
    server: &str,
    config: &McpConfig,
    service: &RunningService<RoleClient, Handler>,
) -> anyhow::Result<Vec<McpTool>> {
    let tools = service.list_all_tools().await?;
    let mut out: Vec<McpTool> = tools
        .into_iter()
        .filter_map(|tool| serde_json::to_value(&tool).ok())
        .filter_map(|tool| mcp_tool_from_json(server, config, &tool))
        .collect();
    out.sort_by(|a, b| a.full_name.cmp(&b.full_name));
    Ok(out)
}

/// Build an [`McpTool`] from a `tools/list` entry (wire JSON, so the mapping
/// stays independent of SDK struct churn).
fn mcp_tool_from_json(server: &str, config: &McpConfig, tool: &Value) -> Option<McpTool> {
    let name = tool.get("name")?.as_str()?.to_string();
    let annotations = tool.get("annotations");
    let hint = |key: &str| {
        annotations
            .and_then(|a| a.get(key))
            .and_then(Value::as_bool)
    };
    let title = tool.get("title").and_then(Value::as_str).or_else(|| {
        annotations
            .and_then(|a| a.get("title"))
            .and_then(Value::as_str)
    });
    let mut description = tool
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if description.is_empty() {
        description = title.unwrap_or(&name).to_string();
    }
    let mut input_schema = tool
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({"type": "object"}));
    // Some providers reject an object schema without `properties`.
    if let Some(object) = input_schema.as_object_mut() {
        if object.get("type").and_then(Value::as_str) == Some("object") {
            object
                .entry("properties")
                .or_insert_with(|| serde_json::json!({}));
        }
    }
    Some(McpTool {
        full_name: full_tool_name(server, &name),
        name,
        server_name: server.to_string(),
        description,
        input_schema,
        plan_mode: config.plan_mode,
        read_only: hint("readOnlyHint").unwrap_or(false),
        trusted: config.trust,
    })
}

/// A finished `tools/call`, flattened for the model.
#[derive(Debug, Clone, PartialEq)]
pub struct CallOutput {
    pub text: String,
    /// The server flagged the result as an error (`isError`).
    pub is_error: bool,
}

/// Flatten a `tools/call` result: text blocks verbatim, embedded text
/// resources inline, binary content summarized, `structuredContent` as JSON
/// when there is nothing else.
pub fn render_call_result(result: &Value) -> CallOutput {
    let mut parts: Vec<String> = Vec::new();
    for block in result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        let text = |key: &str| block.get(key).and_then(Value::as_str);
        match kind {
            "text" => parts.push(text("text").unwrap_or_default().to_string()),
            "image" | "audio" => {
                let mime = text("mimeType").unwrap_or("binary");
                let bytes = text("data").map_or(0, |d| d.len() * 3 / 4);
                parts.push(format!("[{kind} content: {mime}, ~{bytes} bytes]"));
            }
            "resource" => {
                let resource = block.get("resource");
                let uri = resource
                    .and_then(|r| r.get("uri"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match resource.and_then(|r| r.get("text")).and_then(Value::as_str) {
                    Some(body) => parts.push(format!("[resource {uri}]\n{body}")),
                    None => parts.push(format!("[binary resource {uri}]")),
                }
            }
            "resource_link" => {
                let uri = text("uri").unwrap_or("");
                let name = text("name").unwrap_or(uri);
                parts.push(format!("[link: {name} <{uri}>]"));
            }
            _ => {}
        }
    }
    let mut text = parts.join("\n");
    if text.trim().is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            text = serde_json::to_string_pretty(structured).unwrap_or_default();
        }
    }
    if text.len() > MAX_INLINE_TEXT {
        let cut = crate::util::truncate_at_char_boundary(&text, MAX_INLINE_TEXT).to_string();
        text = format!("{cut}\n[MCP output truncated at {MAX_INLINE_TEXT} bytes]");
    }
    CallOutput {
        text,
        is_error: result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// Every configured MCP server and its live connection.
#[derive(Default)]
pub struct McpManager {
    servers: Vec<Arc<Server>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Servers from config plus the project's `.mcp.json` (which only run
    /// once approved: `approved` holds [`super::approval_key`]s). A config
    /// server wins over a `.mcp.json` server of the same name.
    pub fn from_sources(
        configured: &HashMap<String, McpConfig>,
        project_dir: &str,
        approved: &[String],
    ) -> Self {
        let mut manager = Self::new();
        for (name, config) in configured {
            manager.add(name, config.clone(), ServerSource::Config);
        }
        for (name, config) in super::load_project_mcp_json(project_dir) {
            if configured.contains_key(&name) {
                continue;
            }
            let approved = approved.contains(&super::approval_key(project_dir, &name));
            let server = manager.add(&name, config, ServerSource::ProjectFile);
            if !approved {
                *server.status.write() = ServerStatus::NeedsApproval;
            }
        }
        manager
    }

    /// Register a server (idle until [`Self::connect_all`]).
    pub fn add_client(&mut self, name: String, config: McpConfig) {
        self.add(&name, config, ServerSource::Config);
    }

    fn add(&mut self, name: &str, config: McpConfig, source: ServerSource) -> Arc<Server> {
        let status = if config.enabled {
            ServerStatus::Connecting
        } else {
            ServerStatus::Disabled
        };
        let server = Arc::new(Server {
            name: name.to_string(),
            config,
            source,
            status: RwLock::new(status),
            connection: RwLock::new(None),
            stderr: Arc::new(Mutex::new(VecDeque::new())),
        });
        self.servers.retain(|s| s.name != name);
        self.servers.push(Arc::clone(&server));
        self.servers.sort_by(|a, b| a.name.cmp(&b.name));
        server
    }

    fn server(&self, name: &str) -> Option<&Arc<Server>> {
        self.servers.iter().find(|s| s.name == name)
    }

    /// Connect every enabled, approved server concurrently.
    pub async fn connect_all(&self) {
        let pending: Vec<_> = self
            .servers
            .iter()
            .filter(|s| {
                !matches!(
                    *s.status.read(),
                    ServerStatus::Disabled | ServerStatus::NeedsApproval
                )
            })
            .map(|s| s.connect())
            .collect();
        futures::future::join_all(pending).await;
    }

    /// Connect (or reconnect) one server.
    pub async fn reconnect(&self, name: &str) {
        if let Some(server) = self.server(name) {
            server.connect().await;
        }
    }

    /// Stop a server and mark it disabled (for this session).
    pub fn disable(&self, name: &str) {
        if let Some(server) = self.server(name) {
            server.disconnect();
            *server.status.write() = ServerStatus::Disabled;
        }
    }

    pub fn disconnect_all(&self) {
        for server in &self.servers {
            server.disconnect();
        }
    }

    /// Re-list tools on servers that announced a change since last time.
    pub async fn refresh_stale_tools(&self) {
        futures::future::join_all(self.servers.iter().map(|s| s.refresh_if_stale())).await;
    }

    /// Tools of every ready server, sorted (the request prefix stays stable).
    pub fn tools(&self) -> Vec<McpTool> {
        let mut tools: Vec<McpTool> = self
            .servers
            .iter()
            .filter_map(|s| s.connection.read().clone())
            .flat_map(|c| c.tools.read().clone())
            .collect();
        tools.sort_by(|a, b| a.full_name.cmp(&b.full_name));
        tools
    }

    /// Kept for callers of the pre-rmcp API.
    pub fn get_all_tools(&self) -> Vec<McpTool> {
        self.tools()
    }

    /// Names of the connected servers.
    pub fn get_connected_clients(&self) -> Vec<String> {
        self.servers
            .iter()
            .filter(|s| *s.status.read() == ServerStatus::Ready)
            .map(|s| s.name.clone())
            .collect()
    }

    pub fn snapshots(&self) -> Vec<ServerSnapshot> {
        self.servers.iter().map(|s| s.snapshot()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }

    /// Call `full_name` (as the model sees it). No manager lock is held
    /// during the call.
    pub async fn call_tool(&self, full_name: &str, args: Value) -> anyhow::Result<CallOutput> {
        let found = self.servers.iter().find_map(|server| {
            let connection = server.connection.read().clone()?;
            let tool = connection
                .tools
                .read()
                .iter()
                .find(|t| t.full_name == full_name)
                .map(|t| t.name.clone())?;
            Some((server, connection, tool))
        });
        let Some((server, connection, tool)) = found else {
            anyhow::bail!("MCP tool not found or its server is not connected: {full_name}");
        };
        let arguments = match args {
            Value::Object(map) => Some(map),
            Value::Null => None,
            other => anyhow::bail!("MCP tool arguments must be an object, got {other}"),
        };
        let mut params = CallToolRequestParams::new(tool);
        if let Some(arguments) = arguments {
            params = params.with_arguments(arguments);
        }
        let timeout = server.config.call_timeout();
        let result = tokio::time::timeout(timeout, connection.service.call_tool(params))
            .await
            .map_err(|_| anyhow::anyhow!("timed out after {}s", timeout.as_secs()))?;
        let result = match result {
            Ok(result) => result,
            Err(e) => {
                if connection.service.is_transport_closed() {
                    *server.status.write() = ServerStatus::Failed("connection closed".into());
                }
                return Err(e.into());
            }
        };
        Ok(render_call_result(&serde_json::to_value(&result)?))
    }
}

impl Drop for McpManager {
    fn drop(&mut self) {
        self.disconnect_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_annotations_drive_the_permission_hints() {
        let config = McpConfig {
            trust: false,
            ..McpConfig::default()
        };
        let tool = mcp_tool_from_json(
            "docs",
            &config,
            &serde_json::json!({
                "name": "search",
                "inputSchema": {"type": "object"},
                "annotations": {"readOnlyHint": true, "title": "Search docs"}
            }),
        )
        .unwrap();
        assert_eq!(tool.full_name, "docs_search");
        assert!(tool.read_only && !tool.trusted);
        assert_eq!(
            tool.description, "Search docs",
            "title stands in for a missing description"
        );
        assert_eq!(tool.input_schema["properties"], serde_json::json!({}));

        let write =
            mcp_tool_from_json("docs", &config, &serde_json::json!({"name": "delete"})).unwrap();
        assert!(!write.read_only, "no hint = may modify");
    }

    #[test]
    fn call_results_flatten_for_the_model() {
        let out = render_call_result(&serde_json::json!({
            "content": [
                {"type": "text", "text": "hello"},
                {"type": "image", "mimeType": "image/png", "data": "AAAA"},
                {"type": "resource", "resource": {"uri": "file:///a", "text": "body"}},
                {"type": "resource_link", "uri": "file:///b", "name": "b"}
            ],
            "isError": true
        }));
        assert!(out.is_error);
        assert_eq!(
            out.text,
            "hello\n[image content: image/png, ~3 bytes]\n[resource file:///a]\nbody\n[link: b <file:///b>]"
        );

        let structured = render_call_result(&serde_json::json!({
            "content": [], "structuredContent": {"n": 1}
        }));
        assert_eq!(structured.text, "{\n  \"n\": 1\n}");
        assert!(!structured.is_error);
    }

    /// A minimal stdio MCP server: interleaves a log notification and
    /// stderr noise with its responses, like real servers do.
    const MOCK_SERVER: &str = r#"
import json, sys
def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    method, mid = msg.get("method"), msg.get("id")
    if method == "initialize":
        sys.stderr.write("mock server starting\n"); sys.stderr.flush()
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": msg["params"]["protocolVersion"],
            "capabilities": {"tools": {"listChanged": True}},
            "serverInfo": {"name": "mock", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": "echo", "description": "Echo text",
             "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
             "annotations": {"readOnlyHint": True}},
            {"name": "boom", "inputSchema": {"type": "object"}}]}})
    elif method == "tools/call":
        send({"jsonrpc": "2.0", "method": "notifications/message",
              "params": {"level": "info", "data": "working"}})
        name, args = msg["params"]["name"], msg["params"].get("arguments", {})
        if name == "echo":
            result = {"content": [{"type": "text", "text": "echo: " + args.get("text", "")}]}
        else:
            result = {"content": [{"type": "text", "text": "it broke"}], "isError": True}
        send({"jsonrpc": "2.0", "id": mid, "result": result})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
"#;

    #[tokio::test]
    async fn stdio_server_end_to_end() {
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("python3 unavailable; skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("server.py");
        std::fs::write(&script, MOCK_SERVER).unwrap();
        let mut manager = McpManager::new();
        manager.add_client(
            "mock".into(),
            McpConfig {
                command: vec!["python3".into(), script.to_string_lossy().into_owned()],
                ..McpConfig::default()
            },
        );
        manager.connect_all().await;
        let snapshot = &manager.snapshots()[0];
        assert_eq!(snapshot.status, ServerStatus::Ready, "{snapshot:?}");
        assert_eq!(snapshot.tools, 2);
        assert_eq!(
            snapshot.last_stderr.as_deref(),
            Some("mock server starting")
        );

        let tools = manager.tools();
        let names: Vec<&str> = tools.iter().map(|t| t.full_name.as_str()).collect();
        assert_eq!(names, ["mock_boom", "mock_echo"]);
        assert!(tools[1].read_only && !tools[0].read_only);

        // Concurrent calls on one connection, with notifications interleaved.
        let (a, b) = tokio::join!(
            manager.call_tool("mock_echo", serde_json::json!({"text": "one"})),
            manager.call_tool("mock_echo", serde_json::json!({"text": "two"})),
        );
        assert_eq!(a.unwrap().text, "echo: one");
        assert_eq!(b.unwrap().text, "echo: two");
        let failed = manager
            .call_tool("mock_boom", serde_json::json!({}))
            .await
            .unwrap();
        assert!(failed.is_error);
        assert_eq!(failed.text, "it broke");

        manager.disable("mock");
        assert!(manager.tools().is_empty());
        assert!(manager
            .call_tool("mock_echo", serde_json::json!({}))
            .await
            .is_err());
    }

    /// A minimal Streamable HTTP server: JSON responses, a session id, and
    /// it refuses any call that lacks the session or the bearer token.
    const MOCK_HTTP_SERVER: &str = r#"
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body=None, headers=()):
        self.send_response(code)
        for k, v in headers: self.send_header(k, v)
        data = json.dumps(body).encode() if body is not None else b""
        if body is not None: self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)
    def do_GET(self): self.reply(405)
    def do_DELETE(self): self.reply(200)
    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != "Bearer sekret":
            return self.reply(401)
        method, mid = msg.get("method"), msg.get("id")
        if method != "initialize" and self.headers.get("Mcp-Session-Id") != "s-1":
            return self.reply(400)
        if mid is None:
            return self.reply(202)
        if method == "initialize":
            result = {"protocolVersion": msg["params"]["protocolVersion"],
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "web", "version": "1"}}
            return self.reply(200, {"jsonrpc": "2.0", "id": mid, "result": result},
                              [("Mcp-Session-Id", "s-1")])
        if method == "tools/list":
            result = {"tools": [{"name": "ping", "inputSchema": {"type": "object"},
                                 "annotations": {"readOnlyHint": True}}]}
        elif method == "tools/call":
            result = {"content": [{"type": "text", "text": "pong " + self.headers.get("X-Team", "")}]}
        else:
            result = {}
        self.reply(200, {"jsonrpc": "2.0", "id": mid, "result": result})
server = HTTPServer(("127.0.0.1", 0), H)
print(server.server_port, flush=True)
server.serve_forever()
"#;

    #[tokio::test]
    async fn streamable_http_server_end_to_end() {
        use std::io::BufRead;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("server.py");
        std::fs::write(&script, MOCK_HTTP_SERVER).unwrap();
        let Ok(mut child) = std::process::Command::new("python3")
            .arg(&script)
            .stdout(std::process::Stdio::piped())
            .spawn()
        else {
            eprintln!("python3 unavailable; skipping");
            return;
        };
        let mut port = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();

        let mut manager = McpManager::new();
        manager.add_client(
            "web".into(),
            McpConfig {
                transport_type: "http".into(),
                url: Some(format!("http://127.0.0.1:{}/mcp", port.trim())),
                headers: HashMap::from([
                    ("Authorization".to_string(), "Bearer sekret".to_string()),
                    ("X-Team".to_string(), "core".to_string()),
                ]),
                ..McpConfig::default()
            },
        );
        manager.connect_all().await;
        let status = manager.snapshots()[0].status.clone();
        let result = manager.call_tool("web_ping", serde_json::json!({})).await;
        manager.disconnect_all();
        let _ = child.kill();

        assert_eq!(status, ServerStatus::Ready);
        assert_eq!(
            result.unwrap().text,
            "pong core",
            "session + headers reached the server"
        );
    }

    #[test]
    fn project_mcp_json_servers_wait_for_approval() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().into_owned();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers": {"repo": {"command": "true"}, "mine": {"command": "true"}}}"#,
        )
        .unwrap();
        let mut configured = HashMap::new();
        configured.insert(
            "mine".to_string(),
            McpConfig {
                command: vec!["echo".into()],
                enabled: false,
                ..McpConfig::default()
            },
        );
        let manager = McpManager::from_sources(&configured, &project, &[]);
        let snapshots = manager.snapshots();
        let status = |name: &str| {
            snapshots
                .iter()
                .find(|s| s.name == name)
                .map(|s| (s.status.clone(), s.source))
                .unwrap()
        };
        assert_eq!(
            status("repo"),
            (ServerStatus::NeedsApproval, ServerSource::ProjectFile)
        );
        assert_eq!(
            status("mine"),
            (ServerStatus::Disabled, ServerSource::Config),
            "config wins over .mcp.json"
        );

        let approved = [super::super::approval_key(&project, "repo")];
        let manager = McpManager::from_sources(&HashMap::new(), &project, &approved);
        assert_eq!(manager.snapshots()[1].status, ServerStatus::Connecting);
    }
}
