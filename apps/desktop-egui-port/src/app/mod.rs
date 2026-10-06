//! `DesktopApp`: the eframe entry point, the engine owner, and the place
//! where `AgentEvent`s become transcript rows. Ports `App.svelte` startup
//! (theme, reading scale, store init, session restore) plus the Electron main
//! process's event bridge.

use agente_core::agent::AgentEvent;
use agente_core::types::{AgentMode as CoreMode, ApprovalAction};
use egui::{Context, ViewportBuilder};

use crate::backend::engine::{Engine, TurnSpec};
use crate::backend::{AgentMode, Prefs, SessionSpace, protocol_version, read_state, write_state};
use crate::icons;
use crate::state::overlays::{Overlays, StudioFile};
use crate::state::{
    ArtifactState, BotState, BrowserPanelState, CanvasState, ChatState, CodeState, DownloadState,
    Entry, EntryKind, FileStatus, HomeState, Navigation, OnboardingState, RoleplayState, RunState,
    SearchState, SettingsUiState, Space, SubagentCard,
};
use crate::style::{Theme, apply_style};
use crate::views::shell;

pub mod actions;
pub mod commands;
pub mod keys;

/// The project folder the file explorer and the shell tools start from.
const PLAN_DIR: &str = ".agente/plans";

/// Which session the engine's current turn belongs to.
#[derive(Clone, Debug)]
pub enum TurnTarget {
    Session(String),
    Code,
}

/// Persistent slice of the app: sessions and each screen's own state.
#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedState {
    chat: ChatState,
    code: CodeState,
    artifacts: ArtifactState,
    bots: BotState,
    roleplay: RoleplayState,
    home: HomeState,
    search: SearchState,
    browser: BrowserPanelState,
    canvas: CanvasState,
    downloads: DownloadState,
    onboarding: OnboardingState,
    nav_active: Space,
    terminal: Vec<crate::state::overlays::TerminalLine>,
    routines: Vec<crate::state::overlays::Routine>,
    lore: Vec<crate::state::overlays::LoreEntry>,
    studio: Vec<StudioFile>,
}

/// Whole desktop in one struct. Every view borrows its slice per frame.
pub struct DesktopApp {
    pub prefs: Prefs,
    pub engine: Engine,
    pub nav: Navigation,
    pub chat: ChatState,
    pub code: CodeState,
    pub artifacts: ArtifactState,
    pub bots: BotState,
    pub roleplay: RoleplayState,
    pub canvas: CanvasState,
    pub home: HomeState,
    pub search: SearchState,
    pub browser: BrowserPanelState,
    pub onboarding: OnboardingState,
    pub settings_ui: SettingsUiState,
    pub downloads: DownloadState,
    pub clipboard: Option<arboard::Clipboard>,
    pub toasts: Vec<crate::state::Toast>,
    pub sessions_linked: bool,
    pub dirty: bool,
    /// The session the live turn belongs to, and its engine task id.
    pub turn_target: Option<(u64, TurnTarget)>,
    /// Turns the views ordered; the shell starts them on the engine.
    pub pending: Vec<(TurnTarget, AgentMode)>,
    /// Every modal, drawer and docked panel that is not a space.
    pub overlays: Overlays,
    /// Right-dock doors: changed files and the project tree.
    pub dock_changes: bool,
    pub dock_files: bool,
    /// Inline session rename: (session id, draft title).
    pub renaming: Option<(String, String)>,
    /// Project tree cache for the files pane.
    pub project_files: Vec<String>,
    /// Background processes reported by the core tools.
    pub processes: Vec<String>,
    /// A scroll-to-bottom request from a shortcut.
    pub scroll_to_bottom: bool,
    /// Set when the theme changed, so the next frame reinstalls the style.
    pub theme_dirty: bool,
    /// Set by Ctrl+Q; the run loop closes the window.
    pub quit_requested: bool,
    /// Cached `git rev-parse` result: (fetched at, branch).
    pub git_branch_cache: Option<(i64, String)>,
    /// Frames painted so far, used by the screenshot harness.
    frames: u32,
    /// Where the harness writes its PNG, from `AGENTE_EGUI_SCREENSHOT`.
    screenshot_path: Option<String>,
}

impl DesktopApp {
    /// Boots the app. `resume` carries `--resume [id]`: a value selects that
    /// session (id or prefix), an empty string opens the picker.
    pub fn new(cc: &eframe::CreationContext<'_>, resume: Option<String>) -> Self {
        let mut prefs = Prefs::load();
        // The visual harness can pin the theme so screenshots are reproducible.
        if let Ok(theme) = std::env::var("AGENTE_EGUI_THEME") {
            prefs.theme_dark = theme != "light";
        }
        let harness_view = std::env::var("AGENTE_EGUI_VIEW").ok();
        let theme = if prefs.theme_dark {
            Theme::Dark
        } else {
            Theme::Light
        };
        icons::install(&cc.egui_ctx);
        apply_style(&cc.egui_ctx, theme, prefs.reading_scale);

        let project_dir = if prefs.project_dir.trim().is_empty() {
            std::env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".to_owned())
        } else {
            prefs.project_dir.clone()
        };
        let engine = Engine::new(&project_dir);

        let restored: Option<PersistedState> = read_state();
        let mut app = match restored {
            Some(state) => Self {
                prefs: prefs.clone(),
                engine,
                nav: Navigation {
                    active: state.nav_active,
                    sidebar_open: prefs.sidebar_open,
                    ..Default::default()
                },
                chat: state.chat,
                code: state.code,
                artifacts: state.artifacts,
                bots: state.bots,
                roleplay: state.roleplay,
                canvas: state.canvas,
                home: state.home,
                search: state.search,
                browser: state.browser,
                onboarding: state.onboarding,
                settings_ui: SettingsUiState::default(),
                downloads: state.downloads,
                clipboard: arboard::Clipboard::new().ok(),
                toasts: Vec::new(),
                sessions_linked: crate::backend::shared_session_store_linked(),
                dirty: false,
                turn_target: None,
                pending: Vec::new(),
                frames: 0,
                screenshot_path: std::env::var("AGENTE_EGUI_SCREENSHOT").ok(),
                overlays: Overlays::default(),
                dock_changes: false,
                dock_files: false,
                renaming: None,
                project_files: Vec::new(),
                processes: Vec::new(),
                scroll_to_bottom: false,
                theme_dirty: false,
                quit_requested: false,
                git_branch_cache: None,
            },
            None => Self {
                prefs: prefs.clone(),
                engine,
                nav: Navigation {
                    sidebar_open: prefs.sidebar_open,
                    ..Default::default()
                },
                chat: ChatState::default(),
                code: CodeState {
                    project_dir: prefs.project_dir.clone(),
                    ..Default::default()
                },
                artifacts: ArtifactState::default(),
                bots: BotState::default(),
                roleplay: RoleplayState::default(),
                canvas: CanvasState::default(),
                home: HomeState::default(),
                search: SearchState::default(),
                browser: BrowserPanelState::default(),
                onboarding: OnboardingState {
                    done: prefs.onboarding_done,
                    ..Default::default()
                },
                settings_ui: SettingsUiState::default(),
                downloads: DownloadState::default(),
                clipboard: arboard::Clipboard::new().ok(),
                toasts: Vec::new(),
                sessions_linked: crate::backend::shared_session_store_linked(),
                dirty: false,
                turn_target: None,
                pending: Vec::new(),
                frames: 0,
                screenshot_path: std::env::var("AGENTE_EGUI_SCREENSHOT").ok(),
                overlays: Overlays::default(),
                dock_changes: false,
                dock_files: false,
                renaming: None,
                project_files: Vec::new(),
                processes: Vec::new(),
                scroll_to_bottom: false,
                theme_dirty: false,
                quit_requested: false,
                git_branch_cache: None,
            },
        };
        if app.chat.sessions.is_empty() {
            app.chat.new_session(SessionSpace::Home);
        }
        match resume {
            Some(id) if id.trim().is_empty() => {
                app.overlays.session_picker = Some(Default::default());
            }
            Some(id) => {
                let needle = id.trim();
                let found = app
                    .chat
                    .sessions
                    .iter()
                    .find(|session| session.id.starts_with(needle))
                    .map(|session| session.id.clone());
                match found {
                    Some(found) => app.chat.select(&found),
                    None => app.toast_err(format!("No session matches {needle}")),
                }
            }
            None => {}
        }
        if app.chat.active_id.is_none() {
            app.chat.active_id = app.chat.sessions.first().map(|session| session.id.clone());
        }
        match harness_view.as_deref() {
            Some("settings") => app.nav.settings_open = true,
            Some("code") => app.nav.activate(Space::Code),
            Some("roleplay") => app.nav.activate(Space::Roleplay),
            Some("bots") => app.nav.activate(Space::Bots),
            _ => {}
        }
        app
    }

    pub fn apply_theme(&self, ctx: &Context) {
        let theme = if self.prefs.theme_dark {
            Theme::Dark
        } else {
            Theme::Light
        };
        apply_style(ctx, theme, self.prefs.reading_scale);
    }

    /// Pushes an info toast.
    pub fn toast(&mut self, message: impl Into<String>) {
        self.toasts.push(crate::state::Toast::info(message));
    }

    /// Pushes a success toast.
    pub fn toast_ok(&mut self, message: impl Into<String>) {
        self.toasts.push(crate::state::Toast::success(message));
    }

    /// Pushes an error toast.
    pub fn toast_err(&mut self, message: impl Into<String>) {
        self.toasts.push(crate::state::Toast::error(message));
    }

    /// Drops expired toasts; call once per frame.
    pub fn expire_toasts(&mut self) {
        self.toasts.retain(|toast| !toast.expired());
    }

    /// The provider/model pair turns run on. Reads the core config, so a model
    /// picked here is the TUI's model too.
    pub fn active_model(&self) -> (String, String) {
        let config = self.engine.config();
        let provider = config
            .default_provider
            .clone()
            .unwrap_or_else(|| "openrouter".to_owned());
        let model = config.default_model.clone().unwrap_or_default();
        (provider, model)
    }

    /// Orders a turn for a chat session or the code workspace.
    pub fn order_turn(&mut self, target: TurnTarget, mode: AgentMode) {
        if self.engine.running() {
            self.toast("A turn is already running — press stop first.");
            return;
        }
        self.pending.push((target, mode));
    }

    /// True while that target has a turn in flight.
    pub fn target_busy(&self, target: &TurnTarget) -> bool {
        match target {
            TurnTarget::Session(id) => self
                .chat
                .sessions
                .iter()
                .find(|session| &session.id == id)
                .is_some_and(|session| session.state.working()),
            TurnTarget::Code => self.code.run.state.working(),
        }
    }

    /// Starts whatever the views ordered, on the engine.
    pub fn start_pending(&mut self) {
        let Some((target, mode)) = self.pending.first().cloned() else {
            return;
        };
        self.pending.clear();
        let (provider, model) = self.active_model();
        if provider.trim().is_empty() || model.trim().is_empty() {
            self.toast("Pick a provider and model in Settings first.");
            return;
        }
        let thinking = self.prefs.thinking_level.clone();
        let project_dir = self.code.effective_dir();
        let auto_approve = self.code.auto_approve;
        let conversation = match &target {
            TurnTarget::Session(id) => {
                let Some(session) = self.chat.by_id_mut(id) else {
                    return;
                };
                session.begin_turn();
                session.retry = None;
                session.approvals.clear();
                session.conversation.clone()
            }
            TurnTarget::Code => {
                let session = &mut self.code.run;
                session.begin_turn();
                session.retry = None;
                session.approvals.clear();
                session.conversation.clone()
            }
        };
        let spec = TurnSpec {
            conversation,
            provider,
            model,
            thinking_level: thinking,
            mode,
            project_dir,
            auto_approve,
        };
        match self.engine.start_turn(spec) {
            Some(task_id) => self.turn_target = Some((task_id, target)),
            None => self.toast("The engine could not start that turn."),
        }
    }

    /// Sends a composer draft for the active space.
    pub fn send_draft(&mut self, space: SessionSpace, mode: AgentMode) {
        let text = std::mem::take(&mut self.chat.draft);
        let prompt = text.trim().to_owned();
        if prompt.is_empty() {
            return;
        }
        self.chat.ensure_session(space);
        let attachments = std::mem::take(&mut self.chat.attachments);
        let Some(session) = self.chat.active_mut() else {
            return;
        };
        let id = session.id.clone();
        if session.state.working() && self.engine.steer(&prompt, None) {
            // The live turn takes it at its next step boundary.
            session.entries.push(Entry::user(&prompt));
            return;
        }
        session.push_user(&prompt, &prompt);
        if !attachments.is_empty() {
            if let Some(message) = session
                .conversation
                .iter_mut()
                .rev()
                .find(|message| message.role == agente_core::types::Role::User)
            {
                message.attachments = attachments;
            }
        }
        self.order_turn(TurnTarget::Session(id), mode);
    }

    /// Applies engine events to the transcript they belong to.
    pub fn drain_engine(&mut self) {
        for event in self.engine.drain() {
            let Some((task_id, target)) = self.turn_target.clone() else {
                continue;
            };
            if event.task_id != task_id {
                continue;
            }
            self.apply_event(&target, event.event);
        }
    }

    fn apply_event(&mut self, target: &TurnTarget, event: AgentEvent) {
        match event {
            AgentEvent::Thinking => {}
            AgentEvent::TextDelta(text) | AgentEvent::AssistantText(text) => {
                self.with_session(target, |session| {
                    if session.state != RunState::Streaming {
                        session.state = RunState::Streaming;
                    }
                    session.append_stream(&text);
                });
            }
            AgentEvent::ReasoningDelta(text) => {
                self.with_session(target, |session| session.append_reasoning(&text));
            }
            AgentEvent::GenerationProgress { .. } => {}
            AgentEvent::ToolCallStart { id, name, args } => {
                let detail = short_args(&args);
                self.with_session(target, |session| {
                    session.start_tool(&id, &name);
                    session.tool_progress(&id, &detail);
                    session.count_steps();
                });
            }
            AgentEvent::ToolCallProgress { id, chunk } => {
                self.with_session(target, |session| session.tool_progress(&id, &chunk));
            }
            AgentEvent::ToolHeartbeat { .. } => {}
            AgentEvent::ToolCallResult {
                id,
                name,
                result,
                is_error,
            } => {
                self.with_session(target, |session| {
                    session.finish_tool(&id, &name, &result, is_error);
                    if is_error {
                        session
                            .entries
                            .push(Entry::new(EntryKind::Error, result.clone()));
                    }
                });
            }
            AgentEvent::FileChange {
                subagent_id,
                path,
                diff_summary,
                before,
                after,
            } => {
                if subagent_id.is_some() {
                    return;
                }
                self.with_session(target, |session| {
                    let status = match (&before, &after) {
                        (None, Some(_)) => FileStatus::Created,
                        (Some(_), None) => FileStatus::Deleted,
                        _ => FileStatus::Modified,
                    };
                    let (additions, deletions) = count_diff(&diff_summary);
                    match session.files.iter_mut().find(|file| file.path == path) {
                        Some(existing) => {
                            existing.status = status;
                            existing.additions = additions;
                            existing.deletions = deletions;
                            existing.diff = Some(diff_summary.clone());
                        }
                        None => session.files.push(crate::state::ChangedFile {
                            path: path.clone(),
                            status,
                            additions,
                            deletions,
                            diff: Some(diff_summary.clone()),
                        }),
                    }
                });
            }
            AgentEvent::TodoUpdate { subagent_id, todos } => {
                if subagent_id.is_some() {
                    return;
                }
                self.with_session(target, |session| {
                    session.todos = todos
                        .into_iter()
                        .map(|todo| crate::state::TodoItem {
                            done: todo.status.eq_ignore_ascii_case("completed"),
                            text: todo.content,
                        })
                        .collect();
                });
            }
            AgentEvent::Done {
                conversation,
                tokens,
            } => self.commit_turn(target, Some(conversation), tokens, None),
            AgentEvent::Cancelled {
                conversation,
                tokens,
                partial_text,
            } => self.commit_turn(target, Some(conversation), tokens, Some(partial_text)),
            AgentEvent::CompactionStarted { smart, model } => {
                let label = match (smart, model) {
                    (true, Some(model)) => format!("Compacting context with {model}…"),
                    (true, _) => "Compacting context…".to_owned(),
                    _ => "Trimming context…".to_owned(),
                };
                self.with_session(target, |session| {
                    session
                        .entries
                        .push(Entry::new(EntryKind::Compaction, label));
                });
            }
            AgentEvent::ContextCompacted {
                tokens_before,
                tokens_after,
                smart,
                compacted_conversation,
                ..
            } => {
                let how = if smart { "summarized" } else { "trimmed" };
                self.with_session(target, |session| {
                    session.conversation = compacted_conversation.clone();
                    session.entries.push(Entry::new(
                        EntryKind::Compaction,
                        format!(
                            "Context compacted · {} → {} · {how}",
                            format_tokens(tokens_before),
                            format_tokens(tokens_after)
                        ),
                    ));
                });
            }
            AgentEvent::TurnUsage {
                prompt_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                context_tokens,
                ..
            } => {
                self.with_session(target, |session| {
                    session.prompt_tokens = prompt_tokens;
                    session.cache_read_tokens = cache_read_tokens;
                    session.cache_write_tokens = cache_creation_tokens;
                    session.context_tokens = context_tokens;
                });
            }
            AgentEvent::CallUsage {
                cost_usd,
                cost_estimated,
                ..
            } => {
                self.with_session(target, |session| match cost_usd {
                    Some(cost) => {
                        session.spend_usd += cost;
                        if cost_estimated {
                            session.spend_estimated = true;
                        }
                    }
                    None => session.has_unpriced = true,
                });
            }
            AgentEvent::UserMessagesInjected { messages } => {
                self.with_session(target, |session| {
                    for message in messages {
                        session.entries.push(Entry::user(message));
                    }
                });
            }
            AgentEvent::Retry {
                attempt,
                max_attempts,
                ..
            } => {
                self.with_session(target, |session| {
                    session.retry = Some((attempt, max_attempts));
                });
            }
            AgentEvent::ApprovalRequested { request, .. } => {
                self.with_session(target, |session| {
                    session.state = RunState::AwaitingApproval;
                    session.approvals.push(request);
                });
            }
            AgentEvent::SubagentStarted {
                id,
                subagent_type,
                description,
                model,
            } => {
                self.with_session(target, |session| {
                    session.subagents.push(SubagentCard {
                        id,
                        subagent_type,
                        description,
                        model,
                        summary: String::new(),
                        live_text: String::new(),
                        done: false,
                        is_error: false,
                    });
                });
            }
            AgentEvent::SubagentText { id, text } => {
                self.with_session(target, |session| {
                    if let Some(card) = session.subagents.iter_mut().find(|card| card.id == id) {
                        card.live_text.push_str(&text);
                    }
                });
            }
            AgentEvent::SubagentToolCallStart { id, name, .. } => {
                self.with_session(target, |session| {
                    if let Some(card) = session.subagents.iter_mut().find(|card| card.id == id) {
                        card.summary = format!("running {name}");
                    }
                });
            }
            AgentEvent::SubagentToolCallProgress { .. } => {}
            AgentEvent::SubagentToolCallResult { id, name, .. } => {
                self.with_session(target, |session| {
                    if let Some(card) = session.subagents.iter_mut().find(|card| card.id == id) {
                        card.summary = format!("finished {name}");
                    }
                });
            }
            AgentEvent::SubagentDone {
                id,
                summary,
                is_error,
            } => {
                self.with_session(target, |session| {
                    if let Some(card) = session.subagents.iter_mut().find(|card| card.id == id) {
                        card.summary = summary.clone();
                        card.done = true;
                        card.is_error = is_error;
                        let mut row = Entry::new(
                            EntryKind::Step,
                            format!("{} · {}", card.subagent_type, card.description),
                        );
                        row.depth = 2;
                        row.meta = format!(
                            "{} · {} · {}",
                            if is_error { "Failed" } else { "Done" },
                            card.model,
                            summary
                        );
                        row.is_error = is_error;
                        session.entries.push(row);
                    }
                    session.count_steps();
                });
            }
            AgentEvent::SubagentCompletedNotice { summary, .. } => {
                self.with_session(target, |session| {
                    session
                        .entries
                        .push(Entry::notice(format!("Subagent finished: {summary}")));
                });
            }
            AgentEvent::Error {
                message,
                conversation,
            } => {
                let conversation = if conversation.is_empty() {
                    None
                } else {
                    Some(conversation)
                };
                self.commit_turn(target, conversation, 0, None);
                self.with_session(target, |session| {
                    session
                        .entries
                        .push(Entry::new(EntryKind::Error, message.clone()));
                });
            }
            AgentEvent::ModelsDiscovered { .. }
            | AgentEvent::ModelDiscoveryFailed { .. }
            | AgentEvent::ModelCatalogUpdated { .. } => {}
        }
    }

    /// Ends the turn: stores the engine's transcript, writes the footer and
    /// clears the live flags.
    fn commit_turn(
        &mut self,
        target: &TurnTarget,
        conversation: Option<Vec<agente_core::types::Message>>,
        context_tokens: u32,
        partial: Option<String>,
    ) {
        self.with_session(target, |session| {
            if let Some(conversation) = conversation {
                if !conversation.is_empty() {
                    session.conversation = conversation;
                }
            }
            if context_tokens > 0 {
                session.context_tokens = context_tokens;
            }
            if let Some(partial) = partial {
                if !partial.trim().is_empty() {
                    session.append_stream(&partial);
                }
            }
            session.finish_turn();
        });
        self.turn_target = None;
        self.dirty = true;
    }

    fn with_session(
        &mut self,
        target: &TurnTarget,
        edit: impl FnOnce(&mut crate::state::Session),
    ) {
        match target {
            TurnTarget::Session(id) => {
                if let Some(session) = self.chat.by_id_mut(id) {
                    edit(session);
                }
            }
            TurnTarget::Code => edit(&mut self.code.run),
        }
    }

    /// Answers a pending approval through the engine's broker.
    pub fn resolve_approval(&mut self, request_id: &str, action: ApprovalAction) {
        let note = match action {
            ApprovalAction::ApproveOnce => "Approved once",
            ApprovalAction::ApproveAll => "Approved all for this turn",
            ApprovalAction::Deny => "Denied",
            ApprovalAction::Cancel => "Cancelled",
        };
        let is_cancel = matches!(action, ApprovalAction::Cancel);
        if !self.engine.respond(request_id, action) {
            return;
        }
        if let Some((_, target)) = self.turn_target.clone() {
            self.with_session(&target, |session| {
                session.entries.push(Entry::notice(note));
                session.approvals.clear();
                session.state = if is_cancel {
                    RunState::Idle
                } else {
                    RunState::Executing
                };
            });
        }
    }

    /// Stops the running turn, keeping whatever streamed so far.
    pub fn stop_turn(&mut self) {
        self.engine.stop();
        if let Some((_, target)) = self.turn_target.take() {
            self.with_session(&target, |session| {
                session.finish_turn();
                session.entries.push(Entry::notice("Stopped by user"));
            });
        }
        self.dirty = true;
    }

    /// Mirrors live fields into the prefs and saves everything. The visual
    /// harness never writes: a screenshot run must not touch the user's config.
    pub fn save_all(&mut self) {
        if self.screenshot_path.is_some() {
            return;
        }
        self.prefs.project_dir = self.code.project_dir.clone();
        self.prefs.sidebar_open = self.nav.sidebar_open;
        self.prefs.onboarding_done = self.onboarding.done;
        self.prefs.save();
        let studio_files = self
            .overlays
            .studio
            .as_ref()
            .map(|studio| studio.files.clone())
            .unwrap_or_default();
        let terminal_lines = self
            .overlays
            .terminal
            .as_ref()
            .map(|terminal| terminal.lines.clone())
            .unwrap_or_default();
        let routines = self
            .overlays
            .routines
            .as_ref()
            .map(|routines| routines.routines.clone())
            .unwrap_or_default();
        let lore = self
            .overlays
            .lorebook
            .as_ref()
            .map(|lore| lore.entries.clone())
            .unwrap_or_default();
        let state = PersistedState {
            chat: self.chat.clone(),
            code: self.code.clone(),
            studio: studio_files,
            terminal: terminal_lines,
            routines,
            lore,
            artifacts: self.artifacts.clone(),
            bots: self.bots.clone(),
            roleplay: self.roleplay.clone(),
            home: self.home.clone(),
            search: self.search.clone(),
            browser: self.browser.clone(),
            canvas: self.canvas.clone(),
            downloads: self.downloads.clone(),
            onboarding: self.onboarding.clone(),
            nav_active: self.nav.active,
        };
        write_state(&state);
    }

    /// Protocol version shared with every Agente client.
    pub fn protocol_version() -> u16 {
        protocol_version()
    }

    /// Mode label for the status row.
    pub fn mode_label(&self) -> &'static str {
        match self.nav.active {
            Space::Code => self.code.mode.label(),
            _ => "Chat",
        }
    }

    /// The session the status row and composer read.
    pub fn active_run(&self) -> Option<&crate::state::Session> {
        match self.nav.active {
            Space::Code => Some(&self.code.run),
            Space::Home | Space::Roleplay => self.chat.active(),
            Space::Bots => None,
        }
    }
}

fn short_args(args: &str) -> String {
    const LIMIT: usize = 160;
    let flat: String = args.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.len() <= LIMIT {
        flat
    } else {
        format!("{}…", flat.chars().take(LIMIT).collect::<String>())
    }
}

fn count_diff(diff: &str) -> (u64, u64) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

fn format_tokens(tokens: u32) -> String {
    if tokens >= 1000 {
        format!("{}k", tokens / 1000)
    } else {
        tokens.to_string()
    }
}

/// The core mode the engine runs with for a UI mode.
pub fn core_mode(mode: AgentMode) -> CoreMode {
    match mode {
        AgentMode::Plan => CoreMode::Plan,
        AgentMode::Build => CoreMode::Build,
    }
}

impl eframe::App for DesktopApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        if self.engine.running() {
            ctx.request_repaint();
        }
        if self.theme_dirty {
            self.theme_dirty = false;
            self.apply_theme(&ctx);
        }
        keys::handle(self, &ctx);
        self.expire_toasts();
        self.drain_engine();
        shell::show(ui, self);
        self.start_pending();
        self.scroll_to_bottom = false;
        self.screenshot_harness(&ctx);
        if self.quit_requested {
            self.save_all();
            if let Some(session) = self.chat.active() {
                println!(
                    "Resume with: agente-desktop-egui --resume {}",
                    session.id
                );
            }
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        if self.dirty {
            self.save_all();
            self.dirty = false;
        }
    }
}

/// Visual harness: with `AGENTE_EGUI_SCREENSHOT=/path/out.png`, paints a few
/// frames, asks the backend for a screenshot, writes it and exits. Used to
/// check the window against the Electron screens without a display server.
impl DesktopApp {
    fn screenshot_harness(&mut self, ctx: &egui::Context) {
        let Some(path) = self.screenshot_path.clone() else {
            return;
        };
        self.frames += 1;
        if self.frames < 4 {
            ctx.request_repaint();
            return;
        }
        if self.frames == 4 {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(
                egui::UserData::default(),
            ));
            ctx.request_repaint();
            return;
        }
        let shot = ctx.input(|input| {
            input.events.iter().find_map(|event| match event {
                egui::Event::Screenshot { image, .. } => Some(image.clone()),
                _ => None,
            })
        });
        if let Some(image) = shot {
            let [width, height] = image.size;
            let mut bytes = Vec::with_capacity(width * height * 4);
            for pixel in &image.pixels {
                bytes.extend_from_slice(&[pixel.r(), pixel.g(), pixel.b(), pixel.a()]);
            }
            if let Some(buffer) = image::RgbaImage::from_raw(width as u32, height as u32, bytes) {
                let _ = buffer.save(&path);
                eprintln!("[desktop-egui] screenshot written to {path}");
            }
            std::process::exit(0);
        }
        ctx.request_repaint();
    }
}

/// Boots the native window. `main.rs` is the only caller.
pub fn run(resume: Option<String>) -> Result<(), eframe::Error> {
    let options = eframe::NativeOptions {
        viewport: ViewportBuilder::default().with_inner_size([1280.0, 800.0]),
        ..Default::default()
    };
    eframe::run_native(
        "Agente Code",
        options,
        Box::new(move |cc| Ok(Box::new(DesktopApp::new(cc, resume.clone())))),
    )
}
