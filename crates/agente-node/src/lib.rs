use std::sync::Arc;

use agente_core::agent::{ExternalAgentRuntime, ExternalRuntimeConfig};
use agente_core::mcp::McpConfig;
use agente_core::types::ToolCall;
use napi::{Error, Result};
use napi_derive::napi;
use std::collections::HashMap;

#[napi]
pub struct AgentRuntime {
    inner: Arc<ExternalAgentRuntime>,
}

#[napi]
impl AgentRuntime {
    #[napi(constructor)]
    pub fn new(project_dir: String, mode: Option<String>, auto_approve: Option<bool>) -> Self {
        Self {
            inner: Arc::new(ExternalAgentRuntime::new(ExternalRuntimeConfig {
                project_dir,
                mode: mode.unwrap_or_else(|| "plan".to_string()),
                auto_approve: auto_approve.unwrap_or(false),
            })),
        }
    }

    #[napi]
    pub fn set_mode(&self, mode: String) {
        self.inner.set_mode(&mode);
    }

    #[napi]
    pub fn set_auto_approve(&self, auto_approve: bool) {
        self.inner.set_auto_approve(auto_approve);
    }

    /// Async because the underlying call uses `blocking_read` on the tool
    /// registry: it must run inside the napi tokio runtime via
    /// `spawn_blocking`, never on the JS thread (where it would panic when a
    /// tool execution holds the registry).
    #[napi]
    pub async fn get_tool_definitions_json(&self, mode: Option<String>) -> Result<String> {
        let inner = Arc::clone(&self.inner);
        let definitions =
            tokio::task::spawn_blocking(move || inner.tool_definitions(mode.as_deref()))
                .await
                .map_err(|error| {
                    Error::from_reason(format!("tool definitions task failed: {error}"))
                })?;
        serde_json::to_string(&definitions).map_err(to_napi_error)
    }

    #[napi]
    pub async fn connect_mcp_servers_json(&self, mcp_config_json: String) -> Result<String> {
        let configs: HashMap<String, McpConfig> =
            serde_json::from_str(&mcp_config_json).map_err(to_napi_error)?;
        let connected = self.inner.connect_mcp_servers(configs).await;
        serde_json::to_string(&connected).map_err(to_napi_error)
    }

    #[napi]
    pub fn review_tool_calls_json(&self, tool_calls_json: String) -> Result<String> {
        let tool_calls: Vec<ToolCall> =
            serde_json::from_str(&tool_calls_json).map_err(to_napi_error)?;
        let reviews = self.inner.review_tool_calls(tool_calls);
        serde_json::to_string(&reviews).map_err(to_napi_error)
    }

    #[napi]
    pub async fn execute_tool_calls_json(&self, tool_calls_json: String) -> Result<String> {
        let tool_calls: Vec<ToolCall> =
            serde_json::from_str(&tool_calls_json).map_err(to_napi_error)?;
        let results = self.inner.execute_tool_calls(tool_calls).await;
        serde_json::to_string(&results).map_err(to_napi_error)
    }

    #[napi]
    pub async fn execute_approved_tool_calls_json(
        &self,
        tool_calls_json: String,
    ) -> Result<String> {
        let tool_calls: Vec<ToolCall> =
            serde_json::from_str(&tool_calls_json).map_err(to_napi_error)?;
        let results = self.inner.execute_approved_tool_calls(tool_calls).await;
        serde_json::to_string(&results).map_err(to_napi_error)
    }

    #[napi]
    pub async fn get_changed_files_json(&self) -> Result<String> {
        let files = self.inner.changed_files().await;
        serde_json::to_string(&files).map_err(to_napi_error)
    }

    #[napi]
    pub async fn get_file_diff_json(&self, path: String) -> Result<String> {
        let diff = self.inner.file_diff(&path).await;
        serde_json::to_string(&diff).map_err(to_napi_error)
    }

    #[napi]
    pub async fn revert_file_json(&self, path: String) -> Result<String> {
        let result = self.inner.revert_file(&path).await;
        serde_json::to_string(&result).map_err(to_napi_error)
    }

    #[napi]
    pub async fn revert_all_files_json(&self) -> Result<String> {
        let results = self.inner.revert_all().await;
        serde_json::to_string(&results).map_err(to_napi_error)
    }
}

fn to_napi_error(err: serde_json::Error) -> Error {
    Error::from_reason(err.to_string())
}
