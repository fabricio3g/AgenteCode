//! Prompt-cache plumbing shared by the wire formats.
//!
//! Two halves:
//! - **Breakpoints.** OpenAI, DeepSeek, GLM and most OpenAI-compatible APIs
//!   cache a stable prefix automatically. Anthropic-style endpoints (Claude,
//!   MiniMax's Anthropic API) and OpenRouter's Claude/Gemini routes cache
//!   only what carries `cache_control`, so those requests mark the system
//!   prompt plus a rolling breakpoint on the two newest user turns — the
//!   prefix grows turn by turn and every call reuses the previous one.
//! - **Usage.** Providers report cache hits under different names; they all
//!   land in `Usage::cache_read_tokens` / `cache_creation_tokens`.
//!
//! A model option `"cache_control": true|false` forces breakpoints on/off.

use serde_json::{json, Value};

use super::ModelInfo;

/// Whether a request should carry explicit `cache_control` breakpoints.
pub(crate) fn wants_breakpoints(
    anthropic_format: bool,
    provider_id: &str,
    model: &ModelInfo,
) -> bool {
    let provider_id = super::canonical_provider_id(provider_id);
    if let Some(forced) = model.options.get("cache_control").and_then(Value::as_bool) {
        return forced;
    }
    if anthropic_format {
        return true;
    }
    let id = model.api_id.to_ascii_lowercase();
    // OpenCode Go honors breakpoints on the models it can cache; without
    // them (and a `prompt_cache_key`) its gateway never engages the cache.
    provider_id == "opencode-go"
        || (provider_id == "openrouter"
            && (id.starts_with("anthropic/") || id.starts_with("google/gemini")))
}

/// Session-scoped `prompt_cache_key` for gateways that only reuse a cached
/// prefix when told which session a request belongs to (OpenCode Go). An
/// explicit model option wins.
pub(crate) fn prompt_cache_key(
    provider_id: &str,
    model: &ModelInfo,
    session_id: uuid::Uuid,
) -> Option<String> {
    let provider_id = super::canonical_provider_id(provider_id);
    (provider_id == "opencode-go" && !model.options.contains_key("prompt_cache_key"))
        .then(|| session_id.to_string())
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
                last["cache_control"] = ephemeral();
            }
        }
        _ => {}
    }
}

/// Rolling breakpoints: mark the two newest `user` messages (tool results
/// travel as user turns in the Anthropic format). With the system marker
/// that is three of the four breakpoints Anthropic allows.
pub(crate) fn mark_recent_user_turns(messages: &mut [Value]) {
    let mut marked = 0;
    for message in messages.iter_mut().rev() {
        if message["role"] == "user" && !is_empty_content(&message["content"]) {
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
}
