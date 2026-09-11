pub mod client;
pub mod tool_adapter;
pub mod transport;

pub use tool_adapter::McpToolAdapter;
pub use transport::{McpTransport, McpTransportConfig};

use crate::types::ToolDefinition;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpConfig {
    #[serde(rename = "type", default)]
    pub transport_type: String,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Whether MCP tools from this server are available in Plan mode.
    /// Defaults to true since we cannot inspect whether an MCP tool is read-only.
    #[serde(default = "default_plan_mode")]
    pub plan_mode: bool,
}

#[derive(Debug, Clone)]
pub struct McpTool {
    pub name: String,
    pub server_name: String,
    pub full_name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    pub plan_mode: bool,
}

impl McpTool {
    pub fn to_tool_definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.full_name.clone(),
            description: self.description.clone(),
            parameters: self.input_schema.clone(),
        }
    }
}

fn default_enabled() -> bool {
    true
}

fn default_plan_mode() -> bool {
    true
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            transport_type: "local".to_string(),
            command: Vec::new(),
            url: None,
            env: std::collections::HashMap::new(),
            headers: std::collections::HashMap::new(),
            timeout: Some(30000),
            enabled: true,
            plan_mode: true,
        }
    }
}
