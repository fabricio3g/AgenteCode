//! The chat task: turn spawn + the main agent loop.
//!
//! One loop iteration = compact-if-needed -> stream a completion -> assemble
//! the assistant message -> execute the requested tools -> repeat until the
//! model stops calling tools, the iteration budget fires, or the user cancels.

mod request;
mod stream;
#[cfg(test)]
mod tests;
mod todo_review;

use std::sync::mpsc::Sender;
use std::sync::Arc;

use futures::FutureExt;
use tracing::Instrument;

use crate::agent::events::{AgentEvent, AgentTaskEvent};
use crate::cancellation::AbortSignal;
use crate::catalog::ModelCost;
use crate::context::{CompactionStrategy, ContextBudget, ContextCompactor};
use crate::llm::{StopReason, StreamEvent, Usage};
use crate::permissions::{ApprovalBroker, SharedPermissionEngine};
use crate::providers::ProviderRegistry;
use crate::subagent::{SubagentHost, SubagentHostConfig, DEFAULT_MAX_SUBAGENT_DEPTH};
use crate::types::{AgentMode, Message, Role};

use super::config::{send_event, send_turn_usage, AgentRunConfig};
use super::errors::{categorize_error, is_context_overflow_error};
use super::execute::execute_tool_calls_batched;
use super::loop_detection::{
    is_computer_tool, LoopDetector, LoopVerdict, DEFAULT_LOOP_NUDGE_AFTER, DEFAULT_LOOP_STOP_AFTER,
};
use super::progress::StreamProgress;
use super::retry::{is_retryable_error, jittered_backoff, wait_retry_or_cancel};

use request::{
    build_tool_registry, maybe_compact, prepare_request_messages, resolve_iteration_model,
    ToolRegistryParams,
};
use stream::{consume_completion_stream, StreamCollected, StreamOutcome};
use todo_review::should_review_todos;

/// How many times one turn asks a reply the output limit cut off to go on.
const MAX_LENGTH_CONTINUATIONS: u32 = 2;

const LENGTH_CONTINUE_NOTE: &str = "[Your previous reply was cut off by the output token limit. \
Continue exactly where it stopped, without repeating what you already wrote.]";

const EMPTY_LENGTH_NOTE: &str = "[Your previous reply hit the output token limit before producing \
anything usable — probably one very large tool call. Work in smaller steps: split large file \
writes into several edits and keep each call's arguments short.]";

#[allow(clippy::too_many_arguments)]
pub fn spawn_chat_task(
    session_id: uuid::Uuid,
    task_id: u64,
    sender: Sender<AgentTaskEvent>,
    conversation: Vec<Message>,
    provider_id: String,
    model: String,
    thinking_level: String,
    project_dir: String,
    max_iterations: u32,
    registry: Arc<ProviderRegistry>,
    catalog: Option<Arc<crate::catalog::ModelCatalog>>,
    permission_engine: SharedPermissionEngine,
    cancel_signal: AbortSignal,
    approval_broker: ApprovalBroker,
    mcp_manager: Option<Arc<crate::mcp::client::McpManager>>,
    subagent_registry: crate::subagent::SubagentRegistry,
    subagents: crate::config::SubagentSettings,
    smart_compaction: bool,
    compaction_model: Option<crate::config::SubagentModel>,
    initial_gap: usize,
    max_parallel_subagents: usize,
    user_inbox: super::config::UserInbox,
    mut turn_tools: super::config::TurnTools,
) -> tokio::task::JoinHandle<()> {
    tracing::info!(%session_id, task_id, provider = %provider_id, model = %model, "Spawning chat task");
    tokio::spawn(async move {
        // Load the custom-agent roster once per turn; children reuse it
        // instead of re-scanning their (possibly fresh) worktree checkout.
        let custom_agents = crate::subagent::definition::custom_subagents(&project_dir);
        let host = SubagentHost::new(
            SubagentHostConfig {
                custom_agents: custom_agents.clone(),
                subagents,
                event_sender: sender.clone(),
                task_id,
                provider_id: provider_id.clone(),
                provider_registry: Arc::clone(&registry),
                catalog: catalog.clone(),
                permission_engine: permission_engine.clone(),
                approval_broker: approval_broker.clone(),
                mcp_manager: mcp_manager.clone(),
                project_dir: project_dir.clone(),
                model: model.clone(),
                thinking_level: thinking_level.clone(),
                registry: subagent_registry,
                shell_env: turn_tools.shell_env.clone(),
                only_tools: turn_tools.only.clone(),
            },
            DEFAULT_MAX_SUBAGENT_DEPTH,
            max_parallel_subagents,
        )
        .with_mcp_session_id(session_id);
        if let (Some(manager), Some(turn)) = (
            &mcp_manager,
            turn_tools.mcp_turn_id.filter(|_| {
                turn_tools
                    .only
                    .as_ref()
                    .is_none_or(|only| only.iter().any(|name| name == "mcp"))
            }),
        ) {
            turn_tools
                .extra
                .extend(crate::mcp::McpToolAdapter::all_for_turn(
                    manager, session_id, turn,
                ));
        }
        let config = AgentRunConfig {
            session_id,
            task_id,
            sender: sender.clone(),
            messages: conversation,
            provider_id: provider_id.clone(),
            model,
            thinking_level,
            project_dir,
            max_iterations: Some(max_iterations),
            registry,
            catalog,
            permission_engine,
            cancel_signal,
            approval_broker,
            mcp_manager,
            subagent_host: Some(host),
            custom_agents,
            tool_policy: None,
            is_subagent: false,
            depth: 0,
            loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
            loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
            smart_compaction,
            compaction_model,
            initial_gap,
            user_inbox: Some(user_inbox),
            extra_tools: turn_tools.extra,
            only_tools: turn_tools.only,
            shell_env: turn_tools.shell_env,
        };
        let result = std::panic::AssertUnwindSafe(run_agent_loop(config))
            .catch_unwind()
            .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let redacted = crate::util::redact_secrets(&e.message);
                tracing::error!(error = %redacted, provider = %provider_id, "Chat task failed");
                send_event(
                    &sender,
                    task_id,
                    AgentEvent::Error {
                        message: redacted,
                        conversation: e.conversation,
                    },
                );
            }
            Err(panic) => {
                let detail = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                tracing::error!(panic = %detail, "Chat task panicked");
                send_event(
                    &sender,
                    task_id,
                    AgentEvent::Error {
                        message: "Internal error: the agent turn crashed unexpectedly. \
                                  This is usually temporary — try the request again."
                            .to_string(),
                        conversation: Vec::new(),
                    },
                );
            }
        }
    })
}

/// A fatal turn failure plus the transcript as of the failure. The transcript
/// preserves tool work the loop already executed, so the turn owner can
/// persist it instead of reverting to the last pre-turn snapshot.
#[derive(Debug)]
pub struct AgentLoopFailure {
    pub message: String,
    pub conversation: Vec<Message>,
}

impl From<String> for AgentLoopFailure {
    /// Setup failures happen before a transcript exists; the owner falls back
    /// to its last known conversation.
    fn from(message: String) -> Self {
        Self {
            message,
            conversation: Vec::new(),
        }
    }
}

/// Per-turn transcript, token accounting, usage emission, and terminal event
/// helpers. Eliminates repeated cancel/done/usage/token-tracking boilerplate
/// across the loop's exit paths.
pub(super) struct TurnState {
    pub sender: Sender<AgentTaskEvent>,
    pub task_id: u64,
    pub is_subagent: bool,
    pub messages: Vec<Message>,
    pub total_tokens: u32,
    pub total_cache_read_tokens: u32,
    pub total_cache_creation_tokens: u32,
    pub last_prompt_tokens: u32,
    pub last_context_tokens: u32,
    pub last_completion_tokens: u32,
    pub running_tokens: usize,
    pub tokens_measured: bool,
    pub tokenizer_gap: usize,
    pub compacted_recently: bool,
}

impl TurnState {
    fn new(
        sender: Sender<AgentTaskEvent>,
        task_id: u64,
        is_subagent: bool,
        messages: Vec<Message>,
        initial_gap: usize,
    ) -> Self {
        let running_tokens = crate::context::estimate_message_tokens(&messages);
        Self {
            sender,
            task_id,
            is_subagent,
            messages,
            total_tokens: 0,
            total_cache_read_tokens: 0,
            total_cache_creation_tokens: 0,
            last_prompt_tokens: 0,
            last_context_tokens: 0,
            last_completion_tokens: 0,
            running_tokens,
            tokens_measured: false,
            tokenizer_gap: initial_gap,
            compacted_recently: false,
        }
    }

    fn push_message(&mut self, message: Message) {
        self.running_tokens =
            self.running_tokens
                .saturating_add(crate::context::estimate_message_tokens(
                    std::slice::from_ref(&message),
                ));
        self.messages.push(message);
    }

    fn recompute_tokens(&mut self) {
        self.running_tokens = crate::context::estimate_message_tokens(&self.messages);
    }

    pub(super) fn replace_messages_after_compaction(
        &mut self,
        messages: Vec<Message>,
        tokens_after: usize,
    ) {
        // The gap was measured against the transcript before compaction and
        // grows with it; carried over whole it would hold back room the
        // smaller transcript no longer needs (or, after an overflow, keep
        // the wrong size). Scale it with the transcript until the next
        // provider-reported usage measures it again.
        if self.running_tokens > 0 {
            self.tokenizer_gap = ((self.tokenizer_gap as u128 * tokens_after as u128)
                / self.running_tokens as u128) as usize;
        }
        self.messages = messages;
        self.running_tokens = tokens_after;
        self.tokens_measured = false;
        self.compacted_recently = true;
    }

    fn emit_call_usage(&self, usage: &Usage, price: &ModelCost) {
        let (cost_usd, cost_estimated) = price.call_cost(
            usage.cost_usd,
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens,
        );
        send_event(
            &self.sender,
            self.task_id,
            AgentEvent::CallUsage {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_creation_tokens: usage.cache_creation_tokens,
                cost_usd,
                cost_estimated: cost_estimated || usage.cost_estimated,
                subagent_id: None,
            },
        );
    }

    /// Account for an auxiliary call (such as a compaction summarizer) that
    /// bills tokens/USD without changing the main conversation's context size.
    pub(super) fn record_extra_call_usage(&mut self, usage: &Usage, price: &ModelCost) {
        self.total_tokens = self.total_tokens.saturating_add(usage.total_tokens);
        self.emit_call_usage(usage, price);
    }

    /// Account for a primary completion call, updating cumulative spend, last
    /// context size, and the calibrated tokenizer gap.
    pub(super) fn record_completion_usage(
        &mut self,
        usage: &Usage,
        price: &ModelCost,
        request_estimate: usize,
    ) {
        self.total_tokens = self.total_tokens.saturating_add(usage.total_tokens);
        self.total_cache_read_tokens = self
            .total_cache_read_tokens
            .saturating_add(usage.cache_read_tokens);
        self.total_cache_creation_tokens = self
            .total_cache_creation_tokens
            .saturating_add(usage.cache_creation_tokens);
        self.last_prompt_tokens = usage.prompt_tokens;
        self.last_context_tokens = usage
            .prompt_tokens
            .saturating_add(usage.cache_read_tokens)
            .saturating_add(usage.cache_creation_tokens);
        if self.last_context_tokens > 0 {
            self.tokenizer_gap =
                (self.last_context_tokens as usize).saturating_sub(request_estimate);
            self.tokens_measured = true;
        }
        self.last_completion_tokens = usage.completion_tokens;
        self.emit_call_usage(usage, price);
    }

    fn emit_turn_usage(&self) {
        send_turn_usage(
            &self.sender,
            self.task_id,
            self.is_subagent,
            &self.last_prompt_tokens,
            &self.last_completion_tokens,
            &self.total_cache_read_tokens,
            &self.total_cache_creation_tokens,
            &self.last_context_tokens,
        );
    }

    fn finish_cancelled(self, partial_text: String) {
        self.emit_turn_usage();
        send_event(
            &self.sender,
            self.task_id,
            AgentEvent::Cancelled {
                conversation: self.messages,
                tokens: self.total_tokens,
                partial_text,
            },
        );
    }

    fn finish_done(self) {
        self.emit_turn_usage();
        send_event(
            &self.sender,
            self.task_id,
            AgentEvent::Done {
                conversation: self.messages,
                tokens: self.total_tokens,
            },
        );
    }
}

/// Run one agent loop: stream a completion, execute the requested tools, and
/// repeat until the model stops calling tools or the budget/cancel fires.
///
/// Emits plain `AgentEvent`s on `cfg.sender`/`cfg.task_id`, including the
/// terminal `Done`/`Cancelled` events. Children run against a private channel
/// (the `SubagentHost` forwarder translates their stream into `Subagent*`
/// events), so the loop itself does not need to know parent vs child.
#[tracing::instrument(skip_all, fields(session_id = %cfg.session_id, task_id = cfg.task_id, role = if cfg.is_subagent { "child" } else { "parent" }, provider = %cfg.provider_id, model = %cfg.model))]
pub(crate) async fn run_agent_loop(cfg: AgentRunConfig) -> Result<(), AgentLoopFailure> {
    let session_id = cfg.session_id;
    crate::tools::atomic_fs::scope_session(session_id, run_agent_loop_inner(cfg)).await
}

async fn run_agent_loop_inner(cfg: AgentRunConfig) -> Result<(), AgentLoopFailure> {
    let AgentRunConfig {
        session_id,
        task_id,
        sender,
        messages: mut conversation,
        provider_id,
        model,
        mut thinking_level,
        project_dir,
        mut max_iterations,
        registry,
        catalog,
        permission_engine,
        cancel_signal,
        approval_broker,
        mcp_manager,
        subagent_host,
        custom_agents,
        tool_policy,
        is_subagent,
        depth,
        loop_nudge_after,
        loop_stop_after,
        smart_compaction,
        compaction_model,
        initial_gap,
        user_inbox,
        extra_tools,
        only_tools,
        shell_env,
    } = cfg;

    let tool_registry = build_tool_registry(ToolRegistryParams {
        session_id,
        project_dir: &project_dir,
        custom_agents: &custom_agents,
        only_tools: only_tools.as_deref(),
        subagent_host: subagent_host.as_ref(),
        mcp_manager: mcp_manager.as_ref(),
        extra_tools,
        tool_policy: tool_policy.as_ref(),
        is_subagent,
        shell_env,
    })
    .await;

    // Children get the project's AGENTS.md as well: without it every explore
    // run spends tool rounds rediscovering layout and build commands.
    crate::context::inject_project_reminder(&mut conversation, &project_dir);

    let mut state = TurnState::new(sender, task_id, is_subagent, conversation, initial_gap);
    let mut generation_progress = StreamProgress::default();
    let mut retry_attempt = 0u32;
    let mut empty_response_retries = 0u32;
    // Replies the output limit cut off that were asked to go on, this turn.
    let mut length_continuations = 0u32;
    let max_retries = 2u32;
    let base_delay_ms = 500u64;
    const MAX_OVERFLOW_RECOVERIES: u32 = 2;
    let mut overflow_recoveries = 0u32;

    let mut loop_detector = LoopDetector::new(loop_nudge_after, loop_stop_after);
    let mut blocked_computer_tools = std::collections::HashSet::<String>::new();
    let mut computer_budget_granted = false;
    let mut current_todos: Option<Vec<crate::todo::TodoInput>> = None;
    let mut todo_reviewed = false;
    let mut todo_review_at: Option<usize> = None;

    let provider = registry
        .get(&provider_id)
        .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;

    tracing::info!(provider = %provider_id, "Provider found, starting chat loop");

    let mut iteration = 0u32;
    while max_iterations.map(|max| iteration < max).unwrap_or(true) {
        iteration += 1;

        if cancel_signal.is_aborted() {
            tracing::info!("Chat task cancelled");
            state.finish_cancelled(String::new());
            return Ok(());
        }

        // Messages the user sent mid-turn join here, after a complete tool round.
        if let Some(inbox) = &user_inbox {
            let arrived: Vec<Message> = std::mem::take(&mut *inbox.lock());
            if !arrived.is_empty() {
                let texts: Vec<String> = arrived.iter().map(|m| m.content.clone()).collect();
                for message in arrived {
                    state.push_message(message);
                }
                send_event(
                    &state.sender,
                    state.task_id,
                    AgentEvent::UserMessagesInjected { messages: texts },
                );
            }
        }

        if let Some(level) = user_inbox.as_ref().and_then(|inbox| inbox.take_thinking()) {
            thinking_level = level;
        }
        let mode = permission_engine
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mode;

        if !state.is_subagent && mode == AgentMode::Plan {
            let allowed: Vec<String> = tool_registry
                .definitions_for_mode(AgentMode::Plan)
                .into_iter()
                .map(|d| d.name)
                .collect();
            let blocked: Vec<String> = tool_registry
                .definitions()
                .into_iter()
                .map(|d| d.name)
                .filter(|name| !allowed.contains(name))
                .collect();
            let restriction = crate::context::plan_mode_restriction(&allowed, &blocked);
            if crate::context::set_plan_restriction(&mut state.messages, Some(&restriction)) {
                state.recompute_tokens();
            }
        } else if !state.is_subagent
            && crate::context::set_plan_restriction(&mut state.messages, None)
        {
            state.recompute_tokens();
        }

        tracing::info!(
            iteration,
            message_count = state.messages.len(),
            "Starting iteration"
        );

        let (normalized, normalized_changed) =
            crate::context::normalize_tool_messages_tracked(std::mem::take(&mut state.messages));
        state.messages = normalized;
        if normalized_changed {
            state.recompute_tokens();
        }

        let (tx, rx) = tokio::sync::mpsc::channel::<StreamEvent>(256);
        send_event(&state.sender, state.task_id, AgentEvent::Thinking);

        let resolved = resolve_iteration_model(
            provider.as_ref(),
            registry.as_ref(),
            catalog.as_deref(),
            &provider_id,
            &model,
            &thinking_level,
            tool_registry.as_ref(),
            mode,
            &blocked_computer_tools,
        );

        let pre_budget = ContextBudget::new(
            resolved.window,
            resolved.tool_tokens,
            state.tokenizer_gap,
            state.running_tokens,
            resolved.output_tokens,
        );
        let strategy = CompactionStrategy::from_budget(&pre_budget);
        if maybe_compact(
            &mut state,
            iteration,
            &pre_budget,
            &strategy,
            smart_compaction,
            compaction_model.as_ref(),
            &model,
            &resolved.model_info,
            &provider,
            registry.as_ref(),
            catalog.as_deref(),
            session_id,
            &cancel_signal,
            &mut todo_review_at,
        )
        .await
        {
            state.finish_cancelled(String::new());
            return Ok(());
        }

        let (request_messages, request_estimate) = prepare_request_messages(
            &mut state,
            resolved.window,
            resolved.tool_tokens,
            resolved.output_tokens,
            session_id,
            todo_review_at,
        );
        let request_context = crate::providers::RequestContext::new(session_id);
        tracing::info!(iteration, format = ?resolved.api_format, tool_count = resolved.tool_defs.len(), "Starting provider request");
        let request_started = std::time::Instant::now();

        let provider_clone = Arc::clone(&provider);
        let tool_defs = resolved.tool_defs;
        let model_info = resolved.model_info;
        let price = resolved.price;
        let accepted_media = resolved.accepted_media;
        let stream_handle = tokio::spawn(
            async move {
                let tools_for_request = if tool_defs.is_empty() {
                    None
                } else {
                    Some(tool_defs.as_slice())
                };
                match provider_clone
                    .stream_completion(
                        &request_messages,
                        tools_for_request,
                        &model_info,
                        tx,
                        request_context,
                    )
                    .await
                {
                    Ok(usage) => Ok(usage),
                    Err(e) => {
                        tracing::error!(error = %e, "Stream completion failed");
                        Err(e)
                    }
                }
            }
            .instrument(tracing::Span::current()),
        );

        let (collected, stream_result) = match consume_completion_stream(
            &mut state,
            &mut generation_progress,
            rx,
            stream_handle,
            user_inbox.as_ref(),
            &cancel_signal,
            &price,
            request_estimate,
            request_started,
        )
        .await
        {
            StreamOutcome::Cancelled { partial_text } => {
                state.finish_cancelled(partial_text);
                return Ok(());
            }
            StreamOutcome::Steered { partial_text } => {
                if !partial_text.is_empty() {
                    let mut message = Message::user(partial_text.clone());
                    message.role = Role::Assistant;
                    state.push_message(message);
                    send_event(
                        &state.sender,
                        state.task_id,
                        AgentEvent::AssistantText(partial_text),
                    );
                }
                iteration = iteration.saturating_sub(1);
                continue;
            }
            StreamOutcome::Completed {
                collected,
                stream_result,
            } => (*collected, stream_result),
        };

        let StreamCollected {
            mut full_response,
            mut full_reasoning,
            thinking_signature,
            continuation,
            tool_calls,
            stream_error,
            stop_reason: stream_stop_reason,
            received_output,
            first_event_ms,
            first_output_ms,
        } = collected;

        let stream_failure = stream_error
            .clone()
            .or_else(|| stream_result.as_ref().err().cloned());
        if let Some(err) = stream_failure {
            tracing::warn!(iteration, retry_attempt, elapsed_ms = request_started.elapsed().as_millis(), first_event_ms = ?first_event_ms, error = %crate::util::redact_secrets(&err), "Provider request failed");
            if !received_output
                && is_context_overflow_error(&err)
                && overflow_recoveries < MAX_OVERFLOW_RECOVERIES
            {
                overflow_recoveries += 1;
                tracing::warn!(
                    iteration,
                    overflow_recoveries,
                    "Provider context overflow; forcing compaction"
                );
                let tokens_before = state.running_tokens;
                let forced = ContextCompactor::new(strategy.clone())
                    .compact_forced(std::mem::take(&mut state.messages));
                if forced.summary.tokens_saved > 0 {
                    let summary = format!(
                        "Provider reported context overflow; {}",
                        forced.summary.content
                    );
                    let tokens_after = crate::context::estimate_message_tokens(&forced.messages);
                    state.replace_messages_after_compaction(forced.messages, tokens_after);
                    todo_review_at = None;
                    send_event(
                        &state.sender,
                        state.task_id,
                        AgentEvent::ContextCompacted {
                            summary,
                            tokens_before: tokens_before as u32,
                            tokens_after: state.running_tokens as u32,
                            smart: false,
                            compacted_conversation: state.messages.clone(),
                        },
                    );
                    iteration = iteration.saturating_sub(1);
                    continue;
                }
                state.messages = forced.messages;
            }
            if !received_output && is_retryable_error(&err) && retry_attempt < max_retries {
                retry_attempt += 1;
                let delay = jittered_backoff(base_delay_ms, retry_attempt - 1).as_millis() as u64;
                tracing::info!(
                    iteration,
                    retry_attempt,
                    delay_ms = delay,
                    "Retrying provider request"
                );
                send_event(
                    &state.sender,
                    state.task_id,
                    AgentEvent::Retry {
                        attempt: retry_attempt,
                        max_attempts: max_retries,
                        delay_ms: delay,
                    },
                );
                if wait_retry_or_cancel(&cancel_signal, std::time::Duration::from_millis(delay))
                    .await
                {
                    state.finish_cancelled(std::mem::take(&mut full_response));
                    return Ok(());
                }
                iteration = iteration.saturating_sub(1);
                continue;
            }
            let user_msg =
                crate::util::redact_secrets(&categorize_error(&err, &provider_id, &model));
            return Err(AgentLoopFailure {
                message: user_msg,
                conversation: state.messages,
            });
        }

        retry_attempt = 0;
        tracing::info!(iteration, elapsed_ms = request_started.elapsed().as_millis(), first_event_ms = ?first_event_ms, first_output_ms = ?first_output_ms, stop = ?stream_stop_reason, text_bytes = full_response.len(), reasoning_bytes = full_reasoning.len(), tool_calls = tool_calls.len(), "Provider request completed");

        state.emit_turn_usage();

        if full_response.is_empty() && tool_calls.is_empty() {
            if stream_stop_reason == StopReason::Safety {
                return Err(AgentLoopFailure {
                    message: "The model declined to respond (safety filter). Rephrase the request or try a different model with /model."
                        .to_string(),
                    conversation: state.messages,
                });
            }
            if empty_response_retries == 0 {
                empty_response_retries += 1;
                tracing::warn!(
                    stop = ?stream_stop_reason,
                    iteration,
                    "Empty completion; retrying once"
                );
                if stream_stop_reason == StopReason::Length {
                    // The output limit ran out before anything usable — most
                    // often one huge tool call. The same request would end
                    // the same way, so ask for smaller steps.
                    state.push_message(Message::user(EMPTY_LENGTH_NOTE));
                }
                iteration = iteration.saturating_sub(1);
                continue;
            }
            return Err(AgentLoopFailure {
                message: "The model returned an empty response twice. This is usually temporary — try again, or switch models with /model."
                    .to_string(),
                conversation: state.messages,
            });
        }
        empty_response_retries = 0;

        // A reply the output limit cut off mid-text: keep it and ask the model
        // to go on from where it stopped, a bounded number of times, instead
        // of ending the turn on half an answer.
        let continue_after_length = stream_stop_reason == StopReason::Length
            && tool_calls.is_empty()
            && !full_response.is_empty()
            && length_continuations < MAX_LENGTH_CONTINUATIONS
            && !cancel_signal.is_aborted()
            && max_iterations.map(|max| iteration < max).unwrap_or(true);
        if stream_stop_reason == StopReason::Length
            && !full_response.is_empty()
            && !continue_after_length
        {
            full_response.push_str("\n\n[response truncated by the model's output limit]");
        }

        if !full_response.is_empty() || !tool_calls.is_empty() {
            let response_text = if full_response.is_empty() {
                String::new()
            } else {
                std::mem::take(&mut full_response)
            };
            let reasoning = if full_reasoning.is_empty() {
                None
            } else {
                Some(std::mem::take(&mut full_reasoning))
            };
            let assistant_message = Message {
                role: Role::Assistant,
                content: response_text.clone(),
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls.clone())
                },
                tool_call_id: None,
                thinking: reasoning,
                thinking_signature,
                continuation,
                attachments: Vec::new(),
            };
            state.push_message(assistant_message);
            if !response_text.is_empty() {
                send_event(
                    &state.sender,
                    state.task_id,
                    AgentEvent::AssistantText(response_text),
                );
            }
        }

        if continue_after_length {
            length_continuations += 1;
            tracing::info!(
                iteration,
                length_continuations,
                "Reply hit the output limit; asking the model to continue"
            );
            state.push_message(Message::user(LENGTH_CONTINUE_NOTE));
            continue;
        }

        if tool_calls.is_empty()
            && !cancel_signal.is_aborted()
            && user_inbox
                .as_ref()
                .is_some_and(|inbox| !inbox.lock().is_empty())
        {
            continue;
        }

        if tool_calls.is_empty() {
            if should_review_todos(
                current_todos.as_deref(),
                todo_reviewed,
                cancel_signal.is_aborted(),
                mode == AgentMode::Plan,
                max_iterations.map(|max| iteration < max).unwrap_or(true),
            ) {
                todo_reviewed = true;
                todo_review_at = Some(state.messages.len());
                continue;
            }
            tracing::info!("Chat task completed, no more tool calls");
            state.finish_done();
            return Ok(());
        }

        if cancel_signal.is_aborted() {
            tracing::info!("Chat task cancelled before tool execution");
            let cancel_msg = "Skipped: turn was interrupted before tool execution.".to_string();
            for call in &tool_calls {
                send_event(
                    &state.sender,
                    state.task_id,
                    AgentEvent::ToolCallResult {
                        id: call.id.clone(),
                        name: call.function.name.clone(),
                        result: cancel_msg.clone(),
                        is_error: true,
                    },
                );
                state.messages.push(Message {
                    role: Role::Tool,
                    content: cancel_msg.clone(),
                    tool_calls: None,
                    tool_call_id: Some(call.id.clone()),
                    thinking: None,
                    thinking_signature: None,
                    continuation: None,
                    attachments: Vec::new(),
                });
            }
            state.finish_cancelled(String::new());
            return Ok(());
        }

        tracing::info!(tool_count = tool_calls.len(), "Executing tool calls");

        let mut hard_stop = false;
        let mut computer_loop = false;
        let mut nudge_after_batch = false;
        for call in &tool_calls {
            if blocked_computer_tools.contains(&call.function.name) {
                computer_loop = true;
                continue;
            }
            match loop_detector.record(&call.function.name, &call.function.arguments) {
                LoopVerdict::Stop if is_computer_tool(&call.function.name) => {
                    computer_loop = true;
                    blocked_computer_tools.insert(call.function.name.clone());
                    if let Some(prefix) = call.function.name.strip_suffix("computer_observe") {
                        blocked_computer_tools.insert(format!("{prefix}computer_act"));
                    }
                }
                LoopVerdict::Stop => hard_stop = true,
                LoopVerdict::Nudge => nudge_after_batch = true,
                LoopVerdict::Normal => {}
            }
        }

        if hard_stop || computer_loop {
            tracing::warn!(iteration, hard_stop, "Handling repeated tool-call loop");
            let max_repeats = tool_calls
                .iter()
                .map(|call| loop_detector.repeats_of(&call.function.name, &call.function.arguments))
                .max()
                .unwrap_or(0);
            let loop_error = if !hard_stop {
                format!("Computer tool recovery: this batch was not executed; no input was sent. An identical computer call failed {max_repeats} times. The failing tool is unavailable for the rest of this turn. Continue with other available tools, or release computer control with computer_finish and explain the blocker. Do not repeat the call, act without a fresh observation, or claim the task is complete. The agent turn is still running.")
            } else {
                format!(
                    "Error: this exact tool call was repeated {max_repeats} times without \
                 making progress; the turn was stopped to break the loop."
                )
            };
            for call in &tool_calls {
                let tool_message = Message {
                    role: Role::Tool,
                    content: loop_error.clone(),
                    tool_calls: None,
                    tool_call_id: Some(call.id.clone()),
                    thinking: None,
                    thinking_signature: None,
                    continuation: None,
                    attachments: Vec::new(),
                };
                send_event(
                    &state.sender,
                    state.task_id,
                    AgentEvent::ToolCallResult {
                        id: call.id.clone(),
                        name: call.function.name.clone(),
                        result: loop_error.clone(),
                        is_error: true,
                    },
                );
                state.push_message(tool_message);
            }
            if !hard_stop {
                tracing::warn!(
                    iteration,
                    "Blocked a repeated computer tool; continuing the agent turn"
                );
                continue;
            }
            send_event(
                &state.sender,
                state.task_id,
                AgentEvent::AssistantText(
                    "Stopped: the model kept repeating identical tool calls without \
                     progress. Send another message with a different instruction to \
                     continue."
                        .to_string(),
                ),
            );
            state.finish_done();
            return Ok(());
        }

        let outcomes = execute_tool_calls_batched(
            &tool_calls,
            Arc::clone(&tool_registry),
            state.sender.clone(),
            state.task_id,
            &permission_engine,
            &approval_broker,
            &cancel_signal,
            &project_dir,
            depth,
            subagent_host.as_ref(),
        )
        .await;

        let mut tool_images = Vec::new();
        for (i, outcome) in outcomes.into_iter().enumerate() {
            if let Some(call) = tool_calls
                .iter()
                .find(|call| call.id == outcome.tool_call_id)
                .or_else(|| tool_calls.get(i))
            {
                loop_detector.record_result(
                    &call.function.name,
                    &call.function.arguments,
                    outcome.is_error,
                );
                if !computer_budget_granted
                    && !outcome.is_error
                    && call.function.name == "desktop_computer_request"
                {
                    max_iterations =
                        max_iterations.map(|limit| limit.max(iteration.saturating_add(300)));
                    computer_budget_granted = true;
                }
            }
            if let Some(todos) = &outcome.todos {
                current_todos = Some(todos.clone());
            }
            tool_images.extend(
                outcome
                    .attachments
                    .into_iter()
                    .filter(|attachment| accepted_media.contains(&attachment.kind)),
            );
            let tool_message = Message {
                role: Role::Tool,
                content: outcome.content,
                tool_calls: None,
                tool_call_id: Some(if !outcome.tool_call_id.is_empty() {
                    outcome.tool_call_id
                } else if i < tool_calls.len() {
                    tool_calls[i].id.clone()
                } else {
                    format!("tool_{i}")
                }),
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: Vec::new(),
            };
            state.push_message(tool_message);
        }

        if !tool_images.is_empty() {
            let image_message = Message {
                role: Role::User,
                content: crate::media::TOOL_MEDIA_NOTE.into(),
                attachments: tool_images,
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
            };
            state.push_message(image_message);
        }

        if nudge_after_batch {
            state.push_message(Message::user(
                "You have repeated an identical tool call (same tool and \
                 arguments) several times without progress. Change your \
                 approach: adjust the parameters, gather different \
                 information, or explain what is blocking you instead of \
                 retrying.",
            ));
        }
    }

    let max = max_iterations.expect("capped loop must carry a budget");
    tracing::warn!(iteration = max, "Chat task reached max iterations");
    let notice = format!(
        "Reached the iteration limit ({max}) for this turn. The task is paused; send another message to continue."
    );
    send_event(
        &state.sender,
        state.task_id,
        AgentEvent::AssistantText(notice),
    );
    state.finish_done();
    Ok(())
}
