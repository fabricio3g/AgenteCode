use std::collections::HashMap;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

#[derive(Debug, Clone)]
pub enum McpTransportConfig {
    Local {
        command: Vec<String>,
        env: HashMap<String, String>,
    },
    Remote {
        url: String,
        headers: HashMap<String, String>,
    },
}

pub struct McpTransport {
    config: McpTransportConfig,
    process: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<BufReader<ChildStdout>>,
    /// Remote HTTP session (JSON-RPC over POST).
    remote_url: Option<String>,
    remote_headers: HashMap<String, String>,
    remote_client: Option<reqwest::Client>,
    request_id: u64,
}

impl std::fmt::Debug for McpTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpTransport")
            .field("config", &self.config)
            .field(
                "connected",
                &(self.process.is_some() || self.remote_client.is_some()),
            )
            .finish()
    }
}

impl McpTransport {
    pub fn new(config: McpTransportConfig) -> Self {
        Self {
            config,
            process: None,
            stdin: None,
            stdout: None,
            remote_url: None,
            remote_headers: HashMap::new(),
            remote_client: None,
            request_id: 0,
        }
    }

    pub async fn connect(&mut self) -> anyhow::Result<()> {
        match &self.config {
            McpTransportConfig::Local { command, env } => {
                if command.is_empty() {
                    anyhow::bail!("No command specified for local MCP transport");
                }

                let cmd = &command[0];
                let args = &command[1..];

                let mut child = Command::new(cmd)
                    .args(args)
                    .envs(env.clone())
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()?;

                let stdin = child
                    .stdin
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("No stdin"))?;
                let stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("No stdout"))?;
                let stderr = child
                    .stderr
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("No stderr"))?;

                // Spawn stderr reader so server logs don't block
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stderr);
                    let mut line = String::new();
                    loop {
                        match reader.read_line(&mut line).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                let trimmed = line.trim_end();
                                if !trimmed.is_empty() {
                                    tracing::debug!(target: "mcp::stderr", "{}", trimmed);
                                }
                                line.clear();
                            }
                        }
                    }
                });

                self.process = Some(child);
                self.stdin = Some(stdin);
                self.stdout = Some(BufReader::new(stdout));

                tracing::info!("Local MCP transport started: {}", cmd);

                // MCP handshake: send initialize request
                self.send_initialize().await?;
            }
            McpTransportConfig::Remote { url, headers } => {
                let url = url.clone();
                let headers = headers.clone();
                tracing::info!("Connecting remote MCP transport: {}", url);
                let mut builder = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(60))
                    .user_agent(concat!("agente/", env!("CARGO_PKG_VERSION")));
                // Build default headers
                let mut header_map = reqwest::header::HeaderMap::new();
                header_map.insert(
                    reqwest::header::CONTENT_TYPE,
                    reqwest::header::HeaderValue::from_static("application/json"),
                );
                header_map.insert(
                    reqwest::header::ACCEPT,
                    reqwest::header::HeaderValue::from_static(
                        "application/json, text/event-stream",
                    ),
                );
                for (k, v) in &headers {
                    if let (Ok(name), Ok(value)) = (
                        reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                        reqwest::header::HeaderValue::from_str(v),
                    ) {
                        header_map.insert(name, value);
                    }
                }
                builder = builder.default_headers(header_map);
                let client = builder
                    .build()
                    .map_err(|e| anyhow::anyhow!("Failed to build HTTP client: {e}"))?;
                self.remote_url = Some(url);
                self.remote_headers = headers;
                self.remote_client = Some(client);
                self.send_initialize().await?;
            }
        }
        Ok(())
    }

    pub async fn disconnect(&mut self) -> anyhow::Result<()> {
        if let Some(mut process) = self.process.take() {
            let _ = process.kill().await;
        }
        self.stdin = None;
        self.stdout = None;
        self.remote_client = None;
        self.remote_url = None;
        self.remote_headers.clear();
        Ok(())
    }

    pub async fn list_tools(&mut self) -> anyhow::Result<Vec<ToolInfo>> {
        let response = self
            .send_request("tools/list", serde_json::json!({}))
            .await?;

        let tools: Vec<ToolInfo> = response
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        Some(ToolInfo {
                            name: t.get("name")?.as_str()?.to_string(),
                            description: t
                                .get("description")
                                .and_then(|d| d.as_str())
                                .map(|s| s.to_string()),
                            input_schema: t
                                .get("inputSchema")
                                .cloned()
                                .unwrap_or(serde_json::json!({})),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(tools)
    }

    pub async fn call_tool(&mut self, name: &str, args: Value) -> anyhow::Result<String> {
        let params = serde_json::json!({
            "name": name,
            "arguments": args
        });

        let response = self.send_request("tools/call", params).await?;

        let content = response
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();

        Ok(content)
    }

    async fn send_initialize(&mut self) -> anyhow::Result<()> {
        let params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "agente",
                "version": env!("CARGO_PKG_VERSION")
            }
        });

        let result = self.send_request("initialize", params).await?;
        tracing::debug!("MCP initialize response: {:?}", result);

        // Send initialized notification (stdio or remote)
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        if let Some(stdin) = &mut self.stdin {
            let line = serde_json::to_string(&notification)? + "\n";
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
        } else if let (Some(client), Some(url)) = (&self.remote_client, &self.remote_url) {
            let _ = client.post(url).json(&notification).send().await;
        }

        Ok(())
    }

    async fn send_request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.request_id += 1;
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": method,
            "params": params
        });

        // Local stdio transport
        if let (Some(stdin), Some(stdout)) = (&mut self.stdin, &mut self.stdout) {
            let request_str = serde_json::to_string(&request)? + "\n";
            stdin.write_all(request_str.as_bytes()).await?;
            stdin.flush().await?;

            let mut response_line = String::new();
            stdout.read_line(&mut response_line).await?;

            let response: Value = serde_json::from_str(&response_line)?;
            if let Some(error) = response.get("error") {
                anyhow::bail!("MCP error: {error:?}");
            }
            return Ok(response
                .get("result")
                .cloned()
                .unwrap_or(serde_json::json!({})));
        }

        // Remote HTTP JSON-RPC (streamable HTTP / simple POST)
        if let (Some(client), Some(url)) = (&self.remote_client, &self.remote_url) {
            let response = client
                .post(url)
                .json(&request)
                .send()
                .await
                .map_err(|e| anyhow::anyhow!("Remote MCP request failed: {e}"))?;
            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|e| anyhow::anyhow!("Remote MCP body error: {e}"))?;
            if !status.is_success() {
                anyhow::bail!(
                    "Remote MCP HTTP {}: {}",
                    status,
                    body.chars().take(200).collect::<String>()
                );
            }

            // Support plain JSON or SSE-ish "data: {...}" lines
            let json_text = if body.trim_start().starts_with('{') {
                body
            } else {
                body.lines()
                    .find_map(|line| {
                        let line = line.trim();
                        line.strip_prefix("data:")
                            .map(|s| s.trim().to_string())
                            .filter(|s| s.starts_with('{'))
                    })
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "Remote MCP returned non-JSON body: {}",
                            body.chars().take(120).collect::<String>()
                        )
                    })?
            };

            let response: Value = serde_json::from_str(&json_text)
                .map_err(|e| anyhow::anyhow!("Remote MCP JSON parse error: {e}"))?;
            if let Some(error) = response.get("error") {
                anyhow::bail!("MCP error: {error:?}");
            }
            return Ok(response
                .get("result")
                .cloned()
                .unwrap_or(serde_json::json!({})));
        }

        anyhow::bail!("Transport not connected")
    }
}

#[derive(Debug, Clone)]
pub struct ToolInfo {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}
