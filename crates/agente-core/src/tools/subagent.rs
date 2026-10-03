//! Hosted subagent lifecycle tools: `task`, `task_output`, `kill_task`.
//!
//! These tools are *hosted* by the agent loop: their
//! schema and description are exposed through the normal tool registry, but
//! execution is intercepted in `agent::channel` and routed to the
//! `SubagentHost`. The `execute` implementations below only exist to satisfy
//! the `Tool` trait and never run in practice.

use async_trait::async_trait;

use super::{Tool, ToolError, ToolExecutionMode};

/// Live agent roster (built-ins + discovered customs) the description is
/// generated from. The prose is computed once at construction: generating it
/// lazily leaked a fresh `String` on every `description()` call, which the
/// registry performs each loop iteration.
pub struct TaskTool {
    description: String,
    /// Names advertised in the `subagent_type` schema enum so a provider can
    /// constrain the choice (a call shaped `{"type": "explore"}` used to fall
    /// through to the `general-purpose` default).
    agent_types: Vec<String>,
}

const FALLBACK_AGENT_TYPES: &[&str] = &["general-purpose", "explore", "plan"];

impl Default for TaskTool {
    fn default() -> Self {
        Self {
            description: task_description(&[]),
            agent_types: FALLBACK_AGENT_TYPES
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
        }
    }
}

impl TaskTool {
    /// Build the tool with the live agent roster for description generation.
    pub fn with_roster(roster: Vec<crate::subagent::definition::AgentRosterEntry>) -> Self {
        let description = task_description(&roster);
        let agent_types = if roster.is_empty() {
            FALLBACK_AGENT_TYPES
                .iter()
                .map(|name| (*name).to_string())
                .collect()
        } else {
            roster.iter().map(|entry| entry.name.clone()).collect()
        };
        Self {
            description,
            agent_types,
        }
    }
}

fn task_description(roster: &[crate::subagent::definition::AgentRosterEntry]) -> String {
    let mut out = String::from(
        "Spawn a subagent to complete a task. Subagents run in their own context with a restricted toolset.",
    );
    if roster.is_empty() {
        out.push_str(" Built-in types: \"general-purpose\" (all tools), \"explore\" (read-only investigation), \"plan\" (read-only planning). Custom types can be added as `.agente/agents/<name>.md`.");
    } else {
        out.push_str(" Available agent types:");
        for entry in roster {
            out.push_str(&format!(
                "\n- {} \u{2014} {} (tools: {})",
                entry.name,
                entry.description,
                crate::subagent::definition::roster_tools_summary(&entry.tools),
            ));
        }
        out.push_str("\nCustom types can be added as `.agente/agents/<name>.md`.");
    }
    out.push_str(
        " explore and plan wait for the result inline by default (pass run_in_background=true to detach); general-purpose runs in the background by default and returns a task_id immediately. Use task_output to fetch a background result and kill_task to cancel one. A background completion with no outstanding poll is pushed to you automatically — do not poll task_output in a loop. If all concurrency slots are busy the spawn queues and returns a pending handle instead of failing.",
    );
    // When to delegate, and what delegation costs. This used to live in the
    // executor system prompt, where it was a fifteen-line paragraph inside
    // "TOOL USAGE" — the mechanics belong to the tool, and the prompt renders
    // this description in full.
    out.push_str(
        " Reach for explore on open-ended codebase questions (\"where is X handled\", \"find every caller of Y\", \"how does Z flow\") instead of reading file after file yourself; reach for plan when you need an implementation plan from an investigation; general-purpose is for work that changes files. Spawning is not free: every child runs its own model calls, so prefer a flat fan-out over chains (nesting is capped at depth 3). When parallel children touch files, partition ownership up front — one child per area — so their edits never collide, and combine the results yourself.",
    );
    out.push_str(
        " The child starts with a fresh context: it sees ONLY your `prompt`, never the parent conversation. Pack everything it needs into the prompt — exact file paths, prior findings, constraints, and what \"done\" looks like. A prompt like \"fix what we discussed\" will fail.",
    );
    out.push_str(
        " In Plan mode every child runs with read-only tools regardless of subagent_type or capability_mode.",
    );
    out
}

#[async_trait]
impl Tool for TaskTool {
    fn name(&self) -> &str {
        "task"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Task
    }

    fn icon(&self) -> &'static str {
        "◈"
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> serde_json::Value {
        let mut schema = serde_json::json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The full task prompt for the subagent to execute."
                },
                "description": {
                    "type": "string",
                    "description": "Short description of the task (3-5 words)."
                },
                "subagent_type": {
                    "type": "string",
                    "description": "Name of the subagent type to launch. \"explore\" sweeps the codebase read-only, \"plan\" returns an implementation plan, \"general-purpose\" has all tools. Additional user-defined types may also be available.",
                    "default": "general-purpose"
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": "When true, returns immediately with a task_id and pushes the completion automatically; use task_output only to peek at a running result. Defaults to false for explore/plan (their result is needed inline) and true for general-purpose."
                },
                "capability_mode": {
                    "type": "string",
                    "enum": ["read-only", "read-write", "execute", "all"],
                    "description": "Capability mode: \"read-only\", \"read-write\", \"execute\", or \"all\". Controls which tool classes the child can use. Default is determined by the subagent type."
                },
                "cwd": {
                    "type": "string",
                    "description": "Explicit working directory for the subagent. The path must exist and be a directory. Defaults to an isolated git worktree seeded with the parent's current changes; pass isolation \"none\" to use the project directory instead."
                },
                "isolation": {
                    "type": "string",
                    "enum": ["worktree", "none"],
                    "description": "Where the child runs. \"worktree\" (default) gives the child its own git checkout under .agente/worktrees, seeded with your uncommitted changes; changes stay in that worktree for review. \"none\" runs in the project directory."
                },
                "max_iterations": {
                    "type": "integer",
                    "description": "Optional iteration cap for the child loop. Omit for unbounded (the child runs until it stops calling tools, bounded only by timeout_ms). The parent's budget is never inherited."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Wall-clock budget in milliseconds (default 600000). On expiry the subagent is aborted and reported as a timeout failure with its partial transcript kept."
                },
                "resume_from": {
                    "type": "string",
                    "description": "Resume from a previously completed subagent's conversation. Pass the task_id returned by a prior task call. The new subagent continues the previous one's raw transcript with the new task prompt appended. The source must be completed and use the same subagent_type."
                }
            },
            "required": ["prompt", "description"]
        });
        schema["properties"]["subagent_type"]["enum"] = serde_json::json!(self.agent_types);
        schema
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    async fn execute(
        &self,
        _args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, ToolError> {
        Err(ToolError::ExecutionError(
            "task is a hosted tool and is executed by the agent harness".into(),
        ))
    }
}

pub struct TaskOutputTool;

#[async_trait]
impl Tool for TaskOutputTool {
    fn name(&self) -> &str {
        "task_output"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Task
    }

    fn icon(&self) -> &'static str {
        "◈"
    }

    fn description(&self) -> &str {
        "Retrieve the output of a subagent spawned with the task tool. If the subagent is still \
         running, optionally wait up to timeout_ms for it to finish; otherwise returns its \
         current status. Returns an error for unknown task ids."
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "The subagent id returned by the task tool."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Optional: wait up to this many milliseconds for a running subagent to finish before returning its status. Defaults to 120000 when omitted."
                }
            },
            "required": ["task_id"]
        })
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    async fn execute(
        &self,
        _args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, ToolError> {
        Err(ToolError::ExecutionError(
            "task_output is a hosted tool and is executed by the agent harness".into(),
        ))
    }
}

pub struct KillTaskTool;

#[async_trait]
impl Tool for KillTaskTool {
    fn name(&self) -> &str {
        "kill_task"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Task
    }

    fn icon(&self) -> &'static str {
        "◈"
    }

    fn description(&self) -> &str {
        "Cancel a running subagent spawned with the task tool. Does nothing if the subagent \
         already finished. Returns an error for unknown task ids."
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "The subagent id returned by the task tool."
                }
            },
            "required": ["task_id"]
        })
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    async fn execute(
        &self,
        _args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, ToolError> {
        Err(ToolError::ExecutionError(
            "kill_task is a hosted tool and is executed by the agent harness".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subagent::types::SubagentSpawnRequest;
    use crate::tools::Tool;

    #[test]
    fn task_schema_requires_prompt_and_description() {
        let schema = TaskTool::default().parameters();
        let required = schema
            .get("required")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
            .unwrap_or_default();
        assert!(
            required.contains(&"prompt"),
            "task must require prompt: {required:?}"
        );
        assert!(
            required.contains(&"description"),
            "task must require description: {required:?}"
        );
    }

    #[test]
    fn task_output_and_kill_task_require_task_id() {
        for tool in [&TaskOutputTool as &dyn Tool, &KillTaskTool as &dyn Tool] {
            let schema = tool.parameters();
            let required = schema
                .get("required")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
                .unwrap_or_default();
            assert!(
                required.contains(&"task_id"),
                "{} must require task_id: {required:?}",
                tool.name()
            );
        }
    }

    #[test]
    fn task_description_states_plan_mode_read_only_rule() {
        let tool = TaskTool::default();
        let desc = tool.description();
        assert!(
            desc.contains("In Plan mode every child runs with read-only tools"),
            "task description must teach the Plan-mode coercion up front: {desc}"
        );
        assert!(
            desc.contains("pushed to you automatically"),
            "task description must teach push notification: {desc}"
        );
        assert!(
            desc.contains("queues and returns a pending handle"),
            "task description must teach queueing: {desc}"
        );
        assert!(
            desc.contains("ONLY your `prompt`"),
            "task description must teach that the child sees nothing else: {desc}"
        );
    }

    #[test]
    fn spawn_request_defaults_resolve_by_type() {
        // The LLM may omit the optional fields; serde defaults must kick in.
        let req: SubagentSpawnRequest = serde_json::from_value(serde_json::json!({
            "prompt": "explore the codebase",
            "description": "explore repo",
        }))
        .unwrap();
        assert_eq!(req.subagent_type, "general-purpose");
        assert!(
            req.run_in_background.is_none(),
            "run_in_background is unset so the host resolves it by type"
        );
        assert!(
            req.resolved_run_in_background(),
            "general-purpose defaults to background execution"
        );
        assert!(req.capability_mode.is_none());
        assert!(req.cwd.is_none());
        assert!(req.timeout_ms.is_none());
        assert!(req.resume_from.is_none());
    }

    /// explore/plan are research types: the parent needs their answer to
    /// continue, so they run inline unless background is explicitly requested.
    #[test]
    fn research_types_default_to_foreground() {
        let req: SubagentSpawnRequest = serde_json::from_value(serde_json::json!({
            "prompt": "p",
            "description": "d",
            "subagent_type": "explore",
        }))
        .unwrap();
        assert!(req.run_in_background.is_none());
        assert!(!req.resolved_run_in_background());

        let explicit: SubagentSpawnRequest = serde_json::from_value(serde_json::json!({
            "prompt": "p",
            "description": "d",
            "subagent_type": "explore",
            "run_in_background": true,
        }))
        .unwrap();
        assert!(explicit.resolved_run_in_background());
    }

    /// Models commonly spell the type argument `type` or `agent`; unknown keys
    /// used to be ignored and silently spawned `general-purpose`.
    #[test]
    fn subagent_type_accepts_common_aliases() {
        for key in ["type", "agent", "agent_type", "subagent_type"] {
            let mut payload = serde_json::json!({"prompt": "p", "description": "d"});
            payload[key] = serde_json::json!("explore");
            let req: SubagentSpawnRequest = serde_json::from_value(payload).unwrap();
            assert_eq!(req.subagent_type, "explore", "alias {key}");
        }
    }

    #[test]
    fn task_schema_enumerates_agent_types() {
        let schema = TaskTool::default().parameters();
        let types: Vec<&str> = schema["properties"]["subagent_type"]["enum"]
            .as_array()
            .expect("subagent_type enum")
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        for expected in ["explore", "plan", "general-purpose"] {
            assert!(types.contains(&expected), "{types:?}");
        }
    }

    #[test]
    fn roster_summary_marks_read_only_agents() {
        let summary = crate::subagent::definition::roster_tools_summary(&Some(vec![
            "read_file".to_string(),
            "grep".to_string(),
        ]));
        assert!(summary.starts_with("read-only:"), "{summary}");
    }

    #[test]
    fn spawn_request_accepts_full_payload() {
        let req: SubagentSpawnRequest = serde_json::from_value(serde_json::json!({
            "prompt": "do it",
            "description": "do work",
            "subagent_type": "explore",
            "run_in_background": false,
            "capability_mode": "read-only",
            "cwd": "/tmp/x",
            "timeout_ms": 5000,
            "resume_from": "abc",
        }))
        .unwrap();
        assert_eq!(req.subagent_type, "explore");
        assert_eq!(req.run_in_background, Some(false));
        assert_eq!(
            req.capability_mode,
            Some(crate::subagent::types::SubagentCapabilityMode::ReadOnly)
        );
        assert_eq!(req.cwd.as_deref(), Some("/tmp/x"));
        assert_eq!(req.timeout_ms, Some(5000));
        assert_eq!(req.resume_from.as_deref(), Some("abc"));
    }

    #[test]
    fn task_schema_advertises_timeout_ms_as_optional() {
        let schema = TaskTool::default().parameters();
        let props = schema.get("properties").expect("object schema");
        assert!(
            props.get("timeout_ms").is_some(),
            "timeout_ms must be a visible spawn arg"
        );
        let required = schema
            .get("required")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
            .unwrap_or_default();
        assert!(
            !required.contains(&"timeout_ms"),
            "timeout_ms must stay optional: {required:?}"
        );
    }
}
