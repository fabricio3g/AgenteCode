//! Filesystem-first extensions: custom commands, agents, and skills.
//!
//! Layout (project or user config):
//! - `.agente/commands/*.md`
//! - `.agente/agents/*.md`
//! - `.agente/skills/*/SKILL.md`
//!
//! No WASM/JS plugin host — markdown + frontmatter only for v1.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct CustomCommand {
    pub name: String,
    pub description: String,
    pub template: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub source: PathBuf,
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
    pub source: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub body: String,
    pub source: PathBuf,
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

pub fn discover_skills(project_dir: &str) -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();
    for dir in extension_roots(project_dir, "skills") {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let skill_md = path.join("SKILL.md");
                if skill_md.exists() {
                    if let Ok(skill) = load_skill(&skill_md, &path) {
                        out.retain(|s| s.name != skill.name);
                        out.push(skill);
                    }
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
        agent: meta.get("agent").cloned(),
        model: meta.get("model").cloned(),
        source: path.to_path_buf(),
    })
}

fn load_agent(path: &Path) -> anyhow::Result<AgentProfile> {
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
        .unwrap_or_else(|| "agent".into());
    let tools = meta
        .get("tools")
        .map(|s| {
            s.split(',')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Ok(AgentProfile {
        name,
        description: meta
            .get("description")
            .cloned()
            .unwrap_or_else(|| "Custom agent".into()),
        prompt: body.trim().to_string(),
        tools,
        capability: meta.get("capability").cloned(),
        hidden: meta
            .get("hidden")
            .is_some_and(|v| matches!(v.to_lowercase().as_str(), "true" | "1" | "yes")),
        source: path.to_path_buf(),
    })
}

fn load_skill(path: &Path, dir: &Path) -> anyhow::Result<Skill> {
    let raw = std::fs::read_to_string(path)?;
    let (meta, body) = split_frontmatter(&raw);
    let name = meta
        .get("name")
        .cloned()
        .or_else(|| {
            dir.file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "skill".into());
    Ok(Skill {
        name,
        description: meta
            .get("description")
            .cloned()
            .unwrap_or_else(|| "Skill".into()),
        body: body.trim().to_string(),
        source: path.to_path_buf(),
    })
}

/// Very small YAML-ish frontmatter parser for `key: value` lines between `---`.
fn split_frontmatter(raw: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut meta = std::collections::HashMap::new();
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return (meta, raw.to_string());
    }
    let rest = &trimmed[3..];
    let rest = rest.trim_start_matches(['\r', '\n']);
    if let Some(end) = rest.find("\n---") {
        let header = &rest[..end];
        let body = rest[end + 4..].trim_start_matches(['\r', '\n']);
        for line in header.lines() {
            if let Some((k, v)) = line.split_once(':') {
                meta.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
            }
        }
        (meta, body.to_string())
    } else {
        (meta, raw.to_string())
    }
}

/// Expand `$ARGUMENTS` and simple `$FILE` placeholders in a command template.
pub fn expand_command_template(template: &str, arguments: &str) -> String {
    template
        .replace("$ARGUMENTS", arguments)
        .replace("{{args}}", arguments)
        .replace("$FILE", arguments)
}
