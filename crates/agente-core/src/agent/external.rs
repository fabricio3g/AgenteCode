//! Provider-independent agent runtime for native host integrations.
//!
//! This module is intentionally independent from Rust provider implementations.
//! Electron can keep its own provider stack and use this runtime for native
//! workspace tools, permission checks, and heavy code operations.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock as AsyncRwLock};

use super::change_tracker::{ChangeTracker, ChangedFileInfo, FileDiffInfo, RevertResult};
use crate::cancellation::AbortSignal;
use crate::mcp::client::McpManager;
use crate::mcp::{McpConfig, McpToolAdapter};
use crate::permissions::{Permission, PermissionEngine, SharedPermissionEngine};
use crate::tools::{ToolExecutionContext, ToolRegistry};
use crate::types::{AgentMode, ToolCall, ToolDefinition};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalRuntimeConfig {
    pub project_dir: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub auto_approve: bool,
}

fn default_mode() -> String {
    "plan".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalToolResult {
    pub tool_call_id: String,
    pub tool_name: String,
    pub content: String,
    pub is_error: bool,
    #[serde(default)]
    pub approval_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalToolReview {
    pub tool_call_id: String,
    pub tool_name: String,
    pub tool_args: String,
    pub description: String,
    pub approval_required: bool,
    pub is_denied: bool,
    pub is_dangerous: bool,
    pub file_path: Option<String>,
}

pub struct ExternalAgentRuntime {
    project_dir: String,
    tool_registry: Arc<AsyncRwLock<ToolRegistry>>,
    permission_engine: SharedPermissionEngine,
    change_tracker: Arc<Mutex<ChangeTracker>>,
    mcp_managers: Arc<Mutex<Vec<Arc<Mutex<McpManager>>>>>,
}

impl ExternalAgentRuntime {
    pub fn new(config: ExternalRuntimeConfig) -> Self {
        let mode = parse_mode(&config.mode);
        let mut permission_engine = PermissionEngine::new(mode);
        permission_engine.set_auto_approve(config.auto_approve);

        Self {
            project_dir: config.project_dir.clone(),
            tool_registry: Arc::new(AsyncRwLock::new(ToolRegistry::new(config.project_dir))),
            permission_engine: Arc::new(RwLock::new(permission_engine)),
            change_tracker: Arc::new(Mutex::new(ChangeTracker::default())),
            mcp_managers: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn connect_mcp_servers(&self, configs: HashMap<String, McpConfig>) -> Vec<String> {
        let old_managers = {
            let mut managers = self.mcp_managers.lock().await;
            std::mem::take(&mut *managers)
        };
        for manager in old_managers {
            let _ = manager.lock().await.disconnect_all().await;
        }

        let mut manager = McpManager::new();
        for (name, config) in configs {
            if config.enabled {
                manager.add_client(name, config);
            }
        }

        let _ = manager.connect_all().await;
        let connected = manager
            .get_connected_clients()
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();

        let manager = Arc::new(Mutex::new(manager));
        let mcp_tools = {
            let guard = manager.lock().await;
            guard.get_all_tools()
        };

        let adapters = mcp_tools
            .into_iter()
            .map(|tool| {
                Box::new(McpToolAdapter::from_mcp_tool(tool, Arc::clone(&manager)))
                    as Box<dyn crate::tools::Tool>
            })
            .collect();

        let mut registry = ToolRegistry::new(self.project_dir.clone());
        registry.register_mcp_adapters(adapters);
        *self.tool_registry.write().await = registry;
        self.mcp_managers.lock().await.push(manager);

        connected
    }

    pub fn set_mode(&self, mode: &str) {
        let mut engine = self
            .permission_engine
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        engine.set_mode(parse_mode(mode));
    }

    pub fn set_auto_approve(&self, auto_approve: bool) {
        let mut engine = self
            .permission_engine
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        engine.set_auto_approve(auto_approve);
    }

    pub fn tool_definitions(&self, mode: Option<&str>) -> Vec<ToolDefinition> {
        let resolved = mode.map(parse_mode).unwrap_or_else(|| {
            self.permission_engine
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mode
        });
        self.tool_registry
            .blocking_read()
            .definitions_for_mode(resolved)
            .into_iter()
            // Hosted subagent lifecycle is intercepted by `spawn_chat_task`,
            // which this runtime does not run. Advertising it here only
            // produces a failed call and teaches the model not to retry.
            .filter(|definition| {
                !matches!(
                    definition.name.as_str(),
                    "task" | "task_output" | "kill_task"
                )
            })
            .collect()
    }

    pub fn review_tool_calls(&self, tool_calls: Vec<ToolCall>) -> Vec<ExternalToolReview> {
        tool_calls
            .into_iter()
            .map(|tool_call| {
                let tool_name = tool_call.function.name.clone();
                let args: serde_json::Value = serde_json::from_str(&tool_call.function.arguments)
                    .unwrap_or_else(|_| serde_json::json!({}));
                let permission = {
                    let engine = self
                        .permission_engine
                        .read()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    engine.check_tool(&tool_name, &args)
                };

                ExternalToolReview {
                    tool_call_id: tool_call.id,
                    description: format!("Execute tool: {tool_name}"),
                    is_dangerous: is_dangerous_tool_call(&tool_name, &args),
                    file_path: args
                        .get("path")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    tool_name,
                    tool_args: tool_call.function.arguments,
                    approval_required: matches!(permission, Permission::Ask),
                    is_denied: matches!(permission, Permission::Deny),
                }
            })
            .collect()
    }

    pub async fn execute_tool_calls(&self, tool_calls: Vec<ToolCall>) -> Vec<ExternalToolResult> {
        self.execute_tool_calls_inner(tool_calls, false, AbortSignal::never())
            .await
    }

    pub async fn execute_approved_tool_calls(
        &self,
        tool_calls: Vec<ToolCall>,
    ) -> Vec<ExternalToolResult> {
        self.execute_tool_calls_inner(tool_calls, true, AbortSignal::never())
            .await
    }

    /// Cancellation-aware tool execution: aborting `cancel` drops in-flight
    /// tool futures (and reaches process-tree teardown for shell) instead of
    /// leaving commands running after the host abandoned the turn.
    pub async fn execute_tool_calls_cancellable(
        &self,
        tool_calls: Vec<ToolCall>,
        cancel: AbortSignal,
    ) -> Vec<ExternalToolResult> {
        self.execute_tool_calls_inner(tool_calls, false, cancel)
            .await
    }

    /// [`execute_approved_tool_calls`] with a cancellation signal.
    pub async fn execute_approved_tool_calls_cancellable(
        &self,
        tool_calls: Vec<ToolCall>,
        cancel: AbortSignal,
    ) -> Vec<ExternalToolResult> {
        self.execute_tool_calls_inner(tool_calls, true, cancel)
            .await
    }

    pub async fn changed_files(&self) -> Vec<ChangedFileInfo> {
        self.change_tracker.lock().await.changed_files()
    }

    pub async fn file_diff(&self, path: &str) -> Option<FileDiffInfo> {
        self.change_tracker
            .lock()
            .await
            .file_diff(&self.project_dir, path)
    }

    pub async fn revert_file(&self, path: &str) -> RevertResult {
        self.change_tracker
            .lock()
            .await
            .revert_file(&self.project_dir, path)
            .await
    }

    pub async fn revert_all(&self) -> Vec<RevertResult> {
        self.change_tracker
            .lock()
            .await
            .revert_all(&self.project_dir)
            .await
    }

    async fn execute_tool_calls_inner(
        &self,
        tool_calls: Vec<ToolCall>,
        approved_once: bool,
        cancel: AbortSignal,
    ) -> Vec<ExternalToolResult> {
        let has_sequential = {
            let registry = self.tool_registry.read().await;
            tool_calls
                .iter()
                .any(|tc| registry.is_sequential(&tc.function.name))
        };

        if has_sequential {
            let mut results = Vec::with_capacity(tool_calls.len());
            for tool_call in tool_calls {
                results.push(self.execute_one(tool_call, approved_once, &cancel).await);
            }
            return results;
        }

        let futures = tool_calls
            .into_iter()
            .map(|tool_call| self.execute_one(tool_call, approved_once, &cancel));
        join_all(futures).await
    }

    async fn execute_one(
        &self,
        tool_call: ToolCall,
        approved_once: bool,
        cancel: &AbortSignal,
    ) -> ExternalToolResult {
        let tool_name = tool_call.function.name.clone();
        let tool_call_id = tool_call.id.clone();
        let args: serde_json::Value = serde_json::from_str(&tool_call.function.arguments)
            .unwrap_or_else(|_| serde_json::json!({}));

        let mode = self
            .permission_engine
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mode;
        let allowed_in_mode = self
            .tool_registry
            .read()
            .await
            .is_allowed_in_mode(&tool_name, mode);
        if !allowed_in_mode {
            return ExternalToolResult {
                tool_call_id,
                tool_name,
                content: "Error: Tool is not allowed in current mode".to_string(),
                is_error: true,
                approval_required: false,
            };
        }

        let permission = {
            let engine = self
                .permission_engine
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            engine.check_tool(&tool_name, &args)
        };

        match permission {
            Permission::Deny => {
                return ExternalToolResult {
                    tool_call_id,
                    tool_name,
                    content: "Error: Tool is denied in current mode".to_string(),
                    is_error: true,
                    approval_required: false,
                };
            }
            Permission::Ask => {
                if !approved_once {
                    return ExternalToolResult {
                        tool_call_id,
                        tool_name,
                        content: "Approval required before executing this tool".to_string(),
                        is_error: true,
                        approval_required: true,
                    };
                }
            }
            Permission::Allow => {}
        }

        if is_mutating_file_tool(&tool_name) {
            if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
                let _ = self
                    .change_tracker
                    .lock()
                    .await
                    .capture_before(&self.project_dir, path)
                    .await;
            }
        }

        let execution = self
            .tool_registry
            .read()
            .await
            .execute_with_context(
                &tool_name,
                args.clone(),
                ToolExecutionContext::new(cancel.clone()),
            )
            .await;

        if execution.is_ok() && is_mutating_file_tool(&tool_name) {
            if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
                let _ = self
                    .change_tracker
                    .lock()
                    .await
                    .capture_after(&self.project_dir, path)
                    .await;
            }
        }

        match execution {
            Ok(content) => ExternalToolResult {
                tool_call_id,
                tool_name,
                content,
                is_error: false,
                approval_required: false,
            },
            Err(err) => ExternalToolResult {
                tool_call_id,
                tool_name,
                content: format!("Error: {err}"),
                is_error: true,
                approval_required: false,
            },
        }
    }
}

fn is_mutating_file_tool(tool_name: &str) -> bool {
    matches!(tool_name, "write_file" | "edit_file")
}

fn parse_mode(mode: &str) -> AgentMode {
    if mode.eq_ignore_ascii_case("build") {
        AgentMode::Build
    } else {
        AgentMode::Plan
    }
}

/// Danger heuristic for the external runtime: the single shared
/// `permissions::is_dangerous_command` check, scoped to shell calls.
fn is_dangerous_tool_call(tool_name: &str, args: &serde_json::Value) -> bool {
    if tool_name != "shell" {
        return false;
    }

    args.get("command")
        .and_then(|v| v.as_str())
        .map(crate::permissions::is_dangerous_command)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This runtime executes tools directly and has no `SubagentHost`, so the
    /// hosted `task` family cannot work here. Advertising it would only burn a
    /// failed call and teach the model not to retry.
    #[test]
    fn external_definitions_exclude_hosted_subagent_tools() {
        let runtime = ExternalAgentRuntime::new(ExternalRuntimeConfig {
            project_dir: ".".to_string(),
            mode: "build".to_string(),
            auto_approve: true,
        });
        let names: Vec<String> = runtime
            .tool_definitions(None)
            .into_iter()
            .map(|definition| definition.name)
            .collect();

        for hosted in ["task", "task_output", "kill_task"] {
            assert!(!names.contains(&hosted.to_string()), "{names:?}");
        }
        // Regular tools stay available.
        assert!(names.contains(&"read_file".to_string()), "{names:?}");
        assert!(names.contains(&"shell".to_string()), "{names:?}");
    }
}
