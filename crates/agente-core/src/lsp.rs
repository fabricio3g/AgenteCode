use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

/// LSP client for code validation and diagnostics
pub struct LspClient {
    process: Child,
    request_id: u64,
    pending_requests: HashMap<u64, oneshot::Sender<LspResponse>>,
    server_capabilities: Option<ServerCapabilities>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ServerCapabilities {
    #[serde(default)]
    pub text_document_sync: Option<TextDocumentSyncOptions>,
    #[serde(default)]
    pub document_formatting_provider: Option<bool>,
    #[serde(default)]
    pub diagnostic_provider: Option<DiagnosticOptions>,
    #[serde(default)]
    pub completion_provider: Option<CompletionOptions>,
    #[serde(default)]
    pub hover_provider: Option<bool>,
    #[serde(default)]
    pub definition_provider: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TextDocumentSyncOptions {
    #[serde(default)]
    pub open_close: Option<bool>,
    #[serde(default)]
    pub change: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiagnosticOptions {
    #[serde(default)]
    pub identifier: Option<String>,
    #[serde(default)]
    pub inter_file_dependencies: bool,
    #[serde(default)]
    pub workspace_diagnostics: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompletionOptions {
    #[serde(default)]
    pub resolve_provider: Option<bool>,
    #[serde(default)]
    pub trigger_characters: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LspMessage {
    pub jsonrpc: String,
    #[serde(flatten)]
    pub payload: LspPayload,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum LspPayload {
    Request {
        id: u64,
        method: String,
        #[serde(default)]
        params: Option<Value>,
    },
    Response {
        id: u64,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<LspError>,
    },
    Notification {
        method: String,
        #[serde(default)]
        params: Option<Value>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LspError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct LspResponse {
    pub result: Option<Value>,
    pub error: Option<LspError>,
}

/// Supported LSP servers
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LspServer {
    RustAnalyzer,
    TypeScript,
    Python,
    Go,
    Json,
    Markdown,
}

impl LspServer {
    pub fn command(&self) -> (&str, Vec<&str>) {
        match self {
            LspServer::RustAnalyzer => ("rust-analyzer", vec![]),
            LspServer::TypeScript => ("typescript-language-server", vec!["--stdio"]),
            LspServer::Python => ("pylsp", vec![]),
            LspServer::Go => ("gopls", vec![]),
            LspServer::Json => ("vscode-json-language-server", vec!["--stdio"]),
            LspServer::Markdown => ("marksman", vec![]),
        }
    }

    pub fn detect_from_path(path: &str) -> Option<Self> {
        let ext = Path::new(path).extension().and_then(|e| e.to_str())?;

        match ext {
            "rs" => Some(LspServer::RustAnalyzer),
            "ts" | "tsx" | "js" | "jsx" => Some(LspServer::TypeScript),
            "py" | "pyw" => Some(LspServer::Python),
            "go" => Some(LspServer::Go),
            "json" => Some(LspServer::Json),
            "md" | "markdown" => Some(LspServer::Markdown),
            _ => None,
        }
    }
}

impl LspClient {
    /// Start a new LSP client
    pub async fn start(server: LspServer, root_path: &str) -> anyhow::Result<Self> {
        let (cmd, args) = server.command();

        let process = Command::new(cmd)
            .args(args)
            .current_dir(root_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;

        let client = Self {
            process,
            request_id: 0,
            pending_requests: HashMap::new(),
            server_capabilities: None,
        };

        Ok(client)
    }

    /// Send initialize request
    pub async fn initialize(&mut self, root_path: &str) -> anyhow::Result<ServerCapabilities> {
        let params = serde_json::json!({
            "processId": std::process::id(),
            "rootPath": root_path,
            "rootUri": format!("file://{}", root_path),
            "capabilities": {
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "willSave": true,
                        "willSaveWaitUntil": false,
                        "didSave": true
                    },
                    "completion": {
                        "dynamicRegistration": false,
                        "completionItem": {
                            "snippetSupport": true,
                            "commitCharactersSupport": true,
                            "documentationFormat": ["markdown", "plaintext"],
                            "deprecatedSupport": true,
                            "preselectSupport": true
                        }
                    },
                    "hover": {
                        "dynamicRegistration": false,
                        "contentFormat": ["markdown", "plaintext"]
                    },
                    "definition": {
                        "dynamicRegistration": false,
                        "linkSupport": true
                    },
                    "documentSymbol": {
                        "dynamicRegistration": false,
                        "hierarchicalDocumentSymbolSupport": true
                    },
                    "formatting": {
                        "dynamicRegistration": false
                    },
                    "diagnostic": {
                        "dynamicRegistration": false,
                        "relatedDocumentSupport": true
                    }
                },
                "workspace": {
                    "applyEdit": true,
                    "workspaceEdit": {
                        "documentChanges": true
                    },
                    "didChangeConfiguration": {
                        "dynamicRegistration": false
                    }
                }
            },
            "workspaceFolders": [
                {
                    "uri": format!("file://{}", root_path),
                    "name": Path::new(root_path).file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("root")
                }
            ]
        });

        let response = self.request("initialize", params).await?;

        let capabilities: ServerCapabilities = response
            .result
            .and_then(|r| serde_json::from_value(r.get("capabilities")?.clone()).ok())
            .unwrap_or_default();

        self.server_capabilities = Some(capabilities.clone());

        // Send initialized notification
        self.notify("initialized", serde_json::json!({})).await?;

        Ok(capabilities)
    }

    /// Open a document
    pub async fn text_document_did_open(
        &mut self,
        uri: &str,
        language_id: &str,
        version: u64,
        text: &str,
    ) -> anyhow::Result<()> {
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri,
                "languageId": language_id,
                "version": version,
                "text": text
            }
        });

        self.notify("textDocument/didOpen", params).await
    }

    /// Document changed
    pub async fn text_document_did_change(
        &mut self,
        uri: &str,
        version: u64,
        changes: Vec<TextDocumentContentChangeEvent>,
    ) -> anyhow::Result<()> {
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri,
                "version": version
            },
            "contentChanges": changes
        });

        self.notify("textDocument/didChange", params).await
    }

    /// Request diagnostics for a document
    pub async fn text_document_diagnostic(
        &mut self,
        uri: &str,
    ) -> anyhow::Result<Option<Vec<Diagnostic>>> {
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri
            }
        });

        let response = self.request("textDocument/diagnostic", params).await?;

        Ok(response
            .result
            .and_then(|r| serde_json::from_value(r.get("items")?.clone()).ok()))
    }

    /// Format document
    pub async fn text_document_formatting(
        &mut self,
        uri: &str,
    ) -> anyhow::Result<Option<Vec<TextEdit>>> {
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri
            },
            "options": {
                "tabSize": 4,
                "insertSpaces": false,
                "trimTrailingWhitespace": true,
                "insertFinalNewline": true,
                "trimFinalNewlines": true
            }
        });

        let response = self.request("textDocument/formatting", params).await?;

        Ok(response.result.and_then(|r| serde_json::from_value(r).ok()))
    }

    /// Send a request and wait for response
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<LspResponse> {
        self.request_id += 1;
        let id = self.request_id;

        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let (tx, rx) = oneshot::channel();
        self.pending_requests.insert(id, tx);

        self.send_message(message).await?;

        // Wait for response with timeout
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(anyhow::anyhow!("Response channel closed")),
            Err(_) => {
                self.pending_requests.remove(&id);
                Err(anyhow::anyhow!("Request timeout"))
            }
        }
    }

    /// Send notification (no response expected)
    async fn notify(&mut self, method: &str, params: Value) -> anyhow::Result<()> {
        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        self.send_message(message).await
    }

    /// Send raw JSON-RPC message
    async fn send_message(&mut self, message: Value) -> anyhow::Result<()> {
        let content = message.to_string();
        let header = format!("Content-Length: {}\r\n\r\n", content.len());

        if let Some(stdin) = self.process.stdin.as_mut() {
            stdin.write_all(header.as_bytes()).await?;
            stdin.write_all(content.as_bytes()).await?;
            stdin.flush().await?;
        }

        Ok(())
    }

    /// Shutdown the LSP client
    pub async fn shutdown(mut self) -> anyhow::Result<()> {
        // Send shutdown request
        let _ = self.request("shutdown", serde_json::json!({})).await;

        // Send exit notification
        let _ = self.notify("exit", serde_json::json!({})).await;

        // Kill process
        let _ = self.process.kill().await;

        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TextDocumentContentChangeEvent {
    #[serde(default)]
    pub range: Option<Range>,
    #[serde(default)]
    pub range_length: Option<u64>,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Position {
    pub line: u64,
    pub character: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TextEdit {
    pub range: Range,
    pub new_text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Diagnostic {
    pub range: Range,
    pub severity: Option<u64>,
    pub code: Option<Value>,
    pub source: Option<String>,
    pub message: String,
    #[serde(default)]
    pub related_information: Option<Vec<DiagnosticRelatedInformation>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiagnosticRelatedInformation {
    pub location: Location,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Location {
    pub uri: String,
    pub range: Range,
}

/// LSP manager that handles multiple language servers
pub struct LspManager {
    clients: HashMap<LspServer, LspClient>,
    root_path: String,
}

impl LspManager {
    pub fn new(root_path: String) -> Self {
        Self {
            clients: HashMap::new(),
            root_path,
        }
    }

    /// Get or create client for a language
    pub async fn get_client(&mut self, server: LspServer) -> anyhow::Result<&mut LspClient> {
        if !self.clients.contains_key(&server) {
            let mut client = LspClient::start(server, &self.root_path).await?;
            client.initialize(&self.root_path).await?;
            self.clients.insert(server, client);
        }

        Ok(self.clients.get_mut(&server).unwrap())
    }

    /// Validate code and return diagnostics
    pub async fn validate_code(
        &mut self,
        path: &str,
        content: &str,
    ) -> anyhow::Result<Vec<Diagnostic>> {
        let server = LspServer::detect_from_path(path)
            .ok_or_else(|| anyhow::anyhow!("No LSP server for file type: {path}"))?;

        let client = self.get_client(server).await?;

        let uri = format!("file://{path}");
        let lang_id = match server {
            LspServer::RustAnalyzer => "rust",
            LspServer::TypeScript => "typescript",
            LspServer::Python => "python",
            LspServer::Go => "go",
            LspServer::Json => "json",
            LspServer::Markdown => "markdown",
        };

        // Open document
        client
            .text_document_did_open(&uri, lang_id, 1, content)
            .await?;

        // Get diagnostics
        let diagnostics = client.text_document_diagnostic(&uri).await?;

        Ok(diagnostics.unwrap_or_default())
    }

    /// Shutdown all clients
    pub async fn shutdown(self) {
        for (_, client) in self.clients {
            let _ = client.shutdown().await;
        }
    }
}

/// Syntax checks that are actually parsing, not guessing.
///
/// There used to be a hand-rolled Rust brace counter here. It did not skip
/// comments, raw strings, escapes or lifetimes (`&'a str` opened a "string"
/// that swallowed braces), so it reported "Unbalanced braces: 2 extra opening"
/// on files that compiled — a false diagnostic is worse than no diagnostic,
/// because the model then "fixes" working code. Rust syntax is the compiler's
/// business (`cargo check`), and a configured language server is the only
/// source allowed to call something an error.
pub fn quick_validate_syntax(file_path: &str, content: &str) -> Vec<String> {
    let mut errors = Vec::new();
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    if ext == "json" {
        quick_validate_json(content, &mut errors);
    }

    errors
}

fn quick_validate_json(content: &str, errors: &mut Vec<String>) {
    match serde_json::from_str::<Value>(content) {
        Ok(_) => {}
        Err(e) => {
            errors.push(format!("JSON parse error: {e}"));
        }
    }
}
