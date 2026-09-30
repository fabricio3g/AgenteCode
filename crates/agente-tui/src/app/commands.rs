//! Command palette / slash command execution.

use crate::command_palette::Command;

use super::App;

impl App {
    pub(super) fn execute_command(&mut self, cmd: Command) -> anyhow::Result<()> {
        match cmd {
            Command::ShowHelp => {
                let mut help = String::from("Available commands:\n");
                for command in Command::all() {
                    help.push_str(&format!(
                        "{:<12} {}\n",
                        command.slash(),
                        command.description()
                    ));
                }
                self.state.add_system_message(help.trim_end().to_string());
            }
            Command::ShowHotkeys => {
                self.state.ui.show_help = true;
            }
            Command::ConnectProvider => {
                self.state.open_connect_screen();
            }
            Command::SwitchModel => {
                if self.state.is_connected() {
                    self.state.input.show_model_selector = true;
                    self.state.input.model_selector_query.clear();
                    self.state.input.model_selector_selected = 0;
                } else {
                    self.state.open_connect_screen();
                }
            }
            Command::RefreshModels => {
                let provider = self.state.config.current_provider.clone();
                if provider.is_empty() {
                    self.state
                        .add_system_message("Connect a provider first (/provider)".to_string());
                } else {
                    let name = self.state.get_provider_display_name(&provider);
                    self.spawn_model_discovery(&provider);
                    self.state
                        .add_system_message(format!("Refreshing models for {name}…"));
                }
            }
            Command::ToggleMode => {
                self.toggle_plan_build_mode();
            }
            Command::OpenProject => {
                self.open_project_picker();
            }
            Command::NewSession => {
                self.start_new_session();
            }
            Command::OpenSession => {
                self.open_session_picker();
            }
            Command::ClearConversation => {
                self.state.session.chat_history.clear();
                self.state.ui.clear_chat_render_cache();
                self.state.agent.streaming_text.clear();
                self.state.agent.reasoning_text.clear();
                self.state.session.modified_files.clear();
                self.state.session.file_versions.clear();
                self.state.session.conversation.clear();
                self.state.ui.chat_scroll = 0;
                self.state.ui.chat_content_height = 0;
                self.state.ui.chat_auto_scroll = true;
                // Usage counter is per-conversation — reset so the status bar
                // reflects the new conversation, not the session cumulative sum.
                self.state.agent.total_tokens = 0;
            }
            Command::CompactContext => {
                let before =
                    agente_core::context::estimate_message_tokens(&self.state.session.conversation);
                let (_removed, saved) = self.state.compact_conversation();
                if saved > 0 {
                    self.state
                        .add_system_message(crate::state::compaction_notice(
                            before,
                            before.saturating_sub(saved),
                            false,
                        ));
                } else {
                    // Nothing older than the always-kept recent turns: say so
                    // briefly, without a transcript entry.
                    let used = crate::widgets::hints::format_token_count(before);
                    let window = crate::widgets::hints::context_ratio(&self.state)
                        .map(|(_, limit)| {
                            format!(" of {}", crate::widgets::hints::format_token_count(limit))
                        })
                        .unwrap_or_default();
                    self.state.ui.show_toast(format!(
                        "Nothing to compact yet · {used}{window} used, recent turns are always kept"
                    ));
                }
            }
            Command::ToggleAutoApprove => {
                let new_val = !self.state.agent.auto_approve_all();
                if self.state.set_auto_approve(new_val) {
                    let status = if new_val { "enabled" } else { "disabled" };
                    self.state
                        .add_system_message(format!("Auto-approve {status}"));
                } else {
                    self.state.add_system_message(
                        "Auto-approve can only be changed while the agent is idle.".to_string(),
                    );
                }
            }
            Command::OpenEditor => {
                self.open_editor_for_input()?;
            }
            Command::ExportChat => {
                self.export_chat()?;
            }
            Command::ViewTodos => {
                self.state.show_plan_in_chat();
            }
            Command::CycleThinking => {
                self.open_thinking_selector();
            }
            Command::ToggleTheme => {
                let theme = match crate::style::current_theme() {
                    crate::style::Theme::Dark => crate::style::Theme::Light,
                    crate::style::Theme::Light => crate::style::Theme::Dark,
                };
                // apply_theme also drops theme-colored render caches (their
                // keys carry no theme, so stale rows would survive the flip).
                self.state.apply_theme(theme);
                let name = match theme {
                    crate::style::Theme::Dark => "dark",
                    crate::style::Theme::Light => "light",
                };
                self.state.config.config.theme = Some(name.to_string());
                self.state.persist_config();
                self.state
                    .add_system_message(format!("Switched to {name} theme"));
            }
            Command::StopRun => {
                if self.state.agent.is_idle() {
                    self.state
                        .add_system_message("Agent is not running".to_string());
                } else {
                    self.stop_current_operation();
                }
            }
            Command::Undo => {
                if !self.state.agent.is_idle() {
                    self.state.add_system_message(
                        "Wait for the agent to finish before undoing.".to_string(),
                    );
                } else {
                    match self.state.undo_last_change() {
                        Ok(msg) => self.state.add_system_message(msg),
                        Err(msg) => self.state.add_system_message(msg),
                    }
                }
            }
            Command::Redo => {
                if !self.state.agent.is_idle() {
                    self.state.add_system_message(
                        "Wait for the agent to finish before redoing.".to_string(),
                    );
                } else {
                    match self.state.redo_last_change() {
                        Ok(msg) => self.state.add_system_message(msg),
                        Err(msg) => self.state.add_system_message(msg),
                    }
                }
            }
            Command::InitProject => {
                match agente_core::extensions::init_project(&self.state.session.project_dir) {
                    Ok(msg) => self.state.add_system_message(msg),
                    Err(e) => self.state.add_system_message(format!("/init failed: {e}")),
                }
            }
            Command::ListSubagents => {
                self.state.input.open_subagents();
                self.state.ui.needs_render = true;
            }
            Command::Settings => {
                self.state.input.show_settings = true;
                self.state.ui.needs_render = true;
            }
            Command::NewTab => self.open_new_tab(),
            Command::CloseTab => self.close_tab(self.tabs.active()),
            Command::NextTab => self.cycle_tab(1),
            Command::PrevTab => self.cycle_tab(-1),
            Command::Mcp => {
                self.state.input.mcp_selected = 0;
                self.state.input.show_mcp = true;
                self.state.ui.needs_render = true;
            }
            Command::Skills => {
                self.state.input.skills =
                    agente_core::extensions::skills::discover(&self.state.session.project_dir);
                self.state.input.skills_selected = 0;
                self.state.input.show_skills = true;
                self.state.ui.needs_render = true;
            }
            Command::SubagentModels => {
                let types = crate::subagent_models::subagent_types(&self.state.session.project_dir);
                self.state.input.open_subagent_models(types);
                self.state.ui.needs_render = true;
            }
            Command::Doctor => {
                self.state.input.show_doctor = true;
                self.state.input.doctor_scroll = 0;
                self.state.ui.needs_render = true;
            }
            Command::ViewPlan => {
                self.state.show_plan_in_chat();
            }
            Command::ViewChanges => {
                self.state.show_changes_in_chat();
            }
            Command::Quit => {
                self.flush_state_to_disk();
                self.state.ui.should_quit = true;
            }
        }
        Ok(())
    }

    /// Toggle Plan/Build mode, with feedback. Shared by `/mode`, Ctrl+Tab,
    /// Shift+Tab, and the welcome quick action.
    pub(super) fn toggle_plan_build_mode(&mut self) {
        let applies_next_turn = !self.state.agent.is_idle();
        self.state.toggle_mode();
        let mode = self.state.agent.work_mode().label();
        if applies_next_turn {
            self.state
                .add_system_message(format!("Next turn will use {mode} mode"));
        } else {
            self.state
                .add_system_message(format!("Switched to {mode} mode"));
        }
    }

    /// Open the thinking-effort picker (Ctrl+T / `/thinking`).
    ///
    /// Levels come **only** from models.dev `reasoning_options` on the resolved
    /// model (e.g. DeepSeek V4 → off/high/max). No global Low/Medium/High
    /// ladder. The picker also owns the "no levels available" explanation,
    /// which the old blind-cycle shortcut used to push into chat history.
    pub(super) fn open_thinking_selector(&mut self) {
        // Clamp against the same resolved model that supplies the levels.
        // This matters when a provider/model switch leaves a stale effort
        // value behind (for example an OpenRouter model with a narrower
        // supported_efforts list).
        self.state.clamp_thinking_level_for_current_model();
        let profile = self.state.thinking_profile_for_current_model();
        // `auto` (send nothing, provider default) is the first stop whenever
        // there is anything to choose.
        let mut levels = Vec::new();
        let mut budgets = Vec::new();
        if !profile.levels.is_empty() {
            levels.push(agente_core::thinking::THINKING_AUTO.to_string());
            budgets.push(None);
        }
        for level in &profile.levels {
            levels.push(level.id.clone());
            budgets.push(level.budget_tokens);
        }
        let current = self.state.agent.thinking_level.clone();
        self.state.input.open_thinking_selector(&levels, &current);
        self.state.input.thinking_selector_budgets = budgets;
        self.state.input.thinking_selector_default = profile.default;
        self.state.ui.needs_render = true;
    }
}

impl App {
    /// Run a message-dialog action for sent message `entry_id`.
    pub(super) fn run_message_action(
        &mut self,
        entry_id: uuid::Uuid,
        action: crate::message_actions::MessageAction,
    ) -> anyhow::Result<()> {
        use crate::message_actions::{is_available, MessageAction};
        if !is_available(&self.state, entry_id, action) {
            // The dialog already says why (busy agent, compacted message).
            return Ok(());
        }
        let content = self
            .state
            .session
            .chat_history
            .iter()
            .find(|e| e.id == entry_id)
            .map(|e| e.content.clone())
            .unwrap_or_default();
        let attachments = self
            .state
            .session
            .chat_history
            .iter()
            .find(|e| e.id == entry_id)
            .map(|e| e.attachments.clone())
            .unwrap_or_default();
        match action {
            MessageAction::Copy => {
                let _ = self.copy_to_clipboard(&content);
                self.state.ui.show_toast("✓ message copied".to_string());
            }
            MessageAction::ToggleExpand => {
                let expanded = &mut self.state.ui.expanded_message_ids;
                if !expanded.remove(&entry_id) {
                    expanded.insert(entry_id);
                }
            }
            MessageAction::Revert => match self.state.session.revert_to(entry_id) {
                Ok(reverted) => {
                    self.put_back_in_composer(reverted.content);
                    self.state.input.attachments = attachments;
                    let files = match reverted.files_restored {
                        0 => String::new(),
                        1 => " · 1 file edit undone".to_string(),
                        n => format!(" · {n} file edits undone"),
                    };
                    self.state
                        .ui
                        .show_toast(format!("↺ Reverted{files} · message back in the input"));
                }
                Err(error) => self.state.ui.show_toast(error),
            },
            MessageAction::Fork => {
                let point = match self.state.session.rewind_point(entry_id) {
                    Ok(point) => point,
                    Err(error) => {
                        self.state.ui.show_toast(error);
                        return Ok(());
                    }
                };
                let chat = self.state.session.chat_history[..point.chat_index].to_vec();
                let conversation =
                    self.state.session.conversation[..point.conversation_index].to_vec();
                let title = self.state.session.title.clone();
                // Keep the original resumable, then branch in place.
                self.flush_state_to_disk();
                self.current_task_id = self.next_task_id();
                self.state.reset_for_new_session();
                self.state.session.chat_history = chat;
                self.state.session.conversation = conversation;
                if !title.is_empty() {
                    self.state.session.title = format!("{title} (fork)");
                }
                self.state.ui.show_welcome_screen = false;
                self.put_back_in_composer(point.content);
                self.state.input.attachments = attachments;
                self.state
                    .ui
                    .show_toast("⎇ Forked into a new session · the original is saved".to_string());
            }
        }
        self.state.ui.message_actions = None;
        self.state.ui.needs_render = true;
        Ok(())
    }

    /// Drop a rewound prompt back into the composer, caret at the end, and
    /// resync the context meter with the shortened conversation.
    fn put_back_in_composer(&mut self, content: String) {
        self.state.input.input_cursor = content.chars().count();
        self.state.input.input_text = content;
        let conversation = self.state.session.conversation.clone();
        self.state
            .agent
            .recompute_total_from_conversation(&conversation);
        self.state.ui.scroll_to_bottom();
    }
}
