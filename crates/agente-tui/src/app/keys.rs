//! Keyboard routing and overlay key handlers.

use agente_core::session;
use agente_core::types::{self, AgentState, ClickKind};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use std::time::Duration;

use super::{util, App};
use crate::command_palette;
use crate::connect;
use crate::model_selector;
use crate::session_picker::list_directory;
use crate::state::{modal_owner, ModalOwner};

/// Whether this modifier combo should insert a printable character into free text.
///
/// Allows bare keys, Shift, Alt, and AltGr (Ctrl+Alt). Pure Ctrl is reserved for
/// shortcuts (Ctrl+A/E/K/…); those arms match first via exact CONTROL checks.
fn is_text_char_modifiers(m: KeyModifiers) -> bool {
    let ctrl = m.contains(KeyModifiers::CONTROL);
    let alt = m.contains(KeyModifiers::ALT);
    // Pure Control → shortcut, not text
    if ctrl && !alt {
        return false;
    }
    true
}

/// Map OS key to the character we insert (layout / Alt helpers).
///
/// On many Spanish/Latin layouts users expect Alt+Q for `@`. The terminal may
/// report either `Char('@')` with Alt/AltGr, or `Char('q')` with Alt — both work.
fn resolve_text_char(c: char, m: KeyModifiers) -> char {
    let alt = m.contains(KeyModifiers::ALT);
    let ctrl = m.contains(KeyModifiers::CONTROL);
    // Alt+Q → @ when the OS still reports 'q' (not already '@')
    if alt && !ctrl && matches!(c, 'q' | 'Q') {
        return '@';
    }
    c
}

/// API keys are single opaque tokens. Clipboard payloads often include a
/// trailing newline, especially when copied from a terminal or dashboard.
fn normalize_api_key_paste(text: &str) -> String {
    text.split_whitespace().collect()
}

impl App {
    fn insert_input_char(&mut self, c: char) {
        if c == '/' && self.state.input.input_text.is_empty() && self.state.input.input_cursor == 0
        {
            self.state.input.show_slash_picker = true;
            self.state.input.slash_picker_selected = 0;
            self.state.input.close_at_picker();
        }
        let byte_idx =
            util::char_to_byte(&self.state.input.input_text, self.state.input.input_cursor);
        self.state.input.input_text.insert(byte_idx, c);
        self.state.input.input_cursor += 1;
        self.refresh_at_picker_from_input();
    }

    /// Insert pasted text into the composer without submitting.
    /// Bracketed paste delivers the whole payload (including newlines) as one event.
    pub(super) fn insert_paste(&mut self, text: &str) {
        // Normalize Windows / old Mac newlines; never treat as Enter-submit.
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        if normalized.is_empty() {
            return;
        }
        // A dropped or pasted image/audio/video/PDF path attaches the file.
        if self.attach_pasted_path(&normalized) {
            return;
        }
        // A big paste is held out of the composer behind a one-line chip; the
        // payload is spliced back in at submit. Pasting a file used to dump the
        // whole thing into an 8-row box.
        if crate::state::paste_wants_chip(&normalized) {
            let placeholder = self.state.input.stash_paste(&normalized);
            let byte_idx =
                util::char_to_byte(&self.state.input.input_text, self.state.input.input_cursor);
            self.state
                .input
                .input_text
                .insert_str(byte_idx, &placeholder);
            self.state.input.input_cursor += placeholder.chars().count();
            self.state.ui.needs_render = true;
            return;
        }
        if normalized.starts_with('/')
            && self.state.input.input_text.is_empty()
            && self.state.input.input_cursor == 0
        {
            self.state.input.show_slash_picker = true;
            self.state.input.slash_picker_selected = 0;
            self.state.input.close_at_picker();
        }
        let byte_idx =
            util::char_to_byte(&self.state.input.input_text, self.state.input.input_cursor);
        self.state
            .input
            .input_text
            .insert_str(byte_idx, &normalized);
        self.state.input.input_cursor += normalized.chars().count();
        self.refresh_at_picker_from_input();
        self.state.ui.needs_render = true;
    }

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
            ModalOwner::PlanAsk | ModalOwner::PlanReview => {
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
            ModalOwner::Approval
            | ModalOwner::DiffPeek
            | ModalOwner::Doctor
            | ModalOwner::Help
            | ModalOwner::Subagents
            | ModalOwner::SubagentDetail
            | ModalOwner::SubagentModels
            | ModalOwner::Settings
            | ModalOwner::Skills
            | ModalOwner::Mcp
            | ModalOwner::MediaConsent
            | ModalOwner::MessageActions
            | ModalOwner::ProcessView
            | ModalOwner::ThinkingSelector => {}
        }
    }

    /// Open/update/close the `@` file picker based on cursor context.
    fn refresh_at_picker_from_input(&mut self) {
        use crate::at_file_picker::{active_at_mention, list_project_files};

        // Slash mode owns the picker space
        if self.state.input.input_text.starts_with('/') {
            self.state.input.close_at_picker();
            return;
        }

        let text = self.state.input.input_text.clone();
        let cursor = self.state.input.input_cursor;
        if let Some((anchor, query)) = active_at_mention(&text, cursor) {
            if !self.state.input.show_at_picker || self.state.input.at_file_cache.is_empty() {
                self.state.input.at_file_cache =
                    list_project_files(&self.state.session.project_dir);
            }
            self.state.input.show_at_picker = true;
            self.state.input.at_picker_anchor = anchor;
            self.state.input.at_picker_query = query;
            self.state.input.at_picker_selected = 0;
            self.state.input.show_slash_picker = false;
        } else if self.state.input.show_at_picker {
            self.state.input.close_at_picker();
        }
    }

    fn complete_selected_at_file(&mut self) {
        use crate::at_file_picker::filter_files;

        if !self.state.input.show_at_picker {
            return;
        }
        let matches = filter_files(
            &self.state.input.at_file_cache,
            &self.state.input.at_picker_query,
        );
        if matches.is_empty() {
            return;
        }
        let idx = self
            .state
            .input
            .at_picker_selected
            .min(matches.len().saturating_sub(1));
        let path = matches[idx].clone();
        let anchor = self.state.input.at_picker_anchor;
        let cursor = self.state.input.input_cursor;
        let chars: Vec<char> = self.state.input.input_text.chars().collect();
        // `@` on an image/audio/video/PDF attaches the file instead of
        // pasting its bytes into the prompt as text.
        let full = std::path::Path::new(&self.state.session.project_dir).join(&path);
        if let Some(request) = Self::media_request_for_path(&full, false) {
            let before: String = chars[..anchor.min(chars.len())].iter().collect();
            let after: String = chars[cursor.min(chars.len())..].iter().collect();
            self.state.input.input_cursor = before.chars().count();
            self.state.input.input_text = format!("{before}{after}");
            self.state.input.close_at_picker();
            self.request_media(request);
            return;
        }
        // Replace from `@` through cursor with `@path`
        let before: String = chars[..anchor.min(chars.len())].iter().collect();
        let after: String = chars[cursor.min(chars.len())..].iter().collect();
        let inserted = format!("@{path}");
        self.state.input.input_text = format!("{before}{inserted}{after}");
        self.state.input.input_cursor = before.chars().count() + inserted.chars().count();
        self.state.input.close_at_picker();
    }
    pub(super) fn handle_events_with_timeout(&mut self, timeout: Duration) -> anyhow::Result<()> {
        // First event waits up to `timeout`; after that, drain whatever is
        // already queued so fast typing never lags a frame behind (and a
        // burst never gets interleaved with a paint mid-word). Repeat events
        // (held keys) are real input and must not be dropped.
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
                // draw() autoresizes the terminal; invalidate geometry now,
                // including while idle or a modal owns keyboard focus.
                self.state.ui.clear_chat_render_cache();
                self.state.ui.needs_render = true;
            }
            _ => {}
        }
        Ok(())
    }

    /// Shortcuts that fire regardless of which surface has focus.
    ///
    /// `Ok(true)` means the key was consumed. Split out of `handle_key`,
    /// which was a single ~790-line match covering globals, modal dispatch
    /// and composer routing at once.
    fn handle_global_shortcut(&mut self, key: KeyEvent) -> anyhow::Result<bool> {
        // Global shortcuts that work even when modals are open
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
                self.state.session.chat_history.clear();
                self.state.ui.clear_chat_render_cache();
                self.state.agent.streaming_text.clear();
                self.state.session.modified_files.clear();
                self.state.session.file_versions.clear();
                self.state.session.conversation.clear();
                self.state.ui.expanded_message_ids.clear();
                self.state.ui.expanded_thinking_ids.clear();
                self.state.ui.collapse_all_tools();
                self.state.ui.expanded_groups.clear();
                self.state.ui.toast = None;
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
            // Explicit clipboard read. There was no Ctrl+V binding at all:
            // paste worked only through the terminal's bracketed-paste
            // (`Event::Paste`), so in any terminal or multiplexer without it,
            // Ctrl+V silently did nothing.
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('v'),
                ..
            } => {
                match crate::clipboard::paste() {
                    Ok(text) if !text.is_empty() => self.insert_owned_paste(&text),
                    // No text: maybe a screenshot.
                    Ok(_) => {
                        self.attach_clipboard_image();
                    }
                    Err(_) if self.attach_clipboard_image() => {}
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
    ///
    /// `Ok(true)` means a modal consumed the key and normal composer/chat
    /// routing must not run.
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
                if key.code == KeyCode::Esc {
                    self.state.ui.diff_peek = None;
                }
                return Ok(true);
            }
            ModalOwner::Doctor => {
                match key.code {
                    KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
                        self.state.input.show_doctor = false;
                        self.state.ui.needs_render = true;
                    }
                    KeyCode::Up => {
                        self.state.input.doctor_scroll =
                            self.state.input.doctor_scroll.saturating_sub(1);
                        self.state.ui.needs_render = true;
                    }
                    KeyCode::Down => {
                        self.state.input.doctor_scroll =
                            self.state.input.doctor_scroll.saturating_add(1);
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
                        self.state.ui.help_scroll = 0;
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

        // Session tabs: F2 opens one, Ctrl+PgUp/PgDn switch (Alt stays free
        // for typing and Ctrl+T is the thinking picker).
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

        // Every Ctrl+Tab spelling toggles Plan/Build mode. Handle it before
        // completion and welcome-button routing so the hero can never consume
        // the modified Tab as ordinary button navigation. Some terminals send
        // Ctrl+Shift+Tab as Ctrl+BackTab, so accept both key codes.
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && !key.modifiers.contains(KeyModifiers::ALT)
            && matches!(key.code, KeyCode::Tab | KeyCode::BackTab)
        {
            self.toggle_plan_build_mode();
            return Ok(());
        }

        // Plain Tab triggers completions; Shift+Tab toggles plan/build mode, so
        // it must not be consumed here. (Shift+Tab arrives as `BackTab`, or as
        // `SHIFT + Tab` on some terminals — both are handled below.)
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

        // Welcome home: arrow/tab navigation + enter when composer is empty
        if self.state.ui.show_welcome_screen
            && self.state.input.input_text.is_empty()
            && self.handle_welcome_key(key)?
        {
            return Ok(());
        }

        match key {
            // Shift+Tab toggles Plan/Build. Terminals encode it as `BackTab`
            // (with or without the SHIFT modifier) or as `SHIFT + Tab`; accept
            // all spellings so it never silently falls through.
            KeyEvent {
                code: KeyCode::BackTab,
                modifiers,
                ..
            } if !modifiers.contains(KeyModifiers::CONTROL) => {
                self.toggle_plan_build_mode();
            }
            KeyEvent {
                modifiers: KeyModifiers::SHIFT,
                code: KeyCode::Tab,
                ..
            } => {
                self.toggle_plan_build_mode();
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('p'),
                ..
            } => {
                self.state.input.show_command_palette = true;
                self.state.input.command_palette_query.clear();
                self.state.input.command_palette_selected = 0;
            }
            // Subagent popup hint: `ctrl+x view subagents`.
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('x'),
                ..
            } => {
                self.state.input.open_subagents();
                self.state.ui.needs_render = true;
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('n'),
                ..
            } => {
                self.start_new_session();
            }
            KeyEvent {
                code: KeyCode::F(1),
                ..
            } => {
                self.state.ui.show_help = !self.state.ui.show_help;
            }
            KeyEvent {
                code: KeyCode::Char('?'),
                ..
            } if self.state.input.input_text.is_empty() => {
                self.state.ui.show_help = !self.state.ui.show_help;
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('o'),
                ..
            } => {
                self.open_editor_for_input()?;
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('s'),
                ..
            } => {
                self.open_session_picker();
            }
            KeyEvent {
                code: KeyCode::Up,
                modifiers: KeyModifiers::SHIFT,
                ..
            } => {
                self.state.scroll_up(1);
            }
            KeyEvent {
                code: KeyCode::Up,
                modifiers: KeyModifiers::CONTROL,
                ..
            } => {
                self.state.glide_by(-5);
            }
            KeyEvent {
                code: KeyCode::Up,
                modifiers: KeyModifiers::NONE,
                ..
            } => {
                // An empty composer pulls the last queued message back to
                // edit before stepping into history.
                if self.state.input.input_text.is_empty() {
                    if let Some(queued) = self.state.agent.pop_unsent() {
                        self.state.input.input_cursor = queued.display.chars().count();
                        self.state.input.input_text = queued.display;
                        return Ok(());
                    }
                }
                self.state.history_up();
            }
            KeyEvent {
                code: KeyCode::Down,
                modifiers: KeyModifiers::SHIFT,
                ..
            } => {
                self.state.scroll_down(1);
            }
            KeyEvent {
                code: KeyCode::Down,
                modifiers: KeyModifiers::CONTROL,
                ..
            } => {
                self.state.glide_by(5);
            }
            KeyEvent {
                code: KeyCode::Down,
                modifiers: KeyModifiers::NONE,
                ..
            } => {
                self.state.history_down();
            }
            KeyEvent {
                code: KeyCode::PageUp,
                modifiers: KeyModifiers::NONE,
                ..
            } => {
                let page = self.state.ui.chat_visible_height.saturating_sub(2);
                self.state.glide_by(-(page as isize));
            }
            KeyEvent {
                code: KeyCode::PageDown,
                modifiers: KeyModifiers::NONE,
                ..
            } => {
                let page = self.state.ui.chat_visible_height.saturating_sub(2);
                self.state.glide_by(page as isize);
            }
            KeyEvent {
                code: KeyCode::Char('g'),
                modifiers: KeyModifiers::SHIFT,
                ..
            } => {
                self.state.ui.chat_auto_scroll = true;
            }
            KeyEvent {
                code: KeyCode::Home,
                modifiers: KeyModifiers::SHIFT,
                ..
            } => {
                self.state.ui.scroll_to_top();
            }
            KeyEvent {
                code: KeyCode::End,
                modifiers: KeyModifiers::SHIFT,
                ..
            } => {
                self.state.ui.chat_auto_scroll = true;
            }
            KeyEvent {
                code: KeyCode::Left,
                modifiers: KeyModifiers::NONE,
                ..
            } => {
                if self.state.input.input_cursor > 0 {
                    self.state.input.input_cursor -= 1;
                }
                self.refresh_at_picker_from_input();
            }
            KeyEvent {
                code: KeyCode::Right,
                modifiers: KeyModifiers::NONE,
                ..
            } => {
                let char_count = self.state.input.input_text.chars().count();
                if self.state.input.input_cursor < char_count {
                    self.state.input.input_cursor += 1;
                }
                self.refresh_at_picker_from_input();
            }
            KeyEvent {
                code: KeyCode::Backspace,
                ..
            } if self.state.input.input_text.is_empty()
                && !self.state.input.attachments.is_empty() =>
            {
                // An empty composer drops its last attachment.
                if let Some(removed) = self.state.input.attachments.pop() {
                    self.state
                        .ui
                        .show_toast(format!("Removed {}", removed.name));
                }
            }
            KeyEvent {
                code: KeyCode::Backspace,
                ..
            } => {
                // A paste chip is deleted whole. Chewing through it one char at
                // a time would leave `[#1 +142 line` in the draft, which
                // resolves to nothing and would be sent to the model as-is.
                if let Some((start, token)) = self
                    .state
                    .input
                    .placeholder_ending_at(self.state.input.input_cursor)
                {
                    let from = util::char_to_byte(&self.state.input.input_text, start);
                    let to = util::char_to_byte(
                        &self.state.input.input_text,
                        self.state.input.input_cursor,
                    );
                    self.state.input.input_text.replace_range(from..to, "");
                    self.state.input.input_cursor = start;
                    self.state
                        .input
                        .pasted_blocks
                        .retain(|block| block.placeholder() != token);
                } else if self.state.input.input_cursor > 0 {
                    self.state.input.input_cursor -= 1;
                    let byte_idx = util::char_to_byte(
                        &self.state.input.input_text,
                        self.state.input.input_cursor,
                    );
                    self.state.input.input_text.remove(byte_idx);
                }
                self.refresh_at_picker_from_input();
            }
            KeyEvent {
                code: KeyCode::Delete,
                ..
            } => {
                let char_count = self.state.input.input_text.chars().count();
                if self.state.input.input_cursor < char_count {
                    let byte_idx = util::char_to_byte(
                        &self.state.input.input_text,
                        self.state.input.input_cursor,
                    );
                    self.state.input.input_text.remove(byte_idx);
                }
                self.refresh_at_picker_from_input();
            }
            KeyEvent {
                code: KeyCode::Home,
                ..
            } => {
                self.state.input.input_cursor = 0;
            }
            KeyEvent {
                code: KeyCode::End, ..
            } => {
                self.state.input.input_cursor = self.state.input.input_text.chars().count();
            }
            KeyEvent {
                code: KeyCode::Enter,
                ..
            } => {
                // Prefer completing @ file pick over submitting
                if self.state.input.show_at_picker {
                    use crate::at_file_picker::filter_files;
                    let has = !filter_files(
                        &self.state.input.at_file_cache,
                        &self.state.input.at_picker_query,
                    )
                    .is_empty();
                    if has {
                        self.complete_selected_at_file();
                        return Ok(());
                    }
                    // no matches → fall through to submit
                    self.state.input.close_at_picker();
                }
                // Enter opens a hovered subagent card's live detail modal, or
                // a hovered tool card's output expansion.
                if self.state.input.input_text.is_empty() {
                    if let Some(hovered) = self.state.ui.hovered_entry_id {
                        let entry = self
                            .state
                            .session
                            .chat_history
                            .iter()
                            .find(|e| e.id == hovered);
                        if let Some(entry) = entry {
                            if let Some(sub_id) = entry.subagent_id.clone() {
                                self.state.ui.open_subagent_detail(sub_id);
                                self.state.ui.needs_render = true;
                                return Ok(());
                            }
                            if entry.role == agente_core::types::Role::Tool {
                                // Hovering a group header routes to the group,
                                // not to the head member's own card.
                                let on_group_header = self
                                    .state
                                    .ui
                                    .find_click_region(
                                        self.state.ui.mouse_pos.map_or(0, |(_, y)| y),
                                    )
                                    .is_some_and(|r| {
                                        r.kind == ClickKind::ToolGroup && r.entry_id == hovered
                                    });
                                if on_group_header {
                                    self.state.ui.toggle_tool_group(hovered);
                                } else {
                                    self.state
                                        .ui
                                        .cycle_tool_entry(hovered, entry.tool_name.as_deref());
                                }
                                return Ok(());
                            }
                        }
                    }
                }
                if self.state.input.input_text.is_empty()
                    && !self.state.agent.is_idle()
                    && self.state.agent.has_unsent_queue()
                {
                    // Enter again: the queue goes to the running turn now
                    // (it joins at the next step, nothing is cancelled).
                    let sent = self.state.agent.send_queue_now();
                    self.state.ui.show_toast(format!(
                        "↗ Sending {} at the next step",
                        if sent == 1 {
                            "1 message".to_string()
                        } else {
                            format!("{sent} messages")
                        }
                    ));
                } else if self.state.input.input_text.is_empty()
                    && (!self.state.agent.streaming_text.is_empty()
                        || !self.state.agent.reasoning_text.is_empty())
                    && self.state.agent.state == AgentState::StreamingResponse
                {
                    // Only toggle thinking expansion when input is empty
                    self.state.agent.thinking_expanded = !self.state.agent.thinking_expanded;
                } else if !self.state.input.input_text.starts_with('/')
                    && self.state.input.input_text.ends_with('\\')
                {
                    // `\` + Enter inserts a newline instead of submitting.
                    self.state.input.input_text.pop();
                    self.state.input.input_text.push('\n');
                    self.state.input.input_cursor = self.state.input.input_text.chars().count();
                } else if let Some(text) = self.state.submit_input() {
                    self.state.input.close_at_picker();
                    // Exit welcome screen when user sends their first message
                    if self.state.ui.show_welcome_screen {
                        self.state.ui.show_welcome_screen = false;
                    }

                    if text.starts_with('/') {
                        self.handle_user_input(text)?;
                    } else if self.state.config.current_provider.is_empty() {
                        let len = text.chars().count();
                        self.state.input.input_text = text;
                        self.state.input.input_cursor = len;
                        self.state.open_connect_screen();
                    } else {
                        self.handle_user_input(text)?;
                    }
                }
            }
            KeyEvent {
                code: KeyCode::Esc, ..
            } => {
                if self.state.ui.diff_peek.is_some() {
                    self.state.ui.diff_peek = None;
                    self.state.ui.needs_render = true;
                    return Ok(());
                }
                if self.state.input.show_at_picker {
                    self.state.input.close_at_picker();
                    return Ok(());
                }
                let is_running = !matches!(
                    self.state.agent.state,
                    AgentState::Idle | AgentState::Error(_)
                );
                if is_running {
                    self.stop_current_operation();
                } else if !self.state.input.input_text.is_empty() {
                    self.state.input.input_text.clear();
                    self.state.input.input_cursor = 0;
                    self.state.input.close_at_picker();
                }
            }
            KeyEvent {
                code: KeyCode::Char(c),
                modifiers,
                ..
            } if is_text_char_modifiers(modifiers) => {
                let ch = resolve_text_char(c, modifiers);
                self.insert_input_char(ch);
            }
            // Emacs-style line editing
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('a'),
                ..
            } => {
                self.state.input.input_cursor = 0;
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('e'),
                ..
            } => {
                self.state.input.input_cursor = self.state.input.input_text.chars().count();
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('k'),
                ..
            } => {
                // Delete from cursor to end of line
                let byte_idx =
                    util::char_to_byte(&self.state.input.input_text, self.state.input.input_cursor);
                self.state.input.input_text.truncate(byte_idx);
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('u'),
                ..
            } => {
                // Delete from start to cursor
                let byte_idx =
                    util::char_to_byte(&self.state.input.input_text, self.state.input.input_cursor);
                self.state.input.input_text = self.state.input.input_text[byte_idx..].to_string();
                self.state.input.input_cursor = 0;
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('w'),
                ..
            } => {
                // Delete word backward
                if self.state.input.input_cursor > 0 {
                    let text: String = self
                        .state
                        .input
                        .input_text
                        .chars()
                        .take(self.state.input.input_cursor)
                        .collect();
                    let trimmed = text.trim_end_matches(|c: char| c.is_whitespace());
                    let word_end = trimmed.chars().count();
                    if word_end < self.state.input.input_cursor {
                        // If we were in whitespace, delete that first
                        let before = self
                            .state
                            .input
                            .input_text
                            .chars()
                            .take(word_end)
                            .collect::<String>();
                        let after: String = self
                            .state
                            .input
                            .input_text
                            .chars()
                            .skip(self.state.input.input_cursor)
                            .collect();
                        self.state.input.input_text = format!("{before}{after}");
                        self.state.input.input_cursor = word_end;
                    } else {
                        // Delete the word before cursor
                        let last_space = trimmed.rfind(|c: char| c.is_whitespace());
                        let new_cursor = if let Some(pos) = last_space {
                            trimmed[..=pos].chars().count()
                        } else {
                            0
                        };
                        let before: String = self
                            .state
                            .input
                            .input_text
                            .chars()
                            .take(new_cursor)
                            .collect();
                        let after: String = self
                            .state
                            .input
                            .input_text
                            .chars()
                            .skip(self.state.input.input_cursor)
                            .collect();
                        self.state.input.input_text = format!("{before}{after}");
                        self.state.input.input_cursor = new_cursor;
                    }
                }
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('t'),
                ..
            } => {
                self.open_thinking_selector();
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('d'),
                ..
            } => {
                // Quit alternative.
                self.flush_state_to_disk();
                self.state.ui.should_quit = true;
            }
            _ => {}
        }

        Ok(())
    }

    pub(super) fn try_autocomplete_slash_command(&mut self) {
        let query = if self.state.input.input_text.starts_with('/') {
            &self.state.input.input_text[1..]
        } else {
            &self.state.input.input_text
        };

        let commands = command_palette::filter_commands(query);
        if commands.len() == 1 {
            // Exact match - autocomplete
            self.state.input.input_text = commands[0].slash().to_string();
            self.state.input.input_cursor = self.state.input.input_text.chars().count();
            self.state.input.show_slash_picker = false;
        } else if !commands.is_empty() && !query.is_empty() {
            // Multiple matches - complete to common prefix
            let first = commands[0].slash();
            let mut common_prefix_chars = first.chars().count();

            for cmd in &commands[1..] {
                let mut i = 0;
                while i < common_prefix_chars {
                    let a = first.chars().nth(i);
                    let b = cmd.slash().chars().nth(i);
                    if a != b {
                        break;
                    }
                    i += 1;
                }
                common_prefix_chars = i;
            }

            let query_chars = query.chars().count();
            if common_prefix_chars > query_chars {
                // Can extend the command
                let prefix: String = first.chars().take(common_prefix_chars).collect();
                self.state.input.input_text = prefix;
                self.state.input.input_cursor = common_prefix_chars;
                self.state.input.show_slash_picker = true;
                self.state.input.slash_picker_selected = 0;
            } else {
                // Show picker with matches
                self.state.input.show_slash_picker = true;
                self.state.input.slash_picker_selected = 0;
            }
        }
    }

    pub(super) fn complete_selected_slash_command(&mut self) {
        let query = if self.state.input.input_text.starts_with('/') {
            &self.state.input.input_text[1..]
        } else {
            &self.state.input.input_text
        };

        let commands = command_palette::filter_commands(query);
        if let Some(cmd) = commands.get(
            self.state
                .input
                .slash_picker_selected
                .min(commands.len().saturating_sub(1)),
        ) {
            self.state.input.input_text = cmd.slash().to_string();
            self.state.input.input_cursor = self.state.input.input_text.chars().count();
            self.state.input.show_slash_picker = false;
            self.state.input.slash_picker_selected = 0;
        }
    }

    /// Handle keys while `@` file picker is open. Returns true if consumed.
    fn handle_at_picker_key(&mut self, key: KeyEvent) -> anyhow::Result<bool> {
        use crate::at_file_picker::filter_files;

        let n = filter_files(
            &self.state.input.at_file_cache,
            &self.state.input.at_picker_query,
        )
        .len();

        match key.code {
            KeyCode::Up => {
                if self.state.input.at_picker_selected > 0 {
                    self.state.input.at_picker_selected -= 1;
                }
                Ok(true)
            }
            KeyCode::Down => {
                if n > 0 {
                    let max = n - 1;
                    if self.state.input.at_picker_selected < max {
                        self.state.input.at_picker_selected += 1;
                    }
                }
                Ok(true)
            }
            KeyCode::Esc => {
                self.state.input.close_at_picker();
                Ok(true)
            }
            KeyCode::Enter | KeyCode::Tab => {
                if n > 0 {
                    self.complete_selected_at_file();
                    Ok(true)
                } else {
                    Ok(false)
                }
            }
            // Let typing / backspace fall through to main handler after we return false
            // — but we already intercept show_at_picker and return early for all keys
            // when handle returns true. For chars, return false so match continues.
            // Wait: the caller returns early only if handle returns true. If false,
            // we need to not return early from show_at_picker block.
            _ => Ok(false),
        }
    }

    pub(super) fn handle_command_palette_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key {
            KeyEvent {
                code: KeyCode::Esc, ..
            } => {
                self.state.input.show_command_palette = false;
            }
            KeyEvent {
                code: KeyCode::Up, ..
            } => {
                if self.state.input.command_palette_selected > 0 {
                    self.state.input.command_palette_selected -= 1;
                }
            }
            KeyEvent {
                code: KeyCode::Down,
                ..
            } => {
                let commands =
                    command_palette::filter_commands(&self.state.input.command_palette_query);
                if self.state.input.command_palette_selected < commands.len().saturating_sub(1) {
                    self.state.input.command_palette_selected += 1;
                }
            }
            KeyEvent {
                code: KeyCode::Enter,
                ..
            } => {
                let commands =
                    command_palette::filter_commands(&self.state.input.command_palette_query);
                if let Some(cmd) = commands.get(self.state.input.command_palette_selected) {
                    let cmd = *cmd;
                    self.state.input.show_command_palette = false;
                    self.execute_command(cmd)?;
                }
            }
            KeyEvent {
                code: KeyCode::Backspace,
                ..
            } => {
                self.state.input.command_palette_query.pop();
                self.state.input.command_palette_selected = 0;
            }
            KeyEvent {
                code: KeyCode::Char(c),
                modifiers,
                ..
            } if is_text_char_modifiers(modifiers) => {
                let ch = resolve_text_char(c, modifiers);
                self.state.input.command_palette_query.push(ch);
                self.state.input.command_palette_selected = 0;
            }
            _ => {}
        }
        Ok(())
    }

    /// Keys for the live output view: scroll, End follows, `s` stops the
    /// running operation, Esc closes.
    fn handle_process_view_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let running = self
            .state
            .ui
            .process_view
            .as_ref()
            .is_some_and(|view| self.state.agent.live_tool_calls.contains_key(&view.call_id));
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => self.state.ui.process_view = None,
            KeyCode::Char('s') if running => {
                self.stop_current_operation();
                self.state.ui.process_view = None;
            }
            code => {
                if let Some(view) = self.state.ui.process_view.as_mut() {
                    match code {
                        KeyCode::Up => view.scroll_by(-1),
                        KeyCode::Down => view.scroll_by(1),
                        KeyCode::PageUp => view.scroll_by(-20),
                        KeyCode::PageDown => view.scroll_by(20),
                        KeyCode::Home => {
                            view.follow = false;
                            view.scroll = 0;
                        }
                        KeyCode::End => view.follow = true,
                        _ => {}
                    }
                }
            }
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    /// Keys for the message dialog: move, Enter runs, r/f/c/e shortcuts.
    fn handle_message_actions_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::message_actions::actions;
        let Some(entry_id) = self.state.ui.message_actions else {
            return Ok(());
        };
        let list = actions(&self.state, entry_id);
        let last = list.len().saturating_sub(1);
        let selected = self.state.input.message_actions_selected.min(last);
        let chosen = match key.code {
            KeyCode::Esc => {
                self.state.ui.message_actions = None;
                None
            }
            KeyCode::Up => {
                self.state.input.message_actions_selected = selected.saturating_sub(1);
                None
            }
            KeyCode::Down => {
                self.state.input.message_actions_selected = (selected + 1).min(last);
                None
            }
            KeyCode::Enter => list.get(selected).copied(),
            KeyCode::Char(c) => list.iter().copied().find(|a| a.key() == c),
            _ => None,
        };
        if let Some(action) = chosen {
            self.run_message_action(entry_id, action)?;
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    /// Keys for `/settings`: move, Enter/Space changes the row, Esc closes.
    fn handle_settings_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::settings::{Setting, SETTINGS};
        let last = SETTINGS.len() - 1;
        let selected = self.state.input.settings_selected.min(last);
        match key.code {
            KeyCode::Esc => self.state.input.show_settings = false,
            KeyCode::Up => self.state.input.settings_selected = selected.saturating_sub(1),
            KeyCode::Down => self.state.input.settings_selected = (selected + 1).min(last),
            KeyCode::Enter | KeyCode::Char(' ') => match SETTINGS[selected] {
                Setting::SmartCompaction => {
                    let config = &mut self.state.config.config;
                    config.smart_compaction = !config.smart_compaction;
                    self.state.persist_config();
                }
                Setting::ParallelSubagents => {
                    let config = &mut self.state.config.config;
                    config.max_parallel_subagents =
                        Some(crate::settings::next_parallel(config.parallel_subagents()));
                    self.state.persist_config();
                }
                Setting::ReduceMotion => {
                    let on = !self.state.ui.reduce_motion;
                    self.state.ui.reduce_motion = on;
                    self.state.config.config.reduce_motion = on;
                    self.state.persist_config();
                }
                Setting::AutoApprove => {
                    let on = !self.state.agent.auto_approve_persistent;
                    if !self.state.set_auto_approve(on) {
                        self.state
                            .ui
                            .show_toast("Change this while the agent is idle".to_string());
                    }
                }
                Setting::MediaImages | Setting::MediaAudio | Setting::MediaVideo => {
                    if let Some(kind) = SETTINGS[selected].media_kind() {
                        let allow = &mut self.state.config.config.allow_media;
                        if let Some(at) = allow.iter().position(|k| *k == kind) {
                            allow.remove(at);
                        } else {
                            allow.push(kind);
                        }
                        self.state.persist_config();
                    }
                }
                Setting::Theme => {
                    self.execute_command(crate::command_palette::Command::ToggleTheme)?
                }
                Setting::SubagentModels => {
                    self.execute_command(crate::command_palette::Command::SubagentModels)?;
                }
            },
            _ => {}
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    /// Keys for `/mcp`: move, Enter approves / enables / reconnects the row,
    /// `d` turns it off, Esc closes. Approvals and on/off persist.
    fn handle_mcp_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::mcp_servers::{primary_action, McpAction};
        use agente_core::mcp::ServerSource;
        let manager = std::sync::Arc::clone(&self.state.config.mcp_manager);
        let servers = manager.snapshots();
        let last = servers.len().saturating_sub(1);
        let selected = self.state.input.mcp_selected.min(last);
        let server = servers.get(selected);
        let project = self.state.session.project_dir.clone();
        match key.code {
            KeyCode::Esc => self.state.input.show_mcp = false,
            KeyCode::Up => self.state.input.mcp_selected = selected.saturating_sub(1),
            KeyCode::Down => self.state.input.mcp_selected = (selected + 1).min(last),
            KeyCode::Enter => {
                if let Some(server) = server {
                    let config = &mut self.state.config.config;
                    match primary_action(server) {
                        McpAction::Approve => {
                            let approval = agente_core::mcp::approval_key(&project, &server.name);
                            if !config.approved_mcp_servers.contains(&approval) {
                                config.approved_mcp_servers.push(approval);
                            }
                            self.state.persist_config();
                        }
                        McpAction::Enable => {
                            if let Some(entry) = config.mcp.get_mut(&server.name) {
                                entry.enabled = true;
                                self.state.persist_config();
                            }
                        }
                        McpAction::Reconnect => {}
                    }
                    let name = server.name.clone();
                    self.runtime
                        .spawn(async move { manager.reconnect(&name).await });
                }
            }
            KeyCode::Char('d') | KeyCode::Delete => {
                if let Some(server) = server {
                    manager.disable(&server.name);
                    let config = &mut self.state.config.config;
                    match server.source {
                        ServerSource::Config => {
                            if let Some(entry) = config.mcp.get_mut(&server.name) {
                                entry.enabled = false;
                            }
                        }
                        ServerSource::ProjectFile => {
                            let approval = agente_core::mcp::approval_key(&project, &server.name);
                            config.approved_mcp_servers.retain(|k| *k != approval);
                        }
                    }
                    self.state.persist_config();
                }
            }
            _ => {}
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    /// Keys for `/skills`: move, Enter puts `/name ` in the composer to run
    /// the skill (with an optional request after it), Esc closes.
    fn handle_skills_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let count = self.state.input.skills.len();
        let selected = self
            .state
            .input
            .skills_selected
            .min(count.saturating_sub(1));
        match key.code {
            KeyCode::Esc => self.state.input.show_skills = false,
            KeyCode::Up => self.state.input.skills_selected = selected.saturating_sub(1),
            KeyCode::Down => {
                self.state.input.skills_selected = (selected + 1).min(count.saturating_sub(1))
            }
            KeyCode::Enter => {
                if let Some(skill) = self.state.input.skills.get(selected) {
                    let text = format!("/{} ", skill.name);
                    self.state.input.show_skills = false;
                    self.state.input.input_cursor = text.chars().count();
                    self.state.input.input_text = text;
                }
            }
            _ => {}
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    /// Keys for `/subagent-models`: move, Enter opens the model picker for the
    /// row, Del/Backspace resets it to inherit, Esc closes.
    fn handle_subagent_models_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let input = &mut self.state.input;
        let last = input.subagent_model_types.len().saturating_sub(1);
        match key.code {
            KeyCode::Esc => input.show_subagent_models = false,
            KeyCode::Up => {
                input.subagent_models_selected = input.subagent_models_selected.saturating_sub(1)
            }
            KeyCode::Down => {
                input.subagent_models_selected = (input.subagent_models_selected + 1).min(last)
            }
            KeyCode::Enter => {
                if let Some(target) = input
                    .subagent_model_types
                    .get(input.subagent_models_selected)
                    .cloned()
                {
                    if self.state.is_connected() {
                        self.state.input.model_selector_target = Some(target);
                        self.state.input.show_model_selector = true;
                        self.state.input.model_selector_query.clear();
                        self.state.input.model_selector_selected = 0;
                    } else {
                        self.state.open_connect_screen();
                    }
                }
            }
            KeyCode::Delete | KeyCode::Backspace => {
                if let Some(target) = input
                    .subagent_model_types
                    .get(input.subagent_models_selected)
                {
                    if self
                        .state
                        .config
                        .config
                        .subagent_models
                        .remove(target.as_str())
                        .is_some()
                    {
                        self.state.persist_config();
                    }
                }
            }
            _ => {}
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    pub(super) fn handle_model_selector_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        // Use the same filtered list as rendering: only connected providers
        let all_entries: Vec<_> = self
            .state
            .get_all_model_entries()
            .into_iter()
            .filter(|e| self.state.is_provider_connected(&e.provider))
            .collect();
        let filtered = model_selector::filter_models(
            &self.state.input.model_selector_query,
            self.state.input.model_selector_provider.as_deref(),
            &all_entries,
        );

        match key {
            KeyEvent {
                code: KeyCode::Esc, ..
            } => {
                self.state.input.show_model_selector = false;
                self.state.input.model_selector_target = None;
            }
            KeyEvent {
                code: KeyCode::Up, ..
            } => {
                if self.state.input.model_selector_selected > 0 {
                    self.state.input.model_selector_selected -= 1;
                }
            }
            KeyEvent {
                code: KeyCode::Down,
                ..
            } => {
                if self.state.input.model_selector_selected < filtered.len().saturating_sub(1) {
                    self.state.input.model_selector_selected += 1;
                }
            }
            KeyEvent {
                code: KeyCode::Enter,
                ..
            } => {
                // If no providers connected, close model selector and open connect screen
                if !self.state.is_connected() {
                    self.state.input.show_model_selector = false;
                    self.state.open_connect_screen();
                } else if let (Some(entry), Some(target)) = (
                    filtered.get(self.state.input.model_selector_selected),
                    self.state.input.model_selector_target.take(),
                ) {
                    // Choosing for a subagent type: store the override, go
                    // back to the subagent models dialog.
                    self.state.config.config.subagent_models.insert(
                        target,
                        agente_core::config::SubagentModel {
                            provider: entry.provider.clone(),
                            model: entry.model_id.clone(),
                            thinking: None,
                        },
                    );
                    self.state.input.show_model_selector = false;
                    self.state.persist_config();
                } else if let Some(entry) = filtered.get(self.state.input.model_selector_selected) {
                    self.state.config.current_provider = entry.provider.clone();
                    self.state.config.current_model = entry.model_id.clone();
                    self.state.clamp_thinking_level_for_current_model();
                    self.state.input.show_model_selector = false;
                    self.state.persist_config();
                }
            }
            // Cycle the provider scope. This moves through
            // `None` (all connected providers) and each connected provider in
            // turn, and no longer touches the query -- the two used to share
            // one string, so each clobbered the other.
            KeyEvent {
                code: KeyCode::Left | KeyCode::BackTab,
                ..
            } => {
                self.cycle_model_provider(false);
            }
            KeyEvent {
                code: KeyCode::Right | KeyCode::Tab,
                ..
            } => {
                self.cycle_model_provider(true);
            }
            KeyEvent {
                code: KeyCode::Backspace,
                ..
            } => {
                self.state.input.model_selector_query.pop();
                self.state.input.model_selector_selected = 0;
            }
            // Refresh is Ctrl+R / F5, never a bare letter: `r` bound alone
            // shadowed text input, so no model containing an "r" -- turbo,
            // nemotron, mistral, claude -- could be searched for.
            KeyEvent {
                code: KeyCode::Char('r'),
                modifiers: KeyModifiers::CONTROL,
                ..
            }
            | KeyEvent {
                code: KeyCode::F(5),
                ..
            } => {
                // Re-fetch the list for the browsed provider. The rows stay
                // visible and are replaced in place when ModelsDiscovered
                // arrives.
                let providers = match self.state.input.model_selector_provider.clone() {
                    Some(provider) => vec![provider],
                    None => self.state.config.connected_providers.clone(),
                };
                self.refresh_model_catalog();
                for provider in providers {
                    if self.state.config.connected_providers.contains(&provider) {
                        self.spawn_model_discovery(&provider);
                    }
                }
                self.state.ui.needs_render = true;
            }
            KeyEvent {
                code: KeyCode::Char(c),
                modifiers,
                ..
            } if is_text_char_modifiers(modifiers) => {
                let ch = resolve_text_char(c, modifiers);
                self.state.input.model_selector_query.push(ch);
                self.state.input.model_selector_selected = 0;
            }
            _ => {}
        }
        Ok(())
    }

    /// Step the model selector's provider scope.
    ///
    /// The order is `All` followed by each connected provider, so a user can
    /// always get back to searching everything without clearing state.
    fn cycle_model_provider(&mut self, forward: bool) {
        let providers = self.state.config.connected_providers.clone();
        if providers.is_empty() {
            return;
        }
        // Slot 0 is "all providers"; slot n+1 is providers[n].
        let slots = providers.len() + 1;
        let current = match &self.state.input.model_selector_provider {
            None => 0,
            Some(id) => providers
                .iter()
                .position(|p| p == id)
                .map(|i| i + 1)
                .unwrap_or(0),
        };
        let next = if forward {
            (current + 1) % slots
        } else {
            (current + slots - 1) % slots
        };
        self.state.input.model_selector_provider = if next == 0 {
            None
        } else {
            Some(providers[next - 1].clone())
        };
        self.state.input.model_selector_selected = 0;
        self.state.ui.needs_render = true;
    }

    pub(super) fn handle_slash_picker_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key {
            KeyEvent {
                code: KeyCode::Esc, ..
            } => {
                self.state.input.show_slash_picker = false;
                // Preserve the typed text so user can keep editing
            }
            KeyEvent {
                code: KeyCode::Up, ..
            } => {
                if self.state.input.slash_picker_selected > 0 {
                    self.state.input.slash_picker_selected -= 1;
                }
            }
            KeyEvent {
                code: KeyCode::Down,
                ..
            } => {
                let query = if self.state.input.input_text.starts_with('/') {
                    &self.state.input.input_text[1..]
                } else {
                    &self.state.input.input_text
                };
                let commands = command_palette::filter_commands(query);
                if self.state.input.slash_picker_selected < commands.len().saturating_sub(1) {
                    self.state.input.slash_picker_selected += 1;
                }
            }
            KeyEvent {
                code: KeyCode::Enter,
                ..
            } => {
                let query = if self.state.input.input_text.starts_with('/') {
                    &self.state.input.input_text[1..]
                } else {
                    &self.state.input.input_text
                };
                // Text after the command word (`/skill-name request`,
                // `/diff path`) is a typed command, not a pick: submit it.
                let has_args = query.trim_end().contains(char::is_whitespace);
                let commands = command_palette::filter_commands(query);
                match commands.get(self.state.input.slash_picker_selected) {
                    Some(cmd) if !has_args => {
                        self.state.input.show_slash_picker = false;
                        self.state.input.input_text.clear();
                        self.state.input.input_cursor = 0;
                        self.execute_command(*cmd)?;
                    }
                    _ => {
                        // No pick (custom command, skill, arguments): submit
                        // the text as typed.
                        self.state.input.show_slash_picker = false;
                        return self.handle_key(key);
                    }
                }
            }
            KeyEvent {
                code: KeyCode::Backspace,
                ..
            } => {
                if !self.state.input.input_text.is_empty() {
                    let byte_idx = util::char_to_byte(
                        &self.state.input.input_text,
                        self.state.input.input_cursor,
                    );
                    if byte_idx > 0 {
                        let prev_char_idx = self.state.input.input_cursor.saturating_sub(1);
                        let prev_byte_idx =
                            util::char_to_byte(&self.state.input.input_text, prev_char_idx);
                        self.state.input.input_text.remove(prev_byte_idx);
                        self.state.input.input_cursor = prev_char_idx;
                    }
                }
                // Close picker only when input becomes completely empty
                if self.state.input.input_text.is_empty() {
                    self.state.input.show_slash_picker = false;
                }
            }
            KeyEvent {
                code: KeyCode::Char(c),
                modifiers,
                ..
            } if is_text_char_modifiers(modifiers) => {
                let ch = resolve_text_char(c, modifiers);
                let byte_idx =
                    util::char_to_byte(&self.state.input.input_text, self.state.input.input_cursor);
                self.state.input.input_text.insert(byte_idx, ch);
                self.state.input.input_cursor += 1;
                self.state.input.slash_picker_selected = 0;
                // Re-open slash picker if typing after it was closed
                if self.state.input.input_text.starts_with('/') {
                    self.state.input.show_slash_picker = true;
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn handle_connect_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        // Sorted to match connect.rs render order (Connected → Popular → Local → Other)
        let mut provider_entries = self.state.all_provider_entries();
        connect::sort_entries_with_connected(
            &mut provider_entries,
            &self.state.config.connected_providers,
        );

        match &self.state.config.connect_screen.clone() {
            crate::state::ConnectScreen::Closed => {}
            crate::state::ConnectScreen::SelectProvider { .. } => {
                match key.code {
                    KeyCode::Esc => {
                        self.state.close_connect_screen();
                    }
                    KeyCode::Up => {
                        if let crate::state::ConnectScreen::SelectProvider { selected: s, .. } =
                            &mut self.state.config.connect_screen
                        {
                            if *s > 0 {
                                *s -= 1;
                            }
                        }
                    }
                    KeyCode::Down => {
                        if let crate::state::ConnectScreen::SelectProvider { query, selected: s } =
                            &mut self.state.config.connect_screen
                        {
                            let filtered = connect::filtered_presets(query, &provider_entries);
                            if *s < filtered.len().saturating_sub(1) {
                                *s += 1;
                            }
                        }
                    }
                    KeyCode::Enter => {
                        if let crate::state::ConnectScreen::SelectProvider { query, selected: s } =
                            &self.state.config.connect_screen
                        {
                            let filtered = connect::filtered_presets(query, &provider_entries);
                            if let Some(preset) = filtered.get(*s) {
                                let preset_id = preset.id.clone();
                                let query = query.clone();
                                if self.state.can_activate_without_key(&preset_id) {
                                    // Already has auth / local / env — activate without re-typing.
                                    self.activate_connected_provider(&preset_id);
                                } else {
                                    self.state.open_enter_key(
                                        &preset_id,
                                        query,
                                        false,
                                        String::new(),
                                    );
                                }
                            }
                        }
                    }
                    // Ctrl+K = enter / replace API key (does not steal filter typing)
                    KeyCode::Char('k') | KeyCode::Char('K')
                        if key
                            .modifiers
                            .contains(crossterm::event::KeyModifiers::CONTROL) =>
                    {
                        if let crate::state::ConnectScreen::SelectProvider { query, selected: s } =
                            &self.state.config.connect_screen
                        {
                            let filtered = connect::filtered_presets(query, &provider_entries);
                            if let Some(preset) = filtered.get(*s) {
                                if !preset.env_key.is_empty() {
                                    let replace = self.state.is_provider_connected(&preset.id)
                                        || self.state.provider_has_key(&preset.id);
                                    self.state.open_enter_key(
                                        &preset.id,
                                        query.clone(),
                                        replace,
                                        String::new(),
                                    );
                                }
                            }
                        }
                    }
                    // Delete = disconnect and forget stored key
                    KeyCode::Delete => {
                        let action = if let crate::state::ConnectScreen::SelectProvider {
                            query,
                            selected: s,
                        } = &self.state.config.connect_screen
                        {
                            let filtered = connect::filtered_presets(query, &provider_entries);
                            filtered.get(*s).map(|p| (p.id.clone(), *s))
                        } else {
                            None
                        };
                        if let Some((provider_id, sel)) = action {
                            if self.state.is_provider_connected(&provider_id) {
                                self.state.disconnect_provider(&provider_id, true);
                                self.state.persist_config();
                                let mut entries = self.state.all_provider_entries();
                                connect::sort_entries_with_connected(
                                    &mut entries,
                                    &self.state.config.connected_providers,
                                );
                                let q = if let crate::state::ConnectScreen::SelectProvider {
                                    query,
                                    ..
                                } = &self.state.config.connect_screen
                                {
                                    query.clone()
                                } else {
                                    String::new()
                                };
                                let n = connect::filtered_presets(&q, &entries).len();
                                if let crate::state::ConnectScreen::SelectProvider {
                                    selected,
                                    ..
                                } = &mut self.state.config.connect_screen
                                {
                                    if n == 0 {
                                        *selected = 0;
                                    } else if sel >= n {
                                        *selected = n - 1;
                                    }
                                }
                            }
                        }
                    }
                    KeyCode::Backspace => {
                        if let crate::state::ConnectScreen::SelectProvider { query, selected: s } =
                            &mut self.state.config.connect_screen
                        {
                            query.pop();
                            *s = 0;
                        }
                    }
                    KeyCode::Char(c) if is_text_char_modifiers(key.modifiers) => {
                        let ch = resolve_text_char(c, key.modifiers);
                        if let crate::state::ConnectScreen::SelectProvider { query, selected: s } =
                            &mut self.state.config.connect_screen
                        {
                            query.push(ch);
                            *s = 0;
                        }
                    }
                    _ => {}
                }
            }
            crate::state::ConnectScreen::EnterKey {
                provider, query, ..
            } => {
                let provider = provider.clone();
                let saved_query = query.clone();
                match key.code {
                    KeyCode::Esc => {
                        self.state.config.connect_screen =
                            crate::state::ConnectScreen::SelectProvider {
                                query: saved_query,
                                selected: 0,
                            };
                        self.state.config.connect_key_input.clear();
                    }
                    KeyCode::Enter => {
                        let key = self.state.config.connect_key_input.trim().to_string();
                        if key.is_empty() {
                            if let crate::state::ConnectScreen::EnterKey { error, .. } =
                                &mut self.state.config.connect_screen
                            {
                                *error = "API key cannot be empty".to_string();
                            }
                        } else if key.len() < 8 {
                            if let crate::state::ConnectScreen::EnterKey { error, .. } =
                                &mut self.state.config.connect_screen
                            {
                                *error = "API key seems too short".to_string();
                            }
                        } else {
                            self.state.connect_provider(&provider, &key);
                            self.spawn_model_discovery(&provider);
                            self.state.close_connect_screen();
                            self.state.persist_config();
                            // Model selector opens after discovery succeeds (agent_events).
                        }
                    }
                    KeyCode::Backspace => {
                        if let crate::state::ConnectScreen::EnterKey { error, .. } =
                            &mut self.state.config.connect_screen
                        {
                            error.clear();
                        }
                        self.state.config.connect_key_input.pop();
                    }
                    KeyCode::Char(c) if is_text_char_modifiers(key.modifiers) => {
                        let ch = resolve_text_char(c, key.modifiers);
                        if let crate::state::ConnectScreen::EnterKey { error, .. } =
                            &mut self.state.config.connect_screen
                        {
                            error.clear();
                        }
                        self.state.config.connect_key_input.push(ch);
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }

    /// Activate a provider that already has credentials (or needs none).
    /// Spawns discovery if needed; model picker opens when models arrive.
    fn activate_connected_provider(&mut self, provider: &str) {
        self.state.connect_provider(provider, "");
        self.state.close_connect_screen();
        self.state.persist_config();

        let already_done = matches!(
            self.state.config.discovery_status.get(provider),
            Some(crate::state::DiscoveryStatus::Done)
        );
        let has_models = self
            .state
            .config
            .discovered_models
            .get(provider)
            .map(|m| !m.is_empty())
            .unwrap_or(false);

        if already_done && has_models {
            // Immediate handoff when we already know the model list.
            self.state.config.pending_after_connect = None;
            if self.state.config.current_model.is_empty() {
                self.refresh_model_selection_after_discovery(provider);
            }
            return;
        }

        self.spawn_model_discovery(provider);
    }

    pub(super) fn handle_plan_review_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::state::{template_ask_questions, PlanReviewPhase};

        match self.state.plan_review.phase {
            PlanReviewPhase::Review => match key.code {
                KeyCode::Left | KeyCode::BackTab => {
                    if self.state.plan_review.button_index > 0 {
                        self.state.plan_review.button_index -= 1;
                    } else {
                        self.state.plan_review.button_index = 2;
                    }
                }
                KeyCode::Right | KeyCode::Tab => {
                    self.state.plan_review.button_index =
                        (self.state.plan_review.button_index + 1) % 3;
                }
                KeyCode::Up => {
                    self.state.plan_review.scroll_by(-1);
                }
                KeyCode::Down => {
                    self.state.plan_review.scroll_by(1);
                }
                KeyCode::PageUp => {
                    self.state.plan_review.scroll_by(-8);
                }
                KeyCode::PageDown => {
                    self.state.plan_review.scroll_by(8);
                }
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
                    KeyCode::Up => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            ask.go_prev();
                        }
                    }
                    KeyCode::Down => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            ask.go_next_focus();
                        }
                    }
                    KeyCode::BackTab => {
                        // Shift+Tab → previous step
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            ask.go_prev();
                        }
                    }
                    KeyCode::Tab => {
                        // Tab → next step (or submit on last)
                        self.plan_ask_next_or_submit()?;
                    }
                    KeyCode::Left => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            let qi = ask.question_index;
                            if let Some(q) = ask.questions.get_mut(qi) {
                                if !q.options.is_empty() {
                                    let cur = q.selected.unwrap_or(0);
                                    q.selected = Some(if cur == 0 {
                                        q.options.len() - 1
                                    } else {
                                        cur - 1
                                    });
                                }
                            }
                        }
                    }
                    KeyCode::Right => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            let qi = ask.question_index;
                            if let Some(q) = ask.questions.get_mut(qi) {
                                if !q.options.is_empty() {
                                    let cur = q.selected.unwrap_or(0);
                                    q.selected = Some((cur + 1) % q.options.len());
                                }
                            }
                        }
                    }
                    KeyCode::Enter => {
                        // Next step, or submit on last step
                        self.plan_ask_next_or_submit()?;
                    }
                    KeyCode::Esc => {
                        self.plan_review_comment();
                    }
                    KeyCode::Char('q') | KeyCode::Char('Q')
                        if key.modifiers.contains(KeyModifiers::CONTROL) =>
                    {
                        // Ctrl+Q: re-ask (avoid stealing free-text "q")
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
                    KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            let qi = ask.question_index;
                            if let Some(q) = ask.questions.get_mut(qi) {
                                q.free_text.push(c);
                            }
                        }
                    }
                    KeyCode::Backspace => {
                        if let Some(ask) = self.state.plan_review.ask.as_mut() {
                            let qi = ask.question_index;
                            if let Some(q) = ask.questions.get_mut(qi) {
                                q.free_text.pop();
                            }
                        }
                    }
                    _ => {}
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
        // Keep pending but bump will happen on next present_plan
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
        // Keep plan full-screen view; composer reappears for the comment.
        self.state.plan_review.phase = crate::state::PlanReviewPhase::AwaitingComment;
        self.state.plan_review.ask = None;
        self.state.input.input_text.clear();
        self.state.input.input_cursor = 0;
        self.state.ui.needs_render = true;
    }

    pub(super) fn submit_plan_feedback(&mut self, feedback: String) -> anyhow::Result<()> {
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

    /// Multi-step ask: Enter/Tab advances; last step submits synthesized feedback.
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
    pub(super) fn handle_approval_action(
        &mut self,
        action: types::ApprovalAction,
    ) -> anyhow::Result<()> {
        if matches!(action, types::ApprovalAction::ApproveAll) {
            // Turn-scoped: this only affects the current turn. After the
            // turn ends the next turn resets back to the user's persistent
            // preference.
            self.state.agent.set_auto_approve_runtime(true);
        }
        // Route the response to whichever agent (parent or subagent) is
        // waiting on this request, keyed by request id.
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
                // Task may have been cancelled while the popup was open.
                self.state.agent.pop_approval();
            }
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    /// `/subagents` popup: navigate the list with ↑↓/j/k, kill a running
    /// subagent with `k` (or Delete), close with Esc/Enter.
    /// Thinking-level picker (Ctrl+T, `/thinking`).
    ///
    /// The picker uses the level list captured for the resolved model.
    pub(super) fn handle_thinking_selector_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let levels = self.state.input.thinking_selector_levels.clone();
        match key.code {
            KeyCode::Esc => {
                self.state.input.close_thinking_selector();
                self.state.ui.needs_render = true;
            }
            // A horizontal scale: right and down climb, left and up drop.
            KeyCode::Left | KeyCode::Up => {
                if self.state.input.thinking_selector_selected > 0 {
                    self.state.input.thinking_selector_selected -= 1;
                }
                self.state.ui.needs_render = true;
            }
            KeyCode::Right | KeyCode::Down => {
                if self.state.input.thinking_selector_selected + 1 < levels.len() {
                    self.state.input.thinking_selector_selected += 1;
                }
                self.state.ui.needs_render = true;
            }
            KeyCode::PageUp => {
                self.state.input.thinking_selector_selected = self
                    .state
                    .input
                    .thinking_selector_selected
                    .saturating_sub(5);
                self.state.ui.needs_render = true;
            }
            KeyCode::PageDown => {
                let last = levels.len().saturating_sub(1);
                self.state.input.thinking_selector_selected = self
                    .state
                    .input
                    .thinking_selector_selected
                    .saturating_add(5)
                    .min(last);
                self.state.ui.needs_render = true;
            }
            KeyCode::Home => {
                self.state.input.thinking_selector_selected = 0;
                self.state.ui.needs_render = true;
            }
            KeyCode::End => {
                self.state.input.thinking_selector_selected = levels.len().saturating_sub(1);
                self.state.ui.needs_render = true;
            }
            KeyCode::Enter => {
                if let Some(level) = levels.get(self.state.input.thinking_selector_selected) {
                    self.state.agent.thinking_level = level.clone();
                    self.state.config.config.default_thinking_level = Some(level.clone());
                    self.state.ui.show_toast(format!("thinking: {level}"));
                }
                self.state.input.close_thinking_selector();
                self.state.ui.needs_render = true;
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn handle_subagents_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let entries = self.state.subagent_registry.list();
        // The registry list can shrink under the cursor (a child finishing
        // while the popup is open); clamp before any lookup so `k`/Enter
        // never target an out-of-range row.
        if !entries.is_empty() {
            self.state.input.subagents_selected = self
                .state
                .input
                .subagents_selected
                .min(entries.len().saturating_sub(1));
        }
        match key.code {
            KeyCode::Esc => {
                self.state.input.close_subagents();
                self.state.ui.needs_render = true;
            }
            KeyCode::Enter => {
                // Open the live detail modal for the selected row instead of
                // just closing — the list is overview, the modal is inspect.
                if let Some(selected) = entries.get(self.state.input.subagents_selected) {
                    self.state.ui.open_subagent_detail(selected.id.clone());
                    // Keep the overview beneath the child view: Esc restores
                    // the same selected task rather than dropping into chat.
                } else {
                    self.state.input.close_subagents();
                }
                self.state.ui.needs_render = true;
            }
            KeyCode::Up => {
                if self.state.input.subagents_selected > 0 {
                    self.state.input.subagents_selected -= 1;
                }
                self.state.ui.needs_render = true;
            }
            KeyCode::Down => {
                if self.state.input.subagents_selected < entries.len().saturating_sub(1) {
                    self.state.input.subagents_selected += 1;
                }
                self.state.ui.needs_render = true;
            }
            KeyCode::Delete | KeyCode::Char('k') => {
                if let Some(selected) = entries.get(self.state.input.subagents_selected) {
                    let id = selected.id.clone();
                    if selected.status.is_terminal() {
                        self.state
                            .ui
                            .show_toast("subagent already finished".to_string());
                    } else if self.state.subagent_registry.cancel(&id) {
                        let short: String = id.chars().take(8).collect();
                        self.state.ui.show_toast(format!("✓ kill sent {short}…"));
                    }
                    self.state.ui.needs_render = true;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Read-only child session: Tab/1–3 changes view; Esc returns to its owner.
    pub(super) fn handle_subagent_detail_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::state::SubagentDetailTab;
        let page = self
            .state
            .ui
            .subagent_detail_area
            .map(|area| area.height.saturating_sub(1).max(1) as i32)
            .unwrap_or(8);
        match key.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') => {
                self.state.ui.close_subagent_detail();
            }
            KeyCode::Tab => {
                let tab = self.state.ui.subagent_detail_tab.next();
                self.state.ui.select_subagent_tab(tab);
            }
            KeyCode::Char('1') => self
                .state
                .ui
                .select_subagent_tab(SubagentDetailTab::Activity),
            KeyCode::Char('2') => self
                .state
                .ui
                .select_subagent_tab(SubagentDetailTab::Handoff),
            KeyCode::Char('3') => self.state.ui.select_subagent_tab(SubagentDetailTab::Result),
            KeyCode::Char('o') => {
                self.state.ui.subagent_detail_show_output =
                    !self.state.ui.subagent_detail_show_output;
                self.state.ui.needs_render = true;
            }
            KeyCode::Char('d') => {
                if self.state.ui.subagent_diff.is_some() {
                    self.state.ui.subagent_diff = None;
                } else {
                    let worktree = self.state.ui.subagent_detail_id.clone().and_then(|id| {
                        self.state
                            .subagent_registry
                            .get(&id)
                            .and_then(|snap| snap.worktree.clone())
                    });
                    let diff =
                        worktree.and_then(|info| agente_core::subagent::worktree::diff_sync(&info));
                    self.state.ui.subagent_diff = Some(diff);
                }
                self.state.ui.subagent_detail_scroll = 0;
                self.state.ui.subagent_detail_follow = false;
                self.state.ui.needs_render = true;
            }
            KeyCode::Up => self.state.ui.scroll_subagent_detail(-1),
            KeyCode::Down => self.state.ui.scroll_subagent_detail(1),
            KeyCode::PageUp => self.state.ui.scroll_subagent_detail(-page),
            KeyCode::PageDown => self.state.ui.scroll_subagent_detail(page),
            KeyCode::Home => {
                self.state.ui.subagent_detail_scroll = 0;
                self.state.ui.subagent_detail_follow = false;
                self.state.ui.needs_render = true;
            }
            KeyCode::End => {
                self.state.ui.subagent_detail_follow = true;
                self.state.ui.needs_render = true;
            }
            KeyCode::Char('k') | KeyCode::Delete => {
                if let Some(id) = self.state.ui.subagent_detail_id.clone() {
                    let terminal = self
                        .state
                        .subagent_registry
                        .get(&id)
                        .map(|snap| snap.status.is_terminal())
                        .unwrap_or(false);
                    if terminal {
                        self.state
                            .ui
                            .show_toast("subagent already finished".to_string());
                    } else if self.state.subagent_registry.cancel(&id) {
                        let short: String = id.chars().take(8).collect();
                        self.state.ui.show_toast(format!("✓ kill sent {short}…"));
                    } else {
                        self.state
                            .ui
                            .show_toast("subagent is no longer running".to_string());
                    }
                    self.state.ui.needs_render = true;
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn handle_session_picker_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        if self.state.picker.session_picker_browsing {
            return self.handle_folder_browse_key(key);
        }

        if self.state.picker.session_picker_folder_active {
            match key.code {
                KeyCode::Enter => {
                    self.state.picker.session_picker_browsing = true;
                    self.state.picker.session_picker_browse_path =
                        self.state.picker.session_picker_folder_input.clone();
                    self.state.picker.session_picker_browse_selected = 0;
                }
                KeyCode::Backspace => {
                    self.state.picker.session_picker_folder_input.pop();
                }
                KeyCode::Esc => {
                    self.state.picker.session_picker_folder_active = false;
                }
                KeyCode::Tab => {
                    self.state.picker.session_picker_folder_active = false;
                }
                KeyCode::Char(c) if is_text_char_modifiers(key.modifiers) => {
                    let ch = resolve_text_char(c, key.modifiers);
                    self.state.picker.session_picker_folder_input.push(ch);
                }
                _ => {}
            }
            return Ok(());
        }

        let sessions = session::list_sessions();
        let folder = self
            .state
            .picker
            .session_picker_folder_input
            .trim()
            .to_string();
        let query = self.state.picker.session_picker_query.to_lowercase();
        let filtered_count = sessions
            .iter()
            .filter(|session| util::session_matches(session, &folder, &query))
            .count();
        let total_items = 1 + filtered_count;

        match key.code {
            KeyCode::Esc => {
                self.state.picker.show_session_picker = false;
                self.state.picker.session_picker_confirm_delete = false;
            }
            KeyCode::Up => {
                self.state.picker.session_picker_confirm_delete = false;
                if self.state.picker.session_picker_selected > 0 {
                    self.state.picker.session_picker_selected -= 1;
                }
            }
            KeyCode::Down => {
                self.state.picker.session_picker_confirm_delete = false;
                if self.state.picker.session_picker_selected < total_items.saturating_sub(1) {
                    self.state.picker.session_picker_selected += 1;
                }
            }
            KeyCode::Enter => {
                let idx = self.state.picker.session_picker_selected;
                if !self.state.can_replace_session() {
                    self.state.add_system_message(
                        "Stop the agent and running subagents before switching sessions"
                            .to_string(),
                    );
                } else {
                    self.perform_session_switch(idx, &sessions, &folder, &query)?;
                }
            }
            KeyCode::Tab => {
                self.state.picker.session_picker_folder_active = true;
            }
            KeyCode::Char(c) if is_text_char_modifiers(key.modifiers) => {
                let ch = resolve_text_char(c, key.modifiers);
                self.state.picker.session_picker_query.push(ch);
                self.state.picker.session_picker_selected = 0;
            }
            KeyCode::Backspace => {
                self.state.picker.session_picker_query.pop();
                self.state.picker.session_picker_selected = 0;
            }
            KeyCode::Delete => {
                let idx = self.state.picker.session_picker_selected;
                if idx > 0 {
                    if self.state.picker.session_picker_confirm_delete {
                        let folder = self.state.picker.session_picker_folder_input.trim();
                        let query = self.state.picker.session_picker_query.to_lowercase();
                        let sessions = session::list_sessions();
                        let filtered: Vec<_> = sessions
                            .iter()
                            .filter(|session| util::session_matches(session, folder, &query))
                            .collect();
                        if let Some(meta) = filtered.get(idx - 1) {
                            let sid = meta.session_id;
                            self.persistence.delete(sid);
                            self.state
                                .ui
                                .recent_sessions
                                .retain(|s| s.session_id != sid);
                            self.state.ui.needs_render = true;
                        }
                        self.state.picker.session_picker_confirm_delete = false;
                        if self.state.picker.session_picker_selected > 0 {
                            self.state.picker.session_picker_selected -= 1;
                        }
                    } else {
                        self.state.picker.session_picker_confirm_delete = true;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Switch to the selected session after all owned tasks are terminal.
    pub(super) fn perform_session_switch(
        &mut self,
        idx: usize,
        sessions: &[agente_core::session::SessionMeta],
        folder: &str,
        query: &str,
    ) -> anyhow::Result<()> {
        if !self.state.can_replace_session() {
            return Ok(());
        }

        // Perform the actual session switch
        if idx == 0 {
            let project_dir = if folder.is_empty() {
                agente_core::util::normalize_project_dir(std::env::current_dir()?)
            } else {
                let expanded = util::shellexpand_folder(folder);
                std::fs::create_dir_all(&expanded)?;
                std::fs::canonicalize(&expanded)
                    .map(agente_core::util::normalize_project_dir)
                    .unwrap_or_else(|_| agente_core::util::normalize_project_dir(expanded.as_str()))
            };
            self.switch_to_project_dir(project_dir)?;
        } else {
            let filtered: Vec<_> = sessions
                .iter()
                .filter(|session| util::session_matches(session, folder, query))
                .collect();
            if let Some(meta) = filtered.get(idx - 1) {
                if let Ok(data) = session::load_session(&meta.session_id) {
                    self.open_saved_session(&data);
                }
                self.state.picker.close();
            }
        }
        Ok(())
    }

    pub(super) fn handle_folder_browse_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc => {
                if self.state.picker.session_picker_project_select {
                    self.state.picker.close();
                } else {
                    self.select_browsed_folder();
                }
            }
            KeyCode::Tab => {
                if self.state.picker.session_picker_project_select {
                    let path = self.state.picker.session_picker_browse_path.clone();
                    self.switch_to_project_dir(path)?;
                } else {
                    self.select_browsed_folder();
                }
            }
            KeyCode::Up => {
                if self.state.picker.session_picker_browse_selected > 0 {
                    self.state.picker.session_picker_browse_selected -= 1;
                }
            }
            KeyCode::Down => {
                let entries = list_directory(&self.state.picker.session_picker_browse_path);
                if self.state.picker.session_picker_browse_selected
                    < entries.len().saturating_sub(1)
                {
                    self.state.picker.session_picker_browse_selected += 1;
                }
            }
            KeyCode::Enter => {
                let entries = list_directory(&self.state.picker.session_picker_browse_path);
                if let Some(entry) = entries.get(self.state.picker.session_picker_browse_selected) {
                    if entry.is_dir {
                        let current = &self.state.picker.session_picker_browse_path;
                        let new_path = if current.is_empty() {
                            entry.name.clone()
                        } else {
                            std::path::Path::new(current)
                                .join(&entry.name)
                                .to_string_lossy()
                                .to_string()
                        };
                        self.state.picker.session_picker_browse_path = new_path;
                        self.state.picker.session_picker_browse_selected = 0;
                    }
                }
            }
            KeyCode::Backspace => {
                let path = &self.state.picker.session_picker_browse_path;
                if let Some(parent) = std::path::Path::new(path).parent() {
                    self.state.picker.session_picker_browse_path =
                        parent.to_string_lossy().to_string();
                    self.state.picker.session_picker_browse_selected = 0;
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn select_browsed_folder(&mut self) {
        self.state.picker.session_picker_browsing = false;
        self.state.picker.session_picker_folder_input =
            self.state.picker.session_picker_browse_path.clone();
        self.state.picker.session_picker_selected = 0;
    }

    pub(super) fn open_session_picker(&mut self) {
        let project_dir = self.state.session.project_dir.clone();
        self.state.picker.open_sessions(project_dir);
    }

    pub(super) fn open_project_picker(&mut self) {
        let project_dir = self.state.session.project_dir.clone();
        self.state.picker.open_project_selector(project_dir);
    }

    pub(super) fn switch_to_project_dir(&mut self, path: String) -> anyhow::Result<()> {
        if !self.state.can_replace_session() {
            self.state.add_system_message(
                "Stop the agent and running subagents before switching projects".to_string(),
            );
            return Ok(());
        }
        let project_dir = if path.trim().is_empty() {
            agente_core::util::normalize_project_dir(std::env::current_dir()?)
        } else {
            let expanded = util::shellexpand_folder(path.trim());
            std::fs::create_dir_all(&expanded)?;
            agente_core::util::normalize_project_dir(std::fs::canonicalize(&expanded)?)
        };

        self.flush_state_to_disk();
        let config = agente_core::config::AppConfig::load_for_project(
            &project_dir,
            self.state.config.config.catalog.clone(),
        );
        self.reset_current_session(project_dir.clone(), config);
        self.state.picker.close();
        self.state
            .add_system_message(format!("Project set to {project_dir}"));
        self.state.persist_config();
        Ok(())
    }

    pub(super) fn start_new_session(&mut self) {
        if !self.state.can_replace_session() {
            self.state.add_system_message(
                "Stop the agent and running subagents before starting a new session".to_string(),
            );
            return;
        }
        // Persist the outgoing session so it stays resumable from the picker,
        // then replace it in place with a fresh session identity.
        self.flush_state_to_disk();
        self.current_task_id = self.next_task_id();
        self.state.reset_for_new_session();
        // Straight to work: the hero steps aside and every key goes to the
        // composer; the empty chat eases in so the switch reads as intended.
        self.state.ui.show_welcome_screen = false;
        if !self.state.ui.reduce_motion {
            self.state.ui.surface_fade = Some(crate::state::anim::Tween::start(
                crate::state::anim::MODAL_MS,
            ));
        }
        self.state.ui.show_toast("New session started".to_string());
        self.state.ui.needs_render = true;
    }

    pub(super) fn reset_current_session(
        &mut self,
        project_dir: String,
        config: agente_core::config::AppConfig,
    ) {
        self.current_task_id = self.next_task_id();
        let before = std::sync::Arc::clone(&self.state.config.mcp_manager);
        self.state.reset_for_project(project_dir, config);
        if !std::sync::Arc::ptr_eq(&before, &self.state.config.mcp_manager) {
            let _guard = self.runtime.enter();
            super::spawn_mcp_connect(&self.state);
        }
    }

    /// Welcome button keys. Returns true when the key was handled (do not route further).
    fn handle_welcome_key(&mut self, key: KeyEvent) -> anyhow::Result<bool> {
        use crate::widgets::welcome;

        let n = welcome::action_count();
        if n == 0 {
            return Ok(false);
        }
        let sel = self.state.ui.welcome_selected.min(n - 1);
        self.state.ui.welcome_selected = sel;
        match key.code {
            KeyCode::Left | KeyCode::Up => {
                let i = self.state.ui.welcome_selected;
                self.state.ui.welcome_selected = if i == 0 { n - 1 } else { i - 1 };
                self.state.ui.needs_render = true;
                Ok(true)
            }
            KeyCode::Right | KeyCode::Down => {
                self.state.ui.welcome_selected = (self.state.ui.welcome_selected + 1) % n;
                self.state.ui.needs_render = true;
                Ok(true)
            }
            // Tab / Shift+Tab never navigate here — the hero is arrow +
            // mouse only, and every Tab spelling belongs to the mode toggle
            // (or slash autocomplete in the composer).
            KeyCode::Enter => {
                if let Some(cmd) = welcome::action_at(self.state.ui.welcome_selected) {
                    self.execute_command(cmd)?;
                }
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::App;
    use agente_core::config::AppConfig;
    use agente_core::types::ChatEntry;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    fn test_app() -> App {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        App::new_for_test(AppConfig::default(), "/tmp/key-test".to_string(), runtime).unwrap()
    }

    #[test]
    fn typed_skill_command_loads_the_skill_for_the_turn() {
        let project = tempfile::tempdir().unwrap();
        let dir = project.path().join(".agente/skills/zq-lint");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: zq-lint\ndescription: Lint things\n---\nRun the linter twice.",
        )
        .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            project.path().to_string_lossy().into_owned(),
            runtime,
        )
        .unwrap();
        app.state.ui.show_welcome_screen = false;
        for c in "/zq-lint check src".chars() {
            app.handle_key(key(KeyCode::Char(c), KeyModifiers::NONE))
                .unwrap();
        }
        // The turn spawns its task on the ambient runtime.
        let ambient = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = ambient.enter();
        let _ = app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE));

        let bubble = app
            .state
            .session
            .chat_history
            .iter()
            .rev()
            .find(|e| e.role == types::Role::User)
            .expect("user bubble");
        assert_eq!(
            bubble.content, "/zq-lint check src",
            "the bubble shows what was typed"
        );
        let sent = app
            .state
            .session
            .conversation
            .iter()
            .rev()
            .find(|m| m.role == types::Role::User)
            .expect("user turn");
        assert!(
            sent.content.starts_with("<skill_content name=\"zq-lint\">"),
            "{}",
            sent.content
        );
        assert!(sent.content.contains("Run the linter twice."));
        assert!(sent.content.ends_with("check src"));
    }

    #[test]
    fn dropped_media_asks_attaches_and_travels_with_the_message() {
        let mut app = test_app();
        app.state.ui.show_welcome_screen = false;
        app.state.config.current_provider = "stub".into();
        app.state.config.current_model = "stub-text".into();
        let dir = tempfile::tempdir().unwrap();
        let shot = dir.path().join("my shot.png");
        std::fs::write(&shot, b"not really a png").unwrap();

        // A terminal drop pastes the (quoted) path.
        app.insert_paste(&format!("'{}'", shot.display()));
        let asked = app
            .state
            .ui
            .media_consent
            .clone()
            .expect("images ask first");
        assert_eq!(asked.name, "my shot.png");
        assert!(
            app.state.input.input_text.is_empty(),
            "the path is not typed in"
        );
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert!(app.state.ui.media_consent.is_none());
        assert_eq!(app.state.input.attachments.len(), 1);
        assert!(std::path::Path::new(&app.state.input.attachments[0].path).exists());

        // A text-only model: nothing is sent, the attachment stays.
        for c in "what is this".chars() {
            app.handle_key(key(KeyCode::Char(c), KeyModifiers::NONE))
                .unwrap();
        }
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert!(app.state.session.conversation.is_empty());
        assert_eq!(app.state.input.attachments.len(), 1);
        assert_eq!(app.state.input.input_text, "what is this");

        // A vision model takes it.
        app.state.config.current_model = "stub-vision".into();
        let ambient = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = ambient.enter();
        let _ = app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.state.input.attachments.is_empty());
        let sent = app
            .state
            .session
            .conversation
            .iter()
            .rev()
            .find(|m| m.role == types::Role::User)
            .expect("sent");
        assert_eq!(sent.content, "what is this");
        assert_eq!(sent.attachments.len(), 1);
        let bubble = app.state.session.chat_history.last().unwrap();
        assert_eq!(bubble.attachments.len(), 1, "the bubble shows it too");
    }

    #[test]
    fn always_allow_skips_the_question_next_time() {
        let mut app = test_app();
        let dir = tempfile::tempdir().unwrap();
        let clip = dir.path().join("clip.mp4");
        std::fs::write(&clip, b"video").unwrap();
        app.insert_paste(&clip.to_string_lossy());
        app.handle_key(key(KeyCode::Char('a'), KeyModifiers::NONE))
            .unwrap();
        assert_eq!(
            app.state.config.config.allow_media,
            [agente_core::media::AttachmentKind::Video]
        );
        app.state.input.attachments.clear();
        app.insert_paste(&clip.to_string_lossy());
        assert!(app.state.ui.media_consent.is_none(), "no question now");
        assert_eq!(app.state.input.attachments.len(), 1);
        // Esc on a question declines.
        let png = dir.path().join("x.png");
        std::fs::write(&png, b"png").unwrap();
        app.insert_paste(&png.to_string_lossy());
        app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.state.input.attachments.len(), 1, "declined");
    }

    #[test]
    fn enter_queues_and_enter_again_sends_now() {
        let mut app = test_app();
        app.state.ui.show_welcome_screen = false;
        app.state.config.current_provider = "stub".into();
        app.state.agent.state = AgentState::Executing;
        let enter = |app: &mut App| {
            app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
                .unwrap()
        };
        for c in "run the tests".chars() {
            app.handle_key(key(KeyCode::Char(c), KeyModifiers::NONE))
                .unwrap();
        }
        enter(&mut app);
        assert_eq!(app.state.agent.message_queue.len(), 1, "queued");
        assert!(
            app.state.session.chat_history.is_empty(),
            "no bubble before it is sent"
        );

        // Up on an empty composer edits it; Enter re-queues.
        app.handle_key(key(KeyCode::Up, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.state.input.input_text, "run the tests");
        assert!(app.state.agent.message_queue.is_empty());
        enter(&mut app);

        // Enter again on the empty composer: hand it to the running turn.
        enter(&mut app);
        assert!(app.state.agent.message_queue[0].sending);
        let inbox: Vec<String> = app
            .state
            .agent
            .user_inbox
            .lock()
            .iter()
            .map(|m| m.content.clone())
            .collect();
        assert_eq!(inbox, ["run the tests"]);

        // The loop takes it: now it is a bubble.
        app.inject_agent_event(agente_core::agent::AgentEvent::UserMessagesInjected {
            messages: vec!["run the tests".into()],
        });
        app.process_agent_events();
        assert!(app.state.agent.message_queue.is_empty());
        assert_eq!(
            app.state.session.chat_history.last().unwrap().content,
            "run the tests"
        );
    }

    #[test]
    fn mcp_dialog_enables_and_turns_off_servers() {
        let mut config = AppConfig::default();
        config.mcp.insert(
            "docs".into(),
            agente_core::mcp::McpConfig {
                command: vec!["true".into()],
                enabled: false,
                ..Default::default()
            },
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(config, "/tmp/mcp-key-test".into(), runtime).unwrap();
        app.execute_command(crate::command_palette::Command::Mcp)
            .unwrap();
        assert_eq!(
            crate::state::modal_owner(&app.state),
            crate::state::ModalOwner::Mcp
        );
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert!(app.state.config.config.mcp["docs"].enabled, "Enter enables");
        app.handle_key(key(KeyCode::Char('d'), KeyModifiers::NONE))
            .unwrap();
        assert!(
            !app.state.config.config.mcp["docs"].enabled,
            "d turns it off"
        );
        assert_eq!(
            app.state.config.mcp_manager.snapshots()[0].status,
            agente_core::mcp::ServerStatus::Disabled
        );
        app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE))
            .unwrap();
        assert!(!app.state.input.show_mcp);
    }

    #[test]
    fn skills_dialog_enter_puts_the_command_in_the_composer() {
        let mut app = test_app();
        app.state.input.show_skills = true;
        app.state.input.skills = vec![agente_core::extensions::Skill {
            name: "pdf".into(),
            description: "PDFs".into(),
            source: "/s/pdf/SKILL.md".into(),
            dir: "/s/pdf".into(),
            scope: agente_core::extensions::SkillScope::User,
            model_invocable: true,
            compatibility: None,
        }];
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert!(!app.state.input.show_skills);
        assert_eq!(app.state.input.input_text, "/pdf ");
        assert_eq!(app.state.input.input_cursor, 5);
    }

    fn chat_entry(content: &str) -> ChatEntry {
        ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: types::Role::User,
            content: content.to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: None,
            mode: "Build".into(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        }
    }

    #[test]
    fn ctrl_n_starts_a_fresh_session_in_place() {
        let mut app = test_app();
        let old_id = app.state.session.session_id;
        app.state
            .session
            .chat_history
            .push(chat_entry("hello from session one"));
        app.state.input.input_text = "draft one".to_string();
        app.state.input.input_cursor = 9;

        app.handle_key(key(KeyCode::Char('n'), KeyModifiers::CONTROL))
            .unwrap();

        // Fresh identity, empty conversation, cleared composer.
        assert_ne!(app.state.session.session_id, old_id);
        assert!(app.state.session.chat_history.is_empty());
        assert!(app.state.input.input_text.is_empty());
        // The hero steps aside: the empty chat owns the screen, keys go to
        // the composer.
        assert!(!app.state.ui.show_welcome_screen);
        // The toast confirms — no system message pollutes the new transcript.
        assert!(app.state.ui.toast.is_some());
    }

    #[test]
    fn hero_new_session_dismisses_the_hero_and_focuses_the_composer() {
        let mut app = test_app();
        app.state.ui.show_welcome_screen = true;
        app.state.ui.welcome_selected = 0; // "New session"
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert!(!app.state.ui.show_welcome_screen, "hero is gone");
        // Keys now type into the composer instead of driving the menu.
        app.handle_key(key(KeyCode::Char('h'), KeyModifiers::NONE))
            .unwrap();
        app.handle_key(key(KeyCode::Down, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.state.input.input_text, "h");
        assert_eq!(app.state.ui.welcome_selected, 0);
    }

    #[test]
    fn alt_digits_type_instead_of_switching_sessions() {
        let mut app = test_app();
        let old_id = app.state.session.session_id;
        // Alt is a text modifier (Alt+Q yields `@` on Latin layouts), so the
        // freed tab bindings fall through to the composer as plain text.
        for digit in ['1', '2', '9'] {
            app.handle_key(key(KeyCode::Char(digit), KeyModifiers::ALT))
                .unwrap();
        }
        assert_eq!(app.state.session.session_id, old_id);
        assert_eq!(app.state.input.input_text, "129");

        // Plain typing still inserts text (catch-all unaffected).
        app.handle_key(key(KeyCode::Char('x'), KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.state.input.input_text, "129x");
    }

    #[test]
    fn alt_w_types_instead_of_closing() {
        let mut app = test_app();
        let old_id = app.state.session.session_id;
        app.handle_key(key(KeyCode::Char('w'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.state.session.session_id, old_id);
        assert_eq!(app.state.input.input_text, "w");
    }

    #[test]
    fn ctrl_tab_toggles_mode() {
        let mut app = test_app();
        let before = app.state.agent.work_mode();
        app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
            .unwrap();
        assert_ne!(
            app.state.agent.work_mode(),
            before,
            "Ctrl+Tab must toggle plan/build mode"
        );
        // Plan → build → auto: the third press returns to the start.
        for _ in 0..2 {
            app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
                .unwrap();
        }
        assert_eq!(app.state.agent.work_mode(), before);
    }

    #[test]
    fn settings_toggles_smart_compaction_which_defaults_off() {
        let mut app = test_app();
        assert!(!app.state.config.config.smart_compaction, "off by default");
        app.execute_command(crate::command_palette::Command::Settings)
            .unwrap();
        app.state.input.settings_selected = 0; // Smart compaction
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert!(app.state.config.config.smart_compaction);
        app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE))
            .unwrap();
        assert!(!app.state.input.show_settings);
    }

    #[test]
    fn exit_hint_names_the_session_to_resume() {
        let mut app = test_app();
        assert_eq!(
            app.resume_hint(),
            None,
            "nothing to resume in an empty session"
        );
        app.state.add_user_message("Fix the retry loop".into());
        let hint = app.resume_hint().expect("hint");
        let id = app.state.session.session_id.to_string();
        assert!(hint.contains(&format!("agente --resume {id}")), "{hint}");
        assert!(hint.contains("Fix the retry loop"), "labelled: {hint}");
    }

    #[test]
    fn fork_from_a_sent_message_starts_a_branch_session() {
        let mut app = test_app();
        let user = |content: &str| types::Message {
            role: types::Role::User,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        };
        app.state.add_user_message("first".into());
        app.state.session.conversation.push(user("first"));
        app.state.add_user_message("second".into());
        app.state.session.conversation.push(user("second"));
        let old_session = app.state.session.session_id;
        let second = app.state.session.chat_history[1].id;

        app.state.ui.message_actions = Some(second);
        app.handle_key(key(KeyCode::Char('f'), KeyModifiers::NONE))
            .unwrap();

        assert_ne!(app.state.session.session_id, old_session, "new session");
        assert!(app.state.ui.message_actions.is_none(), "dialog closed");
        assert_eq!(
            app.state.session.chat_history.len(),
            1,
            "chat up to the message"
        );
        assert_eq!(app.state.session.conversation.len(), 1);
        assert_eq!(
            app.state.input.input_text, "second",
            "message back in the input"
        );
    }

    #[test]
    fn subagent_calls_count_for_the_child_and_the_session() {
        use agente_core::agent::AgentEvent;
        let mut app = test_app();
        app.inject_agent_event(AgentEvent::SubagentStarted {
            id: "child".into(),
            subagent_type: "explore".into(),
            description: "look around".into(),
            model: "test-model".into(),
        });
        let call = |cost, subagent_id: Option<&str>| AgentEvent::CallUsage {
            prompt_tokens: 100,
            completion_tokens: 10,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost_usd: Some(cost),
            cost_estimated: false,
            subagent_id: subagent_id.map(str::to_string),
        };
        app.inject_agent_event(call(0.004, Some("child")));
        app.inject_agent_event(call(0.010, None));
        app.process_agent_events();
        let child = &app.state.agent.subagents["child"].spend;
        assert_eq!(child.cost_label().as_deref(), Some("$0.004"));
        assert_eq!(app.state.agent.spend.cost_label().as_deref(), Some("$0.01"));
    }

    #[test]
    fn compaction_shows_progress_then_a_transcript_divider() {
        use agente_core::agent::AgentEvent;
        let mut app = test_app();
        app.state.agent.state = types::AgentState::StreamingResponse;
        app.inject_agent_event(AgentEvent::CompactionStarted {
            smart: true,
            model: Some("test-model".into()),
        });
        app.process_agent_events();
        assert_eq!(app.state.agent.compacting, Some(true));
        // A heartbeat during a slow summary keeps the indicator up.
        app.inject_agent_event(AgentEvent::ToolHeartbeat { id: String::new() });
        app.process_agent_events();
        assert_eq!(app.state.agent.compacting, Some(true));

        app.inject_agent_event(AgentEvent::ContextCompacted {
            summary: "checkpoint".into(),
            tokens_before: 182_000,
            tokens_after: 64_000,
            smart: true,
            compacted_conversation: Vec::new(),
        });
        app.process_agent_events();
        assert_eq!(app.state.agent.compacting, None);
        let last = app.state.session.chat_history.last().unwrap();
        assert_eq!(
            last.content,
            "⟲ Context compacted · ~182k → ~64k · summarized"
        );
    }

    #[test]
    fn auto_mode_is_build_with_every_call_approved() {
        let mut app = test_app();
        app.state
            .agent
            .select_work_mode(crate::state::WorkMode::Plan, true);
        let cycle: Vec<_> = (0..3)
            .map(|_| {
                app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
                    .unwrap();
                app.state.agent.work_mode()
            })
            .collect();
        use crate::state::WorkMode::*;
        assert_eq!(cycle, [Build, Auto, Plan]);

        app.state.agent.select_work_mode(Auto, true);
        assert_eq!(app.state.agent.mode, types::AgentMode::Build);
        assert!(app.state.agent.auto_approve_all(), "auto approves");
        assert_eq!(app.state.config.config.default_mode, Some("plan".into()));
        app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
            .unwrap();
        assert_eq!(app.state.agent.work_mode(), Plan);
        assert!(
            !app.state.agent.auto_approve_all(),
            "leaving auto stops approving"
        );
        assert_eq!(app.state.config.config.default_mode, Some("plan".into()));
    }

    #[test]
    fn ctrl_tab_terminal_spellings_all_toggle_mode() {
        for (code, modifiers) in [
            (KeyCode::Tab, KeyModifiers::CONTROL | KeyModifiers::SHIFT),
            (KeyCode::BackTab, KeyModifiers::CONTROL),
            (
                KeyCode::BackTab,
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
        ] {
            let mut app = test_app();
            let before = app.state.agent.work_mode();
            app.handle_key(key(code, modifiers)).unwrap();
            assert_ne!(app.state.agent.work_mode(), before);
        }
    }

    #[test]
    fn ctrl_tab_bypasses_welcome_button_navigation() {
        let mut single = test_app();
        single.state.ui.show_welcome_screen = true;
        single.state.ui.welcome_selected = 1;
        let mode = single.state.agent.work_mode();

        single
            .handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
            .unwrap();

        assert_eq!(single.state.ui.welcome_selected, 1);
        assert_ne!(single.state.agent.work_mode(), mode);
    }

    #[test]
    fn ctrl_tab_selects_next_mode_while_agent_runs() {
        let mut app = test_app();
        let before = app.state.agent.work_mode();
        app.state.agent.current_turn_mode = before.agent_mode();
        let permission_mode = app
            .state
            .agent
            .shared_permission_engine
            .read()
            .unwrap()
            .mode;
        app.state.agent.state = types::AgentState::Executing;
        app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
            .unwrap();
        assert_ne!(
            app.state.agent.work_mode(),
            before,
            "next-turn mode changed"
        );
        assert_eq!(
            app.state.agent.current_turn_mode,
            before.agent_mode(),
            "the running turn keeps its original mode"
        );
        assert_eq!(
            app.state
                .agent
                .shared_permission_engine
                .read()
                .unwrap()
                .mode,
            permission_mode,
            "the running turn keeps its original permissions"
        );
        assert!(app
            .state
            .session
            .chat_history
            .iter()
            .any(|e| e.content.contains("Next turn")));
    }

    #[test]
    fn ctrl_n_is_refused_while_agent_runs() {
        let mut app = test_app();
        app.state
            .session
            .chat_history
            .push(chat_entry("in-progress work"));
        let before = app.state.session.session_id;
        app.state.agent.state = types::AgentState::Executing;

        app.handle_key(key(KeyCode::Char('n'), KeyModifiers::CONTROL))
            .unwrap();

        assert_eq!(app.state.session.session_id, before);
        assert!(app
            .state
            .session
            .chat_history
            .iter()
            .any(|entry| entry.content.contains("Stop the agent")));
    }

    /// `r` is text, not a shortcut.
    ///
    /// It was bound bare to "refresh models" ahead of the text arm, so no
    /// model whose name contains an r -- turbo, nemotron, mistral,
    /// claude -- could be searched for at all.
    #[test]
    fn model_selector_typing_r_searches_instead_of_refreshing() {
        let mut app = test_app();
        app.state
            .config
            .connected_providers
            .push("openrouter".into());
        app.state.config.current_provider = "openrouter".into();
        app.state.input.show_model_selector = true;

        for ch in "turbo".chars() {
            app.handle_key(key(KeyCode::Char(ch), KeyModifiers::NONE))
                .unwrap();
        }

        assert_eq!(app.state.input.model_selector_query, "turbo");
        assert!(
            app.state.config.discovery_status.is_empty(),
            "typing must not kick off a model fetch"
        );
    }

    /// Refresh moved to Ctrl+R (and F5), which cannot collide with typing.
    #[test]
    fn model_selector_ctrl_r_refreshes_the_browsed_provider() {
        let mut app = test_app();
        app.state
            .config
            .connected_providers
            .push("openrouter".into());
        app.state.config.current_provider = "openrouter".into();
        app.state.input.show_model_selector = true;

        // Discovery spawns onto the ambient tokio runtime; enter one for the
        // duration of the key handling.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = rt.enter();
        app.handle_key(key(KeyCode::Char('r'), KeyModifiers::CONTROL))
            .unwrap();

        assert!(matches!(
            app.state.config.discovery_status.get("openrouter"),
            Some(crate::state::DiscoveryStatus::InProgress)
        ));
    }

    #[test]
    fn resize_wakes_idle_ui_without_changing_draft_or_scroll_mode() {
        let mut app = test_app();
        app.state.ui.needs_render = false;
        app.state.ui.chat_auto_scroll = false;
        app.state.input.input_text = "unfinished draft".into();
        app.state.input.show_model_selector = true;
        app.handle_terminal_event(Event::Resize(60, 18)).unwrap();
        assert!(app.state.ui.needs_render);
        assert!(!app.state.ui.chat_auto_scroll);
        assert_eq!(app.state.input.input_text, "unfinished draft");
        assert!(app.state.input.show_model_selector);
    }

    #[test]
    fn refresh_all_providers_preserves_search_without_ambient_runtime() {
        let mut app = test_app();
        app.state.config.connected_providers = vec!["openrouter".into(), "openai".into()];
        app.state.input.show_model_selector = true;
        app.state.input.model_selector_provider = None;
        app.state.input.model_selector_query = "coding".into();
        app.handle_key(key(KeyCode::F(5), KeyModifiers::NONE))
            .unwrap();
        for provider in ["openrouter", "openai"] {
            assert_eq!(
                app.state.config.discovery_status.get(provider),
                Some(&crate::state::DiscoveryStatus::InProgress)
            );
        }
        assert_eq!(app.state.input.model_selector_query, "coding");
    }

    /// The provider scope and the search query are separate state: cycling one
    /// must not clear the other. They shared a single string before, so typing
    /// erased the provider and pressing an arrow erased the search.
    #[test]
    fn model_selector_provider_cycle_preserves_the_query() {
        let mut app = test_app();
        app.state.config.connected_providers = vec!["openrouter".into(), "openai".into()];
        app.state.config.current_provider = "openrouter".into();
        app.state.input.show_model_selector = true;

        for ch in "turbo".chars() {
            app.handle_key(key(KeyCode::Char(ch), KeyModifiers::NONE))
                .unwrap();
        }
        assert_eq!(app.state.input.model_selector_query, "turbo");
        assert_eq!(app.state.input.model_selector_provider, None);

        // Slot order is All -> openrouter -> openai -> All.
        app.handle_key(key(KeyCode::Tab, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(
            app.state.input.model_selector_provider.as_deref(),
            Some("openrouter")
        );
        assert_eq!(
            app.state.input.model_selector_query, "turbo",
            "cycling the provider must not touch the query"
        );

        app.handle_key(key(KeyCode::Tab, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(
            app.state.input.model_selector_provider.as_deref(),
            Some("openai")
        );
        app.handle_key(key(KeyCode::Tab, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(
            app.state.input.model_selector_provider, None,
            "the cycle returns to searching every provider"
        );
        assert_eq!(app.state.input.model_selector_query, "turbo");
    }

    #[test]
    fn provider_key_paste_strips_clipboard_whitespace_and_clears_error() {
        let mut app = test_app();
        app.state
            .config
            .open_enter_key("openai", String::new(), false, "old error".into());

        app.insert_owned_paste("  sk-test-key-123  \r\n");

        assert_eq!(app.state.config.connect_key_input, "sk-test-key-123");
        assert!(matches!(
            &app.state.config.connect_screen,
            crate::state::ConnectScreen::EnterKey { error, .. } if error.is_empty()
        ));
    }

    #[test]
    fn provider_search_keeps_text_input_available_for_all_letters() {
        let mut app = test_app();
        app.state.open_connect_screen();

        for ch in "mistral".chars() {
            app.handle_key(key(KeyCode::Char(ch), KeyModifiers::NONE))
                .unwrap();
        }

        assert!(matches!(
            &app.state.config.connect_screen,
            crate::state::ConnectScreen::SelectProvider { query, selected }
                if query == "mistral" && *selected == 0
        ));
    }

    /// Ctrl+T opens the same model-aware picker as /thinking without writing
    /// a diagnostic into the transcript or touching disk.
    #[test]
    fn ctrl_t_opens_thinking_picker_without_transcript_noise() {
        let mut app = test_app();
        app.handle_key(key(KeyCode::Char('t'), KeyModifiers::CONTROL))
            .unwrap();
        assert!(app.state.input.show_thinking_selector);
        assert!(app.state.session.chat_history.is_empty());
    }

    #[test]
    fn thinking_picker_enter_applies_level_and_only_sets_a_toast() {
        let mut app = test_app();
        app.state.input.open_thinking_selector(
            &["off".to_string(), "high".to_string(), "xhigh".to_string()],
            "off",
        );
        app.state.input.thinking_selector_selected = 2;
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();

        assert_eq!(app.state.agent.thinking_level, "xhigh");
        assert!(!app.state.input.show_thinking_selector);
        assert!(app.state.session.chat_history.is_empty());
        assert!(app.state.ui.toast.is_some());
    }

    /// Opening parks the cursor on whichever level is currently active, so
    /// Enter without moving is a no-op rather than a surprise change.
    #[test]
    fn thinking_selector_opens_on_the_active_level() {
        let mut app = test_app();
        let levels = vec!["off".to_string(), "high".to_string(), "max".to_string()];

        app.state.input.open_thinking_selector(&levels, "max");
        assert_eq!(app.state.input.thinking_selector_selected, 2);

        app.state.input.open_thinking_selector(&levels, "high");
        assert_eq!(app.state.input.thinking_selector_selected, 1);

        // An unknown level falls back to the first row instead of panicking.
        app.state.input.open_thinking_selector(&levels, "bogus");
        assert_eq!(app.state.input.thinking_selector_selected, 0);
    }

    /// The picker owns the modal slot, so it inherits the opaque backdrop and
    /// suppresses the chat scrollbar like every other floating card.
    #[test]
    fn thinking_selector_is_a_floating_modal() {
        let mut app = test_app();
        app.state.input.show_thinking_selector = true;
        let owner = crate::state::modal_owner(&app.state);
        assert_eq!(owner, crate::state::ModalOwner::ThinkingSelector);
        assert!(owner.floats_over_chat(), "must get the backdrop");
        assert!(owner.is_modal(), "must suppress the chat scrollbar");
    }

    #[test]
    fn palette_receives_every_typed_character() {
        let mut app = test_app();
        // Open via the real binding.
        app.handle_key(key(KeyCode::Char('p'), KeyModifiers::CONTROL))
            .unwrap();
        assert!(app.state.input.show_command_palette);

        let alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 -_";
        for ch in alphabet.chars() {
            app.handle_key(key(KeyCode::Char(ch), KeyModifiers::NONE))
                .unwrap();
        }
        let query = app.state.input.command_palette_query.clone();
        for ch in alphabet.chars() {
            assert!(
                query.contains(ch),
                "character {ch:?} missing from palette query (query: {query:?})"
            );
        }

        // Shifted letters must also land.
        app.handle_key(key(KeyCode::Char('z'), KeyModifiers::SHIFT))
            .unwrap();
        let ends_ok = app.state.input.command_palette_query.ends_with('z')
            || app.state.input.command_palette_query.ends_with('Z');
        assert!(ends_ok, "shifted letter not registered");
    }

    #[test]
    fn palette_accepts_altgr_and_ignores_ctrl_shortcuts() {
        let mut app = test_app();
        app.handle_key(key(KeyCode::Char('p'), KeyModifiers::CONTROL))
            .unwrap();

        // AltGr (CONTROL|ALT on international layouts) is text input: the
        // restrictive NONE|SHIFT pattern used to drop it.
        app.handle_key(key(
            KeyCode::Char('['),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        ))
        .unwrap();
        assert_eq!(app.state.input.command_palette_query, "[");

        // Plain Ctrl chords stay shortcuts, never text.
        app.handle_key(key(KeyCode::Char('x'), KeyModifiers::CONTROL))
            .unwrap();
        assert_eq!(app.state.input.command_palette_query, "[");
    }
}
