//! Post-turn todo review helper: reminds the model once to check unfinished
//! todos before ending a turn, without turning into a hard completion gate.

use crate::types::{Message, Role};

pub(super) const TODO_REVIEW_PROMPT: &str = "Before finishing, review the current todo list against the user's request. Complete remaining relevant work if possible, and update each status to reflect what was actually done. If work is blocked, needs user input, or is no longer relevant, say so; never mark it complete without doing it.";

pub(super) fn should_review_todos(
    todos: Option<&[crate::todo::TodoInput]>,
    reviewed: bool,
    cancelled: bool,
    plan_mode: bool,
    has_iteration: bool,
) -> bool {
    !reviewed
        && !cancelled
        && !plan_mode
        && has_iteration
        && todos.is_some_and(|items| {
            items
                .iter()
                .any(|todo| !matches!(todo.status.as_str(), "completed" | "cancelled"))
        })
}

/// Insert the request-only todo review prompt into `messages` at `index`,
/// advancing past any `Role::Tool` messages so an assistant/tool exchange is
/// never split. Returns the estimated token cost of the injected message.
pub(super) fn inject_todo_review(messages: &mut Vec<Message>, index: usize) -> usize {
    let mut insert_at = index.min(messages.len());
    while insert_at < messages.len() && messages[insert_at].role == Role::Tool {
        insert_at += 1;
    }
    let note = Message::user(TODO_REVIEW_PROMPT);
    let cost = crate::context::budget::estimated_message_cost(&note);
    messages.insert(insert_at, note);
    cost
}
