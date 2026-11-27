//! Approval-request construction and missing-argument validation.

use super::ToolCallOutcome;
use crate::permissions::{is_dangerous_command, shell_outside_paths, OUTSIDE_PROJECT_PREFIX};
use crate::types::{ApprovalRequest, ToolCall};

fn target_path_for_approval(tool_name: &str, args: &serde_json::Value) -> Option<String> {
    if let Some(path) = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(path.to_string());
    }
    if tool_name == "apply_patch" {
        return args
            .get("patch")
            .and_then(|v| v.as_str())
            .and_then(crate::tools::patch::extract_target_file_from_patch);
    }
    None
}

pub(crate) async fn build_approval_request(
    tool_call: &ToolCall,
    args: &serde_json::Value,
    project_dir: &str,
) -> ApprovalRequest {
    let tool_name = tool_call.function.name.clone();
    let file_path = target_path_for_approval(&tool_name, args);
    let is_dangerous = if tool_name == "shell" {
        args.get("command")
            .and_then(|v| v.as_str())
            .map(is_dangerous_command)
            .unwrap_or(false)
    } else {
        false
    };

    let (old_content, new_content) = approval_diff_preview(&tool_name, args, project_dir).await;
    let description = match tool_name.as_str() {
        "shell" => args
            .get("command")
            .and_then(|v| v.as_str())
            .map(|cmd| {
                // Say why a safe-looking command is asking: it reaches past
                // the project root, or a path in it cannot be decided.
                let outside = shell_outside_paths(cmd, Some(std::path::Path::new(project_dir)));
                if outside.is_empty() {
                    format!("Run command: {cmd}")
                } else {
                    format!(
                        "{OUTSIDE_PROJECT_PREFIX}{} · Run command: {cmd}",
                        outside.join(", ")
                    )
                }
            })
            .unwrap_or_else(|| "Run shell command".to_string()),
        "write_file" => file_path
            .as_ref()
            .map(|path| format!("Write {path}"))
            .unwrap_or_else(|| "Write file".to_string()),
        "edit_file" => file_path
            .as_ref()
            .map(|path| format!("Edit {path}"))
            .unwrap_or_else(|| "Edit file".to_string()),
        "apply_patch" => file_path
            .as_ref()
            .map(|path| format!("Apply patch to {path}"))
            .unwrap_or_else(|| "Apply patch".to_string()),
        _ => format!("Run {tool_name}"),
    };

    ApprovalRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        tool_name: tool_name.clone(),
        tool_args: tool_call.function.arguments.clone(),
        description,
        is_dangerous,
        old_content,
        new_content,
        file_path,
    }
}

pub(crate) async fn approval_diff_preview(
    tool_name: &str,
    args: &serde_json::Value,
    project_dir: &str,
) -> (Option<String>, Option<String>) {
    let Some(path) = target_path_for_approval(tool_name, args) else {
        return (None, None);
    };

    let Ok(resolved) = crate::tools::resolve_project_path(&path, project_dir) else {
        return (None, None);
    };

    match tool_name {
        "write_file" => {
            let old = tokio::fs::read_to_string(&resolved)
                .await
                .unwrap_or_default();
            let new = args
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            (Some(old), Some(new))
        }
        "edit_file" => {
            let Ok(old) = tokio::fs::read_to_string(&resolved).await else {
                return (None, None);
            };
            let first_edit = args
                .get("edits")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first());
            let search = args.get("search").and_then(|v| v.as_str()).or_else(|| {
                first_edit
                    .and_then(|e| e.get("oldText").or_else(|| e.get("old_text")))
                    .and_then(|v| v.as_str())
            });
            let replace = args.get("replace").and_then(|v| v.as_str()).or_else(|| {
                first_edit
                    .and_then(|e| e.get("newText").or_else(|| e.get("new_text")))
                    .and_then(|v| v.as_str())
            });
            let Some(search) = search else {
                return (None, None);
            };
            let Some(replace) = replace else {
                return (None, None);
            };
            if !old.contains(search) {
                return (Some(old), None);
            }
            let new = old.replacen(search, replace, 1);
            (Some(old), Some(new))
        }
        _ => (None, None),
    }
}

pub(crate) fn check_missing_args(
    tool_call_id: &str,
    tool_name: &str,
    args: &serde_json::Value,
) -> Option<ToolCallOutcome> {
    let mut missing: Vec<&str> = Vec::new();
    match tool_name {
        "read_file" | "file_outline" | "list_dir" => {
            if is_missing_required_arg(args.get("path")) {
                missing.push("path");
            }
        }
        "write_file" => {
            if is_missing_required_arg(args.get("path")) {
                missing.push("path");
            }
            if is_missing_string_arg(args.get("content")) {
                missing.push("content");
            }
        }
        "apply_patch" => {
            if is_missing_required_arg(args.get("patch")) {
                missing.push("patch");
            }
        }
        "edit_file" => {
            if is_missing_required_arg(args.get("path")) {
                missing.push("path");
            }
            let has_single = !is_missing_required_arg(args.get("search"))
                && !is_missing_string_arg(args.get("replace"));
            let has_multi = args
                .get("edits")
                .and_then(|v| v.as_array())
                .map(|arr| !arr.is_empty())
                .unwrap_or(false);
            if !has_single && !has_multi {
                if is_missing_required_arg(args.get("search")) {
                    missing.push("search");
                }
                if is_missing_string_arg(args.get("replace")) {
                    missing.push("replace");
                }
            }
        }
        "shell" => {
            if is_missing_required_arg(args.get("command")) {
                missing.push("command");
            }
        }
        "grep" | "find" => {
            if is_missing_required_arg(args.get("pattern")) {
                missing.push("pattern");
            }
        }
        "todo_write" => {
            if is_missing_required_arg(args.get("todos")) {
                missing.push("todos");
            }
        }
        _ => {}
    }

    if !missing.is_empty() {
        return Some(ToolCallOutcome::error(
            tool_call_id,
            tool_name,
            format!("Missing required arguments: {}", missing.join(", ")),
        ));
    }
    None
}

fn is_missing_string_arg(value: Option<&serde_json::Value>) -> bool {
    !matches!(value, Some(serde_json::Value::String(_)))
}

pub(crate) fn is_missing_required_arg(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(s)) => s.trim().is_empty(),
        Some(serde_json::Value::Array(items)) => items.is_empty(),
        Some(serde_json::Value::Object(obj)) => obj.is_empty(),
        Some(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn write_file_allows_empty_content_and_rejects_null_or_missing() {
        assert!(check_missing_args(
            "c1",
            "write_file",
            &json!({ "path": ".gitkeep", "content": "" })
        )
        .is_none());
        assert!(check_missing_args("c2", "write_file", &json!({ "path": "a.txt" })).is_some());
        assert!(check_missing_args(
            "c3",
            "write_file",
            &json!({ "path": "a.txt", "content": null })
        )
        .is_some());
    }

    #[test]
    fn edit_file_allows_empty_replace_deletion_and_rejects_empty_search() {
        assert!(check_missing_args(
            "c1",
            "edit_file",
            &json!({ "path": "a.rs", "search": "dead_code", "replace": "" })
        )
        .is_none());
        assert!(check_missing_args(
            "c2",
            "edit_file",
            &json!({ "path": "a.rs", "search": "", "replace": "x" })
        )
        .is_some());
        assert!(check_missing_args(
            "c3",
            "edit_file",
            &json!({ "path": "a.rs", "search": "dead_code" })
        )
        .is_some());
    }
}
