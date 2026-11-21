//! Plan review, clarifying-questions (`PlanAsk`), and tool-approval key handlers.

use agente_core::types;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::app::App;
use crate::widgets::text_field::{edit_single_line, step_list_selection_wrap};

impl App {
    pub(super) fn handle_plan_review_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::state::{template_ask_questions, PlanReviewPhase};

        match self.state.plan_review.phase {
            PlanReviewPhase::Review => match key.code {
                KeyCode::Left | KeyCode::BackTab => {
                    step_list_selection_wrap(
                        &mut self.state.plan_review.button_index,
                        3,
                        KeyCode::Up,
                    );
                }
                KeyCode::Right | KeyCode::Tab => {
                    step_list_selection_wrap(
                        &mut self.state.plan_review.button_index,
                        3,
                        KeyCode::Down,
                    );
                }
                KeyCode::Up => self.state.plan_review.scroll_by(-1),
                KeyCode::Down => self.state.plan_review.scroll_by(1),
                KeyCode::PageUp => self.state.plan_review.scroll_by(-8),
                KeyCode::PageDown => self.state.plan_review.scroll_by(8),
                KeyCode::Char('a') | KeyCode::Char('A') => self.plan_review_accept()?,
                KeyCode::Char('r') | KeyCode::Char('R') => self.plan_review_redo()?,
                KeyCode::Char('c') | KeyCode::Char('C') => self.plan_review_comment(),
                KeyCode::Enter => match self.state.plan_review.button_index {
                    0 => self.plan_review_accept()?,
                    1 => self.plan_review_redo()?,
                    _ => self.plan_review_comment(),
                },
                KeyCode::Esc => {
                    self.state.plan_review.dismiss_card();
                    self.state.add_system_message(
                        "Plan kept · press /plan or wait for next present_plan".into(),
                    );
                }
                _ => {}
            },
            PlanReviewPhase::Asking => {
                let reask_max = 3u32;
                match key.code {
                    KeyCode::Up | KeyCode::BackTab => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            ask.go_prev();
                        }
                    }
                    KeyCode::Down => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            ask.go_next_focus();
                        }
                    }
                    KeyCode::Tab | KeyCode::Enter => {
                        self.plan_ask_next_or_submit()?;
                    }
                    KeyCode::Left | KeyCode::Right => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            let qi = ask.question_index;
                            if let Some(q) = ask.questions.get_mut(qi) {
                                if !q.options.is_empty() {
                                    let mut cur = q.selected.unwrap_or(0);
                                    let code = if key.code == KeyCode::Left {
                                        KeyCode::Up
                                    } else {
                                        KeyCode::Down
                                    };
                                    step_list_selection_wrap(&mut cur, q.options.len(), code);
                                    q.selected = Some(cur);
                                }
                            }
                        }
                    }
                    KeyCode::Esc => {
                        self.plan_review_comment();
                    }
                    KeyCode::Char('q') | KeyCode::Char('Q')
                        if key.modifiers.contains(KeyModifiers::CONTROL) =>
                    {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            if ask.reask_count >= reask_max {
                                self.state.add_system_message(
                                    "Re-ask limit reached — write a concrete comment instead."
                                        .into(),
                                );
                                self.plan_review_comment();
                            } else {
                                ask.reask_count += 1;
                                let comment = ask.original_comment.clone();
                                let n = ask.reask_count;
                                ask.questions = template_ask_questions(&comment);
                                if n > 1 {
                                    if let Some(q0) = ask.questions.get_mut(0) {
                                        q0.prompt = format!(
                                            "Different angle — what should we drop or simplify? (feedback: “{}”)",
                                            crate::widgets::truncate_cells(&comment, 36)
                                        );
                                    }
                                    if let Some(q1) = ask.questions.get_mut(1) {
                                        q1.prompt =
                                            "Name one concrete change (file, step, or goal)."
                                                .into();
                                    }
                                }
                                ask.question_index = 0;
                            }
                        }
                    }
                    _ => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            let qi = ask.question_index;
                            if let Some(q) = ask.questions.get_mut(qi) {
                                edit_single_line(&mut q.free_text, key);
                            }
                        }
                    }
                }
            }
            PlanReviewPhase::AwaitingComment | PlanReviewPhase::Idle => {}
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    fn plan_review_accept(&mut self) -> anyhow::Result<()> {
        let version = self
            .state
            .plan_review
            .pending
            .as_ref()
            .map(|p| p.version)
            .unwrap_or(1);
        let path = self
            .state
            .plan_review
            .pending
            .as_ref()
            .map(|p| p.path.clone())
            .unwrap_or_else(|| agente_core::tools::PLANS_DIR_REL.into());
        self.state.plan_review.clear();
        self.state
            .agent
            .set_mode(agente_core::types::AgentMode::Build);
        self.state.config.config.default_mode = Some("Build".into());
        self.state.persist_config();

        let msg = format!(
            "User accepted the plan ({path} v{version}). Implement it now. Follow the plan; only ask if blocked. Prefer the steps in that file."
        );
        self.state
            .add_system_message("Plan accepted · switched to Build".to_string());
        if self.state.agent.is_idle() {
            self.state.add_user_message(msg.clone());
            self.state
                .session
                .conversation
                .push(agente_core::types::Message {
                    role: agente_core::types::Role::User,
                    content: msg,
                    tool_calls: None,
                    tool_call_id: None,
                    thinking: None,
                    thinking_signature: None,
                    continuation: None,
                    attachments: Vec::new(),
                });
            self.start_chat_turn()?;
        } else {
            self.state
                .agent
                .queue_message(crate::state::QueuedMessage::new(msg));
        }
        Ok(())
    }

    fn plan_review_redo(&mut self) -> anyhow::Result<()> {
        let version = self
            .state
            .plan_review
            .pending
            .as_ref()
            .map(|p| p.version)
            .unwrap_or(1);
        self.state.plan_review.phase = crate::state::PlanReviewPhase::Idle;
        self.state
            .agent
            .set_mode(agente_core::types::AgentMode::Plan);
        let msg = format!(
            "User rejected plan v{version}. Produce a different plan via present_plan. Do not reuse the same structure or steps."
        );
        self.state.add_system_message("Plan redo requested".into());
        self.submit_plan_feedback(msg)?;
        Ok(())
    }

    fn plan_review_comment(&mut self) {
        self.state.plan_review.phase = crate::state::PlanReviewPhase::AwaitingComment;
        self.state.plan_review.ask = None;
        self.state.input.input_text.clear();
        self.state.input.input_cursor = 0;
        self.state.ui.needs_render = true;
    }

    pub(in crate::app) fn submit_plan_feedback(&mut self, feedback: String) -> anyhow::Result<()> {
        self.state
            .agent
            .set_mode(agente_core::types::AgentMode::Plan);
        if !self.state.agent.is_idle() {
            self.state
                .agent
                .queue_message(crate::state::QueuedMessage::new(feedback));
            return Ok(());
        }
        self.state.add_user_message(feedback.clone());
        self.state
            .session
            .conversation
            .push(agente_core::types::Message {
                role: agente_core::types::Role::User,
                content: feedback,
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: Vec::new(),
            });
        self.start_chat_turn()
    }

    fn plan_ask_next_or_submit(&mut self) -> anyhow::Result<()> {
        use crate::state::{synthesize_feedback, PlanReviewPhase};

        let should_submit = if let Some(ask) = self.state.plan_review.ask.as_mut() {
            ask.advance_or_submit()
        } else {
            false
        };

        if should_submit {
            if let Some(ask) = self.state.plan_review.ask.clone() {
                let feedback = synthesize_feedback(&ask);
                self.state.plan_review.phase = PlanReviewPhase::Idle;
                self.state.plan_review.ask = None;
                self.submit_plan_feedback(feedback)?;
            }
        }
        Ok(())
    }

    pub(super) fn handle_approval_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let action = match key.code {
            KeyCode::Enter | KeyCode::Char('y') | KeyCode::Char('Y') => {
                Some(types::ApprovalAction::ApproveOnce)
            }
            KeyCode::Char('a') | KeyCode::Char('A') | KeyCode::Char('s') | KeyCode::Char('S') => {
                Some(types::ApprovalAction::ApproveAll)
            }
            KeyCode::Char('n')
            | KeyCode::Char('N')
            | KeyCode::Char('d')
            | KeyCode::Char('D')
            | KeyCode::Esc => Some(types::ApprovalAction::Deny),
            _ => None,
        };

        if let Some(action) = action {
            self.handle_approval_action(action)?;
        }
        Ok(())
    }

    /// Process an approval decision (from keyboard shortcut or mouse click).
    pub(in crate::app) fn handle_approval_action(
        &mut self,
        action: types::ApprovalAction,
    ) -> anyhow::Result<()> {
        if matches!(action, types::ApprovalAction::ApproveAll) {
            self.state.agent.set_auto_approve_runtime(true);
        }
        let request_id = self
            .state
            .agent
            .current_approval()
            .map(|request| request.request_id.clone());
        match request_id {
            Some(id) => {
                let responded = self.approval_broker.respond(&id, action);
                if responded {
                    self.state.agent.pop_approval();
                } else {
                    tracing::error!(request_id = %id, "Approval request already resolved");
                    self.state.agent.pop_approval();
                }
            }
            None => {
                self.state.agent.pop_approval();
            }
        }
        self.state.ui.needs_render = true;
        Ok(())
    }
}
