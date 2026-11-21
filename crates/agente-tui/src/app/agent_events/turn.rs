//! Parent-turn event handling: streaming deltas, tools, usage, compaction,
//! approvals, and terminal turn settlement.

use agente_core::agent::AgentEvent;
use agente_core::types::{self, AgentState, Role};

use crate::app::App;

impl App {
    pub(super) fn apply_turn_event(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::Thinking => {
                self.state.agent.preparing_tool = None;
                if self.state.agent.thinking_start_time.is_none() {
                    self.state.agent.thinking_start_time = Some(chrono::Utc::now());
                }
                self.state.agent.streaming_text.clear();
                self.state.agent.reasoning_text.clear();
                self.state.ui.stream_markdown_cache.reset(0);
                self.state.agent.state = AgentState::StreamingResponse;
            }
            AgentEvent::AssistantText(text) => {
                self.state.agent.retry_status = None;
                self.state.agent.streaming_text.clear();
                self.state.ui.stream_markdown_cache.reset(0);
                self.state.add_assistant_message(text);
                self.state.agent.state = AgentState::Executing;
            }
            AgentEvent::TextDelta(delta) => {
                self.state.agent.retry_status = None;
                self.state.agent.streaming_text.push_str(&delta);
            }
            AgentEvent::ReasoningDelta(delta) => {
                self.state.agent.retry_status = None;
                self.state.agent.reasoning_text.push_str(&delta);
            }
            AgentEvent::GenerationProgress {
                subagent_id,
                tool_name,
                ..
            } => {
                if let Some(id) = subagent_id {
                    let child = self.subagent_card_or_placeholder(&id);
                    child.preparing_tool = tool_name;
                } else {
                    self.state.agent.preparing_tool = tool_name;
                    self.state.agent.retry_status = None;
                }
            }
            AgentEvent::Retry {
                attempt,
                max_attempts,
                ..
            } => {
                self.state.agent.retry_status = Some(crate::state::RetryStatus {
                    attempt,
                    max_attempts,
                });
            }
            AgentEvent::ToolCallStart { id, name, args } => {
                self.state.agent.preparing_tool = None;
                self.state.agent.current_tool_start = Some(std::time::Instant::now());
                let direct = id.starts_with("direct-");
                self.state
                    .agent
                    .start_live_tool(id, name.clone(), args.clone(), direct);
                if !direct && name != "todo_write" {
                    self.state.add_tool_call(name, args);
                }
            }
            AgentEvent::ToolCallProgress { id, chunk } => {
                self.state.agent.append_live_tool_output(&id, &chunk);
            }
            AgentEvent::ToolHeartbeat { .. } => {}
            AgentEvent::ToolCallResult {
                id,
                name,
                result,
                is_error,
            } => {
                self.handle_tool_call_result(id, name, result, is_error);
            }
            AgentEvent::FileChange {
                subagent_id,
                path,
                diff_summary: _,
                before,
                after,
            } => {
                if let Some(id) = subagent_id {
                    if !self.subagent_shares_parent_workspace(&id) {
                        return;
                    }
                }
                let stats = crate::state::diff_line_counts(before.as_deref(), after.as_deref());
                self.state.track_file_change(&path, before, after);
                if let Some(stats) = stats {
                    self.state.stamp_tool_diff_stats(stats);
                }
            }
            AgentEvent::TodoUpdate { subagent_id, todos } => {
                if subagent_id.is_none() {
                    self.state.todo.todos.update(todos);
                    self.state.refresh_plan_in_chat();
                }
            }
            AgentEvent::Done {
                conversation,
                tokens: _,
            } => {
                self.state.agent.settle_context_after_turn(&conversation);
                self.state.session.conversation = conversation;
                if !self.state.agent.streaming_text.is_empty() {
                    let text = self.state.agent.streaming_text.clone();
                    self.state.agent.streaming_text.clear();
                    self.state.add_assistant_message(text);
                } else {
                    self.state.flush_live_reasoning();
                }
                self.settle_parent_turn(true, true, true);
            }
            AgentEvent::Cancelled {
                conversation,
                tokens: _,
                partial_text,
            } => {
                if !partial_text.is_empty() {
                    self.state.agent.streaming_text = partial_text;
                    self.state.add_interrupted_message();
                } else {
                    self.state.flush_live_reasoning();
                }
                self.state
                    .agent
                    .recompute_total_from_conversation(&conversation);
                self.state.session.conversation = conversation;
                self.settle_parent_turn(true, true, false);
            }
            AgentEvent::CompactionStarted { smart, model: _ } => {
                self.state.agent.compacting = Some(smart);
            }
            AgentEvent::ContextCompacted {
                summary: _,
                compacted_conversation,
                tokens_before,
                tokens_after,
                smart,
            } => {
                self.state.session.conversation = compacted_conversation.clone();
                self.state
                    .agent
                    .recompute_total_from_conversation(&compacted_conversation);
                self.state
                    .add_system_message(crate::state::compaction_notice(
                        tokens_before as usize,
                        tokens_after as usize,
                        smart,
                    ));
            }
            AgentEvent::UserMessagesInjected { messages } => {
                for message in self.state.agent.take_injected(messages.len()) {
                    self.state
                        .append_user_message(message.display, message.attachments);
                }
            }
            AgentEvent::CallUsage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                cost_usd,
                cost_estimated,
                subagent_id,
            } => {
                let record = |spend: &mut crate::state::Spend| {
                    spend.record(
                        prompt_tokens,
                        completion_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                        cost_usd,
                    );
                    if cost_usd.is_some() && cost_estimated {
                        spend.estimated_calls += 1;
                    }
                };
                record(&mut self.state.agent.spend);
                if let Some(child) = subagent_id
                    .as_deref()
                    .and_then(|id| self.state.agent.subagents.get_mut(id))
                {
                    record(&mut child.spend);
                }
                self.state.ui.needs_render = true;
            }
            AgentEvent::ContextBudget {
                used,
                room,
                window,
                tool_tokens,
                gap,
                measured,
                ..
            } => {
                self.state
                    .agent
                    .record_budget(used, room, window, tool_tokens, gap, measured);
                self.state.ui.needs_render = true;
            }
            AgentEvent::TurnUsage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                context_tokens,
            } => {
                self.state.agent.record_turn_usage(
                    prompt_tokens,
                    completion_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                );
                self.state.agent.record_context(if context_tokens > 0 {
                    context_tokens
                } else {
                    prompt_tokens
                });
            }
            AgentEvent::Error {
                message: msg,
                conversation,
            } => {
                if !conversation.is_empty() {
                    self.state
                        .agent
                        .recompute_total_from_conversation(&conversation);
                    self.state.session.conversation = conversation;
                }
                let mode_str = self.state.agent.current_turn_mode.to_string();
                let reasoning = self.state.take_reasoning();
                let partial = std::mem::take(&mut self.state.agent.streaming_text);
                let content = if partial.trim().is_empty() {
                    format!("Error: {msg}")
                } else {
                    format!("{partial}\n\nError: {msg}")
                };
                self.state.session.chat_history.push(types::ChatEntry {
                    id: uuid::Uuid::new_v4(),
                    role: Role::Assistant,
                    content,
                    tool_name: None,
                    tool_args: None,
                    is_error: true,
                    timestamp: chrono::Utc::now(),
                    response_duration: None,
                    mode: mode_str,
                    interrupted: !partial.trim().is_empty(),
                    reasoning,
                    subagent_id: None,
                    subagent_type: None,
                    diff_stats: None,
                    attachments: Vec::new(),
                });
                self.state.agent.clear_stream_buffers();
                self.state.ui.stream_markdown_cache.reset(0);
                self.state
                    .agent
                    .remove_approvals_from(&agente_core::agent::ApprovalSource::Parent);
                self.state.agent.end_parent_turn();
                self.state.plan_review.promote();
                self.queue_session_snapshot();
                self.drain_queues_and_continue();
            }
            AgentEvent::ApprovalRequested { source, request } => {
                self.state.agent.enqueue_approval(source, request);
            }
            _ => {}
        }
    }

    fn handle_tool_call_result(
        &mut self,
        id: String,
        name: String,
        result: String,
        is_error: bool,
    ) {
        let live = self.state.agent.finish_live_tool(&id);
        if let Some(view) = self
            .state
            .ui
            .process_view
            .as_mut()
            .filter(|view| view.call_id == id)
        {
            view.finished = live.clone();
        }
        let duration_ms = live
            .as_ref()
            .map(|call| call.started.elapsed().as_millis() as f64)
            .or_else(|| {
                self.state
                    .agent
                    .current_tool_start
                    .take()
                    .map(|t| t.elapsed().as_millis() as f64)
            });
        if self.state.agent.live_tool_calls.is_empty() {
            self.state.agent.current_tool_start = None;
        }
        if live.as_ref().map(|call| call.direct).unwrap_or(false) {
            let command = live
                .as_ref()
                .and_then(|call| {
                    serde_json::from_str::<serde_json::Value>(&call.args)
                        .ok()
                        .and_then(|args| {
                            args.get("command")
                                .and_then(|value| value.as_str())
                                .map(str::to_string)
                        })
                })
                .unwrap_or_else(|| "shell".to_string());
            let display = if result.trim().is_empty() {
                "(no output)".to_string()
            } else {
                result.trim().to_string()
            };
            self.state
                .add_system_message(format!("$ {command}\n{display}"));
            self.settle_parent_turn(false, false, false);
            return;
        }
        if !is_error && name == "present_plan" {
            if let Some((path, title, body)) = agente_core::tools::parse_plan_ready_output(&result)
            {
                self.state.plan_review.store_plan(path, title, body);
                self.state.ui.show_welcome_screen = false;
            }
        }
        let result = if result.is_empty() {
            live.map(|call| call.output).unwrap_or(result)
        } else {
            result
        };
        let display = if name == "present_plan" {
            result
                .split("\n__PLAN_READY__\n")
                .next()
                .unwrap_or(&result)
                .trim()
                .to_string()
        } else {
            result
        };
        if name != "todo_write" || is_error {
            self.state
                .add_tool_result(&name, display, is_error, duration_ms);
        }
    }

    /// Common end-of-turn settlement shared by `Done`, `Cancelled`, and direct `!cmd` shell runs.
    fn settle_parent_turn(&mut self, promote_plan: bool, persist_config: bool, spawn_title: bool) {
        let steering_pending = !self.state.agent.steering_queue.is_empty();
        let mut had_notices = if steering_pending {
            false
        } else {
            self.state.session.drain_notices()
        };
        self.state.agent.clear_stream_buffers();
        self.state.ui.stream_markdown_cache.reset(0);
        self.state
            .agent
            .remove_approvals_from(&agente_core::agent::ApprovalSource::Parent);
        self.state.agent.end_parent_turn();
        if promote_plan {
            self.state.plan_review.promote();
        }
        if persist_config {
            self.state.persist_config();
        }
        self.queue_session_snapshot();
        if spawn_title {
            self.maybe_spawn_session_title();
        }
        let started = self.drain_queues_and_continue();
        if steering_pending && self.state.agent.is_idle() {
            had_notices = self.state.session.drain_notices();
        }
        if had_notices && !started && self.state.agent.is_idle() {
            let _ = self.start_chat_turn();
        }
    }
}
