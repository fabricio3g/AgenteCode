//! Hosted subagent lifecycle tools: `task`, `task_output`, `kill_task`.
//!
//! These tools are *hosted* by the agent loop: their
//! schema and description are exposed through the normal tool registry, but
//! execution is intercepted in `agent::channel` and routed to the
//! `SubagentHost`. The `execute` implementations below only exist to satisfy
//! the `Tool` trait and never run in practice.

use async_trait::async_trait;

use super::{Tool, ToolError, ToolExecutionMode};

/// The `task` tool. There are no predetermined subagents: the parent model
/// creates each one (role, instructions, tool level, model). The prose is
/// computed once at construction: generating it lazily leaked a fresh
/// `String` on every `description()` call, which the registry performs each
/// loop iteration.
pub struct TaskTool {
    description: String,
    /// The user's own agents (`.agente/agents`), advertised as the
    /// `subagent_type` enum; empty leaves `subagent_type` out of the schema.
    agent_types: Vec<String>,
    /// Names the user lets the orchestrator assign (`model` enum); empty
    /// leaves `model` out of the schema.
    model_names: Vec<String>,
}

impl Default for TaskTool {
    fn default() -> Self {
        Self::with_roster(Vec::new())
    }
}

impl TaskTool {
    /// Build the tool with the user's own agents for its description.
    pub fn with_roster(roster: Vec<crate::subagent::definition::AgentRosterEntry>) -> Self {
        Self {
            description: task_description(&roster),
            agent_types: roster.iter().map(|entry| entry.name.clone()).collect(),
            model_names: Vec::new(),
        }
    }

    /// Offer the user's subagent models: their menu joins the description
    /// and their names (plus `main`) become the `model` enum.
    pub fn with_models(mut self, menu: &[crate::subagent::routing::ModelMenuEntry]) -> Self {
        if menu.is_empty() {
            return self;
        }
        self.description
            .push_str(&crate::subagent::routing::menu_text(menu));
        self.model_names = menu
            .iter()
            .map(|entry| entry.name.clone())
            .chain(std::iter::once(crate::config::MAIN_MODEL.to_string()))
            .collect();
        self
    }
}

fn task_description(roster: &[crate::subagent::definition::AgentRosterEntry]) -> String {
    let mut out = String::from(
        "Create a subagent and hand it a task. There are no predetermined subagents: you design each one for the job.",
    );
    out.push_str(
        " Give it a `role` (who it is, in a few words: \"Security reviewer\", \"Test writer\", \"Docs researcher\"), optional `instructions` (method, standards, what to avoid), a `capability_mode` (\"read-only\" by default; \"read-write\" to edit files, \"execute\" to also run commands, \"all\" to also create its own subagents), and the `prompt` with the task itself.",
    );
    if !roster.is_empty() {
        out.push_str(" The user also wrote agents you can launch by name with `subagent_type` (a `role` then sharpens it):");
        for entry in roster {
            out.push_str(&format!(
                "\n- {} \u{2014} {} (tools: {})",
                entry.name,
                entry.description,
                crate::subagent::definition::roster_tools_summary(&entry.tools),
            ));
        }
    }
    out.push_str(
        " A read-only subagent waits for its result inline by default; one that may change things runs in the background and returns a task_id immediately (`run_in_background` overrides either). Use task_output to fetch a background result and kill_task to cancel one. A background completion with no outstanding poll is pushed to you automatically — do not poll task_output in a loop. If all concurrency slots are busy the spawn queues and returns a pending handle instead of failing.",
    );
    // When to delegate, and what delegation costs. This used to live in the
    // executor system prompt, where it was a fifteen-line paragraph inside
    // "TOOL USAGE" — the mechanics belong to the tool, and the prompt renders
    // this description in full.
    out.push_str(
        " Create read-only subagents for open-ended questions (\"where is X handled\", \"find every caller of Y\", \"how does Z flow\") instead of reading file after file yourself — several independent ones at once when the questions are independent. When subagents write, partition ownership up front — one subagent per area — so their edits never collide, and combine the results yourself. Spawning is not free: every child runs its own model calls, so prefer a flat fan-out over chains (nesting is capped at depth 3).",
    );
    out.push_str(
        " The child starts with a fresh context: it sees ONLY your `prompt`, never the parent conversation. Pack everything it needs into the prompt — exact file paths, prior findings, constraints, and what \"done\" looks like. A prompt like \"fix what we discussed\" will fail.",
    );
    out.push_str(" In Plan mode every child runs with read-only tools.");
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
                "role": {
                    "type": "string",
                    "description": "Who the subagent is, in a few words (\"Security reviewer\", \"Test writer\"). Shown to the user on its card. Defaults to the description."
                },
                "instructions": {
                    "type": "string",
                    "description": "How the subagent should work: method, standards, what to avoid. The task itself goes in `prompt`."
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": "When true, returns immediately with a task_id and pushes the completion automatically; use task_output only to peek at a running result. Defaults to false for a read-only subagent (its result is needed inline) and true for one that may change things."
                },
                "capability_mode": {
                    "type": "string",
                    "enum": ["read-only", "read-write", "execute", "all"],
                    "description": "Which tools the child gets: \"read-only\" (read and search, the default), \"read-write\" (plus edits), \"execute\" (plus shell), \"all\" (plus creating its own subagents). One of the user's agents defaults to its own level."
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
                    "description": "Resume from a previously completed subagent's conversation. Pass the task_id returned by a prior task call. The new subagent continues the previous one's raw transcript with the new task prompt appended. The source must be completed and have the same role."
                }
            },
            "required": ["prompt", "description"]
        });
        if !self.agent_types.is_empty() {
            schema["properties"]["subagent_type"] = serde_json::json!({
                "type": "string",
                "enum": self.agent_types,
                "description": "Launch one of the user's own agents by name instead of creating one."
            });
        }
        if !self.model_names.is_empty() {
            schema["properties"]["model"] = serde_json::json!({
                "type": "string",
                "enum": self.model_names,
                "description": "Which of the user's subagent models runs this child (see the list in the tool description); \"main\" is your own model. Omit to use the user's default. Not allowed with resume_from."
            });
        }
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
    fn spawn_request_defaults_create_a_subagent() {
        // The LLM may omit the optional fields; serde defaults must kick in,
        // and a request that names no role is created from its description.
        let mut req: SubagentSpawnRequest = serde_json::from_value(serde_json::json!({
            "prompt": "explore the codebase",
            "description": "Map the parser",
        }))
        .unwrap();
        req.normalize();
        assert!(req.is_created());
        assert_eq!(req.subagent_type, "");
        assert_eq!(req.role.as_deref(), Some("Map the parser"));
        assert!(req.run_in_background.is_none());
        assert!(
            !req.resolved_run_in_background(),
            "a read-only subagent's answer is needed inline"
        );
        assert!(req.capability_mode.is_none());
        assert!(req.cwd.is_none());
        assert!(req.timeout_ms.is_none());
        assert!(req.resume_from.is_none());
    }

    /// A role alone creates a read-only subagent known by that role; it
    /// waits inline unless it may change things or is told otherwise.
    #[test]
    fn a_role_creates_a_subagent() {
        let mut req: SubagentSpawnRequest = serde_json::from_value(serde_json::json!({
            "prompt": "p", "description": "d", "role": " Security reviewer ", "instructions": ""
        }))
        .unwrap();
        req.normalize();
        assert!(req.is_created());
        assert_eq!(req.role.as_deref(), Some("Security reviewer"));
        assert_eq!(req.instructions, None);
        assert!(!req.resolved_run_in_background());
        req.capability_mode = Some(crate::subagent::types::SubagentCapabilityMode::ReadWrite);
        assert!(req.resolved_run_in_background());
        req.run_in_background = Some(false);
        assert!(!req.resolved_run_in_background());

        let schema = TaskTool::default().parameters();
        assert!(schema["properties"]["role"].is_object());
        assert!(schema["properties"]["instructions"].is_object());
        let desc = TaskTool::default().description().to_string();
        assert!(desc.contains("no predetermined subagents"), "{desc}");
        for preset in ["general-purpose", "\"explore\"", "\"plan\""] {
            assert!(!desc.contains(preset), "{preset} in {desc}");
        }
    }

    /// Models commonly spell the agent argument `type` or `agent`.
    #[test]
    fn subagent_type_accepts_common_aliases() {
        for key in ["type", "agent", "agent_type", "subagent_type"] {
            let mut payload = serde_json::json!({"prompt": "p", "description": "d"});
            payload[key] = serde_json::json!("auditor");
            let req: SubagentSpawnRequest = serde_json::from_value(payload).unwrap();
            assert_eq!(req.subagent_type, "auditor", "alias {key}");
        }
    }

    /// `subagent_type` exists only when the user wrote agents of their own.
    #[test]
    fn subagent_type_lists_only_the_users_agents() {
        let plain = TaskTool::default().parameters();
        assert!(plain["properties"].get("subagent_type").is_none());
        let tool = TaskTool::with_roster(vec![crate::subagent::definition::AgentRosterEntry {
            name: "auditor".into(),
            description: "Audits deps".into(),
            tools: Some(vec!["read_file".into()]),
        }]);
        assert_eq!(
            tool.parameters()["properties"]["subagent_type"]["enum"],
            serde_json::json!(["auditor"])
        );
        assert!(tool.description().contains("- auditor \u{2014} Audits deps"));
    }

    #[test]
    fn model_is_offered_only_with_a_menu() {
        let plain = TaskTool::default();
        assert!(plain.parameters()["properties"].get("model").is_none());
        assert!(!plain.description().contains("Models you can assign"));
        let menu = [crate::subagent::routing::ModelMenuEntry {
            name: "scout".into(),
            price: "free".into(),
            context: 131_072,
            use_for: "Fast searches.".into(),
        }];
        let tool = TaskTool::default().with_models(&menu);
        let names = tool.parameters()["properties"]["model"]["enum"].clone();
        assert_eq!(names, serde_json::json!(["scout", "main"]));
        assert!(tool
            .description()
            .contains("- scout \u{2014} free \u{b7} 131k \u{2014} Fast searches."));
        let req: SubagentSpawnRequest = serde_json::from_value(serde_json::json!({
            "prompt": "p", "description": "d", "model": "scout"
        }))
        .unwrap();
        assert_eq!(req.model.as_deref(), Some("scout"));
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
