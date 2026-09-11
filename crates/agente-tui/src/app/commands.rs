//! Command palette / slash command execution.

use crate::command_palette::Command;

use super::App;

/// Bootstrap AGENTS.md for the current project (`/init` scaffolding).
fn init_project_agents_md(project_dir: &str) -> anyhow::Result<String> {
    let path = std::path::Path::new(project_dir).join("AGENTS.md");
    if path.exists() {
        return Ok(
            "AGENTS.md already exists — edit it to refine project guidance for the agent."
                .to_string(),
        );
    }

    let mut langs = Vec::new();
    let has = |name: &str| std::path::Path::new(project_dir).join(name).exists();
    if has("Cargo.toml") {
        langs.push("Rust (Cargo)");
    }
    if has("package.json") {
        langs.push("JavaScript/TypeScript (npm)");
    }
    if has("pyproject.toml") || has("requirements.txt") {
        langs.push("Python");
    }
    if has("go.mod") {
        langs.push("Go");
    }
    if has("pom.xml") || has("build.gradle") || has("build.gradle.kts") {
        langs.push("Java/Kotlin");
    }

    let stack = if langs.is_empty() {
        "Unknown — inspect the tree before editing.".to_string()
    } else {
        langs.join(", ")
    };

    let body = format!(
        r#"# AGENTS.md

Project guidance for coding agents working in this repository.

## Stack

{stack}

## Working directory

`{project_dir}`

## Conventions

- Prefer small, focused changes over large rewrites.
- Match existing style, naming, and module layout.
- Run the project's normal checks after non-trivial edits.
- Do not commit secrets or rewrite git history.

## Commands

Document useful build/test/lint commands here after discovery.

## Notes

Add architecture notes, do-not-touch areas, and preferred patterns below.
"#
    );

    std::fs::write(&path, body)?;
    // Scaffold extensibility dirs (filesystem plugins later)
    for dir in [".agente/commands", ".agente/agents", ".agente/skills"] {
        let _ = std::fs::create_dir_all(std::path::Path::new(project_dir).join(dir));
    }

    Ok(
        "Created AGENTS.md and .agente/{commands,agents,skills}. Commit AGENTS.md when ready."
            .to_string(),
    )
}

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
                let (removed, saved) = self.state.compact_conversation();
                let message = if saved > 0 {
                    format!(
                        "Context compacted: saved ~{} tokens ({removed} older messages summarized)",
                        crate::widgets::hints::format_token_count(saved)
                    )
                } else {
                    "Context is already compact".to_string()
                };
                self.state.add_system_message(message);
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
            Command::InitProject => match init_project_agents_md(&self.state.session.project_dir) {
                Ok(msg) => self.state.add_system_message(msg),
                Err(e) => self.state.add_system_message(format!("/init failed: {e}")),
            },
            Command::ListSubagents => {
                self.state.input.open_subagents();
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
        let mode = self.state.agent.mode.to_string();
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
        let levels = self.state.thinking_levels_for_current_model();
        let current = self.state.agent.thinking_level.clone();
        self.state.input.open_thinking_selector(&levels, &current);
        self.state.ui.needs_render = true;
    }
}
