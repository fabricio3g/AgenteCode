//! Transcript normalization: boundary alignment, tool-exchange repair, and skill carry-over.

use std::collections::HashSet;

use crate::extensions::skills;
use crate::types::{Message, Role};

/// Return a recent-message boundary that never splits an assistant tool call
/// from its consecutive tool results.
pub(super) fn compaction_boundary(
    messages: &[Message],
    keep_recent: usize,
    minimum: usize,
) -> usize {
    let mut start = messages.len().saturating_sub(keep_recent).max(minimum);
    while start > minimum && matches!(messages.get(start).map(|m| &m.role), Some(Role::Tool)) {
        start -= 1;
    }
    start
}

/// Remove protocol-invalid tool messages and incomplete tool exchanges.
/// OpenAI-compatible APIs reject tool results without the directly preceding
/// assistant `tool_calls` message.
pub fn normalize_tool_messages(messages: Vec<Message>) -> Vec<Message> {
    normalize_tool_messages_tracked(messages).0
}

/// Same as `normalize_tool_messages`, additionally reporting whether anything
/// was dropped or padded (used to invalidate incremental token counts).
pub fn normalize_tool_messages_tracked(messages: Vec<Message>) -> (Vec<Message>, bool) {
    let mut input = messages.into_iter().peekable();
    let mut output = Vec::new();
    let mut changed = false;

    while let Some(message) = input.next() {
        if matches!(message.role, Role::Tool) {
            changed = true; // orphaned tool result dropped
            continue;
        }

        let Some(tool_calls) = message
            .tool_calls
            .as_ref()
            .filter(|calls| !calls.is_empty())
        else {
            output.push(message);
            continue;
        };

        let mut expected: HashSet<String> = tool_calls.iter().map(|call| call.id.clone()).collect();
        let mut tool_results = Vec::new();

        while matches!(input.peek().map(|m| &m.role), Some(Role::Tool)) {
            let tool_result = input.next().expect("peeked tool result");
            if tool_result
                .tool_call_id
                .as_ref()
                .is_some_and(|id| expected.remove(id))
            {
                tool_results.push(tool_result);
            } else {
                // A result with a stale/duplicate id is protocol noise — drop it.
                changed = true;
            }
        }

        if expected.is_empty() {
            output.push(message);
            output.extend(tool_results);
        } else if message.content.is_empty() && tool_results.is_empty() {
            // Nothing but un-answered tool calls: the exchange carries no
            // information — drop it entirely rather than pad it.
            changed = true;
        } else {
            changed = changed || !expected.is_empty();
            // Pad the missing results so the exchange stays protocol-valid
            // and the results that DID succeed survive. Stripping the whole
            // exchange used to erase the agent's progress mid-task.
            output.push(message);
            output.extend(tool_results);
            for id in expected {
                output.push(Message {
                    role: Role::Tool,
                    content: "Error: no result was recorded for this tool call (the turn was interrupted)."
                        .to_string(),
                    tool_calls: None,
                    tool_call_id: Some(id),
                    thinking: None,
                    thinking_signature: None,
                    continuation: None,
                    attachments: Vec::new(),
                });
            }
        }
    }

    (output, changed)
}

/// Stands in for the user turn compaction removed between two messages.
pub const COMPACTED_GAP_NOTE: &str = "[Earlier messages were compacted to save context.]";

/// Keep the transcript in an order strict providers accept after
/// compaction removed messages: the first turn after the system prompt is a
/// user turn, and two assistant turns never touch. A short user note fills
/// each gap (the removed turn) instead of guessing at what to merge.
pub(super) fn repair_role_order(messages: Vec<Message>) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::with_capacity(messages.len() + 1);
    for message in messages {
        if matches!(message.role, Role::Assistant)
            && out
                .last()
                .is_none_or(|prev| matches!(prev.role, Role::System | Role::Assistant))
        {
            out.push(Message::user(COMPACTED_GAP_NOTE));
        }
        out.push(message);
    }
    out
}

/// Merge runs of plain user messages into one turn (on a request copy):
/// reminders, a compaction summary, carried skills and queued messages can
/// otherwise reach the provider as several user turns in a row.
pub fn merge_consecutive_user_turns(messages: &mut Vec<Message>) {
    fn plain_user(message: &Message) -> bool {
        matches!(message.role, Role::User)
            && message.tool_call_id.is_none()
            && message.tool_calls.as_ref().is_none_or(Vec::is_empty)
    }
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());
    for message in messages.drain(..) {
        if let Some(last) = out.last_mut() {
            if plain_user(last) && plain_user(&message) {
                if !last.content.is_empty() && !message.content.is_empty() {
                    last.content.push_str("\n\n");
                }
                last.content.push_str(&message.content);
                last.attachments.extend(message.attachments);
                continue;
            }
        }
        out.push(message);
    }
    *messages = out;
}

pub(super) fn carries_skill(message: &Message) -> bool {
    message.content.contains(skills::SKILL_OPEN)
}

/// Heading of the message that re-attaches skills a compaction dropped.
pub const CARRIED_SKILLS_HEADING: &str = "Skills loaded earlier in this session remain in effect:";

/// Re-attach every skill block that was in `before` but did not survive
/// compaction whole (dropped, summarized away, or truncated), as one user
/// message after the system prompt and any summary. Losing a skill mid-task
/// silently degrades the agent, so its instructions always outlive trimming.
pub(super) fn carry_skills(before: &[Message], mut after: Vec<Message>) -> Vec<Message> {
    let mut lost: Vec<(String, String)> = Vec::new();
    for message in before.iter().filter(|m| carries_skill(m)) {
        for (name, block) in skills::skill_blocks(&message.content) {
            lost.retain(|(n, _)| *n != name);
            lost.push((name, block));
        }
    }
    lost.retain(|(_, block)| !after.iter().any(|m| m.content.contains(block.as_str())));
    if lost.is_empty() {
        return after;
    }
    let blocks: Vec<String> = lost.into_iter().map(|(_, block)| block).collect();
    let mut at = after
        .iter()
        .take_while(|m| matches!(m.role, Role::System))
        .count();
    if after
        .get(at)
        .is_some_and(|m| m.content.starts_with("[Conversation summary]"))
    {
        at += 1;
    }
    after.insert(
        at,
        Message {
            role: Role::User,
            content: format!("{CARRIED_SKILLS_HEADING}\n\n{}", blocks.join("\n\n")),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
    );
    after
}
