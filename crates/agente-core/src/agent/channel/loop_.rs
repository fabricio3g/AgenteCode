//! The chat task: turn spawn + the main agent loop.
//!
//! One loop iteration = compact-if-needed -> stream a completion -> assemble
//! the assistant message -> execute the requested tools -> repeat until the
//! model stops calling tools, the iteration budget fires, or the user cancels.

use std::sync::Arc;

use crate::cancellation::AbortSignal;
use crate::context::{CompactionStrategy, ContextCompactor};
use crate::llm::{StopReason, StreamEvent};
use crate::permissions::{ApprovalBroker, SharedPermissionEngine};
use crate::providers::{ProviderRegistry, ProviderSummarizer};
use crate::subagent::SubagentHost;
use crate::subagent::{SubagentHostConfig, DEFAULT_MAX_SUBAGENT_DEPTH};
use crate::thinking::apply_thinking_level;
use crate::tools::ToolRegistry;
use crate::types::{FunctionCall, Message, Role, ToolCall};
use futures::FutureExt;
use tracing::Instrument;

use super::config::{send_event, send_turn_usage, AgentRunConfig};
use super::errors::{categorize_error, is_context_overflow_error};
use super::execute::execute_tool_calls_batched;
use super::loop_detection::{
    LoopDetector, LoopVerdict, DEFAULT_LOOP_NUDGE_AFTER, DEFAULT_LOOP_STOP_AFTER,
};
use super::progress::StreamProgress;
use super::retry::{is_retryable_error, jittered_backoff, wait_retry_or_cancel};
use crate::agent::events::{AgentEvent, AgentTaskEvent};
use std::sync::mpsc::Sender;

const COMPACTION_HEARTBEAT_MS: u64 = 15_000;

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
    catalog: Option<crate::catalog::ModelCatalog>,
    permission_engine: SharedPermissionEngine,
    cancel_signal: AbortSignal,
    approval_broker: ApprovalBroker,
    mcp_manager: Option<Arc<crate::mcp::client::McpManager>>,
    subagent_registry: crate::subagent::SubagentRegistry,
    subagent_models: crate::config::SubagentModels,
    smart_compaction: bool,
    max_parallel_subagents: usize,
    user_inbox: super::config::UserInbox,
    turn_tools: super::config::TurnTools,
) -> tokio::task::JoinHandle<()> {
    tracing::info!(%session_id, task_id, provider = %provider_id, model = %model, "Spawning chat task");
    tokio::spawn(async move {
        let parent_mode = permission_engine
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mode;
        // Load the custom-agent roster once per turn; children reuse it
        // instead of re-scanning their (possibly fresh) worktree checkout.
        let custom_agents = crate::subagent::definition::custom_subagents(&project_dir);
        let host = SubagentHost::new(
            SubagentHostConfig {
                custom_agents: custom_agents.clone(),
                subagent_models,
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
                parent_mode,
                registry: subagent_registry,
                shell_env: turn_tools.shell_env.clone(),
                only_tools: turn_tools.only.clone(),
            },
            DEFAULT_MAX_SUBAGENT_DEPTH,
            max_parallel_subagents,
        );
        let config = AgentRunConfig {
            session_id,
            task_id,
            sender: sender.clone(),
            messages: conversation,
            provider_id: provider_id.clone(),
            model,
            thinking_level,
            project_dir,
            // The parent turn always runs capped (config default 500);
            // unbounded is a child-only regime (see SubagentHost).
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
            user_inbox: Some(user_inbox),
            extra_tools: turn_tools.extra,
            only_tools: turn_tools.only,
            shell_env: turn_tools.shell_env,
        };
        // A panic inside the loop must not kill the spawned task silently:
        // without a terminal event the TUI would hang "running" until the
        // stuck guard force-reset it, discarding the partial answer.
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

/// Run one agent loop: stream a completion, execute the requested tools, and
/// repeat until the model stops calling tools or the budget/cancel fires.
///
/// Emits plain `AgentEvent`s on `cfg.sender`/`cfg.task_id`, including the
/// terminal `Done`/`Cancelled` events. Children run against a private channel
/// (the `SubagentHost` forwarder translates their stream into `Subagent*`
/// events), so the loop itself does not need to know parent vs child.
#[tracing::instrument(skip_all, fields(session_id = %cfg.session_id, task_id = cfg.task_id, role = if cfg.is_subagent { "child" } else { "parent" }, provider = %cfg.provider_id, model = %cfg.model))]
pub(crate) async fn run_agent_loop(cfg: AgentRunConfig) -> Result<(), AgentLoopFailure> {
    let AgentRunConfig {
        session_id,
        task_id,
        sender,
        messages: conversation,
        provider_id,
        model,
        thinking_level,
        project_dir,
        max_iterations,
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
        user_inbox,
        extra_tools,
        only_tools,
        shell_env,
    } = cfg;

    let mut tool_registry = ToolRegistry::with_agents(&project_dir, &custom_agents);

    // A host's allowlist (a bot's toolsets) trims the built-in tools; MCP
    // tools come in only when it names "mcp".
    if let Some(only) = &only_tools {
        tool_registry.retain_named(&only.iter().map(String::as_str).collect::<Vec<_>>());
    }
    let mcp_allowed = only_tools
        .as_ref()
        .is_none_or(|only| only.iter().any(|name| name == "mcp"));

    // MCP tools of every server that is ready now; servers still connecting
    // join on a later turn (a slow server never delays this one).
    if let Some(manager) = mcp_manager.as_ref().filter(|_| mcp_allowed) {
        manager.refresh_stale_tools().await;
        tool_registry.register_mcp_adapters(crate::mcp::McpToolAdapter::all(manager));
    }
    for tool in extra_tools {
        tool_registry.register(tool);
    }

    // Children get a pruned registry containing only tools their capability and
    // type allowlist permits. Even if the model hallucinates an out-of-scope
    // call, the registry rejects it as an unknown tool.
    if let Some(policy) = &tool_policy {
        let keep: Vec<String> = policy
            .filter_definitions(tool_registry.definitions())
            .into_iter()
            .map(|d| d.name)
            .collect();
        tool_registry.retain_named(&keep.iter().map(|s| s.as_str()).collect::<Vec<_>>());
    }

    tool_registry.set_shell_env(shell_env);
    let tool_registry = Arc::new(tool_registry);
    let mode = permission_engine
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .mode;

    // Append mode restriction to existing system message. Children skip this —
    // the host gates plan-mode parents before spawning them.
    let mut messages = conversation;
    if !is_subagent {
        // Project instructions (AGENTS.md) travel as a user-message reminder;
        // idempotent, so it re-attaches after compaction dropped it.
        crate::context::inject_project_reminder(&mut messages, &project_dir);
    }
    if !is_subagent && mode == crate::types::AgentMode::Plan {
        let allowed: Vec<String> = tool_registry
            .definitions_for_mode(crate::types::AgentMode::Plan)
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
        // Find and append to existing system message instead of inserting a second one
        if let Some(sys_msg) = messages.iter_mut().find(|m| m.role == Role::System) {
            sys_msg.content.push_str(&restriction);
        } else {
            messages.insert(
                0,
                Message {
                    role: Role::System,
                    content: restriction[2..].to_string(), // strip leading \n\n
                    tool_calls: None,
                    tool_call_id: None,
                    thinking: None,
                    thinking_signature: None,
                    continuation: None,
                    attachments: Vec::new(),
                },
            );
        }
    }

    // Loop-local counters for per-turn and cumulative usage tracking. The stream
    // loop mutates these in place; terminal events carry them to the UI.
    let mut total_tokens: u32 = 0;
    let mut generation_progress = StreamProgress::default();
    let mut total_cache_read_tokens: u32 = 0;
    let mut total_cache_creation_tokens: u32 = 0;
    let mut last_prompt_tokens: u32 = 0;
    let mut last_context_tokens: u32 = 0;
    let mut last_completion_tokens: u32 = 0;
    let mut retry_attempt = 0u32;
    // Consecutive empty completions this turn (see the empty-response retry).
    let mut empty_response_retries = 0u32;
    let max_retries = 2u32;
    let base_delay_ms = 500u64;
    // Provider-reported context overflows recovered by forced compaction this
    // turn. Bounded: a transcript that will not fit must still fail loudly.
    const MAX_OVERFLOW_RECOVERIES: u32 = 2;
    let mut overflow_recoveries = 0u32;

    // Identical-tool-call ("action stationarity") detection for this turn.
    let mut loop_detector = LoopDetector::new(loop_nudge_after, loop_stop_after);

    // Running context-size estimate for the compaction gate: seeded once here,
    // then incremented per appended message and recomputed only when the
    // conversation is rewritten (normalization repair, compaction).
    let mut running_tokens = crate::context::estimate_message_tokens(&messages);
    // What the provider counted beyond our estimate on the last request (its
    // tokenizer, framing, the system prompt's template), learned from the
    // reported prompt size so the compaction gate tracks the real one.
    let mut tokenizer_gap = 0usize;

    let provider = registry
        .get(&provider_id)
        .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;

    tracing::info!(provider = %provider_id, "Provider found, starting chat loop");

    let mut iteration = 0u32;
    while max_iterations.map(|max| iteration < max).unwrap_or(true) {
        iteration += 1;

        if cancel_signal.is_aborted() {
            tracing::info!("Chat task cancelled");
            send_turn_usage(
                &sender,
                task_id,
                is_subagent,
                &last_prompt_tokens,
                &last_completion_tokens,
                &total_cache_read_tokens,
                &total_cache_creation_tokens,
                &last_context_tokens,
            );
            send_event(
                &sender,
                task_id,
                AgentEvent::Cancelled {
                    conversation: messages,
                    tokens: total_tokens,
                    partial_text: String::new(),
                },
            );
            return Ok(());
        }

        // Messages the user sent mid-turn join here, after a complete tool
        // round (tool results followed by user text is valid everywhere).
        if let Some(inbox) = &user_inbox {
            let arrived: Vec<Message> = std::mem::take(&mut *inbox.lock());
            if !arrived.is_empty() {
                let texts: Vec<String> = arrived.iter().map(|m| m.content.clone()).collect();
                for message in arrived {
                    running_tokens = running_tokens.saturating_add(
                        crate::context::estimate_message_tokens(std::slice::from_ref(&message)),
                    );
                    messages.push(message);
                }
                send_event(
                    &sender,
                    task_id,
                    AgentEvent::UserMessagesInjected { messages: texts },
                );
            }
        }

        tracing::info!(
            iteration,
            message_count = messages.len(),
            "Starting iteration"
        );

        // Recover old sessions and interrupted runs containing incomplete or
        // orphaned tool messages before sending provider requests. The repair
        // may drop or pad messages, so the running token count is refreshed
        // only when it actually changed something.
        let (normalized, normalized_changed) =
            crate::context::normalize_tool_messages_tracked(messages);
        messages = normalized;
        if normalized_changed {
            running_tokens = crate::context::estimate_message_tokens(&messages);
        }

        let (tx, mut rx) = tokio::sync::mpsc::channel::<StreamEvent>(256);

        send_event(&sender, task_id, AgentEvent::Thinking);

        let model_clone = model.clone();
        let provider_clone = provider.clone();

        // Same resolution as TUI: registry + models.dev catalog (thinking levels,
        // context window). Never use a bare discovery stub when catalog knows the model.
        let mut model_info = crate::providers::resolve_model_info(
            registry.as_ref(),
            catalog.as_ref(),
            &provider_id,
            &model_clone,
        );
        // Prefer live provider registration id/api_id if present.
        if let Some(known) = provider.get_model(&model_clone) {
            model_info.id = known.id.clone();
            model_info.api_id = known.api_id.clone();
            if model_info.name.is_empty() || model_info.name == model_info.id {
                model_info.name = known.name.clone();
            }
        }
        let api_format = provider.request_api_format(&model_info);
        model_info.options = provider.get_request_options(&model_info);
        apply_thinking_level(&mut model_info, api_format, &thinking_level);
        let price = model_info.cost.clone();

        let tool_defs = if provider.info().capabilities.tools && model_info.capabilities.toolcall {
            tool_registry.definitions_for_mode(mode)
        } else {
            Vec::new()
        };
        // Every request carries the tool schemas as well as the messages.
        let tool_tokens = crate::context::estimate_tool_definition_tokens(&tool_defs);

        // Auto-compact before the request when the estimated context is near
        // the model's window. Mirrors pi's `shouldCompact`, which uses the
        // model's real context window plus a reserved summary budget.
        let strategy = CompactionStrategy::for_window(
            model_info.limits.context as usize,
            tool_tokens + tokenizer_gap,
        );
        let estimated_tokens = running_tokens;
        if strategy.should_compact(estimated_tokens) {
            tracing::info!(
                iteration,
                estimated_tokens,
                message_budget = strategy.max_tokens,
                tool_tokens,
                "Compacting agent context"
            );
            // Smart compaction (user setting) writes an LLM checkpoint,
            // falling back to trimming if the summary fails; otherwise trim
            // straight away — instant, and no extra model call.
            let smart = smart_compaction;
            send_event(&sender, task_id, AgentEvent::CompactionStarted { smart });
            let compactor = ContextCompactor::new(strategy.clone());
            let compactor = if smart {
                compactor.with_summarizer(Arc::new(ProviderSummarizer::new(
                    provider.clone(),
                    model_info.clone(),
                    crate::providers::RequestContext::new(session_id),
                )))
            } else {
                compactor
            };
            // The summarizer's own LLM round-trip can take a while; heartbeat
            // through it so the TUI's stuck guard never sees the turn silent.
            let heartbeat_sender = sender.clone();
            let mut heartbeat_tick =
                tokio::time::interval(std::time::Duration::from_millis(COMPACTION_HEARTBEAT_MS));
            heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            heartbeat_tick.tick().await;
            let compact_messages = messages.clone();
            let mut compact_task =
                tokio::spawn(async move { compactor.compact_async(compact_messages).await });
            let result = loop {
                tokio::select! {
                    res = &mut compact_task => break res,
                    _ = heartbeat_tick.tick() => {
                        send_event(
                            &heartbeat_sender,
                            task_id,
                            AgentEvent::ToolHeartbeat { id: String::new() },
                        );
                    }
                    _ = cancel_signal.wait_aborted() => {
                        compact_task.abort();
                        send_turn_usage(
                            &sender,
                            task_id,
                            is_subagent,
                            &last_prompt_tokens,
                            &last_completion_tokens,
                            &total_cache_read_tokens,
                            &total_cache_creation_tokens,
                            &last_context_tokens,
                        );
                        send_event(
                            &sender,
                            task_id,
                            AgentEvent::Cancelled {
                                conversation: messages,
                                tokens: total_tokens,
                                partial_text: String::new(),
                            },
                        );
                        return Ok(());
                    }
                }
            };
            // A JoinError here means the compaction task panicked — skip
            // compaction and let the turn continue with the full context.
            let compacted = match result {
                Ok(r) => Some(r),
                Err(e) => {
                    tracing::warn!(error = %e, "compaction task failed; continuing un-compacted");
                    None
                }
            };
            if let Some(result) = compacted {
                if result.summary.tokens_saved > 0 {
                    tracing::info!(
                        iteration,
                        tokens_saved = result.summary.tokens_saved,
                        "Agent context compacted"
                    );
                    let summary = format!(
                        "Context compacted automatically ({}).",
                        result.summary.content
                    );
                    let tokens_after = crate::context::estimate_message_tokens(&result.messages);
                    send_event(
                        &sender,
                        task_id,
                        AgentEvent::ContextCompacted {
                            summary,
                            tokens_before: estimated_tokens as u32,
                            tokens_after: tokens_after as u32,
                            smart,
                            compacted_conversation: result.messages.clone(),
                        },
                    );
                    messages = result.messages;
                    running_tokens = tokens_after;
                }
            }
        }

        let messages_clone = messages.clone();
        let request_context = crate::providers::RequestContext::new(session_id);
        let request_estimate = running_tokens + tool_tokens;

        tracing::info!(iteration, format = ?api_format, tool_count = tool_defs.len(), "Starting provider request");
        let request_started = std::time::Instant::now();

        // What media this model takes, for the tool results below (the request
        // task takes `model_info`).
        let accepted_media: Vec<agente_protocol::AttachmentKind> = [
            agente_protocol::AttachmentKind::Image,
            agente_protocol::AttachmentKind::Audio,
            agente_protocol::AttachmentKind::Video,
            agente_protocol::AttachmentKind::Pdf,
        ]
        .into_iter()
        .filter(|kind| crate::media::model_accepts(&model_info, *kind))
        .collect();
        let stream_handle = tokio::spawn(
            async move {
                let tools_for_request = if tool_defs.is_empty() {
                    None
                } else {
                    Some(tool_defs.as_slice())
                };
                match provider_clone
                    .stream_completion(
                        &messages_clone,
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

        let mut full_response = String::new();
        let mut full_reasoning = String::new();
        let mut thinking_signature: Option<String> = None;
        let mut continuation = None;
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut tool_call_accumulators: std::collections::HashMap<String, (String, String)> =
            std::collections::HashMap::new();
        let mut stream_error: Option<String> = None;
        let mut stream_stop_reason = StopReason::Unknown;
        let mut received_output = false;

        loop {
            tokio::select! {
                event = rx.recv() => {
                    match event {
                        Some(event) => match event {
                            StreamEvent::TextDelta(text) => {
                                received_output |= !text.is_empty();
                                generation_progress.record(text.len(), None, &sender, task_id);
                                full_response.push_str(&text);
                                send_event(&sender, task_id, AgentEvent::TextDelta(text.clone()));
                                if text.len() > 10 {
                                    tokio::task::yield_now().await;
                                }
                            }
                            StreamEvent::TextStart | StreamEvent::TextEnd => {}
                            StreamEvent::ReasoningDelta(text) => {
                                received_output |= !text.is_empty();
                                generation_progress.record(text.len(), None, &sender, task_id);
                                full_reasoning.push_str(&text);
                                send_event(&sender, task_id, AgentEvent::ReasoningDelta(text));
                            }
                            StreamEvent::ReasoningStart | StreamEvent::ReasoningEnd => {}
                            StreamEvent::ThinkingSignature(sig) => {
                                received_output = true;
                                thinking_signature = Some(sig);
                            }
                            StreamEvent::Continuation(value) => {
                                received_output = true;
                                continuation = Some(value);
                            }
                            StreamEvent::ToolCallStart { name, id } => {
                                received_output = true;
                                generation_progress.record(0, Some(&name), &sender, task_id);
                                tool_call_accumulators.insert(id.clone(), (name, String::new()));
                            }
                            StreamEvent::ToolCallDelta { id, args_delta } => {
                                received_output |= !args_delta.is_empty();
                                if let Some((name, accumulated)) = tool_call_accumulators.get_mut(&id) {
                                    generation_progress.record(args_delta.len(), Some(name), &sender, task_id);
                                    accumulated.push_str(&args_delta);
                                }
                            }
                            StreamEvent::ToolCallEnd { id } => {
                                received_output = true;
                                if let Some((name, args)) = tool_call_accumulators.remove(&id) {
                                    tool_calls.push(ToolCall {
                                        id: id.clone(),
                                        call_type: "function".to_string(),
                                        function: FunctionCall {
                                            name: name.clone(),
                                            arguments: args.clone(),
                                        },
                                    });
                                    send_event(&sender, task_id, AgentEvent::ToolCallStart {
                                        id: id.clone(),
                                        name: name.clone(),
                                        args: args.clone(),
                                    });
                                }
                            }
                            StreamEvent::Done {
                                usage,
                                stop_reason,
                            } => {
                                total_tokens = total_tokens.saturating_add(usage.total_tokens);
                                total_cache_read_tokens = total_cache_read_tokens
                                    .saturating_add(usage.cache_read_tokens);
                                total_cache_creation_tokens = total_cache_creation_tokens
                                    .saturating_add(usage.cache_creation_tokens);
                                last_prompt_tokens = usage.prompt_tokens;
                                last_context_tokens = usage
                                    .prompt_tokens
                                    .saturating_add(usage.cache_read_tokens)
                                    .saturating_add(usage.cache_creation_tokens);
                                if last_context_tokens > 0 {
                                    tokenizer_gap = (last_context_tokens as usize)
                                        .saturating_sub(request_estimate);
                                }
                                last_completion_tokens = usage.completion_tokens;
                                send_event(&sender, task_id, AgentEvent::CallUsage {
                                    prompt_tokens: usage.prompt_tokens,
                                    completion_tokens: usage.completion_tokens,
                                    cache_read_tokens: usage.cache_read_tokens,
                                    cache_creation_tokens: usage.cache_creation_tokens,
                                    // The provider's own charge wins; the
                                    // catalog price is the estimate.
                                    cost_usd: usage.cost_usd.or_else(|| {
                                        price.is_priced().then(|| {
                                            price.cost_usd(
                                                usage.prompt_tokens,
                                                usage.completion_tokens,
                                                usage.cache_read_tokens,
                                                usage.cache_creation_tokens,
                                            )
                                        })
                                    }),
                                    cost_estimated: usage.cost_usd.is_none(),
                                    subagent_id: None,
                                });
                                stream_stop_reason = stop_reason;
                                break;
                            }
                            StreamEvent::Error(msg) => {
                                stream_error = Some(msg);
                                break;
                            }
                        },
                        None => break,
                    }
                }
                _ = cancel_signal.wait_aborted() => {
                    tracing::info!("Chat task cancelled during streaming");
                    stream_handle.abort();
                    send_turn_usage(
                        &sender,
                        task_id,
                        is_subagent,
                        &last_prompt_tokens,
                        &last_completion_tokens,
                        &total_cache_read_tokens,
                        &total_cache_creation_tokens,
                        &last_context_tokens,
                    );
                    send_event(
                        &sender,
                        task_id,
                        AgentEvent::Cancelled {
                            conversation: messages,
                            tokens: total_tokens,
                            partial_text: std::mem::take(&mut full_response),
                        },
                    );
                    return Ok(());
                }
            }
        }

        generation_progress.finish_request(&sender, task_id);
        // A provider must not remain blocked sending after its terminal event.
        drop(rx);
        let stream_result = match stream_handle.await {
            Ok(Ok(usage)) => Ok(usage),
            Ok(Err(e)) => Err(format!("Stream error: {e}")),
            Err(e) => Err(format!("Task join error: {e}")),
        };

        // One retry path for both error sources: the stream consumer's
        // `StreamEvent::Error` (preferred) and the provider task's own
        // `Err` (join/network failures). Retryable errors back off and
        // re-request; anything else ends the turn with a categorized error.
        let stream_failure = stream_error
            .clone()
            .or_else(|| stream_result.as_ref().err().cloned());
        if let Some(err) = stream_failure {
            tracing::warn!(iteration, retry_attempt, elapsed_ms = request_started.elapsed().as_millis(), error = %crate::util::redact_secrets(&err), "Provider request failed");
            // Provider-side context overflow: the pre-request estimate said
            // the transcript fits, but the provider (real tokenizer, plus the
            // tool schemas the estimate never counts) disagrees. Shrink the
            // transcript deterministically — no extra LLM call that would
            // itself overflow — and re-issue the request.
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
                let tokens_before = running_tokens;
                let forced = ContextCompactor::new(strategy.clone()).compact_forced(messages);
                if forced.summary.tokens_saved > 0 {
                    let summary = format!(
                        "Provider reported context overflow; {}",
                        forced.summary.content
                    );
                    messages = forced.messages;
                    running_tokens = crate::context::estimate_message_tokens(&messages);
                    send_event(
                        &sender,
                        task_id,
                        AgentEvent::ContextCompacted {
                            summary,
                            tokens_before: tokens_before as u32,
                            tokens_after: running_tokens as u32,
                            smart: false,
                            compacted_conversation: messages.clone(),
                        },
                    );
                    continue;
                }
                messages = forced.messages;
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
                    &sender,
                    task_id,
                    AgentEvent::Retry {
                        attempt: retry_attempt,
                        max_attempts: max_retries,
                        delay_ms: delay,
                    },
                );
                if wait_retry_or_cancel(&cancel_signal, std::time::Duration::from_millis(delay))
                    .await
                {
                    send_turn_usage(
                        &sender,
                        task_id,
                        is_subagent,
                        &last_prompt_tokens,
                        &last_completion_tokens,
                        &total_cache_read_tokens,
                        &total_cache_creation_tokens,
                        &last_context_tokens,
                    );
                    send_event(
                        &sender,
                        task_id,
                        AgentEvent::Cancelled {
                            conversation: messages,
                            tokens: total_tokens,
                            partial_text: std::mem::take(&mut full_response),
                        },
                    );
                    return Ok(());
                }
                continue;
            }
            let user_msg =
                crate::util::redact_secrets(&categorize_error(&err, &provider_id, &model));
            return Err(AgentLoopFailure {
                message: user_msg,
                conversation: messages,
            });
        }

        retry_attempt = 0;
        tracing::info!(iteration, elapsed_ms = request_started.elapsed().as_millis(), stop = ?stream_stop_reason, text_bytes = full_response.len(), reasoning_bytes = full_reasoning.len(), tool_calls = tool_calls.len(), "Provider request completed");

        // The provider's per-request usage is the true context size; forward
        // it every iteration so the status bar tracks the turn live instead
        // of freezing until Done.
        send_turn_usage(
            &sender,
            task_id,
            is_subagent,
            &last_prompt_tokens,
            &last_completion_tokens,
            &total_cache_read_tokens,
            &total_cache_creation_tokens,
            &last_context_tokens,
        );

        // An empty completion (no text, no tool calls) means the turn
        // produced nothing: a safety block, a provider hiccup, or a
        // truncated stream that ended before any content arrived. Retry
        // once; a second empty response surfaces as a visible error instead
        // of a silent Done that leaves the user with nothing.
        if full_response.is_empty() && tool_calls.is_empty() {
            if stream_stop_reason == StopReason::Safety {
                return Err(AgentLoopFailure {
                    message: "The model declined to respond (safety filter). Rephrase the request or try a different model with /model."
                        .to_string(),
                    conversation: messages,
                });
            }
            if empty_response_retries == 0 {
                empty_response_retries += 1;
                tracing::warn!(
                    stop = ?stream_stop_reason,
                    iteration,
                    "Empty completion; retrying once"
                );
                continue;
            }
            return Err(AgentLoopFailure {
                message: "The model returned an empty response twice. This is usually temporary — try again, or switch models with /model."
                    .to_string(),
                conversation: messages,
            });
        }
        empty_response_retries = 0;

        // A length-limited response must not read as a finished answer.
        if stream_stop_reason == StopReason::Length && !full_response.is_empty() {
            full_response.push_str("\n\n[response truncated by the model's output limit]");
        }

        if !full_response.is_empty() || !tool_calls.is_empty() {
            // Take (not clone) the stream buffers: both are dead once the
            // assistant message is pushed and the transcript event is sent.
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
            running_tokens = running_tokens.saturating_add(
                crate::context::estimate_message_tokens(std::slice::from_ref(&assistant_message)),
            );
            messages.push(assistant_message);
            if !response_text.is_empty() {
                send_event(&sender, task_id, AgentEvent::AssistantText(response_text));
            }
        }

        // The user sent something while this reply streamed: answer it in
        // the same turn instead of finishing.
        if tool_calls.is_empty()
            && !cancel_signal.is_aborted()
            && user_inbox
                .as_ref()
                .is_some_and(|inbox| !inbox.lock().is_empty())
        {
            continue;
        }

        if tool_calls.is_empty() {
            tracing::info!("Chat task completed, no more tool calls");
            send_turn_usage(
                &sender,
                task_id,
                is_subagent,
                &last_prompt_tokens,
                &last_completion_tokens,
                &total_cache_read_tokens,
                &total_cache_creation_tokens,
                &last_context_tokens,
            );
            send_event(
                &sender,
                task_id,
                AgentEvent::Done {
                    conversation: messages,
                    tokens: total_tokens,
                },
            );
            return Ok(());
        }

        // Check cancel before executing any tools
        if cancel_signal.is_aborted() {
            tracing::info!("Chat task cancelled before tool execution");
            send_turn_usage(
                &sender,
                task_id,
                is_subagent,
                &last_prompt_tokens,
                &last_completion_tokens,
                &total_cache_read_tokens,
                &total_cache_creation_tokens,
                &last_context_tokens,
            );
            send_event(
                &sender,
                task_id,
                AgentEvent::Cancelled {
                    conversation: messages,
                    tokens: total_tokens,
                    partial_text: String::new(),
                },
            );
            return Ok(());
        }

        tracing::info!(tool_count = tool_calls.len(), "Executing tool calls");

        // "Action stationarity" check: a model repeating the exact same tool
        // call (same name + canonical arguments) is stuck. Nudge it once at
        // the threshold; at the hard limit stop the turn with paired error
        // results so the provider never sees unpaired tool_use blocks.
        let mut hard_stop = false;
        let mut nudge_after_batch = false;
        for call in &tool_calls {
            match loop_detector.record(&call.function.name, &call.function.arguments) {
                LoopVerdict::Stop => hard_stop = true,
                LoopVerdict::Nudge => nudge_after_batch = true,
                LoopVerdict::Normal => {}
            }
        }

        if hard_stop {
            tracing::warn!(iteration, "Stopping repeated tool-call loop");
            let max_repeats = tool_calls
                .iter()
                .map(|call| loop_detector.repeats_of(&call.function.name, &call.function.arguments))
                .max()
                .unwrap_or(0);
            let loop_error = format!(
                "Error: this exact tool call was repeated {max_repeats} times without \
                 making progress; the turn was stopped to break the loop."
            );
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
                running_tokens = running_tokens.saturating_add(
                    crate::context::estimate_message_tokens(std::slice::from_ref(&tool_message)),
                );
                send_event(
                    &sender,
                    task_id,
                    AgentEvent::ToolCallResult {
                        id: call.id.clone(),
                        name: call.function.name.clone(),
                        result: loop_error.clone(),
                        is_error: true,
                    },
                );
                messages.push(tool_message);
            }
            send_event(
                &sender,
                task_id,
                AgentEvent::AssistantText(
                    "Stopped: the model kept repeating identical tool calls without \
                     progress. Send another message with a different instruction to \
                     continue."
                        .to_string(),
                ),
            );
            send_turn_usage(
                &sender,
                task_id,
                is_subagent,
                &last_prompt_tokens,
                &last_completion_tokens,
                &total_cache_read_tokens,
                &total_cache_creation_tokens,
                &last_context_tokens,
            );
            send_event(
                &sender,
                task_id,
                AgentEvent::Done {
                    conversation: messages,
                    tokens: total_tokens,
                },
            );
            return Ok(());
        }

        let outcomes = execute_tool_calls_batched(
            &tool_calls,
            Arc::clone(&tool_registry),
            sender.clone(),
            task_id,
            &permission_engine,
            &approval_broker,
            &cancel_signal,
            &project_dir,
            depth,
            subagent_host.as_ref(),
        )
        .await;

        // Media a tool returned (a browser screenshot, say) goes to the model
        // when it takes that kind; otherwise the result's text stands alone.
        let mut tool_images = Vec::new();
        for (i, outcome) in outcomes.into_iter().enumerate() {
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
            running_tokens = running_tokens.saturating_add(
                crate::context::estimate_message_tokens(std::slice::from_ref(&tool_message)),
            );
            messages.push(tool_message);
        }

        if !tool_images.is_empty() {
            let image_message = Message {
                role: Role::User,
                content: "Media from the latest tool results.".into(),
                attachments: tool_images,
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
            };
            running_tokens = running_tokens.saturating_add(
                crate::context::estimate_message_tokens(std::slice::from_ref(&image_message)),
            );
            messages.push(image_message);
        }

        // First repeat that crossed the nudge threshold: guide the model out
        // of the loop for the next request (fires once per looping signature).
        if nudge_after_batch {
            let nudge_message = Message {
                role: Role::User,
                content: "You have repeated an identical tool call (same tool and \
                          arguments) several times without progress. Change your \
                          approach: adjust the parameters, gather different \
                          information, or explain what is blocking you instead of \
                          retrying."
                    .to_string(),
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: Vec::new(),
            };
            running_tokens = running_tokens.saturating_add(
                crate::context::estimate_message_tokens(std::slice::from_ref(&nudge_message)),
            );
            messages.push(nudge_message);
        }
    }

    // The model kept requesting tool calls until the iteration budget ran out.
    // Unbounded runs never reach this point: without a budget the loop only
    // exits via the Done/Cancelled/Error returns inside, so falling through
    // here proves the request carried an explicit cap.
    let max = max_iterations.expect("capped loop must carry a budget");
    tracing::warn!(iteration = max, "Chat task reached max iterations");
    let notice = format!(
        "Reached the iteration limit ({max}) for this turn. The task is paused; send another message to continue."
    );
    send_event(&sender, task_id, AgentEvent::AssistantText(notice));
    send_turn_usage(
        &sender,
        task_id,
        is_subagent,
        &last_prompt_tokens,
        &last_completion_tokens,
        &total_cache_read_tokens,
        &total_cache_creation_tokens,
        &last_context_tokens,
    );
    send_event(
        &sender,
        task_id,
        AgentEvent::Done {
            conversation: messages,
            tokens: total_tokens,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::channel::approval::check_missing_args;
    use crate::agent::channel::args::{normalize_tool_args, parse_tool_args};
    use crate::catalog::{ModelCapabilities, ModelCost, ModelLimits, ModelStatus};
    use crate::providers::ModelInfo;

    fn reasoning_model() -> ModelInfo {
        use crate::catalog::ReasoningOption;
        ModelInfo {
            api: Default::default(),
            id: "reasoning-model".to_string(),
            name: "Reasoning Model".to_string(),
            api_id: "reasoning-model".to_string(),
            provider_id: "test".to_string(),
            capabilities: ModelCapabilities {
                reasoning: true,
                ..Default::default()
            },
            cost: ModelCost::default(),
            limits: ModelLimits {
                context: 128_000,
                input: None,
                output: 16_384,
            },
            status: ModelStatus::Active,
            headers: std::collections::HashMap::new(),
            options: std::collections::HashMap::new(),
            reasoning_options: vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into(), "max".into()],
                },
            ],
            reasoning_stream_field: None,
            compat: crate::thinking::ThinkingFormat::Default,
        }
    }

    #[test]
    fn applies_catalog_thinking_levels_verbatim() {
        use crate::providers::ApiFormat;
        use crate::thinking::THINKING_OFF;
        let mut openai = reasoning_model();
        apply_thinking_level(&mut openai, ApiFormat::OpenAI, "max");
        assert_eq!(
            openai.options.get("reasoning_effort"),
            Some(&serde_json::json!("max"))
        );

        let mut anthropic = reasoning_model();
        apply_thinking_level(&mut anthropic, ApiFormat::Anthropic, "high");
        // An Anthropic-compatible non-Claude model uses enabled thinking and
        // the effort option without inheriting Claude adaptive mode.
        assert_eq!(anthropic.options["thinking"]["type"], "enabled");
        assert_eq!(anthropic.options["output_config"]["effort"], "high");

        apply_thinking_level(&mut openai, ApiFormat::OpenAI, THINKING_OFF);
        assert!(!openai.options.contains_key("reasoning_effort"));
    }

    #[test]
    fn normalizes_write_file_aliases() {
        let args = serde_json::json!({
            "filePath": "src/main.rs",
            "fileContent": "fn main() {}"
        });
        let normalized = normalize_tool_args("write_file", args);
        assert_eq!(
            normalized.get("path").and_then(|v| v.as_str()),
            Some("src/main.rs")
        );
        assert_eq!(
            normalized.get("content").and_then(|v| v.as_str()),
            Some("fn main() {}")
        );
        assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
    }

    #[test]
    fn normalizes_nested_tool_arguments() {
        let args = serde_json::json!({
            "input": {
                "filename": "hello.txt",
                "contents": "hello"
            }
        });
        let normalized = normalize_tool_args("write_file", args);
        assert_eq!(
            normalized.get("path").and_then(|v| v.as_str()),
            Some("hello.txt")
        );
        assert_eq!(
            normalized.get("content").and_then(|v| v.as_str()),
            Some("hello")
        );
        assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
    }

    #[test]
    fn parses_double_encoded_tool_arguments() {
        let parsed = parse_tool_args(r#""{\"path\":\"a.txt\",\"content\":\"ok\"}""#);
        let normalized = normalize_tool_args("write_file", parsed);
        assert_eq!(
            normalized.get("path").and_then(|v| v.as_str()),
            Some("a.txt")
        );
        assert_eq!(
            normalized.get("content").and_then(|v| v.as_str()),
            Some("ok")
        );
        assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
    }

    #[test]
    fn reports_missing_write_file_fields() {
        let args = serde_json::json!({"content": "missing path"});
        let outcome = check_missing_args("call_1", "write_file", &args).unwrap();
        assert_eq!(outcome.tool_call_id, "call_1");
        assert!(outcome.content.contains("path"));
    }

    #[test]
    fn recovers_write_file_with_literal_newlines() {
        let raw = "{\"path\": \"game.js\", \"content\": \"const a = 1;\nconst b = 2;\n\"}";
        let parsed = parse_tool_args(raw);
        let normalized = normalize_tool_args("write_file", parsed);
        assert_eq!(
            normalized.get("path").and_then(|v| v.as_str()),
            Some("game.js")
        );
        assert_eq!(
            normalized.get("content").and_then(|v| v.as_str()),
            Some("const a = 1;\nconst b = 2;\n")
        );
        assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
    }

    #[test]
    fn recovers_unterminated_large_write_content() {
        let raw = "{\"path\": \"game.js\", \"content\": \"const canvas = document.getElementById('game');\nfunction loop() { requestAnimationFrame(loop); }";
        let parsed = parse_tool_args(raw);
        let normalized = normalize_tool_args("write_file", parsed);
        assert_eq!(
            normalized.get("path").and_then(|v| v.as_str()),
            Some("game.js")
        );
        assert!(normalized
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .contains("requestAnimationFrame"));
        assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
    }

    #[test]
    fn send_event_tags_task_id() {
        let (tx, rx) = std::sync::mpsc::channel();
        send_event(&tx, 42, AgentEvent::Thinking);
        let msg = rx.recv().unwrap();
        assert_eq!(msg.task_id, 42);
        assert!(matches!(msg.event, AgentEvent::Thinking));
    }

    /// A provider that rejects the first request with context overflow, then
    /// answers normally. Models the OpenRouter `context_length_exceeded`
    /// failure from a transcript the local estimate claimed would fit.
    struct OverflowThenOkProvider {
        info: crate::providers::ProviderInfo,
        calls: std::sync::Mutex<u32>,
        first_error: &'static str,
        fail_calls: u32,
        partial_event: Option<crate::llm::StreamEvent>,
    }

    #[async_trait::async_trait]
    impl crate::providers::Provider for OverflowThenOkProvider {
        fn info(&self) -> &crate::providers::ProviderInfo {
            &self.info
        }

        async fn stream_completion(
            &self,
            _messages: &[Message],
            _tools: Option<&[crate::types::ToolDefinition]>,
            _model: &crate::providers::ModelInfo,
            sender: tokio::sync::mpsc::Sender<crate::llm::StreamEvent>,
            _context: crate::providers::RequestContext,
        ) -> Result<crate::llm::Usage, crate::llm::LlmError> {
            let first_call = {
                let mut calls = self.calls.lock().unwrap();
                *calls += 1;
                *calls <= self.fail_calls
            };
            if first_call {
                if let Some(event) = &self.partial_event {
                    sender.send(event.clone()).await.ok();
                }
                return Err(crate::llm::LlmError::StreamError(
                    self.first_error.to_string(),
                ));
            }
            sender
                .send(crate::llm::StreamEvent::TextDelta("recovered".to_string()))
                .await
                .ok();
            sender
                .send(crate::llm::StreamEvent::Done {
                    usage: crate::llm::Usage::default(),
                    stop_reason: crate::llm::StopReason::Stop,
                })
                .await
                .ok();
            Ok(crate::llm::Usage::default())
        }

        async fn list_models(
            &self,
        ) -> Result<Vec<crate::providers::ModelInfo>, crate::llm::LlmError> {
            Ok(Vec::new())
        }
    }

    /// First call: the user "sends now" while the reply streams. Second
    /// call: must see that message, in the same turn.
    struct MidTurnProvider {
        info: crate::providers::ProviderInfo,
        inbox: super::super::config::UserInbox,
        seen: std::sync::Mutex<Vec<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl crate::providers::Provider for MidTurnProvider {
        fn info(&self) -> &crate::providers::ProviderInfo {
            &self.info
        }

        async fn stream_completion(
            &self,
            messages: &[Message],
            _tools: Option<&[crate::types::ToolDefinition]>,
            _model: &crate::providers::ModelInfo,
            sender: tokio::sync::mpsc::Sender<crate::llm::StreamEvent>,
            _context: crate::providers::RequestContext,
        ) -> Result<crate::llm::Usage, crate::llm::LlmError> {
            let call = {
                let mut seen = self.seen.lock().unwrap();
                seen.push(messages.iter().map(|m| m.content.clone()).collect());
                seen.len()
            };
            if call == 1 {
                self.inbox
                    .lock()
                    .push(Message::user("also update the docs"));
            }
            let text = if call == 1 {
                "first answer"
            } else {
                "docs updated"
            };
            sender
                .send(crate::llm::StreamEvent::TextDelta(text.to_string()))
                .await
                .ok();
            sender
                .send(crate::llm::StreamEvent::Done {
                    usage: crate::llm::Usage::default(),
                    stop_reason: crate::llm::StopReason::Stop,
                })
                .await
                .ok();
            Ok(crate::llm::Usage::default())
        }

        async fn list_models(
            &self,
        ) -> Result<Vec<crate::providers::ModelInfo>, crate::llm::LlmError> {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn messages_sent_mid_turn_join_the_same_turn() {
        use crate::cancellation::AbortController;
        use crate::permissions::{shared_permission_engine, ApprovalBroker};
        use crate::types::AgentMode;

        let inbox = super::super::config::UserInbox::default();
        let registry = Arc::new(ProviderRegistry::new());
        let provider = Arc::new(MidTurnProvider {
            info: crate::providers::ProviderInfo {
                id: "test-overflow".into(),
                models: vec![overflow_test_model()],
                ..Default::default()
            },
            inbox: Arc::clone(&inbox),
            seen: std::sync::Mutex::new(Vec::new()),
        });
        registry.register("test-overflow", provider.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        let config = AgentRunConfig {
            session_id: uuid::Uuid::new_v4(),
            task_id: 1,
            sender: tx,
            messages: vec![Message::user("fix the parser")],
            provider_id: "test-overflow".into(),
            model: "stub-model".into(),
            thinking_level: "off".into(),
            project_dir: ".".into(),
            max_iterations: Some(5),
            registry,
            catalog: None,
            permission_engine: shared_permission_engine(AgentMode::Build),
            cancel_signal: AbortController::new().signal(),
            approval_broker: ApprovalBroker::new(),
            mcp_manager: None,
            subagent_host: None,
            custom_agents: Vec::new(),
            tool_policy: None,
            is_subagent: false,
            depth: 0,
            loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
            loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
            smart_compaction: false,
            user_inbox: Some(Arc::clone(&inbox)),
            extra_tools: Vec::new(),
            only_tools: None,
            shell_env: Default::default(),
        };
        run_agent_loop(config).await.expect("turn completes");

        let seen = provider.seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 2, "the turn went on instead of finishing");
        assert_eq!(
            seen[1][seen[1].len() - 2..],
            [
                "first answer".to_string(),
                "also update the docs".to_string()
            ],
            "the message joins after the reply it arrived during"
        );
        assert!(inbox.lock().is_empty(), "taken from the inbox");
        let events: Vec<AgentTaskEvent> = rx.try_iter().collect();
        assert!(events.iter().any(|e| matches!(
            &e.event,
            AgentEvent::UserMessagesInjected { messages } if messages == &["also update the docs"]
        )));
        let done = events
            .iter()
            .find_map(|e| match &e.event {
                AgentEvent::Done { conversation, .. } => Some(conversation.clone()),
                _ => None,
            })
            .expect("Done");
        assert_eq!(done.last().unwrap().content, "docs updated");
    }

    fn overflow_test_model() -> crate::providers::ModelInfo {
        let mut model = reasoning_model();
        model.id = "stub-model".to_string();
        model.api_id = "stub-model".to_string();
        model.name = "Stub Model".to_string();
        model.provider_id = "test-overflow".to_string();
        model.limits.context = 8_000;
        model
    }

    fn tool_result_message(id: &str, lines: usize) -> Vec<Message> {
        let body: String = (0..lines)
            .map(|i| format!("src/file{i}.rs:1:match some_identifier_{id}_{i}\n"))
            .collect();
        vec![
            Message {
                role: Role::Assistant,
                content: String::new(),
                tool_calls: Some(vec![ToolCall {
                    id: id.to_string(),
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: "grep".to_string(),
                        arguments: "{}".to_string(),
                    },
                }]),
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: Vec::new(),
            },
            Message {
                role: Role::Tool,
                content: body,
                tool_calls: None,
                tool_call_id: Some(id.to_string()),
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: Vec::new(),
            },
        ]
    }

    /// Provider-side context overflow compacts the transcript and retries the
    /// turn instead of dying: the estimate said the transcript fits (below
    /// the 85% auto-compact gate), the provider disagreed.
    #[tokio::test]
    async fn provider_overflow_compacts_and_retries_the_turn() {
        use crate::cancellation::AbortController;
        use crate::permissions::{shared_permission_engine, ApprovalBroker};
        use crate::types::AgentMode;

        let dir = std::env::temp_dir().join(format!("agente-overflow-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let model = overflow_test_model();
        let registry = Arc::new(ProviderRegistry::new());
        let provider = Arc::new(OverflowThenOkProvider {
            info: crate::providers::ProviderInfo {
                id: "test-overflow".to_string(),
                name: "Test Overflow".to_string(),
                models: vec![model],
                ..Default::default()
            },
            calls: std::sync::Mutex::new(0),
            first_error: "The request is 265713 tokens long and exceeds this model's context length of 262144 tokens (context_length_exceeded)",
            fail_calls: 1,
            partial_event: None,
        });
        registry.register("test-overflow", provider.clone());

        // ~5.7k estimated tokens across 12 messages: below the 6.8k
        // auto-compact gate (which must NOT fire), above the 4.8k forced
        // target, with the bulk outside the last 8 messages so forced
        // compaction can bite.
        let mut messages = vec![Message {
            role: Role::System,
            content: "system prompt".to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }];
        for i in 0..5 {
            messages.extend(tool_result_message(&format!("c{i}"), 100));
        }
        messages.push(Message {
            role: Role::User,
            content: "go".to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        });
        let estimate = crate::context::estimate_message_tokens(&messages);
        assert!(
            estimate < 6_800,
            "fixture must stay below the auto-compact gate, got {estimate}"
        );
        let original_chars: usize = messages.iter().map(|m| m.content.len()).sum();

        let (tx, rx) = std::sync::mpsc::channel();
        let config = AgentRunConfig {
            session_id: uuid::Uuid::new_v4(),
            task_id: 1,
            sender: tx,
            messages,
            provider_id: "test-overflow".to_string(),
            model: "stub-model".to_string(),
            thinking_level: "off".to_string(),
            project_dir: dir.to_string_lossy().to_string(),
            max_iterations: Some(5),
            registry,
            catalog: None,
            permission_engine: shared_permission_engine(AgentMode::Build),
            cancel_signal: AbortController::new().signal(),
            approval_broker: ApprovalBroker::new(),
            mcp_manager: None,
            subagent_host: None,
            custom_agents: Vec::new(),
            tool_policy: None,
            is_subagent: false,
            depth: 0,
            loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
            loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
            smart_compaction: false,
            user_inbox: None,
            extra_tools: Vec::new(),
            only_tools: None,
            shell_env: Default::default(),
        };
        run_agent_loop(config).await.expect("turn recovers");

        assert_eq!(
            *provider.calls.lock().unwrap(),
            2,
            "one overflow, one retry"
        );
        let events: Vec<AgentTaskEvent> = rx.try_iter().collect();
        assert!(
            events.iter().any(|e| matches!(
                &e.event,
                AgentEvent::ContextCompacted { summary, .. }
                    if summary.contains("Provider reported context overflow")
            )),
            "recovery must emit ContextCompacted"
        );
        let done = events.iter().find_map(|e| match &e.event {
            AgentEvent::Done { conversation, .. } => Some(conversation),
            _ => None,
        });
        let conversation = done.expect("turn ends Done after recovery");
        let compacted_chars: usize = conversation.iter().map(|m| m.content.len()).sum();
        assert!(
            compacted_chars < original_chars,
            "Done transcript must be the compacted one"
        );
        assert!(
            conversation.iter().any(|m| m.content.contains("recovered")),
            "model answer must be present"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn interrupted_chat_stream_retries_and_delivers_the_answer() {
        let (calls, result, events) =
            failure_turn("Chat stream ended before completion", 1, None).await;
        result.expect("transient stream recovers");
        assert_eq!(calls, 2);
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::Retry { .. })));
        assert!(events.iter().any(|event| matches!(event, AgentEvent::Done { conversation, .. } if conversation.last().is_some_and(|message| message.content == "recovered"))));
    }

    #[tokio::test]
    async fn transient_retries_are_bounded_and_stop_after_any_output() {
        let error = r#"openrouter: {"code":502,"message":"Provider returned an empty response"}"#;
        let (calls, result, events) = failure_turn(error, 10, None).await;
        assert!(result.is_err());
        assert_eq!(calls, 3, "initial request plus two retries");
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, AgentEvent::Retry { .. }))
                .count(),
            2
        );
        for event in [
            crate::llm::StreamEvent::TextDelta("partial".into()),
            crate::llm::StreamEvent::ReasoningDelta("thinking".into()),
            crate::llm::StreamEvent::ToolCallStart {
                name: "read".into(),
                id: "call".into(),
            },
        ] {
            let (calls, result, events) = failure_turn(error, 1, Some(event)).await;
            assert!(result.is_err());
            assert_eq!(calls, 1, "partial output must never be replayed");
            assert!(!events
                .iter()
                .any(|event| matches!(event, AgentEvent::Retry { .. })));
        }
    }

    async fn failure_turn(
        first_error: &'static str,
        fail_calls: u32,
        partial_event: Option<crate::llm::StreamEvent>,
    ) -> (u32, Result<(), AgentLoopFailure>, Vec<AgentEvent>) {
        use crate::cancellation::AbortController;
        use crate::permissions::{shared_permission_engine, ApprovalBroker};
        use crate::types::AgentMode;

        let registry = Arc::new(ProviderRegistry::new());
        let provider = Arc::new(OverflowThenOkProvider {
            info: crate::providers::ProviderInfo {
                id: "test-overflow".into(),
                models: vec![overflow_test_model()],
                ..Default::default()
            },
            calls: std::sync::Mutex::new(0),
            first_error,
            fail_calls,
            partial_event,
        });
        registry.register("test-overflow", provider.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        let config = AgentRunConfig {
            session_id: uuid::Uuid::new_v4(),
            task_id: 1,
            sender: tx,
            messages: vec![Message::user("Say recovered")],
            provider_id: "test-overflow".into(),
            model: "stub-model".into(),
            thinking_level: "off".into(),
            project_dir: ".".into(),
            max_iterations: Some(5),
            registry,
            catalog: None,
            permission_engine: shared_permission_engine(AgentMode::Plan),
            cancel_signal: AbortController::new().signal(),
            approval_broker: ApprovalBroker::new(),
            mcp_manager: None,
            subagent_host: None,
            custom_agents: Vec::new(),
            tool_policy: None,
            is_subagent: false,
            depth: 0,
            loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
            loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
            smart_compaction: false,
            user_inbox: None,
            extra_tools: Vec::new(),
            only_tools: None,
            shell_env: Default::default(),
        };
        let result = run_agent_loop(config).await;
        let calls = *provider.calls.lock().unwrap();
        let events: Vec<_> = rx.try_iter().map(|e| e.event).collect();
        (calls, result, events)
    }

    /// Stub that demands `tool_rounds` tool executions before answering in
    /// plain text: each early request returns one `read_file` call against a
    /// temp file, later requests return a final answer with no tool calls.
    struct ToolGrinderProvider {
        info: crate::providers::ProviderInfo,
        calls: std::sync::Mutex<u32>,
        tool_rounds: u32,
        file_name: String,
    }

    #[async_trait::async_trait]
    impl crate::providers::Provider for ToolGrinderProvider {
        fn info(&self) -> &crate::providers::ProviderInfo {
            &self.info
        }

        async fn stream_completion(
            &self,
            _messages: &[Message],
            _tools: Option<&[crate::types::ToolDefinition]>,
            _model: &crate::providers::ModelInfo,
            sender: tokio::sync::mpsc::Sender<crate::llm::StreamEvent>,
            _context: crate::providers::RequestContext,
        ) -> Result<crate::llm::Usage, crate::llm::LlmError> {
            use crate::llm::StreamEvent;
            let call = {
                let mut calls = self.calls.lock().unwrap();
                *calls += 1;
                *calls
            };
            if call <= self.tool_rounds {
                let id = format!("grind-{call}");
                // Vary the range each round: identical tool+args signatures
                // would trip the loop detector's stationarity hard-stop.
                let args = format!(
                    "{{\"path\": \"{}\", \"start_line\": {call}, \"end_line\": {call}}}",
                    self.file_name
                );
                sender
                    .send(StreamEvent::ToolCallStart {
                        name: "read_file".to_string(),
                        id: id.clone(),
                    })
                    .await
                    .ok();
                sender
                    .send(StreamEvent::ToolCallDelta {
                        id: id.clone(),
                        args_delta: args,
                    })
                    .await
                    .ok();
                sender.send(StreamEvent::ToolCallEnd { id }).await.ok();
                sender
                    .send(StreamEvent::Done {
                        usage: crate::llm::Usage::default(),
                        stop_reason: crate::llm::StopReason::ToolUse,
                    })
                    .await
                    .ok();
            } else {
                sender
                    .send(StreamEvent::TextDelta("grind complete".to_string()))
                    .await
                    .ok();
                sender
                    .send(StreamEvent::Done {
                        usage: crate::llm::Usage::default(),
                        stop_reason: crate::llm::StopReason::Stop,
                    })
                    .await
                    .ok();
            }
            Ok(crate::llm::Usage::default())
        }

        async fn list_models(
            &self,
        ) -> Result<Vec<crate::providers::ModelInfo>, crate::llm::LlmError> {
            Ok(Vec::new())
        }
    }

    fn grind_test_setup(
        tool_rounds: u32,
        max_iterations: Option<u32>,
    ) -> (
        std::path::PathBuf,
        std::sync::mpsc::Receiver<AgentTaskEvent>,
        Arc<ToolGrinderProvider>,
        AgentRunConfig,
    ) {
        use crate::cancellation::AbortController;
        use crate::permissions::{shared_permission_engine, ApprovalBroker};
        use crate::types::AgentMode;

        let dir = std::env::temp_dir().join(format!("agente-grind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let body: String = (1..=40)
            .map(|i| format!("grind target line {i}\n"))
            .collect();
        std::fs::write(dir.join("notes.txt"), body).unwrap();

        let mut model = reasoning_model();
        model.id = "stub-model".to_string();
        model.api_id = "stub-model".to_string();
        model.name = "Stub Model".to_string();
        model.provider_id = "test-grind".to_string();
        model.limits.context = 1_000_000;
        let registry = Arc::new(ProviderRegistry::new());
        let provider = Arc::new(ToolGrinderProvider {
            info: crate::providers::ProviderInfo {
                id: "test-grind".to_string(),
                name: "Test Grind".to_string(),
                models: vec![model],
                ..Default::default()
            },
            calls: std::sync::Mutex::new(0),
            tool_rounds,
            file_name: "notes.txt".to_string(),
        });
        registry.register("test-grind", provider.clone());

        let (tx, rx) = std::sync::mpsc::channel();
        let config = AgentRunConfig {
            session_id: uuid::Uuid::new_v4(),
            task_id: 1,
            sender: tx,
            messages: vec![Message {
                role: Role::User,
                content: "grind".to_string(),
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: Vec::new(),
            }],
            provider_id: "test-grind".to_string(),
            model: "stub-model".to_string(),
            thinking_level: "off".to_string(),
            project_dir: dir.to_string_lossy().to_string(),
            max_iterations,
            registry,
            catalog: None,
            permission_engine: shared_permission_engine(AgentMode::Build),
            cancel_signal: AbortController::new().signal(),
            approval_broker: ApprovalBroker::new(),
            mcp_manager: None,
            subagent_host: None,
            custom_agents: Vec::new(),
            tool_policy: None,
            is_subagent: true,
            depth: 1,
            loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
            loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
            smart_compaction: false,
            user_inbox: None,
            extra_tools: Vec::new(),
            only_tools: None,
            shell_env: Default::default(),
        };
        (dir, rx, provider, config)
    }

    /// Unbounded (`None`) runs sail past the old 25-iteration child cap: 30
    /// demanded tool rounds all execute and the turn ends Done, not paused.
    #[tokio::test]
    async fn unbounded_loop_runs_past_the_old_child_cap() {
        let (dir, rx, provider, config) = grind_test_setup(30, None);
        run_agent_loop(config)
            .await
            .expect("unbounded turn completes");
        assert_eq!(
            *provider.calls.lock().unwrap(),
            31,
            "all 30 tool rounds plus the final answer"
        );
        let events: Vec<AgentTaskEvent> = rx.try_iter().collect();
        assert!(
            !events.iter().any(|e| matches!(
                &e.event,
                AgentEvent::AssistantText(text) if text.contains("iteration limit")
            )),
            "unbounded run must never hit the pause notice"
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(&e.event, AgentEvent::Done { .. })),
            "turn ends Done"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An explicit cap still stops the loop with the pause notice, so
    /// per-spawn `max_iterations` overrides keep working.
    #[tokio::test]
    async fn explicit_cap_still_stops_the_loop() {
        let (dir, rx, provider, config) = grind_test_setup(1_000, Some(3));
        run_agent_loop(config).await.expect("capped turn ends");
        assert_eq!(
            *provider.calls.lock().unwrap(),
            3,
            "loop stops after exactly the capped budget"
        );
        let events: Vec<AgentTaskEvent> = rx.try_iter().collect();
        assert!(
            events.iter().any(|e| matches!(
                &e.event,
                AgentEvent::AssistantText(text) if text.contains("iteration limit (3)")
            )),
            "capped run must emit the pause notice"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
