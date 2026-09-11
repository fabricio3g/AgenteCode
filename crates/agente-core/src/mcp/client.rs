use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;
use serde_json::Value;

use super::{McpConfig, McpTool, McpTransport, McpTransportConfig};

#[derive(Debug)]
pub struct McpClient {
    name: String,
    config: McpConfig,
    tools: Arc<RwLock<Vec<McpTool>>>,
    transport: Option<McpTransport>,
}

impl McpClient {
    pub fn new(name: String, config: McpConfig) -> Self {
        Self {
            name,
            config,
            tools: Arc::new(RwLock::new(Vec::new())),
            transport: None,
        }
    }

    pub async fn connect(&mut self) -> anyhow::Result<()> {
        let transport_config = if self.config.transport_type == "remote" {
            McpTransportConfig::Remote {
                url: self.config.url.clone().unwrap_or_default(),
                headers: self.config.headers.clone(),
            }
        } else {
            McpTransportConfig::Local {
                command: self.config.command.clone(),
                env: self.config.env.clone(),
            }
        };

        let mut transport = McpTransport::new(transport_config);
        transport.connect().await?;

        let tools = transport.list_tools().await?;
        let mcp_tools: Vec<McpTool> = tools
            .into_iter()
            .map(|t| {
                let full_name = sanitize_name(&self.name) + "_" + &sanitize_name(&t.name);
                McpTool {
                    name: t.name,
                    server_name: self.name.clone(),
                    full_name,
                    description: t.description.unwrap_or_default(),
                    input_schema: t.input_schema,
                    plan_mode: self.config.plan_mode,
                }
            })
            .collect();

        *self.tools.write() = mcp_tools;
        self.transport = Some(transport);

        tracing::info!(
            server = %self.name,
            tool_count = self.tools.read().len(),
            "MCP client connected"
        );

        Ok(())
    }

    pub async fn disconnect(&mut self) -> anyhow::Result<()> {
        if let Some(mut transport) = self.transport.take() {
            transport.disconnect().await?;
        }
        self.tools.write().clear();
        Ok(())
    }

    pub fn get_tools(&self) -> Vec<McpTool> {
        self.tools.read().clone()
    }

    pub async fn call_tool(&mut self, name: &str, args: Value) -> anyhow::Result<String> {
        if let Some(transport) = &mut self.transport {
            transport.call_tool(name, args).await
        } else {
            anyhow::bail!("MCP client not connected")
        }
    }

    pub fn is_connected(&self) -> bool {
        self.transport.is_some()
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

fn sanitize_name(s: &str) -> String {
    s.replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_")
}

pub struct McpManager {
    clients: HashMap<String, McpClient>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    pub fn add_client(&mut self, name: String, config: McpConfig) {
        self.clients
            .insert(name.clone(), McpClient::new(name, config));
    }

    pub async fn connect_all(&mut self) -> anyhow::Result<()> {
        /// Per-server connect bound so a dead stdio/remote host cannot hold
        /// the manager mutex forever and stall later tool calls.
        const MCP_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
        for (name, client) in self.clients.iter_mut() {
            if client.config.enabled {
                match tokio::time::timeout(MCP_CONNECT_TIMEOUT, client.connect()).await {
                    Ok(Ok(_)) => tracing::info!("MCP client {} connected", name),
                    Ok(Err(e)) => {
                        tracing::warn!("MCP client {} failed to connect: {}", name, e)
                    }
                    Err(_elapsed) => {
                        tracing::warn!(
                            "MCP client {} connect timed out after {}s",
                            name,
                            MCP_CONNECT_TIMEOUT.as_secs()
                        )
                    }
                }
            }
        }
        Ok(())
    }

    pub async fn disconnect_all(&mut self) -> anyhow::Result<()> {
        for client in self.clients.values_mut() {
            client.disconnect().await?;
        }
        Ok(())
    }

    pub fn get_all_tools(&self) -> Vec<McpTool> {
        self.clients.values().flat_map(|c| c.get_tools()).collect()
    }

    pub async fn call_tool(&mut self, full_name: &str, args: Value) -> anyhow::Result<String> {
        for client in self.clients.values_mut() {
            if let Some(tool_name) = client
                .get_tools()
                .into_iter()
                .find(|tool| tool.full_name == full_name)
                .map(|tool| tool.name)
            {
                return client.call_tool(&tool_name, args).await;
            }
        }

        anyhow::bail!("MCP tool not found: {full_name}")
    }

    pub fn get_connected_clients(&self) -> Vec<&str> {
        self.clients
            .iter()
            .filter(|(_, c)| c.is_connected())
            .map(|(name, _)| name.as_str())
            .collect()
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}
