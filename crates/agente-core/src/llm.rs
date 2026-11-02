use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use thiserror::Error;
use tokio::sync::mpsc::Sender;

use crate::types::{Message, ToolCall, ToolDefinition};

#[derive(Error, Debug)]
pub enum LlmError {
    #[error("HTTP request failed: {0}")]
    HttpError(String),
    #[error("JSON parsing failed: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("LLM response missing content")]
    MissingContent,
    #[error("Rate limited")]
    RateLimited,
    #[error("Stream error: {0}")]
    StreamError(String),
}

/// Why a provider ended a response.
///
/// `Unknown` on the `Done` event means the stream ended without the provider
/// announcing a reason — commonly a truncated (proxied) connection — and lets
/// the agent loop surface that instead of treating the partial text as a
/// finished answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StopReason {
    /// Natural end of turn.
    #[default]
    Stop,
    /// Model wants tool calls executed.
    ToolUse,
    /// Cut off by a token/length limit.
    Length,
    /// Blocked by a safety filter / content policy.
    Safety,
    /// Stream ended without any announced reason.
    Unknown,
}

impl StopReason {
    /// Parse an OpenAI-style `finish_reason` / Anthropic `stop_reason` string.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "end_turn" | "stop_sequence" | "stop" | "STOP" => Self::Stop,
            "tool_use" | "tool_calls" | "function_call" => Self::ToolUse,
            "max_tokens" | "length" | "MAX_TOKENS" => Self::Length,
            "refusal" | "content_filter" | "SAFETY" | "RECITATION" | "BLOCKLIST" => Self::Safety,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone)]
pub enum StreamEvent {
    TextStart,
    TextDelta(String),
    TextEnd,
    ReasoningStart,
    ReasoningDelta(String),
    ReasoningEnd,
    /// Anthropic extended-thinking signature (required to replay thinking blocks).
    ThinkingSignature(String),
    Continuation(agente_protocol::ProviderContinuation),
    ToolCallStart {
        name: String,
        id: String,
    },
    ToolCallDelta {
        id: String,
        args_delta: String,
    },
    ToolCallEnd {
        id: String,
    },
    Done {
        usage: Usage,
        stop_reason: StopReason,
    },
    Error(String),
}

/// A tool call being assembled from streamed deltas. `id` and `name` may
/// arrive in separate chunks on OpenAI-compatible servers; `started` tracks
/// whether the upstream accumulator has been told about the call.
#[derive(Default)]
pub struct PendingToolCall {
    pub id: String,
    pub name: String,
    pub args: String,
    pub started: bool,
}

/// Flush every pending tool call at end of stream: announce calls whose
/// `id`/`name` only completed late, then close them all so the agent loop's
/// accumulator never sees an orphaned `ToolCallEnd`.
pub(crate) async fn drain_pending_tool_calls(
    pending: &mut std::collections::HashMap<usize, PendingToolCall>,
    sender: &tokio::sync::mpsc::Sender<StreamEvent>,
) {
    for (_, call) in pending.drain() {
        if !call.started {
            if call.id.is_empty() || call.name.is_empty() {
                tracing::warn!(
                    name = %call.name,
                    "dropping incomplete streamed tool call at end of stream"
                );
                continue;
            }
            let _ = sender
                .send(StreamEvent::ToolCallStart {
                    name: call.name.clone(),
                    id: call.id.clone(),
                })
                .await;
        }
        let _ = sender.send(StreamEvent::ToolCallEnd { id: call.id }).await;
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveredModel {
    pub id: String,
    pub owned_by: Option<String>,
    pub context_window: Option<u32>,
}

#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn chat_completion(
        &self,
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        model: &str,
    ) -> Result<ChatResponse, LlmError>;

    async fn list_models(&self) -> Result<Vec<DiscoveredModel>, LlmError>;
}

pub struct ChatResponse {
    pub content: Option<String>,
    pub tool_calls: Option<Vec<ToolCall>>,
    pub usage: Usage,
}

#[derive(Debug, Clone, Default)]
pub struct Usage {
    /// Uncached input tokens. Adapters subtract cache hits when an API includes
    /// them in its prompt count, matching Messages' separate cache buckets.
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    /// Tokens served from the provider's prompt cache (Anthropic
    /// `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`,
    /// Gemini `cachedContentTokenCount`). Charged at a reduced rate (typically
    /// ~10% of `prompt_tokens`).
    pub cache_read_tokens: u32,
    /// Tokens written to the provider's prompt cache (Anthropic
    /// `cache_creation_input_tokens`). Charged at full price on first write.
    pub cache_creation_tokens: u32,
    /// Reported USD charge or subscription allowance consumed by this call.
    /// Preferred over a catalog-price estimate when present.
    pub cost_usd: Option<f64>,
    /// The reported amount is a provider estimate rather than measured spend.
    pub cost_estimated: bool,
}

impl Usage {
    /// Effective input tokens charged this turn: prompt + cache creation
    /// (full price) + cache read at `cache_read_price_ratio` of face value
    /// (default 10%).
    ///
    /// Use this for the status bar's "used" number so cached turns don't
    /// double-count against the model context window. The LLM transcript
    /// size (`estimate_message_tokens(&messages)`) is still the authoritative
    /// context-window measure — `effective_input_tokens` is the *cost* view.
    pub fn effective_input_tokens(&self, cache_read_price_ratio: f32) -> u32 {
        let cache_read_cost = (self.cache_read_tokens as f32 * cache_read_price_ratio) as u32;
        self.prompt_tokens
            .saturating_add(self.cache_creation_tokens)
            .saturating_add(cache_read_cost)
    }
}

pub async fn stream_chat_completion(
    api_base: &str,
    api_key: &str,
    messages: &[Message],
    tools: Option<&[ToolDefinition]>,
    model: &str,
    sender: Sender<StreamEvent>,
) -> Result<Usage, LlmError> {
    let client = Client::new();

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });

    if let Some(tools) = tools {
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

    let mut request = client
        .post(format!("{api_base}/chat/completions"))
        .header("Content-Type", "application/json");

    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }

    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|e| LlmError::HttpError(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let _ = sender
            .send(StreamEvent::Error(format!("HTTP {status}: {text}")))
            .await;
        return Err(LlmError::HttpError(format!("HTTP {status}: {text}")));
    }

    let mut stream = response.bytes_stream();
    let mut usage = Usage::default();
    let mut buffer = String::new();
    let mut stop_reason = StopReason::Unknown;
    let mut tool_calls_in_progress: std::collections::HashMap<usize, PendingToolCall> =
        std::collections::HashMap::new();

    let _ = sender.send(StreamEvent::TextStart).await;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| LlmError::StreamError(e.to_string()))?;
        let chunk_str = String::from_utf8_lossy(&chunk);
        buffer.push_str(&chunk_str);

        loop {
            let newline_pos = buffer.find('\n');
            if newline_pos.is_none() {
                break;
            }
            let line_end = newline_pos.unwrap();
            let line = buffer[..line_end].trim().to_string();
            buffer.drain(..line_end + 1);

            if line.is_empty() || line == "data: [DONE]" {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(choice) = json
                        .get("choices")
                        .and_then(|c| c.as_array())
                        .and_then(|a| a.first())
                    {
                        if let Some(delta) = choice.get("delta") {
                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                if !content.is_empty() {
                                    let _ = sender
                                        .send(StreamEvent::TextDelta(content.to_string()))
                                        .await;
                                }
                            }

                            if let Some(tool_calls) =
                                delta.get("tool_calls").and_then(|t| t.as_array())
                            {
                                for tc in tool_calls {
                                    let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0)
                                        as usize;
                                    let id = tc.get("id").and_then(|i| i.as_str()).unwrap_or("");
                                    let function = tc.get("function");
                                    let name = function
                                        .and_then(|f| f.get("name").and_then(|n| n.as_str()))
                                        .unwrap_or("");
                                    let args = function
                                        .and_then(|f| f.get("arguments").and_then(|a| a.as_str()))
                                        .unwrap_or("");

                                    // Same split-chunk tolerance as below: register
                                    // on first sight, patch id/name in as they arrive.
                                    let entry = tool_calls_in_progress.entry(idx).or_default();
                                    if !id.is_empty() && entry.id.is_empty() {
                                        entry.id = id.to_string();
                                    }
                                    if !name.is_empty() && entry.name.is_empty() {
                                        entry.name = name.to_string();
                                    }
                                    if !args.is_empty() {
                                        entry.args.push_str(args);
                                    }
                                    if !entry.started
                                        && !entry.id.is_empty()
                                        && !entry.name.is_empty()
                                    {
                                        entry.started = true;
                                        let _ = sender
                                            .send(StreamEvent::ToolCallStart {
                                                name: entry.name.clone(),
                                                id: entry.id.clone(),
                                            })
                                            .await;
                                    }
                                    if !args.is_empty() && entry.started {
                                        let _ = sender
                                            .send(StreamEvent::ToolCallDelta {
                                                id: entry.id.clone(),
                                                args_delta: args.to_string(),
                                            })
                                            .await;
                                    }
                                }
                            }

                            if let Some(reasoning) =
                                delta.get("reasoning_content").and_then(|r| r.as_str())
                            {
                                if !reasoning.is_empty() {
                                    let _ = sender
                                        .send(StreamEvent::ReasoningDelta(reasoning.to_string()))
                                        .await;
                                }
                            }
                        }

                        if let Some(reason) = choice.get("finish_reason").and_then(|f| f.as_str()) {
                            stop_reason = StopReason::parse(reason);
                            drain_pending_tool_calls(&mut tool_calls_in_progress, &sender).await;
                        }
                    }

                    if let Some(u) = json.get("usage") {
                        usage.prompt_tokens =
                            u.get("prompt_tokens").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
                        usage.completion_tokens = u
                            .get("completion_tokens")
                            .and_then(|c| c.as_u64())
                            .unwrap_or(0) as u32;
                        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
                        usage.cache_read_tokens = u
                            .get("prompt_tokens_details")
                            .and_then(|p| p.get("cached_tokens"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u32;
                    }
                }
            }
        }
    }

    drain_pending_tool_calls(&mut tool_calls_in_progress, &sender).await;

    let _ = sender.send(StreamEvent::TextEnd).await;
    let _ = sender
        .send(StreamEvent::Done {
            usage: usage.clone(),
            stop_reason,
        })
        .await;

    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_input_tokens_counts_cache_creation_full_and_read_reduced() {
        let usage = Usage {
            prompt_tokens: 1_000,
            completion_tokens: 200,
            total_tokens: 1_200,
            cache_read_tokens: 4_000,
            cache_creation_tokens: 2_000,
            cost_usd: None,
            cost_estimated: false,
        };
        // prompt + cache_creation (full) + 10% of cache_read
        let effective = usage.effective_input_tokens(0.1);
        assert_eq!(effective, 1_000 + 2_000 + 400);
    }

    #[test]
    fn effective_input_tokens_zero_cache_matches_prompt() {
        let usage = Usage {
            prompt_tokens: 500,
            completion_tokens: 100,
            total_tokens: 600,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost_usd: None,
            cost_estimated: false,
        };
        assert_eq!(usage.effective_input_tokens(0.1), 500);
    }

    #[test]
    fn effective_input_tokens_uses_saturating_math() {
        let usage = Usage {
            prompt_tokens: u32::MAX,
            cache_read_tokens: u32::MAX,
            cache_creation_tokens: u32::MAX,
            ..Default::default()
        };
        // Must not panic/overflow — result is capped at u32::MAX.
        let _ = usage.effective_input_tokens(0.1);
    }
}
