//! Shared HTTP and option handling for provider transports.
use super::{ApiFormat, ModelInfo, ProviderInfo};
use crate::llm::LlmError;
use crate::types::{Message, Role};
use serde_json::{json, Value};
use std::collections::HashMap;

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
    ] {
        result.remove(control);
    }
    result
}

pub(super) fn stream_error(provider: &str, value: &Value) -> LlmError {
    let raw = crate::util::redact_secrets(&format!("{provider}: {value}"));
    LlmError::StreamError(raw.chars().take(1500).collect())
}

pub(super) async fn send_request(
    info: &ProviderInfo,
    model: &ModelInfo,
    path: &str,
    body: &Value,
) -> Result<reqwest::Response, LlmError> {
    let base_url = model
        .api
        .base_url
        .clone()
        .unwrap_or_else(|| info.resolve_base_url());
    let url = super::join_url(&crate::util::expand_env_templates(&base_url), path);
    let mut request = crate::util::http_client()
        .post(url)
        .header("Content-Type", "application/json");
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
        let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| LlmError::HttpError("Invalid configured header name".into()))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| LlmError::HttpError("Invalid configured header value".into()))?;
        headers.insert(name, value);
    }
    request = request.headers(headers);
    let response = request
        .json(body)
        .send()
        .await
        .map_err(|e| LlmError::HttpError(format!("{}: {e}", info.name)))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = crate::util::redact_secrets(&response.text().await.unwrap_or_default());
        return Err(LlmError::HttpError(format!(
            "{}: HTTP {status} - {}",
            info.name,
            text.chars().take(1500).collect::<String>()
        )));
    }
    Ok(response)
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
