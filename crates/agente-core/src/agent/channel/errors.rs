//! Error classification shared by the agent loop and the discovery task.
//!
//! Providers stringify their failures as `"{name} ({url}): HTTP {status} - {body}"`
//! before the error reaches here, so classification prefers the status code
//! carried in that shape. Substring matching is the fallback for transport
//! errors that genuinely have no status — and it is word-aware, because a bare
//! `contains("rate")` fires on the word "generated" and reported ordinary model
//! output to the user as a rate limit.

/// The HTTP status a provider embedded in its error text, if any.
///
/// Matches `HTTP <3 digits>` case-insensitively. Anything else — a model id
/// containing digits, a token count, a URL with a port — is not a status and
/// must not be read as one.
pub(crate) fn http_status(raw: &str) -> Option<u16> {
    // Scan raw bytes directly. Indexing `raw` with offsets found in
    // `raw.to_lowercase()` is unsound: Unicode lowercasing can change byte
    // lengths (e.g. `İ` → `i̇`), moving the offset onto a char boundary that
    // does not exist in `raw`.
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        if bytes[i..i + 4].eq_ignore_ascii_case(b"http") {
            let mut j = i + 4;
            while j < bytes.len() && matches!(bytes[j], b' ' | b':' | b'/' | b'=') {
                j += 1;
            }
            let mut digits = 0u32;
            let mut value = 0u32;
            while j < bytes.len() && bytes[j].is_ascii_digit() && digits < 4 {
                value = value * 10 + u32::from(bytes[j] - b'0');
                digits += 1;
                j += 1;
            }
            if digits == 3 && (100..600).contains(&value) {
                return Some(value as u16);
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

/// True when `needle` appears in `haystack` as a whole word.
///
/// `contains_word("content was not generated", "rate")` is false; a plain
/// `contains` is true, which is how "generated" became "Rate limited".
pub(crate) fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let is_boundary = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric() && c != '_');
    let mut from = 0;
    while let Some(offset) = haystack[from..].find(needle) {
        let start = from + offset;
        let end = start + needle.len();
        let before = haystack[..start].chars().next_back();
        let after = haystack[end..].chars().next();
        if is_boundary(before) && is_boundary(after) {
            return true;
        }
        from = start + needle.len();
    }
    false
}

/// True when a provider failure means the request exceeded the model's
/// context window. The agent loop compacts and retries these instead of
/// failing the turn; keep the patterns in sync with the context branch of
/// [`categorize_error`] below.
pub(crate) fn is_context_overflow_error(raw: &str) -> bool {
    let lower = raw.to_lowercase();
    // Provider-shaped codes and phrases (`context_length_exceeded`, "exceeds
    // this model's context length of N tokens").
    lower.contains("context_length")
        || lower.contains("context length")
        || lower.contains("maximum context")
        || lower.contains("too many tokens")
        || lower.contains("prompt is too long")
        || (lower.contains("context")
            && (lower.contains("overflow")
                || lower.contains("too long")
                || lower.contains("too large")
                || lower.contains("max_tokens")
                || lower.contains("exceed")))
}

/// Map a raw provider/transport error to a short, actionable user message.
pub(crate) fn categorize_error(raw: &str, provider: &str, model: &str) -> String {
    let lower = raw.to_lowercase();

    // Context overflow arrives under several statuses (400, 413, sometimes a
    // 200 with an error body), so the text check runs first and wins.
    if is_context_overflow_error(raw) || lower.contains("413") {
        return format!(
            "Context window exceeded. The conversation is too long for {provider} \
             (model: {model}). Try /compact to reduce context."
        );
    }

    // A status the provider actually reported is authoritative.
    if let Some(status) = http_status(raw) {
        return match status {
            401 | 407 => format!(
                "API key invalid for {provider}. Check your API key and reconnect with /provider."
            ),
            403 => format!(
                "Access denied for {provider} (model: {model}). This model may require a paid \
                 plan or special access."
            ),
            404 => format!(
                "Model '{model}' not found for {provider}. Try /model to select a different model."
            ),
            413 => format!(
                "Context window exceeded. The conversation is too long for {provider} \
                 (model: {model}). Try /compact to reduce context."
            ),
            429 => format!("Rate limited by {provider}. Wait a moment and try again."),
            400 | 422 => format!(
                "Request rejected by {provider}. The model '{model}' may not support this \
                 feature. Details: {raw}"
            ),
            408 | 504 => {
                format!("Request to {provider} timed out. The service may be slow or unreachable.")
            }
            500..=599 => {
                format!("{provider} is experiencing issues. Wait a moment and try again.")
            }
            _ => format!("Error from {provider}: {raw}"),
        };
    }

    // No status: transport-level or provider-worded failure.
    if lower.contains("unauthorized")
        || lower.contains("invalid api key")
        || lower.contains("invalid x-api-key")
        || lower.contains("authentication")
    {
        format!("API key invalid for {provider}. Check your API key and reconnect with /provider.")
    } else if lower.contains("forbidden") {
        format!(
            "Access denied for {provider} (model: {model}). This model may require a paid plan \
             or special access."
        )
    } else if lower.contains("not found") {
        format!("Model '{model}' not found for {provider}. Try /model to select a different model.")
    } else if lower.contains("rate limit") || lower.contains("rate_limit") {
        format!("Rate limited by {provider}. Wait a moment and try again.")
    } else if lower.contains("overloaded") {
        format!("{provider} is experiencing issues. Wait a moment and try again.")
    } else if lower.contains("invalid params")
        || lower.contains("invalid parameters")
        || lower.contains("bad request")
    {
        format!(
            "Request rejected by {provider}. The model '{model}' may not support this feature. \
             Details: {raw}"
        )
    } else if lower.contains("timeout") || lower.contains("timed out") {
        format!("Request to {provider} timed out. The service may be slow or unreachable.")
    } else {
        format!("Error from {provider}: {raw}")
    }
}

/// Rewrite a model-discovery failure into a user-actionable hint.
pub(crate) fn sanitize_discovery_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("/models") || lower.contains("get ") || lower.contains("request") {
        "Could not load models for this provider. Check the API key or select a built-in model."
            .to_string()
    } else {
        raw.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_read_from_the_provider_error_shape() {
        assert_eq!(
            http_status("OpenAI (https://api.openai.com/v1): HTTP 429 - slow down"),
            Some(429)
        );
        assert_eq!(http_status("HTTP 500: upstream failure"), Some(500));
        assert_eq!(http_status("http/404 not found"), Some(404));
    }

    #[test]
    fn digits_that_are_not_a_status_are_not_read_as_one() {
        // A model id, a token count and a port must not become status codes.
        assert_eq!(http_status("model 'gpt-500-turbo' is retired"), None);
        assert_eq!(http_status("prompt is 429 tokens over the limit"), None);
        assert_eq!(http_status("connect to localhost:8080 failed"), None);
        assert_eq!(http_status("HTTP 99 nonsense"), None);
    }

    /// Unicode whose lowercase form has a different byte length (İ → i̇) must
    /// not make the status scan index `raw` with an offset from `to_lowercase`.
    #[test]
    fn unicode_before_http_does_not_break_the_scan() {
        assert_eq!(http_status("İstanbul gateway: HTTP 429"), Some(429));
        assert_eq!(http_status("ẞ provider returned HTTP 503"), Some(503));
        assert_eq!(http_status("ünïcödé only"), None);
    }

    /// The regression this module exists for: `contains("rate")` matched the
    /// word "generated", so any provider message mentioning generated content
    /// was shown to the user as "Rate limited".
    #[test]
    fn generated_is_not_a_rate_limit() {
        for raw in [
            "content was not generated",
            "the response was moderated",
            "token count was not accurate",
        ] {
            let msg = categorize_error(raw, "openai", "gpt-4o");
            assert!(
                !msg.contains("Rate limited"),
                "{raw:?} must not classify as a rate limit, got {msg:?}"
            );
        }
        assert!(contains_word("hit the rate limit", "rate"));
        assert!(!contains_word("content was not generated", "rate"));
    }

    #[test]
    fn status_codes_drive_the_message() {
        let at = |raw: &str| categorize_error(raw, "openai", "gpt-4o");
        assert!(at("x: HTTP 401 - bad key").contains("API key invalid"));
        assert!(at("x: HTTP 404 - no such model").contains("not found"));
        assert!(at("x: HTTP 429 - slow down").contains("Rate limited"));
        assert!(at("x: HTTP 503 - unavailable").contains("experiencing issues"));
        assert!(at("x: HTTP 413 - too big").contains("Context window exceeded"));
    }

    /// A provider-side context rejection must read as context overflow even
    /// when it arrives as HTTP 400: otherwise the user is told the model
    /// "may not support this feature" and the loop cannot recover.
    #[test]
    fn openrouter_context_rejection_classifies_as_overflow() {
        let raw = "Stream error: HTTP request failed: OpenRouter: HTTP 400 Bad Request - \
            {\"error\":{\"message\":\"Provider returned error\",\"code\":400,\"metadata\":\
            {\"raw\":\"{\\\"error\\\":{\\\"message\\\":\\\"The request is 265713 tokens long \
            and exceeds this model's context length of 262144 tokens.\\\",\\\"type\\\":\
            \\\"invalid_request_error\\\",\\\"param\\\":\\\"\\\",\\\"code\\\":\
            \\\"context_length_exceeded\\\"}}\",\"provider_name\":\"Nex AGI\"}}}";
        assert!(is_context_overflow_error(raw));
        let msg = categorize_error(raw, "openrouter", "nex-n2.5-mini:free");
        assert!(
            msg.contains("Context window exceeded"),
            "overflow must not read as an unsupported feature, got {msg:?}"
        );
        assert!(msg.contains("/compact"));
    }

    #[test]
    fn overflow_phrasings_are_recognized() {
        for raw in [
            "context_length_exceeded",
            "Maximum context length exceeded",
            "prompt is too long: 200k tokens",
            "Too many tokens in request",
            "input exceeds the context window",
        ] {
            assert!(is_context_overflow_error(raw), "{raw:?}");
        }
        assert!(!is_context_overflow_error("model refused to answer"));
        assert!(!is_context_overflow_error(
            "content was not generated due to a filter"
        ));
    }

    /// A transport failure with no status still has to be classified by text.
    #[test]
    fn textual_fallback_still_classifies_transport_errors() {
        let at = |raw: &str| categorize_error(raw, "openai", "gpt-4o");
        assert!(at("connection timed out").contains("timed out"));
        assert!(at("invalid api key supplied").contains("API key invalid"));
        assert!(at("server overloaded, retry").contains("experiencing issues"));
    }
}
