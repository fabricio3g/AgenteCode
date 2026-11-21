//! Per-turn setup and per-iteration request preparation: tool registry
//! assembly, model/thinking resolution, auto-compaction, budget accounting,
//! and request-only reminder injection.

use std::collections::HashSet;
use std::sync::Arc;

use crate::agent::channel::config::send_event;
use crate::agent::events::AgentEvent;
use crate::cancellation::AbortSignal;
use crate::catalog::{ModelCatalog, ModelCost};
use crate::context::{CompactionStrategy, ContextBudget, ContextCompactor};
use crate::providers::{ApiFormat, ModelInfo, Provider, ProviderRegistry, ProviderSummarizer};
use crate::subagent::{AgentDefinition, SubagentHost, ToolPolicy};
use crate::thinking::apply_thinking_level;
use crate::tools::{ShellEnv, Tool, ToolRegistry};
use crate::types::{AgentMode, Message, Role, ToolDefinition};

use super::todo_review::inject_todo_review;
use super::TurnState;

const COMPACTION_HEARTBEAT_MS: u64 = 15_000;

/// Inputs for building the per-turn [`ToolRegistry`].
pub(super) struct ToolRegistryParams<'a> {
    pub session_id: uuid::Uuid,
    pub project_dir: &'a str,
    pub custom_agents: &'a [AgentDefinition],
    pub only_tools: Option<&'a [String]>,
    pub subagent_host: Option<&'a SubagentHost>,
    pub mcp_manager: Option<&'a Arc<crate::mcp::client::McpManager>>,
    pub extra_tools: Vec<Box<dyn Tool>>,
    pub tool_policy: Option<&'a ToolPolicy>,
    pub is_subagent: bool,
    pub shell_env: ShellEnv,
}

pub(super) async fn build_tool_registry(params: ToolRegistryParams<'_>) -> Arc<ToolRegistry> {
    let mut tool_registry = ToolRegistry::with_agents(params.project_dir, params.custom_agents);

    if let Some(only) = params.only_tools {
        tool_registry.retain_named(&only.iter().map(String::as_str).collect::<Vec<_>>());
    }
    if let Some(host) = params.subagent_host {
        tool_registry.offer_subagent_models(params.custom_agents, &host.model_menu());
    }
    let mcp_allowed = params
        .only_tools
        .is_none_or(|only| only.iter().any(|name| name == "mcp"));

    if let Some(manager) = params.mcp_manager.filter(|_| mcp_allowed) {
        manager.refresh_stale_tools().await;
        let mut adapters = crate::mcp::McpToolAdapter::all_for_session(
            manager,
            params
                .subagent_host
                .and_then(SubagentHost::mcp_session_id)
                .unwrap_or(params.session_id),
        );
        if params.is_subagent {
            adapters.retain(|tool| !tool.name().starts_with("desktop_computer_"));
        }
        tool_registry.register_mcp_adapters(adapters);
    }
    let has_client_tools = !params.extra_tools.is_empty();
    for tool in params.extra_tools {
        tool_registry.register(tool);
    }
    if !params.is_subagent
        && (params.only_tools.is_none() || has_client_tools)
        && crate::goal::GoalStore::user()
            .get(params.session_id)
            .ok()
            .flatten()
            .is_some_and(|goal| goal.status == crate::goal::GoalStatus::Active)
    {
        tool_registry.register(Box::new(crate::tools::TypedTool::new(
            crate::goal::GoalCompleteTool {
                session_id: params.session_id,
            },
        )));
    }

    if !params.is_subagent
        && params.subagent_host.is_some()
        && params.only_tools.is_none()
        && crate::swarm::BoardStore::user().enabled(params.session_id)
    {
        let menu = params
            .subagent_host
            .map(SubagentHost::model_menu)
            .unwrap_or_default();
        tool_registry.register(Box::new(crate::swarm::BoardTool::with_models(&menu)));
    }

    if let Some(policy) = params.tool_policy {
        let keep: Vec<String> = policy
            .filter_definitions(tool_registry.definitions())
            .into_iter()
            .map(|d| d.name)
            .collect();
        tool_registry.retain_named(&keep.iter().map(|s| s.as_str()).collect::<Vec<_>>());
        tool_registry.set_tool_policy(policy.clone());
    }

    tool_registry.set_shell_env(params.shell_env);
    Arc::new(tool_registry)
}

/// Resolved model metadata and tool list for one completion iteration.
pub(super) struct IterationModel {
    pub model_info: ModelInfo,
    pub api_format: ApiFormat,
    pub price: ModelCost,
    pub tool_defs: Vec<ToolDefinition>,
    pub tool_tokens: usize,
    pub window: usize,
    pub output_tokens: usize,
    pub accepted_media: Vec<agente_protocol::AttachmentKind>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn resolve_iteration_model(
    provider: &dyn Provider,
    registry: &ProviderRegistry,
    catalog: Option<&ModelCatalog>,
    provider_id: &str,
    model: &str,
    thinking_level: &str,
    tool_registry: &ToolRegistry,
    mode: AgentMode,
    blocked_computer_tools: &HashSet<String>,
) -> IterationModel {
    let mut model_info =
        crate::providers::resolve_model_info(registry, catalog, provider_id, model);
    if let Some(known) = provider.get_model(model) {
        model_info.id = known.id.clone();
        model_info.api_id = known.api_id.clone();
        if model_info.name.is_empty() || model_info.name == model_info.id {
            model_info.name = known.name.clone();
        }
    }
    let api_format = provider.request_api_format(&model_info);
    model_info.options = provider.get_request_options(&model_info);
    apply_thinking_level(&mut model_info, api_format, thinking_level);
    let price = model_info.cost.clone();

    let mut tool_defs = if provider.info().capabilities.tools && model_info.capabilities.toolcall {
        tool_registry.definitions_for_mode(mode)
    } else {
        Vec::new()
    };
    tool_defs.retain(|tool| !blocked_computer_tools.contains(&tool.name));
    let tool_tokens = crate::context::estimate_tool_definition_tokens(&tool_defs);
    let window = model_info.limits.context as usize;
    let output_tokens = model_info.limits.output as usize;
    let accepted_media = [
        agente_protocol::AttachmentKind::Image,
        agente_protocol::AttachmentKind::Audio,
        agente_protocol::AttachmentKind::Video,
        agente_protocol::AttachmentKind::Pdf,
    ]
    .into_iter()
    .filter(|kind| crate::media::model_accepts(&model_info, *kind))
    .collect();

    IterationModel {
        model_info,
        api_format,
        price,
        tool_defs,
        tool_tokens,
        window,
        output_tokens,
        accepted_media,
    }
}

/// Auto-compact the transcript when the pre-request budget crosses the gate.
/// Returns `true` if cancelled while compacting (caller should return `Ok(())`).
#[allow(clippy::too_many_arguments)]
pub(super) async fn maybe_compact(
    state: &mut TurnState,
    iteration: u32,
    budget: &ContextBudget,
    strategy: &CompactionStrategy,
    smart_compaction: bool,
    compaction_model: Option<&crate::config::SubagentModel>,
    model: &str,
    model_info: &ModelInfo,
    provider: &Arc<dyn Provider>,
    registry: &ProviderRegistry,
    catalog: Option<&ModelCatalog>,
    session_id: uuid::Uuid,
    cancel_signal: &AbortSignal,
    todo_review_at: &mut Option<usize>,
) -> bool {
    if !budget.should_compact() {
        return false;
    }

    let estimated_tokens = state.running_tokens;
    tracing::info!(
        iteration,
        estimated_tokens,
        room = budget.room(),
        tool_tokens = budget.tool_tokens,
        gap = state.tokenizer_gap,
        used_ratio = budget.ratio(),
        "Compacting agent context"
    );

    let smart = smart_compaction;
    let summary_model_name = smart.then(|| {
        compaction_model
            .map(|chosen| chosen.model.clone())
            .unwrap_or_else(|| model.to_string())
    });
    send_event(
        &state.sender,
        state.task_id,
        AgentEvent::CompactionStarted {
            smart,
            model: summary_model_name,
        },
    );

    let summary_target = if let Some(chosen) = compaction_model {
        registry.get(&chosen.provider).map(|summary_provider| {
            let mut summary_model = crate::providers::resolve_model_info(
                registry,
                catalog,
                &chosen.provider,
                &chosen.model,
            );
            summary_model.options = summary_provider.get_request_options(&summary_model);
            if let Some(level) = &chosen.thinking {
                let summary_format = summary_provider.request_api_format(&summary_model);
                apply_thinking_level(&mut summary_model, summary_format, level);
            }
            (summary_provider, summary_model)
        })
    } else {
        Some((Arc::clone(provider), model_info.clone()))
    };
    let summary_price = summary_target
        .as_ref()
        .map(|(_, model)| model.cost.clone())
        .unwrap_or_default();
    let summarizer = smart
        .then_some(summary_target)
        .flatten()
        .map(|(provider, model)| {
            Arc::new(ProviderSummarizer::new(
                provider,
                model,
                crate::providers::RequestContext::new(session_id),
            ))
        });
    let compactor = ContextCompactor::new(strategy.clone());
    let compactor = if let Some(summarizer) = &summarizer {
        compactor.with_summarizer(summarizer.clone())
    } else {
        compactor
    };

    let heartbeat_sender = state.sender.clone();
    let task_id = state.task_id;
    let mut heartbeat_tick =
        tokio::time::interval(std::time::Duration::from_millis(COMPACTION_HEARTBEAT_MS));
    heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat_tick.tick().await;
    let compact_messages = state.messages.clone();
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
                return true;
            }
        }
    };

    let compacted = match result {
        Ok(r) => Some(r),
        Err(e) => {
            tracing::warn!(error = %e, "compaction task failed; continuing un-compacted");
            None
        }
    };

    if let Some(usage) = summarizer
        .as_ref()
        .and_then(|summarizer| summarizer.usage())
    {
        state.record_extra_call_usage(&usage, &summary_price);
    }

    if let Some(mut result) = compacted {
        if result.summary.tokens_saved == 0 {
            let forced =
                ContextCompactor::new(strategy.clone()).compact_forced(result.messages.clone());
            if forced.summary.tokens_saved > 0 {
                result = forced;
            }
        }
        if result.summary.tokens_saved == 0 {
            tracing::warn!(
                iteration,
                used = state.running_tokens,
                room = budget.room(),
                "Compaction saved nothing; leaving the transcript as it is"
            );
        } else {
            let smart = matches!(
                result.summary.metadata.summary_type,
                crate::context::SummaryType::Semantic
            );
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
                &state.sender,
                state.task_id,
                AgentEvent::ContextCompacted {
                    summary,
                    tokens_before: estimated_tokens as u32,
                    tokens_after: tokens_after as u32,
                    smart,
                    compacted_conversation: result.messages.clone(),
                },
            );
            state.replace_messages_after_compaction(result.messages, tokens_after);
            *todo_review_at = None;
        }
    }
    false
}

/// Build the request-only message slice: prune stale tool media, emit
/// `ContextBudget`, and append session goal, budget notice, and todo review
/// reminders without mutating the saved transcript.
pub(super) fn prepare_request_messages(
    state: &mut TurnState,
    window: usize,
    tool_tokens: usize,
    output_tokens: usize,
    session_id: uuid::Uuid,
    todo_review_at: Option<usize>,
) -> (Vec<Message>, usize) {
    let mut request_messages = state.messages.clone();
    let pruned_tokens = crate::media::prune_stale_tool_media(&mut request_messages);
    let used = state.running_tokens.saturating_sub(pruned_tokens);

    let budget = ContextBudget::new(
        window,
        tool_tokens,
        state.tokenizer_gap,
        used,
        output_tokens,
    );
    let mut system_tokens = 0usize;
    let mut message_tokens = 0usize;
    let mut tool_result_tokens = 0usize;
    for message in &request_messages {
        let cost = crate::context::budget::estimated_message_cost(message);
        match message.role {
            Role::System => system_tokens += cost,
            Role::Tool => tool_result_tokens += cost,
            _ => message_tokens += cost,
        }
    }
    send_event(
        &state.sender,
        state.task_id,
        AgentEvent::ContextBudget {
            used: budget.used as u32,
            room: budget.room() as u32,
            window: budget.window as u32,
            tool_tokens: budget.tool_tokens as u32,
            gap: budget.gap as u32,
            system_tokens: system_tokens as u32,
            message_tokens: message_tokens as u32,
            tool_result_tokens: tool_result_tokens as u32,
            reserve: budget.reserve as u32,
            measured: state.tokens_measured,
        },
    );

    let mut reminder_tokens = 0usize;
    if !state.is_subagent {
        match crate::goal::GoalStore::user().get(session_id) {
            Ok(Some(goal)) => {
                if let Some(text) = goal.reminder() {
                    let note = Message::user(text);
                    reminder_tokens += crate::context::budget::estimated_message_cost(&note);
                    request_messages.push(note);
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "Could not read session goal"),
        }
    }
    if let Some(note) = budget.notice_message(state.compacted_recently) {
        reminder_tokens += crate::context::budget::estimated_message_cost(&note);
        request_messages.push(note);
        state.compacted_recently = false;
    }
    if let Some(index) = todo_review_at {
        reminder_tokens += inject_todo_review(&mut request_messages, index);
    }
    let request_estimate = used + tool_tokens + reminder_tokens;
    (request_messages, request_estimate)
}
