//! Composer text editing, paste chips, and inline `@file` / `/slash` pickers.

use agente_core::types::{AgentState, ClickKind};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::app::{util, App};
use crate::command_palette;
use crate::widgets::text_field::{is_text_char_modifiers, resolve_text_char, step_list_selection};

impl App {
    pub(super) fn insert_input_char(&mut self, c: char) {
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
    pub(in crate::app) fn insert_paste(&mut self, text: &str) {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        if normalized.is_empty() {
            return;
        }
        if self.attach_pasted_path(&normalized) {
            return;
        }
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

    /// Open/update/close the `@` file picker based on cursor context.
    pub(super) fn refresh_at_picker_from_input(&mut self) {
        use crate::at_file_picker::{active_at_mention, list_project_files};

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

    pub(super) fn complete_selected_at_file(&mut self) {
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
        let before: String = chars[..anchor.min(chars.len())].iter().collect();
        let after: String = chars[cursor.min(chars.len())..].iter().collect();
        let inserted = format!("@{path}");
        self.state.input.input_text = format!("{before}{inserted}{after}");
        self.state.input.input_cursor = before.chars().count() + inserted.chars().count();
        self.state.input.close_at_picker();
    }

    pub(super) fn handle_composer_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key {
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
                if self.state.input.input_text.is_empty() {
                    if let Some(queued) = self.state.agent.pop_unsent() {
                        self.state.input.input_cursor = queued.display.chars().count();
                        self.state.input.input_text = queued.display;
                        self.state.input.attachments.extend(queued.attachments);
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
                self.state.ui.scroll_to_bottom();
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
                self.state.ui.scroll_to_bottom();
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
                    self.state.input.close_at_picker();
                }
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
                                    self.state.ui.cycle_tool_entry(hovered);
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
                    self.state.agent.thinking_expanded = !self.state.agent.thinking_expanded;
                } else if !self.state.input.input_text.starts_with('/')
                    && self.state.input.input_text.ends_with('\\')
                {
                    self.state.input.input_text.pop();
                    self.state.input.input_text.push('\n');
                    self.state.input.input_cursor = self.state.input.input_text.chars().count();
                } else if let Some(text) = self.state.submit_input() {
                    self.state.input.close_at_picker();
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
                let byte_idx =
                    util::char_to_byte(&self.state.input.input_text, self.state.input.input_cursor);
                self.state.input.input_text.truncate(byte_idx);
            }
            KeyEvent {
                modifiers: KeyModifiers::CONTROL,
                code: KeyCode::Char('u'),
                ..
            } => {
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
                        let last_space = trimmed.rfind(|c: char| c.is_whitespace());
                        let new_cursor = if let Some(pos) = last_space {
                            trimmed[..pos].chars().count() + 1
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
                self.flush_state_to_disk();
                self.state.ui.should_quit = true;
            }
            _ => {}
        }

        Ok(())
    }

    pub(super) fn try_autocomplete_slash_command(&mut self) {
        let query = self
            .state
            .input
            .input_text
            .strip_prefix('/')
            .unwrap_or(&self.state.input.input_text);

        let commands = command_palette::filter_commands(query);
        if commands.len() == 1 {
            self.state.input.input_text = commands[0].slash().to_string();
            self.state.input.input_cursor = self.state.input.input_text.chars().count();
            self.state.input.show_slash_picker = false;
        } else if !commands.is_empty() && !query.is_empty() {
            let first = commands[0].slash();
            let mut common_prefix_chars = first.chars().count();

            for cmd in &commands[1..] {
                let mut i = 0;
                while i < common_prefix_chars {
                    if first.chars().nth(i) != cmd.slash().chars().nth(i) {
                        break;
                    }
                    i += 1;
                }
                common_prefix_chars = i;
            }

            let query_chars = query.chars().count();
            if common_prefix_chars > query_chars {
                let prefix: String = first.chars().take(common_prefix_chars).collect();
                self.state.input.input_text = prefix;
                self.state.input.input_cursor = common_prefix_chars;
                self.state.input.show_slash_picker = true;
                self.state.input.slash_picker_selected = 0;
            } else {
                self.state.input.show_slash_picker = true;
                self.state.input.slash_picker_selected = 0;
            }
        }
    }

    pub(super) fn complete_selected_slash_command(&mut self) {
        let query = self
            .state
            .input
            .input_text
            .strip_prefix('/')
            .unwrap_or(&self.state.input.input_text);

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
    pub(super) fn handle_at_picker_key(&mut self, key: KeyEvent) -> anyhow::Result<bool> {
        use crate::at_file_picker::filter_files;

        let n = filter_files(
            &self.state.input.at_file_cache,
            &self.state.input.at_picker_query,
        )
        .len();

        if step_list_selection(&mut self.state.input.at_picker_selected, n, key.code) {
            return Ok(true);
        }

        match key.code {
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
            _ => Ok(false),
        }
    }

    pub(super) fn handle_slash_picker_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let query_str = self
            .state
            .input
            .input_text
            .strip_prefix('/')
            .unwrap_or(&self.state.input.input_text)
            .to_string();
        let commands = command_palette::filter_commands(&query_str);
        if step_list_selection(
            &mut self.state.input.slash_picker_selected,
            commands.len(),
            key.code,
        ) {
            return Ok(());
        }

        match key {
            KeyEvent {
                code: KeyCode::Esc, ..
            } => {
                self.state.input.show_slash_picker = false;
            }
            KeyEvent {
                code: KeyCode::Enter,
                ..
            } => {
                let has_args = query_str.trim_end().contains(char::is_whitespace);
                match commands.get(self.state.input.slash_picker_selected) {
                    Some(cmd) if !has_args => {
                        self.state.input.show_slash_picker = false;
                        self.state.input.input_text.clear();
                        self.state.input.input_cursor = 0;
                        self.execute_command(*cmd)?;
                    }
                    _ => {
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
                if self.state.input.input_text.starts_with('/') {
                    self.state.input.show_slash_picker = true;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
