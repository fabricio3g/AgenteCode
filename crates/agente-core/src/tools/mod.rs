//! Tool system for agent operations
//!
//! This module provides a modular tool system organized by category:
//! - File operations: read, write, edit, list
//! - Search operations: grep, glob
//! - Execution: shell commands
//! - Task management: todo list

use async_trait::async_trait;
use std::collections::HashMap;
use thiserror::Error;

use crate::types::ToolDefinition;

// Re-export individual tool modules
pub mod atomic_fs;
pub mod edit_match;
pub mod exec;
pub mod file;
mod mutation_queue;
pub mod outline;
mod output;
pub mod patch;
mod path;
pub mod processes;
pub(crate) mod runner;
pub mod search;
pub mod skill;
pub mod subagent;
pub mod task;
pub mod web;

// Re-export tool implementations and shared helpers
pub use exec::ShellTool;
pub use file::{EditFileTool, ListDirTool, ReadFileTool, WriteFileTool};
pub use mutation_queue::{ensure_not_cancelled, with_file_mutation_queue};
pub use outline::FileOutlineTool;
pub use output::{truncate_output, truncate_tool_output, ToolOutput};
pub(crate) use output::{
    MAX_DIR_ENTRIES, MAX_EDIT_FILE_BYTES, MAX_FILE_LINES, MAX_GREP_LINE_LEN, MAX_LINE_BYTES,
    MAX_READ_FILE_BYTES, MAX_SHELL_LINES,
};
use output::{MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES};
pub use patch::ApplyPatchTool;
pub(crate) use path::{canonical_base_cached, comparable_path};
pub use path::{resolve_project_path, resolve_read_path};
pub use runner::{ShellEnv, ToolExecutionContext, ToolOutputStream, ToolProgress};
pub use search::{FindTool, GrepTool};
pub use skill::SkillTool;
pub use subagent::{KillTaskTool, TaskOutputTool, TaskTool};
pub use task::{
    parse_plan_ready_output, plan_file_rel, PresentPlanTool, TodoWriteTool, PLANS_DIR_REL,
};
pub use web::{WebFetchTool, WebSearchTool};

#[derive(Error, Debug)]
pub enum ToolError {
    #[error("Tool execution failed: {0}")]
    ExecutionError(String),
    #[error("Invalid arguments: {0}")]
    InvalidArguments(String),
    #[error("Tool not found: {0}")]
    NotFound(String),
}

/// Behavioral class of a tool. ONE source of truth for everything that used
/// to be name-based match lists: Plan-mode gating, subagent capability
/// filtering, permission rules and the TUI presentation tables all derive
/// from this, so a new tool of an existing kind needs no extra wiring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    /// Reads file contents (`read_file`).
    Read,
    /// Creates files (`write_file`).
    Write,
    /// Modifies existing files (`edit_file`).
    Edit,
    /// Runs commands (`shell`).
    Execute,
    /// Content search (`grep`, `find`).
    Search,
    /// Directory listings (`list_dir`).
    List,
    /// Network fetch/search (`web_fetch`, `web_search`).
    Web,
    /// Session todo list (`todo_write`).
    Todo,
    /// Plan submission (`present_plan`).
    Plan,
    /// Hosted subagent control (`task`, `task_output`, `kill_task`).
    Task,
    /// Anything else (MCP adapters, unknown names).
    Other,
}

impl ToolKind {
    /// Tools that modify project files or run commands. Blocked in Plan mode
    /// and gated by subagent capability modes. Unknown kinds (MCP) are NOT
    /// treated as mutating — matches the historical behavior where only the
    /// three known write tools were gated.
    pub fn mutates_project(self) -> bool {
        matches!(self, Self::Write | Self::Edit | Self::Execute)
    }
}

/// The kind of a tool by NAME, for call sites that only have the string
/// (permission engine, subagent policy filtering, TUI rendering). Tools
/// registered under a known name get their kind here; everything else —
/// notably MCP adapters — falls back to `None` and callers apply their own
/// conservative default.
pub fn known_kind(name: &str) -> Option<ToolKind> {
    Some(match name {
        "read_file" => ToolKind::Read,
        "file_outline" => ToolKind::Read,
        "write_file" => ToolKind::Write,
        "edit_file" | "apply_patch" => ToolKind::Edit,
        "shell" | "process_stop" => ToolKind::Execute,
        "process_list" | "process_output" => ToolKind::Read,
        "grep" | "find" => ToolKind::Search,
        "list_dir" => ToolKind::List,
        "web_search" | "web_fetch" => ToolKind::Web,
        "todo_write" => ToolKind::Todo,
        "present_plan" => ToolKind::Plan,
        "task" | "task_output" | "kill_task" => ToolKind::Task,
        "skill" => ToolKind::Read,
        _ => return None,
    })
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> serde_json::Value;
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }

    /// Client-owned virtual files must never enter host filesystem diagnostics/undo.
    fn uses_host_filesystem(&self) -> bool {
        true
    }

    /// Media produced by a client tool, keyed by its model call ID.
    fn take_result_attachments(&self, _call_id: &str) -> Vec<agente_protocol::Attachment> {
        Vec::new()
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    /// Behavioral class driving mode gating, capability filtering and UI
    /// presentation. Defaults to the conservative catch-all.
    fn kind(&self) -> ToolKind {
        ToolKind::Other
    }

    /// Permission when no rule or config policy decides, in place of the
    /// mode default (Build allows, Plan denies). MCP adapters use it to ask
    /// before tools the server does not mark read-only.
    fn default_permission(
        &self,
        _mode: crate::types::AgentMode,
    ) -> Option<crate::permissions::Permission> {
        None
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        project_dir: &str,
    ) -> Result<String, ToolError>;

    /// Context-aware execution path. Existing tools only need to implement
    /// [`Tool::execute`]; this default wrapper drops an ordinary tool future as
    /// soon as its invocation is cancelled.
    async fn execute_with_context(
        &self,
        args: serde_json::Value,
        project_dir: &str,
        context: ToolExecutionContext,
    ) -> Result<String, ToolError> {
        runner::run_with_heartbeat(&context, self.execute(args, project_dir)).await
    }
}

/// Args type bound for the typed tool path: deserialization from the
/// model-provided JSON plus a schema generated free from the struct
/// (schemars, doc comments become field descriptions).
pub trait ToolArgs: serde::de::DeserializeOwned + schemars::JsonSchema + Send {}
impl<T> ToolArgs for T where T: serde::de::DeserializeOwned + schemars::JsonSchema + Send {}

/// The typed authoring path. Implement this — with an
/// args struct whose doc comments document the schema — and `register_typed`
/// handles schema generation, argument parsing, cancellation and truncation.
pub trait ToolCore: Send + Sync + 'static {
    type Args: ToolArgs;
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn kind(&self) -> ToolKind {
        ToolKind::Other
    }
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }
    fn allowed_in_plan(&self) -> bool {
        true
    }
    // Declared RPITIT-style with an explicit Send bound (implementers write
    // a plain `async fn run`) so the adapter's futures stay Send.
    fn run(
        &self,
        args: Self::Args,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> impl std::future::Future<Output = Result<String, ToolError>> + Send;
}

/// Bridges a [`ToolCore`] into the object-safe [`Tool`] trait: schema from
/// the args type, JSON args parsed into it once, then typed `run`.
pub struct TypedTool<C: ToolCore>(C);

impl<C: ToolCore> TypedTool<C> {
    /// Wrap a typed tool core. The field is private, so this is the only way
    /// for other modules (notably their test blocks) to build one.
    pub fn new(core: C) -> Self {
        TypedTool(core)
    }

    pub fn boxed() -> Box<dyn Tool>
    where
        C: Default,
    {
        Box::new(TypedTool(C::default()))
    }
}

/// Drop JSON-Schema document furniture from a tool schema.
///
/// `schemars` emits `$schema` and a `title` per struct and per field. Neither
/// tells a model anything it needs to call the tool, and every byte rides in
/// the request prefix of every turn — on a twenty-tool registry that is
/// thousands of tokens of pure boilerplate. Types, descriptions, properties,
/// required lists and enums are untouched.
pub(crate) fn compact_schema(value: serde_json::Value) -> serde_json::Value {
    compact_schema_at(value, false)
}

/// `property_names` is true for the map whose *keys* are argument names
/// (`properties`, `$defs`, `definitions`): a tool argument may legitimately be
/// called `title`, and its name is not schema furniture.
fn compact_schema_at(value: serde_json::Value, property_names: bool) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .filter(|(key, _)| property_names || (key != "$schema" && key != "title"))
                .map(|(key, child)| {
                    let names = matches!(key.as_str(), "properties" | "$defs" | "definitions");
                    (key, compact_schema_at(child, names))
                })
                .collect(),
        ),
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .into_iter()
                .map(|item| compact_schema_at(item, false))
                .collect(),
        ),
        other => other,
    }
}

#[async_trait]
impl<C: ToolCore> Tool for TypedTool<C> {
    fn name(&self) -> &str {
        self.0.name()
    }

    fn description(&self) -> &str {
        self.0.description()
    }

    fn parameters(&self) -> serde_json::Value {
        compact_schema(
            serde_json::to_value(schemars::schema_for!(C::Args)).unwrap_or(serde_json::json!({
                "type": "object"
            })),
        )
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        self.0.execution_mode()
    }

    fn allowed_in_plan(&self) -> bool {
        self.0.allowed_in_plan()
    }

    fn kind(&self) -> ToolKind {
        self.0.kind()
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        project_dir: &str,
    ) -> Result<String, ToolError> {
        let parsed: C::Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArguments(format!("Invalid arguments: {e}")))?;
        self.0
            .run(parsed, project_dir, &ToolExecutionContext::default())
            .await
    }

    async fn execute_with_context(
        &self,
        args: serde_json::Value,
        project_dir: &str,
        context: ToolExecutionContext,
    ) -> Result<String, ToolError> {
        if context.cancellation.is_aborted() {
            return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
        }
        let parsed: C::Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArguments(format!("Invalid arguments: {e}")))?;
        runner::run_with_heartbeat(&context, self.0.run(parsed, project_dir, &context)).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ToolExecutionMode {
    Parallel,
    Sequential,
}

pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn Tool>>,
    project_dir: String,
    /// Stamped onto every call's context (see [`ShellEnv`]).
    shell_env: ShellEnv,
    /// Active subagent tool policy (including board `owns` path scope).
    tool_policy: Option<crate::subagent::ToolPolicy>,
}

impl ToolRegistry {
    pub fn new(project_dir: impl Into<String>) -> Self {
        let project_dir = project_dir.into();
        let agents = crate::subagent::definition::custom_subagents(&project_dir);
        Self::with_agents(project_dir, &agents)
    }

    /// Build a registry from an already-loaded roster. Children use this so a
    /// fresh worktree checkout does not re-scan `.agente/agents` on disk.
    pub fn with_agents(
        project_dir: impl Into<String>,
        agents: &[crate::subagent::AgentDefinition],
    ) -> Self {
        let mut registry = Self {
            tools: HashMap::new(),
            project_dir: project_dir.into(),
            shell_env: ShellEnv::Inherit,
            tool_policy: None,
        };
        registry.register_typed::<ShellTool>();
        registry.register_typed::<processes::ProcessListTool>();
        registry.register_typed::<processes::ProcessOutputTool>();
        registry.register_typed::<processes::ProcessStopTool>();
        registry.register_typed::<ReadFileTool>();
        registry.register_typed::<WriteFileTool>();
        registry.register_typed::<EditFileTool>();
        registry.register_typed::<ApplyPatchTool>();
        registry.register_typed::<ListDirTool>();
        registry.register_typed::<FileOutlineTool>();
        registry.register_typed::<GrepTool>();
        registry.register_typed::<FindTool>();
        registry.register_typed::<TodoWriteTool>();
        registry.register_typed::<PresentPlanTool>();
        registry.register_typed::<WebFetchTool>();
        registry.register_typed::<WebSearchTool>();
        registry.register(Box::new(TaskTool::with_roster(
            crate::subagent::definition::agent_roster(agents),
        )));
        registry.register(Box::new(TaskOutputTool));
        registry.register(Box::new(KillTaskTool));
        if let Some(skills) =
            SkillTool::new(crate::extensions::skills::discover(&registry.project_dir))
        {
            registry.register(Box::new(skills));
        }
        registry
    }

    /// Offer the user's subagent models on the `task` and `board` tools (rebuilt
    /// from the same roster, so descriptions stay byte-stable per list).
    pub fn offer_subagent_models(
        &mut self,
        agents: &[crate::subagent::AgentDefinition],
        menu: &[crate::subagent::routing::ModelMenuEntry],
    ) {
        if menu.is_empty() {
            return;
        }
        if self.tools.contains_key("task") {
            self.register(Box::new(
                TaskTool::with_roster(crate::subagent::definition::agent_roster(agents))
                    .with_models(menu),
            ));
        }
        if self.tools.contains_key("board") {
            self.register(Box::new(crate::swarm::BoardTool::with_models(menu)));
        }
    }

    /// Register a typed tool: schema comes from the
    /// args struct, arguments are parsed into it before `run`.
    pub fn register_typed<C>(&mut self)
    where
        C: ToolCore + Default,
    {
        self.register(TypedTool::<C>::boxed());
    }

    /// Register pre-built MCP tool adapters.
    pub fn register_mcp_adapters(&mut self, adapters: Vec<Box<dyn Tool>>) {
        for adapter in adapters {
            self.register(adapter);
        }
    }

    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn project_dir(&self) -> &str {
        &self.project_dir
    }

    pub fn get(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.get(name).map(|t| t.as_ref())
    }

    /// Registered tool names, sorted.
    pub fn names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.tools.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    /// Tool definitions, sorted by name.
    ///
    /// The order is part of every request's cached prefix: `tools` is a
    /// `HashMap` with a per-instance random seed and a registry is rebuilt
    /// each turn, so an unsorted list reshuffled the tools on every turn and
    /// broke prompt caching on every provider.
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut defs: Vec<ToolDefinition> = self
            .tools
            .values()
            .map(|t| ToolDefinition {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters(),
            })
            .collect();
        defs.sort_by(|a, b| a.name.cmp(&b.name));
        defs
    }

    /// Get tool definitions filtered by agent mode.
    /// Plan mode only allows non-mutating tools (kind-derived, see
    /// [`ToolKind::mutates_project`]).
    /// Sorted by name for the same prompt-cache reason as [`Self::definitions`].
    pub fn definitions_for_mode(&self, mode: crate::types::AgentMode) -> Vec<ToolDefinition> {
        let mut defs: Vec<ToolDefinition> = self
            .tools
            .values()
            .filter(|t| match mode {
                crate::types::AgentMode::Plan => {
                    // Plan mode: read-only tools only
                    !t.kind().mutates_project() && t.allowed_in_plan()
                }
                crate::types::AgentMode::Build => true,
            })
            .map(|t| ToolDefinition {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters(),
            })
            .collect();
        defs.sort_by(|a, b| a.name.cmp(&b.name));
        defs
    }

    /// Check if a tool is allowed in the given mode
    pub fn is_allowed_in_mode(&self, name: &str, mode: crate::types::AgentMode) -> bool {
        match mode {
            crate::types::AgentMode::Plan => self
                .tools
                .get(name)
                .map(|t| !t.kind().mutates_project() && t.allowed_in_plan())
                .unwrap_or(false),
            crate::types::AgentMode::Build => self.tools.contains_key(name),
        }
    }

    pub async fn execute(&self, name: &str, args: serde_json::Value) -> Result<String, ToolError> {
        self.execute_with_context(name, args, ToolExecutionContext::default())
            .await
    }

    pub async fn execute_with_context(
        &self,
        name: &str,
        args: serde_json::Value,
        context: ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| ToolError::NotFound(name.to_string()))?;
        if let Some(policy) = &self.tool_policy {
            let normalized = crate::agent::channel::args::normalize_tool_args(name, args.clone());
            if let Err(reason) = policy.check_tool_call(name, &normalized, &self.project_dir) {
                return Err(ToolError::ExecutionError(reason));
            }
        }
        let context = context.with_shell_env(self.shell_env.clone());
        let result = tool
            .execute_with_context(args, &self.project_dir, context)
            .await?;
        let output = truncate_output(&result);
        if output.truncated {
            Ok(format!(
                "{}\n[Output truncated to {} lines / {}KB]",
                output.content,
                MAX_OUTPUT_LINES,
                MAX_OUTPUT_BYTES / 1024
            ))
        } else {
            Ok(output.content)
        }
    }

    pub fn is_sequential(&self, name: &str) -> bool {
        self.tools
            .get(name)
            .map(|t| t.execution_mode() == ToolExecutionMode::Sequential)
            .unwrap_or(false)
    }

    /// Drop every tool whose name is not in `names`. Used by the subagent host
    /// to enforce capability/allowlist gating at the registry level, so a child
    /// can never call an out-of-scope tool even if the model hallucinates one.
    pub fn retain_named(&mut self, names: &[&str]) {
        self.tools.retain(|name, _| names.contains(&name.as_str()));
    }

    /// The environment the commands this turn's tools start get.
    pub fn set_shell_env(&mut self, shell_env: ShellEnv) {
        self.shell_env = shell_env;
    }

    /// Attach a subagent [`crate::subagent::ToolPolicy`] (including board `owns`
    /// path scope) so mutating file calls are validated against owned paths.
    pub fn set_tool_policy(&mut self, policy: crate::subagent::ToolPolicy) {
        self.tool_policy = Some(policy);
    }

    pub fn tool_policy(&self) -> Option<&crate::subagent::ToolPolicy> {
        self.tool_policy.as_ref()
    }
}

#[cfg(test)]
mod typed_path_tests {
    use super::*;

    #[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
    struct EchoArgs {
        /// Text to echo back.
        text: String,
        /// How many times to repeat it.
        #[serde(default)]
        times: u32,
    }

    #[derive(Debug, Default)]
    struct EchoTool;

    impl ToolCore for EchoTool {
        type Args = EchoArgs;

        fn name(&self) -> &str {
            "echo_test"
        }

        fn description(&self) -> &str {
            "Echo the given text."
        }

        fn kind(&self) -> ToolKind {
            ToolKind::Other
        }

        async fn run(
            &self,
            args: EchoArgs,
            _project_dir: &str,
            _context: &ToolExecutionContext,
        ) -> Result<String, ToolError> {
            Ok(args.text.repeat(args.times.max(1) as usize))
        }
    }

    #[tokio::test]
    async fn typed_tool_schema_comes_from_the_args_struct() {
        let adapter = TypedTool::new(EchoTool);
        let schema = Tool::parameters(&adapter);
        let text = schema["properties"]["text"]["description"]
            .as_str()
            .expect("doc comment became description");
        assert_eq!(text, "Text to echo back.");
        assert_eq!(schema["properties"]["times"]["type"], "integer");
    }

    #[tokio::test]
    async fn typed_tool_parses_and_runs() {
        let adapter = TypedTool::new(EchoTool);
        let out = adapter
            .execute(serde_json::json!({"text": "hi", "times": 3}), "/tmp")
            .await
            .unwrap();
        assert_eq!(out, "hihihi");
        let err = adapter
            .execute(serde_json::json!({"nope": true}), "/tmp")
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidArguments(_)));
    }

    #[tokio::test]
    async fn register_typed_places_a_working_tool() {
        let mut registry = ToolRegistry::new("/tmp");
        registry.register_typed::<EchoTool>();
        assert!(registry.is_allowed_in_mode("echo_test", crate::types::AgentMode::Build));
        let out = registry
            .execute("echo_test", serde_json::json!({"text": "ok"}))
            .await
            .unwrap();
        assert_eq!(out, "ok");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schemas_drop_document_furniture_but_keep_the_contract() {
        let schema = compact_schema(serde_json::json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Args",
            "type": "object",
            "properties": {
                "path": {
                    "title": "Path",
                    "description": "File to read",
                    "type": "string"
                },
                "mode": { "enum": ["fast", "thorough"] },
                "title": {
                    "title": "Title",
                    "description": "Short plan title",
                    "type": "string"
                }
            },
            "required": ["path"]
        }));
        let text = serde_json::to_string(&schema).unwrap();
        assert!(!text.contains("$schema"), "{text}");
        assert_eq!(schema["properties"]["path"]["description"], "File to read");
        assert_eq!(schema["properties"]["path"]["type"], "string");
        assert_eq!(schema["properties"]["mode"]["enum"][0], "fast");
        assert_eq!(
            schema["properties"]["title"]["description"],
            "Short plan title"
        );
        assert!(schema["properties"]["title"].get("title").is_none());
        assert_eq!(schema["required"][0], "path");
        assert_eq!(schema["type"], "object");
    }

    #[test]
    fn every_registered_tool_schema_is_compact() {
        fn furniture(value: &serde_json::Value, property_names: bool) -> Option<&'static str> {
            match value {
                serde_json::Value::Object(map) => {
                    if map.contains_key("$schema") {
                        return Some("$schema");
                    }
                    if !property_names && map.contains_key("title") {
                        return Some("title");
                    }
                    map.iter().find_map(|(key, child)| {
                        let names = matches!(key.as_str(), "properties" | "$defs" | "definitions");
                        furniture(child, names)
                    })
                }
                serde_json::Value::Array(items) => {
                    items.iter().find_map(|item| furniture(item, false))
                }
                _ => None,
            }
        }

        let registry = ToolRegistry::new("/tmp");
        let defs = registry.definitions();
        assert!(!defs.is_empty());
        for def in &defs {
            assert_eq!(
                furniture(&def.parameters, false),
                None,
                "{} carries schema boilerplate: {}",
                def.name,
                def.parameters
            );
            assert_eq!(
                def.parameters["type"], "object",
                "{} lost its object type",
                def.name
            );
        }
        let read_file = defs
            .iter()
            .find(|def| def.name == "read_file")
            .expect("read_file is registered");
        assert_eq!(read_file.parameters["properties"]["path"]["type"], "string");
        assert_eq!(read_file.parameters["required"][0], "path");
    }

    #[test]
    fn test_tool_error_display() {
        let err = ToolError::NotFound("test_tool".to_string());
        assert!(err.to_string().contains("test_tool"));
    }

    struct BuildOnlyTool;

    #[async_trait::async_trait]
    impl Tool for BuildOnlyTool {
        fn name(&self) -> &str {
            "build_only"
        }

        fn description(&self) -> &str {
            "Build-only test tool"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }

        fn allowed_in_plan(&self) -> bool {
            false
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _project_dir: &str,
        ) -> Result<String, ToolError> {
            Ok("ok".to_string())
        }
    }

    #[test]
    fn test_mode_filtered_tool_access() {
        let mut registry = ToolRegistry::new(".");
        registry.register(Box::new(BuildOnlyTool));

        assert!(!registry.is_allowed_in_mode("write_file", crate::types::AgentMode::Plan));
        assert!(!registry.is_allowed_in_mode("build_only", crate::types::AgentMode::Plan));
        assert!(registry.is_allowed_in_mode("build_only", crate::types::AgentMode::Build));
        assert!(!registry.is_allowed_in_mode("missing_tool", crate::types::AgentMode::Build));
    }

    struct SlowTool;

    #[async_trait::async_trait]
    impl Tool for SlowTool {
        fn name(&self) -> &str {
            "slow"
        }

        fn description(&self) -> &str {
            "Slow test tool"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _project_dir: &str,
        ) -> Result<String, ToolError> {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            Ok("finished".into())
        }
    }

    #[tokio::test]
    async fn context_cancels_ordinary_tool_futures() {
        let mut registry = ToolRegistry::new(".");
        registry.register(Box::new(SlowTool));
        let controller = crate::cancellation::AbortController::new();
        let signal = controller.signal();
        let task = tokio::spawn(async move {
            registry
                .execute_with_context(
                    "slow",
                    serde_json::json!({}),
                    ToolExecutionContext::new(signal),
                )
                .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        controller.abort();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .expect("cancelled tool should return promptly")
            .expect("tool task should not panic");
        assert!(result.unwrap_err().to_string().contains("cancelled"));
    }

    #[test]
    fn edit_matching_finds_an_exact_replacement() {
        let content = "hello world";
        let found = match crate::tools::edit_match::locate(content, "world", None) {
            crate::tools::edit_match::EditMatch::Found(found) => found,
            other => panic!("expected a match, got {other:?}"),
        };
        assert_eq!(found.range, 6..11);
        assert!(found.level.is_exact());
    }

    #[test]
    fn edit_matching_folds_smart_quotes_without_guessing_bytes() {
        let content = "say \u{201C}hello\u{201D} world";
        let found = match crate::tools::edit_match::locate(content, "say \"hello\"", None) {
            crate::tools::edit_match::EditMatch::Found(found) => found,
            other => panic!("expected a normalized match, got {other:?}"),
        };
        assert_eq!(
            found.level,
            crate::tools::edit_match::MatchLevel::Normalized
        );
        let updated = crate::tools::edit_match::apply(content, found.range, "say \"goodbye\"");
        assert_eq!(updated, "say \"goodbye\" world");
    }

    #[test]
    fn plan_mode_tools_pass_the_permission_engine() {
        use crate::permissions::{Permission, PermissionEngine, ToolFsFacts};
        use crate::types::AgentMode;
        let registry = ToolRegistry::new(".");
        let engine = PermissionEngine::new(AgentMode::Plan);
        let args = serde_json::json!({});
        let denied: Vec<String> = registry
            .definitions_for_mode(AgentMode::Plan)
            .into_iter()
            .map(|definition| definition.name)
            .filter(|name| {
                let tool_default = registry
                    .get(name)
                    .and_then(|tool| tool.default_permission(AgentMode::Plan));
                engine.check_tool_with_default(name, &args, &ToolFsFacts::default(), tool_default)
                    == Permission::Deny
            })
            .collect();
        assert!(
            denied.is_empty(),
            "offered in Plan mode but denied: {denied:?}"
        );
    }

    #[tokio::test]
    async fn file_outline_registered_and_allowed_in_plan() {
        let registry = ToolRegistry::new(".");
        assert!(registry.is_allowed_in_mode("file_outline", crate::types::AgentMode::Plan));
        assert!(registry.is_allowed_in_mode("file_outline", crate::types::AgentMode::Build));

        let temp_dir = std::env::temp_dir().join(format!("outline-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir).await.unwrap();
        let test_file = temp_dir.join("sample.rs");
        tokio::fs::write(
            &test_file,
            "pub struct Model;\nimpl Model {\n    pub fn run() {}\n}\n",
        )
        .await
        .unwrap();

        let reg = ToolRegistry::new(&*temp_dir.to_string_lossy());
        let res = reg
            .execute("file_outline", serde_json::json!({"path": "sample.rs"}))
            .await
            .unwrap();

        assert!(res.contains("pub struct Model"));
        assert!(res.contains("impl Model"));
        assert!(res.contains("pub fn run()"));

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn apply_patch_registered_and_modifies_file() {
        let registry = ToolRegistry::new(".");
        assert!(!registry.is_allowed_in_mode("apply_patch", crate::types::AgentMode::Plan));
        assert!(registry.is_allowed_in_mode("apply_patch", crate::types::AgentMode::Build));

        let temp_dir = std::env::temp_dir().join(format!("patch-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir).await.unwrap();
        let target_file = temp_dir.join("lib.rs");
        tokio::fs::write(&target_file, "fn start() {\n    init();\n}\n")
            .await
            .unwrap();

        let patch_content = "--- a/lib.rs\n+++ b/lib.rs\n@@ -1,3 +1,4 @@\n fn start() {\n+    setup();\n     init();\n }\n";

        let reg = ToolRegistry::new(&*temp_dir.to_string_lossy());
        let _ = reg
            .execute("read_file", serde_json::json!({"path": "lib.rs"}))
            .await
            .unwrap();
        let res = reg
            .execute("apply_patch", serde_json::json!({"patch": patch_content}))
            .await
            .unwrap();

        assert!(res.contains("Successfully applied patch"));
        let updated = tokio::fs::read_to_string(&target_file).await.unwrap();
        assert!(updated.contains("setup();"));
        assert!(updated.contains("init();"));

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn tool_arg_aliases_deserialized_properly() {
        let temp_dir = std::env::temp_dir().join(format!("alias-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir).await.unwrap();
        let reg = ToolRegistry::new(&*temp_dir.to_string_lossy());

        reg.execute(
            "write_file",
            serde_json::json!({"file_path": "alias.txt", "contents": "hello from alias"}),
        )
        .await
        .unwrap();

        let content = reg
            .execute("read_file", serde_json::json!({"file": "alias.txt"}))
            .await
            .unwrap();
        assert!(content.contains("hello from alias"));

        reg.execute(
            "edit_file",
            serde_json::json!({
                "filepath": "alias.txt",
                "query": "hello",
                "replacement": "world"
            }),
        )
        .await
        .unwrap();

        let updated = reg
            .execute("read_file", serde_json::json!({"path": "alias.txt"}))
            .await
            .unwrap();
        assert!(updated.contains("world from alias"));

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
}

#[cfg(test)]
mod ordering_tests {
    use super::ToolRegistry;

    fn names(defs: Vec<crate::types::ToolDefinition>) -> Vec<String> {
        defs.into_iter().map(|d| d.name).collect()
    }

    #[test]
    fn tool_order_is_identical_across_registries() {
        let first = names(ToolRegistry::new("/tmp/order").definitions());
        for _ in 0..8 {
            assert_eq!(names(ToolRegistry::new("/tmp/order").definitions()), first);
        }
        assert!(first.windows(2).all(|w| w[0] <= w[1]), "sorted: {first:?}");
        let plan = names(
            ToolRegistry::new("/tmp/order").definitions_for_mode(crate::types::AgentMode::Plan),
        );
        assert!(plan.windows(2).all(|w| w[0] <= w[1]), "sorted: {plan:?}");
    }
}
