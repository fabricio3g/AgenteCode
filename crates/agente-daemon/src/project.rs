//! What a project offers the agent, for clients' menus (the TUI reads these
//! from disk itself): skills, subagents, custom slash commands, AGENTS.md,
//! and the MCP servers the runtime is using. `project.init` writes the
//! AGENTS.md scaffold, like the TUI's `/init`.

use agente_core::extensions::skills::SkillScope;
use agente_core::mcp::{ServerSnapshot, ServerStatus};
use agente_runtime::RuntimeHandle;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::connection::{parse, Failure};
use agente_protocol::rpc;
use base64::Engine;

pub(crate) fn import_media(params: Value) -> Result<Value, Failure> {
    #[derive(Deserialize)]
    struct MediaParams {
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        data: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        project_dir: Option<String>,
    }
    let MediaParams {
        path,
        data,
        name,
        project_dir,
    } = parse(params)?;
    let attachment = if let Some(path) = path {
        let path =
            agente_core::media::media_path_from_paste(&path, project_dir.as_deref().unwrap_or("."));
        match path {
            Some(path) => agente_core::media::attach_file(&path)
                .map_err(|error| (rpc::INVALID_PARAMS, error.to_string()))?,
            None => None,
        }
    } else {
        let name = name.ok_or_else(|| (rpc::INVALID_PARAMS, "media name is required".into()))?;
        let (kind, mime) = agente_core::media::kind_for_path(std::path::Path::new(&name))
            .ok_or_else(|| {
                (
                    rpc::INVALID_PARAMS,
                    "choose an image, audio, video or PDF file".into(),
                )
            })?;
        let data = data.ok_or_else(|| (rpc::INVALID_PARAMS, "media data is required".into()))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&data)
            .map_err(|error| (rpc::INVALID_PARAMS, error.to_string()))?;
        Some(
            agente_core::media::store_bytes(&bytes, &name, kind, mime)
                .map_err(|error| (rpc::INVALID_PARAMS, error.to_string()))?,
        )
    };
    Ok(json!({ "attachment": attachment }))
}

#[derive(Deserialize)]
struct ProjectParams {
    project_dir: String,
}

#[derive(Deserialize)]
struct ExpandParams {
    project_dir: String,
    text: String,
}

pub(crate) fn handle(
    runtime: &RuntimeHandle,
    method: &str,
    params: Value,
) -> Result<Value, Failure> {
    match method {
        "project.info" => {
            let ProjectParams { project_dir } = parse(params)?;
            Ok(info(&project_dir))
        }
        "project.init" => {
            let ProjectParams { project_dir } = parse(params)?;
            let message = agente_core::extensions::init_project(&project_dir)
                .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
            Ok(json!({ "message": message }))
        }
        "project.expand_prompt" => {
            let ExpandParams { project_dir, text } = parse(params)?;
            let Some(slash) = text.strip_prefix('/') else {
                return Ok(json!({ "text": text }));
            };
            let (name, args) = slash.split_once(char::is_whitespace).unwrap_or((slash, ""));
            let commands = agente_core::extensions::discover_commands(&project_dir);
            if let Some(command) = commands.iter().find(|command| command.name == name) {
                let expanded = agente_core::extensions::expand_command_template(
                    &command.template,
                    args.trim(),
                );
                return Ok(json!({ "text": expanded }));
            }
            if let Some(skill) = agente_core::extensions::skills::find(&project_dir, name) {
                let expanded =
                    agente_core::extensions::skills::user_invocation(&skill, args.trim())
                        .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
                return Ok(json!({ "text": expanded }));
            }
            Ok(json!({ "text": text }))
        }
        "mcp.status" => {
            let snapshots = if params.get("project_dir").is_some() {
                let ProjectParams { project_dir } = parse(params)?;
                runtime.project_mcp_snapshots(&project_dir)
            } else {
                runtime.mcp_snapshots()
            };
            Ok(Value::Array(snapshots.iter().map(server).collect()))
        }
        _ => Err((rpc::METHOD_NOT_FOUND, format!("unknown method {method}"))),
    }
}

fn info(project_dir: &str) -> Value {
    let skills: Vec<Value> = agente_core::extensions::skills::discover(project_dir)
        .into_iter()
        .map(|skill| {
            json!({
                "name": skill.name,
                "description": skill.description,
                "scope": match skill.scope { SkillScope::User => "user", SkillScope::Project => "project" },
                "source": skill.source,
            })
        })
        .collect();
    // The user's own agents; the parent creates every other subagent.
    let agents: Vec<Value> = agente_core::subagent::custom_subagents(project_dir)
        .into_iter()
        .filter(|agent| !agent.hidden)
        .map(|agent| {
            json!({
                "name": agent.name,
                "description": agent.description,
                "model": agent.model,
            })
        })
        .collect();
    let commands: Vec<Value> = agente_core::extensions::discover_commands(project_dir)
        .into_iter()
        .map(|command| {
            json!({ "name": command.name, "description": command.description, "template": command.template })
        })
        .collect();
    json!({
        "skills": skills,
        "agents": agents,
        "commands": commands,
        "agents_md": std::path::Path::new(project_dir).join("AGENTS.md").exists(),
    })
}

fn server(snapshot: &ServerSnapshot) -> Value {
    let (status, error) = match &snapshot.status {
        ServerStatus::Disabled => ("disabled", None),
        ServerStatus::NeedsApproval => ("needs_approval", None),
        ServerStatus::Connecting => ("connecting", None),
        ServerStatus::Ready => ("ready", None),
        ServerStatus::Failed(message) => ("failed", Some(message.clone())),
    };
    json!({
        "name": snapshot.name,
        "target": snapshot.target,
        "remote": snapshot.remote,
        "status": status,
        "error": error.or_else(|| snapshot.last_stderr.clone().filter(|_| status == "failed")),
        "tools": snapshot.tools,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_info_lists_what_the_folder_adds() {
        let dir = tempfile_dir("info");
        std::fs::create_dir_all(dir.join(".agente/commands")).unwrap();
        std::fs::create_dir_all(dir.join(".agente/agents")).unwrap();
        std::fs::write(
            dir.join(".agente/commands/review.md"),
            "---\ndescription: Review the diff\n---\nReview my changes.",
        )
        .unwrap();
        std::fs::write(
            dir.join(".agente/agents/auditor.md"),
            "---\ndescription: Audits deps\nmodel: scout\n---\nAudit.",
        )
        .unwrap();
        let value = info(&dir.to_string_lossy());
        assert_eq!(value["agents_md"], false);
        // Only the user's own agents: the model creates every other subagent.
        let agents = value["agents"].as_array().unwrap();
        let auditor = agents
            .iter()
            .find(|agent| agent["name"] == "auditor")
            .unwrap();
        assert_eq!(auditor["model"], "scout");
        for preset in ["general-purpose", "explore", "plan"] {
            assert!(
                !agents.iter().any(|agent| agent["name"] == preset),
                "{preset}"
            );
        }
        assert_eq!(value["commands"][0]["name"], "review");

        let init = agente_core::extensions::init_project(&dir.to_string_lossy()).unwrap();
        assert!(init.contains("Created AGENTS.md"));
        assert_eq!(info(&dir.to_string_lossy())["agents_md"], true);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn tempfile_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agente-project-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
