//! Native generateContent transport for model-routed gateways.
use super::{ModelInfo, Provider, ProviderInfo, RequestContext};
use crate::llm::{LlmError, StopReason, StreamEvent, Usage};
use crate::types::{Message, Role, ToolDefinition};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;

pub struct GoogleProvider {
    info: ProviderInfo,
}

impl GoogleProvider {
    pub fn from_info(info: ProviderInfo) -> Self {
        Self { info }
    }

    fn replay(&self, message: &Message, model: &ModelInfo) -> Option<Vec<Value>> {
        let continuation = message.continuation.as_ref()?;
        if !continuation.matches(&self.info.id, &model.api_id) {
            return None;
        }
        let block = continuation.blocks.first()?;
        if block["type"] != "google_content" {
            return None;
        }
        let parts = block["parts"].as_array()?;
        let ids = block["call_ids"].as_array()?;
        let text: String = parts
            .iter()
            .filter(|p| p["thought"] != true)
            .filter_map(|p| p["text"].as_str())
            .collect();
        if text != message.content {
            return None;
        }
        let calls = message.tool_calls.as_deref().unwrap_or_default();
        let native = parts
            .iter()
            .filter_map(|p| p.get("functionCall"))
            .collect::<Vec<_>>();
        if native.len() != calls.len() || ids.len() != calls.len() {
            return None;
        }
        if !native.iter().zip(calls).zip(ids).all(|((part, call), id)| {
            id.as_str() == Some(call.id.as_str())
                && part["name"] == call.function.name
                && serde_json::from_str::<Value>(&call.function.arguments)
                    .is_ok_and(|args| args == part["args"])
        }) {
            return None;
        }
        Some(parts.clone())
    }

    pub(crate) fn request_body(
        &self,
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        model: &ModelInfo,
    ) -> Result<Value, LlmError> {
        let mut contents: Vec<Value> = Vec::new();
        let mut system = Vec::new();
        let mut call_names: HashMap<String, (String, Option<Value>)> = HashMap::new();
        for message in messages {
            if message.role == Role::System {
                if !message.content.is_empty() {
                    system.push(json!({"text": message.content}));
                }
                continue;
            }
            let role = if message.role == Role::Assistant {
                "model"
            } else {
                "user"
            };
            let mut parts = Vec::new();
            if message.role == Role::Tool {
                let id = message.tool_call_id.as_deref().unwrap_or_default();
                let (name, native_id) = call_names.get(id).ok_or_else(|| {
                    LlmError::StreamError("Missing function call for Google tool result".into())
                })?;
                let mut result =
                    json!({"name": name, "response": super::wire::tool_output(&message.content)});
                if let Some(native_id) = native_id {
                    result["id"] = native_id.clone();
                }
                parts.push(json!({"functionResponse": result}));
            } else {
                let replay = self.replay(message, model);
                if let Some(calls) = &message.tool_calls {
                    let native = replay
                        .as_ref()
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(|p| p.get("functionCall"))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    for (index, call) in calls.iter().enumerate() {
                        call_names.insert(
                            call.id.clone(),
                            (
                                call.function.name.clone(),
                                native.get(index).and_then(|p| p.get("id")).cloned(),
                            ),
                        );
                    }
                }
                if let Some(replay) = replay {
                    parts = replay;
                } else {
                    if message.role == Role::User {
                        // Gemini takes every media kind as inline data.
                        for encoded in crate::media::encode_for(model, &message.attachments) {
                            parts.push(match encoded {
                                crate::media::Encoded::Skipped(note) => json!({"text": note}),
                                crate::media::Encoded::Data { attachment, base64 } => json!({
                                    "inlineData": {"mimeType": attachment.mime, "data": base64}
                                }),
                            });
                        }
                    }
                    if !message.content.is_empty() {
                        parts.push(json!({"text": message.content}));
                    }
                    if let Some(calls) = &message.tool_calls {
                        for call in calls {
                            parts.push(json!({"functionCall": {
                                "name": call.function.name,
                                "args": serde_json::from_str::<Value>(&call.function.arguments).unwrap_or_else(|_| json!({})),
                            }}));
                        }
                    }
                }
            }
            if parts.is_empty() {
                continue;
            }
            if let Some(last) = contents.last_mut().filter(|last| last["role"] == role) {
                last["parts"].as_array_mut().unwrap().extend(parts);
            } else {
                contents.push(json!({"role": role, "parts": parts}));
            }
        }
        let mut body = json!({"contents": contents, "generationConfig": {}});
        if !system.is_empty() {
            body["systemInstruction"] = json!({"parts": system});
        }
        if model.limits.output > 0 {
            body["generationConfig"]["maxOutputTokens"] = json!(model.limits.output);
        }
        for (key, value) in super::wire_options(&model.options) {
            match key.as_str() {
                "thinkingConfig" | "temperature" | "topP" | "topK" | "maxOutputTokens"
                | "responseMimeType" => body["generationConfig"][&key] = value,
                "max_tokens" | "max_output_tokens" => {
                    body["generationConfig"]["maxOutputTokens"] = value
                }
                "top_p" => body["generationConfig"]["topP"] = value,
                "top_k" => body["generationConfig"]["topK"] = value,
                "generationConfig" if value.is_object() => {
                    body["generationConfig"]
                        .as_object_mut()
                        .unwrap()
                        .extend(value.as_object().unwrap().clone());
                }
                "thinking" | "reasoning" | "reasoning_effort" | "reasoning_summary"
                | "stream_options" | "prompt_cache_key" => {}
                _ => body[&key] = value,
            }
        }
        if model.capabilities.reasoning {
            body["generationConfig"]["thinkingConfig"]["includeThoughts"] = json!(true);
        }
        if model.capabilities.toolcall {
            if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
                body["tools"] = json!([{"functionDeclarations": tools.iter().map(|tool| json!({
                    "name": tool.name, "description": tool.description, "parametersJsonSchema": tool.parameters,
                })).collect::<Vec<_>>()}]);
            }
        }
        Ok(body)
    }
}

#[async_trait]
impl Provider for GoogleProvider {
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
        let model_id = model
            .api_id
            .strip_prefix("models/")
            .unwrap_or(&model.api_id);
        if model_id.contains(['?', '#', '/']) {
            return Err(LlmError::HttpError(
                "Invalid Google model identifier".into(),
            ));
        }
        let body = self.request_body(messages, tools, model)?;
        let response = super::send_request(
            &self.info,
            model,
            &format!("models/{model_id}:streamGenerateContent?alt=sse"),
            &body,
            context,
        )
        .await?;
        let mut sse = super::wire::begin_sse_stream(response, &sender).await;
        let mut parts = Vec::new();
        let mut call_ids = Vec::new();
        let mut usage = Usage::default();
        let mut stop_reason = None;
        while let Some(event) = sse.next_json().await? {
            if let Some(error) = event.get("error").filter(|v| !v.is_null()) {
                return Err(super::stream_error(&self.info.name, error));
            }
            if event["promptFeedback"]["blockReason"].is_string() {
                stop_reason = Some(StopReason::Safety);
            }
            if let Some(candidate) = event["candidates"].as_array().and_then(|c| c.first()) {
                if let Some(chunk) = candidate["content"]["parts"].as_array() {
                    for part in chunk {
                        if let Some(text) = part["text"].as_str().filter(|s| !s.is_empty()) {
                            let delta = if part["thought"] == true {
                                StreamEvent::ReasoningDelta(text.into())
                            } else {
                                StreamEvent::TextDelta(text.into())
                            };
                            let _ = sender.send(delta).await;
                        }
                        if let Some(call) = part.get("functionCall") {
                            let name = call["name"].as_str().filter(|s| !s.is_empty()).ok_or_else(
                                || {
                                    LlmError::StreamError(
                                        "Google returned an unnamed function call".into(),
                                    )
                                },
                            )?;
                            let id = call["id"]
                                .as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                            let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
                            let _ = sender
                                .send(StreamEvent::ToolCallStart {
                                    id: id.clone(),
                                    name: name.into(),
                                })
                                .await;
                            let _ = sender
                                .send(StreamEvent::ToolCallDelta {
                                    id: id.clone(),
                                    args_delta: args.to_string(),
                                })
                                .await;
                            let _ = sender
                                .send(StreamEvent::ToolCallEnd { id: id.clone() })
                                .await;
                            call_ids.push(id);
                        }
                        // Keep signatures attached to their original parts, including
                        // signature-only parts; concatenating text loses this boundary.
                        parts.push(part.clone());
                    }
                }
                if let Some(reason) = candidate["finishReason"].as_str() {
                    stop_reason = Some(StopReason::parse(reason));
                }
            }
            if let Some(u) = event.get("usageMetadata") {
                super::billing::record_cost(&mut usage, u);
                usage.prompt_tokens = u["promptTokenCount"].as_u64().unwrap_or(0) as u32;
                usage.completion_tokens = (u["candidatesTokenCount"].as_u64().unwrap_or(0)
                    + u["thoughtsTokenCount"].as_u64().unwrap_or(0))
                    as u32;
                usage.cache_read_tokens = u["cachedContentTokenCount"].as_u64().unwrap_or(0) as u32;
                usage.total_tokens = u["totalTokenCount"]
                    .as_u64()
                    .unwrap_or(usage.prompt_tokens as u64 + usage.completion_tokens as u64)
                    as u32;
                usage.prompt_tokens = usage.prompt_tokens.saturating_sub(usage.cache_read_tokens);
            }
        }
        let mut stop_reason = stop_reason.ok_or_else(|| {
            LlmError::StreamError("Google stream ended without a finish reason".into())
        })?;
        if !call_ids.is_empty() && stop_reason == StopReason::Stop {
            stop_reason = StopReason::ToolUse;
        }
        let continuation_blocks = if parts.is_empty() {
            Vec::new()
        } else {
            vec![json!({"type": "google_content", "parts": parts, "call_ids": call_ids})]
        };
        super::wire::finish_sse_stream(
            &self.info,
            model,
            &sender,
            usage,
            stop_reason,
            continuation_blocks,
        )
        .await
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError> {
        Ok(self.info.models.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FunctionCall, ToolCall};

    #[test]
    fn malformed_historical_tool_args_fall_back_to_empty_object() {
        let provider = GoogleProvider::from_info(ProviderInfo {
            id: "google".into(),
            name: "Google".into(),
            ..Default::default()
        });
        let model = super::super::fallback_model_info("google", "gemini-2.5-pro");
        let assistant = Message {
            role: Role::Assistant,
            content: String::new(),
            tool_calls: Some(vec![ToolCall {
                id: "c1".into(),
                call_type: "function".into(),
                function: FunctionCall {
                    name: "read_file".into(),
                    arguments: "{broken json".into(),
                },
            }]),
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        };
        let body = provider.request_body(&[assistant], None, &model).unwrap();
        assert_eq!(
            body["contents"][0]["parts"][0]["functionCall"]["args"],
            json!({})
        );
    }
}
