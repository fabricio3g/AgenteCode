//! Pure mapping from runtime events to ACP v1 payloads.
//!
//! `RuntimeEventEnvelope`s are runtime vocabulary; real ACP clients speak
//! `session/update` (`{"sessionUpdate": …}`) and `session/request_permission`.
//! Everything here is side-effect free so the shapes are testable directly.

use agente_protocol::{ApprovalDecisionKind, RuntimeEvent, SessionId};
use serde_json::{json, Value};

/// Maximum characters kept of any single argument value in a tool title.
const TITLE_SUMMARY_CHARS: usize = 64;

/// A text content block (the only kind the text-only runtime conversation
/// produces).
fn text_content(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

/// ACP `ToolKind` for a runtime tool name: read → "read", write/edit → "edit",
/// shell → "execute", grep/find/glob → "search", everything else "other".
pub(crate) fn tool_kind(name: &str) -> &'static str {
    let name = name.to_ascii_lowercase();
    if name.starts_with("read") {
        "read"
    } else if name.starts_with("write") || name.starts_with("edit") {
        "edit"
    } else if name.starts_with("shell") || name == "bash" {
        "execute"
    } else if name.starts_with("grep") || name.starts_with("find") || name.starts_with("glob") {
        "search"
    } else {
        "other"
    }
}

/// Truncate a string on a char boundary, appending an ellipsis when cut.
fn shorten(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{head}…")
}

/// Human title for a tool call: the tool name plus a short summary of its most
/// descriptive argument. Unparseable arguments degrade to the bare name.
pub(crate) fn tool_title(name: &str, arguments: &str) -> String {
    let summary = serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|value| {
            let object = value.as_object()?;
            [
                "path",
                "file_path",
                "command",
                "query",
                "pattern",
                "url",
                "description",
            ]
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_str))
            .map(|text| shorten(text, TITLE_SUMMARY_CHARS))
        });
    match summary {
        Some(summary) => format!("{name} {summary}"),
        None => name.to_string(),
    }
}

/// Map a todo status string onto the ACP plan-entry vocabulary
/// (`pending` / `in_progress` / `completed`). The runtime also emits
/// `cancelled`, for which ACP has no terminal-negative status: such entries
/// stay on the pending row (neither active nor completed).
fn plan_status(raw: &str) -> &'static str {
    match raw.to_ascii_lowercase().as_str() {
        "in_progress" | "inprogress" | "in-progress" | "active" | "current" => "in_progress",
        "completed" | "done" | "finished" => "completed",
        _ => "pending",
    }
}

/// Map a todo priority string onto `high` / `medium` / `low`.
fn plan_priority(raw: &str) -> &'static str {
    match raw.to_ascii_lowercase().as_str() {
        "high" => "high",
        "low" => "low",
        _ => "medium",
    }
}

/// Build the ACP `plan` update from the todo JSON emitted by the runtime
/// (`[{id, content, status, priority}, …]`). Unknown shapes degrade to an
/// empty plan rather than failing the stream.
pub(crate) fn plan_update(todos: &Value) -> Value {
    let entries: Vec<Value> = todos
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let content = ["content", "text", "description"]
                        .iter()
                        .find_map(|key| item.get(*key).and_then(Value::as_str))
                        .unwrap_or("");
                    let status = item
                        .get("status")
                        .and_then(Value::as_str)
                        .map(plan_status)
                        .unwrap_or("pending");
                    let priority = item
                        .get("priority")
                        .and_then(Value::as_str)
                        .map(plan_priority)
                        .unwrap_or("medium");
                    json!({ "content": content, "priority": priority, "status": status })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "sessionUpdate": "plan", "entries": entries })
}

/// The `update` object for a runtime event, or `None` when the event has no
/// ACP representation. `ApprovalRequested` returns `None` here because it is
/// handled by the dedicated `session/request_permission` flow; text deltas are
/// forwarded, whole assistant messages are skipped (the deltas already carry
/// them).
pub(crate) fn update_for_event(event: &RuntimeEvent) -> Option<Value> {
    let update = match event {
        RuntimeEvent::AssistantDelta { text } => {
            json!({ "sessionUpdate": "agent_message_chunk", "content": text_content(text) })
        }
        RuntimeEvent::ReasoningDelta { text } => {
            json!({ "sessionUpdate": "agent_thought_chunk", "content": text_content(text) })
        }
        RuntimeEvent::ToolProposed {
            id,
            name,
            arguments,
        } => json!({
            "sessionUpdate": "tool_call",
            "toolCallId": id,
            "title": tool_title(name, arguments),
            "kind": tool_kind(name),
            "status": "pending"
        }),
        RuntimeEvent::ToolProgress { id, .. } => json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": id,
            "status": "in_progress"
        }),
        RuntimeEvent::ToolResult {
            id,
            content,
            is_error,
            ..
        } => {
            let mut update = json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": id,
                "status": if *is_error { "failed" } else { "completed" }
            });
            if !content.is_empty() {
                update["content"] = json!([
                    { "type": "content", "content": text_content(content) }
                ]);
            }
            update
        }
        RuntimeEvent::TodoChanged { todos } => plan_update(todos),
        RuntimeEvent::TurnFinished { .. }
        | RuntimeEvent::TurnCancelled { .. }
        | RuntimeEvent::TurnFailed { .. } => json!({ "sessionUpdate": "turn_finished" }),
        RuntimeEvent::TurnStarted
        | RuntimeEvent::Thinking
        | RuntimeEvent::AssistantMessage { .. }
        | RuntimeEvent::ToolHeartbeat { .. }
        | RuntimeEvent::ApprovalRequested { .. }
        | RuntimeEvent::FileChanged { .. }
        | RuntimeEvent::ChildStarted { .. }
        | RuntimeEvent::ChildDelta { .. }
        | RuntimeEvent::ChildTool { .. }
        | RuntimeEvent::ChildFinished { .. }
        | RuntimeEvent::ContextCompacted { .. }
        | RuntimeEvent::ContextBudget { .. }
        | RuntimeEvent::Usage { .. }
        | RuntimeEvent::Retry { .. }
        | RuntimeEvent::SteeringQueued
        | RuntimeEvent::CallUsage { .. }
        | RuntimeEvent::UserMessagesInjected { .. }
        | RuntimeEvent::CompactionStarted { .. }
        | RuntimeEvent::GenerationProgress { .. }
        | RuntimeEvent::ChildCompletedNotice { .. }
        | RuntimeEvent::Diagnostic { .. } => return None,
    };
    Some(update)
}

/// `session/update` notification params for a session.
pub(crate) fn session_update_params(session_id: SessionId, update: Value) -> Value {
    json!({ "sessionId": session_id.to_string(), "update": update })
}

/// `session/request_permission` params: the pending tool call plus the three
/// options the runtime's approval model supports. The runtime's approval
/// `request_id` doubles as the `toolCallId` so outcomes correlate on the wire.
pub(crate) fn request_permission_params(
    session_id: SessionId,
    request_id: &str,
    tool_name: &str,
    tool_args: &str,
) -> Value {
    json!({
        "sessionId": session_id.to_string(),
        "toolCall": {
            "toolCallId": request_id,
            "title": tool_title(tool_name, tool_args),
            "kind": tool_kind(tool_name),
            "status": "pending"
        },
        "options": [
            { "optionId": "allow_once",   "name": "Allow once",   "kind": "allow_once" },
            { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
            { "optionId": "reject_once",  "name": "Reject",       "kind": "reject_once" }
        ]
    })
}

/// Translate a client's `session/request_permission` response into the runtime
/// decision. Error responses and cancelled outcomes cancel the request; an
/// unknown selected option fails closed to `Deny`.
pub(crate) fn decision_from_response(
    response: Option<&Value>,
    failed: bool,
) -> ApprovalDecisionKind {
    if failed {
        return ApprovalDecisionKind::Cancel;
    }
    let Some(result) = response else {
        return ApprovalDecisionKind::Cancel;
    };
    let outcome = result.get("outcome");
    match outcome
        .and_then(|outcome| outcome.get("outcome"))
        .and_then(Value::as_str)
    {
        Some("selected") => {
            let option_id = outcome
                .and_then(|outcome| outcome.get("optionId"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            match option_id {
                "allow_once" | "approve_once" => ApprovalDecisionKind::ApproveOnce,
                "allow_always" | "approve_all" => ApprovalDecisionKind::ApproveAll,
                "reject_once" | "reject_always" | "deny" => ApprovalDecisionKind::Deny,
                _ => ApprovalDecisionKind::Deny,
            }
        }
        // `cancelled` and any unrecognized shape abandon the request.
        _ => ApprovalDecisionKind::Cancel,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_protocol::RuntimeEvent;

    fn update_of(event: RuntimeEvent) -> Value {
        update_for_event(&event).expect("event must map to an update")
    }

    #[test]
    fn assistant_delta_maps_to_message_chunk() {
        let update = update_of(RuntimeEvent::AssistantDelta { text: "hi".into() });
        assert_eq!(update["sessionUpdate"], "agent_message_chunk");
        assert_eq!(update["content"], json!({ "type": "text", "text": "hi" }));
    }

    #[test]
    fn reasoning_delta_maps_to_thought_chunk() {
        let update = update_of(RuntimeEvent::ReasoningDelta { text: "hmm".into() });
        assert_eq!(update["sessionUpdate"], "agent_thought_chunk");
        assert_eq!(update["content"], json!({ "type": "text", "text": "hmm" }));
    }

    #[test]
    fn tool_proposed_maps_to_pending_tool_call() {
        let update = update_of(RuntimeEvent::ToolProposed {
            id: "t1".into(),
            name: "shell".into(),
            arguments: r#"{"command":"cargo test"}"#.into(),
        });
        assert_eq!(update["sessionUpdate"], "tool_call");
        assert_eq!(update["toolCallId"], "t1");
        assert_eq!(update["kind"], "execute");
        assert_eq!(update["status"], "pending");
        assert_eq!(update["title"], "shell cargo test");
    }

    #[test]
    fn tool_progress_and_result_map_to_tool_call_updates() {
        let progress = update_of(RuntimeEvent::ToolProgress {
            id: "t1".into(),
            chunk: "running".into(),
        });
        assert_eq!(progress["sessionUpdate"], "tool_call_update");
        assert_eq!(progress["toolCallId"], "t1");
        assert_eq!(progress["status"], "in_progress");

        let result = update_of(RuntimeEvent::ToolResult {
            id: "t1".into(),
            name: "shell".into(),
            content: "done".into(),
            is_error: false,
        });
        assert_eq!(result["sessionUpdate"], "tool_call_update");
        assert_eq!(result["status"], "completed");
        assert_eq!(result["content"][0]["type"], "content");
        assert_eq!(result["content"][0]["content"]["text"], "done");

        let failed = update_of(RuntimeEvent::ToolResult {
            id: "t1".into(),
            name: "shell".into(),
            content: "boom".into(),
            is_error: true,
        });
        assert_eq!(failed["status"], "failed");
    }

    #[test]
    fn empty_tool_results_omit_content() {
        let result = update_of(RuntimeEvent::ToolResult {
            id: "t1".into(),
            name: "shell".into(),
            content: String::new(),
            is_error: false,
        });
        assert!(result.get("content").is_none());
    }

    #[test]
    fn todos_map_to_plan_entries() {
        let todos = json!([
            { "id": "1", "content": "first", "status": "InProgress", "priority": "High" },
            { "id": "2", "content": "second", "status": "completed", "priority": "Low" },
            { "id": "3", "content": "third", "status": "Cancelled", "priority": "Medium" }
        ]);
        let update = update_of(RuntimeEvent::TodoChanged { todos });
        assert_eq!(update["sessionUpdate"], "plan");
        let entries = update["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["content"], "first");
        assert_eq!(entries[0]["status"], "in_progress");
        assert_eq!(entries[0]["priority"], "high");
        assert_eq!(entries[1]["status"], "completed");
        assert_eq!(entries[1]["priority"], "low");
        // Cancelled steps are neither active nor completed in ACP.
        assert_eq!(entries[2]["status"], "pending");
    }

    #[test]
    fn malformed_todos_degrade_to_an_empty_plan() {
        for todos in [Value::Null, json!("nope"), json!({"items": []})] {
            let update = plan_update(&todos);
            assert_eq!(update["sessionUpdate"], "plan");
            assert_eq!(update["entries"], json!([]));
        }
    }

    #[test]
    fn terminal_events_map_to_turn_finished() {
        for event in [
            RuntimeEvent::TurnFinished { revision: 1 },
            RuntimeEvent::TurnCancelled {
                revision: 1,
                partial_text: "p".into(),
            },
            RuntimeEvent::TurnFailed {
                message: "m".into(),
            },
        ] {
            assert_eq!(update_of(event)["sessionUpdate"], "turn_finished");
        }
    }

    #[test]
    fn unrepresented_events_are_skipped() {
        let events = [
            RuntimeEvent::TurnStarted,
            RuntimeEvent::Thinking,
            RuntimeEvent::AssistantMessage {
                text: "whole".into(),
            },
            RuntimeEvent::ToolHeartbeat { id: "t".into() },
            RuntimeEvent::FileChanged {
                path: "p".into(),
                summary: "s".into(),
                before: None,
                after: None,
            },
            RuntimeEvent::ApprovalRequested {
                request_id: "r".into(),
                source: "parent".into(),
                tool_name: "shell".into(),
                tool_args: "{}".into(),
                description: "d".into(),
                is_dangerous: false,
                file_path: None,
                child_run_id: None,
                old_content: None,
                new_content: None,
            },
            RuntimeEvent::ContextCompacted {
                summary: "s".into(),
                revision: 1,
                tokens_before: 0,
                tokens_after: 0,
                smart: false,
            },
            RuntimeEvent::Usage {
                usage: agente_protocol::Usage::default(),
            },
            RuntimeEvent::Retry {
                attempt: 1,
                max_attempts: 3,
                delay_ms: 100,
            },
            RuntimeEvent::SteeringQueued,
            RuntimeEvent::Diagnostic {
                message: "m".into(),
            },
        ];
        for event in events {
            assert!(
                update_for_event(&event).is_none(),
                "event should be skipped: {event:?}"
            );
        }
    }

    #[test]
    fn tool_kinds_follow_the_vocabulary() {
        assert_eq!(tool_kind("read_file"), "read");
        assert_eq!(tool_kind("ReadFile"), "read");
        assert_eq!(tool_kind("write_file"), "edit");
        assert_eq!(tool_kind("edit_file"), "edit");
        assert_eq!(tool_kind("shell"), "execute");
        assert_eq!(tool_kind("grep"), "search");
        assert_eq!(tool_kind("find"), "search");
        assert_eq!(tool_kind("glob"), "search");
        assert_eq!(tool_kind("list_dir"), "other");
        assert_eq!(tool_kind("web_fetch"), "other");
        assert_eq!(tool_kind("todo_write"), "other");
    }

    #[test]
    fn tool_title_summarizes_arguments() {
        assert_eq!(
            tool_title("read_file", r#"{"path":"src/main.rs"}"#),
            "read_file src/main.rs"
        );
        assert_eq!(tool_title("shell", "not json"), "shell");
        assert_eq!(tool_title("grep", r#"{"unknown_key":1}"#), "grep");
        let long = "x".repeat(200);
        let title = tool_title("grep", &format!(r#"{{"pattern":"{long}"}}"#));
        assert!(title.chars().count() <= TITLE_SUMMARY_CHARS + "grep ".len());
        assert!(title.ends_with('…'));
    }

    #[test]
    fn permission_params_shape() {
        let session = SessionId::new();
        let params = request_permission_params(session, "req-1", "shell", r#"{"command":"ls"}"#);
        assert_eq!(params["sessionId"], session.to_string());
        assert_eq!(params["toolCall"]["toolCallId"], "req-1");
        assert_eq!(params["toolCall"]["kind"], "execute");
        assert_eq!(params["toolCall"]["status"], "pending");
        let kinds: Vec<&str> = params["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|option| option["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["allow_once", "allow_always", "reject_once"]);
    }

    #[test]
    fn decisions_from_client_responses() {
        let selected =
            |option: &str| json!({ "outcome": { "outcome": "selected", "optionId": option } });
        assert_eq!(
            decision_from_response(Some(&selected("allow_once")), false),
            ApprovalDecisionKind::ApproveOnce
        );
        assert_eq!(
            decision_from_response(Some(&selected("allow_always")), false),
            ApprovalDecisionKind::ApproveAll
        );
        assert_eq!(
            decision_from_response(Some(&selected("reject_once")), false),
            ApprovalDecisionKind::Deny
        );
        // Unknown options fail closed.
        assert_eq!(
            decision_from_response(Some(&selected("gibberish")), false),
            ApprovalDecisionKind::Deny
        );
        let cancelled = json!({ "outcome": { "outcome": "cancelled" } });
        assert_eq!(
            decision_from_response(Some(&cancelled), false),
            ApprovalDecisionKind::Cancel
        );
        assert_eq!(
            decision_from_response(Some(&json!({})), false),
            ApprovalDecisionKind::Cancel
        );
        assert_eq!(
            decision_from_response(None, false),
            ApprovalDecisionKind::Cancel
        );
        // An error response (e.g. the client does not support the method) cancels.
        assert_eq!(
            decision_from_response(Some(&selected("allow_once")), true),
            ApprovalDecisionKind::Cancel
        );
    }

    #[test]
    fn session_update_params_carry_session_and_update() {
        let session = SessionId::new();
        let params = session_update_params(session, json!({ "sessionUpdate": "plan" }));
        assert_eq!(params["sessionId"], session.to_string());
        assert_eq!(params["update"]["sessionUpdate"], "plan");
    }
}
