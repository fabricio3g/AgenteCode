//! `skill`: loads an Agent Skill's instructions into the conversation.
//!
//! The catalog (every model-invocable skill's name + description) lives in
//! this tool's description and the `name` parameter is an enum of those
//! names, so the model can only ask for skills that exist. The tool is only
//! registered when at least one skill is available.

use async_trait::async_trait;

use crate::extensions::skills::{self, Skill, SKILL_TOOL};

use super::{Tool, ToolError, ToolKind, ToolRenderInfo};

pub struct SkillTool {
    skills: Vec<Skill>,
    description: String,
}

impl SkillTool {
    /// `None` when there is nothing to offer (no empty catalog, no tool).
    pub fn new(skills: Vec<Skill>) -> Option<Self> {
        let skills: Vec<Skill> = skills.into_iter().filter(|s| s.model_invocable).collect();
        if skills.is_empty() {
            return None;
        }
        let description = skills::tool_description(&skills);
        Some(Self {
            skills,
            description,
        })
    }
}

#[async_trait]
impl Tool for SkillTool {
    fn name(&self) -> &str {
        SKILL_TOOL
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> serde_json::Value {
        let names: Vec<&str> = self.skills.iter().map(|s| s.name.as_str()).collect();
        serde_json::json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "enum": names,
                    "description": "Name of the skill to load"
                }
            },
            "required": ["name"]
        })
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }

    fn icon(&self) -> &'static str {
        "◆"
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, ToolError> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'name' parameter".into()))?;
        let skill = self.skills.iter().find(|s| s.name == name).ok_or_else(|| {
            let known: Vec<&str> = self.skills.iter().map(|s| s.name.as_str()).collect();
            ToolError::InvalidArguments(format!(
                "Unknown skill '{name}'. Available: {}",
                known.join(", ")
            ))
        })?;
        skill
            .content_block()
            .map_err(|e| ToolError::ExecutionError(format!("Failed to read skill '{name}': {e}")))
    }

    fn render_call(&self, args: &serde_json::Value) -> ToolRenderInfo {
        ToolRenderInfo {
            icon: self.icon(),
            label: SKILL_TOOL.to_string(),
            detail: args
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::skills::SkillScope;

    fn skill(dir: &std::path::Path, name: &str, invocable: bool) -> Skill {
        let skill_dir = dir.join(name);
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: d\n---\nDo {name}."),
        )
        .unwrap();
        Skill {
            name: name.to_string(),
            description: "d".to_string(),
            source: skill_dir.join("SKILL.md"),
            dir: skill_dir,
            scope: SkillScope::User,
            model_invocable: invocable,
            compatibility: None,
        }
    }

    #[tokio::test]
    async fn loads_known_skills_and_rejects_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            SkillTool::new(vec![skill(tmp.path(), "hidden", false)]).is_none(),
            "no model-invocable skills, no tool"
        );
        let tool = SkillTool::new(vec![
            skill(tmp.path(), "review", true),
            skill(tmp.path(), "hidden", false),
        ])
        .unwrap();
        assert_eq!(
            tool.parameters()["properties"]["name"]["enum"],
            serde_json::json!(["review"])
        );
        assert!(!tool.description().contains("hidden"));
        let out = tool
            .execute(serde_json::json!({"name": "review"}), "/tmp")
            .await
            .unwrap();
        assert!(out.contains("Do review."), "{out}");
        assert!(tool
            .execute(serde_json::json!({"name": "hidden"}), "/tmp")
            .await
            .is_err());
    }
}
