//! Semantic LLM summarization prompts, trait, and checkpoint builder.

use async_trait::async_trait;

use super::normalize::{
    carry_skills, compaction_boundary, normalize_tool_messages, repair_role_order,
};
use super::{CompactionResult, ContextCompactor, Summary, SummaryMetadata, SummaryType};
use crate::context::budget::estimate_message_tokens;
use crate::types::{Message, Role};

/// Error produced when LLM-based summarization fails.
#[derive(Debug, thiserror::Error)]
pub enum SummarizeError {
    #[error("LLM summarization failed: {0}")]
    Llm(String),
}

/// A summarizer produces a condensed representation of a set of messages.
///
/// This mirrors pi's compaction design: the compactor delegates summary
/// generation to an LLM through the provider/model layer instead of only
/// truncating messages heuristically.
#[async_trait]
pub trait Summarizer: Send + Sync {
    /// Summarize `messages` into a single summary string.
    ///
    /// `budget_tokens` is a soft upper bound on the summary size. When a
    /// previous summary exists (from an earlier compaction), `previous_summary`
    /// lets implementations produce an incremental update rather than
    /// regenerating from scratch.
    async fn summarize(
        &self,
        messages: &[Message],
        budget_tokens: usize,
        previous_summary: Option<&str>,
    ) -> Result<String, SummarizeError>;
}

/// System prompt used for context summarization (modeled on pi).
pub const SUMMARIZATION_SYSTEM_PROMPT: &str = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

/// Structured summarization prompt (modeled on pi's `SUMMARIZATION_PROMPT`).
pub const SUMMARIZATION_PROMPT: &str = r#"The conversation above needs to be summarized. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages."#;

/// Prompt for updating an existing summary with new messages (modeled on pi).
pub const UPDATE_SUMMARIZATION_PROMPT: &str = r#"The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages."#;

/// Serialize messages into a text representation suitable for summarization.
pub fn serialize_conversation(messages: &[Message]) -> String {
    let mut out = String::new();
    for m in messages {
        let role = match m.role {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        };
        out.push_str(&format!("<{}>\n{}\n</{}>\n", role, m.content, role));
        if let Some(tool_calls) = &m.tool_calls {
            for tc in tool_calls {
                out.push_str(&format!(
                    "<tool_call name=\"{}\">\n{}\n</tool_call>\n",
                    tc.function.name, tc.function.arguments
                ));
            }
        }
    }
    out
}

/// Build the LLM message list (system + user) used to summarize a conversation.
pub fn build_summarization_messages(
    messages: &[Message],
    previous_summary: Option<&str>,
) -> Vec<Message> {
    let conversation_text = serialize_conversation(messages);
    let mut prompt = format!("<conversation>\n{conversation_text}\n</conversation>\n\n");
    if let Some(prev) = previous_summary {
        prompt.push_str(&format!(
            "<previous-summary>\n{prev}\n</previous-summary>\n\n"
        ));
    }
    prompt.push_str(if previous_summary.is_some() {
        UPDATE_SUMMARIZATION_PROMPT
    } else {
        SUMMARIZATION_PROMPT
    });

    vec![
        Message {
            role: Role::System,
            content: SUMMARIZATION_SYSTEM_PROMPT.to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
        Message {
            role: Role::User,
            content: prompt,
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
    ]
}

/// Build a message that carries a compaction summary into the conversation:
/// a user-side context checkpoint, so the turn after the system prompt is a
/// user turn and an assistant turn kept from before still follows one.
pub(super) fn summary_message(content: &str) -> Message {
    Message {
        role: Role::User,
        content: format!("[Conversation summary]\n{content}"),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    }
}

impl ContextCompactor {
    /// Summarize older messages with the LLM, keep recent messages intact, and
    /// prepend a summary message. Leading system messages are always preserved.
    pub(super) async fn perform_semantic_compaction(
        &self,
        summarizer: &dyn Summarizer,
        messages: Vec<Message>,
        original_tokens: usize,
        original_count: usize,
    ) -> Result<CompactionResult, SummarizeError> {
        // Leading system messages (the system prompt) are never summarized away.
        let mut system_msgs = Vec::new();
        let mut summarize_start = 0;
        for (i, m) in messages.iter().enumerate() {
            if matches!(m.role, Role::System) {
                system_msgs.push(m.clone());
                summarize_start = i + 1;
            } else {
                break;
            }
        }

        let recent_start =
            compaction_boundary(&messages, self.strategy.keep_recent, summarize_start);

        let older: Vec<Message> = messages[summarize_start..recent_start].to_vec();
        if older.is_empty() {
            return Err(SummarizeError::Llm("Nothing to summarize".to_string()));
        }

        let recent: Vec<Message> = messages[recent_start..].to_vec();

        let retained_tokens =
            estimate_message_tokens(&system_msgs).saturating_add(estimate_message_tokens(&recent));
        let summary_budget = self.strategy.summary_budget(retained_tokens);
        if summary_budget == 0 {
            return Err(SummarizeError::Llm(
                "Retained context leaves no summary budget".into(),
            ));
        }
        let summary_text = summarizer.summarize(&older, summary_budget, None).await?;
        if summary_text.trim().is_empty() {
            return Err(SummarizeError::Llm("Empty summary from model".into()));
        }

        let mut result = system_msgs;
        result.push(summary_message(&summary_text));
        result.extend(recent);
        result = repair_role_order(carry_skills(&messages, normalize_tool_messages(result)));

        let compressed_tokens = estimate_message_tokens(&result);
        let tokens_saved = original_tokens.saturating_sub(compressed_tokens);

        let summary = Summary {
            content: summary_text,
            tokens_saved,
            metadata: SummaryMetadata {
                original_message_count: original_count,
                original_tokens,
                compressed_tokens,
                tokens_saved,
                timestamp: chrono::Utc::now(),
                summary_type: SummaryType::Semantic,
            },
        };

        Ok(CompactionResult {
            messages: result,
            summary,
        })
    }
}
