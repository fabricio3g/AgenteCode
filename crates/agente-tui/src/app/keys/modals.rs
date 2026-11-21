//! Modal picker, settings, connect, thinking, and subagent key handlers.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::app::App;
use crate::command_palette;
use crate::connect;
use crate::model_selector;
use crate::widgets::text_field::{edit_filter_query, edit_single_line, step_list_selection};

impl App {
    pub(super) fn handle_command_palette_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let commands = command_palette::filter_commands(&self.state.input.command_palette_query);
        if step_list_selection(
            &mut self.state.input.command_palette_selected,
            commands.len(),
            key.code,
        ) {
            return Ok(());
        }
        if edit_filter_query(
            &mut self.state.input.command_palette_query,
            &mut self.state.input.command_palette_selected,
            key,
        ) {
            return Ok(());
        }
        match key.code {
            KeyCode::Esc => self.state.input.show_command_palette = false,
            KeyCode::Enter => {
                if let Some(cmd) = commands.get(self.state.input.command_palette_selected) {
                    let cmd = *cmd;
                    self.state.input.show_command_palette = false;
                    self.execute_command(cmd)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Keys for the live output view: scroll, End follows, `s` stops the
    /// running operation, Esc closes.
    pub(super) fn handle_process_view_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
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
                        KeyCode::Home => view.scroll.scroll_to_top(),
                        KeyCode::End => view.scroll.scroll_to_bottom(true),
                        _ => {}
                    }
                }
            }
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    /// Keys for the message dialog: move, Enter runs, r/f/c/e shortcuts.
    pub(super) fn handle_message_actions_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::message_actions::actions;
        let Some(entry_id) = self.state.ui.message_actions else {
            return Ok(());
        };
        let list = actions(&self.state, entry_id);
        let last = list.len().saturating_sub(1);
        self.state.input.message_actions_selected =
            self.state.input.message_actions_selected.min(last);
        if step_list_selection(
            &mut self.state.input.message_actions_selected,
            list.len(),
            key.code,
        ) {
            self.state.ui.needs_render = true;
            return Ok(());
        }
        let selected = self.state.input.message_actions_selected;
        let chosen = match key.code {
            KeyCode::Esc => {
                self.state.ui.message_actions = None;
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
    pub(super) fn handle_settings_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::settings::{Setting, SETTINGS};
        let last = SETTINGS.len() - 1;
        self.state.input.settings_selected = self.state.input.settings_selected.min(last);
        if step_list_selection(
            &mut self.state.input.settings_selected,
            SETTINGS.len(),
            key.code,
        ) {
            self.state.ui.needs_render = true;
            return Ok(());
        }
        let selected = self.state.input.settings_selected;
        match key.code {
            KeyCode::Esc => self.state.input.show_settings = false,
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
                Setting::WebSearch => {
                    let message = match crate::settings::cycle_web_search() {
                        Ok(message) | Err(message) => message,
                    };
                    self.state.ui.show_toast(message);
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
    /// `d` turns it off, Esc closes.
    pub(super) fn handle_mcp_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::mcp_servers::{primary_action, McpAction};
        use agente_core::mcp::ServerSource;
        let manager = std::sync::Arc::clone(&self.state.config.mcp_manager);
        let servers = manager.snapshots();
        let last = servers.len().saturating_sub(1);
        self.state.input.mcp_selected = self.state.input.mcp_selected.min(last);
        if step_list_selection(&mut self.state.input.mcp_selected, servers.len(), key.code) {
            self.state.ui.needs_render = true;
            return Ok(());
        }
        let selected = self.state.input.mcp_selected;
        let server = servers.get(selected);
        let project = self.state.session.project_dir.clone();
        match key.code {
            KeyCode::Esc => self.state.input.show_mcp = false,
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

    /// Keys for `/skills`: move, Enter puts `/name ` in the composer, Esc closes.
    pub(super) fn handle_skills_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let count = self.state.input.skills.len();
        self.state.input.skills_selected = self
            .state
            .input
            .skills_selected
            .min(count.saturating_sub(1));
        if step_list_selection(&mut self.state.input.skills_selected, count, key.code) {
            self.state.ui.needs_render = true;
            return Ok(());
        }
        let selected = self.state.input.skills_selected;
        match key.code {
            KeyCode::Esc => self.state.input.show_skills = false,
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

    /// Keys for `/subagent-models`.
    pub(super) fn handle_subagent_models_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        use crate::subagent_models::{self as dialog, Edit, EditField, ModelTarget, Row};
        self.state.ui.needs_render = true;

        if let Some(mut edit) = self.state.input.subagent_model_edit.take() {
            match key.code {
                KeyCode::Esc => {}
                KeyCode::Enter => {
                    dialog::commit_edit(&mut self.state.config.config.subagents, &edit);
                    self.state.persist_config();
                }
                _ => {
                    edit_single_line(&mut edit.text, key);
                    self.state.input.subagent_model_edit = Some(edit);
                }
            }
            return Ok(());
        }

        let rows = dialog::rows(&self.state.config.config.subagents);
        let last = rows.len().saturating_sub(1);
        self.state.input.subagent_models_selected =
            self.state.input.subagent_models_selected.min(last);
        if step_list_selection(
            &mut self.state.input.subagent_models_selected,
            rows.len(),
            key.code,
        ) {
            return Ok(());
        }
        let selected = self.state.input.subagent_models_selected;
        let row = rows.get(selected).copied();
        let open_picker = |app: &mut Self, target: ModelTarget| {
            if app.state.is_connected() {
                app.state.input.model_selector_target = Some(target);
                app.state.input.show_model_selector = true;
                app.state.input.model_selector_provider = None;
                app.state.input.model_selector_query.clear();
                app.state.input.model_selector_selected = 0;
            } else {
                app.state.open_connect_screen();
            }
        };
        let mut changed = false;
        match (key.code, row) {
            (KeyCode::Esc, _) => self.state.input.show_subagent_models = false,
            (KeyCode::Enter, Some(Row::Entry(index))) => {
                open_picker(self, ModelTarget::Entry(index))
            }
            (KeyCode::Enter, Some(Row::Add)) => open_picker(self, ModelTarget::New),
            (KeyCode::Char(' '), Some(row @ (Row::Entry(_) | Row::Main)))
            | (KeyCode::Enter, Some(row @ Row::Main)) => {
                dialog::set_default(&mut self.state.config.config.subagents, row);
                changed = true;
            }
            (KeyCode::Enter | KeyCode::Char(' '), Some(Row::Picks)) => {
                let settings = &mut self.state.config.config.subagents;
                settings.orchestrator_picks = settings.picks().then_some(false);
                changed = true;
            }
            (KeyCode::Char(c @ ('u' | 'n')), Some(Row::Entry(index))) => {
                let entry = &self.state.config.config.subagents.models[index];
                let (field, text) = if c == 'u' {
                    (EditField::Note, entry.use_for.clone())
                } else {
                    (EditField::Name, entry.name.clone())
                };
                self.state.input.subagent_model_edit = Some(Edit { index, field, text });
            }
            (KeyCode::Delete | KeyCode::Backspace, Some(Row::Entry(index))) => {
                dialog::remove(&mut self.state.config.config.subagents, index);
                changed = true;
            }
            _ => {}
        }
        if changed {
            self.state.persist_config();
        }
        Ok(())
    }

    pub(super) fn handle_model_selector_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
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

        if step_list_selection(
            &mut self.state.input.model_selector_selected,
            filtered.len(),
            key.code,
        ) {
            return Ok(());
        }

        match key {
            KeyEvent {
                code: KeyCode::Esc, ..
            } => {
                self.state.input.show_model_selector = false;
                self.state.input.model_selector_target = None;
            }
            KeyEvent {
                code: KeyCode::Enter,
                ..
            } => {
                if !self.state.is_connected() {
                    self.state.input.show_model_selector = false;
                    self.state.open_connect_screen();
                } else if let (Some(entry), Some(target)) = (
                    filtered.get(self.state.input.model_selector_selected),
                    self.state.input.model_selector_target.take(),
                ) {
                    let (provider, model) = (entry.provider.clone(), entry.model_id.clone());
                    crate::subagent_models::apply_pick(&mut self.state, target, &provider, &model);
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
                code: KeyCode::Char('r'),
                modifiers: KeyModifiers::CONTROL,
                ..
            }
            | KeyEvent {
                code: KeyCode::F(5),
                ..
            } => {
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
            _ => {
                edit_filter_query(
                    &mut self.state.input.model_selector_query,
                    &mut self.state.input.model_selector_selected,
                    key,
                );
            }
        }
        Ok(())
    }

    fn cycle_model_provider(&mut self, forward: bool) {
        let providers = self.state.config.connected_providers.clone();
        if providers.is_empty() {
            return;
        }
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

    pub(super) fn handle_connect_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let mut provider_entries = self.state.all_provider_entries();
        connect::sort_entries_with_connected(
            &mut provider_entries,
            &self.state.config.connected_providers,
        );

        match &self.state.config.connect_screen.clone() {
            crate::state::ConnectScreen::Closed => {}
            crate::state::ConnectScreen::SelectProvider { .. } => {
                if let crate::state::ConnectScreen::SelectProvider { query, selected } =
                    &mut self.state.config.connect_screen
                {
                    let len = connect::filtered_presets(query, &provider_entries).len();
                    if step_list_selection(selected, len, key.code) {
                        return Ok(());
                    }
                }
                match key.code {
                    KeyCode::Esc => {
                        self.state.close_connect_screen();
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
                    KeyCode::Char('k') | KeyCode::Char('K')
                        if key.modifiers.contains(KeyModifiers::CONTROL) =>
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
                                if let crate::state::ConnectScreen::SelectProvider {
                                    query,
                                    selected,
                                } = &mut self.state.config.connect_screen
                                {
                                    let n = connect::filtered_presets(query, &entries).len();
                                    if n == 0 {
                                        *selected = 0;
                                    } else if sel >= n {
                                        *selected = n - 1;
                                    }
                                }
                            }
                        }
                    }
                    _ => {
                        if let crate::state::ConnectScreen::SelectProvider { query, selected } =
                            &mut self.state.config.connect_screen
                        {
                            edit_filter_query(query, selected, key);
                        }
                    }
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
                        }
                    }
                    _ => {
                        if edit_single_line(&mut self.state.config.connect_key_input, key) {
                            if let crate::state::ConnectScreen::EnterKey { error, .. } =
                                &mut self.state.config.connect_screen
                            {
                                error.clear();
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

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
            self.state.config.pending_after_connect = None;
            if self.state.config.current_model.is_empty() {
                self.refresh_model_selection_after_discovery(provider);
            }
            return;
        }

        self.spawn_model_discovery(provider);
    }

    /// Thinking-level picker (Ctrl+T, `/thinking`).
    pub(super) fn handle_thinking_selector_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let levels = self.state.input.thinking_selector_levels.clone();
        let nav_code = match key.code {
            KeyCode::Left | KeyCode::Up => Some(KeyCode::Up),
            KeyCode::Right | KeyCode::Down => Some(KeyCode::Down),
            _ => None,
        };
        if let Some(code) = nav_code {
            step_list_selection(
                &mut self.state.input.thinking_selector_selected,
                levels.len(),
                code,
            );
            self.state.ui.needs_render = true;
            return Ok(());
        }
        match key.code {
            KeyCode::Esc => {
                self.state.input.close_thinking_selector();
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
        if !entries.is_empty() {
            self.state.input.subagents_selected = self
                .state
                .input
                .subagents_selected
                .min(entries.len().saturating_sub(1));
        }
        if step_list_selection(
            &mut self.state.input.subagents_selected,
            entries.len(),
            key.code,
        ) {
            self.state.ui.needs_render = true;
            return Ok(());
        }
        match key.code {
            KeyCode::Esc => {
                self.state.input.close_subagents();
                self.state.ui.needs_render = true;
            }
            KeyCode::Enter => {
                if let Some(selected) = entries.get(self.state.input.subagents_selected) {
                    self.state.ui.open_subagent_detail(selected.id.clone());
                } else {
                    self.state.input.close_subagents();
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
                self.state.ui.subagent_detail_scroll.scroll_to_top();
                self.state.ui.needs_render = true;
            }
            KeyCode::Up => self.state.ui.scroll_subagent_detail(-1),
            KeyCode::Down => self.state.ui.scroll_subagent_detail(1),
            KeyCode::PageUp => self.state.ui.scroll_subagent_detail(-page),
            KeyCode::PageDown => self.state.ui.scroll_subagent_detail(page),
            KeyCode::Home => {
                self.state.ui.subagent_detail_scroll.scroll_to_top();
                self.state.ui.needs_render = true;
            }
            KeyCode::End => {
                self.state.ui.subagent_detail_scroll.scroll_to_bottom(true);
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
}
