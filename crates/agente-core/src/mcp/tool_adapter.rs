use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::mcp::client::McpManager;
use crate::tools::{Tool, ToolError, ToolExecutionMode, ToolRenderInfo};

/// Adapter that makes an MCP tool look like a native `Tool` to the registry.
pub struct McpToolAdapter {
    name: String,
    description: String,
    parameters: serde_json::Value,
    plan_mode: bool,
    manager: Arc<Mutex<McpManager>>,
}

impl McpToolAdapter {
    pub fn from_mcp_tool(mcp_tool: crate::mcp::McpTool, manager: Arc<Mutex<McpManager>>) -> Self {
        Self {
            name: mcp_tool.full_name.clone(),
            description: mcp_tool.description.clone(),
            parameters: mcp_tool.input_schema.clone(),
            plan_mode: mcp_tool.plan_mode,
            manager,
        }
    }
}

#[async_trait]
impl Tool for McpToolAdapter {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> serde_json::Value {
        self.parameters.clone()
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        // MCP tools are treated as parallel by default.
        ToolExecutionMode::Parallel
    }

    fn allowed_in_plan(&self) -> bool {
        self.plan_mode
    }

    fn icon(&self) -> &'static str {
        // Distinct hexagon icon for MCP tools.
        "⬡"
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, ToolError> {
        let mut manager = self.manager.lock().await;
        manager
            .call_tool(&self.name, args)
            .await
            .map_err(|e| ToolError::ExecutionError(format!("MCP tool failed: {e}")))
    }

    fn render_call(&self, args: &serde_json::Value) -> ToolRenderInfo {
        let detail = args
            .as_object()
            .and_then(|m| m.values().next())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        ToolRenderInfo {
            icon: self.icon(),
            label: format!("mcp:{}", self.name),
            detail,
        }
    }
}
