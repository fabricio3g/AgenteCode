use super::ApiFormat;

/// Go's model list supplies IDs but not the protocol required to call each ID.
/// Keep this mapping in sync with https://opencode.ai/docs/go/#endpoints.
pub(super) fn format(model_id: &str) -> Option<ApiFormat> {
    match model_id {
        "grok-4.7"
        | "grok-4.6"
        | "gpt-6-luna"
        | "gpt-5.6-luna"
        | "muse-spark-1.3-contributor"
        | "muse-spark-1.2-contributor" => Some(ApiFormat::Responses),
        "minimax-m3" | "minimax-m2.7" | "minimax-m2.5" | "qwen3.8-max" | "qwen3.8-flash"
        | "qwen3.7-max" | "qwen3.7-plus" | "qwen3.6-plus" => Some(ApiFormat::Anthropic),
        "glm-5.3-flash"
        | "glm-5.3"
        | "glm-5.2"
        | "glm-5.1"
        | "kimi-k3"
        | "kimi-k2.7-code"
        | "kimi-k2.6"
        | "longcat-2.0"
        | "deepseek-v4.1-flash"
        | "deepseek-v4-pro"
        | "deepseek-v4-flash"
        | "deepseek-v4-flash-vision-exp"
        | "mimo-v2.6-flash"
        | "mimo-v2.6-pro"
        | "mimo-v2.5"
        | "mimo-v2.5-pro"
        | "hy4-preview"
        | "hy3"
        | "space-bunny-free" => Some(ApiFormat::OpenAI),
        _ => None,
    }
}
