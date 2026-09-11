//! Enhanced context compaction with semantic summarization
//!
//! This module provides intelligent context management for LLM conversations:
//! - Semantic summarization of old messages
//! - Configurable compaction strategies
//! - Metadata tracking for compressed content

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::llm::{LlmClient, LlmError};
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
        },
        Message {
            role: Role::User,
            content: prompt,
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
        },
    ]
}

/// An LLM-backed summarizer using the project's OpenAI-compatible client.
pub struct LlmSummarizer {
    client: Arc<dyn LlmClient>,
    model: String,
}

impl LlmSummarizer {
    /// Create a summarizer that uses `client` with `model` for completions.
    pub fn new(client: Arc<dyn LlmClient>, model: impl Into<String>) -> Self {
        Self {
            client,
            model: model.into(),
        }
    }
}

#[async_trait]
impl Summarizer for LlmSummarizer {
    async fn summarize(
        &self,
        messages: &[Message],
        _budget_tokens: usize,
        previous_summary: Option<&str>,
    ) -> Result<String, SummarizeError> {
        let llm_messages = build_summarization_messages(messages, previous_summary);
        let response = self
            .client
            .chat_completion(&llm_messages, None, &self.model)
            .await
            .map_err(|e: LlmError| SummarizeError::Llm(e.to_string()))?;
        response
            .content
            .ok_or_else(|| SummarizeError::Llm("Empty summary from model".to_string()))
    }
}

/// Strategy for context compaction
#[derive(Debug, Clone)]
pub struct CompactionStrategy {
    /// Maximum allowed tokens in the context
    pub max_tokens: usize,
    /// Always keep the last N messages untouched
    pub keep_recent: usize,
    /// Compact when context reaches this percentage of max_tokens (0.0-1.0)
    pub summarize_threshold: f32,
    /// Target reduction ratio when compacting (0.0-1.0)
    /// e.g., 0.7 means reduce to 70% of original size
    pub target_reduction: f32,
    /// Tokens reserved for the summary prompt and its output (pi-style).
    pub reserve_tokens: usize,
    /// Approximate recent-context tokens to keep after compaction (pi-style).
    pub keep_recent_tokens: usize,
}

impl Default for CompactionStrategy {
    fn default() -> Self {
        Self {
            max_tokens: 128_000,        // Common for many models
            keep_recent: 8,             // Keep last 8 messages
            summarize_threshold: 0.85,  // Compact at 85% of limit
            target_reduction: 0.6,      // Reduce to 60% when compacting
            reserve_tokens: 16_384,     // Room for summary prompt + output
            keep_recent_tokens: 20_000, // Approx recent context kept
        }
    }
}

impl CompactionStrategy {
    /// Create a new compaction strategy
    pub fn new(max_tokens: usize, keep_recent: usize, summarize_threshold: f32) -> Self {
        Self {
            max_tokens,
            keep_recent,
            summarize_threshold,
            target_reduction: 0.6,
            reserve_tokens: 16_384,
            keep_recent_tokens: 20_000,
        }
    }

    /// Create a strategy for smaller context windows
    pub fn small_context() -> Self {
        Self {
            max_tokens: 32_000,
            keep_recent: 6,
            summarize_threshold: 0.8,
            target_reduction: 0.5,
            reserve_tokens: 8_192,
            keep_recent_tokens: 8_000,
        }
    }

    /// Create a strategy for large context windows
    pub fn large_context() -> Self {
        Self {
            max_tokens: 200_000,
            keep_recent: 12,
            summarize_threshold: 0.9,
            target_reduction: 0.7,
            reserve_tokens: 24_576,
            keep_recent_tokens: 32_000,
        }
    }

    /// Check if compaction should be triggered
    pub fn should_compact(&self, current_tokens: usize) -> bool {
        current_tokens as f32 > (self.max_tokens as f32 * self.summarize_threshold)
    }

    /// Calculate the target token count after compaction
    pub fn target_tokens(&self) -> usize {
        (self.max_tokens as f32 * self.target_reduction) as usize
    }

    /// Summary output must fit beside the system prompt and retained turns.
    pub fn summary_budget(&self, retained_tokens: usize) -> usize {
        self.reserve_tokens
            .min(self.target_tokens().saturating_sub(retained_tokens))
    }
}

/// Summary metadata for compressed content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryMetadata {
    /// Original message count before summarization
    pub original_message_count: usize,
    /// Original token count (estimated)
    pub original_tokens: usize,
    /// Token count after summarization
    pub compressed_tokens: usize,
    /// Number of tokens saved
    pub tokens_saved: usize,
    /// Timestamp of summarization
    pub timestamp: chrono::DateTime<chrono::Utc>,
    /// Type of summarization performed
    pub summary_type: SummaryType,
}

/// Types of summarization
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SummaryType {
    /// Truncation - simple cut-off
    Truncated,
    /// Line-based compression
    LineCompressed,
    /// Semantic summary (future: would use LLM)
    Semantic,
    /// Tool call consolidation
    ToolCallConsolidated,
}

/// Result of a compaction operation
#[derive(Debug, Clone)]
pub struct CompactionResult {
    /// The compacted messages
    pub messages: Vec<Message>,
    /// Summary of what was compressed
    pub summary: Summary,
}

/// Summary of compacted content
#[derive(Debug, Clone)]
pub struct Summary {
    /// Human-readable summary content
    pub content: String,
    /// Tokens saved by compaction
    pub tokens_saved: usize,
    /// Metadata about the compaction
    pub metadata: SummaryMetadata,
}

/// Context compactor with semantic awareness
pub struct ContextCompactor {
    strategy: CompactionStrategy,
    summarizer: Option<Arc<dyn Summarizer>>,
}

impl ContextCompactor {
    /// Create a new compactor with the given strategy
    pub fn new(strategy: CompactionStrategy) -> Self {
        Self {
            strategy,
            summarizer: None,
        }
    }

    /// Create with default strategy
    pub fn default_strategy() -> Self {
        Self::new(CompactionStrategy::default())
    }

    /// Attach an LLM summarizer. When present, `compact_async` performs
    /// semantic summarization (pi-style); otherwise it falls back to the
    /// heuristic `compact` path.
    pub fn with_summarizer(mut self, summarizer: Arc<dyn Summarizer>) -> Self {
        self.summarizer = Some(summarizer);
        self
    }

    /// Compact a list of messages according to the strategy
    pub fn compact(&self, messages: Vec<Message>) -> CompactionResult {
        let original_tokens = self.estimate_tokens(&messages);
        let original_count = messages.len();

        // If we're under the threshold, return as-is
        if !self.strategy.should_compact(original_tokens) {
            return self.no_compaction_result(messages, original_tokens, original_count);
        }

        // Perform compaction
        let (compacted, summary) =
            self.perform_compaction(messages, original_tokens, original_count, false);

        CompactionResult {
            messages: compacted,
            summary,
        }
    }

    /// Compact unconditionally, ignoring the `summarize_threshold` gate.
    ///
    /// Used when the transcript must shrink no matter what the estimate says:
    /// manual `/compact`, and recovery after the provider rejects a request
    /// the estimate claimed would fit. In forced mode tool results are also
    /// eligible for truncation — they are usually the bulk of an over-limit
    /// transcript, and the estimator undercounts them.
    pub fn compact_forced(&self, messages: Vec<Message>) -> CompactionResult {
        let original_tokens = self.estimate_tokens(&messages);
        let original_count = messages.len();
        let (compacted, summary) =
            self.perform_compaction(messages, original_tokens, original_count, true);
        CompactionResult {
            messages: compacted,
            summary,
        }
    }

    /// Async variant that uses the attached LLM summarizer for semantic
    /// compaction. Falls back to the heuristic path when no summarizer is
    /// attached or when summarization fails, so callers always get a result.
    pub async fn compact_async(&self, messages: Vec<Message>) -> CompactionResult {
        let original_tokens = self.estimate_tokens(&messages);
        let original_count = messages.len();

        if !self.strategy.should_compact(original_tokens) {
            return self.no_compaction_result(messages, original_tokens, original_count);
        }

        if let Some(summarizer) = &self.summarizer {
            match self
                .perform_semantic_compaction(
                    summarizer.as_ref(),
                    messages.clone(),
                    original_tokens,
                    original_count,
                )
                .await
            {
                Ok(result) => return result,
                Err(err) => {
                    tracing::warn!(error = %err, "Semantic compaction failed; falling back to heuristic");
                }
            }
        }

        let (compacted, summary) =
            self.perform_compaction(messages, original_tokens, original_count, false);
        CompactionResult {
            messages: compacted,
            summary,
        }
    }

    fn no_compaction_result(
        &self,
        messages: Vec<Message>,
        original_tokens: usize,
        original_count: usize,
    ) -> CompactionResult {
        CompactionResult {
            messages,
            summary: Summary {
                content: String::new(),
                tokens_saved: 0,
                metadata: SummaryMetadata {
                    original_message_count: original_count,
                    original_tokens,
                    compressed_tokens: original_tokens,
                    tokens_saved: 0,
                    timestamp: chrono::Utc::now(),
                    summary_type: SummaryType::Truncated,
                },
            },
        }
    }

    /// Summarize older messages with the LLM, keep recent messages intact, and
    /// prepend a summary message. Leading system messages are always preserved.
    async fn perform_semantic_compaction(
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
        let keep_recent = messages.len().saturating_sub(recent_start);

        let older: Vec<Message> = messages[summarize_start..recent_start].to_vec();
        if older.is_empty() {
            return Err(SummarizeError::Llm("Nothing to summarize".to_string()));
        }

        let recent: Vec<Message> = messages[recent_start..].to_vec();

        let retained_tokens = self
            .estimate_tokens(&system_msgs)
            .saturating_add(self.estimate_tokens(&recent));
        let summary_budget = self.strategy.summary_budget(retained_tokens);
        if summary_budget == 0 {
            return Err(SummarizeError::Llm(
                "Retained context leaves no summary budget".into(),
            ));
        }
        let summary_text = summarizer.summarize(&older, summary_budget, None).await?;

        let mut result = system_msgs;
        result.push(summary_message(&summary_text));
        result.extend(recent);
        result = normalize_tool_messages(result);

        let compressed_tokens = self.estimate_tokens(&result);
        let tokens_saved = original_tokens.saturating_sub(compressed_tokens);

        let summary = Summary {
            content: format!(
                "Compacted {} messages ({} original, {} kept recent)",
                older.len(),
                original_count,
                keep_recent
            ),
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

    fn perform_compaction(
        &self,
        messages: Vec<Message>,
        original_tokens: usize,
        original_count: usize,
        forced: bool,
    ) -> (Vec<Message>, Summary) {
        let target = self.strategy.target_tokens();

        // Keep complete assistant/tool exchanges even when the boundary falls
        // inside the tool results.
        let recent_start = compaction_boundary(&messages, self.strategy.keep_recent, 0);
        let keep_recent = messages.len().saturating_sub(recent_start);
        let recent: Vec<Message> = messages[recent_start..].to_vec();
        let older: Vec<Message> = messages[..recent_start].to_vec();

        // Estimate tokens in recent messages (we'll keep all of these)
        let recent_tokens: usize = recent.iter().map(|m| self.estimate_message_tokens(m)).sum();

        let budget_for_older = target.saturating_sub(recent_tokens);

        // Compact older messages to fit the budget
        let (compacted_older, tokens_saved) =
            self.compact_messages(older, budget_for_older, forced);

        let mut result = compacted_older;
        result.extend(recent);
        result = normalize_tool_messages(result);

        let compressed_tokens = self.estimate_tokens(&result);

        let summary = Summary {
            content: format!(
                "Compacted {} messages ({} original, {} kept recent)",
                original_count.saturating_sub(keep_recent),
                original_count,
                keep_recent
            ),
            tokens_saved,
            metadata: SummaryMetadata {
                original_message_count: original_count,
                original_tokens,
                compressed_tokens,
                tokens_saved,
                timestamp: chrono::Utc::now(),
                summary_type: SummaryType::LineCompressed,
            },
        };

        (result, summary)
    }

    fn compact_messages(
        &self,
        messages: Vec<Message>,
        target_tokens: usize,
        forced: bool,
    ) -> (Vec<Message>, usize) {
        if messages.is_empty() {
            return (messages, 0);
        }

        // Group messages by type for better summarization
        let mut grouped = messages;
        let mut current_tokens: usize = grouped
            .iter()
            .map(|m| self.estimate_message_tokens(m))
            .sum();
        let original_tokens = current_tokens;

        // Reduce until we fit the budget
        while current_tokens > target_tokens && !grouped.is_empty() {
            // Find the largest message to compact
            if let Some(idx) = self.find_largest_message(&grouped, forced) {
                let message = &mut grouped[idx];
                let before = self.estimate_message_tokens(message);
                self.compress_message(message);
                let after = self.estimate_message_tokens(message);

                current_tokens = current_tokens.saturating_sub(before.saturating_sub(after));

                // If compression didn't help, remove the message
                if before <= after * 2 {
                    grouped.remove(idx);
                    current_tokens -= after;
                }
            } else {
                break;
            }
        }

        (grouped, original_tokens.saturating_sub(current_tokens))
    }

    fn find_largest_message(&self, messages: &[Message], forced: bool) -> Option<usize> {
        messages
            .iter()
            .enumerate()
            // Tool results are the bulk of an over-limit transcript, but the
            // default path leaves them intact; only a forced compaction (the
            // estimate already proved wrong) truncates them.
            .filter(|(_, m)| forced || m.tool_call_id.is_none())
            .filter(|(_, m)| !matches!(m.role, Role::System)) // Never remove system messages
            .max_by_key(|(_, m)| self.estimate_message_tokens(m))
            .map(|(i, _)| i)
    }

    fn compress_message(&self, message: &mut Message) {
        match message.role {
            Role::Assistant => {
                self.compress_assistant_message(message);
            }
            Role::User => {
                self.compress_user_message(message);
            }
            Role::System => {
                // Never compact system messages
            }
            Role::Tool => {
                // Optionally compress tool results
                self.compress_tool_result(message);
            }
        }
    }

    fn compress_assistant_message(&self, message: &mut Message) {
        let lines: Vec<&str> = message.content.lines().collect();
        if lines.len() > 20 {
            // Keep first and last portions
            let head = 8;
            let tail = 8;
            let omitted = lines.len() - head - tail;

            let head_part = lines[..head].join("\n");
            let tail_part = lines[lines.len() - tail..].join("\n");

            message.content =
                format!("{head_part}\n\n... [{omitted} lines omitted] ...\n\n{tail_part}");
        }
    }

    fn compress_user_message(&self, message: &mut Message) {
        // For user messages, truncate more aggressively
        let max_lines = 15;
        let lines: Vec<&str> = message.content.lines().collect();

        if lines.len() > max_lines {
            let kept: Vec<&str> = lines.iter().take(max_lines).cloned().collect();
            message.content = format!("{}\n\n... [User message truncated] ...", kept.join("\n"));
        }
    }

    fn compress_tool_result(&self, message: &mut Message) {
        // Tool results are often large; compress significantly
        let max_lines = 10;
        let lines: Vec<&str> = message.content.lines().collect();

        if lines.len() > max_lines {
            let kept: Vec<&str> = lines.iter().take(max_lines).cloned().collect();
            message.content = format!(
                "{}\n\n... [Tool output truncated: {} total lines] ...",
                kept.join("\n"),
                lines.len()
            );
        }
    }

    /// Estimate token count for a message
    fn estimate_message_tokens(&self, message: &Message) -> usize {
        let mut tokens = message.content.len() / 4; // Rough estimate: 1 token ≈ 4 chars

        // Add overhead for tool calls
        if let Some(tool_calls) = &message.tool_calls {
            for tc in tool_calls {
                tokens += tc.function.name.len() / 4;
                tokens += tc.function.arguments.len() / 4;
                tokens += 10; // Overhead per tool call
            }
        }

        tokens.max(1) // At least 1 token
    }

    /// Estimate total token count for a list of messages
    fn estimate_tokens(&self, messages: &[Message]) -> usize {
        messages
            .iter()
            .map(|m| self.estimate_message_tokens(m))
            .sum()
    }
}

/// Return a recent-message boundary that never splits an assistant tool call
/// from its consecutive tool results.
fn compaction_boundary(messages: &[Message], keep_recent: usize, minimum: usize) -> usize {
    let mut start = messages.len().saturating_sub(keep_recent).max(minimum);
    while start > minimum && matches!(messages.get(start).map(|m| &m.role), Some(Role::Tool)) {
        start -= 1;
    }
    start
}

/// Remove protocol-invalid tool messages and incomplete tool exchanges.
/// OpenAI-compatible APIs reject tool results without the directly preceding
/// assistant `tool_calls` message.
pub fn normalize_tool_messages(messages: Vec<Message>) -> Vec<Message> {
    normalize_tool_messages_tracked(messages).0
}

/// Same as `normalize_tool_messages`, additionally reporting whether anything
/// was dropped or padded (used to invalidate incremental token counts).
pub fn normalize_tool_messages_tracked(messages: Vec<Message>) -> (Vec<Message>, bool) {
    let mut input = messages.into_iter().peekable();
    let mut output = Vec::new();
    let mut changed = false;

    while let Some(message) = input.next() {
        if matches!(message.role, Role::Tool) {
            changed = true; // orphaned tool result dropped
            continue;
        }

        let Some(tool_calls) = message
            .tool_calls
            .as_ref()
            .filter(|calls| !calls.is_empty())
        else {
            output.push(message);
            continue;
        };

        let mut expected: HashSet<String> = tool_calls.iter().map(|call| call.id.clone()).collect();
        let mut tool_results = Vec::new();

        while matches!(input.peek().map(|m| &m.role), Some(Role::Tool)) {
            let tool_result = input.next().expect("peeked tool result");
            if tool_result
                .tool_call_id
                .as_ref()
                .is_some_and(|id| expected.remove(id))
            {
                tool_results.push(tool_result);
            }
            // A result with a stale/duplicate id is protocol noise — drop it.
            changed = true;
        }

        if expected.is_empty() {
            output.push(message);
            output.extend(tool_results);
        } else if message.content.is_empty() && tool_results.is_empty() {
            // Nothing but un-answered tool calls: the exchange carries no
            // information — drop it entirely rather than pad it.
            changed = true;
        } else {
            changed = changed || !expected.is_empty();
            // Pad the missing results so the exchange stays protocol-valid
            // and the results that DID succeed survive. Stripping the whole
            // exchange used to erase the agent's progress mid-task.
            output.push(message);
            output.extend(tool_results);
            for id in expected {
                output.push(Message {
                    role: Role::Tool,
                    content: "Error: no result was recorded for this tool call (the turn was interrupted)."
                        .to_string(),
                    tool_calls: None,
                    tool_call_id: Some(id),
                    thinking: None,
                    thinking_signature: None,
                    continuation: None,
                });
            }
        }
    }

    (output, changed)
}

/// Build a message that carries a compaction summary into the conversation.
fn summary_message(content: &str) -> Message {
    Message {
        role: Role::Assistant,
        content: format!("[Conversation summary]\n{content}"),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FunctionCall, ToolCall};

    #[test]
    fn summary_budget_fits_retained_context_and_never_underflows() {
        let strategy = CompactionStrategy::new(8_000, 8, 0.85);
        assert_eq!(strategy.summary_budget(3_000), 1_800);
        assert_eq!(strategy.summary_budget(4_800), 0);
        assert_eq!(strategy.summary_budget(usize::MAX), 0);
        assert_eq!(CompactionStrategy::default().summary_budget(20_000), 16_384);
    }

    fn create_message(role: Role, content: &str) -> Message {
        Message {
            role,
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
        }
    }

    fn tool_exchange(ids: &[&str]) -> Vec<Message> {
        let calls = ids
            .iter()
            .map(|id| ToolCall {
                id: (*id).to_string(),
                call_type: "function".to_string(),
                function: FunctionCall {
                    name: "read_file".to_string(),
                    arguments: "{}".to_string(),
                },
            })
            .collect();
        let mut messages = vec![Message {
            role: Role::Assistant,
            content: String::new(),
            tool_calls: Some(calls),
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
        }];
        messages.extend(ids.iter().map(|id| Message {
            role: Role::Tool,
            content: format!("result for {id}"),
            tool_calls: None,
            tool_call_id: Some((*id).to_string()),
            thinking: None,
            thinking_signature: None,
            continuation: None,
        }));
        messages
    }

    #[test]
    fn test_compaction_strategy_default() {
        let strategy = CompactionStrategy::default();
        assert_eq!(strategy.max_tokens, 128_000);
        assert_eq!(strategy.keep_recent, 8);
        // Should compact at 85% of max_tokens = 108,800
        assert!(strategy.should_compact(110_000));
        assert!(!strategy.should_compact(100_000));
    }

    #[test]
    fn test_compaction_no_compaction_needed() {
        let compactor = ContextCompactor::default_strategy();
        let messages = vec![
            create_message(Role::User, "Hello"),
            create_message(Role::Assistant, "Hi there!"),
        ];

        let result = compactor.compact(messages);
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.summary.tokens_saved, 0);
    }

    #[test]
    fn test_compaction_keeps_recent_messages() {
        let compactor = ContextCompactor::new(CompactionStrategy {
            max_tokens: 1000,
            keep_recent: 2,
            summarize_threshold: 0.5,
            target_reduction: 0.6,
            reserve_tokens: 256,
            keep_recent_tokens: 200,
        });

        let mut messages = vec![];
        for i in 0..10 {
            messages.push(create_message(
                Role::User,
                &format!("This is message {i} with some content that uses tokens"),
            ));
            messages.push(create_message(
                Role::Assistant,
                &format!("Response to message {i} with details and information"),
            ));
        }

        let original_count = messages.len();
        let result = compactor.compact(messages);

        // Should have kept at least the last 2 messages
        assert!(result.messages.len() >= 2);
        assert_eq!(
            result.summary.metadata.original_message_count,
            original_count
        );
    }

    #[test]
    fn test_estimate_message_tokens() {
        let compactor = ContextCompactor::default_strategy();
        let message = create_message(Role::User, "Hello world, this is a test message.");

        let tokens = compactor.estimate_message_tokens(&message);
        assert!(tokens > 0);
        assert!(tokens < 100); // Reasonable upper bound
    }

    /// A transcript the estimator claims fits can still overflow the provider
    /// (real tokenizers, uncounted tool schemas). Forced compaction must
    /// shrink it anyway — including the tool results the default path leaves
    /// intact.
    #[test]
    fn forced_compaction_shrinks_tool_results_below_the_gate() {
        let compactor = ContextCompactor::new(CompactionStrategy {
            max_tokens: 4_000,
            keep_recent: 2,
            summarize_threshold: 0.9, // gate at 3.6k: the transcript stays
            target_reduction: 0.5,    // target 2k: forced mode still shrinks
            reserve_tokens: 256,
            keep_recent_tokens: 200,
        });
        let big_output: String = (0..400)
            .map(|i| format!("src/file{i}.rs:1:match {i}\n"))
            .collect();
        let messages = vec![
            Message {
                role: Role::Assistant,
                content: String::new(),
                tool_calls: Some(vec![ToolCall {
                    id: "c1".to_string(),
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: "grep".to_string(),
                        arguments: "{}".to_string(),
                    },
                }]),
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
            },
            Message {
                role: Role::Tool,
                content: big_output,
                tool_calls: None,
                tool_call_id: Some("c1".to_string()),
                thinking: None,
                thinking_signature: None,
                continuation: None,
            },
            create_message(Role::User, "latest question"),
            create_message(Role::Assistant, "latest answer"),
        ];

        // Below the gate: plain compact() is a no-op.
        let plain = compactor.compact(messages.clone());
        assert_eq!(plain.summary.tokens_saved, 0);
        assert_eq!(plain.messages.len(), messages.len());

        let forced = compactor.compact_forced(messages);
        assert!(
            forced.summary.tokens_saved > 0,
            "forced compaction must save tokens"
        );
        // The live exchange at the tail is untouched.
        let tail = &forced.messages[forced.messages.len() - 2..];
        assert_eq!(tail[0].content, "latest question");
        assert_eq!(tail[1].content, "latest answer");
        // The old tool result was truncated, not kept whole.
        assert!(
            forced
                .messages
                .iter()
                .any(|m| m.content.contains("Tool output truncated")),
            "old tool output must be truncated"
        );
    }

    #[test]
    fn forced_compaction_on_a_small_transcript_is_harmless() {
        let compactor = ContextCompactor::new(CompactionStrategy {
            max_tokens: 100_000,
            keep_recent: 8,
            summarize_threshold: 0.9,
            target_reduction: 0.5,
            reserve_tokens: 256,
            keep_recent_tokens: 200,
        });
        let messages = vec![
            create_message(Role::System, "You are a helpful agent."),
            create_message(Role::User, "hi"),
            create_message(Role::Assistant, "hello"),
        ];
        let forced = compactor.compact_forced(messages.clone());
        assert_eq!(forced.summary.tokens_saved, 0);
        assert_eq!(forced.messages.len(), messages.len());
        assert_eq!(
            forced.messages.first().map(|m| m.role.clone()),
            Some(Role::System)
        );
    }

    #[test]
    fn normalize_tool_messages_removes_orphans_and_pads_incomplete_exchanges() {
        let orphan = Message {
            role: Role::Tool,
            content: "orphan".to_string(),
            tool_calls: None,
            tool_call_id: Some("missing".to_string()),
            thinking: None,
            thinking_signature: None,
            continuation: None,
        };
        let mut messages = vec![orphan];
        messages.extend(tool_exchange(&["complete"]));
        let mut incomplete = tool_exchange(&["first", "second"]);
        incomplete.pop();
        messages.extend(incomplete);

        let normalized = normalize_tool_messages(messages);

        // Orphan dropped; complete exchange kept; the incomplete exchange is
        // PADDED with a synthetic result for "second" instead of being
        // stripped — the successful result for "first" must survive so the
        // agent does not lose its progress mid-task.
        assert_eq!(normalized.len(), 5);
        assert!(normalized[0].tool_calls.is_some());
        assert_eq!(normalized[1].tool_call_id.as_deref(), Some("complete"));
        assert!(normalized[1].content.contains("complete"));
        let assistant = &normalized[2];
        assert_eq!(
            assistant
                .tool_calls
                .as_ref()
                .map(|calls| calls.iter().map(|c| c.id.clone()).collect::<Vec<_>>()),
            Some(vec!["first".to_string(), "second".to_string()]),
        );
        assert_eq!(normalized[3].tool_call_id.as_deref(), Some("first"));
        assert!(normalized[3].content.contains("result for first"));
        assert_eq!(normalized[4].tool_call_id.as_deref(), Some("second"));
        assert!(
            normalized[4].content.contains("no result was recorded"),
            "padded result: {:?}",
            normalized[4].content
        );
    }

    #[test]
    fn compaction_keeps_system_message() {
        let compactor = ContextCompactor::new(CompactionStrategy {
            max_tokens: 1000,
            keep_recent: 2,
            summarize_threshold: 0.5,
            target_reduction: 0.6,
            reserve_tokens: 256,
            keep_recent_tokens: 200,
        });
        let mut messages = vec![create_message(Role::System, "You are a helpful agent.")];
        for i in 0..20 {
            messages.push(create_message(
                Role::User,
                &format!(
                    "This is a long user message number {i} with enough content to consume tokens"
                ),
            ));
        }

        let result = compactor.compact(messages);
        assert_eq!(
            result.messages.first().map(|m| m.role.clone()),
            Some(Role::System)
        );
    }

    struct FakeSummarizer {
        summary: String,
        fail: bool,
    }

    #[async_trait]
    impl Summarizer for FakeSummarizer {
        async fn summarize(
            &self,
            _messages: &[Message],
            _budget_tokens: usize,
            _previous_summary: Option<&str>,
        ) -> Result<String, SummarizeError> {
            if self.fail {
                Err(SummarizeError::Llm("boom".to_string()))
            } else {
                Ok(self.summary.clone())
            }
        }
    }

    #[tokio::test]
    async fn semantic_compaction_uses_summarizer_and_keeps_recent() {
        let compactor = ContextCompactor::new(CompactionStrategy {
            max_tokens: 200,
            keep_recent: 2,
            summarize_threshold: 0.5,
            target_reduction: 0.6,
            reserve_tokens: 256,
            keep_recent_tokens: 200,
        })
        .with_summarizer(Arc::new(FakeSummarizer {
            summary: "STRUCTURED SUMMARY".to_string(),
            fail: false,
        }));

        let mut messages = vec![create_message(Role::System, "You are a helpful agent.")];
        for i in 0..10 {
            messages.push(create_message(
                Role::User,
                &format!("User message {i} with plenty of content"),
            ));
            messages.push(create_message(
                Role::Assistant,
                &format!("Assistant response {i} with detail"),
            ));
        }

        let result = compactor.compact_async(messages).await;

        // Semantic summary was produced by the fake summarizer.
        assert_eq!(result.summary.metadata.summary_type, SummaryType::Semantic);
        assert!(result.summary.tokens_saved > 0);

        // System message is preserved and first.
        assert_eq!(
            result.messages.first().map(|m| m.role.clone()),
            Some(Role::System)
        );

        // The summary message was injected.
        let has_summary = result.messages.iter().any(|m| {
            m.content.contains("[Conversation summary]") && m.content.contains("STRUCTURED SUMMARY")
        });
        assert!(has_summary, "expected a summary message in the result");

        // Recent messages were kept intact.
        let last = result.messages.last().unwrap();
        assert!(last.content.contains("Assistant response 9"));
    }

    #[tokio::test]
    async fn semantic_compaction_keeps_tool_exchange_intact_at_boundary() {
        let compactor = ContextCompactor::new(CompactionStrategy {
            max_tokens: 100,
            keep_recent: 2,
            summarize_threshold: 0.5,
            target_reduction: 0.6,
            reserve_tokens: 256,
            keep_recent_tokens: 200,
        })
        .with_summarizer(Arc::new(FakeSummarizer {
            summary: "SUMMARY".to_string(),
            fail: false,
        }));
        let mut messages = vec![
            create_message(Role::System, "system"),
            create_message(Role::User, &"old context ".repeat(100)),
        ];
        messages.extend(tool_exchange(&["call_1", "call_2"]));

        let result = compactor.compact_async(messages).await;
        let assistant_index = result
            .messages
            .iter()
            .position(|message| message.tool_calls.is_some())
            .expect("assistant tool call retained");

        assert_eq!(result.messages[assistant_index + 1].role, Role::Tool);
        assert_eq!(result.messages[assistant_index + 2].role, Role::Tool);
    }

    #[tokio::test]
    async fn semantic_compaction_falls_back_when_summarizer_fails() {
        let compactor = ContextCompactor::new(CompactionStrategy {
            max_tokens: 200,
            keep_recent: 2,
            summarize_threshold: 0.5,
            target_reduction: 0.6,
            reserve_tokens: 256,
            keep_recent_tokens: 200,
        })
        .with_summarizer(Arc::new(FakeSummarizer {
            summary: String::new(),
            fail: true,
        }));

        let mut messages = vec![];
        for i in 0..10 {
            messages.push(create_message(
                Role::User,
                &format!("This is user message {i} with a lot of content that uses tokens"),
            ));
            messages.push(create_message(
                Role::Assistant,
                &format!("This is assistant response {i} with details"),
            ));
        }

        let result = compactor.compact_async(messages).await;

        // Failure falls back to the heuristic path instead of panicking.
        assert_ne!(result.summary.metadata.summary_type, SummaryType::Semantic);
        assert!(!result.messages.is_empty());
    }

    #[test]
    fn serialize_conversation_includes_roles_and_tool_calls() {
        let mut msg = create_message(Role::Assistant, "Let me read that file");
        msg.tool_calls = Some(vec![crate::types::ToolCall {
            id: "call_1".to_string(),
            call_type: "function".to_string(),
            function: crate::types::FunctionCall {
                name: "read_file".to_string(),
                arguments: r#"{"path":"a.rs"}"#.to_string(),
            },
        }]);
        let text = serialize_conversation(&[msg]);
        assert!(text.contains("<assistant>"));
        assert!(text.contains("read_file"));
        assert!(text.contains("a.rs"));
    }
}
