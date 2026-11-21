//! Responses transport shared by direct providers and gateways.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use tokio::sync::mpsc::Sender;

use super::{ModelInfo, Provider, ProviderInfo, RequestContext};
use crate::llm::{LlmError, StopReason, StreamEvent, Usage};
use crate::types::{Message, Role, ToolDefinition};

pub struct ResponsesProvider {
    info: ProviderInfo,
}

impl ResponsesProvider {
    pub fn from_info(info: ProviderInfo) -> Self {
        Self { info }
    }

    pub(crate) fn request_body(
        &self,
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        model: &ModelInfo,
    ) -> Value {
        let mut input = Vec::new();
        for message in messages {
            if message.role == Role::Tool {
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": message.tool_call_id.as_deref().unwrap_or_default(),
                    "output": message.content,
                }));
                continue;
            }
            if message.role == Role::Assistant {
                if let Some(blocks) = super::replay_blocks(message, &self.info, model, "responses")
                {
                    input.extend(blocks.into_iter().map(|mut block| {
                        // Stateless requests replay data, never references to server storage.
                        if let Some(object) = block.as_object_mut() {
                            object.remove("id");
                        }
                        block
                    }));
                    continue;
                }
            }
            if message.role == Role::User && !message.attachments.is_empty() {
                input.push(
                    json!({"role": "user", "content": response_content_parts(message, model)}),
                );
            } else if !message.content.is_empty() {
                input.push(json!({
                    "role": match message.role { Role::System => "system", Role::User => "user", _ => "assistant" },
                    "content": message.content,
                }));
            }
            if let Some(calls) = &message.tool_calls {
                for call in calls {
                    input.push(json!({
                        "type": "function_call", "call_id": call.id,
                        "name": call.function.name,
                        // Broken arguments replayed made strict upstreams reject the request.
                        "arguments": super::openai::well_formed_arguments(&call.function.arguments),
                    }));
                }
            }
        }
        let mut body = json!({
            "model": model.api_id, "input": input, "stream": true, "store": false,
        });
        if model.limits.output > 0 {
            body["max_output_tokens"] = json!(model.limits.output);
        }
        for (key, value) in super::wire_options(&model.options) {
            match key.as_str() {
                "reasoning_effort" => {
                    body["reasoning"]["effort"] = value;
                }
                "reasoning_summary" => {
                    body["reasoning"]["summary"] = value;
                }
                "max_tokens" | "max_completion_tokens" => {
                    body["max_output_tokens"] = value;
                }
                "thinking" | "enable_thinking" | "output_config" | "stream_options" => {}
                _ => {
                    body[&key] = value;
                }
            }
        }
        if model.capabilities.reasoning {
            if body["reasoning"]["summary"].is_null() {
                body["reasoning"]["summary"] = json!("auto");
            }
            let include = body
                .as_object_mut()
                .unwrap()
                .entry("include")
                .or_insert(json!([]));
            if let Some(values) = include.as_array_mut() {
                if !values.iter().any(|v| v == "reasoning.encrypted_content") {
                    values.push(json!("reasoning.encrypted_content"));
                }
            }
        }
        if model.capabilities.toolcall {
            if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
                body["tools"] = json!(tools
                    .iter()
                    .map(|t| json!({
                        "type": "function", "name": t.name,
                        "description": t.description, "parameters": t.parameters,
                        "strict": false,
                    }))
                    .collect::<Vec<_>>());
            }
        }
        body
    }
}

#[derive(Default)]
struct Call {
    call_id: String,
    name: String,
    arguments: String,
    sent: usize,
    started: bool,
    ended: bool,
}

impl Call {
    async fn emit(&mut self, sender: &Sender<StreamEvent>, close: bool) -> Result<(), LlmError> {
        if self.ended {
            return Ok(());
        }
        if self.call_id.is_empty() || self.name.is_empty() {
            if close {
                return Err(LlmError::StreamError(
                    "Responses returned an incomplete function call".into(),
                ));
            }
            return Ok(());
        }
        if !self.started {
            let _ = sender
                .send(StreamEvent::ToolCallStart {
                    id: self.call_id.clone(),
                    name: self.name.clone(),
                })
                .await;
            self.started = true;
        }
        if self.sent < self.arguments.len() {
            let _ = sender
                .send(StreamEvent::ToolCallDelta {
                    id: self.call_id.clone(),
                    args_delta: self.arguments[self.sent..].to_string(),
                })
                .await;
            self.sent = self.arguments.len();
        }
        if close {
            let _ = sender
                .send(StreamEvent::ToolCallEnd {
                    id: self.call_id.clone(),
                })
                .await;
            self.ended = true;
        }
        Ok(())
    }

    fn finish_arguments(&mut self, complete: &str) -> Result<(), LlmError> {
        if !complete.starts_with(&self.arguments) {
            return Err(LlmError::StreamError(
                "Responses changed streamed function arguments".into(),
            ));
        }
        self.arguments = complete.to_string();
        Ok(())
    }
}

#[derive(Default)]
struct ResponseState {
    calls: HashMap<String, Call>,
    output: BTreeMap<usize, Value>,
    text: HashMap<(String, usize), String>,
    thought: HashMap<(String, usize), String>,
    terminal: bool,
    stop: Option<StopReason>,
    usage: Usage,
}

impl ResponseState {
    async fn item(
        &mut self,
        index: usize,
        item: &Value,
        sender: &Sender<StreamEvent>,
        done: bool,
    ) -> Result<(), LlmError> {
        let id = item["id"].as_str().unwrap_or_default().to_string();
        match item["type"].as_str() {
            Some("function_call") => {
                let call = self.calls.entry(id).or_default();
                if let Some(value) = item["call_id"].as_str() {
                    call.call_id = value.into();
                }
                if let Some(value) = item["name"].as_str() {
                    call.name = value.into();
                }
                if let Some(args) = item["arguments"].as_str() {
                    if done {
                        call.finish_arguments(args)?;
                    } else if call.arguments.is_empty() {
                        call.arguments = args.into();
                    }
                }
                call.emit(sender, done).await?;
            }
            Some("message") if done => {
                if let Some(parts) = item["content"].as_array() {
                    for (part_index, part) in parts.iter().enumerate() {
                        if let Some(text) =
                            part["text"].as_str().or_else(|| part["refusal"].as_str())
                        {
                            let sent = self.text.entry((id.clone(), part_index)).or_default();
                            if let Some(tail) =
                                text.strip_prefix(sent.as_str()).filter(|s| !s.is_empty())
                            {
                                let _ = sender.send(StreamEvent::TextDelta(tail.into())).await;
                            }
                            *sent = text.into();
                        }
                    }
                }
            }
            Some("reasoning") if done => {
                if let Some(parts) = item["summary"].as_array() {
                    for (part_index, part) in parts.iter().enumerate() {
                        if let Some(text) = part["text"].as_str() {
                            let sent = self.thought.entry((id.clone(), part_index)).or_default();
                            if let Some(tail) =
                                text.strip_prefix(sent.as_str()).filter(|s| !s.is_empty())
                            {
                                let _ = sender.send(StreamEvent::ReasoningDelta(tail.into())).await;
                            }
                            *sent = text.into();
                        }
                    }
                }
            }
            _ => {}
        }
        if done {
            self.output.insert(index, item.clone());
        }
        Ok(())
    }

    async fn event(&mut self, json: Value, sender: &Sender<StreamEvent>) -> Result<(), LlmError> {
        if let Some(error) = json.get("error").filter(|v| !v.is_null()) {
            return Err(super::stream_error("Responses", error));
        }
        let kind = json["type"].as_str().unwrap_or_default();
        match kind {
            "error" | "response.failed" => {
                return Err(super::stream_error("Responses", &json));
            }
            "response.output_text.delta"
            | "response.refusal.delta"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_text.delta" => {
                if let Some(delta) = json["delta"].as_str().filter(|s| !s.is_empty()) {
                    let reasoning = kind.contains("reasoning");
                    let index = json[if reasoning {
                        "summary_index"
                    } else {
                        "content_index"
                    }]
                    .as_u64()
                    .unwrap_or(0) as usize;
                    let key = (
                        json["item_id"].as_str().unwrap_or_default().to_string(),
                        index,
                    );
                    if reasoning {
                        self.thought.entry(key).or_default().push_str(delta);
                        let _ = sender.send(StreamEvent::ReasoningDelta(delta.into())).await;
                    } else {
                        self.text.entry(key).or_default().push_str(delta);
                        let _ = sender.send(StreamEvent::TextDelta(delta.into())).await;
                    }
                }
            }
            "response.output_item.added" | "response.output_item.done" => {
                self.item(
                    json["output_index"].as_u64().unwrap_or(0) as usize,
                    &json["item"],
                    sender,
                    kind.ends_with(".done"),
                )
                .await?;
            }
            "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
                let id = json["item_id"].as_str().unwrap_or_default().to_string();
                let call = self.calls.entry(id).or_default();
                if kind.ends_with(".delta") {
                    if let Some(delta) = json["delta"].as_str() {
                        call.arguments.push_str(delta);
                    }
                } else if let Some(args) = json["arguments"].as_str() {
                    call.finish_arguments(args)?;
                }
                call.emit(sender, false).await?;
            }
            "response.completed" | "response.incomplete" => {
                let response = &json["response"];
                if let Some(error) = response.get("error").filter(|v| !v.is_null()) {
                    return Err(super::stream_error("Responses", error));
                }
                if let Some(output) = response["output"].as_array() {
                    for (index, item) in output.iter().enumerate() {
                        self.item(index, item, sender, true).await?;
                    }
                }
                let usage = &response["usage"];
                super::billing::record_cost(&mut self.usage, usage);
                self.usage.prompt_tokens = usage["input_tokens"].as_u64().unwrap_or(0) as u32;
                self.usage.completion_tokens = usage["output_tokens"].as_u64().unwrap_or(0) as u32;
                self.usage.cache_read_tokens = usage["input_tokens_details"]["cached_tokens"]
                    .as_u64()
                    .unwrap_or(0) as u32;
                self.usage.total_tokens = self
                    .usage
                    .prompt_tokens
                    .saturating_add(self.usage.completion_tokens);
                self.usage.prompt_tokens = self
                    .usage
                    .prompt_tokens
                    .saturating_sub(self.usage.cache_read_tokens);
                self.stop = Some(if kind == "response.incomplete" {
                    match response["incomplete_details"]["reason"].as_str() {
                        Some("max_output_tokens") => StopReason::Length,
                        Some("content_filter") => StopReason::Safety,
                        _ => StopReason::Unknown,
                    }
                } else if self.calls.values().any(|c| c.ended) {
                    StopReason::ToolUse
                } else {
                    StopReason::Stop
                });
                self.terminal = true;
            }
            _ => {}
        }
        Ok(())
    }
}

#[async_trait]
impl Provider for ResponsesProvider {
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
        let mut body = self.request_body(messages, tools, model);
        if let Some(key) = super::cache::prompt_cache_key(
            super::ApiFormat::Responses,
            &self.info,
            model,
            context.session_id,
        ) {
            body["prompt_cache_key"] = json!(key);
        }
        let response = super::send_request(&self.info, model, "responses", &body, context).await?;
        let mut sse = super::wire::begin_sse_stream(response, &sender).await;
        let mut state = ResponseState::default();
        while let Some(event) = sse.next_json().await? {
            state.event(event, &sender).await?;
            if state.terminal {
                break;
            }
        }
        if !state.terminal {
            return Err(LlmError::StreamError(
                "Responses stream ended before the response completed".into(),
            ));
        }
        super::wire::finish_sse_stream(
            &self.info,
            model,
            &sender,
            state.usage,
            state.stop.unwrap_or(StopReason::Unknown),
            state.output.into_values().collect(),
        )
        .await
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError> {
        super::openai::OpenAIProvider::from_info(self.info.clone())
            .list_models()
            .await
    }
}

/// A user message with media for the Responses API: `input_text`, then
/// `input_image` / `input_file` (data URLs). Audio and video, and kinds the
/// model does not accept, become a text note.
fn response_content_parts(message: &Message, model: &ModelInfo) -> Vec<Value> {
    use crate::media::{AttachmentKind, Encoded};
    let mut parts = Vec::new();
    if !message.content.is_empty() {
        parts.push(json!({"type": "input_text", "text": message.content}));
    }
    for encoded in crate::media::encode_for(model, &message.attachments) {
        parts.push(match encoded {
            Encoded::Skipped(note) => json!({"type": "input_text", "text": note}),
            Encoded::Data { attachment, base64 } => {
                let data_url = format!("data:{};base64,{base64}", attachment.mime);
                match attachment.kind {
                    AttachmentKind::Image => json!({"type": "input_image", "image_url": data_url}),
                    AttachmentKind::Pdf => json!({"type": "input_file",
                        "filename": attachment.name, "file_data": data_url}),
                    AttachmentKind::Audio | AttachmentKind::Video => json!({"type": "input_text",
                        "text": format!("[{} attachment {} not sent: the Responses API has no {} input]",
                            attachment.kind.label(), attachment.name, attachment.kind.label())}),
                }
            }
        });
    }
    parts
}
