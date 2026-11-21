use super::{ApiFormat, ModelInfo, Provider, ProviderInfo, RequestContext};
use crate::llm::{LlmError, StopReason, StreamEvent, Usage};
use crate::types::{Message, Role, ToolDefinition};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use tokio::sync::mpsc::Sender;

/// Messages-compatible transport for MiniMax, Kimi and model-routed gateways.
pub struct MessagesProvider {
    info: ProviderInfo,
}

impl MessagesProvider {
    pub fn from_info(info: ProviderInfo) -> Self {
        Self { info }
    }

    fn transform_messages(&self, messages: &[Message], model: &ModelInfo) -> Vec<Value> {
        let mut result: Vec<Value> = Vec::new();
        for message in messages.iter().filter(|m| m.role != Role::System) {
            let role = if message.role == Role::Assistant {
                "assistant"
            } else {
                "user"
            };
            let mut content = Vec::new();
            if message.role == Role::Tool {
                content.push(json!({"type": "tool_result", "tool_use_id": message.tool_call_id.as_deref().unwrap_or_default(), "content": message.content}));
            } else if let Some(blocks) =
                super::replay_blocks(message, &self.info, model, "messages")
            {
                content = blocks;
            } else {
                // Old sessions have a single legacy signature, without native blocks.
                // New sessions preserve every signed/redacted block independently.
                if message.role == Role::Assistant && message.continuation.is_none() {
                    if let (Some(thinking), Some(signature)) =
                        (&message.thinking, &message.thinking_signature)
                    {
                        if !signature.is_empty() {
                            content.push(json!({"type": "thinking", "thinking": thinking, "signature": signature}));
                        }
                    }
                }
                if message.role == Role::User {
                    // Media first, then the text (Anthropic's recommended order).
                    content.extend(anthropic_media_blocks(message, model));
                }
                if !message.content.is_empty() {
                    content.push(json!({"type": "text", "text": message.content}));
                }
                if let Some(calls) = &message.tool_calls {
                    for call in calls {
                        content.push(json!({"type": "tool_use", "id": call.id, "name": call.function.name,
                            "input": serde_json::from_str::<Value>(&call.function.arguments).unwrap_or_else(|_| json!({}))}));
                    }
                }
            }
            if content.is_empty() {
                continue;
            }
            // Parallel tool results are one user turn; preserve each result block.
            if let Some(last) = result.last_mut().filter(|last| last["role"] == role) {
                last["content"].as_array_mut().unwrap().extend(content);
            } else {
                result.push(json!({"role": role, "content": content}));
            }
        }
        result
    }

    pub(crate) fn request_body(
        &self,
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        model: &ModelInfo,
    ) -> Value {
        let mut body = json!({"model": model.api_id, "messages": self.transform_messages(messages, model),
            "stream": true, "max_tokens": if model.limits.output == 0 { crate::catalog::DEFAULT_OUTPUT_TOKENS } else { model.limits.output }});
        let system = messages
            .iter()
            .filter(|m| m.role == Role::System && !m.content.is_empty())
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        if !system.is_empty() {
            body["system"] = json!(system);
        }
        for (key, value) in super::wire_options(&model.options) {
            match key.as_str() {
                "max_output_tokens" | "max_completion_tokens" => body["max_tokens"] = value,
                "reasoning_effort" => body["output_config"]["effort"] = value,
                "reasoning_summary" | "stream_options" | "prompt_cache_key" => {}
                _ => body[&key] = value,
            }
        }
        if model.capabilities.toolcall {
            if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
                body["tools"] = json!(tools.iter().map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.parameters})).collect::<Vec<_>>());
            }
        }
        body
    }
}

#[derive(Default)]
struct MessageStream {
    blocks: BTreeMap<usize, Value>,
    arguments: HashMap<usize, String>,
    closed: HashSet<usize>,
    usage: Usage,
    stop: Option<StopReason>,
    complete: bool,
}

/// `image` / `document` blocks for a user message's attachments. Audio and
/// video have no Messages-API block, so they (and anything the model does
/// not accept) become a text note.
fn anthropic_media_blocks(message: &Message, model: &ModelInfo) -> Vec<Value> {
    use crate::media::{AttachmentKind, Encoded};
    crate::media::encode_for(model, &message.attachments)
        .into_iter()
        .map(|encoded| match encoded {
            Encoded::Skipped(note) => json!({"type": "text", "text": note}),
            Encoded::Data { attachment, base64 } => match attachment.kind {
                AttachmentKind::Image => json!({"type": "image", "source": {
                    "type": "base64", "media_type": attachment.mime, "data": base64}}),
                AttachmentKind::Pdf => json!({"type": "document", "source": {
                    "type": "base64", "media_type": "application/pdf", "data": base64}}),
                AttachmentKind::Audio | AttachmentKind::Video => {
                    json!({"type": "text", "text": format!(
                    "[{} attachment {} not sent: the Anthropic Messages API has no {} input]",
                    attachment.kind.label(), attachment.name, attachment.kind.label())})
                }
            },
        })
        .collect()
}

fn append_text(object: &mut Value, field: &str, delta: &str) {
    if let Some(map) = object.as_object_mut() {
        match map.get_mut(field) {
            Some(Value::String(existing)) => existing.push_str(delta),
            _ => {
                map.insert(field.to_string(), Value::String(delta.to_string()));
            }
        }
    }
}

impl MessageStream {
    async fn close(&mut self, index: usize, sender: &Sender<StreamEvent>) -> Result<(), LlmError> {
        if !self.closed.insert(index) {
            return Ok(());
        }
        let Some(block) = self.blocks.get_mut(&index) else {
            return Ok(());
        };
        match block["type"].as_str() {
            Some("tool_use") => {
                if let Some(arguments) = self.arguments.remove(&index) {
                    if !arguments.trim().is_empty() {
                        block["input"] =
                            serde_json::from_str(&arguments).unwrap_or_else(|_| json!({}));
                    } else if block.get("input").is_none() || block["input"].is_null() {
                        block["input"] = json!({});
                    }
                } else {
                    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                    let _ = sender
                        .send(StreamEvent::ToolCallDelta {
                            id: block["id"].as_str().unwrap_or_default().into(),
                            args_delta: input.to_string(),
                        })
                        .await;
                }
                let _ = sender
                    .send(StreamEvent::ToolCallEnd {
                        id: block["id"].as_str().unwrap_or_default().into(),
                    })
                    .await;
            }
            Some("thinking") => {
                let _ = sender.send(StreamEvent::ReasoningEnd).await;
            }
            _ => {}
        }
        Ok(())
    }

    async fn event(&mut self, json: Value, sender: &Sender<StreamEvent>) -> Result<(), LlmError> {
        if let Some(error) = json.get("error").filter(|v| !v.is_null()) {
            return Err(super::stream_error("Messages", error));
        }
        let index = json["index"].as_u64().unwrap_or(0) as usize;
        match json["type"].as_str() {
            Some("error") => return Err(super::stream_error("Messages", &json)),
            Some("content_block_start") => {
                let block = json["content_block"].clone();
                match block["type"].as_str() {
                    Some("thinking") => {
                        let _ = sender.send(StreamEvent::ReasoningStart).await;
                        if let Some(text) = block["thinking"].as_str().filter(|s| !s.is_empty()) {
                            let _ = sender.send(StreamEvent::ReasoningDelta(text.into())).await;
                        }
                    }
                    Some("text") => {
                        if let Some(text) = block["text"].as_str().filter(|s| !s.is_empty()) {
                            let _ = sender.send(StreamEvent::TextDelta(text.into())).await;
                        }
                    }
                    Some("tool_use") => {
                        let id =
                            block["id"]
                                .as_str()
                                .filter(|s| !s.is_empty())
                                .ok_or_else(|| {
                                    LlmError::StreamError(
                                        "Messages returned a tool call without an id".into(),
                                    )
                                })?;
                        let name = block["name"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| {
                                LlmError::StreamError(
                                    "Messages returned a tool call without a name".into(),
                                )
                            })?;
                        let _ = sender
                            .send(StreamEvent::ToolCallStart {
                                id: id.into(),
                                name: name.into(),
                            })
                            .await;
                    }
                    _ => {}
                }
                self.blocks.insert(index, block);
            }
            Some("content_block_delta") => {
                let Some(block) = self.blocks.get_mut(&index) else {
                    return Err(LlmError::StreamError(
                        "Messages delta arrived before its content block".into(),
                    ));
                };
                let delta = &json["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(text) = delta["text"].as_str() {
                            append_text(block, "text", text);
                            let _ = sender.send(StreamEvent::TextDelta(text.into())).await;
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta["thinking"].as_str() {
                            append_text(block, "thinking", text);
                            let _ = sender.send(StreamEvent::ReasoningDelta(text.into())).await;
                        }
                    }
                    Some("signature_delta") => {
                        if let Some(signature) = signature_delta(delta) {
                            append_text(block, "signature", signature);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(text) = delta["partial_json"].as_str().filter(|s| !s.is_empty())
                        {
                            self.arguments.entry(index).or_default().push_str(text);
                            let _ = sender
                                .send(StreamEvent::ToolCallDelta {
                                    id: block["id"].as_str().unwrap_or_default().into(),
                                    args_delta: text.into(),
                                })
                                .await;
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => self.close(index, sender).await?,
            Some("message_start") => {
                let u = &json["message"]["usage"];
                super::billing::record_cost(&mut self.usage, u);
                self.usage.prompt_tokens = u["input_tokens"].as_u64().unwrap_or(0) as u32;
                self.usage.cache_creation_tokens =
                    u["cache_creation_input_tokens"].as_u64().unwrap_or(0) as u32;
                self.usage.cache_read_tokens =
                    u["cache_read_input_tokens"].as_u64().unwrap_or(0) as u32;
            }
            Some("message_delta") => {
                if let Some(reason) = json["delta"]["stop_reason"].as_str() {
                    self.stop = Some(StopReason::parse(reason));
                }
                let u = &json["usage"];
                super::billing::record_cost(&mut self.usage, u);
                if let Some(tokens) = u["output_tokens"].as_u64() {
                    self.usage.completion_tokens = tokens as u32;
                }
                if let Some(tokens) = u["cache_creation_input_tokens"].as_u64() {
                    self.usage.cache_creation_tokens = tokens as u32;
                }
                if let Some(tokens) = u["cache_read_input_tokens"].as_u64() {
                    self.usage.cache_read_tokens = tokens as u32;
                }
            }
            Some("message_stop") => self.complete = true,
            _ => {}
        }
        Ok(())
    }
}

#[async_trait]
impl Provider for MessagesProvider {
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
        let body = self.request_body(messages, tools, model);
        let body =
            super::cache::PreparedRequest::new(body, ApiFormat::Anthropic, &self.info, model);
        let response =
            super::send_with_cache_fallback(&self.info, model, "messages", &body, context).await?;
        let mut sse = super::wire::begin_sse_stream(response, &sender).await;
        let mut state = MessageStream::default();
        while let Some(event) = sse.next_json().await? {
            state.event(event, &sender).await?;
            if state.complete {
                break;
            }
        }
        if !state.complete && state.stop.is_none() {
            return Err(LlmError::StreamError(
                "Messages stream ended before the message completed".into(),
            ));
        }
        for index in state.blocks.keys().copied().collect::<Vec<_>>() {
            state.close(index, &sender).await?;
        }
        state.usage.total_tokens = state
            .usage
            .prompt_tokens
            .saturating_add(state.usage.completion_tokens)
            .saturating_add(state.usage.cache_creation_tokens)
            .saturating_add(state.usage.cache_read_tokens);
        super::wire::finish_sse_stream(
            &self.info,
            model,
            &sender,
            state.usage,
            state.stop.unwrap_or(StopReason::Stop),
            state.blocks.into_values().collect(),
        )
        .await
    }
    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError> {
        Ok(self.info.models.clone())
    }
}

fn signature_delta(delta: &Value) -> Option<&str> {
    (delta.get("type")?.as_str()? == "signature_delta")
        .then(|| delta.get("signature")?.as_str())
        .flatten()
}

#[cfg(test)]
mod signature_tests {
    use super::*;
    #[test]
    fn reads_signature_from_typed_delta() {
        assert_eq!(
            signature_delta(&json!({"type":"signature_delta","signature":"opaque"})),
            Some("opaque")
        );
        assert_eq!(
            signature_delta(&json!({"type":"text_delta","signature":"not a signature delta"})),
            None
        );
    }

    #[test]
    fn anthropic_gets_image_and_document_blocks_and_notes_for_the_rest() {
        use crate::media::tests::{attachment, test_model};
        use crate::media::AttachmentKind;
        let dir = tempfile::tempdir().unwrap();
        let mut message = Message::user("review");
        message.attachments = vec![
            attachment(dir.path(), "ui.png", AttachmentKind::Image, "image/png"),
            attachment(
                dir.path(),
                "spec.pdf",
                AttachmentKind::Pdf,
                "application/pdf",
            ),
            attachment(dir.path(), "call.mp3", AttachmentKind::Audio, "audio/mpeg"),
        ];
        let mut model = test_model();
        model.capabilities.input_modalities =
            ["text", "image", "pdf", "audio"].map(String::from).to_vec();
        let blocks = anthropic_media_blocks(&message, &model);
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["source"]["media_type"], "image/png");
        assert_eq!(blocks[1]["type"], "document");
        assert_eq!(
            blocks[2]["type"], "text",
            "no audio block in the Messages API"
        );
    }

    #[tokio::test]
    async fn empty_partial_json_and_truncated_tool_json_do_not_fail_stream() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        let mut state = MessageStream::default();
        // 0-arg tool receiving an empty partial_json delta.
        state
            .event(
                json!({
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": "t1", "name": "ping", "input": {}}
                }),
                &tx,
            )
            .await
            .unwrap();
        state
            .event(
                json!({
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": ""}
                }),
                &tx,
            )
            .await
            .unwrap();
        state
            .event(json!({"type": "content_block_stop", "index": 0}), &tx)
            .await
            .unwrap();
        assert_eq!(state.blocks[&0]["input"], json!({}));

        // Truncated tool JSON falls back gracefully instead of returning Err.
        state
            .event(
                json!({
                    "type": "content_block_start",
                    "index": 1,
                    "content_block": {"type": "tool_use", "id": "t2", "name": "write", "input": {}}
                }),
                &tx,
            )
            .await
            .unwrap();
        state
            .event(
                json!({
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"a.rs\""}
                }),
                &tx,
            )
            .await
            .unwrap();
        state
            .event(json!({"type": "content_block_stop", "index": 1}), &tx)
            .await
            .unwrap();
        assert_eq!(state.blocks[&1]["input"], json!({}));
        drop(tx);
        let mut deltas = Vec::new();
        while let Some(ev) = rx.recv().await {
            if let StreamEvent::ToolCallDelta { id, args_delta } = ev {
                deltas.push((id, args_delta));
            }
        }
        assert!(deltas.iter().any(|(id, a)| id == "t1" && a == "{}"));
    }
}
