//! Built-in and user-defined subagent definitions, effective-config
//! resolution, and capability-based tool filtering.
//!
//! Resolution precedence:
//! explicit spawn-time override > subagent type definition > parent defaults.

use crate::extensions::AgentProfile;
use crate::types::ToolDefinition;

use super::types::{SubagentCapabilityMode, SubagentSpawnRequest};

/// Default nesting depth for subagents (parent = depth 0).
pub const DEFAULT_MAX_SUBAGENT_DEPTH: u32 = 3;
/// Default max concurrently running subagents per session.
pub const DEFAULT_MAX_CONCURRENT_SUBAGENTS: usize = 4;
/// Cap for the final summary a subagent returns to its parent.
pub const DEFAULT_SUBAGENT_SUMMARY_CAP: usize = 4000;
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

/// A built-in subagent definition.
pub struct BuiltinSubagent {
    pub name: &'static str,
    pub description: &'static str,
    pub prompt: &'static str,
    /// Tool allowlist; empty means "all tools (subject to capability mode)".
    pub tools: &'static [&'static str],
    pub capability: SubagentCapabilityMode,
}

/// User-defined subagent loaded from `.agente/agents/*.md`.
#[derive(Debug, Clone)]
pub struct CustomSubagent {
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

pub const GENERAL_PURPOSE_PROMPT: &str = "\
You are a general-purpose subagent working inside a parent agent session.

Complete the assigned task fully. You have no iteration limit: keep working
until the task is genuinely done, not until you have done \"enough\". Do what
was asked; nothing more, nothing less. Respond with a detailed writeup when
done.

Work with depth:
- Investigate before acting: read the relevant files, trace call sites, check
  tests. A fix you have not verified is not done.
- If the first approach fails, diagnose why and try the next one. Report
  dead ends in your writeup so the parent does not repeat them.
- Never finish with a shallow answer when the task asks a deep question. If
  you cannot complete part of the task, say exactly which part and why.

Strengths:
- Searching across large codebases for code, configurations, and patterns
- Multi-file analysis and architecture investigation
- Multi-step research requiring exploration of many files

Workspace boundary: operate inside the project directory only. Never modify
files outside the workspace, and do not assume files exist without checking.
Prefer reading files before editing them, and verify your changes afterwards.";

pub const EXPLORE_PROMPT: &str = "\
You are an explore subagent: a thorough, read-only specialist for codebase
investigation. You have no iteration limit: keep digging until the question
is answered with evidence, not until you have run \"enough\" searches.

Your job is to answer questions about the codebase by reading, listing, and
searching files. You must NOT modify files or run shell commands — you only
have read-only tools.

Report findings as a concise structured summary:
- What you found (files, symbols, patterns), with exact paths
- Answers to the specific questions asked
- Any gaps or uncertainties (e.g. \"could not find\") so the parent can follow up

Work with depth: prefer targeted grep/read over broad file dumps, but do not
stop after the first hit. Chase definitions to their source, check every
call site that matters, and read the surrounding code before concluding.
A three-search answer to a deep question is a failure. When done, respond
with a detailed writeup.";

pub const PLAN_PROMPT: &str = "\
You are a plan subagent: a read-only specialist that investigates a problem
and produces an implementation plan.

You may read, list, search, and track progress with todo_write. You must NOT
modify files or run shell commands. Do not present the plan to the user —
that is the parent agent's job.

Use todo_write to track investigation steps. When done, respond with a
detailed plan: goal, steps in order, files to touch, risks, and open
questions.";

pub const GENERAL_PURPOSE_TOOLS: &[&str] = &[];
pub const EXPLORE_TOOLS: &[&str] = &["read_file", "file_outline", "list_dir", "grep", "find"];
pub const PLAN_TOOLS: &[&str] = &[
    "read_file",
    "file_outline",
    "list_dir",
    "grep",
    "find",
    "todo_write",
    "present_plan",
];

pub const BUILTIN_SUBAGENTS: &[BuiltinSubagent] = &[
    BuiltinSubagent {
        name: "general-purpose",
        description: "Use this agent when a task is multi-step or spans many files and doing it inline would flood the parent context. Has all tools, including edits.",
        prompt: GENERAL_PURPOSE_PROMPT,
        tools: GENERAL_PURPOSE_TOOLS,
        capability: SubagentCapabilityMode::All,
    },
    BuiltinSubagent {
        name: "explore",
        description: "Use this agent when you need to survey an unfamiliar area, find every call site of a symbol, or answer a question spanning many files. Read-only and thorough.",
        prompt: EXPLORE_PROMPT,
        tools: EXPLORE_TOOLS,
        capability: SubagentCapabilityMode::ReadOnly,
    },
    BuiltinSubagent {
        name: "plan",
        description: "Use this agent when you need a structured implementation plan after investigating a problem. Read-only.",
        prompt: PLAN_PROMPT,
        tools: PLAN_TOOLS,
        capability: SubagentCapabilityMode::ReadOnly,
    },
];

pub fn builtin_subagent(name: &str) -> Option<&'static BuiltinSubagent> {
    BUILTIN_SUBAGENTS.iter().find(|s| s.name == name)
}

/// Convert discovered `.agente/agents/*.md` profiles into custom subagent
/// definitions (wires the previously-unused `discover_agents`).
pub fn custom_subagents(project_dir: &str) -> Vec<CustomSubagent> {
    crate::extensions::discover_agents(project_dir)
        .into_iter()
        .map(|p: AgentProfile| CustomSubagent {
            name: p.name,
            description: p.description,
            prompt: p.prompt,
            tools: if p.tools.is_empty() {
                None
            } else {
                Some(p.tools)
            },
            capability: p.capability.as_deref().and_then(parse_capability),
            hidden: p.hidden,
        })
        .collect()
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

/// The full set of spawnable agent types: built-ins plus discovered custom
/// agents, with project-level files shadowing built-ins by name. This is the
/// dynamic roster the task tool's description is generated from.
pub fn agent_roster(project_dir: &str) -> Vec<AgentRosterEntry> {
    agent_roster_with(project_dir, &custom_subagents(project_dir))
}

/// Roster from an already-loaded custom list. Children reuse the parent's
/// roster so a worktree checkout does not re-scan `.agente/agents`.
pub fn agent_roster_with(project_dir: &str, custom: &[CustomSubagent]) -> Vec<AgentRosterEntry> {
    let _ = project_dir;
    let mut entries: Vec<AgentRosterEntry> = Vec::new();
    for builtin in BUILTIN_SUBAGENTS {
        if custom.iter().any(|c| c.name == builtin.name) {
            continue; // project-level file shadows the built-in
        }
        entries.push(AgentRosterEntry {
            name: builtin.name.to_string(),
            description: builtin.description.to_string(),
            tools: if builtin.tools.is_empty() {
                None
            } else {
                Some(builtin.tools.iter().map(|s| s.to_string()).collect())
            },
        });
    }
    for c in custom {
        if c.hidden {
            continue; // internal helper: spawnable by name, never advertised
        }
        entries.push(AgentRosterEntry {
            name: c.name.clone(),
            description: c.description.clone(),
            tools: c.tools.clone(),
        });
    }
    entries
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
    pub depth: u32,
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
    pub cwd: Option<String>,
}

/// Resolve the effective runtime config for a spawn request.
///
/// Precedence: explicit override > subagent type > parent defaults. The
/// model is always the parent's selected model: children never run on a
/// different model than the user picked.
pub fn resolve_effective_config(
    request: &SubagentSpawnRequest,
    parent: &SubagentParentDefaults,
    custom: &[CustomSubagent],
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

    let (system_prompt, type_tools, type_capability) =
        match builtin_subagent(&request.subagent_type) {
            Some(def) => (
                def.prompt.to_string(),
                if def.tools.is_empty() {
                    None
                } else {
                    Some(def.tools.iter().map(|s| s.to_string()).collect())
                },
                def.capability,
            ),
            None => {
                let custom_def = custom
                    .iter()
                    .find(|c| c.name == request.subagent_type)
                    .ok_or_else(|| {
                        let mut types: Vec<&str> =
                            BUILTIN_SUBAGENTS.iter().map(|b| b.name).collect();
                        types.extend(custom.iter().map(|c| c.name.as_str()));
                        format!(
                            "Unknown subagent type '{}'. Available types: {}. \
                             Custom types can be added as `.agente/agents/<name>.md`.",
                            request.subagent_type,
                            types.join(", ")
                        )
                    })?;
                (
                    custom_def.prompt.clone(),
                    custom_def.tools.clone(),
                    custom_capability(custom_def.tools.as_deref(), custom_def.capability),
                )
            }
        };

    let capability = request.capability_mode.unwrap_or(type_capability);
    let model = Some(parent.model.clone());
    let cwd = request
        .cwd
        .clone()
        .or_else(|| Some(parent.project_dir.clone()));

    Ok(EffectiveRuntimeConfig {
        subagent_type: request.subagent_type.clone(),
        system_prompt,
        tools: type_tools,
        capability,
        model,
        cwd,
    })
}

/// Capability a child actually runs with under the given parent mode.
///
/// Plan-mode parents may only run read-only children (Plan mode forbids
/// mutations, including via delegation). Coerce instead of rejecting: the
/// `task` default is the `general-purpose` type (capability `All`), so a
/// hard error fails every default spawn and `task` looks unavailable in
/// Plan mode. The child-registry prune enforces the invariant regardless of
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
        "read_file" | "file_outline" | "list_dir" | "grep" | "find" | "web_search" | "web_fetch"
    )
}

/// Tools that require full capability (spawning nested subagents).
pub fn is_hosted_tool(name: &str) -> bool {
    matches!(name, "task" | "task_output" | "kill_task")
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

    #[test]
    fn builtin_types_resolve() {
        assert!(builtin_subagent("general-purpose").is_some());
        assert!(builtin_subagent("explore").is_some());
        assert!(builtin_subagent("plan").is_some());
        assert!(builtin_subagent("nope").is_none());
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

    /// `hidden: true` agents stay spawnable by name but vanish from the
    /// advertised roster, so the model never picks them unprompted.
    #[test]
    fn hidden_custom_agents_leave_the_roster_but_stay_resolvable() {
        let dir = std::env::temp_dir().join(format!("roster-hidden-{}", std::process::id()));
        let agents = dir.join(".agente").join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(
            agents.join("helper.md"),
            "---\ndescription: Internal helper\nhidden: true\n---\nHelp quietly.",
        )
        .unwrap();
        std::fs::write(
            agents.join("scout.md"),
            "---\ndescription: Visible scout\n---\nScout loudly.",
        )
        .unwrap();

        let roster = agent_roster(dir.to_str().unwrap());
        let names: Vec<&str> = roster.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"scout"), "{names:?}");
        assert!(!names.contains(&"helper"), "{names:?}");
        // Built-ins are unaffected.
        assert!(names.contains(&"explore"), "{names:?}");

        // Direct spawns by name still resolve (hidden ≠ disabled).
        let req = SubagentSpawnRequest {
            prompt: "do it".into(),
            description: "d".into(),
            subagent_type: "helper".into(),
            run_in_background: Some(true),
            capability_mode: None,
            cwd: None,
            isolation: Default::default(),
            max_iterations: None,
            timeout_ms: None,
            resume_from: None,
            task_id: None,
        };
        let parent = SubagentParentDefaults {
            model: "m".into(),
            project_dir: dir.to_str().unwrap().into(),
            depth: 0,
        };
        let custom = custom_subagents(dir.to_str().unwrap());
        assert!(custom.iter().any(|c| c.name == "helper" && c.hidden));
        let cfg = resolve_effective_config(&req, &parent, &custom).unwrap();
        assert_eq!(cfg.subagent_type, "helper");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_timeout_ms_defaults_and_honors_positive_overrides() {
        assert_eq!(resolve_timeout_ms(None), DEFAULT_SUBAGENT_TIMEOUT_MS);
        assert_eq!(resolve_timeout_ms(Some(0)), DEFAULT_SUBAGENT_TIMEOUT_MS);
        assert_eq!(resolve_timeout_ms(Some(5_000)), 5_000);
    }

    /// Built-in prompts must demand depth, not speed: children run unbounded,
    /// so a "be fast / do the minimum" instruction directly
    /// produces shallow 3-greps-and-done runs instead of real investigations.
    #[test]
    fn builtin_prompts_demand_depth_not_speed() {
        assert!(
            EXPLORE_PROMPT.contains("no iteration limit"),
            "explore must know its budget is unbounded"
        );
        assert!(
            !EXPLORE_PROMPT.contains("but fast"),
            "explore must not be told to be fast"
        );
        assert!(
            GENERAL_PURPOSE_PROMPT.contains("no iteration limit"),
            "general-purpose must know its budget is unbounded"
        );
        assert!(
            GENERAL_PURPOSE_PROMPT.contains("genuinely done"),
            "general-purpose must be told to finish fully, not minimally"
        );
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

    #[test]
    fn resolve_unknown_type_errors() {
        let req = SubagentSpawnRequest {
            prompt: "do it".into(),
            description: "d".into(),
            subagent_type: "missing".into(),
            run_in_background: Some(true),
            capability_mode: None,
            cwd: None,
            isolation: Default::default(),
            max_iterations: None,
            timeout_ms: None,
            resume_from: None,
            task_id: None,
        };
        let parent = SubagentParentDefaults {
            model: "m".into(),
            project_dir: ".".into(),
            depth: 0,
        };
        assert!(resolve_effective_config(&req, &parent, &[]).is_err());
    }

    #[test]
    fn resolve_explicit_capability_override_wins() {
        let req = SubagentSpawnRequest {
            prompt: "do it".into(),
            description: "d".into(),
            subagent_type: "explore".into(),
            run_in_background: Some(true),
            capability_mode: Some(SubagentCapabilityMode::All),
            cwd: None,
            isolation: Default::default(),
            max_iterations: None,
            timeout_ms: None,
            resume_from: None,
            task_id: None,
        };
        let parent = SubagentParentDefaults {
            model: "parent-model".into(),
            project_dir: ".".into(),
            depth: 1,
        };
        let cfg = resolve_effective_config(&req, &parent, &[]).unwrap();
        assert_eq!(cfg.capability, SubagentCapabilityMode::All);
        // explore stays read-only by default without the override
        let req2 = SubagentSpawnRequest {
            capability_mode: None,
            ..req.clone()
        };
        let cfg2 = resolve_effective_config(&req2, &parent, &[]).unwrap();
        assert_eq!(cfg2.capability, SubagentCapabilityMode::ReadOnly);
    }

    /// Children always run on the parent's selected model — there is no
    /// per-type, per-request, or custom-agent override.
    #[test]
    fn child_inherits_the_parent_model() {
        let req = SubagentSpawnRequest {
            prompt: "do it".into(),
            description: "d".into(),
            subagent_type: "explore".into(),
            run_in_background: Some(true),
            capability_mode: None,
            cwd: None,
            isolation: Default::default(),
            max_iterations: None,
            timeout_ms: None,
            resume_from: None,
            task_id: None,
        };
        let parent = SubagentParentDefaults {
            model: "parent-model".into(),
            project_dir: ".".into(),
            depth: 0,
        };
        let cfg = resolve_effective_config(&req, &parent, &[]).unwrap();
        assert_eq!(cfg.model.as_deref(), Some("parent-model"));

        // A custom agent carrying a `model:` frontmatter is ignored too.
        let dir = std::env::temp_dir().join(format!("agente-model-{}", uuid::Uuid::new_v4()));
        let agents = dir.join(".agente").join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(
            agents.join("scout.md"),
            "---\ndescription: Scout\nmodel: some-other-model\n---\nScout.",
        )
        .unwrap();
        let custom = custom_subagents(dir.to_str().unwrap());
        let req_scout = SubagentSpawnRequest {
            subagent_type: "scout".into(),
            ..req
        };
        let cfg = resolve_effective_config(&req_scout, &parent, &custom).unwrap();
        assert_eq!(cfg.model.as_deref(), Some("parent-model"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
