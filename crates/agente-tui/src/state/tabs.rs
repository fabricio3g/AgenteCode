//! Session tabs: several sessions open at once, each with its own agent.
//!
//! The active tab lives in [`AppState`] as always, so every widget and
//! handler keeps working on `state.session` / `state.agent`. A background
//! tab is a [`TabState`] holding the same per-session parts; switching tabs
//! swaps them, and an agent event for a background tab swaps it in just
//! long enough to apply the event — so background turns keep running.

use super::{AgentRuntimeState, AppState, ConfigState, PlanReviewState, SessionState, TodoState};
use agente_core::cancellation::AbortController;

/// The per-session parts of [`AppState`] (plus the composer draft and chat
/// position, so each tab comes back exactly as it was left).
pub struct TabState {
    pub agent: AgentRuntimeState,
    pub session: SessionState,
    pub todo: TodoState,
    pub plan_review: PlanReviewState,
    pub cancel_tx: AbortController,
    pub subagent_registry: agente_core::subagent::SubagentRegistry,
    pub config: ConfigState,
    pub input_text: String,
    pub input_cursor: usize,
    pub chat_scroll: usize,
    pub chat_auto_scroll: bool,
    pub scroll_target: Option<usize>,
    pub show_welcome_screen: bool,
}

impl TabState {
    /// A fresh session in `state`'s project, inheriting its model, mode and
    /// thinking level (what "new tab" means).
    pub fn fresh_like(state: &AppState) -> Self {
        let project_dir = state.session.project_dir.clone();
        let agent = AgentRuntimeState {
            mode: state.agent.mode,
            auto_mode: state.agent.auto_mode,
            current_turn_mode: state.agent.mode,
            thinking_level: state.agent.thinking_level.clone(),
            auto_approve_persistent: state.agent.auto_approve_persistent,
            shared_permission_engine:
                agente_core::permissions::shared_permission_engine_with_config(
                    state.agent.mode,
                    &state.config.config.auto_approve,
                    &project_dir,
                ),
            ..AgentRuntimeState::default()
        };
        Self {
            agent,
            session: SessionState::new(project_dir),
            todo: TodoState::default(),
            plan_review: PlanReviewState::default(),
            cancel_tx: AbortController::new(),
            subagent_registry: agente_core::subagent::SubagentRegistry::new(),
            config: state.config.clone(),
            input_text: String::new(),
            input_cursor: 0,
            chat_scroll: 0,
            chat_auto_scroll: true,
            scroll_target: None,
            show_welcome_screen: false,
        }
    }

    /// Exchange these parts with the ones in `state`.
    pub fn swap_with(&mut self, state: &mut AppState) {
        use std::mem::swap;
        swap(&mut self.agent, &mut state.agent);
        swap(&mut self.session, &mut state.session);
        swap(&mut self.todo, &mut state.todo);
        swap(&mut self.plan_review, &mut state.plan_review);
        swap(&mut self.cancel_tx, &mut state.cancel_tx);
        swap(&mut self.subagent_registry, &mut state.subagent_registry);
        swap(&mut self.config, &mut state.config);
        swap(&mut self.input_text, &mut state.input.input_text);
        swap(&mut self.input_cursor, &mut state.input.input_cursor);
        swap(&mut self.chat_scroll, &mut state.ui.chat_scroll);
        swap(&mut self.chat_auto_scroll, &mut state.ui.chat_auto_scroll);
        swap(&mut self.scroll_target, &mut state.ui.scroll_target);
        swap(
            &mut self.show_welcome_screen,
            &mut state.ui.show_welcome_screen,
        );
    }

    /// Label for the tab strip.
    pub fn label(&self, unseen: bool) -> TabLabel {
        tab_label(&self.session, &self.agent, unseen)
    }
}

/// What a tab shows in the strip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabLabel {
    pub title: String,
    pub status: TabStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabStatus {
    Idle,
    /// A turn or a subagent is running.
    Working,
    /// Waiting for a tool approval.
    NeedsApproval,
    /// Finished while in the background; not looked at yet.
    Unseen,
}

/// The strip as the renderer sees it (refreshed by the app every frame).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TabStrip {
    pub tabs: Vec<TabLabel>,
    pub active: usize,
}

impl TabStrip {
    /// The strip only shows once there is more than one tab.
    pub fn visible(&self) -> bool {
        self.tabs.len() > 1
    }
}

pub fn tab_label(session: &SessionState, agent: &AgentRuntimeState, unseen: bool) -> TabLabel {
    let title = if !session.title.trim().is_empty() {
        session.title.trim().to_string()
    } else {
        let first = agente_core::session::first_user_prompt(&session.chat_history);
        let first = first.lines().next().unwrap_or("").trim().to_string();
        if first.is_empty() {
            "New session".to_string()
        } else {
            first
        }
    };
    let status = if agent.has_pending_approval() {
        TabStatus::NeedsApproval
    } else if !agent.is_idle() {
        TabStatus::Working
    } else if unseen {
        TabStatus::Unseen
    } else {
        TabStatus::Idle
    };
    TabLabel { title, status }
}
