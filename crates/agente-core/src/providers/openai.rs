use async_trait::async_trait;
use reqwest::Client;
use std::collections::{BTreeMap, HashMap};
use tokio::sync::mpsc::Sender;

use super::{
    inferred_service_model_capabilities, join_url, ApiFormat, ModelInfo, Provider,
    ProviderCapabilities, ProviderInfo, RequestContext,
};
use crate::catalog::{ModelCost, ModelLimits, ModelStatus};
use crate::llm::{
    drain_pending_tool_calls, LlmError, PendingToolCall, StopReason, StreamEvent, Usage,
};
use crate::types::{Message, ProviderContinuation, Role, ToolDefinition};

/// OpenAI-compatible provider implementation
pub struct OpenAIProvider {
    info: ProviderInfo,
    client: Client,
}

impl OpenAIProvider {
    pub fn new(id: &str, name: &str, base_url: &str, env_keys: Vec<String>) -> Self {
        Self::from_info(ProviderInfo {
            id: id.to_string(),
            name: name.to_string(),
            api_format: ApiFormat::OpenAI,
            capabilities: ProviderCapabilities {
                streaming: true,
                tools: true,
                vision: false,
                reasoning: false,
                temperature: true,
                max_tokens: true,
            },
            base_url: base_url.to_string(),
            env_keys,
            headers: HashMap::new(),
            models: vec![],
            api_key: None,
            transport: Default::default(),
        })
    }

    pub fn from_info(info: ProviderInfo) -> Self {
        Self {
            info,
            client: crate::util::http_client(),
        }
    }

    fn resolve_api_key(&self) -> Option<String> {
        self.info.resolve_api_key()
    }

    fn resolve_base_url(&self) -> String {
        self.info.resolve_base_url()
    }
}

#[async_trait]
impl Provider for OpenAIProvider {
    fn info(&self) -> &ProviderInfo {
        &self.info
    }

    async fn stream_completion(
        &self,
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        model: &ModelInfo,
        sender: Sender<StreamEvent>,
        context: RequestContext,
    ) -> Result<Usage, LlmError> {
        // Transform messages to OpenAI format
        let mut messages_json: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                let mut obj = serde_json::json!({
                    "role": match m.role {
                        Role::System => "system",
                        Role::User => "user",
                        Role::Assistant => "assistant",
                        Role::Tool => "tool",
                    },
                    "content": m.content,
                });

                if m.role == Role::User && !m.attachments.is_empty() {
                    obj["content"] = serde_json::Value::Array(chat_content_parts(m, model));
                }

                if let Some(ref tool_calls) = m.tool_calls {
                    obj["tool_calls"] = serde_json::json!(tool_calls);
                }

                if let Some(ref tool_call_id) = m.tool_call_id {
                    obj["tool_call_id"] = serde_json::json!(tool_call_id);
                }
                if let Some(blocks) = super::replay_blocks(m, &self.info, model, "chat") {
                    obj = blocks[0]["message"].clone();
                }

                obj
            })
            .collect();

        // pi-style compat knobs (mirrors pi packages/ai/src/types.ts):
        // - reasoning_stream_field: which delta field carries interleaved reasoning
        //   (DeepSeek `reasoning_content`, Qwen/Kimi `reasoning`, …)
        let reasoning_field =
            model
                .reasoning_stream_field
                .clone()
                .unwrap_or_else(|| match model.compat {
                    super::super::thinking::ThinkingFormat::OpenRouter
                    | super::super::thinking::ThinkingFormat::Qwen
                    | super::super::thinking::ThinkingFormat::Together => "reasoning".to_string(),
                    _ => "reasoning_content".to_string(),
                });

        // Candidate delta fields for interleaved reasoning, in priority order.
        // Catalog `reasoning_stream_field` wins; family fallbacks cover proxies
        // (OpenRouter `reasoning`, Together `reasoning_text`, Qwen `thinking`, …).
        let reasoning_fields: Vec<String> = {
            let mut fields = Vec::new();
            if !reasoning_field.is_empty() {
                fields.push(reasoning_field.clone());
            }
            for candidate in [
                "reasoning_content",
                "reasoning",
                "reasoning_text",
                "thinking",
            ] {
                if !fields.iter().any(|f| f == candidate) {
                    fields.push(candidate.to_string());
                }
            }
            fields
        };

        // Replay stored reasoning on assistant messages. DeepSeek-style APIs reject
        // multi-turn conversations that omit `reasoning_content` when thinking is
        // enabled (an empty string is accepted); Qwen-style APIs accept `reasoning`.
        if model.capabilities.reasoning {
            for (m, obj) in messages.iter().zip(messages_json.iter_mut()) {
                if m.role != Role::Assistant {
                    continue;
                }
                if obj["reasoning_details"].is_array()
                    || (reasoning_field == "reasoning_details"
                        && model.compat == crate::thinking::ThinkingFormat::OpenRouter)
                {
                    continue;
                }
                if let Some(thinking) = &m.thinking {
                    obj[reasoning_field.as_str()] = serde_json::json!(thinking);
                } else if reasoning_field == "reasoning_content"
                    && !matches!(
                        model.compat,
                        super::super::thinking::ThinkingFormat::OpenRouter
                    )
                {
                    obj["reasoning_content"] = serde_json::json!("");
                }
            }
        }

        let mut body = serde_json::json!({
            "model": model.api_id,
            "messages": messages_json,
            "stream": true,
        });

        // pi parity: o1/o3/o4/gpt-5 reject `max_tokens`; use `max_completion_tokens`.
        // Explicit per-model override wins (agente.json `options.max_tokens_field`).
        let max_tokens_field = model
            .options
            .get("max_tokens_field")
            .and_then(|v| v.as_str())
            .filter(|s| *s == "max_completion_tokens")
            .or_else(|| {
                let id = model.api_id.to_ascii_lowercase();
                if id.starts_with("o1")
                    || id.starts_with("o3")
                    || id.starts_with("o4")
                    || id.starts_with("gpt-5")
                {
                    Some("max_completion_tokens")
                } else {
                    None
                }
            })
            .unwrap_or("max_tokens");
        // Live OpenAI-compatible `/models` entries commonly omit output
        // limits. Zero means unknown and must not become an invalid wire
        // limit; the provider will apply its own default.
        if model.limits.output > 0 {
            body[max_tokens_field] = serde_json::json!(model.limits.output);
        }

        // pi parity: request token usage inside the stream via
        // `stream_options.include_usage` (disable per-model with
        // `options.stream_options = false` or override the object).
        let include_usage = model
            .options
            .get("stream_options")
            .is_none_or(|v| !matches!(v, serde_json::Value::Bool(false)));
        if include_usage {
            body["stream_options"] = serde_json::json!({ "include_usage": true });
        }
        // OpenRouter always reports the real charge (`usage.cost`) in the
        // final chunk — the old `usage: {include: true}` flag is deprecated.
        // A configured session cache key keeps successive turns on one cache.
        if let Some(key) = super::cache::prompt_cache_key(&self.info, model, context.session_id) {
            body["prompt_cache_key"] = serde_json::json!(key);
        }

        // Add options from model config (skip control knobs that are not wire params)
        for (key, value) in super::wire_options(&model.options) {
            if key == "max_tokens_field"
                || key == "include_usage"
                || key == "anthropic_thinking_mode"
            {
                continue;
            }
            // `stream_options: false` disables include_usage; don't forward the boolean.
            if key == "stream_options" && !value.is_object() {
                continue;
            }
            body[&key] = value;
        }

        // Add tools if supported
        if model.capabilities.toolcall {
            if let Some(tools) = tools {
                if !tools.is_empty() {
                    let tool_defs: Vec<_> = tools
                        .iter()
                        .map(|t| {
                            serde_json::json!({
                                "type": "function",
                                "function": {
                                    "name": t.name,
                                    "description": t.description,
                                    "parameters": t.parameters,
                                }
                            })
                        })
                        .collect();
                    body["tools"] = serde_json::Value::Array(tool_defs);
                }
            }
        }

        let body = super::cache::PreparedRequest::new(body, ApiFormat::OpenAI, &self.info, model);
        let response =
            super::send_with_cache_fallback(&self.info, model, "chat/completions", &body, context)
                .await?;

        let mut stream = super::sse::EventStream::new(response.bytes_stream());
        let mut usage = Usage::default();
        let mut stop_reason = StopReason::Unknown;
        let mut tool_calls_in_progress: HashMap<usize, PendingToolCall> = HashMap::new();
        let mut details = BTreeMap::new();
        let mut content = String::new();
        let mut completed_calls = Vec::new();
        let mut finished = false;
        let mut done_marker = false;
        let mut event_count = 0usize;

        let _ = sender.send(StreamEvent::TextStart).await;

        let idle = crate::util::stream_idle_timeout();
        while let Some(data) = stream.next_event(idle).await? {
            if data == "[DONE]" {
                done_marker = true;
                break;
            }
            event_count += 1;
            let json: serde_json::Value = serde_json::from_str(&data)?;
            if let Some(error) = json.get("error").filter(|value| !value.is_null()) {
                return Err(LlmError::StreamError(crate::util::redact_secrets(
                    &format!("{}: {}", self.info.name, error),
                )));
            }
            // Handle choices
            if let Some(choice) = json["choices"].as_array().and_then(|a| a.first()) {
                if let Some(delta) = choice.get("delta") {
                    // Content
                    if let Some(content) = delta["content"].as_str() {
                        if !content.is_empty() {
                            let _ = sender
                                .send(StreamEvent::TextDelta(content.to_string()))
                                .await;
                        }
                    }
                    if let Some(text) = delta["content"].as_str() {
                        content.push_str(text);
                    }

                    // Interleaved reasoning (DeepSeek `reasoning_content`,
                    // Qwen/Kimi `reasoning`, Together `reasoning_text`, …)
                    let reasoning = reasoning_fields.iter().find_map(|field| {
                        delta
                            .get(field)
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                    });
                    if let Some(reasoning) = reasoning {
                        let _ = sender
                            .send(StreamEvent::ReasoningDelta(reasoning.to_string()))
                            .await;
                    }
                    if let Some(blocks) = delta["reasoning_details"].as_array() {
                        for (position, block) in blocks.iter().enumerate() {
                            if reasoning.is_none() {
                                if let Some(text) =
                                    block["text"].as_str().or_else(|| block["summary"].as_str())
                                {
                                    let _ =
                                        sender.send(StreamEvent::ReasoningDelta(text.into())).await;
                                }
                            }
                            merge_reasoning_detail(&mut details, position, block);
                        }
                    }

                    // Tool calls
                    if let Some(tool_calls) = delta["tool_calls"].as_array() {
                        for tc in tool_calls {
                            let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                            let id = tc["id"].as_str().unwrap_or("");
                            let function = tc.get("function");
                            let name = function
                                .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                                .unwrap_or("");
                            let args = function
                                .and_then(|f| f.get("arguments"))
                                .map(tool_arguments_to_string)
                                .unwrap_or_default();

                            // Several OpenAI-compatible servers split the
                            // first tool-call chunk across deltas (`id`
                            // without `name`, or the reverse). Register the
                            // call on first sight and patch the fields in
                            // as they arrive — dropping any of them used
                            // to discard the whole call silently.
                            let entry = tool_calls_in_progress.entry(idx).or_default();
                            if !id.is_empty() && entry.id.is_empty() {
                                entry.id = id.to_string();
                            }
                            if !name.is_empty() && entry.name.is_empty() {
                                entry.name = name.to_string();
                            }
                            if !args.is_empty() {
                                entry.args.push_str(&args);
                            }
                            let just_started =
                                !entry.started && !entry.id.is_empty() && !entry.name.is_empty();
                            if just_started {
                                entry.started = true;
                                let _ = sender
                                    .send(StreamEvent::ToolCallStart {
                                        name: entry.name.clone(),
                                        id: entry.id.clone(),
                                    })
                                    .await;
                            }
                            let args = if just_started {
                                entry.args.clone()
                            } else {
                                args
                            };
                            if !args.is_empty() && entry.started {
                                let _ = sender
                                    .send(StreamEvent::ToolCallDelta {
                                        id: entry.id.clone(),
                                        args_delta: args,
                                    })
                                    .await;
                            }
                        }
                    }
                }

                // Finish reason
                if let Some(reason) = choice["finish_reason"].as_str() {
                    if reason == "error" {
                        return Err(super::stream_error(&self.info.name, choice));
                    }
                    finished = true;
                    stop_reason = StopReason::parse(reason);
                    let mut pending: Vec<_> = tool_calls_in_progress.iter().collect();
                    pending.sort_by_key(|(index, _)| **index);
                    for (_, call) in pending {
                        if call.id.is_empty() || call.name.is_empty() {
                            return Err(LlmError::StreamError(
                                "Chat stream returned an incomplete tool call".into(),
                            ));
                        }
                        completed_calls.push(serde_json::json!({"id": call.id, "type": "function",
                            "function": {"name": call.name, "arguments": call.args}}));
                    }
                    drain_pending_tool_calls(&mut tool_calls_in_progress, &sender).await;
                }
            }

            // Usage
            if let Some(u) = json["usage"].as_object() {
                usage.prompt_tokens =
                    u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                usage.completion_tokens = u
                    .get("completion_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                usage.total_tokens = usage.prompt_tokens.saturating_add(usage.completion_tokens);
                // Hits/writes under every dialect (DeepSeek reports
                // `prompt_cache_hit_tokens`, not `prompt_tokens_details`).
                // OpenRouter bills the call itself: `usage.cost` in USD.
                // With your own provider key (BYOK) `cost` is only
                // OpenRouter's fee; the provider's charge is reported in
                // `cost_details.upstream_inference_cost`. Both are paid.
                let upstream = u
                    .get("cost_details")
                    .and_then(|d| d.get("upstream_inference_cost"))
                    .and_then(|v| v.as_f64())
                    .filter(|v| v.is_finite() && *v > 0.0)
                    .unwrap_or(0.0);
                usage.cost_usd = u
                    .get("cost")
                    .and_then(|v| v.as_f64())
                    .map(|cost| cost + upstream);
                let (read, write) = super::cache::openai_usage_cache(&json["usage"]);
                usage.cache_read_tokens = read;
                usage.cache_creation_tokens = write;
                usage.prompt_tokens = usage
                    .prompt_tokens
                    .saturating_sub(read)
                    .saturating_sub(write);
            }
        }

        if !finished || !tool_calls_in_progress.is_empty() {
            tracing::warn!(provider = %self.info.id, model = %model.api_id, event_count, done_marker, finish_reason_seen = finished, pending_tool_calls = tool_calls_in_progress.len(), "Chat stream ended before completion");
            return Err(LlmError::StreamError(
                "Chat stream ended before completion".into(),
            ));
        }
        if !details.is_empty() {
            let mut message = serde_json::json!({"role": "assistant", "content": content,
                "reasoning_details": details.into_values().collect::<Vec<_>>()});
            if !completed_calls.is_empty() {
                message["tool_calls"] = serde_json::json!(completed_calls);
            }
            let _ = sender
                .send(StreamEvent::Continuation(ProviderContinuation {
                    provider_id: self.info.id.clone(),
                    model_id: model.api_id.clone(),
                    blocks: vec![
                        serde_json::json!({"type": "chat_completion", "message": message}),
                    ],
                }))
                .await;
        }

        let _ = sender.send(StreamEvent::TextEnd).await;
        let _ = sender
            .send(StreamEvent::Done {
                usage: usage.clone(),
                stop_reason,
            })
            .await;

        Ok(usage)
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError> {
        tracing::info!(
            provider = %self.info.id,
            "Fetching models from provider API"
        );

        let api_key = self.resolve_api_key();
        if api_key.is_none() && !self.info.env_keys.is_empty() {
            return Err(LlmError::HttpError(format!(
                "{}: API key required to list models",
                self.info.name
            )));
        }

        let base_url = self.resolve_base_url();
        if super::canonical_provider_id(&self.info.id) == "opencode-go"
            && base_url.trim_end_matches('/') != "https://opencode.ai/zen/go/v1"
        {
            return Err(LlmError::HttpError(
                "OpenCode Go requires its official Go endpoint".into(),
            ));
        }
        let mut url = reqwest::Url::parse(&join_url(&base_url, "models")).map_err(|e| {
            LlmError::HttpError(format!("{}: invalid models URL: {e}", self.info.name))
        })?;
        let mut models = Vec::new();
        let mut after_id = None::<String>;
        for _ in 0..100 {
            url.query_pairs_mut().clear();
            if let Some(cursor) = &after_id {
                url.query_pairs_mut().append_pair("after_id", cursor);
            }
            let mut request = self.client.get(url.clone());
            for (key, value) in &self.info.headers {
                request = request.header(key.as_str(), value.as_str());
            }
            if let Some((name, session)) = super::wire::session_header(&self.info, None) {
                request = request.header(name, session);
            }
            if let Some(api_key) = &api_key {
                request = if self.info.api_format == ApiFormat::Anthropic {
                    request.header("x-api-key", api_key)
                } else {
                    request.bearer_auth(api_key)
                };
            }
            let response = request.send().await.map_err(|e| {
                LlmError::HttpError(format!("{}: failed to list models: {e}", self.info.name))
            })?;
            if !response.status().is_success() {
                let status = response.status();
                let text = crate::util::redact_secrets(&response.text().await.unwrap_or_default());
                return Err(LlmError::HttpError(format!(
                    "{}: model discovery failed with HTTP {status}: {}",
                    self.info.name,
                    truncate_error_body(&text)
                )));
            }
            let json: serde_json::Value = response.json().await.map_err(|e| {
                LlmError::HttpError(format!("{}: invalid models response: {e}", self.info.name))
            })?;
            let data = json
                .get("data")
                .and_then(|value| value.as_array())
                .ok_or_else(|| {
                    LlmError::HttpError(format!(
                        "{}: invalid model list (expected a data array)",
                        self.info.name
                    ))
                })?;
            models.extend(data.iter().filter_map(|raw| {
                let id = raw["id"].as_str()?;
                if id.starts_with("ft:") || id.starts_with("system:") {
                    return None;
                }
                Some(self.model_info_from_service_id(id, raw))
            }));
            if self.info.api_format != ApiFormat::Anthropic || json["has_more"] != true {
                if super::llamacpp::is_llamacpp(&self.info) {
                    super::llamacpp::attach_props(
                        &self.client,
                        &base_url,
                        api_key.as_deref(),
                        &mut models,
                    )
                    .await;
                }
                return Ok(models);
            }
            let next = json["last_id"]
                .as_str()
                .filter(|id| Some(*id) != after_id.as_deref())
                .ok_or_else(|| {
                    LlmError::HttpError(format!(
                        "{}: invalid model pagination cursor",
                        self.info.name
                    ))
                })?;
            after_id = Some(next.into());
        }
        return Err(LlmError::HttpError(format!(
            "{}: model list exceeded 100 pages",
            self.info.name
        )));
    }
}

impl OpenAIProvider {
    fn model_info_from_service_id(&self, id: &str, raw: &serde_json::Value) -> ModelInfo {
        let live_reasoning =
            (crate::thinking::detect_thinking_format(&self.info.id, &self.info.base_url)
                == crate::thinking::ThinkingFormat::OpenRouter)
                .then(|| openrouter_reasoning_option(raw))
                .flatten();
        // Prefer registry/catalog-backed entry when this provider already has it.
        // Full catalog enrich also runs in the TUI on ModelsDiscovered.
        if let Some(mut known) = self
            .info
            .models
            .iter()
            .find(|m| m.id == id || m.api_id == id)
            .cloned()
            .or_else(|| {
                if let Some((prefix, bare)) = id.split_once('/') {
                    if prefix != self.info.id {
                        return None;
                    }
                    self.info
                        .models
                        .iter()
                        .find(|m| m.id == bare || m.api_id == bare)
                        .cloned()
                } else {
                    None
                }
            })
        {
            let live_context = raw
                .get("context_window")
                .or_else(|| raw.get("context_length"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .unwrap_or(0);
            if live_context > 0 {
                known.limits.context = live_context;
            }
            if let Some(name) = raw.get("name").and_then(|v| v.as_str()) {
                if !name.is_empty() && (known.name.is_empty() || known.name == known.id) {
                    known.name = name.to_string();
                }
            }
            if let Some(reasoning) = live_reasoning {
                known.capabilities.reasoning = true;
                known.reasoning_options = vec![reasoning];
                known.compat = crate::thinking::ThinkingFormat::OpenRouter;
            }
            if !known.cost.is_priced() {
                if let Some(cost) = live_pricing(raw) {
                    known.cost = cost;
                }
            }
            if let Some(modalities) = live_input_modalities(raw) {
                known.capabilities.vision = modalities.iter().any(|m| m == "image");
                known.capabilities.input_modalities = modalities;
            }
            apply_live_transport(&mut known, raw);
            return known;
        }

        let live_context = raw
            .get("context_window")
            .or_else(|| raw.get("context_length"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(0);

        let mut capabilities = inferred_service_model_capabilities(id);
        capabilities.reasoning = live_reasoning.is_some();
        if let Some(modalities) = live_input_modalities(raw) {
            capabilities.vision = modalities.iter().any(|m| m == "image");
            capabilities.input_modalities = modalities;
        }

        let mut discovered = ModelInfo {
            api: super::ModelApi::default(),
            id: id.to_string(),
            name: raw
                .get("display_name")
                .or_else(|| raw.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or(id)
                .to_string(),
            api_id: id.to_string(),
            provider_id: self.info.id.clone(),
            capabilities,
            cost: live_pricing(raw).unwrap_or_default(),
            limits: ModelLimits {
                // 0 means "unknown" — resolve/enrich fills from catalog or default.
                context: live_context,
                input: None,
                output: 0,
            },
            status: ModelStatus::Active,
            headers: HashMap::new(),
            options: HashMap::new(),
            reasoning_options: live_reasoning.into_iter().collect(),
            reasoning_stream_field: None,
            compat: crate::thinking::detect_thinking_format(&self.info.id, &self.info.base_url),
        };
        apply_live_transport(&mut discovered, raw);
        discovered
    }
}

fn apply_live_transport(model: &mut ModelInfo, raw: &serde_json::Value) {
    let provider = raw
        .get("provider")
        .cloned()
        .and_then(|v| serde_json::from_value::<crate::catalog::ModelProvider>(v).ok());
    let format = raw
        .get("api_format")
        .and_then(serde_json::Value::as_str)
        .and_then(ApiFormat::from_name)
        .or_else(|| super::ModelApi::from_provider(provider.as_ref()).format);
    if let Some(format) = format {
        model.api.live_format = Some(format);
        if model.api.format_source <= super::policy::MetadataSource::Live {
            model.api.format = Some(format);
            model.api.format_source = super::policy::MetadataSource::Live;
        }
    }
    if let Some(cache) = raw
        .get("cache_control")
        .and_then(serde_json::Value::as_bool)
    {
        model.api.live_cache_control = Some(cache);
        if model.api.cache_source <= super::policy::MetadataSource::Live {
            model
                .options
                .insert("cache_control".into(), serde_json::json!(cache));
            model.api.cache_source = super::policy::MetadataSource::Live;
        }
    }
}

/// Per-million prices from a live `/models` entry. OpenRouter publishes USD
/// **per token** as strings (`"pricing": {"prompt": "0.000003", …}`); the
/// catalog convention is per million tokens.
/// A user message with media as OpenAI chat content parts: the text, then
/// `image_url` / `input_audio` / `video_url` / `file` parts (data URLs). Kinds
/// the model does not accept become a text note.
fn chat_content_parts(message: &Message, model: &ModelInfo) -> Vec<serde_json::Value> {
    use crate::media::{AttachmentKind, Encoded};
    let mut parts = Vec::new();
    if !message.content.is_empty() {
        parts.push(serde_json::json!({"type": "text", "text": message.content}));
    }
    for encoded in crate::media::encode_for(model, &message.attachments) {
        match encoded {
            Encoded::Skipped(note) => parts.push(serde_json::json!({"type": "text", "text": note})),
            Encoded::Data { attachment, base64 } => {
                let data_url = format!("data:{};base64,{base64}", attachment.mime);
                parts.push(match attachment.kind {
                    AttachmentKind::Image => serde_json::json!({
                        "type": "image_url", "image_url": {"url": data_url}
                    }),
                    AttachmentKind::Audio => serde_json::json!({
                        "type": "input_audio",
                        "input_audio": {"data": base64, "format": crate::media::audio_format(&attachment.mime)}
                    }),
                    AttachmentKind::Video => serde_json::json!({
                        "type": "video_url", "video_url": {"url": data_url}
                    }),
                    AttachmentKind::Pdf => serde_json::json!({
                        "type": "file",
                        "file": {"filename": attachment.name, "file_data": data_url}
                    }),
                });
            }
        }
    }
    parts
}

/// OpenRouter `/models`: `architecture.input_modalities` (`text`, `image`,
/// `file`, `audio`, `video`).
fn live_input_modalities(raw: &serde_json::Value) -> Option<Vec<String>> {
    let list = raw
        .get("architecture")
        .and_then(|a| a.get("input_modalities"))
        .and_then(|m| m.as_array())?;
    let modalities: Vec<String> = list
        .iter()
        .filter_map(|m| m.as_str())
        .map(str::to_ascii_lowercase)
        .collect();
    (!modalities.is_empty()).then_some(modalities)
}

fn live_pricing(raw: &serde_json::Value) -> Option<ModelCost> {
    let pricing = raw.get("pricing")?;
    let rate = |key: &str| -> f64 {
        pricing
            .get(key)
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse().ok())
                    .or_else(|| v.as_f64())
            })
            .filter(|v: &f64| v.is_finite() && *v >= 0.0)
            .map_or(0.0, |per_token| per_token * 1_000_000.0)
    };
    let cost = ModelCost {
        input: rate("prompt"),
        output: rate("completion"),
        cache_read: rate("input_cache_read"),
        cache_write: rate("input_cache_write"),
        tiers: Vec::new(),
    };
    cost.is_priced().then_some(cost)
}

/// Convert OpenRouter's live model reasoning contract into the shared model
/// metadata. The presence of the object is meaningful; an omitted object is
/// intentionally left as `None` so catalog/runtime resolution cannot invent a
/// reasoning ladder for an unknown model.
fn openrouter_reasoning_option(raw: &serde_json::Value) -> Option<crate::catalog::ReasoningOption> {
    let reasoning = raw.get("reasoning")?.as_object()?;
    let supported_efforts_value = reasoning.get("supported_efforts");
    let effort_selectable = match supported_efforts_value {
        // OpenRouter documents null as “all gateway effort values”.
        Some(value) if value.is_null() => true,
        Some(value) if value.is_array() => true,
        // A malformed non-null value must not become the universal ladder.
        Some(_) | None => false,
    };
    let supported_efforts = supported_efforts_value.and_then(|value| {
        value.as_array().map(|values| {
            values
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
    });
    Some(crate::catalog::ReasoningOption::OpenRouter {
        effort_selectable,
        supported_efforts,
        default_effort: reasoning
            .get("default_effort")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        default_enabled: reasoning.get("default_enabled").and_then(|v| v.as_bool()),
        mandatory: reasoning
            .get("mandatory")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        supports_max_tokens: reasoning
            .get("supports_max_tokens")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

fn merge_reasoning_detail(
    details: &mut BTreeMap<usize, serde_json::Value>,
    position: usize,
    block: &serde_json::Value,
) {
    let index = block["index"]
        .as_u64()
        .map(|v| v as usize)
        .unwrap_or(position);
    let entry = details
        .entry(index)
        .or_insert_with(|| serde_json::json!({}));
    if let Some(fields) = block.as_object() {
        for (key, value) in fields {
            if matches!(key.as_str(), "text" | "summary" | "data") && value.is_string() {
                let mut text = entry[key].as_str().unwrap_or_default().to_string();
                text.push_str(value.as_str().unwrap());
                entry[key] = serde_json::json!(text);
            } else {
                entry[key] = value.clone();
            }
        }
    }
}

fn tool_arguments_to_string(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn truncate_error_body(text: &str) -> String {
    if text.chars().count() > 200 {
        format!("{}...", text.chars().take(200).collect::<String>())
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod discovery_tests {
    #[test]
    fn live_openrouter_pricing_converts_per_token_strings() {
        let raw = serde_json::json!({"pricing": {"prompt": "0.000003", "completion": "0.000015", "input_cache_read": "0.0000003"}});
        let cost = super::live_pricing(&raw).expect("priced");
        assert!((cost.input - 3.0).abs() < 1e-9);
        assert!((cost.output - 15.0).abs() < 1e-9);
        assert!((cost.cache_read - 0.3).abs() < 1e-9);
        let free = serde_json::json!({"pricing": {"prompt": "0", "completion": "0"}});
        assert!(
            super::live_pricing(&free).is_none(),
            "free models stay unpriced"
        );
    }

    use super::*;
    use std::sync::Arc;

    fn provider_with_models(models: Vec<ModelInfo>) -> OpenAIProvider {
        OpenAIProvider::from_info(ProviderInfo {
            id: "openrouter".to_string(),
            name: "OpenRouter".to_string(),
            api_format: ApiFormat::OpenAI,
            capabilities: ProviderCapabilities {
                streaming: true,
                tools: true,
                vision: false,
                reasoning: false,
                temperature: true,
                max_tokens: true,
            },
            base_url: "https://openrouter.ai/api/v1".to_string(),
            env_keys: vec!["OPENROUTER_API_KEY".to_string()],
            headers: HashMap::new(),
            models,
            api_key: None,
            transport: Default::default(),
        })
    }

    fn known_model(id: &str, name: &str, context: u32) -> ModelInfo {
        ModelInfo {
            api: Default::default(),
            id: id.to_string(),
            name: name.to_string(),
            api_id: id.to_string(),
            provider_id: "openrouter".to_string(),
            capabilities: inferred_service_model_capabilities(id),
            cost: ModelCost::default(),
            limits: ModelLimits {
                context,
                input: None,
                output: 0,
            },
            status: ModelStatus::Active,
            headers: HashMap::new(),
            options: HashMap::new(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            compat: crate::thinking::ThinkingFormat::Default,
        }
    }

    /// OpenRouter-shaped `/models` entry for a model the registry already knows.
    #[test]
    fn service_id_enriches_known_model_with_live_context_and_name() {
        let provider = provider_with_models(vec![known_model("deepseek/deepseek-chat", "", 0)]);
        let raw = serde_json::json!({
            "id": "deepseek/deepseek-chat",
            "name": "DeepSeek V3 (live)",
            "context_length": 65536
        });

        let info = provider.model_info_from_service_id("deepseek/deepseek-chat", &raw);

        assert_eq!(info.id, "deepseek/deepseek-chat");
        // Live context_length wins over the (unset) registry entry.
        assert_eq!(info.limits.context, 65_536);
        // Live display name fills an empty registry name.
        assert_eq!(info.name, "DeepSeek V3 (live)");
    }

    #[test]
    fn unknown_service_model_keeps_live_context_only() {
        let provider = provider_with_models(Vec::new());
        let raw = serde_json::json!({
            "id": "vendor/brand-new-model",
            "name": "Brand New",
            "context_length": 1_048_576
        });

        let info = provider.model_info_from_service_id("vendor/brand-new-model", &raw);

        // 0 means "unknown" downstream — resolve/enrich layers fill from catalog.
        assert_eq!(info.limits.context, 1_048_576);
        assert_eq!(info.name, "Brand New");
    }

    #[test]
    fn missing_context_fields_leave_context_unknown() {
        let provider = provider_with_models(Vec::new());
        let raw = serde_json::json!({ "id": "vendor/no-context" });

        let info = provider.model_info_from_service_id("vendor/no-context", &raw);

        assert_eq!(info.limits.context, 0);
        // Falls back to the raw id when no display name is present.
        assert_eq!(info.name, "vendor/no-context");
    }

    #[test]
    fn live_openrouter_reasoning_preserves_null_and_omitted_effort_metadata() {
        let provider = provider_with_models(Vec::new());
        let any_effort = serde_json::json!({
            "id": "vendor/any-effort",
            "reasoning": {
                "supported_efforts": null,
                "default_effort": "medium",
                "default_enabled": true,
                "mandatory": false
            }
        });
        let info = provider.model_info_from_service_id("vendor/any-effort", &any_effort);
        assert!(info.capabilities.reasoning);
        assert!(matches!(
            info.reasoning_options.as_slice(),
            [crate::catalog::ReasoningOption::OpenRouter {
                effort_selectable: true,
                supported_efforts: None,
                default_effort: Some(_),
                default_enabled: Some(true),
                mandatory: false,
                ..
            }]
        ));
        let levels = crate::thinking::supported_thinking_levels(&info);
        assert_eq!(
            levels,
            vec!["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        );

        let no_effort = serde_json::json!({
            "id": "vendor/no-effort",
            "reasoning": { "mandatory": true }
        });
        let info = provider.model_info_from_service_id("vendor/no-effort", &no_effort);
        assert!(info.capabilities.reasoning);
        assert!(crate::thinking::supported_thinking_levels(&info).is_empty());
    }

    #[test]
    fn live_openrouter_reasoning_reaches_request_options() {
        let provider = provider_with_models(Vec::new());
        let raw = serde_json::json!({
            "id": "vendor/live-reasoner",
            "reasoning": {
                "supported_efforts": ["low", "high"],
                "mandatory": true
            }
        });
        let mut info = provider.model_info_from_service_id("vendor/live-reasoner", &raw);
        crate::thinking::apply_thinking_level(&mut info, ApiFormat::OpenAI, "high");
        assert_eq!(
            info.options["reasoning"],
            serde_json::json!({ "effort": "high" })
        );
        crate::thinking::apply_thinking_level(&mut info, ApiFormat::OpenAI, "off");
        // Invalid selections must not erase the last valid mandatory effort.
        assert_eq!(
            info.options["reasoning"],
            serde_json::json!({"effort":"high"})
        );
    }

    #[test]
    fn malformed_openrouter_efforts_do_not_enable_universal_ladder() {
        let provider = provider_with_models(Vec::new());
        let raw = serde_json::json!({
            "id": "vendor/malformed",
            "reasoning": { "supported_efforts": { "high": true } }
        });
        let info = provider.model_info_from_service_id("vendor/malformed", &raw);
        // Not mandatory, so reasoning can still be switched — but no efforts.
        assert_eq!(
            crate::thinking::supported_thinking_levels(&info),
            vec!["off", "on"]
        );
    }

    #[test]
    fn discovery_selection_uses_runtime_snapshot_for_request_options() {
        let provider = provider_with_models(Vec::new());
        let raw = serde_json::json!({
            "id": "vendor/live-reasoner",
            "name": "Live Reasoner",
            "reasoning": {
                "supported_efforts": ["low", "high"],
                "default_effort": "low",
                "mandatory": true
            }
        });
        let discovered = provider.model_info_from_service_id("vendor/live-reasoner", &raw);

        let registry = crate::providers::ProviderRegistry::new();
        registry.register("openrouter", Arc::new(provider));
        registry.replace_runtime_models("openrouter", vec![discovered]);

        let mut selected = registry
            .runtime_model("openrouter", "vendor/live-reasoner")
            .expect("live discovery snapshot should be selectable");
        crate::thinking::apply_thinking_level(&mut selected, ApiFormat::OpenAI, "high");

        assert_eq!(
            selected.options.get("reasoning"),
            Some(&serde_json::json!({ "effort": "high" }))
        );
        assert!(registry
            .get_model("openrouter", "vendor/live-reasoner")
            .is_some());
    }

    #[test]
    fn media_travels_as_chat_content_parts() {
        use crate::media::tests::{attachment, test_model};
        use crate::media::AttachmentKind;
        let dir = tempfile::tempdir().unwrap();
        let mut message = crate::types::Message::user("what is in these?");
        message.attachments = vec![
            attachment(dir.path(), "shot.png", AttachmentKind::Image, "image/png"),
            attachment(dir.path(), "talk.wav", AttachmentKind::Audio, "audio/wav"),
            attachment(dir.path(), "demo.mp4", AttachmentKind::Video, "video/mp4"),
            attachment(
                dir.path(),
                "spec.pdf",
                AttachmentKind::Pdf,
                "application/pdf",
            ),
        ];
        let mut model = test_model();
        model.capabilities.input_modalities = ["text", "image", "audio", "file"]
            .map(String::from)
            .to_vec();
        let parts = super::chat_content_parts(&message, &model);
        let kinds: Vec<&str> = parts.iter().map(|p| p["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["text", "image_url", "input_audio", "text", "file"]);
        assert!(parts[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(parts[2]["input_audio"]["format"], "wav");
        assert!(
            parts[3]["text"]
                .as_str()
                .unwrap()
                .contains("does not accept video"),
            "the video becomes a note: {}",
            parts[3]
        );
        assert_eq!(parts[4]["file"]["filename"], "spec.pdf");
    }
}
