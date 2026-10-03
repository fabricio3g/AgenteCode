//! Explicit subagent handoffs and complete final results.
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

/// Preserve the child's complete answer. Display previews and context
/// compaction have their own limits; neither may silently clip this handoff.
pub fn completion_output(output: &str) -> String {
    output.trim().to_string()
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
    fn completion_output_preserves_findings_at_the_end() {
        let output = format!("{}\nAcceptance criteria verified.", "日".repeat(10000));
        assert_eq!(completion_output(&output), output);
        assert_eq!(completion_output(" done "), "done");
    }
}
