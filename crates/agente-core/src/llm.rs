use thiserror::Error;

#[derive(Error, Debug)]
pub enum LlmError {
    #[error("HTTP request failed: {0}")]
    HttpError(String),
    #[error("JSON parsing failed: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("LLM response missing content")]
    MissingContent,
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
    pending: &mut std::collections::BTreeMap<usize, PendingToolCall>,
    sender: &tokio::sync::mpsc::Sender<StreamEvent>,
) {
    for (_, call) in std::mem::take(pending) {
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
            if !call.args.is_empty() {
                let _ = sender
                    .send(StreamEvent::ToolCallDelta {
                        id: call.id.clone(),
                        args_delta: call.args,
                    })
                    .await;
            }
        }
        let _ = sender.send(StreamEvent::ToolCallEnd { id: call.id }).await;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drain_pending_tool_calls_is_ordered_and_emits_buffered_args() {
        let mut pending = std::collections::BTreeMap::new();
        pending.insert(
            2,
            PendingToolCall {
                id: "call-2".into(),
                name: "second".into(),
                args: "{\"b\":2}".into(),
                started: false,
            },
        );
        pending.insert(
            0,
            PendingToolCall {
                id: "call-0".into(),
                name: "first".into(),
                args: "{\"a\":1}".into(),
                started: false,
            },
        );
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        drain_pending_tool_calls(&mut pending, &tx).await;
        drop(tx);
        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        assert!(matches!(&events[0], StreamEvent::ToolCallStart { id, .. } if id == "call-0"));
        assert!(
            matches!(&events[1], StreamEvent::ToolCallDelta { id, args_delta } if id == "call-0" && args_delta == "{\"a\":1}")
        );
        assert!(matches!(&events[2], StreamEvent::ToolCallEnd { id } if id == "call-0"));
        assert!(matches!(&events[3], StreamEvent::ToolCallStart { id, .. } if id == "call-2"));
        assert!(
            matches!(&events[4], StreamEvent::ToolCallDelta { id, args_delta } if id == "call-2" && args_delta == "{\"b\":2}")
        );
        assert!(matches!(&events[5], StreamEvent::ToolCallEnd { id } if id == "call-2"));
    }
}
