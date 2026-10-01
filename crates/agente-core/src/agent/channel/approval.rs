//! Approval-request construction and missing-argument validation.

use super::ToolCallOutcome;
use crate::permissions::is_dangerous_command;
use crate::types::{ApprovalRequest, ToolCall};

pub(crate) async fn build_approval_request(
    tool_call: &ToolCall,
    args: &serde_json::Value,
    project_dir: &str,
) -> ApprovalRequest {
    let tool_name = tool_call.function.name.clone();
    let file_path = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
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
            .map(|cmd| format!("Run command: {cmd}"))
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
    let Some(path) = args.get("path").and_then(|v| v.as_str()) else {
        return (None, None);
    };

    let Ok(resolved) = crate::tools::resolve_project_path(path, project_dir) else {
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
    let required = match tool_name {
        "read_file" | "file_outline" | "list_dir" => vec!["path"],
        "write_file" => vec!["path", "content"],
        "apply_patch" => vec!["patch"],
        "edit_file" => {
            let has_single = !is_missing_required_arg(args.get("search"))
                && !is_missing_required_arg(args.get("replace"));
            let has_multi = args
                .get("edits")
                .and_then(|v| v.as_array())
                .map(|arr| !arr.is_empty())
                .unwrap_or(false);
            if has_single || has_multi {
                vec!["path"]
            } else {
                vec!["path", "search", "replace"]
            }
        }
        "shell" => vec!["command"],
        "grep" => vec!["pattern"],
        "find" => vec!["pattern"],
        "todo_write" => vec!["todos"],
        _ => vec![],
    };

    let missing: Vec<&str> = required
        .iter()
        .filter(|name| is_missing_required_arg(args.get(**name)))
        .copied()
        .collect();

    if !missing.is_empty() {
        return Some(ToolCallOutcome {
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            content: format!("Error: Missing required arguments: {}", missing.join(", ")),
            is_error: true,
            path_changed: None,
            changed_path: None,
            file_before: None,
            file_after: None,
            todos: None,
            attachments: Vec::new(),
        });
    }
    None
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
