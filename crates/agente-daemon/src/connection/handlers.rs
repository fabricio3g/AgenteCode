//! JSON-RPC method handlers and shared request parameter structs for [`Connection`].

use std::collections::HashMap;
use std::sync::Arc;

use agente_protocol::rpc;
use agente_protocol::{
    ApprovalDecision, Attachment, Message, RunId, SessionId, StartTurn, Trust, TurnId,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    initialize_result, parse, runtime_failure, to_json, Connection, Failure, OwnTurnGuard, BUSY,
};

#[derive(Deserialize)]
struct ProviderParams {
    provider: String,
}

#[derive(Deserialize)]
struct ProviderModelParams {
    provider: String,
    model: String,
}

#[derive(Deserialize)]
struct ProviderIdParams {
    id: String,
}

#[derive(Deserialize)]
struct ConnectProviderParams {
    id: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
}

#[derive(Deserialize)]
struct TemplateParams {
    template: String,
}

#[derive(Deserialize)]
struct ThinkingRequestParams {
    provider: String,
    model: String,
    level: String,
}

#[derive(Deserialize)]
struct PreviewParams {
    path: String,
}

#[derive(Deserialize)]
struct CancelChildParams {
    run_id: RunId,
}

#[derive(Deserialize)]
struct SessionParams {
    session_id: SessionId,
}

#[derive(Deserialize)]
struct CompactParams {
    session_id: SessionId,
    #[serde(default = "default_smart_compaction")]
    smart: bool,
}

fn default_smart_compaction() -> bool {
    true
}

#[derive(Deserialize)]
struct OpenSessionParams {
    session_id: SessionId,
    project_dir: String,
}

#[derive(Deserialize)]
struct ForkParams {
    session_id: SessionId,
    #[serde(default)]
    conversation_index: Option<usize>,
}

#[derive(Deserialize)]
struct GoalParams {
    session_id: SessionId,
    goal: agente_core::goal::Goal,
}

#[derive(Deserialize)]
struct BoardEnableParams {
    session_id: SessionId,
    enabled: bool,
}

#[derive(Deserialize)]
struct ComplementsSyncParams {
    servers: HashMap<String, crate::complements::ComplementConfig>,
    retry: Option<String>,
}

#[derive(Deserialize)]
struct TurnParams {
    turn_id: TurnId,
}

#[derive(Deserialize)]
struct UpdateTurnParams {
    turn_id: TurnId,
    thinking_level: Option<String>,
    mode: Option<agente_protocol::TurnMode>,
}

#[derive(Deserialize)]
struct SteerParams {
    turn_id: TurnId,
    content: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
}

#[derive(Deserialize)]
struct ExecParams {
    session_id: SessionId,
    tool: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Deserialize)]
struct RewindParams {
    session_id: SessionId,
    conversation_index: usize,
}

#[derive(Deserialize, Default)]
struct SubscribeParams {
    /// Only these sessions; all sessions when absent.
    #[serde(default)]
    session_ids: Option<Vec<SessionId>>,
}

#[derive(Deserialize)]
struct ProjectParams {
    project_dir: String,
}

#[derive(Deserialize)]
struct McpControlParams {
    project_dir: String,
    name: String,
    action: String,
}

#[derive(Deserialize)]
struct ProcessParams {
    project_dir: String,
    id: String,
    #[serde(default)]
    tail_chars: Option<usize>,
}

#[derive(Deserialize)]
struct StartProcessParams {
    project_dir: String,
    command: String,
}

#[derive(Deserialize)]
struct LlmCompleteParams {
    provider: String,
    model: String,
    messages: Vec<Message>,
    #[serde(default)]
    max_tokens: Option<usize>,
    #[serde(default)]
    session_id: Option<SessionId>,
}

#[derive(Deserialize)]
struct GenerateTitleParams {
    provider: String,
    model: String,
    user_text: String,
    assistant_text: String,
    #[serde(default)]
    session_id: Option<SessionId>,
}

#[derive(Deserialize)]
struct ClientStateParams {
    session_id: SessionId,
    client: String,
    state: Value,
    #[serde(default)]
    title: Option<String>,
}

/// A background process as clients list it.
fn process_json(process: &agente_core::tools::processes::BackgroundProcess) -> Value {
    use agente_core::tools::processes::ProcessStatus;
    let (status, exit_code) = match process.status() {
        ProcessStatus::Running => ("running", None),
        ProcessStatus::Exited(code) => ("exited", code),
        ProcessStatus::Stopped => ("stopped", None),
    };
    json!({
        "id": process.id,
        "command": process.command,
        "project_dir": process.project_dir,
        "started_at": process.started_at,
        "status": status,
        "exit_code": exit_code,
        "urls": process.urls(),
    })
}

fn find_process(
    params: &ProcessParams,
) -> Result<Arc<agente_core::tools::processes::BackgroundProcess>, Failure> {
    agente_core::tools::processes::find(&params.project_dir, &params.id).ok_or_else(|| {
        (
            rpc::INVALID_PARAMS,
            format!("no background process {}", params.id),
        )
    })
}

impl Connection {
    pub(super) async fn start_turn_async(
        self: &Arc<Self>,
        params: Value,
    ) -> Result<Value, Failure> {
        if params.pointer("/home/complements").and_then(Value::as_bool) == Some(true) {
            let wait = async {
                while self.lock_complements().waiting_for_first_connection() {
                    tokio::time::sleep(std::time::Duration::from_millis(75)).await;
                }
            };
            let _ = tokio::time::timeout(std::time::Duration::from_secs(4), wait).await;
            let managers = self.lock_complements().managers();
            let refresh = async {
                for manager in managers {
                    manager.refresh_stale_tools().await;
                }
            };
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), refresh).await;
        }
        let turn_connection = Arc::clone(self);
        tokio::task::spawn_blocking(move || turn_connection.handle("turn.start", params))
            .await
            .unwrap_or_else(|error| Err((rpc::INTERNAL_ERROR, error.to_string())))
    }

    pub(super) async fn control_mcp(&self, params: Value) -> Result<Value, Failure> {
        let McpControlParams {
            project_dir,
            name,
            action,
        } = parse(params)?;
        self.runtime
            .control_mcp(&project_dir, &name, &action)
            .await
            .map(|()| json!({ "ok": true }))
            .map_err(runtime_failure)
    }

    pub(super) async fn compact_session(&self, params: Value) -> Result<Value, Failure> {
        let CompactParams {
            session_id,
            smart: requested_smart,
        } = parse(params)?;
        let before = self.runtime.session_snapshot(session_id);
        let tokens_before = agente_core::context::estimate_message_tokens(&before.conversation);
        let (snapshot, smart, usage) = if requested_smart {
            self.runtime
                .compact_smart(session_id)
                .await
                .map_err(runtime_failure)?
        } else {
            (
                self.runtime.compact(session_id).map_err(runtime_failure)?,
                false,
                None,
            )
        };
        let tokens_after = agente_core::context::estimate_message_tokens(&snapshot.conversation);
        // Return the persisted checkpoint with the RPC response: notification
        // delivery and the response may race on separate connection tasks.
        let summary = if smart && tokens_after < tokens_before {
            snapshot.conversation.iter().find_map(|message| {
                (message.role == agente_protocol::Role::Assistant)
                    .then(|| message.content.strip_prefix("[Conversation summary]\n"))
                    .flatten()
                    .map(str::to_owned)
            })
        } else {
            None
        };
        let mut result = to_json(snapshot)?;
        result["compaction"] = json!({
            "tokens_before": tokens_before,
            "tokens_after": tokens_after,
            "summary": summary,
            "estimated": true,
            "smart": smart,
            "requested_smart": requested_smart,
            "model_tokens": if requested_smart {
                usage.as_ref().map(|u| {
                    u.total_tokens.max(
                        u.prompt_tokens
                            .saturating_add(u.cache_read_tokens)
                            .saturating_add(u.cache_creation_tokens)
                            .saturating_add(u.completion_tokens),
                    )
                })
            } else {
                Some(0)
            },
            "input_tokens": usage.as_ref().map(|u| {
                u.prompt_tokens
                    .saturating_add(u.cache_read_tokens)
                    .saturating_add(u.cache_creation_tokens)
            }),
            "cache_read_tokens": usage.as_ref().map(|u| u.cache_read_tokens),
            "cache_creation_tokens": usage.as_ref().map(|u| u.cache_creation_tokens),
            "output_tokens": usage.as_ref().map(|u| u.completion_tokens),
        });
        Ok(result)
    }

    /// `models.discover {provider}` → the provider's live list, enriched,
    /// each model with its thinking profile.
    pub(super) async fn discover_models(&self, params: Value) -> Result<Value, Failure> {
        let ProviderParams { provider } = parse(params)?;
        let models = self
            .runtime
            .discover_models(&provider)
            .await
            .map_err(runtime_failure)?;
        Ok(json!({
            "provider": provider,
            "models": models.iter().map(agente_core::models::model_json).collect::<Vec<_>>(),
        }))
    }

    pub(super) async fn refresh_catalog(&self) -> Result<Value, Failure> {
        let count = self
            .runtime
            .refresh_catalog()
            .await
            .map_err(runtime_failure)?;
        Ok(json!({ "ok": true, "model_count": count }))
    }

    pub(super) async fn test_provider(&self, params: Value) -> Result<Value, Failure> {
        let ProviderParams { provider } = parse(params)?;
        self.runtime
            .test_provider(&provider)
            .await
            .map_err(runtime_failure)
    }

    pub(super) async fn llm_complete(&self, params: Value) -> Result<Value, Failure> {
        let LlmCompleteParams {
            provider,
            model,
            messages,
            max_tokens,
            session_id,
        } = parse(params)?;
        let text = self
            .runtime
            .complete_text(&provider, &model, messages, max_tokens, session_id)
            .await
            .map_err(runtime_failure)?;
        Ok(json!({ "text": text }))
    }

    pub(super) async fn generate_title(&self, params: Value) -> Result<Value, Failure> {
        let GenerateTitleParams {
            provider,
            model,
            user_text,
            assistant_text,
            session_id,
        } = parse(params)?;
        let title = self
            .runtime
            .generate_title(&provider, &model, &user_text, &assistant_text, session_id)
            .await
            .map_err(runtime_failure)?;
        Ok(json!({ "title": title }))
    }

    pub(super) async fn start_process(&self, params: Value) -> Result<Value, Failure> {
        let StartProcessParams {
            project_dir,
            command,
        } = parse(params)?;
        if command.trim().is_empty() {
            return Err((rpc::INVALID_PARAMS, "command cannot be empty".into()));
        }
        let process = agente_core::tools::processes::start(
            &command,
            &project_dir,
            &agente_core::tools::ShellEnv::Inherit,
        )
        .await
        .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
        Ok(process_json(&process))
    }

    pub(super) fn handle(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, Failure> {
        let runtime = &self.runtime;
        match method {
            "initialize" => Ok(initialize_result()),
            "runtime.settings" => Ok(runtime.settings()),
            "models.info" => {
                let ProviderModelParams { provider, model } = parse(params)?;
                let info = runtime.model_info(&provider, &model);
                Ok(json!({
                    "id": info.id,
                    "name": info.name,
                    "provider_id": info.provider_id,
                    "capabilities": info.capabilities,
                    "cost": info.cost,
                    "limits": info.limits,
                    "reasoning_options": info.reasoning_options,
                    "reasoning_stream_field": info.reasoning_stream_field,
                    "transport": agente_core::models::transport_json(&info),
                }))
            }
            "providers.list" => Ok(json!({
                "providers": agente_core::providers::spec::all(),
            })),
            "providers.status" => Ok(runtime.provider_status()),
            "providers.connect" => {
                let ConnectProviderParams {
                    id,
                    api_key,
                    base_url,
                } = parse(params)?;
                runtime
                    .connect_provider(&id, api_key, base_url)
                    .map_err(runtime_failure)?;
                Ok(runtime.provider_status())
            }
            "providers.disconnect" => {
                let ProviderIdParams { id } = parse(params)?;
                runtime.disconnect_provider(&id).map_err(runtime_failure)?;
                Ok(runtime.provider_status())
            }
            "providers.set_default" => {
                let ProviderModelParams { provider, model } = parse(params)?;
                runtime
                    .set_default_model(&provider, &model)
                    .map_err(runtime_failure)?;
                Ok(runtime.provider_status())
            }
            // Desktop's Settings → Search, handed to the core's `web_search`
            // (`web.json` + the keys in `auth.json`), so the Code space and
            // the TUI search where Desktop does.
            "web.sync" => {
                let sync: agente_core::tools::web::settings::WebSync = parse(params)?;
                let provider = sync.apply().map_err(|error| {
                    (
                        rpc::INTERNAL_ERROR,
                        format!("Could not save web search settings: {error}"),
                    )
                })?;
                Ok(json!({ "provider": provider.id() }))
            }
            "models.catalog" => {
                let ProviderParams { provider } = parse(params)?;
                let models: Vec<Value> = runtime
                    .catalog_models(&provider)
                    .into_iter()
                    .map(|(id, name, status)| json!({ "id": id, "name": name, "status": status }))
                    .collect();
                Ok(json!({ "provider": provider, "models": models }))
            }
            "models.thinking" => {
                let ProviderModelParams { provider, model } = parse(params)?;
                to_json(runtime.thinking_profile(&provider, &model))
            }
            "thinking.template" => {
                let TemplateParams { template } = parse(params)?;
                to_json(agente_core::providers::llamacpp::template_profile(
                    &template,
                ))
            }
            "thinking.request" => {
                let ThinkingRequestParams {
                    provider,
                    model,
                    level,
                } = parse(params)?;
                if let Some(error) = runtime.model_info(&provider, &model).api.route_error {
                    return Err((rpc::INVALID_PARAMS, error));
                }
                Ok(json!({ "body": runtime.thinking_request(&provider, &model, &level) }))
            }
            "media.import" => crate::project::import_media(params),
            "media.preview_path" => {
                let PreviewParams { path } = parse(params)?;
                let path = agente_core::media::stored_image_path(&path)
                    .map_err(|error| (rpc::INVALID_PARAMS, error.to_string()))?;
                Ok(json!({ "path": path }))
            }
            "children.list" => Ok(Value::Array(runtime.list_children())),
            "children.cancel" => {
                let CancelChildParams { run_id } = parse(params)?;
                Ok(json!({ "ok": runtime.cancel_child(run_id) }))
            }
            "session.list" => to_json(runtime.session_infos()),
            "goal.get" => {
                let SessionParams { session_id } = parse(params)?;
                let goal = agente_core::goal::GoalStore::user()
                    .get(session_id.as_uuid())
                    .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
                to_json(goal)
            }
            "goal.set" => {
                let GoalParams { session_id, goal } = parse(params)?;
                if goal.objective.trim().is_empty() || goal.objective.len() > 16_384 {
                    return Err((
                        rpc::INVALID_PARAMS,
                        "Goal must contain 1–16384 bytes".into(),
                    ));
                }
                agente_core::goal::GoalStore::user()
                    .put(session_id.as_uuid(), &goal)
                    .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
                to_json(goal)
            }
            "board.get" => {
                let SessionParams { session_id } = parse(params)?;
                let board = agente_core::swarm::BoardStore::user()
                    .get(session_id.as_uuid())
                    .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
                to_json(board)
            }
            "board.enable" => {
                let BoardEnableParams {
                    session_id,
                    enabled,
                } = parse(params)?;
                let board = agente_core::swarm::BoardStore::user()
                    .set_enabled(session_id.as_uuid(), enabled)
                    .map_err(|error| (rpc::INTERNAL_ERROR, error))?;
                to_json(board)
            }
            "board.clear" => {
                let SessionParams { session_id } = parse(params)?;
                let board = agente_core::swarm::BoardStore::user()
                    .clear(session_id.as_uuid())
                    .map_err(|error| (rpc::INTERNAL_ERROR, error))?;
                to_json(board)
            }
            "goal.clear" => {
                let SessionParams { session_id } = parse(params)?;
                agente_core::goal::GoalStore::user()
                    .clear(session_id.as_uuid())
                    .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
                Ok(json!({ "ok": true }))
            }
            "session.get" => {
                let SessionParams { session_id } = parse(params)?;
                Ok(json!({
                    "snapshot": to_json(runtime.session_snapshot(session_id))?,
                    "meta": to_json(runtime.session_meta(session_id))?,
                }))
            }
            "session.open" => {
                let OpenSessionParams {
                    session_id,
                    project_dir,
                } = parse(params)?;
                Ok(
                    json!({ "snapshot": runtime.open_session(session_id, &project_dir).map_err(runtime_failure)? }),
                )
            }
            "session.checkpoints" => {
                let SessionParams { session_id } = parse(params)?;
                Ok(runtime.checkpoints(session_id))
            }
            "session.delete" => {
                let SessionParams { session_id } = parse(params)?;
                let deleted = runtime
                    .delete_session(session_id)
                    .map_err(runtime_failure)?;
                self.client_tools.remove_session(session_id);
                Ok(json!({ "deleted": deleted }))
            }
            "session.fork" => {
                let ForkParams {
                    session_id,
                    conversation_index,
                } = parse(params)?;
                if runtime.is_busy(session_id) {
                    return Err((BUSY, "wait for the turn to finish before forking".into()));
                }
                if conversation_index.is_some_and(|index| {
                    index > runtime.session_snapshot(session_id).conversation.len()
                }) {
                    return Err((
                        rpc::INVALID_PARAMS,
                        "conversation index is beyond this session".into(),
                    ));
                }
                let fork = runtime.fork_session(session_id);
                if let Some(goal) = agente_core::goal::GoalStore::user()
                    .get(session_id.as_uuid())
                    .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?
                {
                    agente_core::goal::GoalStore::user()
                        .put(fork.session_id.as_uuid(), &goal)
                        .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
                }
                if agente_core::swarm::BoardStore::user().enabled(session_id.as_uuid()) {
                    agente_core::swarm::BoardStore::user()
                        .set_enabled(fork.session_id.as_uuid(), true)
                        .map_err(|error| (rpc::INTERNAL_ERROR, error))?;
                }
                if let Some(index) = conversation_index {
                    runtime
                        .rewind(fork.session_id, index)
                        .map_err(runtime_failure)?;
                }
                to_json(runtime.session_snapshot(fork.session_id))
            }
            "client_tools.register" => {
                let registration: agente_protocol::RegisterClientTools = parse(params)?;
                if runtime.is_busy(registration.session_id) {
                    return Err((BUSY, "Home session is busy".into()));
                }
                self.client_tools
                    .register(registration.session_id, registration.tools)
                    .map_err(|error| (rpc::INVALID_PARAMS, error))?;
                Ok(json!({"ok": true}))
            }
            "complements.sync" => {
                let ComplementsSyncParams { mut servers, retry } = parse(params)?;
                if servers.len() > 32
                    || servers
                        .keys()
                        .any(|id| id.len() != 12 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
                {
                    return Err((
                        rpc::INVALID_PARAMS,
                        "Invalid complement IDs or too many services".into(),
                    ));
                }
                for config in servers.values_mut() {
                    config.mcp.trust = false;
                }
                let mut complements = self.lock_complements();
                complements.sync(servers, retry.as_deref());
                Ok(complements.status())
            }
            "complements.status" => Ok(self.lock_complements().status()),
            "client_tools.result" => {
                self.client_tools
                    .result(parse(params)?)
                    .map_err(|error| (rpc::INVALID_PARAMS, error))?;
                Ok(json!({"ok": true}))
            }
            "turn.start" => {
                let mut start: StartTurn = parse(params)?;
                // Nothing to answer: a blank prompt would start a whole turn
                // of the model exploring on its own.
                if start.conversation.is_empty()
                    && start.prompt.as_ref().is_none_or(|prompt| {
                        prompt.content.trim().is_empty() && prompt.attachments.is_empty()
                    })
                {
                    return Err((rpc::INVALID_PARAMS, "Empty message".into()));
                }
                let turn_id = TurnId::new();
                let own_guard = OwnTurnGuard::new(self, turn_id);
                let (turn, timeout_task) = if let Some(policy) = &start.home {
                    if policy.max_iterations == 0
                        || policy.max_iterations > 500
                        || policy.max_tool_calls > 1000
                        || policy.max_time_ms == 0
                        || policy.max_time_ms > 3_600_000
                    {
                        return Err((rpc::INVALID_PARAMS, "Invalid Home turn budgets".into()));
                    }
                    let complements = if policy.complements && policy.max_tool_calls > 0 {
                        self.lock_complements().tools()
                    } else {
                        Vec::new()
                    };
                    if !complements.is_empty()
                        && start.mode != Some(agente_protocol::TurnMode::Plan)
                    {
                        start.mode = Some(agente_protocol::TurnMode::Build);
                    }
                    let extra = self
                        .client_tools
                        .tools(
                            start.session_id,
                            turn_id,
                            policy,
                            self.outbox.clone(),
                            complements,
                        )
                        .map_err(|error| (rpc::INVALID_PARAMS, error))?;
                    let timeout = policy.max_time_ms;
                    let turn = runtime
                        .start_turn_with_tools(
                            start,
                            turn_id,
                            Some(agente_core::agent::TurnTools {
                                extra,
                                only: Some(Vec::new()),
                                ..Default::default()
                            }),
                        )
                        .map_err(runtime_failure)?;
                    let runtime = runtime.clone();
                    let timeout_handle = self.spawn_task(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;
                        runtime.cancel(turn_id);
                    });
                    (turn, Some(timeout_handle))
                } else {
                    (
                        runtime
                            .start_turn_with_tools(start, turn_id, None)
                            .map_err(runtime_failure)?,
                        None,
                    )
                };
                let conversation_index = turn.conversation_index;
                let turn_id = self.pump(turn, timeout_task);
                own_guard.disarm();
                Ok(json!({ "turn_id": turn_id, "conversation_index": conversation_index }))
            }
            "turn.exec" => {
                // Whoever can open the socket is the owner: it is created
                // readable by this user only.
                let ExecParams {
                    session_id,
                    tool,
                    arguments,
                } = parse(params)?;
                let turn_id = TurnId::new();
                let own_guard = OwnTurnGuard::new(self, turn_id);
                let turn = runtime
                    .exec_tool_with_id(session_id, turn_id, &tool, arguments, Trust::Owner)
                    .map_err(runtime_failure)?;
                let turn_id = self.pump(turn, None);
                own_guard.disarm();
                Ok(json!({ "turn_id": turn_id }))
            }
            "turn.cancel" => {
                let TurnParams { turn_id } = parse(params)?;
                Ok(json!({ "ok": runtime.cancel(turn_id) }))
            }
            "turn.update" => {
                let args: UpdateTurnParams = parse(params)?;
                Ok(
                    json!({ "ok": runtime.update_turn(args.turn_id, args.thinking_level, args.mode) }),
                )
            }
            "turn.steer" => {
                let SteerParams {
                    turn_id,
                    content,
                    attachments,
                } = parse(params)?;
                let mut message = Message::user(content);
                message.attachments = attachments;
                Ok(json!({ "ok": runtime.steer_message(turn_id, message) }))
            }
            "approval.respond" => {
                let decision: ApprovalDecision = parse(params)?;
                Ok(json!({ "ok": runtime.approve(decision) }))
            }
            "edits.undo" => {
                let SessionParams { session_id } = parse(params)?;
                Ok(json!({ "paths": runtime.undo(session_id).map_err(runtime_failure)? }))
            }
            "edits.redo" => {
                let SessionParams { session_id } = parse(params)?;
                Ok(json!({ "paths": runtime.redo(session_id).map_err(runtime_failure)? }))
            }
            "edits.rewind" => {
                let RewindParams {
                    session_id,
                    conversation_index,
                } = parse(params)?;
                let reverted = runtime
                    .rewind(session_id, conversation_index)
                    .map_err(runtime_failure)?;
                Ok(json!({ "reverted": reverted }))
            }
            "events.subscribe" => {
                let SubscribeParams { session_ids } = if params.is_null() {
                    SubscribeParams::default()
                } else {
                    parse(params)?
                };
                self.subscribe(session_ids.map(|ids| ids.into_iter().collect()));
                Ok(json!({ "ok": true }))
            }
            "client_state.save" => {
                let ClientStateParams {
                    session_id,
                    client,
                    state,
                    title,
                } = parse(params)?;
                runtime
                    .save_client_state(session_id, &client, state, title)
                    .map_err(runtime_failure)?;
                Ok(json!({ "ok": true }))
            }
            "processes.list" => {
                let ProjectParams { project_dir } = parse(params)?;
                let list = agente_core::tools::processes::list(&project_dir);
                Ok(Value::Array(
                    list.iter().map(|process| process_json(process)).collect(),
                ))
            }
            "processes.output" => {
                let params: ProcessParams = parse(params)?;
                let process = find_process(&params)?;
                Ok(json!({ "output": process.output(params.tail_chars.unwrap_or(64 * 1024)) }))
            }
            "processes.stop" => {
                let params: ProcessParams = parse(params)?;
                let process = find_process(&params)?;
                Ok(json!({ "stopped": agente_core::tools::processes::stop(&process) }))
            }
            "processes.prune" => {
                let ProjectParams { project_dir } = parse(params)?;
                let pruned = agente_core::tools::processes::prune(&project_dir);
                Ok(json!({ "pruned": pruned }))
            }
            "project.info" | "project.init" | "project.expand_prompt" | "mcp.status" => {
                crate::project::handle(runtime, method, params)
            }
            _ => Err((rpc::METHOD_NOT_FOUND, format!("unknown method {method}"))),
        }
    }
}
