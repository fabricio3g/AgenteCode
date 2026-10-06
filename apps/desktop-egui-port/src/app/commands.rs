//! The command catalog: one list behind the palette (Ctrl+P), slash input and
//! the keyboard shortcuts. Ports the Electron `command-palette` plus the TUI's
//! `Command::all()` so both entry points behave identically.

use crate::app::DesktopApp;
use crate::backend::SessionSpace;
use crate::state::overlays::{PaletteMode, PaletteState};
use crate::state::{HomeView, Space};

/// One command: an id, a title, the shortcut hint and the slash spelling.
pub struct Command {
    pub id: &'static str,
    pub title: &'static str,
    pub hint: &'static str,
    pub slash: &'static str,
}

/// Every command, in palette order.
pub const COMMANDS: &[Command] = &[
    Command { id: "new", title: "New chat", hint: "Ctrl+N", slash: "new" },
    Command { id: "search", title: "Search chats", hint: "Ctrl+Shift+K", slash: "search" },
    Command { id: "settings", title: "Settings", hint: "Ctrl+,", slash: "settings" },
    Command { id: "model", title: "Model…", hint: "", slash: "model" },
    Command { id: "provider", title: "Provider…", hint: "", slash: "provider" },
    Command { id: "theme", title: "Toggle theme", hint: "", slash: "theme" },
    Command { id: "plan", title: "Plan mode", hint: "Shift+Tab", slash: "plan" },
    Command { id: "build", title: "Build mode", hint: "Shift+Tab", slash: "build" },
    Command { id: "auto", title: "Toggle auto-approve", hint: "", slash: "auto" },
    Command { id: "compact", title: "Compact context", hint: "", slash: "compact" },
    Command { id: "clear", title: "Clear conversation", hint: "Ctrl+L", slash: "clear" },
    Command { id: "rename", title: "Rename conversation", hint: "F2", slash: "rename" },
    Command { id: "fork", title: "Fork conversation", hint: "", slash: "fork" },
    Command { id: "changes", title: "Changed files", hint: "Ctrl+B", slash: "changes" },
    Command { id: "files", title: "Project files", hint: "", slash: "files" },
    Command { id: "plan-review", title: "Review the plan", hint: "", slash: "plan-review" },
    Command { id: "processes", title: "Processes", hint: "", slash: "processes" },
    Command { id: "terminal", title: "Terminal", hint: "", slash: "terminal" },
    Command { id: "subagents", title: "Subagents", hint: "Ctrl+X", slash: "subagents" },
    Command { id: "artifacts", title: "Artifacts", hint: "", slash: "artifacts" },
    Command { id: "studio", title: "Artifact studio", hint: "Ctrl+`", slash: "studio" },
    Command { id: "skills", title: "Skills", hint: "", slash: "skills" },
    Command { id: "mcp", title: "MCP servers", hint: "", slash: "mcp" },
    Command { id: "agents", title: "Agent roster", hint: "", slash: "agents" },
    Command { id: "voice", title: "Voice", hint: "", slash: "voice" },
    Command { id: "runtime", title: "Local runtime", hint: "", slash: "runtime" },
    Command { id: "export", title: "Export transcript", hint: "Ctrl+E", slash: "export" },
    Command { id: "help", title: "Keyboard shortcuts", hint: "Ctrl+?", slash: "help" },
    Command { id: "quit", title: "Quit", hint: "Ctrl+Q", slash: "quit" },
];

/// Commands whose title matches the query, for the palette list.
pub fn filtered(query: &str) -> Vec<&'static Command> {
    let needle = query.trim().to_lowercase();
    COMMANDS
        .iter()
        .filter(|command| {
            needle.is_empty()
                || command.title.to_lowercase().contains(&needle)
                || command.slash.contains(&needle)
        })
        .collect()
}

/// Runs a command by id. `arg` carries a slash argument when there is one.
pub fn run(app: &mut DesktopApp, id: &str, arg: &str) {
    match id {
        "new" => {
            let space = app.nav.active.session_space().unwrap_or(SessionSpace::Home);
            app.chat.new_session(space);
            app.nav.activate(Space::Home);
            app.dirty = true;
        }
        "search" => {
            app.overlays.chat_search = Some(Default::default());
        }
        "settings" => app.nav.settings_open = true,
        "model" => {
            if arg.trim().is_empty() {
                app.open_model_picker();
            } else {
                app.set_model(arg.trim());
            }
        }
        "provider" => {
            if arg.trim().is_empty() {
                app.nav.settings_open = true;
            } else {
                app.set_provider(arg.trim());
            }
        }
        "theme" => {
            app.prefs.theme_dark = !app.prefs.theme_dark;
            app.dirty = true;
            app.theme_dirty = true;
        }
        "plan" | "build" | "auto" => {
            let build = id == "build" || (id == "auto" && app.code.mode == crate::backend::AgentMode::Plan);
            app.code.mode = if build {
                crate::backend::AgentMode::Build
            } else {
                crate::backend::AgentMode::Plan
            };
            app.engine.set_mode(app.code.mode);
            if id == "auto" {
                app.code.toggle_auto_approve();
                app.engine.set_auto_approve(app.code.auto_approve);
            }
            app.dirty = true;
        }
        "compact" => app.compact_now(),
        "clear" => {
            if let Some(id) = app.chat.active_id.clone() {
                app.overlays.confirm =
                    Some(crate::state::overlays::ConfirmState::clear_session(&id));
            }
        }
        "rename" => app.start_rename(),
        "fork" => app.fork_active_session(),
        "changes" => app.dock_changes = !app.dock_changes,
        "files" => app.dock_files = !app.dock_files,
        "plan-review" => app.open_plan_review(),
        "processes" => app.refresh_processes(),
        "terminal" => {
            let cwd = app.code.effective_dir();
            app.overlays.terminal = Some(crate::state::overlays::TerminalState::new(cwd));
        }
        "subagents" => {
            if app.active_subagents().is_empty() {
                app.toast("No subagents in this session yet.");
            } else {
                app.overlays.subagent_detail = Some(0);
            }
        }
        "artifacts" => {
            app.nav.activate(Space::Home);
            app.home.view = HomeView::Artifacts;
        }
        "studio" => app.open_studio(),
        "skills" => app.toast(app.skills_summary()),
        "mcp" => app.toast(app.mcp_summary()),
        "agents" => app.toast(app.agents_summary()),
        "voice" => {
            app.overlays.voice.hands_free = !app.overlays.voice.hands_free;
            app.toast(if app.overlays.voice.hands_free {
                "Hands-free voice mode on"
            } else {
                "Hands-free voice mode off"
            });
        }
        "runtime" => app.refresh_runtime(),
        "export" => app.export_transcript(),
        "help" => app.overlays.help = true,
        "quit" => app.quit_requested = true,
        _ => app.toast(format!("Unknown command: /{id}")),
    }
}

/// The palette state for the command list.
pub fn palette() -> PaletteState {
    PaletteState {
        mode: PaletteMode::Commands,
        title: "Commands".to_owned(),
        ..Default::default()
    }
}

/// Resolves a slash line (`/model gpt-5`, `/clear`) into a command id.
pub fn parse_slash(input: &str) -> Option<(&'static str, &str)> {
    let rest = input.trim().strip_prefix('/')?;
    let mut parts = rest.splitn(2, char::is_whitespace);
    let name = parts.next()?.trim();
    let arg = parts.next().unwrap_or("").trim();
    let command = COMMANDS
        .iter()
        .find(|command| command.slash == name || command.id == name)?;
    Some((command.id, arg))
}
