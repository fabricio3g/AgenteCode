//! Filesystem-first extensions: custom commands, agents, and skills.
//!
//! Layout (project or user config):
//! - `.agente/commands/*.md`
//! - `.agente/agents/*.md`
//! - `.agente/skills/*/SKILL.md` (see [`skills`], which also reads the
//!   cross-client `.agents/skills` and `.claude/skills` locations)
//!
//! No WASM/JS plugin host — markdown + frontmatter only for v1.

pub mod skills;

pub use skills::{Skill, SkillScope};

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct CustomCommand {
    pub name: String,
    pub description: String,
    pub template: String,
}

#[derive(Debug, Clone)]
pub struct AgentProfile {
    pub name: String,
    pub description: String,
    pub prompt: String,
    /// Tools allowlist; empty means all tools.
    pub tools: Vec<String>,
    /// Explicit capability ceiling (`read-only` / `read-write` / `execute` /
    /// `all`). Absent = derived from the tool allowlist.
    pub capability: Option<String>,
    /// `hidden: true` keeps the agent out of the advertised roster (the model
    /// won't pick it from the `task` description) while leaving direct
    /// spawns by name working — internal helpers, not ambient choice.
    pub hidden: bool,
    /// `model:` frontmatter: a name from the subagent model list,
    /// `provider/model`, or `main`. Absent = no preference.
    pub model: Option<String>,
}

/// Discover custom slash commands from project + user config dirs.
pub fn discover_commands(project_dir: &str) -> Vec<CustomCommand> {
    let mut out: Vec<CustomCommand> = Vec::new();
    for dir in extension_roots(project_dir, "commands") {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                if let Ok(cmd) = load_command(&path) {
                    // Project commands override user commands of the same name.
                    out.retain(|c| c.name != cmd.name);
                    out.push(cmd);
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn discover_agents(project_dir: &str) -> Vec<AgentProfile> {
    let mut out: Vec<AgentProfile> = Vec::new();
    for dir in extension_roots(project_dir, "agents") {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                if let Ok(agent) = load_agent(&path) {
                    out.retain(|a| a.name != agent.name);
                    out.push(agent);
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn extension_roots(project_dir: &str, kind: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".config").join("agente").join(kind));
        roots.push(home.join(".agente").join(kind));
    }
    roots.push(Path::new(project_dir).join(".agente").join(kind));
    roots
}

fn load_command(path: &Path) -> anyhow::Result<CustomCommand> {
    let raw = std::fs::read_to_string(path)?;
    let (meta, body) = split_frontmatter(&raw);
    let name = meta
        .get("name")
        .cloned()
        .or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "command".into());
    Ok(CustomCommand {
        name,
        description: meta
            .get("description")
            .cloned()
            .unwrap_or_else(|| "Custom command".into()),
        template: body.trim().to_string(),
    })
}

fn load_agent(path: &Path) -> anyhow::Result<AgentProfile> {
    let raw = std::fs::read_to_string(path)?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("agent");
    Ok(parse_agent(&raw, stem))
}

/// Parse an agent file (`---` frontmatter + prompt body). Shared by the
/// files on disk and the built-in agents bundled with the binary, so both
/// read the same fields the same way. `fallback_name` names a file without
/// a `name:` key.
pub fn parse_agent(raw: &str, fallback_name: &str) -> AgentProfile {
    let (meta, body) = split_frontmatter(raw);
    let tools = meta
        .get("tools")
        .map(|s| {
            s.split(',')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default();
    AgentProfile {
        name: meta
            .get("name")
            .cloned()
            .unwrap_or_else(|| fallback_name.to_string()),
        description: meta
            .get("description")
            .cloned()
            .unwrap_or_else(|| "Custom agent".into()),
        prompt: body.trim().to_string(),
        tools,
        capability: meta.get("capability").cloned(),
        hidden: truthy(meta.get("hidden")),
        model: meta
            .get("model")
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty() && m != "inherit"),
    }
}

/// Lenient YAML-ish frontmatter parser for the block between `---` lines.
///
/// Handles what skill/agent/command files written for other clients use in
/// practice without pulling in a YAML crate: `key: value` (quotes stripped,
/// colons inside values kept), block scalars (`key: |` / `key: >`), plain
/// values continued on indented lines, and one level of nested maps
/// (`metadata:` → `metadata.author`). Anything it cannot read is skipped.
pub(crate) fn split_frontmatter(raw: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut meta = std::collections::HashMap::new();
    let trimmed = raw.trim_start_matches('\u{feff}').trim_start();
    if !trimmed.starts_with("---") {
        return (meta, raw.to_string());
    }
    let rest = trimmed[3..].trim_start_matches(['\r', '\n']);
    let Some(end) = rest.find("\n---") else {
        return (meta, raw.to_string());
    };
    let header = &rest[..end];
    let body = rest[end + 4..]
        .trim_start_matches('-')
        .trim_start_matches(['\r', '\n']);

    let lines: Vec<&str> = header.lines().map(|l| l.trim_end_matches('\r')).collect();
    let indented = |line: &str| line.starts_with(' ') || line.starts_with('\t');
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.trim().is_empty() || line.trim_start().starts_with('#') || indented(line) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let value = value.trim();
        // Indented lines that belong to this key.
        let mut block: Vec<&str> = Vec::new();
        while i < lines.len() && (indented(lines[i]) || lines[i].trim().is_empty()) {
            block.push(lines[i]);
            i += 1;
        }
        while block.last().is_some_and(|l| l.trim().is_empty()) {
            block.pop();
        }
        if let Some(style) = value.chars().next().filter(|c| matches!(c, '|' | '>')) {
            let parts = block.iter().map(|l| l.trim());
            let joined = if style == '|' {
                parts.collect::<Vec<_>>().join("\n")
            } else {
                parts
                    .filter(|l| !l.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            meta.insert(key, joined);
        } else if value.is_empty() && block.iter().any(|l| l.trim().contains(": ")) {
            for sub in &block {
                if let Some((k, v)) = sub.trim().split_once(':') {
                    meta.insert(format!("{key}.{}", k.trim()), unquote(v.trim()));
                }
            }
        } else {
            let mut full = value.to_string();
            for continued in &block {
                full.push(' ');
                full.push_str(continued.trim());
            }
            meta.insert(key, unquote(full.trim()));
        }
    }
    (meta, body.to_string())
}

fn unquote(value: &str) -> String {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

/// `true`, `yes`, `1` (any case).
pub(crate) fn truthy(value: Option<&String>) -> bool {
    value.is_some_and(|v| matches!(v.to_lowercase().as_str(), "true" | "1" | "yes"))
}

/// Expand `$ARGUMENTS` and simple `$FILE` placeholders in a command template.
pub fn expand_command_template(template: &str, arguments: &str) -> String {
    template
        .replace("$ARGUMENTS", arguments)
        .replace("{{args}}", arguments)
        .replace("$FILE", arguments)
}

/// Bootstrap AGENTS.md for a project (`/init`, in the TUI and Desktop):
/// guidance for the agent plus the `.agente/{commands,agents,skills}` folders.
pub fn init_project(project_dir: &str) -> anyhow::Result<String> {
    let path = std::path::Path::new(project_dir).join("AGENTS.md");
    if path.exists() {
        return Ok(
            "AGENTS.md already exists — edit it to refine project guidance for the agent."
                .to_string(),
        );
    }

    let mut langs = Vec::new();
    let has = |name: &str| std::path::Path::new(project_dir).join(name).exists();
    if has("Cargo.toml") {
        langs.push("Rust (Cargo)");
    }
    if has("package.json") {
        langs.push("JavaScript/TypeScript (npm)");
    }
    if has("pyproject.toml") || has("requirements.txt") {
        langs.push("Python");
    }
    if has("go.mod") {
        langs.push("Go");
    }
    if has("pom.xml") || has("build.gradle") || has("build.gradle.kts") {
        langs.push("Java/Kotlin");
    }

    let stack = if langs.is_empty() {
        "Unknown — inspect the tree before editing.".to_string()
    } else {
        langs.join(", ")
    };

    let body = format!(
        r#"# AGENTS.md

Project guidance for coding agents working in this repository.

## Stack

{stack}

## Working directory

`{project_dir}`

## Conventions

- Prefer small, focused changes over large rewrites.
- Match existing style, naming, and module layout.
- Run the project's normal checks after non-trivial edits.
- Do not commit secrets or rewrite git history.

## Commands

Document useful build/test/lint commands here after discovery.

## Notes

Add architecture notes, do-not-touch areas, and preferred patterns below.
"#
    );

    std::fs::write(&path, body)?;
    // Scaffold extensibility dirs (filesystem plugins later)
    for dir in [".agente/commands", ".agente/agents", ".agente/skills"] {
        let _ = std::fs::create_dir_all(std::path::Path::new(project_dir).join(dir));
    }

    Ok(
        "Created AGENTS.md and .agente/{commands,agents,skills}. Commit AGENTS.md when ready."
            .to_string(),
    )
}
