//! Session picker, folder browser, project switching, and fresh-session lifecycle.

use agente_core::session;
use crossterm::event::{KeyCode, KeyEvent};

use crate::app::{util, App};
use crate::session_picker::list_directory;
use crate::widgets::text_field::{edit_filter_query, edit_single_line, step_list_selection};

impl App {
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
                KeyCode::Esc | KeyCode::Tab => {
                    self.state.picker.session_picker_folder_active = false;
                }
                _ => {
                    edit_single_line(&mut self.state.picker.session_picker_folder_input, key);
                }
            }
            return Ok(());
        }

        let folder = self
            .state
            .picker
            .session_picker_folder_input
            .trim()
            .to_string();
        let query = self.state.picker.session_picker_query.to_lowercase();
        let filtered_count = self
            .state
            .picker
            .sessions
            .iter()
            .filter(|session| crate::session_picker::session_matches(session, &folder, &query))
            .count();
        let total_items = 1 + filtered_count;

        if matches!(key.code, KeyCode::Up | KeyCode::Down) {
            self.state.picker.session_picker_confirm_delete = false;
            step_list_selection(
                &mut self.state.picker.session_picker_selected,
                total_items,
                key.code,
            );
            return Ok(());
        }

        match key.code {
            KeyCode::Esc => {
                self.state.picker.show_session_picker = false;
                self.state.picker.session_picker_confirm_delete = false;
            }
            KeyCode::Enter => {
                let idx = self.state.picker.session_picker_selected;
                if !self.state.can_replace_session() {
                    self.state.add_system_message(
                        "Stop the agent and running subagents before switching sessions"
                            .to_string(),
                    );
                } else {
                    let sessions = self.state.picker.sessions.clone();
                    self.perform_session_switch(idx, &sessions, &folder, &query)?;
                }
            }
            KeyCode::Tab => {
                self.state.picker.session_picker_folder_active = true;
            }
            KeyCode::Delete => {
                let idx = self.state.picker.session_picker_selected;
                if idx > 0 {
                    if self.state.picker.session_picker_confirm_delete {
                        let folder = self.state.picker.session_picker_folder_input.trim();
                        let query = self.state.picker.session_picker_query.to_lowercase();
                        let sid = self
                            .state
                            .picker
                            .sessions
                            .iter()
                            .filter(|session| {
                                crate::session_picker::session_matches(session, folder, &query)
                            })
                            .nth(idx - 1)
                            .map(|meta| meta.session_id);
                        if let Some(sid) = sid {
                            self.persistence.delete(sid);
                            self.state.picker.sessions.retain(|s| s.session_id != sid);
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
            _ => {
                edit_filter_query(
                    &mut self.state.picker.session_picker_query,
                    &mut self.state.picker.session_picker_selected,
                    key,
                );
            }
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
                .filter(|session| crate::session_picker::session_matches(session, folder, query))
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
        if matches!(key.code, KeyCode::Up | KeyCode::Down) {
            let len = list_directory(&self.state.picker.session_picker_browse_path).len();
            step_list_selection(
                &mut self.state.picker.session_picker_browse_selected,
                len,
                key.code,
            );
            return Ok(());
        }
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

    pub(in crate::app) fn open_session_picker(&mut self) {
        let project_dir = self.state.session.project_dir.clone();
        self.state.picker.open_sessions(project_dir);
    }

    pub(in crate::app) fn open_project_picker(&mut self) {
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

    pub(in crate::app) fn start_new_session(&mut self) {
        if !self.state.can_replace_session() {
            self.state.add_system_message(
                "Stop the agent and running subagents before starting a new session".to_string(),
            );
            return;
        }
        self.flush_state_to_disk();
        self.clear_active_task_ids();
        self.current_task_id = self.next_task_id();
        self.state.reset_for_new_session();
        self.state.ui.show_welcome_screen = false;
        if !self.state.ui.reduce_motion {
            self.state.ui.surface_fade = Some(crate::state::anim::Tween::start(
                crate::state::anim::MODAL_MS,
            ));
        }
        self.state.ui.show_toast("New session started".to_string());
        self.state.ui.needs_render = true;
    }

    pub(in crate::app) fn reset_current_session(
        &mut self,
        project_dir: String,
        config: agente_core::config::AppConfig,
    ) {
        self.clear_active_task_ids();
        self.current_task_id = self.next_task_id();
        let before = std::sync::Arc::clone(&self.state.config.mcp_manager);
        self.state.reset_for_project(project_dir, config);
        if !std::sync::Arc::ptr_eq(&before, &self.state.config.mcp_manager) {
            let _guard = self.runtime.enter();
            crate::app::spawn_mcp_connect(&self.state);
        }
    }
}
