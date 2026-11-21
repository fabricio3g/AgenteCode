//! Keyboard routing, global shortcuts, paste ownership, and modal dispatch.

mod composer;
mod modals;
mod plan;
mod session;
#[cfg(test)]
mod tests;

use std::time::Duration;

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::App;
use crate::command_palette;
use crate::state::{modal_owner, ModalOwner};
use crate::widgets::text_field::step_list_selection_wrap;

/// API keys are single opaque tokens. Clipboard payloads often include a
/// trailing newline, especially when copied from a terminal or dashboard.
fn normalize_api_key_paste(text: &str) -> String {
    text.split_whitespace().collect()
}

impl App {
    fn insert_owned_paste(&mut self, text: &str) {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        if normalized.is_empty() {
            return;
        }
        match modal_owner(&self.state) {
            ModalOwner::None
            | ModalOwner::PlanComment
            | ModalOwner::AtPicker
            | ModalOwner::SlashPicker
            | ModalOwner::Welcome => self.insert_paste(&normalized),
            ModalOwner::PlanAsk => {
                if let Some(ask) = self.state.plan_review.ask.as_mut() {
                    let index = ask.question_index;
                    if let Some(question) = ask.questions.get_mut(index) {
                        question.free_text.push_str(&normalized);
                        self.state.ui.needs_render = true;
                    }
                }
            }
            ModalOwner::Connect => match &mut self.state.config.connect_screen {
                crate::state::ConnectScreen::SelectProvider { query, selected } => {
                    query.push_str(&normalized);
                    *selected = 0;
                    self.state.ui.needs_render = true;
                }
                crate::state::ConnectScreen::EnterKey { .. } => {
                    let key = normalize_api_key_paste(&normalized);
                    if !key.is_empty() {
                        self.state.config.connect_key_input.push_str(&key);
                        if let crate::state::ConnectScreen::EnterKey { error, .. } =
                            &mut self.state.config.connect_screen
                        {
                            error.clear();
                        }
                    }
                    self.state.ui.needs_render = true;
                }
                crate::state::ConnectScreen::Closed => {}
            },
            ModalOwner::ModelSelector => {
                self.state.input.model_selector_query.push_str(&normalized);
                self.state.input.model_selector_selected = 0;
                self.state.ui.needs_render = true;
            }
            ModalOwner::CommandPalette => {
                self.state.input.command_palette_query.push_str(&normalized);
                self.state.input.command_palette_selected = 0;
                self.state.ui.needs_render = true;
            }
            ModalOwner::SessionPicker => {
                if self.state.picker.session_picker_folder_active {
                    self.state
                        .picker
                        .session_picker_folder_input
                        .push_str(&normalized);
                } else {
                    self.state.picker.session_picker_query.push_str(&normalized);
                    self.state.picker.session_picker_selected = 0;
                }
                self.state.ui.needs_render = true;
            }
            ModalOwner::SubagentModels => {
                if let Some(edit) = self.state.input.subagent_model_edit.as_mut() {
                    let single_line = normalized.replace('\n', " ");
                    edit.text.push_str(&single_line);
                    self.state.ui.needs_render = true;
                }
            }
            ModalOwner::Approval
            | ModalOwner::PlanReview
            | ModalOwner::DiffPeek
            | ModalOwner::Doctor
            | ModalOwner::Help
            | ModalOwner::Subagents
            | ModalOwner::SubagentDetail
            | ModalOwner::Board
            | ModalOwner::Settings
            | ModalOwner::Skills
            | ModalOwner::Mcp
            | ModalOwner::MediaConsent
            | ModalOwner::MessageActions
            | ModalOwner::ProcessView
            | ModalOwner::ThinkingSelector => {}
        }
    }

    pub(super) fn handle_events_with_timeout(&mut self, timeout: Duration) -> anyhow::Result<()> {
        let mut events = 0usize;
        loop {
            let poll_timeout = if events == 0 { timeout } else { Duration::ZERO };
            if !crossterm::event::poll(poll_timeout)? {
                break;
            }
            events += 1;
            self.handle_terminal_event(crossterm::event::read()?)?;
            if events >= 64 {
                break; // keep the frame responsive under a flooded queue
            }
        }
        Ok(())
    }

    pub(crate) fn handle_terminal_event(&mut self, event: Event) -> anyhow::Result<()> {
        match event {
            Event::Key(key) => {
                if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
                    self.state.ui.needs_render = true;
                    self.handle_key(key)?;
                }
            }
            Event::Mouse(mouse) => {
                self.handle_mouse(mouse)?;
            }
            Event::Paste(text) => {
                self.insert_owned_paste(&text);
            }
            Event::Resize(_, _) => {
                self.state.ui.clear_chat_render_cache();
                if self.state.ui.scroll_drag.take().is_some() {
                    self.state.ui.suppress_click_on_up = true;
                }
                self.state.ui.needs_render = true;
            }
            _ => {}
        }
        Ok(())
    }

    /// Shortcuts that fire regardless of which surface has focus.
    fn handle_global_shortcut(&mut self, key: KeyEvent) -> anyhow::Result<bool> {
        match key {
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('c'),
                ..
            } => {
                self.flush_state_to_disk();
                self.state.ui.should_quit = true;
                return Ok(true);
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('l'),
                ..
            } => {
                self.execute_command(command_palette::Command::ClearConversation)?;
                return Ok(true);
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('b'),
                ..
            } => {
                self.state.show_changes_in_chat();
                return Ok(true);
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('v'),
                ..
            } => {
                match crate::clipboard::paste() {
                    Ok(text) if !text.is_empty() => self.insert_owned_paste(&text),
                    Ok(_) => {
                        self.attach_clipboard_image();
                    }
                    Err(_) if self.attach_clipboard_image() => {}
                    Err(arboard::Error::ContentNotAvailable) => {}
                    Err(error) => {
                        tracing::debug!(%error, "clipboard read failed");
                        self.state
                            .ui
                            .show_toast("Clipboard unavailable".to_string());
                    }
                }
                return Ok(true);
            }
            _ => {}
        }

        Ok(false)
    }

    /// Route a key to whichever modal currently owns the screen.
    fn handle_modal_key(&mut self, key: KeyEvent) -> anyhow::Result<bool> {
        match modal_owner(&self.state) {
            ModalOwner::Approval => {
                self.handle_approval_key(key)?;
                return Ok(true);
            }
            ModalOwner::PlanAsk | ModalOwner::PlanReview => {
                self.handle_plan_review_key(key)?;
                return Ok(true);
            }
            ModalOwner::PlanComment => match key.code {
                KeyCode::PageUp => {
                    self.state.plan_review.scroll_by(-8);
                    return Ok(true);
                }
                KeyCode::PageDown => {
                    self.state.plan_review.scroll_by(8);
                    return Ok(true);
                }
                KeyCode::Esc => {
                    self.state.plan_review.phase = crate::state::PlanReviewPhase::Review;
                    self.state.input.input_text.clear();
                    self.state.input.input_cursor = 0;
                    return Ok(true);
                }
                _ => {}
            },
            ModalOwner::DiffPeek => {
                let ui = &mut self.state.ui;
                match key.code {
                    KeyCode::Esc => ui.diff_peek = None,
                    KeyCode::Up => ui.scroll_diff_peek(-1),
                    KeyCode::Down => ui.scroll_diff_peek(1),
                    KeyCode::PageUp => ui.scroll_diff_peek(-8),
                    KeyCode::PageDown => ui.scroll_diff_peek(8),
                    KeyCode::Home => ui.diff_peek_scroll.scroll_to_top(),
                    KeyCode::End => ui.diff_peek_scroll.scroll_to_bottom(false),
                    _ => {}
                }
                return Ok(true);
            }
            ModalOwner::Doctor => {
                match key.code {
                    KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
                        self.state.input.show_doctor = false;
                        self.state.input.doctor_checks.clear();
                        self.state.ui.needs_render = true;
                    }
                    KeyCode::Up => {
                        self.state.input.doctor_scroll.scroll_by(-1);
                        self.state.ui.needs_render = true;
                    }
                    KeyCode::Down => {
                        self.state.input.doctor_scroll.scroll_by(1);
                        self.state.ui.needs_render = true;
                    }
                    _ => {}
                }
                return Ok(true);
            }
            ModalOwner::Help => {
                match key.code {
                    KeyCode::Esc | KeyCode::F(1) | KeyCode::Char('?') => {
                        self.state.ui.show_help = false;
                    }
                    KeyCode::Up => self.state.ui.scroll_help(-1),
                    KeyCode::Down => self.state.ui.scroll_help(1),
                    KeyCode::PageUp => self.state.ui.scroll_help(-8),
                    KeyCode::PageDown => self.state.ui.scroll_help(8),
                    KeyCode::Home => {
                        self.state.ui.help_scroll.scroll_to_top();
                        self.state.ui.needs_render = true;
                    }
                    KeyCode::End => self.state.ui.scroll_help(i32::MAX / 2),
                    _ => {}
                }
                return Ok(true);
            }
            ModalOwner::SessionPicker => {
                self.handle_session_picker_key(key)?;
                return Ok(true);
            }
            ModalOwner::SubagentDetail => {
                self.handle_subagent_detail_key(key)?;
                return Ok(true);
            }
            ModalOwner::Subagents => {
                self.handle_subagents_key(key)?;
                return Ok(true);
            }
            ModalOwner::Connect => {
                self.handle_connect_key(key)?;
                return Ok(true);
            }
            ModalOwner::ThinkingSelector => {
                self.handle_thinking_selector_key(key)?;
                return Ok(true);
            }
            ModalOwner::ModelSelector => {
                self.handle_model_selector_key(key)?;
                return Ok(true);
            }
            ModalOwner::SubagentModels => {
                self.handle_subagent_models_key(key)?;
                return Ok(true);
            }
            ModalOwner::Settings => {
                self.handle_settings_key(key)?;
                return Ok(true);
            }
            ModalOwner::Skills => {
                self.handle_skills_key(key)?;
                return Ok(true);
            }
            ModalOwner::Mcp => {
                self.handle_mcp_key(key)?;
                return Ok(true);
            }
            ModalOwner::Board => {
                match key.code {
                    KeyCode::Esc => {
                        self.state.input.show_board = false;
                        self.state.input.board_scroll.scroll_to_top();
                    }
                    KeyCode::Char('s') => self.state.toggle_swarm(),
                    KeyCode::Up => self.state.input.board_scroll.scroll_by(-1),
                    KeyCode::Down => self.state.input.board_scroll.scroll_by(1),
                    KeyCode::PageUp => self.state.input.board_scroll.scroll_by(-4),
                    KeyCode::PageDown => self.state.input.board_scroll.scroll_by(4),
                    KeyCode::Home => self.state.input.board_scroll.scroll_to_top(),
                    _ => {}
                }
                self.state.ui.needs_render = true;
                return Ok(true);
            }
            ModalOwner::MediaConsent => {
                self.handle_media_consent_key(key);
                return Ok(true);
            }
            ModalOwner::MessageActions => {
                self.handle_message_actions_key(key)?;
                return Ok(true);
            }
            ModalOwner::ProcessView => {
                self.handle_process_view_key(key)?;
                return Ok(true);
            }
            ModalOwner::CommandPalette => {
                self.handle_command_palette_key(key)?;
                return Ok(true);
            }
            ModalOwner::AtPicker
            | ModalOwner::SlashPicker
            | ModalOwner::Welcome
            | ModalOwner::None => {}
        }
        Ok(false)
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        if self.handle_global_shortcut(key)? {
            return Ok(());
        }
        if self.handle_modal_key(key)? {
            return Ok(());
        }

        // Session tabs: F2 opens one, Ctrl+PgUp/PgDn switch.
        match (key.code, key.modifiers) {
            (KeyCode::F(2), KeyModifiers::NONE) => {
                self.open_new_tab();
                return Ok(());
            }
            (KeyCode::PageDown, KeyModifiers::CONTROL) => {
                self.cycle_tab(1);
                return Ok(());
            }
            (KeyCode::PageUp, KeyModifiers::CONTROL) => {
                self.cycle_tab(-1);
                return Ok(());
            }
            _ => {}
        }

        // Every Ctrl+Tab spelling toggles Plan/Build mode.
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && !key.modifiers.contains(KeyModifiers::ALT)
            && matches!(key.code, KeyCode::Tab | KeyCode::BackTab)
        {
            self.toggle_plan_build_mode();
            return Ok(());
        }

        // Plain Tab triggers completions; Shift+Tab toggles plan/build mode.
        if key.code == KeyCode::Tab
            && !key.modifiers.contains(KeyModifiers::SHIFT)
            && !key.modifiers.contains(KeyModifiers::CONTROL)
        {
            if self.state.input.show_at_picker {
                self.complete_selected_at_file();
                return Ok(());
            }
            if self.state.input.input_text.starts_with('/') {
                if self.state.input.show_slash_picker {
                    self.complete_selected_slash_command();
                } else {
                    self.try_autocomplete_slash_command();
                }
                return Ok(());
            }
        }

        if self.state.input.show_at_picker && self.handle_at_picker_key(key)? {
            return Ok(());
        }

        if self.state.input.show_slash_picker {
            self.handle_slash_picker_key(key)?;
            return Ok(());
        }

        // Welcome home: arrow navigation + enter when composer is empty.
        if self.state.ui.show_welcome_screen
            && self.state.input.input_text.is_empty()
            && self.handle_welcome_key(key)?
        {
            return Ok(());
        }

        self.handle_composer_key(key)
    }

    /// Welcome button keys. Returns true when the key was handled.
    fn handle_welcome_key(&mut self, key: KeyEvent) -> anyhow::Result<bool> {
        use crate::widgets::welcome;

        let n = welcome::action_count();
        if n == 0 {
            return Ok(false);
        }
        let sel = self.state.ui.welcome_selected.min(n - 1);
        self.state.ui.welcome_selected = sel;
        let nav_code = match key.code {
            KeyCode::Left | KeyCode::Up => Some(KeyCode::Up),
            KeyCode::Right | KeyCode::Down => Some(KeyCode::Down),
            _ => None,
        };
        if let Some(code) = nav_code {
            step_list_selection_wrap(&mut self.state.ui.welcome_selected, n, code);
            self.state.ui.needs_render = true;
            return Ok(true);
        }
        if key.code == KeyCode::Enter {
            if let Some(cmd) = welcome::action_at(self.state.ui.welcome_selected) {
                self.execute_command(cmd)?;
            }
            return Ok(true);
        }
        Ok(false)
    }
}
