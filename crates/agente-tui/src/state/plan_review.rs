//! Plan review card + ask/clarify state for finished plans.

use chrono::{DateTime, Utc};

/// UI phase for plan review flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PlanReviewPhase {
    #[default]
    Idle,
    /// Squared card: Accept / Redo / Comment
    Review,
    /// Composer collecting free-text feedback
    AwaitingComment,
    /// Clarifying questions for vague feedback
    Asking,
}

#[derive(Debug, Clone)]
pub struct PendingPlan {
    pub path: String,
    pub title: String,
    pub body_markdown: String,
    pub created_at: DateTime<Utc>,
    pub version: u32,
}

/// One step in the multi-step clarify flow.
/// `options` are optional shortcuts; `free_text` is always available if none fit.
#[derive(Debug, Clone)]
pub struct AskQuestion {
    pub prompt: String,
    pub options: Vec<String>,
    pub selected: Option<usize>,
    /// Free-text answer (escape hatch when user dislikes chips).
    pub free_text: String,
}

impl AskQuestion {
    /// Step is answered if a choice is selected or free text is non-empty.
    pub fn is_answered(&self) -> bool {
        self.selected.is_some() || !self.free_text.trim().is_empty()
    }
}

#[derive(Debug, Clone)]
pub struct PlanAskState {
    pub original_comment: String,
    pub questions: Vec<AskQuestion>,
    pub question_index: usize,
    pub reask_count: u32,
}

impl PlanAskState {
    pub fn step_count(&self) -> usize {
        self.questions.len()
    }

    pub fn step_display(&self) -> (usize, usize) {
        let n = self.step_count().max(1);
        let i = self.question_index.min(n.saturating_sub(1)) + 1;
        (i, n)
    }

    pub fn at_last_step(&self) -> bool {
        self.questions.is_empty() || self.question_index + 1 >= self.questions.len()
    }

    /// Advance to next step. Returns true if already on last step (caller should submit).
    pub fn advance_or_submit(&mut self) -> bool {
        if self.at_last_step() {
            true
        } else {
            self.question_index += 1;
            false
        }
    }

    pub fn go_prev(&mut self) {
        if self.question_index > 0 {
            self.question_index -= 1;
        }
    }

    pub fn go_next_focus(&mut self) {
        let max = self.questions.len().saturating_sub(1);
        if self.question_index < max {
            self.question_index += 1;
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PlanReviewState {
    pub phase: PlanReviewPhase,
    pub pending: Option<PendingPlan>,
    pub scroll: u16,
    /// Wrapped body line count from last render (for scroll clamp).
    pub body_line_count: u16,
    /// Visible body rows from last render.
    pub body_visible: u16,
    pub ask: Option<PlanAskState>,
    /// Selected button on review card: 0 Accept, 1 Redo, 2 Comment
    pub button_index: usize,
}

impl PlanReviewState {
    /// Store a finished plan without opening the actionable card yet. Used
    /// when `present_plan` completes mid-turn while the agent is still running:
    /// the card is promoted to Review on the terminal event (Done/Error/
    /// Cancelled), so a live agent never shows a review it could keep mutating.
    pub fn store_plan(&mut self, path: String, title: String, body: String) {
        let version = self
            .pending
            .as_ref()
            .map(|p| p.version.saturating_add(1))
            .unwrap_or(1);
        self.pending = Some(PendingPlan {
            path,
            title,
            body_markdown: body,
            created_at: Utc::now(),
            version,
        });
        // Phase intentionally unchanged (Idle) — the card opens on promote().
        self.scroll = 0;
        self.body_line_count = 0;
        self.body_visible = 0;
        self.button_index = 0;
        self.ask = None;
    }

    /// Promote a stored plan into the actionable Review card. Only promotes
    /// from Idle so an in-progress review/comment/ask session is never
    /// clobbered by a late terminal event.
    pub fn promote(&mut self) {
        if self.pending.is_none() || self.phase != PlanReviewPhase::Idle {
            return;
        }
        self.phase = PlanReviewPhase::Review;
        self.scroll = 0;
        self.button_index = 0;
        self.ask = None;
    }

    pub fn open_review(&mut self, path: String, title: String, body: String) {
        self.store_plan(path, title, body);
        self.phase = PlanReviewPhase::Review;
    }

    pub fn dismiss_card(&mut self) {
        // Keep pending plan; just hide the card
        if matches!(
            self.phase,
            PlanReviewPhase::Review | PlanReviewPhase::Asking | PlanReviewPhase::AwaitingComment
        ) {
            self.phase = PlanReviewPhase::Idle;
        }
        self.ask = None;
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Full-screen plan panel replaces the chat list (Review or Comment typing).
    pub fn takes_chat_area(&self) -> bool {
        self.pending.is_some()
            && matches!(
                self.phase,
                PlanReviewPhase::Review | PlanReviewPhase::AwaitingComment
            )
    }

    pub fn is_modal(&self) -> bool {
        matches!(
            self.phase,
            PlanReviewPhase::Review | PlanReviewPhase::Asking
        )
    }

    pub fn max_scroll(&self) -> u16 {
        self.body_line_count
            .saturating_sub(self.body_visible.max(1))
    }

    pub fn scroll_by(&mut self, delta: i16) {
        let max = self.max_scroll();
        if delta < 0 {
            self.scroll = self.scroll.saturating_sub((-delta) as u16);
        } else {
            self.scroll = (self.scroll.saturating_add(delta as u16)).min(max);
        }
    }
}

/// Heuristic: is this plan feedback too vague to replan safely?
pub fn is_vague_feedback(comment: &str) -> bool {
    let t = comment.trim();
    if t.is_empty() {
        return true;
    }
    if t.chars().count() < 24 {
        // Short + only generic words → vague
        let lower = t.to_ascii_lowercase();
        let generic = [
            "better", "simpler", "simple", "fix", "no", "yes", "idk", "meh", "improve", "redo",
            "again", "bad", "wrong", "ok", "more", "less", "change", "update", "please", "make",
            "it", "this", "that", "not",
        ];
        let tokens: Vec<&str> = lower
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect();
        if tokens.is_empty() {
            return true;
        }
        let all_generic = tokens.iter().all(|tok| generic.contains(tok));
        if all_generic {
            return true;
        }
        if t.chars().count() < 12 {
            return true;
        }
    }
    false
}

/// Template multi-step clarifying questions when the model is unavailable.
pub fn template_ask_questions(comment: &str) -> Vec<AskQuestion> {
    vec![
        AskQuestion {
            prompt: format!(
                "You said “{}”. Which part of the plan should change?",
                crate::widgets::truncate_cells(comment, 40)
            ),
            options: vec![
                "Approach".into(),
                "Scope".into(),
                "Steps".into(),
                "Risks".into(),
                "Everything".into(),
            ],
            selected: Some(0),
            free_text: String::new(),
        },
        AskQuestion {
            prompt: "How big should the change be?".into(),
            options: vec![
                "Small tweak".into(),
                "Medium rewrite".into(),
                "Start over".into(),
            ],
            selected: Some(0),
            free_text: String::new(),
        },
        AskQuestion {
            prompt: "What is the main outcome you want instead?".into(),
            options: vec![],
            selected: None,
            free_text: String::new(),
        },
        AskQuestion {
            prompt: "Anything else the plan must not do or touch?".into(),
            options: vec![],
            selected: None,
            free_text: String::new(),
        },
    ]
}

/// Merge ask answers into a concrete feedback string for the agent.
pub fn synthesize_feedback(ask: &PlanAskState) -> String {
    let mut out = format!(
        "User feedback on the plan (originally vague: “{}”):\n",
        ask.original_comment
    );
    for (i, q) in ask.questions.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", i + 1, q.prompt));
        if let Some(sel) = q.selected {
            if let Some(opt) = q.options.get(sel) {
                out.push_str(&format!("   Answer: {opt}\n"));
            }
        }
        if !q.free_text.trim().is_empty() {
            out.push_str(&format!("   Details: {}\n", q.free_text.trim()));
        }
    }
    out.push_str("\nRevise the plan with present_plan to match this feedback.");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vague_short_generic() {
        assert!(is_vague_feedback("make it better"));
        assert!(is_vague_feedback("no"));
        assert!(is_vague_feedback("  "));
    }

    #[test]
    fn specific_feedback_not_vague() {
        assert!(!is_vague_feedback(
            "Skip the database migration and only update the TUI plan review widget."
        ));
    }

    #[test]
    fn open_review_bumps_version() {
        let mut s = PlanReviewState::default();
        s.open_review("p".into(), "t".into(), "body".into());
        assert_eq!(s.pending.as_ref().unwrap().version, 1);
        s.open_review("p".into(), "t2".into(), "body2".into());
        assert_eq!(s.pending.as_ref().unwrap().version, 2);
        assert_eq!(s.phase, PlanReviewPhase::Review);
    }

    #[test]
    fn is_answered_option_or_text() {
        let mut q = AskQuestion {
            prompt: "x".into(),
            options: vec!["a".into()],
            selected: None,
            free_text: String::new(),
        };
        assert!(!q.is_answered());
        q.selected = Some(0);
        assert!(q.is_answered());
        q.selected = None;
        q.free_text = "detail".into();
        assert!(q.is_answered());
    }

    #[test]
    fn advance_or_submit_steps() {
        let mut ask = PlanAskState {
            original_comment: "better".into(),
            questions: template_ask_questions("better"),
            question_index: 0,
            reask_count: 0,
        };
        assert_eq!(ask.step_display(), (1, 4));
        assert!(!ask.at_last_step());
        assert!(!ask.advance_or_submit());
        assert_eq!(ask.question_index, 1);
        // jump to last
        ask.question_index = ask.questions.len() - 1;
        assert!(ask.at_last_step());
        assert!(ask.advance_or_submit());
    }

    #[test]
    fn store_keeps_idle_until_promote_opens_review() {
        let mut s = PlanReviewState::default();
        s.store_plan("p".into(), "t".into(), "body".into());
        assert_eq!(s.phase, PlanReviewPhase::Idle);
        assert!(!s.takes_chat_area());
        s.promote();
        assert_eq!(s.phase, PlanReviewPhase::Review);
        assert!(s.takes_chat_area());
    }

    #[test]
    fn promote_never_clobbers_active_comment_session() {
        let mut s = PlanReviewState::default();
        s.open_review("p".into(), "t".into(), "body".into());
        s.phase = PlanReviewPhase::AwaitingComment;
        s.promote();
        assert_eq!(s.phase, PlanReviewPhase::AwaitingComment);
        assert!(s.takes_chat_area());
        s.dismiss_card();
        assert_eq!(s.phase, PlanReviewPhase::Idle);
        assert!(!s.takes_chat_area());
    }

    #[test]
    fn scroll_clamps_to_rendered_body() {
        let mut s = PlanReviewState {
            body_line_count: 20,
            body_visible: 8,
            ..PlanReviewState::default()
        };
        assert_eq!(s.max_scroll(), 12);
        s.scroll_by(50);
        assert_eq!(s.scroll, 12);
        s.scroll_by(-50);
        assert_eq!(s.scroll, 0);
    }
}
