//! Subagent host: spawn orchestration wired into the agent loop.
//!
//! The host owns the shared subagent registry and knows how to translate a
//! `task` / `task_output` / `kill_task` tool call into a child agent run. The
//! child reuses the same `run_agent_loop` as the parent, but streams its
//! events through a private channel that a forwarder re-emits as
//! `AgentEvent::Subagent*` on the parent's channel, so the TUI renders nested
//! activity without confusing turn-level `Done` events.

mod board;
mod forwarder;
mod spawn;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::{mpsc::Sender, Arc, OnceLock};

use crate::agent::channel::ToolCallOutcome;
use crate::agent::events::{AgentEvent, AgentTaskEvent};
use crate::cancellation::AbortSignal;
use crate::catalog::ModelCatalog;
use crate::permissions::{ApprovalBroker, SharedPermissionEngine};
use crate::providers::ProviderRegistry;
use crate::subagent::definition::{filter_tool_definitions, AgentDefinition};
use crate::subagent::registry::SubagentRegistry;
use crate::subagent::types::{
    SubagentCapabilityMode, SubagentResult, SubagentSpawnRequest, SubagentStatus,
};
use crate::subagent::worktree;
use crate::tools::ToolExecutionContext;
use crate::types::{ToolCall, ToolDefinition};

/// Bounded wait for `task_output` when the model omits `timeout_ms` (or passes
/// 0, which used to block forever in event silence).
const DEFAULT_TASK_OUTPUT_WAIT_MS: u64 = 120_000;
/// Liveness tick while `task_output` waits on a still-running child.
const TASK_OUTPUT_HEARTBEAT_MS: u64 = 15_000;

/// Tool gating policy applied to a child agent's registry (capability mode,
/// optional type allowlist, and optional board `owns` path scope).
#[derive(Debug, Clone)]
pub struct ToolPolicy {
    pub capability: SubagentCapabilityMode,
    pub allowlist: Option<Vec<String>>,
    pub owns: Vec<String>,
}

impl ToolPolicy {
    /// True when a tool name is allowed for this child.
    pub fn allows(&self, tool_name: &str) -> bool {
        let in_allowlist = self
            .allowlist
            .as_ref()
            .map(|list| list.iter().any(|t| t == tool_name))
            .unwrap_or(true);
        in_allowlist
            && crate::subagent::definition::tool_allowed_by_capability(tool_name, self.capability)
    }

    /// True when `path` is within at least one of this card's `owns` patterns
    /// (or when `owns` is empty).
    pub fn allows_path(&self, path: &str, project_dir: &str) -> bool {
        if self.owns.is_empty() {
            return true;
        }
        let Some(rel) = relative_to_project(path, project_dir) else {
            return false;
        };
        self.owns
            .iter()
            .any(|owned| crate::swarm::path_is_owned(owned, &rel))
    }

    /// Validate a tool call against capability, allowlist, and (for mutating
    /// file tools `write_file`, `edit_file`, `apply_patch`) board `owns` scope.
    pub fn check_tool_call(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        project_dir: &str,
    ) -> Result<(), String> {
        if !self.allows(tool_name) {
            return Err(format!(
                "Tool '{tool_name}' is not allowed by subagent policy"
            ));
        }
        if !self.owns.is_empty() && matches!(tool_name, "write_file" | "edit_file" | "apply_patch")
        {
            let mut targets: Vec<String> = Vec::new();
            if let Some(path) = args
                .get("path")
                .or_else(|| args.get("file_path"))
                .or_else(|| args.get("filePath"))
                .or_else(|| args.get("filepath"))
                .or_else(|| args.get("file"))
                .or_else(|| args.get("filename"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                targets.push(path.to_string());
            }
            if tool_name == "apply_patch" {
                if let Some(patch_text) = args
                    .get("patch")
                    .or_else(|| args.get("diff"))
                    .or_else(|| args.get("unified_diff"))
                    .and_then(|v| v.as_str())
                {
                    for extracted in
                        crate::tools::patch::extract_all_target_files_from_patch(patch_text)
                    {
                        if !targets.contains(&extracted) {
                            targets.push(extracted);
                        }
                    }
                }
            }
            if targets.is_empty() {
                return Err(format!(
                    "Access denied: '{tool_name}' requires a target path within owned paths ({})",
                    self.owns.join(", ")
                ));
            }
            for target in &targets {
                if !self.allows_path(target, project_dir) {
                    return Err(format!(
                        "Access denied: '{target}' is outside this card's owned paths ({})",
                        self.owns.join(", ")
                    ));
                }
            }
        }
        Ok(())
    }

    /// Filter tool definitions for the child's request.
    pub fn filter_definitions(&self, definitions: Vec<ToolDefinition>) -> Vec<ToolDefinition> {
        filter_tool_definitions(definitions, self.capability, self.allowlist.as_deref())
    }
}

fn relative_to_project(path: &str, project_dir: &str) -> Option<String> {
    let base_path = Path::new(project_dir);
    if base_path.exists() {
        let resolved = crate::tools::resolve_project_path(path, project_dir).ok()?;
        let canonical_base = crate::tools::canonical_base_cached(project_dir);
        let rel = crate::tools::comparable_path(&resolved)
            .strip_prefix(crate::tools::comparable_path(&canonical_base))
            .ok()?
            .to_path_buf();
        return Some(rel.to_string_lossy().replace('\\', "/"));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        let rel = candidate.strip_prefix(base_path).ok()?;
        Some(rel.to_string_lossy().replace('\\', "/"))
    } else {
        Some(path.to_string())
    }
}

/// Everything the host needs to spawn and observe children.
#[derive(Clone)]
pub struct SubagentHostConfig {
    pub event_sender: Sender<AgentTaskEvent>,
    pub task_id: u64,
    pub provider_id: String,
    pub provider_registry: Arc<ProviderRegistry>,
    pub catalog: Option<Arc<ModelCatalog>>,
    pub permission_engine: SharedPermissionEngine,
    pub approval_broker: ApprovalBroker,
    pub mcp_manager: Option<Arc<crate::mcp::client::McpManager>>,
    pub project_dir: String,
    pub model: String,
    pub thinking_level: String,
    /// Shared subagent registry. The TUI holds the same handle so the status
    /// bar counter and `/subagents` popup observe the live set of children.
    pub registry: SubagentRegistry,
    /// Custom agents discovered once when the host is built (per turn) —
    /// spawning used to re-read `.agente/agents` from disk on every `task`
    /// call. Built-ins are always live.
    pub custom_agents: Vec<AgentDefinition>,
    /// The user's subagent model list, per-type defaults and picking switch
    /// (`subagents` setting), read by `subagent::routing`.
    pub subagents: crate::config::SubagentSettings,
    /// The parent turn's command environment; children inherit it, so a
    /// bot's subagent never gets the host's keys either.
    pub shell_env: crate::tools::ShellEnv,
    /// The parent turn's tool allowlist (a bot's toolsets); children never
    /// get a tool their parent couldn't use.
    pub only_tools: Option<Vec<String>>,
}

/// Spawn orchestration + shared registry, shareable between parent and children.
#[derive(Clone)]
pub struct SubagentHost {
    pub(super) inner: Arc<SubagentHostInner>,
}

pub(super) struct SubagentHostInner {
    pub(super) config: SubagentHostConfig,
    pub(super) registry: SubagentRegistry,
    pub(super) max_depth: u32,
    pub(super) max_concurrent: usize,
    /// The parent runtime owns queued preparation; forwarders run on plain
    /// OS threads, and child runtimes disappear when their loops finish.
    pub(super) scheduler: OnceLock<tokio::runtime::Handle>,
    pub(super) mcp_session_id: OnceLock<uuid::Uuid>,
}

fn outcome_from_result(
    tool_call_id: String,
    tool_name: &str,
    result: SubagentResult,
) -> ToolCallOutcome {
    let content = result.render();
    if result.is_error {
        ToolCallOutcome::err_raw(tool_call_id, tool_name, content)
    } else {
        ToolCallOutcome::ok(tool_call_id, tool_name, content)
    }
}

impl SubagentHost {
    pub fn new(config: SubagentHostConfig, max_depth: u32, max_concurrent: usize) -> Self {
        let registry = config.registry.clone();
        worktree::gc_in_background(Path::new(&config.project_dir));
        Self {
            inner: Arc::new(SubagentHostInner {
                config,
                registry,
                max_depth,
                max_concurrent,
                scheduler: OnceLock::new(),
                mcp_session_id: OnceLock::new(),
            }),
        }
    }

    /// Children share the root conversation's Desktop tool ownership.
    pub fn with_mcp_session_id(self, session: uuid::Uuid) -> Self {
        let _ = self.inner.mcp_session_id.set(session);
        self
    }

    pub fn mcp_session_id(&self) -> Option<uuid::Uuid> {
        self.inner.mcp_session_id.get().copied()
    }

    /// The user's models the orchestrator may assign, priced and sized from
    /// the same metadata a turn resolves (registry, live data, catalog).
    pub fn model_menu(&self) -> Vec<crate::subagent::routing::ModelMenuEntry> {
        let config = &self.inner.config;
        crate::subagent::routing::model_menu(&config.subagents, |provider, model| {
            let info = crate::providers::resolve_model_info(
                &config.provider_registry,
                config.catalog.as_deref(),
                provider,
                model,
            );
            (info.cost, info.limits.context)
        })
    }

    /// Execute a hosted subagent tool call (`task`, `task_output`, `kill_task`, `board`).
    pub(crate) async fn execute_hosted_tool_call(
        &self,
        tool_call: &ToolCall,
        args: serde_json::Value,
        context: ToolExecutionContext,
        depth: u32,
    ) -> ToolCallOutcome {
        let tool_call_id = tool_call.id.clone();
        let parent_cancel = context.cancellation.clone();
        match tool_call.function.name.as_str() {
            "task" => {
                let request: SubagentSpawnRequest = match serde_json::from_value(args) {
                    Ok(req) => req,
                    Err(e) => {
                        return ToolCallOutcome::error(
                            tool_call_id,
                            "task",
                            format!("Invalid task arguments: {e}"),
                        );
                    }
                };
                if request.prompt.trim().is_empty() {
                    return ToolCallOutcome::error(
                        tool_call_id,
                        "task",
                        "Missing required 'prompt' parameter",
                    );
                }
                if request.description.trim().is_empty() {
                    return ToolCallOutcome::error(
                        tool_call_id,
                        "task",
                        "Missing required 'description' parameter",
                    );
                }
                let result = self.spawn(request, parent_cancel, depth).await;
                outcome_from_result(tool_call_id, "task", result)
            }
            "board" => {
                self.inner
                    .scheduler
                    .get_or_init(tokio::runtime::Handle::current);
                self.execute_board(tool_call_id, args, parent_cancel, depth)
                    .await
            }
            "task_output" => self.task_output(tool_call_id, args, &context).await,
            "kill_task" => self.kill_task(tool_call_id, args),
            other => {
                ToolCallOutcome::error(tool_call_id, other, format!("Unknown hosted tool: {other}"))
            }
        }
    }

    pub(super) async fn task_output(
        &self,
        tool_call_id: String,
        args: serde_json::Value,
        context: &ToolExecutionContext,
    ) -> ToolCallOutcome {
        let parent_cancel = context.cancellation.clone();
        let Some(task_id) = args.get("task_id").and_then(|v| v.as_str()) else {
            return ToolCallOutcome::error(
                tool_call_id,
                "task_output",
                "Missing required 'task_id' parameter",
            );
        };
        let timeout_ms = match args.get("timeout_ms").and_then(|v| v.as_u64()) {
            Some(ms) if ms > 0 => ms,
            _ => DEFAULT_TASK_OUTPUT_WAIT_MS,
        };

        let Some(snapshot) = self.inner.registry.get(task_id) else {
            return ToolCallOutcome::error(
                tool_call_id,
                "task_output",
                format!(
                    "Unknown task id '{task_id}'. It may belong to another session or have been cleaned up."
                ),
            );
        };

        let result = if snapshot.status.is_terminal() {
            SubagentResult {
                id: task_id.to_string(),
                status: snapshot.status,
                summary: snapshot.summary.clone(),
                resume_from_hint: Some(task_id.to_string()),
                is_error: matches!(
                    snapshot.status,
                    SubagentStatus::Failed | SubagentStatus::Cancelled
                ),
            }
        } else {
            if let Some(rx) = self.inner.registry.completion_receiver(task_id) {
                let mut rx = rx;
                let deadline =
                    tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
                let heartbeat = std::time::Duration::from_millis(TASK_OUTPUT_HEARTBEAT_MS);
                loop {
                    if *rx.borrow() {
                        break;
                    }
                    let now = tokio::time::Instant::now();
                    if now >= deadline {
                        break;
                    }
                    tokio::select! {
                        _ = tokio::time::sleep_until((now + heartbeat).min(deadline)) => {
                            context.heartbeat();
                        }
                        _ = rx.changed() => break,
                        _ = parent_cancel.wait_aborted() => break,
                    }
                }
            }
            let snap = self.inner.registry.get(task_id).unwrap_or(snapshot);
            SubagentResult {
                id: task_id.to_string(),
                status: snap.status,
                summary: snap.summary.clone(),
                resume_from_hint: Some(task_id.to_string()),
                is_error: matches!(
                    snap.status,
                    SubagentStatus::Failed | SubagentStatus::Cancelled
                ),
            }
        };

        if result.status.is_terminal() {
            self.inner.registry.mark_observed(task_id);
        }

        outcome_from_result(tool_call_id, "task_output", result)
    }

    pub(super) fn kill_task(
        &self,
        tool_call_id: String,
        args: serde_json::Value,
    ) -> ToolCallOutcome {
        let Some(task_id) = args.get("task_id").and_then(|v| v.as_str()) else {
            return ToolCallOutcome::error(
                tool_call_id,
                "kill_task",
                "Missing required 'task_id' parameter",
            );
        };
        if !self.inner.registry.contains(task_id) {
            return ToolCallOutcome::error(
                tool_call_id,
                "kill_task",
                format!("Unknown task id '{task_id}'"),
            );
        }
        if let Some(queued) = self.inner.registry.take_queued(task_id) {
            queued.controller.abort();
            self.inner.registry.finish(
                task_id,
                SubagentStatus::Cancelled,
                "cancelled while queued".to_string(),
                Vec::new(),
            );
            self.inner.registry.mark_observed(task_id);
            let _ = self.inner.config.event_sender.send(AgentTaskEvent {
                task_id: self.inner.config.task_id,
                event: AgentEvent::SubagentDone {
                    id: task_id.to_string(),
                    summary: "cancelled while queued".to_string(),
                    is_error: true,
                },
            });
            self.board_child_finished(task_id);
            return ToolCallOutcome::ok(
                tool_call_id,
                "kill_task",
                format!("Subagent {task_id} cancelled while queued"),
            );
        }
        self.inner.registry.cancel(task_id);
        let still_running = self
            .inner
            .registry
            .get(task_id)
            .is_some_and(|snap| !snap.status.is_terminal());
        if still_running {
            self.inner.registry.mark_observed(task_id);
        }
        ToolCallOutcome::ok(
            tool_call_id,
            "kill_task",
            format!("Subagent {task_id} cancelled"),
        )
    }
}
