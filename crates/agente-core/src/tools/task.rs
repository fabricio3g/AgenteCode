//! Task management tools
//!
//! This module provides tools for managing task lists:
//! - todo_write: Update the task todo list for this session
//! - present_plan: Finalize a plan for user Accept / Redo / Comment

use std::path::Path;

use super::{
    atomic_fs, ensure_not_cancelled, with_file_mutation_queue, ToolCore, ToolError,
    ToolExecutionContext, ToolExecutionMode, ToolKind, ToolRenderInfo,
};

/// Where a project keeps its plans: one file per plan, so plans from other
/// sessions and tabs never overwrite each other.
pub const PLANS_DIR_REL: &str = ".agente/plans";

/// `.agente/plans/2026-09-27-add-image-input.md` — dated and named after the
/// title. A revision (same title, same day) updates its own file; a new plan
/// gets a new one.
pub fn plan_file_rel(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_end_matches('-').chars().take(48).collect();
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "plan" } else { slug };
    let date = chrono::Local::now().format("%Y-%m-%d");
    format!("{PLANS_DIR_REL}/{date}-{slug}.md")
}

#[derive(Default)]
pub struct TodoWriteTool;

// The doc comments on `TodoWriteArgs`/`TodoEntry` fields become the generated
// schema descriptions, mirroring the previous hand-written tool definition.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct TodoWriteArgs {
    /// List of todos to set
    // Deserialized as a raw value so runtime tolerance matches the old hand
    // parser byte-for-byte (only null/missing was rejected); the schema still
    // describes the array-of-entries shape.
    #[schemars(required, with = "Vec<TodoEntry>")]
    todos: Option<serde_json::Value>,
}

#[derive(Debug, schemars::JsonSchema)]
pub struct TodoEntry {
    /// Brief description of the task
    #[schemars(required)]
    pub content: Option<String>,
    /// Current status of the task
    #[serde(default)]
    #[schemars(schema_with = "todo_status_schema")]
    pub status: Option<String>,
    /// Priority level of the task
    #[serde(default)]
    #[schemars(schema_with = "todo_priority_schema")]
    pub priority: Option<String>,
}

fn todo_status_schema(_generator: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
    string_enum_schema(&["pending", "in_progress", "completed", "cancelled"])
}

fn todo_priority_schema(
    _generator: &mut schemars::gen::SchemaGenerator,
) -> schemars::schema::Schema {
    string_enum_schema(&["high", "medium", "low"])
}

fn string_enum_schema(values: &[&str]) -> schemars::schema::Schema {
    schemars::schema::Schema::Object(schemars::schema::SchemaObject {
        instance_type: Some(schemars::schema::InstanceType::String.into()),
        enum_values: Some(values.iter().map(|v| (*v).into()).collect()),
        ..Default::default()
    })
}

impl ToolCore for TodoWriteTool {
    type Args = TodoWriteArgs;

    fn name(&self) -> &str {
        "todo_write"
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Todo
    }

    fn icon(&self) -> &'static str {
        "☐"
    }

    fn description(&self) -> &str {
        "Update the task todo list for this session. Use this to track progress on multi-step tasks."
    }

    async fn run(
        &self,
        args: TodoWriteArgs,
        _project_dir: &str,
        _context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        if args.todos.as_ref().is_none_or(|v| v.is_null()) {
            return Err(ToolError::InvalidArguments(
                "Missing 'todos' parameter".to_string(),
            ));
        }
        Ok("Todos updated successfully".to_string())
    }
}

/// Present a finished plan to the user (Plan mode). Writes the plan to its own
/// file under `.agente/plans/` and signals the TUI to open the Accept / Redo / Comment card.
#[derive(Default)]
pub struct PresentPlanTool;

#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct PresentPlanArgs {
    /// Short plan title
    #[schemars(required)]
    title: Option<String>,
    /// Full plan body in markdown (steps, approach, risks)
    #[schemars(required)]
    markdown: Option<String>,
}

impl ToolCore for PresentPlanTool {
    type Args = PresentPlanArgs;

    fn name(&self) -> &str {
        "present_plan"
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Plan
    }

    fn icon(&self) -> &'static str {
        "◇"
    }

    fn render_call(&self, args: &serde_json::Value) -> ToolRenderInfo {
        ToolRenderInfo {
            icon: self.icon(),
            label: self.name().to_string(),
            detail: args
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        }
    }

    fn description(&self) -> &str {
        "Present a finished implementation plan for user review. Call this when the plan is complete. Saves it to its own file under `.agente/plans/` (a revision keeps the same title) and waits for Accept / Redo / Comment. Do not implement code after calling this — wait for acceptance."
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    async fn run(
        &self,
        args: PresentPlanArgs,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let title = args
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'title'".into()))?;
        let markdown = args
            .markdown
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'markdown'".into()))?;

        let body = if markdown.starts_with('#') {
            format!("{markdown}\n")
        } else {
            format!("# {title}\n\n{markdown}\n")
        };

        let rel = plan_file_rel(title);
        let path = Path::new(project_dir).join(&rel);
        let path_str = path.to_string_lossy().to_string();
        let body_for_write = body.clone();
        with_file_mutation_queue(
            &path_str,
            context.cancellation.clone(),
            move |signal| async move {
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(|e| {
                        ToolError::ExecutionError(format!("Failed to create .agente: {e}"))
                    })?;
                }
                ensure_not_cancelled(&signal)?;
                atomic_fs::write_and_record(&path, &body_for_write).await
            },
        )
        .await?;

        // Structured trailer for the TUI (PlanReady). Keep human-readable head for chat.
        Ok(format!(
            "Plan ready for review: {title}\nSaved to {rel}\n\n__PLAN_READY__\n{rel}\n__PLAN_TITLE__\n{title}\n__PLAN_BODY__\n{body}"
        ))
    }
}

/// Parse `present_plan` tool output into `(path, title, body)` if marked ready.
pub fn parse_plan_ready_output(result: &str) -> Option<(String, String, String)> {
    let marker = "__PLAN_READY__\n";
    let idx = result.find(marker)?;
    let rest = &result[idx + marker.len()..];
    let title_marker = "\n__PLAN_TITLE__\n";
    let body_marker = "\n__PLAN_BODY__\n";
    let t_idx = rest.find(title_marker)?;
    let path = rest[..t_idx].trim().to_string();
    let after_title = &rest[t_idx + title_marker.len()..];
    let b_idx = after_title.find(body_marker)?;
    let title = after_title[..b_idx].trim().to_string();
    let body = after_title[b_idx + body_marker.len()..].to_string();
    if path.is_empty() || title.is_empty() || body.trim().is_empty() {
        return None;
    }
    Some((path, title, body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{Tool, TypedTool};
    use serde_json::json;

    #[test]
    fn parse_plan_ready_roundtrip() {
        let s = "Plan ready\n\n__PLAN_READY__\n.agente/plan.md\n__PLAN_TITLE__\nMy Plan\n__PLAN_BODY__\n# My Plan\n\nsteps\n";
        let (p, t, b) = parse_plan_ready_output(s).unwrap();
        assert_eq!(p, ".agente/plan.md");
        assert_eq!(t, "My Plan");
        assert!(b.contains("# My Plan"));
    }

    #[tokio::test]
    async fn present_plan_writes_file() {
        let dir = std::env::temp_dir().join(format!("agente_plan_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let tool = TypedTool::new(PresentPlanTool);
        let out = tool
            .execute(
                json!({
                    "title": "T",
                    "markdown": "## Steps\n1. a"
                }),
                &root,
            )
            .await
            .unwrap();
        assert!(out.contains("__PLAN_READY__"));
        let (p, t, b) = parse_plan_ready_output(&out).unwrap();
        assert_eq!(p, plan_file_rel("T"));
        assert!(
            p.starts_with(".agente/plans/") && p.ends_with("-t.md"),
            "{p}"
        );
        assert_eq!(t, "T");
        assert!(b.contains("## Steps"));
        let written = std::fs::read_to_string(dir.join(&p)).unwrap();
        assert!(written.contains("## Steps"));

        // Another plan in the same project keeps its own file.
        let other = tool
            .execute(
                json!({"title": "Add image input", "markdown": "steps"}),
                &root,
            )
            .await
            .unwrap();
        let (other_path, _, _) = parse_plan_ready_output(&other).unwrap();
        assert!(other_path.ends_with("-add-image-input.md"), "{other_path}");
        assert!(dir.join(&p).exists(), "the first plan is untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn todo_write_runtime_semantics_are_preserved() {
        let tool = TypedTool::new(TodoWriteTool);

        let err = tool.execute(json!({}), "/tmp").await.unwrap_err();
        assert!(err.to_string().contains("Missing 'todos' parameter"));

        let err = tool
            .execute(json!({"todos": null}), "/tmp")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Missing 'todos' parameter"));

        // The old hand parser never validated the todos payload: unknown
        // status values and even non-array shapes still reported success.
        let ok = tool
            .execute(
                json!({"todos": [{"content": "x", "status": "bogus"}]}),
                "/tmp",
            )
            .await
            .unwrap();
        assert_eq!(ok, "Todos updated successfully");

        let ok = tool
            .execute(json!({"todos": "weird"}), "/tmp")
            .await
            .unwrap();
        assert_eq!(ok, "Todos updated successfully");
    }

    #[test]
    fn todo_write_schema_keeps_enums_and_required() {
        let schema = Tool::parameters(&TypedTool::new(TodoWriteTool));
        assert_eq!(schema["required"], json!(["todos"]));
        assert_eq!(schema["properties"]["todos"]["type"], "array");
        assert_eq!(
            schema["properties"]["todos"]["description"],
            "List of todos to set"
        );
        let items = &schema["properties"]["todos"]["items"];
        // Nested entry schemas are hoisted into `definitions` (schemars 0.8).
        assert_eq!(items["$ref"], "#/definitions/TodoEntry");
        let entry = &schema["definitions"]["TodoEntry"];
        assert_eq!(entry["required"], json!(["content"]));
        assert_eq!(
            entry["properties"]["content"]["description"],
            "Brief description of the task"
        );
        assert_eq!(entry["properties"]["status"]["type"], "string");
        assert_eq!(
            entry["properties"]["status"]["enum"],
            json!(["pending", "in_progress", "completed", "cancelled"])
        );
        assert_eq!(
            entry["properties"]["status"]["description"],
            "Current status of the task"
        );
        assert_eq!(
            entry["properties"]["priority"]["enum"],
            json!(["high", "medium", "low"])
        );
        assert_eq!(
            entry["properties"]["priority"]["description"],
            "Priority level of the task"
        );
    }

    #[test]
    fn present_plan_schema_has_required_title_and_markdown() {
        let schema = Tool::parameters(&TypedTool::new(PresentPlanTool));
        let required = schema["required"].as_array().unwrap();
        assert!(required.contains(&json!("title")));
        assert!(required.contains(&json!("markdown")));
        assert_eq!(
            schema["properties"]["title"]["description"],
            "Short plan title"
        );
        assert_eq!(
            schema["properties"]["markdown"]["description"],
            "Full plan body in markdown (steps, approach, risks)"
        );
    }

    #[tokio::test]
    async fn present_plan_preserves_missing_argument_errors() {
        let tool = TypedTool::new(PresentPlanTool);

        let err = tool.execute(json!({}), "/tmp").await.unwrap_err();
        assert!(err.to_string().contains("Missing 'title'"));

        let err = tool
            .execute(json!({"title": "   "}), "/tmp")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Missing 'title'"));

        let err = tool
            .execute(json!({"title": "T"}), "/tmp")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Missing 'markdown'"));
    }
}
