//! Heuristic trimming compaction: shrinking tool outputs, prose, and old turns.

use std::collections::HashSet;

use super::normalize::{
    carries_skill, carry_skills, compaction_boundary, normalize_tool_messages, repair_role_order,
};
use super::{ContextCompactor, Summary, SummaryMetadata, SummaryType};
use crate::context::budget::{estimate_message_tokens, estimated_message_cost};
use crate::types::{Message, Role};

impl ContextCompactor {
    pub(super) fn perform_compaction(
        &self,
        messages: Vec<Message>,
        original_tokens: usize,
        original_count: usize,
    ) -> (Vec<Message>, Summary) {
        let target = self.strategy.target_tokens();

        // Keep complete assistant/tool exchanges even when the boundary falls
        // inside the tool results.
        let tokens_from =
            |start: usize| -> usize { messages[start..].iter().map(estimated_message_cost).sum() };
        let mut keep = self.strategy.keep_recent.max(1);
        let mut recent_start = compaction_boundary(&messages, keep, 0);
        // A few large messages can hold more than the target on their own:
        // keep fewer of them, down to the newest exchange, rather than
        // saving nothing.
        while keep > 1 && tokens_from(recent_start) > target {
            keep -= 1;
            recent_start = compaction_boundary(&messages, keep, 0);
        }
        let keep_recent = messages.len().saturating_sub(recent_start);
        let mut recent: Vec<Message> = messages[recent_start..].to_vec();
        let older: Vec<Message> = messages[..recent_start].to_vec();

        // Estimate tokens in recent messages (we'll keep all of these)
        let mut recent_tokens = tokens_from(recent_start);

        // The newest exchange alone can be over the target — one huge read
        // or a minified single-line result. Recent messages are otherwise
        // kept whole, so shrink their largest tool outputs (never a skill)
        // until they fit, or an overflow recovery saves nothing.
        let mut recent_saved = 0usize;
        if recent_tokens > target {
            let mut largest: Vec<usize> = recent
                .iter()
                .enumerate()
                .filter(|(_, m)| matches!(m.role, Role::Tool) && !carries_skill(m))
                .map(|(i, _)| i)
                .collect();
            largest.sort_by_key(|&i| std::cmp::Reverse(estimated_message_cost(&recent[i])));
            for i in largest {
                if recent_tokens <= target {
                    break;
                }
                let before = estimated_message_cost(&recent[i]);
                self.compress_tool_result(&mut recent[i]);
                let saved = before.saturating_sub(estimated_message_cost(&recent[i]));
                recent_tokens = recent_tokens.saturating_sub(saved);
                recent_saved += saved;
            }
        }

        let budget_for_older = target.saturating_sub(recent_tokens);

        // Compact older messages to fit the budget
        let (compacted_older, older_saved) = self.compact_messages(older, budget_for_older);
        let tokens_saved = older_saved + recent_saved;

        let mut result = compacted_older;
        result.extend(recent);
        result = repair_role_order(carry_skills(&messages, normalize_tool_messages(result)));

        let compressed_tokens = estimate_message_tokens(&result);

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

    pub(super) fn compact_messages(
        &self,
        messages: Vec<Message>,
        target_tokens: usize,
    ) -> (Vec<Message>, usize) {
        if messages.is_empty() {
            return (messages, 0);
        }

        // Group messages by type for better summarization
        let mut grouped = messages;
        let mut current_tokens: usize = grouped.iter().map(estimated_message_cost).sum();
        let original_tokens = current_tokens;

        // Reduce until we fit the budget
        while current_tokens > target_tokens && !grouped.is_empty() {
            // Find the largest message to compact
            if let Some(idx) = self.find_largest_message(&grouped) {
                let message = &mut grouped[idx];
                let before = estimated_message_cost(message);
                self.compress_message(message);
                let after = estimated_message_cost(message);

                current_tokens = current_tokens.saturating_sub(before.saturating_sub(after));

                // If compression didn't help, remove the message
                if before <= after * 2 {
                    grouped.remove(idx);
                    current_tokens = current_tokens.saturating_sub(after.min(before));
                }
            } else {
                break;
            }
        }

        (grouped, original_tokens.saturating_sub(current_tokens))
    }

    fn find_largest_message(&self, messages: &[Message]) -> Option<usize> {
        // Loaded skills are durable guidance: never shrink their block, nor
        // the assistant call whose loss would orphan (and drop) the result.
        let skill_calls: HashSet<&str> = messages
            .iter()
            .filter(|m| carries_skill(m))
            .filter_map(|m| m.tool_call_id.as_deref())
            .collect();
        messages
            .iter()
            .enumerate()
            .filter(|(_, m)| !carries_skill(m))
            .filter(|(_, m)| {
                !m.tool_calls
                    .as_ref()
                    .is_some_and(|calls| calls.iter().any(|c| skill_calls.contains(c.id.as_str())))
            })
            // Tool results are the bulk of an over-limit transcript and the
            // first thing worth shrinking: a grep/read-heavy conversation is
            // almost all tool output.
            .filter(|(_, m)| !matches!(m.role, Role::System)) // Never remove system messages
            .max_by_key(|(_, m)| estimated_message_cost(m))
            .map(|(i, _)| i)
    }

    fn compress_message(&self, message: &mut Message) {
        match message.role {
            Role::Assistant => self.compress_assistant_message(message),
            Role::User => self.compress_user_message(message),
            Role::System => {} // Never compact system messages
            Role::Tool => self.compress_tool_result(message),
        }
    }

    fn compress_assistant_message(&self, message: &mut Message) {
        let lines: Vec<&str> = message.content.lines().collect();
        if lines.len() > 20 {
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
        // Old media is the heaviest part of a user turn: keep a note of it.
        if !message.attachments.is_empty() {
            let names: Vec<String> = message
                .attachments
                .drain(..)
                .map(|a| format!("{} {}", a.kind.label(), a.name))
                .collect();
            message.content.push_str(&format!(
                "\n[attachments removed by compaction: {}]",
                names.join(", ")
            ));
            return;
        }
        // For user messages, truncate more aggressively
        let max_lines = 15;
        let lines: Vec<&str> = message.content.lines().collect();

        if lines.len() > max_lines {
            let kept: Vec<&str> = lines.iter().take(max_lines).cloned().collect();
            message.content = format!("{}\n\n... [User message truncated] ...", kept.join("\n"));
        }
    }

    fn compress_tool_result(&self, message: &mut Message) {
        // Tool results are often large; compress significantly. Bytes are
        // capped as well as lines: minified JSON or a long log line is one
        // line, and a line cap alone left it whole.
        const MAX_LINES: usize = 10;
        const MAX_BYTES: usize = 2_000;
        let total_lines = message.content.lines().count();
        let total_bytes = message.content.len();
        if total_lines <= MAX_LINES && total_bytes <= MAX_BYTES {
            return;
        }
        let head = message
            .content
            .lines()
            .take(MAX_LINES)
            .collect::<Vec<_>>()
            .join("\n");
        let head = crate::util::truncate_at_char_boundary(&head, MAX_BYTES);
        message.content = format!(
            "{head}\n\n... [Tool output truncated: {total_lines} lines, {total_bytes} bytes total] ..."
        );
    }
}
