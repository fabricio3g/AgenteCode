//! Enhanced context compaction with semantic summarization
//!
//! This module provides intelligent context management for LLM conversations:
//! - Semantic summarization of old messages
//! - Configurable compaction strategies
//! - Metadata tracking for compressed content

mod normalize;
mod semantic;
#[cfg(test)]
mod tests;
mod trim;

pub use normalize::{
    merge_consecutive_user_turns, normalize_tool_messages, normalize_tool_messages_tracked,
    CARRIED_SKILLS_HEADING, COMPACTED_GAP_NOTE,
};
pub use semantic::{
    build_summarization_messages, serialize_conversation, SummarizeError, Summarizer,
    SUMMARIZATION_PROMPT, SUMMARIZATION_SYSTEM_PROMPT, UPDATE_SUMMARIZATION_PROMPT,
};

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::budget::{estimate_message_tokens, ContextBudget, COMPACT_AT};
use crate::types::Message;

/// How a compaction trades window for recent turns.
///
/// Sized from a [`ContextBudget`], never from a window assumed on its own:
/// the gate, the status meter and this strategy all read the same room.
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
        }
    }

    /// The strategy for a budget: thresholds apply to the room left for
    /// messages, and the summary reserve never exceeds a quarter of it.
    pub fn from_budget(budget: &ContextBudget) -> Self {
        let room = budget.room();
        Self {
            max_tokens: room,
            keep_recent: 8,
            summarize_threshold: COMPACT_AT,
            target_reduction: 0.6,
            reserve_tokens: budget.reserve.min(room / 4),
        }
    }

    /// A manual `/compact`: always shrinks what is there (to about 60%),
    /// never more than the window allows. Sized by the window alone, a
    /// conversation below its compaction target would not shrink at all.
    pub fn manual(context_window: usize, current_tokens: usize) -> Self {
        let budget = ContextBudget::new(context_window, 0, 0, current_tokens, 0);
        let mut strategy = Self::from_budget(&budget);
        strategy.max_tokens = strategy.max_tokens.min(current_tokens.max(1));
        strategy.keep_recent = 4;
        strategy
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
    pub(super) strategy: CompactionStrategy,
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

    /// Attach an LLM summarizer. When present, `compact_async` performs
    /// semantic summarization (pi-style); otherwise it falls back to the
    /// heuristic `compact` path.
    pub fn with_summarizer(mut self, summarizer: Arc<dyn Summarizer>) -> Self {
        self.summarizer = Some(summarizer);
        self
    }

    /// Compact a list of messages according to the strategy
    pub fn compact(&self, messages: Vec<Message>) -> CompactionResult {
        let original_tokens = estimate_message_tokens(&messages);
        let original_count = messages.len();

        // If we're under the threshold, return as-is
        if !self.strategy.should_compact(original_tokens) {
            return self.no_compaction_result(messages, original_tokens, original_count);
        }

        // Perform compaction
        let (compacted, summary) =
            self.perform_compaction(messages, original_tokens, original_count);

        CompactionResult {
            messages: compacted,
            summary,
        }
    }

    /// Compact unconditionally, ignoring the `summarize_threshold` gate.
    ///
    /// Used when the transcript must shrink no matter what the estimate says:
    /// manual `/compact`, and recovery after the provider rejects a request
    /// the estimate claimed would fit. Tool results are eligible either way —
    /// they are usually the bulk of an over-limit transcript.
    pub fn compact_forced(&self, messages: Vec<Message>) -> CompactionResult {
        let original_tokens = estimate_message_tokens(&messages);
        let original_count = messages.len();
        let (compacted, summary) =
            self.perform_compaction(messages, original_tokens, original_count);
        CompactionResult {
            messages: compacted,
            summary,
        }
    }

    /// Async variant that uses the attached LLM summarizer for semantic
    /// compaction. Falls back to the heuristic path when no summarizer is
    /// attached or when summarization fails, so callers always get a result.
    pub async fn compact_async(&self, messages: Vec<Message>) -> CompactionResult {
        let original_tokens = estimate_message_tokens(&messages);
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
            self.perform_compaction(messages, original_tokens, original_count);
        CompactionResult {
            messages: compacted,
            summary,
        }
    }

    /// Manual semantic compaction, independent of the automatic threshold.
    /// A failed summarizer still performs the forced local trim.
    pub async fn compact_async_forced(&self, messages: Vec<Message>) -> CompactionResult {
        if let Some(summarizer) = &self.summarizer {
            let tokens = estimate_message_tokens(&messages);
            let count = messages.len();
            if let Ok(result) = self
                .perform_semantic_compaction(summarizer.as_ref(), messages.clone(), tokens, count)
                .await
            {
                return result;
            }
        }
        self.compact_forced(messages)
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
}
