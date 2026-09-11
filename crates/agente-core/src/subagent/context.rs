//! Subagent context forking and completion summaries.
//!
//! A child agent does not need the parent's full transcript. We keep a small
//! tail of self-contained context (plain assistant text + user messages) and
//! drop tool plumbing (tool calls + results), which would otherwise break
//! provider message validation when truncated mid-turn.

use crate::types::{Message, Role};

/// Maximum characters kept per message when forking.
const FORK_MAX_MESSAGE_CHARS: usize = 2000;
/// Maximum number of parent messages kept (excluding the injected system
/// prompt and the child's task prompt).
const FORK_MAX_MESSAGES: usize = 10;

/// Build the initial conversation for a child agent.
///
/// - Prepends a fresh system message with the child's system prompt.
/// - Forks the parent tail (plain text + user messages only; tool calls,
///   tool results, thinking, and system messages are dropped).
/// - Appends the child's task prompt as the first user message.
pub fn fork_subagent_context(
    parent_messages: &[Message],
    child_system_prompt: &str,
    child_prompt: &str,
) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::with_capacity(FORK_MAX_MESSAGES + 2);

    out.push(Message {
        role: Role::System,
        content: child_system_prompt.to_string(),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
    });

    let mut tail: Vec<Message> = Vec::new();
    for msg in parent_messages.iter().rev() {
        match msg.role {
            Role::System => continue,
            Role::Tool => continue,
            Role::Assistant => {
                // Messages with tool calls are only meaningful together with
                // their tool results; drop both to keep provider validation happy.
                if msg.tool_calls.is_some() {
                    continue;
                }
            }
            Role::User => {}
        }
        let mut m = msg.clone();
        m.thinking = None;
        m.thinking_signature = None;
        if m.content.len() > FORK_MAX_MESSAGE_CHARS {
            m.content = format!(
                "{}...\n[truncated for subagent context]",
                crate::util::truncate_at_char_boundary(&m.content, FORK_MAX_MESSAGE_CHARS)
            );
        }
        tail.push(m);
        if tail.len() >= FORK_MAX_MESSAGES {
            break;
        }
    }
    tail.reverse();
    out.extend(tail);

    out.push(Message {
        role: Role::User,
        content: child_prompt.to_string(),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
    });

    out
}

/// Cap a subagent's final output so the parent's context stays lean.
pub fn completion_summary(output: &str, max_chars: usize) -> String {
    let trimmed = output.trim();
    if trimmed.chars().count() > max_chars {
        let head: String = trimmed.chars().take(max_chars).collect();
        format!("{head}\n...\n[subagent output truncated]")
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(content: &str) -> Message {
        Message {
            role: Role::User,
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
        }
    }

    fn assistant(content: &str, with_tool_calls: bool) -> Message {
        Message {
            role: Role::Assistant,
            content: content.to_string(),
            tool_calls: if with_tool_calls {
                Some(vec![crate::types::ToolCall {
                    id: "c1".into(),
                    call_type: "function".into(),
                    function: crate::types::FunctionCall {
                        name: "read_file".into(),
                        arguments: "{}".into(),
                    },
                }])
            } else {
                None
            },
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
        }
    }

    #[test]
    fn fork_keeps_system_tail_and_prompt() {
        let parent = vec![
            Message {
                role: Role::System,
                content: "parent system".into(),
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
            },
            user("first user"),
            assistant("plain reply", false),
            assistant("tool reply", true),
            Message {
                role: Role::Tool,
                content: "tool result".into(),
                tool_calls: None,
                tool_call_id: Some("c1".into()),
                thinking: None,
                thinking_signature: None,
                continuation: None,
            },
            user("last user"),
        ];

        let forked = fork_subagent_context(&parent, "child system", "do the thing");

        assert_eq!(forked.len(), 5); // system + 3 plain tail messages + task prompt
        assert_eq!(forked[0].role, Role::System);
        assert_eq!(forked[0].content, "child system");
        assert_eq!(forked[1].content, "first user");
        assert_eq!(forked[2].content, "plain reply");
        assert_eq!(forked[3].content, "last user");
        assert_eq!(forked[4].role, Role::User);
        assert_eq!(forked[4].content, "do the thing");
        // No tool plumbing leaked into the child.
        assert!(!forked.iter().any(|m| m.role == Role::Tool));
        assert!(!forked
            .iter()
            .any(|m| m.role == Role::Assistant && m.tool_calls.is_some()));
    }

    #[test]
    fn completion_summary_caps_output() {
        let long = "x".repeat(5000);
        let capped = completion_summary(&long, 100);
        assert!(capped.contains("[subagent output truncated]"));
        assert!(capped.chars().count() < 200);

        let short = "done".to_string();
        assert_eq!(completion_summary(&short, 100), "done");
    }

    /// Byte 2000 falls inside a 3-byte char (2000 % 3 != 0); the old
    /// `&content[..2000]` panicked here.
    #[test]
    fn fork_truncates_long_unicode_without_panicking() {
        let payload = "日".repeat(1000);
        let parent = vec![user(&payload)];
        let forked = fork_subagent_context(&parent, "child system", "task");
        let forked_user = &forked[1];
        assert!(forked_user
            .content
            .ends_with("[truncated for subagent context]"));
        assert!(forked_user.content.len() <= FORK_MAX_MESSAGE_CHARS + 40);
        assert!(forked_user.content.starts_with('日'));
    }
}
