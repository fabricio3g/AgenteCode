//! Explicit subagent handoffs and bounded completion summaries.
//!
//! Fresh children receive their own system prompt and exactly the task prompt
//! authored by the delegating agent. Parent messages, tool results, reasoning,
//! and provider continuation metadata are never copied implicitly.

use crate::types::{Message, Role};

/// Build a fresh child conversation from an explicit handoff only.
/// Resuming a child's own transcript is handled separately by the host.
pub fn fork_subagent_context(child_system_prompt: &str, child_prompt: &str) -> Vec<Message> {
    [
        (Role::System, child_system_prompt),
        (Role::User, child_prompt),
    ]
    .into_iter()
    .map(|(role, content)| Message {
        role,
        content: content.to_string(),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    })
    .collect()
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

    #[test]
    fn fresh_child_receives_only_the_explicit_handoff() {
        let handoff = "Investigate src/auth.rs. Do not edit files. Return evidence and a fix plan.";
        let messages = fork_subagent_context("Read-only specialist", handoff);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, Role::System);
        assert_eq!(messages[0].content, "Read-only specialist");
        assert_eq!(messages[1].role, Role::User);
        assert_eq!(messages[1].content, handoff);
        for message in messages {
            assert!(message.tool_calls.is_none());
            assert!(message.tool_call_id.is_none());
            assert!(message.thinking.is_none());
            assert!(message.thinking_signature.is_none());
            assert!(message.continuation.is_none());
        }
    }

    #[test]
    fn explicit_handoff_is_not_silently_truncated() {
        let prompt = format!(
            "{}\nAcceptance criteria: all tests pass.",
            "日".repeat(3000)
        );
        assert_eq!(fork_subagent_context("system", &prompt)[1].content, prompt);
    }

    #[test]
    fn completion_summary_caps_output() {
        let capped = completion_summary(&"x".repeat(5000), 100);
        assert!(capped.contains("[subagent output truncated]"));
        assert!(capped.chars().count() < 200);
        assert_eq!(completion_summary("done", 100), "done");
    }
}
