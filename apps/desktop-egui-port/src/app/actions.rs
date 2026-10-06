//! App actions: everything the palette, the slash commands, the shortcuts and
//! the panels call into. Keeps `mod.rs` about the event loop and this file
//! about doing things.

use agente_core::context::compaction::{CompactionStrategy, ContextCompactor};
use agente_core::types::{Message, Role};

use crate::backend::SessionSpace;
use crate::state::overlays::{
    PaletteMode, PaletteState, PlanReviewState, ProcessViewState, RuntimeModel, RuntimePanelState,
    SearchHit, StudioFile, StudioState, TerminalLine,
};
use crate::state::{Entry, EntryKind, RunState, Space};

use super::{DesktopApp, PLAN_DIR, TurnTarget};

impl DesktopApp {
    /// Opens the palette in model-picking mode, listing what the catalog, the
    /// live discovery snapshot and the config know for this provider.
    pub fn open_model_picker(&mut self) {
        self.overlays.palette = Some(PaletteState {
            mode: PaletteMode::Models,
            title: "Models".to_owned(),
            ..Default::default()
        });
    }

    /// Model ids for the active provider, sorted, deduplicated.
    pub fn model_choices(&self) -> Vec<String> {
        let (provider, _) = self.active_model();
        let mut ids: Vec<String> = Vec::new();
        if let Some(config) = self.engine.config().provider.get(&provider) {
            ids.extend(config.models.keys().cloned());
        }
        if let Some(catalog) = self.engine.config().catalog.as_ref() {
            if let Some(entry) = catalog.providers.get(&provider) {
                ids.extend(entry.models.keys().cloned());
            }
        }
        if let Some(live) = self.engine.registry().runtime_snapshot().get(&provider) {
            ids.extend(live.iter().map(|model| model.id.clone()));
        }
        ids.sort();
        ids.dedup();
        ids
    }

    /// Sets the default model in the core config, so the TUI sees it too.
    pub fn set_model(&mut self, model: &str) {
        let model = model.trim().to_owned();
        if model.is_empty() {
            return;
        }
        self.engine.config_mut().default_model = Some(model.clone());
        match self.engine.save_config() {
            Ok(()) => self.toast(format!("Model: {model}")),
            Err(error) => self.toast(format!("Could not save the model: {error}")),
        }
        self.engine.reload_providers();
        self.dirty = true;
    }

    /// Sets the default provider.
    pub fn set_provider(&mut self, provider: &str) {
        let provider = provider.trim().to_owned();
        if provider.is_empty() {
            return;
        }
        self.engine.config_mut().default_provider = Some(provider.clone());
        match self.engine.save_config() {
            Ok(()) => self.toast(format!("Provider: {provider}")),
            Err(error) => self.toast(format!("Could not save the provider: {error}")),
        }
        self.engine.reload_providers();
        self.dirty = true;
    }

    /// `/compact`: trims the live conversation now and records the divider.
    pub fn compact_now(&mut self) {
        let Some(target) = self.current_target() else {
            self.toast("No conversation to compact.");
            return;
        };
        let (before, after) = self.with_target(&target, |session| {
            let before = estimate(&session.conversation);
            let strategy = CompactionStrategy::new(200_000, 8, 0.0);
            let compactor = ContextCompactor::new(strategy);
            let result = compactor.compact_forced(session.conversation.clone());
            session.conversation = result.messages;
            let after = estimate(&session.conversation);
            session.entries.push(Entry::new(
                EntryKind::Compaction,
                format!(
                    "Context compacted · {} → {} · trimmed",
                    format_tokens(before),
                    format_tokens(after)
                ),
            ));
            (before, after)
        });
        self.toast(format!(
            "Compacted {} → {}",
            format_tokens(before),
            format_tokens(after)
        ));
        self.dirty = true;
    }

    /// F2: rename the active session inline.
    pub fn start_rename(&mut self) {
        match self.nav.active {
            Space::Code => self.overlays.prompt_inspector = None,
            _ => {
                if let Some(session) = self.chat.active() {
                    self.renaming = Some((session.id.clone(), session.title.clone()));
                }
            }
        }
    }

    /// Applies the rename draft.
    pub fn commit_rename(&mut self) {
        let Some((id, title)) = self.renaming.take() else {
            return;
        };
        let title = title.trim().to_owned();
        if title.is_empty() {
            return;
        }
        if let Some(session) = self.chat.by_id_mut(&id) {
            session.title = title;
        }
        self.dirty = true;
    }

    /// Forks the active conversation up to the newest user turn, like the TUI's
    /// message action: the original stays, a copy opens beside it.
    pub fn fork_active_session(&mut self) {
        let Some(source) = self.chat.active().cloned() else {
            return;
        };
        let mut fork = source.clone();
        fork.id = uuid::Uuid::new_v4().to_string();
        fork.title = format!("{} (fork)", source.title);
        fork.updated_at = chrono::Utc::now().timestamp();
        fork.state = RunState::Idle;
        fork.streaming_text.clear();
        fork.reasoning_text.clear();
        fork.approvals.clear();
        fork.subagents.clear();
        fork.turn_started = None;
        let id = fork.id.clone();
        self.chat.sessions.push(fork);
        self.chat.active_id = Some(id);
        self.toast("Forked the conversation");
        self.dirty = true;
    }

    /// Ctrl+B: the changed-files dock.
    pub fn toggle_changes(&mut self) {
        self.dock_changes = !self.dock_changes;
    }

    /// Opens the newest plan for review, like the `present_plan` card.
    pub fn open_plan_review(&mut self) {
        let dir = std::path::Path::new(&self.code.effective_dir()).join(PLAN_DIR);
        let newest = std::fs::read_dir(&dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
            .max_by_key(|entry| {
                entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .ok()
            });
        match newest {
            Some(entry) => {
                let path = entry.path();
                match std::fs::read_to_string(&path) {
                    Ok(markdown) => {
                        self.overlays.plan_review = Some(PlanReviewState::load(
                            path.display().to_string(),
                            markdown,
                        ));
                    }
                    Err(error) => self.toast(format!("Could not read the plan: {error}")),
                }
            }
            None => self.toast("No plan written yet. Ask for one in Plan mode."),
        }
    }

    /// Sends the plan review answer as the next turn.
    pub fn send_plan_feedback(&mut self, feedback: &str) {
        let prompt = feedback.trim().to_owned();
        if prompt.is_empty() {
            return;
        }
        self.chat.ensure_session(SessionSpace::Home);
        let Some(session) = self.chat.active_mut() else {
            return;
        };
        let id = session.id.clone();
        session.push_user(&prompt, &prompt);
        let mode = crate::backend::AgentMode::Build;
        self.overlays.plan_review = None;
        self.order_turn(TurnTarget::Session(id), mode);
    }

    /// Lists background processes through the core `process_list` tool.
    pub fn refresh_processes(&mut self) {
        let dir = self.code.effective_dir();
        let registry = agente_core::tools::ToolRegistry::new(dir);
        let output = self
            .engine
            .block_on(registry.execute("process_list", serde_json::json!({})));
        match output {
            Ok(text) => {
                self.processes = text
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .map(str::to_owned)
                    .collect();
                self.toast(format!("{} process rows", self.processes.len()));
            }
            Err(error) => self.toast(format!("process_list failed: {error}")),
        }
    }

    /// Reads a process's live tail through the core `process_output` tool.
    pub fn open_process(&mut self, id: &str) {
        let dir = self.code.effective_dir();
        let registry = agente_core::tools::ToolRegistry::new(dir);
        let args = serde_json::json!({ "id": id, "tail_chars": 8000 });
        let output = self
            .engine
            .block_on(registry.execute("process_output", args));
        let content = match output {
            Ok(text) => text,
            Err(error) => format!("process_output failed: {error}"),
        };
        self.overlays.process_view = Some(ProcessViewState {
            id: id.to_owned(),
            content,
            follow: true,
            stopped: false,
        });
    }

    /// Stops a background process through the core `process_stop` tool.
    pub fn stop_process(&mut self, id: &str) {
        let dir = self.code.effective_dir();
        let registry = agente_core::tools::ToolRegistry::new(dir);
        let args = serde_json::json!({ "id": id });
        match self.engine.block_on(registry.execute("process_stop", args)) {
            Ok(text) => {
                if let Some(view) = self.overlays.process_view.as_mut() {
                    view.stopped = true;
                    view.content.push_str("\n[stopped] ");
                    view.content.push_str(&text);
                }
                self.toast(format!("Stopped {id}"));
            }
            Err(error) => self.toast(format!("process_stop failed: {error}")),
        }
    }

    /// Walks the project for the files pane, honoring `.gitignore`.
    pub fn refresh_project_files(&mut self) {
        let root = self.code.effective_dir();
        let mut files: Vec<String> = Vec::new();
        for entry in ignore::WalkBuilder::new(&root)
            .max_depth(Some(6))
            .hidden(false)
            .filter_entry(|entry| {
                let name = entry.file_name().to_string_lossy();
                !matches!(name.as_ref(), "target" | "node_modules" | ".git" | "dist")
            })
            .build()
            .flatten()
        {
            if entry.file_type().is_some_and(|kind| kind.is_file()) {
                let path = entry.path();
                let relative = path
                    .strip_prefix(&root)
                    .unwrap_or(path)
                    .display()
                    .to_string();
                files.push(relative);
            }
            if files.len() >= 2000 {
                break;
            }
        }
        files.sort();
        self.project_files = files;
    }

    /// Subagents reported for the active session.
    pub fn active_subagents(&self) -> Vec<&crate::state::SubagentCard> {
        self.active_run()
            .map(|session| session.subagents.iter().collect())
            .unwrap_or_default()
    }

    /// Opens the artifact studio for the selected artifact.
    pub fn open_studio(&mut self) {
        let Some(index) = self.artifacts.selected.or(if self.artifacts.items.is_empty() {
            None
        } else {
            Some(0)
        }) else {
            self.toast("No artifact selected.");
            return;
        };
        let files = self
            .artifacts
            .items
            .get(index)
            .map(|item| vec![StudioFile {
                name: format!("{}.md", item.name.to_lowercase().replace(' ', "-")),
                content: format!("# {}\n\n{}\n", item.name, item.summary),
                language: "markdown".to_owned(),
            }])
            .unwrap_or_default();
        self.overlays.studio = Some(StudioState::new(index, files));
    }

    /// The skills discovered for this project, as a toast summary.
    pub fn skills_summary(&self) -> String {
        let skills = agente_core::extensions::skills::discover(&self.code.effective_dir());
        if skills.is_empty() {
            return "No skills found in this project or your home folders.".to_owned();
        }
        let names: Vec<&str> = skills.iter().map(|skill| skill.name.as_str()).collect();
        format!("{} skills: {}", names.len(), names.join(", "))
    }

    /// MCP servers and their status, as a toast summary.
    pub fn mcp_summary(&self) -> String {
        let servers = self.engine.mcp_snapshots();
        if servers.is_empty() {
            return "No MCP servers configured.".to_owned();
        }
        let rows: Vec<String> = servers
            .iter()
            .map(|server| format!("{} ({:?}, {} tools)", server.name, server.status, server.tools))
            .collect();
        format!("MCP: {}", rows.join(" · "))
    }

    /// The agent roster for this project, as a toast summary.
    pub fn agents_summary(&self) -> String {
        let roster = agente_core::subagent::definition::agent_roster(&self.code.effective_dir());
        let names: Vec<String> = roster
            .iter()
            .map(|agent| {
                let tools = agent
                    .tools
                    .as_ref()
                    .map(|tools| tools.join("/"))
                    .unwrap_or_else(|| "all".to_owned());
                format!("{} ({tools})", agent.name)
            })
            .collect();
        format!("{} agents: {}", names.len(), names.join(", "))
    }

    /// Hardware and downloaded models, best effort.
    pub fn refresh_runtime(&mut self) {
        let mut models: Vec<RuntimeModel> = Vec::new();
        if let Some(home) = dirs::home_dir() {
            let dir = home.join(".agente").join("models");
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let size = entry
                        .metadata()
                        .map(|meta| format!("{:.1} GB", meta.len() as f64 / 1_073_741_824.0))
                        .unwrap_or_else(|_| "—".to_owned());
                    models.push(RuntimeModel {
                        name: path
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        path: path.display().to_string(),
                        size,
                    });
                }
            }
        }
        let hardware = format!(
            "{} · {} cores",
            std::env::consts::OS,
            std::thread::available_parallelism()
                .map(|count| count.get())
                .unwrap_or(0)
        );
        let note = if models.is_empty() {
            "No local models downloaded. llama.cpp servers on this machine still work through the provider list."
                .to_owned()
        } else {
            format!("{} model files under ~/.agente/models", models.len())
        };
        self.overlays.runtime = Some(RuntimePanelState {
            hardware,
            models,
            loaded: None,
            note,
        });
    }

    /// Writes the transcript next to the project, like the TUI's export.
    pub fn export_transcript(&mut self) {
        let Some(session) = self.active_run() else {
            self.toast("Nothing to export.");
            return;
        };
        let mut content = String::new();
        for entry in &session.entries {
            let role = match entry.kind {
                EntryKind::User => "You",
                EntryKind::Assistant => "Assistant",
                EntryKind::Tool => "Tool",
                EntryKind::Thinking => "Thinking",
                EntryKind::Notice => "Notice",
                EntryKind::Compaction => "Compaction",
                EntryKind::Error => "Error",
                EntryKind::Footer => "Turn",
                EntryKind::TurnHeader => "Turn",
                EntryKind::Step => "Step",
            };
            content.push_str(&format!("[{role}] {}\n\n", entry.text));
            if let Some(tool) = &entry.tool_name {
                content.push_str(&format!("  tool: {tool}\n"));
            }
        }
        let path = std::path::Path::new(&self.code.effective_dir()).join("agente_export.md");
        match std::fs::write(&path, content) {
            Ok(()) => self.toast(format!("Exported to {}", path.display())),
            Err(error) => self.toast(format!("Export failed: {error}")),
        }
    }

    /// Runs the shell tool for the embedded terminal.
    pub fn run_terminal_command(&mut self) {
        let Some(terminal) = self.overlays.terminal.as_mut() else {
            return;
        };
        let command = std::mem::take(&mut terminal.input);
        let command = command.trim().to_owned();
        if command.is_empty() {
            return;
        }
        let cwd = terminal.cwd.clone();
        terminal.lines.push(TerminalLine {
            command: true,
            text: command.clone(),
            is_error: false,
        });
        terminal.running = true;
        let registry = agente_core::tools::ToolRegistry::new(cwd);
        let args = serde_json::json!({ "command": command });
        let output = self.engine.block_on(registry.execute("shell", args));
        if let Some(terminal) = self.overlays.terminal.as_mut() {
            terminal.running = false;
            match output {
                Ok(text) => terminal.lines.push(TerminalLine {
                    command: false,
                    text,
                    is_error: false,
                }),
                Err(error) => terminal.lines.push(TerminalLine {
                    command: false,
                    text: format!("{error}"),
                    is_error: true,
                }),
            }
        }
    }

    /// Full-text search across every session's transcript.
    pub fn run_chat_search(&mut self) {
        let Some(search) = self.overlays.chat_search.as_mut() else {
            return;
        };
        let needle = search.query.trim().to_lowercase();
        if needle.is_empty() {
            search.hits.clear();
            return;
        }
        let mut hits: Vec<SearchHit> = Vec::new();
        for session in &self.chat.sessions {
            for (index, entry) in session.entries.iter().enumerate() {
                if entry.text.to_lowercase().contains(&needle) {
                    hits.push(SearchHit {
                        session_id: session.id.clone(),
                        session_title: session.title.clone(),
                        entry_index: index,
                        snippet: crate::state::overlays::entry_preview(entry),
                    });
                }
            }
        }
        hits.truncate(200);
        if let Some(search) = self.overlays.chat_search.as_mut() {
            search.hits = hits;
            search.index = 0;
        }
    }

    /// Jumps to a chat-search hit: selects the session and pins the row.
    pub fn open_search_hit(&mut self, hit: &SearchHit) {
        self.chat.select(&hit.session_id);
        self.nav.activate(Space::Home);
        self.overlays.chat_search = None;
        self.dirty = true;
    }

    /// Fetches a page through the core `web_fetch` tool and stores the text
    /// in the browser panel's notes.
    pub fn fetch_browser_page(&mut self) {
        let url = self.browser.url.trim().to_owned();
        if url.is_empty() {
            self.toast("Type a URL first.");
            return;
        }
        let dir = self.code.effective_dir();
        let registry = agente_core::tools::ToolRegistry::new(dir);
        let args = serde_json::json!({ "url": url });
        match self.engine.block_on(registry.execute("web_fetch", args)) {
            Ok(text) => {
                self.browser.notes = text;
                self.toast_ok(format!("Fetched {url}"));
                self.dirty = true;
            }
            Err(error) => self.toast_err(format!("web_fetch failed: {error}")),
        }
    }

    /// Scans the model folders for the downloads popover.
    pub fn refresh_downloads(&mut self) {
        let mut items: Vec<crate::state::DownloadItem> = Vec::new();
        if let Some(home) = dirs::home_dir() {
            for folder in ["models", "runtimes"] {
                let dir = home.join(".agente").join(folder);
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let name = path
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        let size = entry
                            .metadata()
                            .map(|meta| agente_core::media::human_bytes(meta.len()))
                            .unwrap_or_else(|_| "—".to_owned());
                        items.push(crate::state::DownloadItem {
                            name,
                            detail: format!("{folder} · {size} · on disk"),
                        });
                    }
                }
            }
        }
        if items.is_empty() {
            items.push(crate::state::DownloadItem {
                name: "No model files yet".to_owned(),
                detail: "the models folder stays empty until a model is downloaded".to_owned(),
            });
        }
        self.downloads.items = items;
    }

    /// The git branch of the project folder, cached for a few seconds.
    pub fn git_branch(&mut self) -> String {
        let now = chrono::Utc::now().timestamp();
        if let Some((at, branch)) = self.git_branch_cache.as_ref() {
            if now - at < 5 {
                return branch.clone();
            }
        }
        let dir = self.code.effective_dir();
        let branch = std::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&dir)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .filter(|branch| !branch.is_empty())
            .unwrap_or_else(|| "no repo".to_owned());
        self.git_branch_cache = Some((now, branch.clone()));
        branch
    }

    /// `+N −M` for the session's changed files, like the Electron titlebar.
    pub fn change_counts(&self) -> Option<(u64, u64)> {
        let session = self.active_run()?;
        if session.files.is_empty() {
            return None;
        }
        let additions = session.files.iter().map(|file| file.additions).sum();
        let deletions = session.files.iter().map(|file| file.deletions).sum();
        Some((additions, deletions))
    }

    /// The target the palette and the commands act on.
    pub fn current_target(&self) -> Option<TurnTarget> {
        match self.nav.active {
            Space::Code => Some(TurnTarget::Code),
            Space::Bots => None,
            _ => self.chat.active_id.clone().map(TurnTarget::Session),
        }
    }

    /// Runs `edit` against a target session (or the code workspace).
    pub fn with_target<R>(
        &mut self,
        target: &TurnTarget,
        edit: impl FnOnce(&mut crate::state::Session) -> R,
    ) -> R {
        match target {
            TurnTarget::Session(id) => {
                let session = self
                    .chat
                    .by_id_mut(id)
                    .expect("target session exists");
                edit(session)
            }
            TurnTarget::Code => edit(&mut self.code.run),
        }
    }

    /// Applies the pending confirm dialog.
    pub fn apply_confirm(&mut self, accepted: bool) {
        use crate::state::overlays::ConfirmAction;
        let Some(confirm) = self.overlays.confirm.take() else {
            return;
        };
        if !accepted {
            return;
        }
        match confirm.action {
            ConfirmAction::DeleteSession(id) => {
                self.chat.sessions.retain(|session| session.id != id);
                if self.chat.active_id.as_deref() == Some(id.as_str()) {
                    self.chat.active_id = self.chat.sessions.first().map(|s| s.id.clone());
                }
                if self.chat.sessions.is_empty() {
                    self.chat.new_session(SessionSpace::Home);
                }
                self.toast("Conversation deleted");
            }
            ConfirmAction::DeleteMessage(session, index) => {
                if self.chat.delete_entry(&session, index) {
                    self.toast("Message deleted");
                }
            }
            ConfirmAction::ClearSession(id) => {
                if let Some(session) = self.chat.by_id_mut(&id) {
                    session.entries.clear();
                    session.conversation.clear();
                    session.files.clear();
                    session.todos.clear();
                    session.title = "New chat".to_owned();
                }
                self.toast("Conversation cleared");
            }
            ConfirmAction::RevertFile(path) => {
                let cwd = self.code.effective_dir();
                let full = std::path::Path::new(&cwd).join(&path);
                match std::fs::remove_file(&full) {
                    Ok(()) => self.toast(format!("Removed {path}")),
                    Err(error) => self.toast(format!("Revert failed: {error}")),
                }
            }
            ConfirmAction::RevertAll => {
                let paths = self.code.forget_all_files();
                self.toast(format!("Reverted {} files", paths.len()));
            }
            ConfirmAction::DeleteArtifact(index) => {
                if index < self.artifacts.items.len() {
                    self.artifacts.items.remove(index);
                }
                self.toast("Artifact deleted");
            }
            ConfirmAction::DeleteBot(index) => {
                if index < self.bots.bots.len() {
                    self.bots.bots.remove(index);
                }
                self.toast("Bot deleted");
            }
            ConfirmAction::CloseProject(index) => {
                if index < self.code.projects.len() {
                    self.code.projects.remove(index);
                    self.code.active_project = None;
                }
                self.toast("Project closed");
            }
        }
        self.dirty = true;
    }

    /// Applies a turn-level command's own copy of the conversation.
    pub fn push_assistant_entry(&mut self, text: &str) {
        if let Some(target) = self.current_target() {
            self.with_target(&target, |session| {
                session.entries.push(Entry::assistant(text));
            });
        }
    }

    /// True when the active space has something worth searching.
    pub fn has_transcript(&self) -> bool {
        self.active_run()
            .is_some_and(|session| !session.entries.is_empty())
    }

    /// The conversation the engine would send, for the prompt inspector.
    pub fn prompt_preview(&self) -> (String, String, u32) {
        let Some(session) = self.active_run() else {
            return (String::new(), String::new(), 0);
        };
        let mut system = String::new();
        let mut messages = String::new();
        for message in &session.conversation {
            match message.role {
                Role::System => {
                    system.push_str(&message.content);
                    system.push('\n');
                }
                Role::User => {
                    messages.push_str("[user] ");
                    messages.push_str(&message.content);
                    messages.push_str("\n\n");
                }
                Role::Assistant => {
                    messages.push_str("[assistant] ");
                    messages.push_str(&message.content);
                    messages.push_str("\n\n");
                }
                Role::Tool => {
                    messages.push_str("[tool] ");
                    messages.push_str(&message.content);
                    messages.push_str("\n\n");
                }
            }
        }
        let tokens = estimate(&session.conversation);
        (system, messages, tokens)
    }

    /// Opens the prompt inspector for the active session.
    pub fn open_prompt_inspector(&mut self) {
        let (system, messages, tokens) = self.prompt_preview();
        self.overlays.prompt_inspector = Some(crate::state::overlays::PromptInspectorState {
            system,
            messages,
            tokens,
        });
    }
}

/// Rough token estimate: characters over four, the same rule the TUI uses for
/// its context meter.
pub fn estimate(messages: &[Message]) -> u32 {
    let chars: usize = messages.iter().map(|message| message.content.len()).sum();
    (chars / 4) as u32
}

fn format_tokens(tokens: u32) -> String {
    if tokens >= 1000 {
        format!("{}k", tokens / 1000)
    } else {
        tokens.to_string()
    }
}

/// A short label for a turn target.
pub fn target_label(target: &TurnTarget) -> String {
    match target {
        TurnTarget::Session(id) => format!("session {}", &id[..8.min(id.len())]),
        TurnTarget::Code => "code workspace".to_owned(),
    }
}
