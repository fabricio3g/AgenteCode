//! Shared HTTP and option handling for provider transports.
use super::{ApiFormat, ModelInfo, ProviderInfo, RequestContext};
use crate::llm::{LlmError, StopReason, StreamEvent, Usage};
use crate::types::{Message, ProviderContinuation, Role};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;

/// Routing identity is a declarative provider policy, shared by every dialect.
/// Discovery has no conversation, so it uses a stable process identity.
pub(crate) fn session_header(
    info: &ProviderInfo,
    context: Option<RequestContext>,
) -> Option<(String, String)> {
    static PROCESS_SESSION: std::sync::OnceLock<uuid::Uuid> = std::sync::OnceLock::new();
    let name = info.transport_policy().cache.session_header?;
    if name.is_empty() {
        return None;
    }
    let session = context
        .map(|context| context.session_id)
        .filter(|id| !id.is_nil())
        .unwrap_or_else(|| *PROCESS_SESSION.get_or_init(uuid::Uuid::new_v4));
    Some((name, session.to_string()))
}

pub(crate) fn model_options(options: &HashMap<String, Value>) -> HashMap<String, Value> {
    let mut result = HashMap::new();
    if let Some(nested) = options.get("options").and_then(Value::as_object) {
        result.extend(nested.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    result.extend(
        options
            .iter()
            .filter(|(k, _)| k.as_str() != "options")
            .map(|(k, v)| (k.clone(), v.clone())),
    );
    for (alias, canonical) in [
        ("reasoningEffort", "reasoning_effort"),
        ("reasoningSummary", "reasoning_summary"),
        ("maxOutputTokens", "max_output_tokens"),
        ("enableThinking", "enable_thinking"),
    ] {
        if let Some(value) = result.remove(alias) {
            result.entry(canonical.into()).or_insert(value);
        }
    }
    if let Some(thinking) = result.get_mut("thinking").and_then(Value::as_object_mut) {
        if let Some(budget) = thinking.remove("budgetTokens") {
            thinking.entry("budget_tokens").or_insert(budget);
        }
    }
    result
}

pub(crate) fn wire_options(options: &HashMap<String, Value>) -> HashMap<String, Value> {
    let mut result = model_options(options);
    for control in [
        "max_tokens_field",
        "include_usage",
        "anthropic_thinking_mode",
        "thinking_format",
        "headers",
        "variants",
        "api_format",
        "npm",
        "provider",
        "cache_control",
    ] {
        result.remove(control);
    }
    result
}

pub(super) fn stream_error(provider: &str, value: &Value) -> LlmError {
    let raw = crate::util::redact_secrets(&format!("{provider}: {value}"));
    LlmError::StreamError(raw.chars().take(1500).collect())
}

pub(super) fn resolve_completion_url(
    info: &ProviderInfo,
    model: &ModelInfo,
    path: &str,
) -> Result<String, LlmError> {
    let base_url = if crate::config::provider_is_supported(&info.id) {
        info.resolve_base_url()
    } else {
        model
            .api
            .base_url
            .clone()
            .unwrap_or_else(|| info.resolve_base_url())
    };
    if super::canonical_provider_id(&info.id) == "opencode-go"
        && base_url.trim_end_matches('/') != "https://opencode.ai/zen/go/v1"
    {
        return Err(LlmError::HttpError(
            "OpenCode Go requires its official Go endpoint".into(),
        ));
    }
    Ok(super::join_url(
        &crate::util::expand_env_templates(&base_url),
        path,
    ))
}

pub(super) fn completion_request(
    info: &ProviderInfo,
    model: &ModelInfo,
    path: &str,
    body: &Value,
    context: RequestContext,
) -> Result<reqwest::RequestBuilder, LlmError> {
    let url = resolve_completion_url(info, model, path)?;
    tracing::info!(provider = %info.id, model = %model.api_id, session_id = %context.session_id, format = ?model.api.format.unwrap_or(info.api_format), path, "Sending provider HTTP request");
    let mut request = crate::util::http_client()
        .post(url)
        .header("Content-Type", "application/json");
    if let Some((name, session)) = session_header(info, Some(context)) {
        request = request.header(name, session);
    }
    let format = model.api.format.unwrap_or(info.api_format);
    if let Some(key) = info.resolve_api_key() {
        request = match format {
            ApiFormat::Anthropic => request.header("x-api-key", key),
            ApiFormat::Google => request.header("x-goog-api-key", key),
            _ => request.bearer_auth(key),
        };
    } else if !info.env_keys.is_empty() {
        return Err(LlmError::HttpError(format!(
            "{}: set {} to connect",
            info.name, info.env_keys[0]
        )));
    }
    if format == ApiFormat::Anthropic {
        request = request.header("anthropic-version", "2023-06-01");
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for (key, value) in info.headers.iter().chain(model.headers.iter()) {
        if crate::config::provider_is_supported(super::canonical_provider_id(&info.id))
            && (key.eq_ignore_ascii_case("authorization")
                || key.eq_ignore_ascii_case("x-api-key")
                || key.eq_ignore_ascii_case("x-goog-api-key")
                || info
                    .transport_policy()
                    .cache
                    .session_header
                    .as_ref()
                    .is_some_and(|name| key.eq_ignore_ascii_case(name))
                || key.eq_ignore_ascii_case("host"))
        {
            return Err(LlmError::HttpError(format!(
                "{}: authentication and session headers cannot be overridden",
                info.name
            )));
        }
        let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| LlmError::HttpError("Invalid configured header name".into()))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| LlmError::HttpError("Invalid configured header value".into()))?;
        headers.insert(name, value);
    }
    request = request.headers(headers);
    Ok(request.json(body))
}

/// Wire-level shape of one completion request: what went out, independent of
/// the transcript's contents. Logged per attempt so a slow first token can be
/// attributed to prompt size, tool schemas, caching or thinking instead of
/// guessed at.
pub(crate) struct RequestShape {
    pub prompt_bytes: usize,
    pub messages: usize,
    pub tool_count: usize,
    pub tools_bytes: usize,
    pub cache_markers: usize,
    pub prompt_cache_key: bool,
    pub thinking: String,
    pub max_tokens: Option<u64>,
}

impl RequestShape {
    pub(crate) fn of(body: &Value) -> Self {
        let prompt = body
            .get("messages")
            .or_else(|| body.get("input"))
            .or_else(|| body.get("contents"));
        let tools = body.get("tools").and_then(Value::as_array);
        Self {
            prompt_bytes: prompt.map_or(0, json_len),
            messages: prompt.and_then(Value::as_array).map_or(0, Vec::len),
            tool_count: tools.map_or(0, Vec::len),
            tools_bytes: tools.map_or(0, |tools| tools.iter().map(json_len).sum()),
            cache_markers: count_keys(body, "cache_control"),
            prompt_cache_key: body.get("prompt_cache_key").is_some(),
            thinking: thinking_label(body),
            max_tokens: ["max_tokens", "max_completion_tokens", "max_output_tokens"]
                .iter()
                .find_map(|key| body.get(*key).and_then(Value::as_u64))
                .or_else(|| {
                    body.get("generationConfig")
                        .and_then(|config| config.get("maxOutputTokens"))
                        .and_then(Value::as_u64)
                }),
        }
    }
}

fn json_len(value: &Value) -> usize {
    serde_json::to_string(value).map_or(0, |text| text.len())
}

/// Occurrences of `key` anywhere in the document (cache breakpoint markers).
fn count_keys(value: &Value, key: &str) -> usize {
    match value {
        Value::Object(map) => map
            .iter()
            .map(|(name, child)| usize::from(name == key) + count_keys(child, key))
            .sum(),
        Value::Array(items) => items.iter().map(|item| count_keys(item, key)).sum(),
        _ => 0,
    }
}

/// Compact `thinking` for the log: the level the wire actually carries, not the
/// level the UI offered. `none` means the request asked for no reasoning.
fn thinking_label(body: &Value) -> String {
    let budget = body
        .get("thinking")
        .and_then(|thinking| thinking.get("budget_tokens"))
        .or_else(|| {
            body.get("reasoning")
                .and_then(|value| value.get("max_tokens"))
        })
        .or_else(|| {
            body.get("generationConfig")
                .and_then(|config| config.get("thinkingConfig"))
                .and_then(|config| config.get("thinkingBudget"))
        })
        .and_then(Value::as_u64);
    if let Some(effort) = body
        .get("reasoning_effort")
        .or_else(|| {
            body.get("output_config")
                .and_then(|value| value.get("effort"))
        })
        .or_else(|| body.get("reasoning").and_then(|value| value.get("effort")))
        .or_else(|| body.get("thinking").and_then(|value| value.get("type")))
        .and_then(Value::as_str)
    {
        return match budget {
            Some(budget) => format!("{effort} budget={budget}"),
            None => effort.to_string(),
        };
    }
    if let Some(budget) = budget {
        return format!("budget={budget}");
    }
    if body.get("enable_thinking").and_then(Value::as_bool) == Some(false) {
        return "off".into();
    }
    if body.get("thinking").is_some()
        || body.get("reasoning").is_some()
        || body.get("enable_thinking").is_some()
        || body.get("chat_template_kwargs").is_some()
        || body
            .get("generationConfig")
            .and_then(|config| config.get("thinkingConfig"))
            .is_some()
    {
        return "on".into();
    }
    "none".into()
}

/// Keep machine-readable failure details until retry policy has been evaluated.
struct HttpFailure {
    error: LlmError,
    status: Option<reqwest::StatusCode>,
    details: Value,
}

impl From<LlmError> for HttpFailure {
    fn from(error: LlmError) -> Self {
        Self {
            error,
            status: None,
            details: Value::Null,
        }
    }
}

impl HttpFailure {
    fn rejects_cache_control(&self) -> bool {
        if !matches!(self.status.map(|s| s.as_u16()), Some(400 | 422)) {
            return false;
        }
        let error = self.details.get("error").unwrap_or(&self.details);
        let parameter = error
            .get("param")
            .or_else(|| error.get("parameter"))
            .and_then(Value::as_str);
        let code = error
            .get("code")
            .or_else(|| error.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .replace(['\"', '\'', '`'], "");
        if parameter == Some("cache_control")
            && (matches!(
                code,
                "unsupported_parameter" | "unsupported_parameter_error"
            ) || message.contains("not supported")
                || message.contains("unsupported"))
        {
            return true;
        }
        // A message-only gateway response must explicitly name the rejected parameter.
        let words: Vec<_> = message
            .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .filter(|word| !word.is_empty())
            .collect();
        words.windows(5).any(|words| {
            words == ["parameter", "cache_control", "is", "not", "supported"]
                || words == ["cache_control", "parameter", "is", "not", "supported"]
        }) || words
            .windows(3)
            .any(|words| words == ["unsupported", "parameter", "cache_control"])
    }
}

/// Bound a wait that has no natural end. `what` names the provider in the
/// failure, which is phrased like an SSE stall: a request that produced
/// nothing is what the retry policy treats as transient.
async fn deadline<T>(
    limit: std::time::Duration,
    what: &str,
    future: impl std::future::Future<Output = Result<T, LlmError>>,
) -> Result<T, LlmError> {
    match tokio::time::timeout(limit, future).await {
        Ok(result) => result,
        Err(_) => Err(LlmError::HttpError(format!(
            "{what}: stream stalled (no response headers for {}s)",
            limit.as_secs()
        ))),
    }
}

async fn send_http(
    info: &ProviderInfo,
    model: &ModelInfo,
    path: &str,
    body: &Value,
    context: RequestContext,
) -> Result<reqwest::Response, HttpFailure> {
    let resolved_url = resolve_completion_url(info, model, path)?;
    let request = completion_request(info, model, path, body, context)?;
    let shape = RequestShape::of(body);
    tracing::info!(
        provider = %info.id,
        model = %model.api_id,
        path,
        prompt_bytes = shape.prompt_bytes,
        messages = shape.messages,
        tool_count = shape.tool_count,
        tools_bytes = shape.tools_bytes,
        cache_markers = shape.cache_markers,
        prompt_cache_key = shape.prompt_cache_key,
        thinking = %shape.thinking,
        max_tokens = ?shape.max_tokens,
        "Provider request shape"
    );
    let started = std::time::Instant::now();
    // The client carries no overall timeout — a streamed answer may run for
    // minutes — which would leave a gateway that accepted the connection and
    // never answered holding the turn forever. Bound only the wait for the
    // response headers, at the idle timeout: a response that starts inside it
    // is never cut off, and a silent one becomes a retryable failure.
    // A local model server may hold its headers until it has read the prompt.
    let wait = if crate::util::is_local_endpoint(&resolved_url) {
        crate::util::local_first_byte_timeout()
    } else {
        crate::util::stream_idle_timeout()
    };
    let response = deadline(wait, &info.name, async {
        request
            .send()
            .await
            .map_err(|e| LlmError::HttpError(format!("{}: {e}", info.name)))
    })
    .await
    .map_err(HttpFailure::from)?;
    tracing::info!(provider = %info.id, model = %model.api_id, status = %response.status(), elapsed_ms = started.elapsed().as_millis(), "Provider HTTP response");
    if !response.status().is_success() {
        let status = response.status();
        let text = crate::util::redact_secrets(&response.text().await.unwrap_or_default());
        return Err(HttpFailure {
            error: LlmError::HttpError(format!(
                "{}: HTTP {status} - {}",
                info.name,
                text.chars().take(1500).collect::<String>()
            )),
            status: Some(status),
            details: serde_json::from_str(&text).unwrap_or(Value::String(text)),
        });
    }
    Ok(response)
}

pub(super) async fn send_request(
    info: &ProviderInfo,
    model: &ModelInfo,
    path: &str,
    body: &Value,
    context: RequestContext,
) -> Result<reqwest::Response, LlmError> {
    send_http(info, model, path, body, context)
        .await
        .map_err(|failure| failure.error)
}

pub(super) async fn send_with_cache_fallback(
    info: &ProviderInfo,
    model: &ModelInfo,
    path: &str,
    request: &super::cache::PreparedRequest,
    context: RequestContext,
) -> Result<reqwest::Response, LlmError> {
    match send_http(info, model, path, &request.body, context).await {
        Err(failure) if request.uncached.is_some() && failure.rejects_cache_control() => {
            tracing::warn!(provider = %info.id, model = %model.api_id, "Provider rejected cache_control; retrying original request without Agente annotations");
            send_request(
                info,
                model,
                path,
                request
                    .uncached
                    .as_ref()
                    .expect("guard checked uncached request"),
                context,
            )
            .await
        }
        result => result.map_err(|failure| failure.error),
    }
}

/// Replay native blocks only while their generic transcript projection still
/// matches. Compaction, tool repair, or a model switch must not resurrect stale
/// tool calls or invalid signed reasoning.
pub(super) fn replay_blocks(
    message: &Message,
    info: &ProviderInfo,
    model: &ModelInfo,
    protocol: &str,
) -> Option<Vec<Value>> {
    if message.role != Role::Assistant {
        return None;
    }
    let continuation = message.continuation.as_ref()?;
    if !continuation.matches(&info.id, &model.api_id) {
        return None;
    }
    if protocol == "chat" {
        if continuation.blocks.len() != 1 || continuation.blocks[0]["type"] != "chat_completion" {
            return None;
        }
        let native = &continuation.blocks[0]["message"];
        if native["content"].as_str().unwrap_or_default() != message.content {
            return None;
        }
        let calls: Vec<crate::types::ToolCall> = serde_json::from_value(
            native
                .get("tool_calls")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )
        .ok()?;
        if serde_json::to_value(&calls).ok()?
            != serde_json::to_value(message.tool_calls.as_deref().unwrap_or_default()).ok()?
        {
            return None;
        }
        return Some(continuation.blocks.clone());
    }
    let mut text = String::new();
    let mut calls = Vec::new();
    for block in &continuation.blocks {
        match (protocol, block["type"].as_str()) {
            ("responses", Some("message")) => {
                for part in block["content"].as_array()? {
                    if let Some(s) = part["text"].as_str().or_else(|| part["refusal"].as_str()) {
                        text.push_str(s);
                    }
                }
            }
            ("responses", Some("reasoning"))
            | ("messages", Some("thinking" | "redacted_thinking")) => {}
            ("responses", Some("function_call")) => calls.push((
                block["call_id"].as_str()?,
                block["name"].as_str()?,
                serde_json::from_str::<Value>(block["arguments"].as_str()?).ok()?,
            )),
            ("messages", Some("text")) => text.push_str(block["text"].as_str()?),
            ("messages", Some("tool_use")) => calls.push((
                block["id"].as_str()?,
                block["name"].as_str()?,
                block["input"].clone(),
            )),
            _ => return None,
        }
    }
    if text != message.content {
        return None;
    }
    let generic = message.tool_calls.as_deref().unwrap_or_default();
    if calls.len() != generic.len()
        || !calls.iter().zip(generic).all(|((id, name, args), call)| {
            *id == call.id
                && *name == call.function.name
                && serde_json::from_str::<Value>(&call.function.arguments)
                    .is_ok_and(|value| value == *args)
        })
    {
        return None;
    }
    Some(continuation.blocks.clone())
}

/// Generic tool output body for native Google functionResponse messages.
pub(super) fn tool_output(text: &str) -> Value {
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({"output": text}))
}

/// Look up a model by exact `id`/`api_id`, or by `provider_id/`-stripped /
/// `provider_id/`-prefixed form without stripping another vendor's prefix.
pub(super) fn find_model<'a>(
    models: &'a [ModelInfo],
    provider_id: &str,
    model_id: &str,
) -> Option<&'a ModelInfo> {
    models
        .iter()
        .find(|m| m.id == model_id || m.api_id == model_id)
        .or_else(|| {
            if let Some((prefix, bare)) = model_id.split_once('/') {
                if prefix != provider_id {
                    return None;
                }
                models.iter().find(|m| m.id == bare || m.api_id == bare)
            } else {
                let prefixed = format!("{provider_id}/{model_id}");
                models
                    .iter()
                    .find(|m| m.id == prefixed || m.api_id == prefixed)
            }
        })
}

/// Shared SSE JSON completion stream shell: wraps `EventStream`, sends
/// `TextStart`, applies the idle timeout, handles `[DONE]`, and decodes JSON.
pub(super) struct SseJsonStream<S> {
    stream: super::sse::EventStream<S>,
    idle: std::time::Duration,
    pub done_marker: bool,
}

impl<S, B, E> SseJsonStream<S>
where
    S: futures::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    pub(super) async fn next_json(&mut self) -> Result<Option<Value>, LlmError> {
        let Some(data) = self.stream.next_event(self.idle).await? else {
            return Ok(None);
        };
        if data == "[DONE]" {
            self.done_marker = true;
            return Ok(None);
        }
        Ok(Some(serde_json::from_str(&data)?))
    }
}

/// Open an SSE completion stream from `response` and emit `StreamEvent::TextStart`.
pub(super) async fn begin_sse_stream(
    response: reqwest::Response,
    sender: &Sender<StreamEvent>,
) -> SseJsonStream<impl futures::Stream<Item = Result<impl AsRef<[u8]>, reqwest::Error>> + Unpin> {
    let resolved_url = response.url().to_string();
    let stream = super::sse::EventStream::for_completion(response.bytes_stream(), &resolved_url);
    let _ = sender.send(StreamEvent::TextStart).await;
    SseJsonStream {
        stream,
        idle: crate::util::stream_idle_timeout(),
        done_marker: false,
    }
}

/// Finalize a completion stream: emit optional `Continuation`, `TextEnd`, and
/// `Done`, returning `usage`.
pub(super) async fn finish_sse_stream(
    info: &ProviderInfo,
    model: &ModelInfo,
    sender: &Sender<StreamEvent>,
    usage: Usage,
    stop_reason: StopReason,
    continuation_blocks: Vec<Value>,
) -> Result<Usage, LlmError> {
    if !continuation_blocks.is_empty() {
        let _ = sender
            .send(StreamEvent::Continuation(ProviderContinuation {
                provider_id: info.id.clone(),
                model_id: model.api_id.clone(),
                blocks: continuation_blocks,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_reads_an_openai_chat_body() {
        let body = json!({
            "model": "m",
            "messages": [
                {"role": "system", "content": [{"type": "text", "text": "hi", "cache_control": {"type": "ephemeral"}}]},
                {"role": "user", "content": "hello"}
            ],
            "tools": [{"type": "function", "function": {"name": "read_file"}}],
            "prompt_cache_key": "session",
            "reasoning_effort": "high",
            "max_completion_tokens": 8192,
            "stream": true,
        });
        let shape = RequestShape::of(&body);
        assert_eq!(shape.messages, 2);
        assert!(shape.prompt_bytes > 0);
        assert_eq!(shape.tool_count, 1);
        assert!(shape.tools_bytes > 0);
        assert_eq!(shape.cache_markers, 1);
        assert!(shape.prompt_cache_key);
        assert_eq!(shape.thinking, "high");
        assert_eq!(shape.max_tokens, Some(8_192));
    }

    #[test]
    fn shape_reads_responses_and_anthropic_bodies() {
        let responses = json!({"input": [{"role": "user"}], "max_output_tokens": 512});
        let shape = RequestShape::of(&responses);
        assert_eq!(shape.messages, 1);
        assert_eq!(shape.max_tokens, Some(512));
        assert_eq!(shape.thinking, "none");

        let anthropic = json!({
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "a", "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": "b", "cache_control": {"type": "ephemeral"}}
            ]}],
            "thinking": {"type": "enabled", "budget_tokens": 24_576},
            "max_tokens": 32_000,
        });
        let shape = RequestShape::of(&anthropic);
        assert_eq!(shape.cache_markers, 2);
        assert_eq!(shape.thinking, "enabled budget=24576");
        assert_eq!(shape.max_tokens, Some(32_000));
        assert!(!shape.prompt_cache_key);
    }

    #[test]
    fn thinking_label_names_off_and_google_budgets() {
        assert_eq!(
            thinking_label(&json!({"enable_thinking": false})),
            "off",
            "a disabled toggle is not 'on'"
        );
        assert_eq!(
            thinking_label(&json!({
                "generationConfig": {"thinkingConfig": {"thinkingBudget": 2048}}
            })),
            "budget=2048"
        );
        assert_eq!(thinking_label(&json!({"stream": true})), "none");
    }

    /// A gateway that accepts the connection and never answers must not hold
    /// the turn forever: the wait for response headers is bounded, and the
    /// failure is worded as a stall so the retry policy retries a request that
    /// produced nothing (`agent::channel::retry`).
    #[tokio::test]
    async fn a_silent_response_is_bounded_and_reads_as_a_stall() {
        let started = std::time::Instant::now();
        let error = deadline(std::time::Duration::from_millis(20), "Test", async {
            std::future::pending::<Result<reqwest::Response, LlmError>>().await
        })
        .await
        .expect_err("a silent response must fail");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the header wait was not bounded"
        );
        let message = error.to_string();
        assert!(message.contains("stream stalled"), "{message}");
        assert!(message.contains("no response headers"), "{message}");
    }

    /// A response that answers is passed through untouched, deadline or not.
    #[tokio::test]
    async fn an_answered_response_is_not_affected_by_the_bound() {
        let value = deadline(std::time::Duration::from_secs(30), "Test", async {
            Ok::<u32, LlmError>(7)
        })
        .await
        .expect("an answered call must pass through");
        assert_eq!(value, 7);
    }

    #[test]
    fn x_goog_api_key_header_override_is_rejected() {
        let mut info = ProviderInfo {
            id: "openrouter".into(),
            name: "OpenRouter".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            api_key: Some("secret".into()),
            ..Default::default()
        };
        info.headers
            .insert("x-goog-api-key".into(), "attacker".into());
        let model = super::super::fallback_model_info("openrouter", "test");
        let err = completion_request(
            &info,
            &model,
            "chat/completions",
            &json!({}),
            RequestContext::new(uuid::Uuid::new_v4()),
        )
        .unwrap_err();
        assert!(err.to_string().contains("cannot be overridden"), "{err}");
    }
}
