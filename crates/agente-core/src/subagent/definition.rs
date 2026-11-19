//! Subagent definitions, effective-config resolution, and capability-based
//! tool filtering.
//!
//! There are no predetermined subagents: the parent model creates each one
//! for its task — a role, optional instructions, a tool level and a model
//! from the user's list — on the base prompt bundled as
//! `crates/agente-core/agents/_role.md`. Agents the user writes themselves
//! (`.agente/agents/*.md`) can still be spawned by name.
//!
//! Resolution precedence:
//! explicit spawn-time override > the user's agent file > parent defaults.
//! The model is routed separately (`subagent::routing`).

use crate::extensions::AgentProfile;
use crate::types::ToolDefinition;

use super::types::{SubagentCapabilityMode, SubagentSpawnRequest};

/// Default nesting depth for subagents (parent = depth 0).
pub const DEFAULT_MAX_SUBAGENT_DEPTH: u32 = 3;
/// Default max concurrently running subagents per session.
pub use crate::config::DEFAULT_MAX_CONCURRENT_SUBAGENTS;
/// Default wall-clock budget per spawn. A stuck child (silent provider stall,
/// runaway tool loop inside its iteration budget) is aborted and reported as
/// a timeout failure with its partial transcript kept for `resume_from`.
pub const DEFAULT_SUBAGENT_TIMEOUT_MS: u64 = 600_000;

/// Resolve the effective wall-clock timeout: explicit positive values win,
/// anything else (absent or zero) falls back to the default.
pub fn resolve_timeout_ms(requested: Option<u64>) -> u64 {
    match requested {
        Some(ms) if ms > 0 => ms,
        _ => DEFAULT_SUBAGENT_TIMEOUT_MS,
    }
}

/// An agent the user wrote in `.agente/agents`, spawnable by name.
#[derive(Debug, Clone)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub prompt: String,
    /// Tool allowlist; `None` means all tools.
    pub tools: Option<Vec<String>>,
    /// Explicit capability ceiling from the agent file's `capability:`
    /// frontmatter. `None` = derive from the tool allowlist.
    pub capability: Option<SubagentCapabilityMode>,
    /// `hidden: true` frontmatter: excluded from the advertised roster (the
    /// model won't discover it) while direct spawns by name keep working.
    pub hidden: bool,
    /// `model:` frontmatter (a model list name, `provider/model`, or `main`):
    /// a preference the router weighs below the parent's pick.
    pub model: Option<String>,
}

impl AgentDefinition {
    fn from_profile(p: AgentProfile) -> Self {
        Self {
            capability: p.capability.as_deref().and_then(parse_capability),
            tools: (!p.tools.is_empty()).then_some(p.tools),
            name: p.name,
            description: p.description,
            prompt: p.prompt,
            hidden: p.hidden,
            model: p.model,
        }
    }

    /// The capability this agent runs with when the spawn names none.
    pub fn default_capability(&self) -> SubagentCapabilityMode {
        custom_capability(self.tools.as_deref(), self.capability)
    }
}

/// Parse a loose capability string from agent frontmatter. Accepts the serde
/// kebab forms plus common spellings; unknown values fall back to `None`
/// (derived capability) instead of failing the whole agent file.
pub fn parse_capability(raw: &str) -> Option<SubagentCapabilityMode> {
    let normalized = raw.trim().to_lowercase().replace('_', "-");
    match normalized.as_str() {
        "read-only" | "readonly" | "read" => Some(SubagentCapabilityMode::ReadOnly),
        "read-write" | "readwrite" | "write" => Some(SubagentCapabilityMode::ReadWrite),
        "execute" => Some(SubagentCapabilityMode::Execute),
        "all" => Some(SubagentCapabilityMode::All),
        _ => None,
    }
}

/// The base prompt of a subagent the parent creates from a role:
/// `{role}` and `{instructions}` are filled in per spawn.
const ROLE_FILE: &str = include_str!("../../agents/_role.md");

/// The system prompt of a created subagent.
fn role_prompt(role: &str, instructions: Option<&str>) -> String {
    let (_, body) = crate::extensions::split_frontmatter(ROLE_FILE);
    body.trim()
        .replace("{role}", role)
        .replace("{instructions}", instructions.unwrap_or(""))
        .replace("\n\n\n\n", "\n\n")
}

/// Agents discovered in `.agente/agents/*.md` (user dirs, then the project).
pub fn custom_subagents(project_dir: &str) -> Vec<AgentDefinition> {
    crate::extensions::discover_agents(project_dir)
        .into_iter()
        .map(AgentDefinition::from_profile)
        .collect()
}

/// Look one of the user's agents up by name.
pub fn find_agent<'a>(name: &str, custom: &'a [AgentDefinition]) -> Option<&'a AgentDefinition> {
    custom.iter().find(|c| c.name == name)
}

/// Default capability for a custom agent, derived from its tool allowlist.
/// An explicit `capability:` frontmatter value wins over the derivation.
pub fn custom_capability(
    tools: Option<&[String]>,
    explicit: Option<SubagentCapabilityMode>,
) -> SubagentCapabilityMode {
    if let Some(capability) = explicit {
        return capability;
    }
    match tools {
        None => SubagentCapabilityMode::All,
        Some(list) => {
            let has_shell = list.iter().any(|t| t == "shell");
            let all_read_only = list.iter().all(|t| {
                is_read_only_tool(t) || matches!(t.as_str(), "todo_write" | "present_plan")
            });
            if has_shell {
                SubagentCapabilityMode::Execute
            } else if all_read_only {
                SubagentCapabilityMode::ReadOnly
            } else {
                SubagentCapabilityMode::ReadWrite
            }
        }
    }
}

/// One entry of the agent roster the `task` tool advertises to the model.
#[derive(Debug, Clone)]
pub struct AgentRosterEntry {
    pub name: String,
    pub description: String,
    pub tools: Option<Vec<String>>,
}

/// The user's own agents the `task` tool advertises (hidden ones stay
/// spawnable by name but are not listed). Empty for most users: the parent
/// creates its subagents.
///
/// Takes an already-loaded list: children reuse the parent's roster so a
/// worktree checkout does not re-scan `.agente/agents`.
pub fn agent_roster(custom: &[AgentDefinition]) -> Vec<AgentRosterEntry> {
    custom
        .iter()
        .filter(|agent| !agent.hidden)
        .map(|agent| AgentRosterEntry {
            name: agent.name.clone(),
            description: agent.description.clone(),
            tools: agent.tools.clone(),
        })
        .collect()
}

/// Human/model-facing summary of an agent's toolset for the roster.
pub fn roster_tools_summary(tools: &Option<Vec<String>>) -> String {
    match tools {
        None => "all tools".to_string(),
        Some(list) if list.is_empty() => "all tools".to_string(),
        Some(list) => {
            // Read-only capability is the routing signal a parent needs most:
            // it can fan research children out without collision risk.
            if list.iter().all(|t| is_read_only_tool(t)) {
                format!("read-only: {}", list.join(", "))
            } else {
                list.join(", ")
            }
        }
    }
}

/// Parent defaults a child inherits when the spawn request omits a value.
#[derive(Debug, Clone)]
pub struct SubagentParentDefaults {
    pub model: String,
    pub project_dir: String,
}

/// Fully resolved configuration for a child agent run.
#[derive(Debug, Clone)]
pub struct EffectiveRuntimeConfig {
    pub subagent_type: String,
    pub system_prompt: String,
    /// Tool allowlist; `None` means all tools (subject to capability mode).
    pub tools: Option<Vec<String>>,
    pub capability: SubagentCapabilityMode,
    pub model: Option<String>,
    /// Provider for `model` when a subagent-model override applies; `None`
    /// runs on the parent's provider.
    pub provider: Option<String>,
    /// Thinking level the override asked for; `None` inherits the parent's.
    pub thinking_level: Option<String>,
    pub cwd: Option<String>,
    /// The agent file's `model:` preference, for the router.
    pub agent_model: Option<String>,
}

/// Resolve the effective runtime config for a spawn request.
///
/// Precedence: explicit override > agent definition > parent defaults. The
/// model is the parent's here; `SubagentHost::spawn` routes it afterwards
/// (`subagent::routing::resolve_model`), weighing `agent_model`.
pub fn resolve_effective_config(
    request: &SubagentSpawnRequest,
    parent: &SubagentParentDefaults,
    custom: &[AgentDefinition],
) -> Result<EffectiveRuntimeConfig, String> {
    // Validate cwd eagerly (exists + is a directory) at spawn time.
    if let Some(cwd) = request.cwd.as_deref() {
        let p = std::path::Path::new(cwd);
        if !p.exists() {
            return Err(format!("Subagent cwd does not exist: {cwd}"));
        }
        if !p.is_dir() {
            return Err(format!("Subagent cwd is not a directory: {cwd}"));
        }
    }

    let cwd = request
        .cwd
        .clone()
        .or_else(|| Some(parent.project_dir.clone()));

    // The usual case: the parent created this subagent. The role base
    // prompt, no tool allowlist, read-only unless the parent asked for more.
    if request.is_created() {
        let role = request.role.as_deref().unwrap_or("Subagent");
        return Ok(EffectiveRuntimeConfig {
            subagent_type: role.to_string(),
            system_prompt: role_prompt(role, request.instructions.as_deref()),
            tools: None,
            capability: request
                .capability_mode
                .unwrap_or(SubagentCapabilityMode::ReadOnly),
            model: Some(parent.model.clone()),
            provider: None,
            thinking_level: None,
            cwd,
            agent_model: None,
        });
    }

    // One of the user's own agent files, named by `subagent_type`.
    let agent = find_agent(&request.subagent_type, custom).ok_or_else(|| {
        let mut message = format!(
            "Unknown agent '{}'. Create the subagent instead: pass `role` (and `instructions`, `capability_mode`, `model`).",
            request.subagent_type
        );
        if !custom.is_empty() {
            let names: Vec<&str> = custom.iter().map(|c| c.name.as_str()).collect();
            message.push_str(&format!(" The user's agents: {}.", names.join(", ")));
        }
        message
    })?;
    let capability = request
        .capability_mode
        .unwrap_or_else(|| agent.default_capability());
    // A role on the user's agent sharpens it: its prompt, then the role.
    let system_prompt = match request.role.as_deref() {
        Some(role) => format!(
            "{}\n\nFor this task your role is: {role}.{}",
            agent.prompt,
            request
                .instructions
                .as_deref()
                .map(|text| format!("\n{text}"))
                .unwrap_or_default()
        ),
        None => agent.prompt.clone(),
    };

    Ok(EffectiveRuntimeConfig {
        subagent_type: request.subagent_type.clone(),
        system_prompt,
        tools: agent.tools.clone(),
        capability,
        model: Some(parent.model.clone()),
        provider: None,
        thinking_level: None,
        cwd,
        agent_model: agent.model.clone(),
    })
}

/// Capability a child actually runs with under the given parent mode.
///
/// Plan-mode parents may only run read-only children (Plan mode forbids
/// mutations, including via delegation). Coerce instead of rejecting, so a
/// writer the parent creates still runs — read-only — rather than making
/// `task` look unavailable in Plan mode. The child-registry prune enforces the invariant regardless of
/// the requested type. Returns the effective capability plus whether a
/// coercion happened (surfaced to the model in the spawn result).
pub fn capability_for_parent_mode(
    parent_mode: crate::types::AgentMode,
    requested: SubagentCapabilityMode,
) -> (SubagentCapabilityMode, bool) {
    if parent_mode == crate::types::AgentMode::Plan && requested != SubagentCapabilityMode::ReadOnly
    {
        (SubagentCapabilityMode::ReadOnly, true)
    } else {
        (requested, false)
    }
}

/// Tool classes by capability mode. Read-only tools are always allowed;
/// mutating classes are gated progressively.
pub fn is_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        "read_file"
            | "file_outline"
            | "list_dir"
            | "grep"
            | "find"
            | "web_search"
            | "web_fetch"
            | "skill"
    )
}

/// Tools that require full capability (spawning nested subagents).
pub fn is_hosted_tool(name: &str) -> bool {
    matches!(name, "task" | "task_output" | "kill_task" | "board")
}

/// True when a tool name is allowed for the given capability mode.
pub fn tool_allowed_by_capability(name: &str, capability: SubagentCapabilityMode) -> bool {
    use crate::tools::ToolKind;
    if is_read_only_tool(name) || matches!(name, "todo_write" | "present_plan") {
        return true;
    }
    if is_hosted_tool(name) {
        return capability == SubagentCapabilityMode::All;
    }
    match crate::tools::known_kind(name) {
        Some(ToolKind::Write | ToolKind::Edit) => matches!(
            capability,
            SubagentCapabilityMode::ReadWrite
                | SubagentCapabilityMode::Execute
                | SubagentCapabilityMode::All
        ),
        Some(ToolKind::Execute) => matches!(
            capability,
            SubagentCapabilityMode::Execute | SubagentCapabilityMode::All
        ),
        // Unknown tools (e.g. MCP adapters) require full capability.
        _ => capability == SubagentCapabilityMode::All,
    }
}

/// Filter tool definitions by capability mode and an optional type allowlist.
pub fn filter_tool_definitions(
    definitions: Vec<ToolDefinition>,
    capability: SubagentCapabilityMode,
    allowlist: Option<&[String]>,
) -> Vec<ToolDefinition> {
    definitions
        .into_iter()
        .filter(|d| {
            let in_allowlist = allowlist
                .map(|list| list.iter().any(|t| t == &d.name))
                .unwrap_or(true);
            in_allowlist && tool_allowed_by_capability(&d.name, capability)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: String::new(),
            parameters: serde_json::json!({}),
        }
    }

    fn parent() -> SubagentParentDefaults {
        SubagentParentDefaults {
            model: "parent-model".into(),
            project_dir: ".".into(),
        }
    }

    fn request(subagent_type: &str) -> SubagentSpawnRequest {
        SubagentSpawnRequest {
            prompt: "do it".into(),
            description: "d".into(),
            subagent_type: subagent_type.into(),
            run_in_background: Some(true),
            capability_mode: None,
            cwd: None,
            isolation: Default::default(),
            max_iterations: None,
            timeout_ms: None,
            resume_from: None,
            role: None,
            instructions: None,
            model: None,
            task_id: None,
        }
    }

    fn created(role: &str) -> SubagentSpawnRequest {
        let mut req = SubagentSpawnRequest {
            role: Some(role.into()),
            ..request("")
        };
        req.normalize();
        req
    }

    fn user_agents(files: &[(&str, &str)]) -> (std::path::PathBuf, Vec<AgentDefinition>) {
        let dir = std::env::temp_dir().join(format!("agente-agents-{}", uuid::Uuid::new_v4()));
        let agents = dir.join(".agente").join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        for (name, body) in files {
            std::fs::write(agents.join(format!("{name}.md")), body).unwrap();
        }
        let custom = custom_subagents(dir.to_str().unwrap());
        (dir, custom)
    }

    /// No predetermined subagents: with no files of the user's own, there is
    /// nothing to spawn by name and nothing in the roster.
    #[test]
    fn there_are_no_predetermined_subagents() {
        for name in ["general-purpose", "explore", "plan"] {
            assert!(find_agent(name, &[]).is_none(), "{name}");
        }
        assert!(agent_roster(&[]).is_empty());
        let err = resolve_effective_config(&request("explore"), &parent(), &[]).unwrap_err();
        assert!(err.contains("pass `role`"), "{err}");
    }

    /// The parent creates the subagent: the role base prompt, read-only by
    /// default, more when it asks.
    #[test]
    fn the_parent_creates_a_subagent_from_a_role() {
        let mut req = created("Security reviewer");
        req.instructions = Some("Check auth first.".into());
        let cfg = resolve_effective_config(&req, &parent(), &[]).unwrap();
        assert_eq!(cfg.subagent_type, "Security reviewer");
        assert_eq!(cfg.capability, SubagentCapabilityMode::ReadOnly);
        assert_eq!(cfg.tools, None);
        assert_eq!(cfg.model.as_deref(), Some("parent-model"));
        assert!(cfg.system_prompt.contains("Your role: Security reviewer."), "{}", cfg.system_prompt);
        assert!(cfg.system_prompt.contains("Check auth first."));
        assert!(!cfg.system_prompt.contains("{instructions}"));

        let bare = created("Security reviewer");
        let cfg = resolve_effective_config(&bare, &parent(), &[]).unwrap();
        assert!(!cfg.system_prompt.contains("\n\n\n"), "{}", cfg.system_prompt);

        let writer = SubagentSpawnRequest {
            capability_mode: Some(SubagentCapabilityMode::ReadWrite),
            ..bare
        };
        let cfg = resolve_effective_config(&writer, &parent(), &[]).unwrap();
        assert_eq!(cfg.capability, SubagentCapabilityMode::ReadWrite);
    }

    /// With neither a role nor an agent named, the task's description is
    /// the role.
    #[test]
    fn the_description_stands_in_for_a_missing_role() {
        let mut req = SubagentSpawnRequest {
            description: "Map the parser".into(),
            ..request("")
        };
        req.normalize();
        let cfg = resolve_effective_config(&req, &parent(), &[]).unwrap();
        assert_eq!(cfg.subagent_type, "Map the parser");
    }

    /// The created subagent's prompt asks for depth, not speed: children run
    /// unbounded, so "be quick" produces three-greps-and-done runs.
    #[test]
    fn the_role_prompt_demands_a_finished_job() {
        let prompt = role_prompt("Explorer", None);
        assert!(prompt.contains("fully"), "{prompt}");
        assert!(prompt.contains("in parallel"), "{prompt}");
        assert!(!prompt.contains("quick"), "{prompt}");
    }

    /// The user's own agent files still spawn by name — tools, capability,
    /// `model:` preference — and a role sharpens them.
    #[test]
    fn the_users_agent_files_spawn_by_name() {
        let (dir, custom) = user_agents(&[
            (
                "auditor",
                "---\ndescription: Audits deps\ntools: read_file, grep\nmodel: scout\n---\nAudit carefully.",
            ),
            ("helper", "---\ndescription: Internal\nhidden: true\n---\nHelp."),
        ]);
        let roster: Vec<String> = agent_roster(&custom).into_iter().map(|e| e.name).collect();
        assert_eq!(roster, ["auditor"]);

        let cfg = resolve_effective_config(&request("auditor"), &parent(), &custom).unwrap();
        assert_eq!(cfg.subagent_type, "auditor");
        assert_eq!(cfg.capability, SubagentCapabilityMode::ReadOnly);
        assert_eq!(cfg.system_prompt, "Audit carefully.");
        assert_eq!(cfg.agent_model.as_deref(), Some("scout"));
        assert_eq!(cfg.model.as_deref(), Some("parent-model"));

        let sharpened = SubagentSpawnRequest {
            role: Some("License checker".into()),
            ..request("auditor")
        };
        let cfg = resolve_effective_config(&sharpened, &parent(), &custom).unwrap();
        assert!(cfg.system_prompt.ends_with("For this task your role is: License checker."));

        // Hidden agents stay spawnable by name.
        assert!(resolve_effective_config(&request("helper"), &parent(), &custom).is_ok());
        let err = resolve_effective_config(&request("nope"), &parent(), &custom).unwrap_err();
        assert!(err.contains("The user's agents: auditor, helper."), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capability_gating() {
        use SubagentCapabilityMode::*;
        assert!(tool_allowed_by_capability("read_file", ReadOnly));
        assert!(!tool_allowed_by_capability("write_file", ReadOnly));
        assert!(tool_allowed_by_capability("write_file", ReadWrite));
        assert!(!tool_allowed_by_capability("shell", ReadWrite));
        assert!(tool_allowed_by_capability("shell", Execute));
        assert!(!tool_allowed_by_capability("task", Execute));
        assert!(tool_allowed_by_capability("task", All));
        // Structural read tools and patch edits must classify with their kind,
        // not fall through to "unknown requires All".
        assert!(tool_allowed_by_capability("file_outline", ReadOnly));
        assert!(!tool_allowed_by_capability("apply_patch", ReadOnly));
        assert!(tool_allowed_by_capability("apply_patch", ReadWrite));
    }

    #[test]
    fn filter_applies_allowlist_and_capability() {
        let defs = vec![
            def("read_file"),
            def("write_file"),
            def("shell"),
            def("task"),
        ];
        let filtered = filter_tool_definitions(
            defs,
            SubagentCapabilityMode::ReadOnly,
            Some(&["read_file".to_string(), "write_file".to_string()]),
        );
        let names: Vec<&str> = filtered.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["read_file"]);
    }

    #[test]
    fn resolve_timeout_ms_defaults_and_honors_positive_overrides() {
        assert_eq!(resolve_timeout_ms(None), DEFAULT_SUBAGENT_TIMEOUT_MS);
        assert_eq!(resolve_timeout_ms(Some(0)), DEFAULT_SUBAGENT_TIMEOUT_MS);
        assert_eq!(resolve_timeout_ms(Some(5_000)), 5_000);
    }

    #[test]
    fn plan_mode_parent_coerces_child_capability_to_read_only() {
        use crate::types::AgentMode;
        use SubagentCapabilityMode::*;
        // Any mutating capability under a Plan-mode parent becomes read-only.
        assert_eq!(
            capability_for_parent_mode(AgentMode::Plan, All),
            (ReadOnly, true)
        );
        assert_eq!(
            capability_for_parent_mode(AgentMode::Plan, Execute),
            (ReadOnly, true)
        );
        assert_eq!(
            capability_for_parent_mode(AgentMode::Plan, ReadWrite),
            (ReadOnly, true)
        );
        // Already read-only: no coercion flag.
        assert_eq!(
            capability_for_parent_mode(AgentMode::Plan, ReadOnly),
            (ReadOnly, false)
        );
        // Build mode: untouched.
        assert_eq!(
            capability_for_parent_mode(AgentMode::Build, All),
            (All, false)
        );
    }
}
