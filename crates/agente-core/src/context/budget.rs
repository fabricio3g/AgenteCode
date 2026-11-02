//! One context budget.
//!
//! Every context decision in the app — when to compact, what the status meter
//! draws, what the model is told about its remaining room — reads this one
//! struct. It replaces four estimators and two different denominators that
//! used to disagree: the gate compared a local message estimate against
//! `window − tool schemas − tokenizer gap`, while the meter compared the
//! provider's whole prompt against the bare window, so the amber line and the
//! compaction line were never the same place.

use crate::types::Message;

/// Fraction of the room for messages at which compaction fires.
pub const COMPACT_AT: f32 = 0.85;

/// Most of the window a reply may claim. The reserve is what the model can
/// still generate after the transcript, so compaction has to fire before the
/// window is full, not when it already is.
const MAX_RESERVE_FRACTION: f32 = 0.25;

/// The full window a model offers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContextBudget {
    /// The model's context window (`ModelInfo.limits.context`).
    pub window: usize,
    /// What the request's tool schemas cost; the message estimate never sees
    /// them and with dozens of tools they are thousands of tokens.
    pub tool_tokens: usize,
    /// What the provider counted beyond our estimate last time (its tokenizer,
    /// framing, the chat template). Carried across turns so the first request
    /// of a turn — where overflow actually happens — is not gated blind.
    pub gap: usize,
    /// The transcript as we count it (see `estimate_message_tokens`).
    pub used: usize,
    /// Room kept for the reply itself.
    pub reserve: usize,
}

impl ContextBudget {
    /// A budget with the reply reserve derived from the model's output limit.
    /// `output_tokens` is `ModelInfo.limits.output`; 0 means unknown.
    pub fn new(
        window: usize,
        tool_tokens: usize,
        gap: usize,
        used: usize,
        output_tokens: usize,
    ) -> Self {
        let window = if window == 0 { 8_000 } else { window };
        let reserve = output_tokens
            .max(1_024)
            .min((window as f32 * MAX_RESERVE_FRACTION) as usize);
        Self {
            window,
            tool_tokens,
            gap,
            used,
            reserve,
        }
    }

    /// Room available to the transcript. Never less than a quarter of the
    /// window: a model whose tool schemas nearly fill it still gets to run.
    pub fn room(&self) -> usize {
        self.window
            .saturating_sub(self.tool_tokens)
            .saturating_sub(self.gap)
            .saturating_sub(self.reserve)
            .max(self.window / 4)
            .max(1_000)
    }

    /// Tokens still free for messages.
    pub fn remaining(&self) -> usize {
        self.room().saturating_sub(self.used)
    }

    /// How full the room is, `0.0..`.
    pub fn ratio(&self) -> f32 {
        self.used as f32 / self.room().max(1) as f32
    }

    /// The width the provider actually accepted last time, for the meter's
    /// denominator: the room plus what the reply may take.
    pub fn limit(&self) -> usize {
        self.room() + self.reserve
    }

    /// Whether the transcript is near the window and must shrink.
    pub fn should_compact(&self) -> bool {
        self.ratio() >= COMPACT_AT
    }

    /// How much room is left, banded. A reminder is only rewritten when the
    /// band changes, so the text stays stable between steps.
    pub fn band(&self) -> Band {
        let room = self.room().max(1);
        let left = self.remaining();
        let ratio = left as f32 / room as f32;
        if ratio <= 0.10 {
            Band::Tenth
        } else if ratio <= 0.25 {
            Band::Quarter
        } else if ratio <= 0.50 {
            Band::Half
        } else {
            Band::Plenty
        }
    }

    /// What the model is told. `None` while there is comfortable room: a
    /// reminder on every request is noise, and the useful moment is when the
    /// model can still change what it does.
    pub fn notice(&self) -> Option<String> {
        let left = format_tokens(self.remaining());
        let used = format_tokens(self.used);
        let window = format_tokens(self.window);
        match self.band() {
            Band::Plenty => None,
            Band::Half => Some(format!(
                "Context: {used} of {window} used, about {left} left. \
                 Older tool output is trimmed first."
            )),
            Band::Quarter => Some(format!(
                "Context: {used} of {window} used, about {left} left. \
                 Prefer one targeted read over several broad ones, and write \
                 durable findings to a file instead of holding them in the conversation."
            )),
            Band::Tenth => Some(format!(
                "Context: {used} of {window} used, about {left} left. \
                 The context is nearly full: summarize what matters now and keep \
                 working from files. The next step may compact, and only a summary \
                 survives that."
            )),
        }
    }

    /// The note a compaction leaves behind: the model must know its earlier
    /// turns are gone, and what replaced them.
    pub fn compacted_notice(&self) -> String {
        format!(
            "The context was compacted to {} of {}. About {} is left. \
             The summary above is all that survives from earlier turns.",
            format_tokens(self.used),
            format_tokens(self.window),
            format_tokens(self.remaining())
        )
    }

    /// The reminder as a message appended to the request copy. Never pushed
    /// into the transcript: it must not reach session files, forks, resumed
    /// subagent transcripts or the chat.
    pub fn notice_message(&self, compacted: bool) -> Option<Message> {
        let content = if compacted {
            Some(self.compacted_notice())
        } else {
            self.notice()
        }?;
        Some(Message::user(content))
    }
}

/// How much room is left, coarse enough that the reminder text stops moving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Band {
    /// More than half the room is free.
    Plenty,
    /// Half to a quarter.
    Half,
    /// A quarter to a tenth.
    Quarter,
    /// A tenth or less.
    Tenth,
}

/// `61k`, `1.5M`, `800`: the one token count every surface prints.
pub fn format_tokens(tokens: usize) -> String {
    if tokens >= 1_000_000 {
        let v = tokens as f64 / 1_000_000.0;
        if v == v.trunc() {
            format!("{}M", v as u64)
        } else {
            format!("{v:.1}M")
        }
    } else if tokens >= 1_000 {
        let v = tokens as f64 / 1_000.0;
        if v == v.trunc() {
            format!("{}k", v as u64)
        } else {
            format!("{v:.1}k")
        }
    } else {
        tokens.to_string()
    }
}

/// Estimate the number of tokens in a slice of messages using the standard
/// "1 token ≈ 4 characters" heuristic, plus a flat 10-token overhead per tool
/// call, the media each message carries and the reasoning it replays.
///
/// The only estimator in the app: the compaction gate, the compactor's own
/// accounting, the status meter and `/compact` all call this.
pub fn estimate_message_tokens(messages: &[Message]) -> usize {
    messages.iter().map(estimated_message_cost).sum()
}

/// One message's share of [`estimate_message_tokens`].
pub fn estimated_message_cost(message: &Message) -> usize {
    let tool_tokens = message
        .tool_calls
        .as_ref()
        .map(|calls| {
            calls
                .iter()
                .map(|tc| tc.function.name.len() / 4 + tc.function.arguments.len() / 4 + 10)
                .sum::<usize>()
        })
        .unwrap_or(0);
    let media: usize = message
        .attachments
        .iter()
        .map(crate::media::estimated_tokens)
        .sum();
    // Reasoning is replayed on the wire (Anthropic thinking blocks, OpenAI
    // reasoning, provider continuations), so it occupies the window even
    // though it never appears in a bubble.
    let reasoning = message.thinking.as_deref().map_or(0, |t| t.len() / 4)
        + message
            .thinking_signature
            .as_deref()
            .map_or(0, |t| t.len() / 4)
        + message
            .continuation
            .as_ref()
            .map_or(0, |c| serde_json::to_string(c).map_or(0, |s| s.len() / 4));
    message.content.len() / 4 + tool_tokens + media + reasoning
}

/// Tokens the tool schemas add to every request.
pub fn estimate_tool_definition_tokens(tools: &[crate::types::ToolDefinition]) -> usize {
    tools
        .iter()
        .map(|tool| {
            (tool.name.len() + tool.description.len() + tool.parameters.to_string().len()) / 4 + 8
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(content: &str) -> Message {
        Message::user(content)
    }

    #[test]
    fn a_small_window_leaves_room_for_the_tool_schemas() {
        // 8k window, ~4.5k of tool schemas: compaction must fire well before
        // the messages alone reach 85% of the whole window.
        let budget = ContextBudget::new(8_192, 4_500, 0, 0, 1_024);
        assert_eq!(budget.reserve, 1_024);
        assert_eq!(budget.room(), 2_668);
        assert!(!budget.should_compact());
        let full = ContextBudget::new(8_192, 4_500, 0, 2_400, 1_024);
        assert!(full.should_compact());
        // The meter's denominator is the room the provider will accept.
        assert_eq!(full.limit(), 3_692);
    }

    #[test]
    fn an_unknown_window_assumes_eight_thousand() {
        assert_eq!(ContextBudget::new(0, 0, 0, 0, 0).window, 8_000);
        // The reserve is never more than a quarter of the window.
        assert_eq!(ContextBudget::new(100_000, 0, 0, 0, 64_000).reserve, 25_000);
        // And never less than a quarter of the window stays usable.
        assert_eq!(ContextBudget::new(8_000, 50_000, 0, 0, 0).room(), 2_000);
    }

    #[test]
    fn the_gap_shrinks_the_room() {
        let measured = ContextBudget::new(128_000, 20_000, 0, 40_000, 8_192);
        let undercounted = ContextBudget::new(128_000, 20_000, 6_000, 40_000, 8_192);
        assert_eq!(measured.room() - undercounted.room(), 6_000);
        assert!(undercounted.ratio() > measured.ratio());
    }

    #[test]
    fn the_reminder_arrives_only_when_the_model_can_still_act_on_it() {
        let window = 100_000;
        // Bands are shares of the *room* (the window minus the reply reserve),
        // so the test asks the budget for its own room rather than assuming
        // the two are the same number.
        let room = ContextBudget::new(window, 0, 0, 0, 0).room();
        let at = |used: usize| ContextBudget::new(window, 0, 0, used, 0);
        // 60% free: nothing to say.
        assert_eq!(at(room * 40 / 100).notice(), None);
        assert_eq!(at(room * 60 / 100).band(), Band::Half);
        assert_eq!(at(room * 80 / 100).band(), Band::Quarter);
        assert_eq!(at(room * 95 / 100).band(), Band::Tenth);
        let text = at(room * 95 / 100).notice().unwrap();
        assert!(text.contains("nearly full"), "{text}");
        assert!(text.contains("may compact"), "{text}");
    }

    #[test]
    fn every_band_says_how_much_is_left() {
        let window = 100_000;
        let room = ContextBudget::new(window, 0, 0, 0, 0).room();
        for used in [room * 60 / 100, room * 80 / 100, room * 95 / 100] {
            let text = ContextBudget::new(window, 0, 0, used, 0).notice().unwrap();
            assert!(text.starts_with("Context: "), "{text}");
            assert!(text.contains(" left"), "{text}");
        }
    }

    #[test]
    fn reasoning_is_counted_even_though_it_is_never_drawn() {
        let plain = user("hello");
        let mut thinking = plain.clone();
        thinking.thinking = Some("x".repeat(4_000));
        assert_eq!(
            estimated_message_cost(&thinking) - estimated_message_cost(&plain),
            1_000
        );
        // A signed thinking block replays with its signature, so the signature
        // occupies the window too.
        let mut signed = plain.clone();
        signed.thinking_signature = Some("s".repeat(400));
        assert_eq!(
            estimated_message_cost(&signed) - estimated_message_cost(&plain),
            100
        );
    }

    #[test]
    fn media_is_counted_at_its_prompt_cost() {
        let mut with_image = user("look");
        with_image.attachments = vec![crate::media::Attachment {
            kind: crate::media::AttachmentKind::Image,
            name: "shot.png".into(),
            mime: "image/png".into(),
            path: "/tmp/shot.png".into(),
            bytes: 1_000,
        }];
        assert!(estimated_message_cost(&with_image) >= 1_600);
    }

    #[test]
    fn token_counts_use_one_scale() {
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(61_000), "61k");
        assert_eq!(format_tokens(1_500_000), "1.5M");
        assert_eq!(format_tokens(2_000_000), "2M");
    }
}
