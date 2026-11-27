//! JSON-RPC method handlers and shared request parameter structs for [`Connection`].

use std::collections::HashMap;
use std::sync::Arc;

use agente_protocol::rpc;
use agente_protocol::{
    ApprovalDecision, Attachment, DriverInstanceConfig, InputResponse, Message, RunId, SessionId,
    StartTurn, Trust, TurnId,
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
    #[serde(default)]
    instance_id: Option<String>,
}

#[derive(Default, Deserialize)]
struct DriversListParams {
    #[serde(default)]
    probe: bool,
}

#[derive(Default, Deserialize)]
struct ProbeDriverParams {
    #[serde(default)]
    instance_id: Option<String>,
}

#[derive(Deserialize)]
struct SaveDriverInstanceParams {
    instance_id: String,
    config: DriverInstanceConfig,
}

#[derive(Deserialize)]
struct DeleteDriverInstanceParams {
    instance_id: String,
}

#[derive(Default, Deserialize)]
struct OrchestratorTasksParams {
    #[serde(default)]
    parent_session_id: Option<SessionId>,
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

/// `board.move`: the user accepts, sends back or gives up a card from the
/// board itself, the same move the lead makes with `board` `move`.
#[derive(Deserialize)]
struct BoardMoveParams {
    session_id: SessionId,
    id: String,
    to: agente_core::swarm::MoveTo,
    #[serde(default)]
    note: Option<String>,
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

#[derive(Deserialize)]
struct RollbackTurnParams {
    session_id: SessionId,
    turn_index: usize,
}

#[derive(Deserialize, Default)]
struct SubscribeParams {
    /// Only these sessions; all sessions when absent.
    #[serde(default)]
    session_ids: Option<Vec<SessionId>>,
    /// Also stream real-time `process.event` notifications on this connection.
    #[serde(default)]
    include_processes: bool,
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
    messages: Vec<Value>,
    #[serde(default)]
    max_tokens: Option<usize>,
    #[serde(default)]
    session_id: Option<SessionId>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
}

#[derive(Deserialize)]
struct LlmStreamParams {
    #[serde(default)]
    stream_id: Option<String>,
    provider: String,
    model: String,
    messages: Vec<Value>,
    #[serde(default)]
    tools: Option<Vec<agente_core::types::ToolDefinition>>,
    #[serde(default)]
    thinking_level: Option<String>,
    #[serde(default)]
    temperature: Option<f64>,
    #[serde(default)]
    top_p: Option<f64>,
    #[serde(default)]
    max_tokens: Option<usize>,
    #[serde(default)]
    session_id: Option<SessionId>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
}

/// Convert JSON chat messages (supporting both native `Message` objects and
/// OpenAI-style multimodal `content` arrays with `text` / `image_url` parts)
/// into core `Message`s while strictly enforcing `deny_media` and inline
/// base64-only media sandboxing.
fn parse_llm_messages(
    runtime: &agente_runtime::RuntimeHandle,
    raw_messages: Vec<Value>,
) -> Result<Vec<Message>, Failure> {
    let mut out = Vec::with_capacity(raw_messages.len());
    for mut raw in raw_messages {
        let mut inline_attachments = Vec::new();
        if let Some(obj) = raw.as_object_mut() {
            if let Some(parts) = obj.get("content").and_then(Value::as_array).cloned() {
                let mut text_parts = Vec::new();
                for part in parts {
                    let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
                    match kind {
                        "text" | "input_text" => {
                            if let Some(t) = part.get("text").and_then(Value::as_str) {
                                text_parts.push(t.to_string());
                            }
                        }
                        "image_url" | "input_image" => {
                            runtime
                                .check_media_kind_allowed(agente_protocol::AttachmentKind::Image)
                                .map_err(runtime_failure)?;
                            let url = part
                                .get("image_url")
                                .and_then(|v| v.as_str().or_else(|| v.get("url").and_then(Value::as_str)))
                                .ok_or_else(|| {
                                    (rpc::INVALID_PARAMS, "image_url part missing url".into())
                                })?;
                            let att = agente_core::media::import_data_url(url, "inline-image")
                                .map_err(|e| (rpc::INVALID_PARAMS, e.to_string()))?;
                            inline_attachments.push(att);
                        }
                        other => {
                            return Err((
                                rpc::INVALID_PARAMS,
                                format!("unsupported content part type: {other}"),
                            ));
                        }
                    }
                }
                obj.insert("content".into(), Value::String(text_parts.join("\n")));
            }
        }
        let mut message: Message = serde_json::from_value(raw)
            .map_err(|e| (rpc::INVALID_PARAMS, format!("invalid message: {e}")))?;
        message.attachments.extend(inline_attachments);
        runtime
            .check_attachments_allowed(&message.attachments)
            .map_err(runtime_failure)?;
        out.push(message);
    }
    Ok(out)
}

#[derive(Deserialize)]
struct LlmCancelParams {
    stream_id: String,
}

#[derive(Deserialize)]
struct WebSearchParams {
    query: String,
    #[serde(default)]
    max_results: Option<usize>,
    #[serde(default)]
    provider: Option<agente_core::tools::web::settings::SearchProvider>,
}

#[derive(Deserialize)]
struct WebFetchParams {
    url: String,
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

    pub(super) async fn list_drivers(&self, params: Value) -> Result<Value, Failure> {
        let DriversListParams { probe } = if params.is_null() {
            DriversListParams::default()
        } else {
            parse(params)?
        };
        let drivers = if probe {
            self.runtime.probe_drivers().await
        } else {
            self.runtime.list_drivers()
        };
        Ok(json!({ "drivers": to_json(drivers)? }))
    }

    pub(super) async fn probe_driver(&self, params: Value) -> Result<Value, Failure> {
        let ProbeDriverParams { instance_id } = if params.is_null() {
            ProbeDriverParams::default()
        } else {
            parse(params)?
        };
        if let Some(instance_id) = instance_id {
            let driver = self
                .runtime
                .probe_driver(&instance_id)
                .await
                .map_err(runtime_failure)?;
            Ok(json!({ "driver": to_json(driver)? }))
        } else {
            let drivers = self.runtime.probe_drivers().await;
            Ok(json!({ "drivers": to_json(drivers)? }))
        }
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
                // User since the checkpoint became a user turn; Assistant in
                // sessions compacted before that.
                matches!(
                    message.role,
                    agente_protocol::Role::User | agente_protocol::Role::Assistant
                )
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

    pub(super) fn start_llm_stream(
        self: &Arc<Self>,
        params: Value,
    ) -> Result<Value, Failure> {
        let LlmStreamParams {
            stream_id,
            provider: provider_id,
            model: model_id,
            messages: raw_messages,
            tools,
            thinking_level,
            temperature,
            top_p,
            max_tokens,
            session_id,
            base_url,
            api_key,
        } = parse(params)?;

        let messages = parse_llm_messages(&self.runtime, raw_messages)?;

        let (provider, model) = self
            .runtime
            .resolve_llm_request(
                &provider_id,
                &model_id,
                thinking_level.as_deref(),
                temperature,
                top_p,
                max_tokens,
                base_url.as_deref(),
                api_key.as_deref(),
            )
            .map_err(runtime_failure)?;

        let stream_id = stream_id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let ctx = agente_core::providers::RequestContext::new(
            session_id
                .unwrap_or_else(SessionId::new)
                .as_uuid(),
        );
        let connection = Arc::clone(self);
        let id_for_task = stream_id.clone();

        let task = tokio::spawn(async move {
            struct StreamCleanup {
                connection: Arc<Connection>,
                stream_id: String,
                producer: tokio::task::AbortHandle,
            }
            impl Drop for StreamCleanup {
                fn drop(&mut self) {
                    self.producer.abort();
                    self.connection.lock_llm_streams().remove(&self.stream_id);
                }
            }

            let (tx, mut rx) = tokio::sync::mpsc::channel(256);
            let producer = tokio::spawn(async move {
                if let Err(error) = provider
                    .stream_completion(&messages, tools.as_deref(), &model, tx.clone(), ctx)
                    .await
                {
                    let _ = tx
                        .send(agente_core::llm::StreamEvent::Error(error.to_string()))
                        .await;
                }
            });
            let _cleanup = StreamCleanup {
                connection: Arc::clone(&connection),
                stream_id: id_for_task.clone(),
                producer: producer.abort_handle(),
            };

            let mut saw_terminal = false;
            while let Some(event) = rx.recv().await {
                use agente_core::llm::{StopReason, StreamEvent};
                let payload = match event {
                    StreamEvent::TextDelta(text) => json!({
                        "stream_id": id_for_task,
                        "type": "content",
                        "text": text,
                    }),
                    StreamEvent::ReasoningDelta(text) => json!({
                        "stream_id": id_for_task,
                        "type": "reasoning",
                        "text": text,
                    }),
                    StreamEvent::ToolCallStart { id, name } => json!({
                        "stream_id": id_for_task,
                        "type": "tool_call_start",
                        "id": id,
                        "name": name,
                    }),
                    StreamEvent::ToolCallDelta { id, args_delta } => json!({
                        "stream_id": id_for_task,
                        "type": "tool_call_delta",
                        "id": id,
                        "args_delta": args_delta,
                    }),
                    StreamEvent::ToolCallEnd { id } => json!({
                        "stream_id": id_for_task,
                        "type": "tool_call_end",
                        "id": id,
                    }),
                    StreamEvent::Done { usage, stop_reason } => {
                        saw_terminal = true;
                        let reason = match stop_reason {
                            StopReason::Stop => "stop",
                            StopReason::ToolUse => "tool_calls",
                            StopReason::Length => "length",
                            StopReason::Safety => "content_filter",
                            StopReason::Unknown => "unknown",
                        };
                        json!({
                            "stream_id": id_for_task,
                            "type": "done",
                            "stop_reason": reason,
                            "usage": {
                                "prompt_tokens": usage.prompt_tokens,
                                "completion_tokens": usage.completion_tokens,
                                "total_tokens": usage.total_tokens,
                                "cache_read_tokens": usage.cache_read_tokens,
                                "cache_creation_tokens": usage.cache_creation_tokens,
                            },
                        })
                    }
                    StreamEvent::Error(message) => {
                        saw_terminal = true;
                        json!({
                            "stream_id": id_for_task,
                            "type": "error",
                            "error": message,
                        })
                    }
                    StreamEvent::TextStart
                    | StreamEvent::TextEnd
                    | StreamEvent::ReasoningStart
                    | StreamEvent::ReasoningEnd
                    | StreamEvent::ThinkingSignature(_)
                    | StreamEvent::Continuation(_) => continue,
                };
                connection
                    .send(rpc::notification("llm.chunk", payload))
                    .await;
                if saw_terminal {
                    break;
                }
            }
            if !saw_terminal {
                connection
                    .send(rpc::notification(
                        "llm.chunk",
                        json!({
                            "stream_id": id_for_task,
                            "type": "done",
                            "stop_reason": "stop",
                        }),
                    ))
                    .await;
            }
        });

        self.lock_llm_streams()
            .insert(stream_id.clone(), task.abort_handle());
        Ok(json!({ "stream_id": stream_id }))
    }

    pub(super) async fn llm_complete(&self, params: Value) -> Result<Value, Failure> {
        let LlmCompleteParams {
            provider,
            model,
            messages: raw_messages,
            max_tokens,
            session_id,
            base_url,
            api_key,
        } = parse(params)?;
        let messages = parse_llm_messages(&self.runtime, raw_messages)?;
        let text = self
            .runtime
            .complete_text(
                &provider,
                &model,
                messages,
                max_tokens,
                session_id,
                base_url.as_deref(),
                api_key.as_deref(),
            )
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

    pub(super) async fn web_search(&self, params: Value) -> Result<Value, Failure> {
        let WebSearchParams {
            query,
            max_results,
            provider,
        } = parse(params)?;
        let (used_provider, hits, notes) =
            agente_core::tools::web::search::search_structured(&query, max_results, provider)
                .await
                .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
        Ok(json!({
            "provider": used_provider,
            "hits": hits,
            "notes": notes,
        }))
    }

    pub(super) async fn web_fetch(&self, params: Value) -> Result<Value, Failure> {
        let WebFetchParams { url } = parse(params)?;
        let page = agente_core::tools::web::fetch_url_structured(&url)
            .await
            .map_err(|error| (rpc::INTERNAL_ERROR, error.to_string()))?;
        to_json(page)
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
            "media.import" => crate::project::import_media(runtime, params),
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
            "board.move" => {
                let BoardMoveParams {
                    session_id,
                    id,
                    to,
                    note,
                } = parse(params)?;
                let store = agente_core::swarm::BoardStore::user();
                let (said, board) = agente_core::swarm::move_with_work(
                    &store,
                    session_id.as_uuid(),
                    &id,
                    to,
                    note.as_deref(),
                )
                .map_err(|error| (rpc::INVALID_PARAMS, error))?;
                Ok(json!({ "message": said, "board": to_json(board)? }))
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
                    instance_id,
                } = parse(params)?;
                Ok(json!({
                    "snapshot": runtime
                        .open_session_with_driver(session_id, &project_dir, instance_id.as_deref())
                        .map_err(runtime_failure)?
                }))
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
                if let Some(orchestrator) = &self.orchestrator {
                    orchestrator.revoke_session(session_id);
                }
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
                // Strictly enforce user's disabled media kinds on all incoming attachments.
                if let Some(prompt) = &start.prompt {
                    runtime
                        .check_attachments_allowed(&prompt.attachments)
                        .map_err(runtime_failure)?;
                }
                for msg in &start.conversation {
                    runtime
                        .check_attachments_allowed(&msg.attachments)
                        .map_err(runtime_failure)?;
                }
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
                runtime
                    .check_attachments_allowed(&attachments)
                    .map_err(runtime_failure)?;
                let mut message = Message::user(content);
                message.attachments = attachments;
                Ok(json!({ "ok": runtime.steer_message(turn_id, message) }))
            }
            "approval.respond" => {
                let decision: ApprovalDecision = parse(params)?;
                Ok(json!({ "ok": runtime.approve(decision) }))
            }
            "input.respond" => {
                let response: InputResponse = parse(params)?;
                Ok(json!({ "ok": runtime.respond_input(response) }))
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
            "edits.rollback_to_turn" => {
                let RollbackTurnParams {
                    session_id,
                    turn_index,
                } = parse(params)?;
                let paths = runtime
                    .rollback_to_turn(session_id, turn_index)
                    .map_err(runtime_failure)?;
                Ok(json!({ "paths": paths }))
            }
            "llm.stream" => self.start_llm_stream(params),
            "llm.cancel" => {
                let LlmCancelParams { stream_id } = parse(params)?;
                let cancelled = self
                    .lock_llm_streams()
                    .remove(&stream_id)
                    .map(|handle| handle.abort())
                    .is_some();
                Ok(json!({ "cancelled": cancelled }))
            }
            "events.subscribe" => {
                let SubscribeParams {
                    session_ids,
                    include_processes,
                } = if params.is_null() {
                    SubscribeParams::default()
                } else {
                    parse(params)?
                };
                self.subscribe(
                    session_ids.map(|ids| ids.into_iter().collect()),
                    include_processes,
                );
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
            "drivers.instances.save" => {
                let SaveDriverInstanceParams {
                    instance_id,
                    config,
                } = parse(params)?;
                let info = runtime
                    .save_driver_instance(instance_id, config)
                    .map_err(runtime_failure)?;
                Ok(json!({ "driver": to_json(info)? }))
            }
            "drivers.instances.delete" => {
                let DeleteDriverInstanceParams { instance_id } = parse(params)?;
                let deleted = runtime
                    .delete_driver_instance(&instance_id)
                    .map_err(runtime_failure)?;
                Ok(json!({ "deleted": deleted }))
            }
            "orchestrator.status" => {
                let Some(orchestrator) = &self.orchestrator else {
                    return Ok(json!({ "enabled": false }));
                };
                let mut status = orchestrator.status_json();
                status["enabled"] = json!(true);
                Ok(status)
            }
            "orchestrator.tasks" => {
                let OrchestratorTasksParams { parent_session_id } = if params.is_null() {
                    OrchestratorTasksParams::default()
                } else {
                    parse(params)?
                };
                let tasks = self
                    .orchestrator
                    .as_ref()
                    .map(|orch| orch.list_tasks_json(parent_session_id))
                    .unwrap_or_else(|| json!([]));
                Ok(json!({ "tasks": tasks }))
            }
            _ => Err((rpc::METHOD_NOT_FOUND, format!("unknown method {method}"))),
        }
    }
}
