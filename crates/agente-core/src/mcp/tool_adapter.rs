use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use parking_lot::Mutex;

use crate::mcp::client::McpManager;
use crate::permissions::Permission;
use crate::tools::{
    Tool, ToolError, ToolExecutionContext, ToolExecutionMode, ToolKind, ToolRenderInfo,
    TOOL_HEARTBEAT_MS,
};
use crate::types::AgentMode;

/// Makes an MCP tool look like a native [`Tool`] to the registry.
///
/// Permissions follow the server's hints: a `readOnlyHint` tool runs without
/// approval and is offered in Plan mode (when the server allows Plan mode);
/// any other tool asks first unless the server is configured `trust: true`.
pub struct McpToolAdapter {
    name: String,
    owner_session: Option<uuid::Uuid>,
    description: String,
    parameters: serde_json::Value,
    plan_mode: bool,
    read_only: bool,
    trusted: bool,
    manager: Arc<McpManager>,
    /// Images and audio a call returned, stored and keyed by its call id,
    /// until the loop takes them for a model that can use them.
    media: Mutex<HashMap<String, Vec<agente_protocol::Attachment>>>,
}

impl McpToolAdapter {
    pub fn from_mcp_tool(mcp_tool: crate::mcp::McpTool, manager: Arc<McpManager>) -> Self {
        Self {
            name: mcp_tool.full_name,
            owner_session: None,
            description: mcp_tool.description,
            parameters: mcp_tool.input_schema,
            plan_mode: mcp_tool.plan_mode,
            read_only: mcp_tool.read_only,
            trusted: mcp_tool.trusted,
            manager,
            media: Mutex::new(HashMap::new()),
        }
    }

    /// Run the call; keep its media (a browser screenshot, say) as stored
    /// attachments for `call_id` rather than only a text placeholder.
    async fn call(&self, args: serde_json::Value, call_id: &str) -> Result<String, ToolError> {
        let output = self
            .manager
            .call_tool_with_meta(&self.name, args, self.request_meta())
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
        let stored: Vec<_> = output
            .media
            .iter()
            .enumerate()
            .filter_map(|(index, media)| {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(media.data.trim())
                    .ok()?;
                let name = format!("{}-{}", self.name, index + 1);
                crate::media::store_bytes(&bytes, &name, media.kind, &media.mime)
                    .map_err(
                        |error| tracing::warn!(tool = %self.name, %error, "MCP media not kept"),
                    )
                    .ok()
            })
            .collect();
        if !stored.is_empty() && !call_id.is_empty() {
            self.media.lock().insert(call_id.to_string(), stored);
        }
        Ok(output.text)
    }

    fn request_meta(&self) -> Option<serde_json::Value> {
        self.owner_session
            .filter(|_| self.name.starts_with("desktop_"))
            .map(|session| serde_json::json!({ "agente/sessionId": session.to_string() }))
    }

    /// Desktop tools inherit the root conversation, including from children.
    pub fn all_for_session(manager: &Arc<McpManager>, session: uuid::Uuid) -> Vec<Box<dyn Tool>> {
        manager
            .tools()
            .into_iter()
            .map(|tool| {
                let mut adapter = Self::from_mcp_tool(tool, Arc::clone(manager));
                adapter.owner_session = Some(session);
                Box::new(adapter) as Box<dyn Tool>
            })
            .collect()
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
        self.call(args, "").await
    }

    /// The default wrapper (cancellation, heartbeats) around [`Self::call`],
    /// which needs the call id to keep the result's media.
    async fn execute_with_context(
        &self,
        args: serde_json::Value,
        _project_dir: &str,
        context: ToolExecutionContext,
    ) -> Result<String, ToolError> {
        if context.cancellation.is_aborted() {
            return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
        }
        let run = self.call(args, &context.call_id);
        tokio::pin!(run);
        let mut heartbeat =
            tokio::time::interval(std::time::Duration::from_millis(TOOL_HEARTBEAT_MS));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;
        loop {
            tokio::select! {
                result = &mut run => return result,
                _ = context.cancellation.wait_aborted() => {
                    return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
                }
                _ = heartbeat.tick() => context.heartbeat(),
            }
        }
    }

    fn take_result_attachments(&self, call_id: &str) -> Vec<agente_protocol::Attachment> {
        self.media.lock().remove(call_id).unwrap_or_default()
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
    fn desktop_calls_carry_host_session_without_changing_model_arguments() {
        let mut tool = adapter(true, false, true);
        let session = uuid::Uuid::new_v4();
        tool.owner_session = Some(session);
        assert!(tool.request_meta().is_none());
        tool.name = "desktop_browser_snapshot".into();
        assert_eq!(
            tool.request_meta().unwrap()["agente/sessionId"],
            session.to_string()
        );
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
