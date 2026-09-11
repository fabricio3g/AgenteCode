//! Session information rendered in the transcript instead of a side panel.
use super::AppState;
use agente_core::types::{Role, TodoStatus};

impl AppState {
    fn plan_summary(&self) -> String {
        let mut content = String::from("### Plan\n\n");
        if self.get_todos().is_empty() {
            content.push_str("No plan steps yet.");
        }
        for todo in self.get_todos() {
            let (glyph, status) = match todo.status {
                TodoStatus::Completed => ("✓", "done"),
                TodoStatus::InProgress => ("◉", "in progress"),
                TodoStatus::Cancelled => ("✗", "cancelled"),
                TodoStatus::Pending => ("○", "pending"),
            };
            content.push_str(&format!("- {glyph} {} · {status}\n", todo.content));
        }
        content
    }

    /// Refresh the current turn's checklist without stealing the reader's scroll.
    /// Completed turns retain their own plan snapshots in session history.
    pub fn refresh_plan_in_chat(&mut self) {
        let content = self.plan_summary();
        let existing = self
            .session
            .chat_history
            .iter_mut()
            .rev()
            .take_while(|entry| entry.role != Role::User)
            .find(|entry| entry.role == Role::System && entry.content.starts_with("### Plan\n"));
        if let Some(entry) = existing {
            if entry.content == content {
                return;
            }
            entry.content = content;
            let id = entry.id;
            self.ui.invalidate_chat_entry(&id);
        } else {
            self.session.add_system_message(content);
        }
        self.ui.needs_render = true;
    }

    /// An explicit command puts the current checklist at the reading position.
    pub fn show_plan_in_chat(&mut self) {
        let content = self.plan_summary();
        if !self
            .session
            .chat_history
            .last()
            .is_some_and(|entry| entry.role == Role::System && entry.content == content)
        {
            self.session.add_system_message(content);
        }
        self.ui.show_welcome_screen = false;
        self.ui.scroll_to_bottom();
        self.ui.needs_render = true;
    }

    /// Agent-tracked changes and their diffs share normal chat wrapping and scrolling.
    pub fn show_changes_in_chat(&mut self) {
        let mut content = String::from("### Changes\n\n");
        if self.session.modified_files.is_empty() {
            content.push_str("No file changes in this session. Use @ to find project files.");
        }
        for file in &self.session.modified_files {
            content.push_str(&format!(
                "#### {} · +{} / -{}\n\n",
                file.path, file.additions, file.deletions
            ));
            let before = self
                .session
                .file_originals
                .get(&file.path)
                .and_then(|value| value.as_deref())
                .unwrap_or("");
            let after = self
                .session
                .file_versions
                .get(&file.path)
                .map(String::as_str)
                .unwrap_or("");
            let diff = similar::TextDiff::from_lines(before, after)
                .unified_diff()
                .context_radius(3)
                .header(&file.path, &file.path)
                .to_string();
            if !diff.is_empty() {
                // A fence longer than any run in file content cannot close early.
                let fence_len = diff
                    .lines()
                    .map(|line| line.chars().filter(|ch| *ch == '`').count())
                    .max()
                    .unwrap_or(0)
                    .max(2)
                    + 1;
                let fence = "`".repeat(fence_len);
                content.push_str(&format!("{fence}diff\n{diff}{fence}\n\n"));
            }
        }
        self.session.add_system_message(content);
        self.ui.show_welcome_screen = false;
        self.ui.scroll_to_bottom();
        self.ui.needs_render = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use agente_core::todo::TodoInput;

    #[test]
    fn plan_updates_reuse_the_card_and_preserve_manual_scroll() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/chat-summary".into());
        state.todo.todos.update(vec![TodoInput {
            content: "Verify the UI".into(),
            status: "pending".into(),
            priority: "high".into(),
        }]);
        state.ui.chat_auto_scroll = false;
        state.ui.chat_scroll = 3;
        state.refresh_plan_in_chat();
        let id = state.session.chat_history.last().unwrap().id;
        state.todo.todos.update(vec![TodoInput {
            content: "Verify the UI".into(),
            status: "completed".into(),
            priority: "high".into(),
        }]);
        state.refresh_plan_in_chat();
        assert_eq!(state.session.chat_history.len(), 1);
        assert_eq!(state.session.chat_history[0].id, id);
        assert!(state.session.chat_history[0].content.contains("done"));
        assert!(!state.ui.chat_auto_scroll);
        assert_eq!(state.ui.chat_scroll, 3);
        assert!(state.session.conversation.is_empty());
    }

    #[test]
    fn changes_are_visible_in_chat_with_diff_and_without_model_messages() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/chat-summary".into());
        state.track_file_change("main.rs", Some("old\n".into()), Some("new\n".into()));
        state.show_changes_in_chat();
        let content = &state.session.chat_history.last().unwrap().content;
        assert!(content.contains("main.rs"));
        assert!(content.contains("-old"));
        assert!(content.contains("+new"));
        assert!(state.session.conversation.is_empty());
        assert!(!state.ui.show_welcome_screen);
        assert!(state.ui.chat_auto_scroll);
    }
}
