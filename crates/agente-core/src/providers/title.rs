//! Lightweight, provider-backed session title generation.

use std::sync::Arc;
use std::time::Duration;

use crate::llm::LlmError;
use crate::providers::summarizer::complete_text;
use crate::providers::Provider;
use crate::providers::{ModelInfo, RequestContext};
use crate::types::{Message, Role};

const TITLE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CONTEXT_CHARS: usize = 2_000;
const MAX_TITLE_CHARS: usize = 60;

/// Generate a short title from the first completed exchange. This is a
/// deliberately separate no-tools request: it never mutates the main agent's
/// transcript or activity state.
pub async fn generate_session_title(
    provider: Arc<dyn Provider>,
    model: ModelInfo,
    user_text: &str,
    assistant_text: &str,
    context: RequestContext,
) -> Result<String, LlmError> {
    let user_text = truncate_chars(user_text.trim(), MAX_CONTEXT_CHARS);
    let assistant_text = truncate_chars(assistant_text.trim(), MAX_CONTEXT_CHARS);
    let messages = vec![
        Message {
            role: Role::System,
            content: "Create a concise title for this coding session. Return only the title, in the conversation's language, using 3 to 7 words. Do not use quotes, Markdown, labels, or ending punctuation.".to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
        Message {
            role: Role::User,
            content: format!(
                "User request:\n{user_text}\n\nAssistant response:\n{assistant_text}"
            ),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
    ];

    let raw = tokio::time::timeout(
        TITLE_TIMEOUT,
        complete_text(provider, model, &messages, context),
    )
    .await
    .map_err(|_| LlmError::StreamError("Session title generation timed out".to_string()))??;

    normalize_session_title(&raw).ok_or(LlmError::MissingContent)
}

/// Normalize provider output into a safe, stable one-line title.
pub fn normalize_session_title(raw: &str) -> Option<String> {
    let line = raw.lines().find(|line| !line.trim().is_empty())?.trim();
    let line = line.trim_start_matches('#').trim();
    let line = if line.to_ascii_lowercase().starts_with("title:") {
        line.get("title:".len()..).unwrap_or_default().trim()
    } else {
        line
    };
    let line = line
        .trim_matches(|c| matches!(c, '"' | '\'' | '`' | '*' | '_' | '~'))
        .trim();
    let line = line.trim_end_matches(['.', '!', '?', ':', ';']).trim();
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(truncate_chars(&collapsed, MAX_TITLE_CHARS))
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_model_wrapping() {
        assert_eq!(
            normalize_session_title("# Title: Improve session navigation\n").as_deref(),
            Some("Improve session navigation")
        );
        assert_eq!(
            normalize_session_title("Title:  `Fix   session tabs!`\nextra").as_deref(),
            Some("Fix session tabs")
        );
        assert_eq!(
            normalize_session_title("\"Improve Session Navigation\"").as_deref(),
            Some("Improve Session Navigation")
        );
        assert_eq!(
            normalize_session_title("**Polish Saved Sessions**").as_deref(),
            Some("Polish Saved Sessions")
        );
    }

    #[test]
    fn rejects_empty_and_caps_long_titles() {
        assert_eq!(normalize_session_title(" \n "), None);
        let title = normalize_session_title(&"x".repeat(100)).unwrap();
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
    }
}
