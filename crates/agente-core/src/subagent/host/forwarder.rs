//! Child event forwarder and worktree settlement on completion.

use crate::agent::events::{AgentEvent, AgentTaskEvent};
use crate::subagent::context::completion_output;
use crate::subagent::registry::bound_conversation;
use crate::subagent::types::SubagentStatus;
use crate::subagent::worktree;
use crate::types::Role;

use super::SubagentHost;

/// Decide whether a terminal child event deserves a push completion notice:
/// background spawn, nobody holding the completion signal, and the model
/// never received the terminal result through another path.
pub(super) fn should_notify_completion(
    background: bool,
    receiver_count: usize,
    observed: bool,
) -> bool {
    background && receiver_count == 0 && !observed
}

/// Push a completion notice for a terminal child when no waiter can receive
/// the result inline (background spawn nobody polled). Fire-and-forget
/// spawns would otherwise finish silently and the model would never learn
/// the outcome without polling.
pub(super) fn maybe_notify_completion(
    host: &SubagentHost,
    id: &str,
    status: SubagentStatus,
    summary: &str,
) {
    let (background, subagent_type) = match host.inner.registry.get(id) {
        Some(snap) => (snap.background, snap.subagent_type),
        None => return,
    };
    if !should_notify_completion(
        background,
        host.inner.registry.receiver_count(id),
        host.inner.registry.was_observed(id),
    ) {
        return;
    }
    let _ = host.inner.config.event_sender.send(AgentTaskEvent {
        task_id: host.inner.config.task_id,
        event: AgentEvent::SubagentCompletedNotice {
            id: id.to_string(),
            subagent_type,
            status: status.as_str().to_string(),
            summary: summary.to_string(),
        },
    });
}

/// How many bytes of a finished message the parent has not seen yet.
///
/// A streaming provider reports the same reply twice: once as deltas, once as
/// the finished message. `streamed` holds the deltas of the message in flight,
/// so a finished message that starts with it only needs its tail forwarded.
pub(super) fn unsent_remainder(finished: &str, streamed: &str) -> usize {
    if finished.starts_with(streamed) {
        streamed.len()
    } else {
        0
    }
}

/// Translate a child's private event stream into `AgentEvent::Subagent*`
/// events on the parent's channel, and record the final transcript. Runs on a
/// dedicated OS thread: the receive and the sends are blocking, and must not
/// occupy an async executor worker.
pub(super) fn forward_child_events(
    child_rx: std::sync::mpsc::Receiver<AgentTaskEvent>,
    host: SubagentHost,
    subagent_id: String,
) {
    let parent_sender = host.inner.config.event_sender.clone();
    let parent_task_id = host.inner.config.task_id;
    let mut full_text = String::new();
    let mut streamed_message = String::new();
    const PROGRESS_EVERY_BYTES: usize = 1024;
    let mut published_at = 0usize;

    let send = |event: AgentEvent| {
        let _ = parent_sender.send(AgentTaskEvent {
            task_id: parent_task_id,
            event,
        });
    };

    while let Ok(task_event) = child_rx.recv() {
        match task_event.event {
            AgentEvent::TextDelta(delta) => {
                streamed_message.push_str(&delta);
                full_text.push_str(&delta);
                send(AgentEvent::SubagentText {
                    id: subagent_id.clone(),
                    text: delta,
                });
                if full_text.len().saturating_sub(published_at) >= PROGRESS_EVERY_BYTES {
                    published_at = full_text.len();
                    host.inner.registry.set_progress(&subagent_id, &full_text);
                }
            }
            AgentEvent::AssistantText(text) => {
                full_text = text.clone();
                published_at = full_text.len();
                host.inner.registry.set_progress(&subagent_id, &full_text);
                let already = unsent_remainder(&text, &streamed_message);
                streamed_message.clear();
                let remainder = text[already..].to_string();
                if !remainder.is_empty() {
                    send(AgentEvent::SubagentText {
                        id: subagent_id.clone(),
                        text: remainder,
                    });
                }
            }
            AgentEvent::ToolCallStart { id, name, args } => {
                send(AgentEvent::SubagentToolCallStart {
                    id: subagent_id.clone(),
                    call_id: id,
                    name,
                    args,
                });
            }
            AgentEvent::ToolCallProgress { id, chunk } => {
                send(AgentEvent::SubagentToolCallProgress {
                    id: subagent_id.clone(),
                    call_id: id,
                    chunk,
                });
            }
            AgentEvent::ToolHeartbeat { id } => {
                send(AgentEvent::ToolHeartbeat { id });
            }
            AgentEvent::ToolCallResult {
                id,
                name,
                result,
                is_error,
            } => {
                send(AgentEvent::SubagentToolCallResult {
                    id: subagent_id.clone(),
                    call_id: id,
                    name,
                    result,
                    is_error,
                });
            }
            AgentEvent::TodoUpdate { todos, .. } => {
                send(AgentEvent::TodoUpdate {
                    subagent_id: Some(subagent_id.clone()),
                    todos,
                });
            }
            AgentEvent::FileChange {
                path,
                diff_summary,
                before,
                after,
                ..
            } => {
                send(AgentEvent::FileChange {
                    subagent_id: Some(subagent_id.clone()),
                    path,
                    diff_summary,
                    before,
                    after,
                });
            }
            AgentEvent::ApprovalRequested { source: _, request } => {
                send(AgentEvent::ApprovalRequested {
                    source: crate::agent::ApprovalSource::Subagent {
                        id: subagent_id.clone(),
                    },
                    request,
                });
            }
            AgentEvent::CompactionStarted { .. } => {}
            AgentEvent::ContextCompacted { summary, .. } => {
                send(AgentEvent::SubagentText {
                    id: subagent_id.clone(),
                    text: format!("[context compacted] {summary}"),
                });
            }
            AgentEvent::GenerationProgress {
                output_bytes,
                tool_name,
                ..
            } => {
                send(AgentEvent::GenerationProgress {
                    subagent_id: Some(subagent_id.clone()),
                    output_bytes,
                    tool_name,
                });
            }
            AgentEvent::Done { conversation, .. } => {
                let summary = completion_output(
                    conversation
                        .iter()
                        .rev()
                        .find(|message| {
                            message.role == Role::Assistant && message.tool_calls.is_none()
                        })
                        .map(|message| message.content.as_str())
                        .unwrap_or(&full_text),
                );
                settle_worktree_blocking(&host, &subagent_id);
                host.inner.registry.finish(
                    &subagent_id,
                    SubagentStatus::Completed,
                    summary.clone(),
                    bound_conversation(conversation),
                );
                send(AgentEvent::SubagentDone {
                    id: subagent_id.clone(),
                    summary: summary.clone(),
                    is_error: false,
                });
                maybe_notify_completion(&host, &subagent_id, SubagentStatus::Completed, &summary);
                break;
            }
            AgentEvent::Cancelled {
                conversation,
                partial_text,
                ..
            } => {
                let timed_out = host.inner.registry.take_timed_out(&subagent_id);
                let (status, summary) = match timed_out {
                    Some(ms) => {
                        let note = format!(
                            "Subagent timed out after {}s of wall-clock time.",
                            ms / 1_000
                        );
                        let summary = if partial_text.trim().is_empty() {
                            format!(
                                "{note} Resume with resume_from:{subagent_id} if follow-up work is needed."
                            )
                        } else {
                            completion_output(&format!(
                                "{note}\nPartial output:\n{partial_text}\nResume with resume_from:{subagent_id}."
                            ))
                        };
                        (SubagentStatus::Failed, summary)
                    }
                    None => {
                        let summary = if partial_text.trim().is_empty() {
                            "cancelled".to_string()
                        } else {
                            completion_output(&partial_text)
                        };
                        (SubagentStatus::Cancelled, summary)
                    }
                };
                settle_worktree_blocking(&host, &subagent_id);
                host.inner.registry.finish(
                    &subagent_id,
                    status,
                    summary.clone(),
                    bound_conversation(conversation),
                );
                let is_error = status != SubagentStatus::Completed;
                send(AgentEvent::SubagentDone {
                    id: subagent_id.clone(),
                    summary: summary.clone(),
                    is_error,
                });
                maybe_notify_completion(&host, &subagent_id, status, &summary);
                break;
            }
            AgentEvent::Error {
                message: msg,
                conversation,
            } => {
                let summary = completion_output(&msg);
                settle_worktree_blocking(&host, &subagent_id);
                host.inner.registry.finish(
                    &subagent_id,
                    SubagentStatus::Failed,
                    summary.clone(),
                    bound_conversation(conversation),
                );
                send(AgentEvent::SubagentDone {
                    id: subagent_id.clone(),
                    summary: summary.clone(),
                    is_error: true,
                });
                maybe_notify_completion(&host, &subagent_id, SubagentStatus::Failed, &summary);
                break;
            }
            AgentEvent::CallUsage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                cost_usd,
                cost_estimated,
                subagent_id: nested,
            } => send(AgentEvent::CallUsage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                cost_usd,
                cost_estimated,
                subagent_id: nested.or_else(|| Some(subagent_id.clone())),
            }),
            AgentEvent::Thinking
            | AgentEvent::ReasoningDelta(_)
            | AgentEvent::TurnUsage { .. }
            | AgentEvent::ContextBudget { .. }
            | AgentEvent::UserMessagesInjected { .. }
            | AgentEvent::Retry { .. }
            | AgentEvent::ModelsDiscovered { .. }
            | AgentEvent::ModelDiscoveryFailed { .. }
            | AgentEvent::ModelCatalogUpdated { .. }
            | AgentEvent::SubagentStarted { .. }
            | AgentEvent::SubagentText { .. }
            | AgentEvent::SubagentToolCallStart { .. }
            | AgentEvent::SubagentToolCallProgress { .. }
            | AgentEvent::SubagentToolCallResult { .. }
            | AgentEvent::SubagentDone { .. }
            | AgentEvent::SubagentCompletedNotice { .. }
            | AgentEvent::BoardChanged { .. } => {}
        }
    }

    if let Some(snapshot) = host.inner.registry.get(&subagent_id) {
        if !snapshot.status.is_terminal() {
            settle_worktree_blocking(&host, &subagent_id);
            host.inner.registry.finish(
                &subagent_id,
                SubagentStatus::Failed,
                "Subagent ended without a result (child process error).".to_string(),
                Vec::new(),
            );
            send(AgentEvent::SubagentDone {
                id: subagent_id.clone(),
                summary: "Subagent ended without a result (child process error).".to_string(),
                is_error: true,
            });
            maybe_notify_completion(
                &host,
                &subagent_id,
                SubagentStatus::Failed,
                "Subagent ended without a result (child process error).",
            );
        }
    }
    host.board_child_finished(&subagent_id);
    host.try_start_queued();
}

/// Release a finished child's checkout before its terminal status is
/// published. A clean checkout returns to the warm pool; a dirty one stays on
/// disk for review with its flag flipped. Settling before `finish` means a
/// resume that sees the terminal status cannot race the release.
pub(super) fn settle_worktree_blocking(host: &SubagentHost, id: &str) -> bool {
    let Some(info) = host
        .inner
        .registry
        .get(id)
        .and_then(|snap| snap.worktree.clone())
    else {
        return true;
    };
    let clean = worktree::release_sync(&info);
    if !clean {
        host.inner.registry.update(id, |snap| {
            if let Some(wt) = snap.worktree.as_mut() {
                wt.dirty = true;
            }
        });
    }
    clean
}
