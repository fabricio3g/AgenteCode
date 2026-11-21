//! Prompt-cache plumbing shared by the wire formats.
//!
//! Two halves:
//! - **Breakpoints.** Shared transport metadata decides whether to annotate
//!   the system prompt and the two newest user turns. Protocol defaults and
//!   documented provider rules are configurable, as is the session cache key.
//! - **Usage.** Providers report cache hits under different names; they all
//!   land in `Usage::cache_read_tokens` / `cache_creation_tokens`.
//!
//! A model option `"cache_control": true|false` forces breakpoints on/off.
//! Fallback resends the retained original request, including user annotations.

use serde_json::{json, Value};

use super::ModelInfo;

/// Whether the resolved transport policy enables explicit annotations.
pub(crate) fn wants_breakpoints(
    format: super::ApiFormat,
    info: &super::ProviderInfo,
    model: &ModelInfo,
) -> bool {
    info.transport_policy().breakpoints(format, model)
}

/// Whether the wire format accepts top-level OpenAI-style `prompt_cache_key`.
/// Anthropic Messages and Google generateContent reject unknown top-level
/// fields with HTTP 400.
pub(crate) fn supports_prompt_cache_key(format: super::ApiFormat) -> bool {
    matches!(
        format,
        super::ApiFormat::OpenAI | super::ApiFormat::Responses
    )
}

pub(crate) fn prompt_cache_key(
    format: super::ApiFormat,
    info: &super::ProviderInfo,
    model: &ModelInfo,
    session_id: uuid::Uuid,
) -> Option<String> {
    (supports_prompt_cache_key(format)
        && info.transport_policy().cache.prompt_cache_key == Some(true)
        && !super::model_options(&model.options).contains_key("prompt_cache_key"))
    .then(|| session_id.to_string())
}

/// Retain the complete original request. Only the copy gets Agente's markers.
/// A retry never walks arbitrary JSON or changes the original content shapes.
pub(crate) struct PreparedRequest {
    pub body: Value,
    pub uncached: Option<Value>,
}

impl PreparedRequest {
    pub fn new(
        original: Value,
        format: super::ApiFormat,
        info: &super::ProviderInfo,
        model: &ModelInfo,
    ) -> Self {
        if !wants_breakpoints(format, info, model) {
            return Self {
                body: original,
                uncached: None,
            };
        }
        let mut body = original.clone();
        match format {
            super::ApiFormat::Anthropic => {
                if let Some(system) = body
                    .get_mut("system")
                    .filter(|system| !is_empty_content(system))
                {
                    let mut message = json!({"content": system});
                    mark_last_block(&mut message);
                    *system = message["content"].take();
                }
            }
            super::ApiFormat::OpenAI => {
                if let Some(messages) = body["messages"].as_array_mut() {
                    if let Some(system) = messages.iter_mut().find(|m| m["role"] == "system") {
                        mark_last_block(system);
                    }
                }
            }
            _ => {}
        }
        if matches!(
            format,
            super::ApiFormat::OpenAI | super::ApiFormat::Anthropic
        ) {
            if let Some(messages) = body["messages"].as_array_mut() {
                mark_recent_user_turns(messages);
            }
        }
        let uncached = (body != original).then_some(original);
        Self { body, uncached }
    }
}

fn ephemeral() -> Value {
    json!({"type": "ephemeral"})
}

/// Mark the last content block of a message. String content becomes a single
/// text part so it can carry the marker.
pub(crate) fn mark_last_block(message: &mut Value) {
    match &mut message["content"] {
        Value::String(text) => {
            let text = std::mem::take(text);
            message["content"] =
                json!([{"type": "text", "text": text, "cache_control": ephemeral()}]);
        }
        Value::Array(blocks) => {
            if let Some(last) = blocks.last_mut().filter(|b| b.is_object()) {
                if last.get("cache_control").is_none() {
                    last["cache_control"] = ephemeral();
                }
            }
        }
        _ => {}
    }
}

/// Rolling breakpoints: mark the two newest `user` or `tool` messages (tool
/// results travel as user turns in the Anthropic format and as `tool` turns
/// in OpenAI chat, where a tool loop would otherwise never move its cache
/// point past the first prompt). With the system marker that is three of the
/// four breakpoints Anthropic allows.
pub(crate) fn mark_recent_user_turns(messages: &mut [Value]) {
    let mut marked = 0;
    for message in messages.iter_mut().rev() {
        let role = &message["role"];
        if (role == "user" || role == "tool") && !is_empty_content(&message["content"]) {
            mark_last_block(message);
            marked += 1;
            if marked == 2 {
                break;
            }
        }
    }
}

fn is_empty_content(content: &Value) -> bool {
    match content {
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        _ => true,
    }
}

/// `(cache_read, cache_write)` from an OpenAI-style `usage` object, across
/// dialects: `prompt_tokens_details.cached_tokens` (OpenAI, GLM, OpenRouter,
/// Kimi), `prompt_cache_hit_tokens` (DeepSeek), `cache_write_tokens` /
/// `cache_creation_input_tokens` (OpenRouter, Anthropic-backed proxies).
pub(crate) fn openai_usage_cache(usage: &Value) -> (u32, u32) {
    // Largest of the reported fields: gateways (OpenCode Go) return several
    // dialects at once, and a present-but-zero OpenAI field must not hide a
    // real DeepSeek `prompt_cache_hit_tokens`.
    let first = |paths: &[&[&str]]| -> u32 {
        paths
            .iter()
            .filter_map(|path| {
                path.iter()
                    .try_fold(usage, |value, key| value.get(*key))
                    .and_then(Value::as_u64)
            })
            .max()
            .unwrap_or(0) as u32
    };
    let read = first(&[
        &["prompt_tokens_details", "cached_tokens"],
        &["prompt_cache_hit_tokens"],
        &["cache_read_input_tokens"],
    ]);
    let write = first(&[
        &["prompt_tokens_details", "cache_write_tokens"],
        &["cache_creation_input_tokens"],
    ]);
    (read, write)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_and_openai_dialects_both_report_hits() {
        let deepseek = json!({"prompt_tokens": 100, "prompt_cache_hit_tokens": 80, "prompt_cache_miss_tokens": 20});
        assert_eq!(openai_usage_cache(&deepseek), (80, 0));
        let openai = json!({"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 64}});
        assert_eq!(openai_usage_cache(&openai), (64, 0));
        let openrouter =
            json!({"prompt_tokens_details": {"cached_tokens": 10, "cache_write_tokens": 90}});
        assert_eq!(openai_usage_cache(&openrouter), (10, 90));
        assert_eq!(openai_usage_cache(&json!({"prompt_tokens": 5})), (0, 0));
        // Mixed dialects (OpenCode Go): the real hit wins over a zero field.
        let mixed =
            json!({"prompt_cache_hit_tokens": 70, "prompt_tokens_details": {"cached_tokens": 0}});
        assert_eq!(openai_usage_cache(&mixed), (70, 0));
    }

    #[test]
    fn rolling_breakpoints_mark_the_two_newest_user_turns() {
        let mut messages = vec![
            json!({"role": "user", "content": "one"}),
            json!({"role": "assistant", "content": "a"}),
            json!({"role": "user", "content": [{"type": "tool_result", "content": "r"}]}),
            json!({"role": "assistant", "content": "b"}),
            json!({"role": "user", "content": "three"}),
        ];
        mark_recent_user_turns(&mut messages);
        assert!(messages[0]["content"].is_string(), "oldest turn untouched");
        assert_eq!(
            messages[2]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert_eq!(messages[4]["content"][0]["text"], "three");
        assert_eq!(
            messages[4]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert!(
            messages[3]["content"].is_string(),
            "assistant turns untouched"
        );
    }

    #[test]
    fn rolling_breakpoints_follow_openai_tool_results() {
        let mut messages = vec![
            json!({"role": "user", "content": "task"}),
            json!({"role": "assistant", "content": "", "tool_calls": []}),
            json!({"role": "tool", "tool_call_id": "a", "content": "first"}),
            json!({"role": "assistant", "content": "", "tool_calls": []}),
            json!({"role": "tool", "tool_call_id": "b", "content": "second"}),
        ];
        mark_recent_user_turns(&mut messages);
        assert!(messages[0]["content"].is_string(), "older prompt untouched");
        for i in [2, 4] {
            assert_eq!(
                messages[i]["content"][0]["cache_control"]["type"],
                "ephemeral"
            );
        }
        assert_eq!(messages[4]["tool_call_id"], "b");
    }
}
