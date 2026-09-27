use std::sync::Arc;

use async_trait::async_trait;

use crate::mcp::client::McpManager;
use crate::permissions::Permission;
use crate::tools::{Tool, ToolError, ToolExecutionMode, ToolKind, ToolRenderInfo};
use crate::types::AgentMode;

/// Makes an MCP tool look like a native [`Tool`] to the registry.
///
/// Permissions follow the server's hints: a `readOnlyHint` tool runs without
/// approval and is offered in Plan mode (when the server allows Plan mode);
/// any other tool asks first unless the server is configured `trust: true`.
pub struct McpToolAdapter {
    name: String,
    description: String,
    parameters: serde_json::Value,
    plan_mode: bool,
    read_only: bool,
    trusted: bool,
    manager: Arc<McpManager>,
}

impl McpToolAdapter {
    pub fn from_mcp_tool(mcp_tool: crate::mcp::McpTool, manager: Arc<McpManager>) -> Self {
        Self {
            name: mcp_tool.full_name,
            description: mcp_tool.description,
            parameters: mcp_tool.input_schema,
            plan_mode: mcp_tool.plan_mode,
            read_only: mcp_tool.read_only,
            trusted: mcp_tool.trusted,
            manager,
        }
    }

    /// One adapter per tool of every ready server.
    pub fn all(manager: &Arc<McpManager>) -> Vec<Box<dyn Tool>> {
        manager
            .tools()
            .into_iter()
            .map(|t| Box::new(Self::from_mcp_tool(t, Arc::clone(manager))) as Box<dyn Tool>)
            .collect()
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
        ToolExecutionMode::Parallel
    }

    fn kind(&self) -> ToolKind {
        if self.read_only {
            ToolKind::Read
        } else {
            ToolKind::Other
        }
    }

    fn allowed_in_plan(&self) -> bool {
        self.plan_mode && self.read_only
    }

    fn default_permission(&self, mode: AgentMode) -> Option<Permission> {
        Some(match mode {
            AgentMode::Plan if self.allowed_in_plan() => Permission::Allow,
            AgentMode::Plan => Permission::Deny,
            AgentMode::Build if self.read_only || self.trusted => Permission::Allow,
            AgentMode::Build => Permission::Ask,
        })
    }

    fn icon(&self) -> &'static str {
        "⬡"
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, ToolError> {
        let output = self
            .manager
            .call_tool(&self.name, args)
            .await
            .map_err(|e| ToolError::ExecutionError(format!("MCP tool failed: {e}")))?;
        if output.is_error {
            // Surfaces as a failed call, so the model sees it went wrong.
            return Err(ToolError::ExecutionError(
                if output.text.trim().is_empty() {
                    "MCP tool reported an error".to_string()
                } else {
                    output.text
                },
            ));
        }
        Ok(output.text)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::{PermissionEngine, ToolFsFacts};

    fn adapter(read_only: bool, trusted: bool, plan_mode: bool) -> McpToolAdapter {
        McpToolAdapter::from_mcp_tool(
            crate::mcp::McpTool {
                name: "t".into(),
                server_name: "s".into(),
                full_name: "s_t".into(),
                description: "d".into(),
                input_schema: serde_json::json!({"type": "object"}),
                plan_mode,
                read_only,
                trusted,
            },
            Arc::new(McpManager::new()),
        )
    }

    fn decide(tool: &McpToolAdapter, mode: AgentMode, auto_approve: bool) -> Permission {
        let mut engine = PermissionEngine::new(mode);
        engine.set_auto_approve(auto_approve);
        engine.check_tool_with_default(
            tool.name(),
            &serde_json::json!({}),
            &ToolFsFacts::default(),
            tool.default_permission(mode),
        )
    }

    #[test]
    fn read_only_hint_skips_approval_and_other_tools_ask() {
        let read = adapter(true, false, true);
        let write = adapter(false, false, true);
        assert_eq!(decide(&read, AgentMode::Build, false), Permission::Allow);
        assert_eq!(decide(&write, AgentMode::Build, false), Permission::Ask);
        assert_eq!(
            decide(&write, AgentMode::Build, true),
            Permission::Allow,
            "auto-approve still covers MCP asks"
        );
        assert_eq!(
            decide(&adapter(false, true, true), AgentMode::Build, false),
            Permission::Allow
        );

        assert_eq!(decide(&read, AgentMode::Plan, false), Permission::Allow);
        assert_eq!(decide(&write, AgentMode::Plan, false), Permission::Deny);
        assert_eq!(
            decide(&adapter(true, false, false), AgentMode::Plan, false),
            Permission::Deny
        );
    }
}
