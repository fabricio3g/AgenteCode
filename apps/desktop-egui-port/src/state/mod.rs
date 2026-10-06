//! UI state. Ports the Electron Svelte stores and feature-local state to
//! plain Rust structs. Spaces match `spaces.ts` exactly: home, code and
//! roleplay, with bots and the artifacts library beside them.
//!
//! Each session keeps two views of the same conversation: `conversation` is
//! the core transcript the engine sends to the model, and `entries` is what
//! the thread paints. That split is what the TUI does, and it is why a
//! resumed session replays exactly what the model saw.

pub mod overlays;

use agente_core::types::{ApprovalRequest, Message, Role};

use crate::backend::{AgentMode, SessionSpace};

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now_stamp() -> i64 {
    chrono::Utc::now().timestamp()
}

fn title_of(text: &str) -> String {
    const LIMIT: usize = 32;
    let first = text.lines().next().unwrap_or("New chat").trim();
    if first.is_empty() {
        "New chat".to_owned()
    } else if first.len() <= LIMIT {
        first.to_owned()
    } else {
        format!("{}…", first.chars().take(LIMIT).collect::<String>())
    }
}

/// The three top-level spaces, plus bots. Ports `SpaceId` + the bots screen.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum Space {
    #[default]
    Home,
    Code,
    Roleplay,
    Bots,
}

impl Space {
    pub const ALL: &[Self] = &[Self::Home, Self::Code, Self::Roleplay, Self::Bots];

    pub fn label(self) -> &'static str {
        match self {
            Self::Home => "Home",
            Self::Code => "Code",
            Self::Roleplay => "Roleplay",
            Self::Bots => "Bots",
        }
    }

    /// Rail icon, like the Electron activity rail.
    pub fn icon(self) -> &'static str {
        match self {
            Self::Home => crate::icons::ICON_HOME,
            Self::Code => crate::icons::ICON_CODE,
            Self::Roleplay => crate::icons::ICON_ROLEPLAY,
            Self::Bots => crate::icons::ICON_BOTS,
        }
    }

    /// One-line purpose statement, like `SpaceDefinition.description`.
    pub fn description(self) -> &'static str {
        match self {
            Self::Home => "Conversation, research and investigation.",
            Self::Code => "The coding agent: projects, files, edits.",
            Self::Roleplay => "Character-driven scenes and lore.",
            Self::Bots => "Assistants, routines and automations.",
        }
    }

    pub fn session_space(self) -> Option<SessionSpace> {
        match self {
            Self::Home => Some(SessionSpace::Home),
            Self::Code => Some(SessionSpace::Code),
            Self::Roleplay => Some(SessionSpace::Roleplay),
            Self::Bots => None,
        }
    }
}

/// Navigation. Settings is a screen over the workspace, never a space, so the
/// rail never shows two active rows at once.
#[derive(Clone, Debug)]
pub struct Navigation {
    pub active: Space,
    pub settings_open: bool,
    pub onboarding_open: bool,
    pub sidebar_open: bool,
}

impl Default for Navigation {
    fn default() -> Self {
        Self {
            active: Space::default(),
            settings_open: false,
            onboarding_open: false,
            sidebar_open: true,
        }
    }
}

impl Navigation {
    pub fn activate(&mut self, space: Space) {
        self.active = space;
        self.settings_open = false;
    }

    pub fn toggle_sidebar(&mut self) {
        self.sidebar_open = !self.sidebar_open;
    }

    pub fn toggle_settings(&mut self) {
        self.settings_open = !self.settings_open;
    }

    pub fn close_settings(&mut self) {
        self.settings_open = false;
    }

    pub fn open_onboarding(&mut self) {
        self.onboarding_open = true;
    }

    pub fn close_onboarding(&mut self) {
        self.onboarding_open = false;
    }
}

/// Home content: the thread, or the artifact library.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum HomeView {
    #[default]
    Chat,
    Artifacts,
}

/// Composer loop on home: instant answers or the full agent loop.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum ComposerMode {
    Instant,
    #[default]
    Agent,
}

impl ComposerMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Instant => "Instant",
            Self::Agent => "Agent",
        }
    }

    pub fn toggle(self) -> Self {
        match self {
            Self::Instant => Self::Agent,
            Self::Agent => Self::Instant,
        }
    }
}

/// One painted transcript row. Ports the TUI's entry grammar, which the
/// Desktop transcript follows too.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Entry {
    pub kind: EntryKind,
    pub text: String,
    /// Media that rode with this row (user turns only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<agente_protocol::Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub seconds: u64,
    /// Tree depth for step rows, like the Electron step list.
    #[serde(default)]
    pub depth: u8,
    /// Right-aligned meta for a step row (`Working · model · $0.004`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub meta: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub enum EntryKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Notice,
    Compaction,
    Error,
    Footer,
    /// The collapsed turn header: `⌄ N steps` with the elapsed time.
    TurnHeader,
    /// A step row inside a turn (tools, subagents, todos).
    Step,
}

impl Entry {
    pub fn user(text: impl Into<String>) -> Self {
        Self::new(EntryKind::User, text)
    }

    pub fn assistant(text: impl Into<String>) -> Self {
        Self::new(EntryKind::Assistant, text)
    }

    pub fn notice(text: impl Into<String>) -> Self {
        Self::new(EntryKind::Notice, text)
    }

    pub fn new(kind: EntryKind, text: impl Into<String>) -> Self {
        Self {
            kind,
            text: text.into(),
            attachments: Vec::new(),
            tool_name: None,
            tool_id: None,
            is_error: false,
            seconds: 0,
            depth: 0,
            meta: String::new(),
        }
    }

    pub fn tool(tool_id: impl Into<String>, name: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            kind: EntryKind::Tool,
            text: text.into(),
            attachments: Vec::new(),
            tool_name: Some(name.into()),
            tool_id: Some(tool_id.into()),
            is_error: false,
            seconds: 0,
            depth: 1,
            meta: String::new(),
        }
    }
}

/// What the turn is doing, so the composer and status row know.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum RunState {
    #[default]
    Idle,
    Streaming,
    Executing,
    AwaitingApproval,
}

impl RunState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Streaming => "streaming",
            Self::Executing => "running tools",
            Self::AwaitingApproval => "needs approval",
        }
    }

    pub fn working(self) -> bool {
        !matches!(self, Self::Idle)
    }
}

/// A live subagent card. Ports the Electron `SubagentCard`.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SubagentCard {
    pub id: String,
    pub subagent_type: String,
    pub description: String,
    pub model: String,
    pub summary: String,
    pub live_text: String,
    pub done: bool,
    pub is_error: bool,
}

/// Todo row. Ports the todo dock.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TodoItem {
    pub text: String,
    pub done: bool,
}

/// Changed-file row. Ports the diff/revert panel state.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: FileStatus,
    pub additions: u64,
    pub deletions: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum FileStatus {
    #[default]
    Modified,
    Created,
    Deleted,
}

impl FileStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Modified => "Modified",
            Self::Created => "Created",
            Self::Deleted => "Deleted",
        }
    }
}

/// One conversation with its live turn state. Ports the Electron
/// `ChatSession` plus `AgentState`: transcript, conversation, approvals,
/// spend, todos, changed files and subagents all belong to a session.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub space: SessionSpace,
    pub updated_at: i64,
    #[serde(default)]
    pub project_dir: String,
    pub conversation: Vec<Message>,
    pub entries: Vec<Entry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<TodoItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<ChangedFile>,
    #[serde(skip)]
    pub state: RunState,
    #[serde(skip)]
    pub streaming_text: String,
    #[serde(skip)]
    pub reasoning_text: String,
    #[serde(skip)]
    pub approvals: Vec<ApprovalRequest>,
    #[serde(skip)]
    pub subagents: Vec<SubagentCard>,
    #[serde(skip)]
    pub spend_usd: f64,
    #[serde(skip)]
    pub spend_estimated: bool,
    #[serde(skip)]
    pub has_unpriced: bool,
    #[serde(skip)]
    pub cache_read_tokens: u32,
    #[serde(skip)]
    pub cache_write_tokens: u32,
    #[serde(skip)]
    pub prompt_tokens: u32,
    #[serde(skip)]
    pub context_tokens: u32,
    #[serde(skip)]
    pub retry: Option<(u32, u32)>,
    #[serde(skip)]
    pub turn_started: Option<i64>,
    #[serde(skip)]
    pub turn_seconds: u64,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            id: new_id(),
            title: "New chat".to_owned(),
            space: SessionSpace::Home,
            updated_at: now_stamp(),
            project_dir: String::new(),
            conversation: Vec::new(),
            entries: Vec::new(),
            todos: Vec::new(),
            files: Vec::new(),
            state: RunState::Idle,
            streaming_text: String::new(),
            reasoning_text: String::new(),
            approvals: Vec::new(),
            subagents: Vec::new(),
            spend_usd: 0.0,
            spend_estimated: false,
            has_unpriced: false,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            prompt_tokens: 0,
            context_tokens: 0,
            retry: None,
            turn_started: None,
            turn_seconds: 0,
        }
    }
}

impl Session {
    pub fn new(space: SessionSpace) -> Self {
        Self {
            space,
            ..Default::default()
        }
    }

    /// Pushes a user turn: bubble plus the core conversation message.
    pub fn push_user(&mut self, display: &str, prompt: &str) {
        self.entries.push(Entry::user(display));
        self.conversation.push(Message::user(prompt));
        self.title = title_of(display);
        self.updated_at = now_stamp();
    }

    /// Appends streamed assistant text, folding it into the last assistant row.
    pub fn append_stream(&mut self, text: &str) {
        self.streaming_text.push_str(text);
        match self.entries.last_mut() {
            Some(entry) if entry.kind == EntryKind::Assistant => entry.text.push_str(text),
            _ => self.entries.push(Entry::assistant(text)),
        }
    }

    /// Appends streamed reasoning, folding it into the last thinking row.
    pub fn append_reasoning(&mut self, text: &str) {
        self.reasoning_text.push_str(text);
        match self.entries.last_mut() {
            Some(entry) if entry.kind == EntryKind::Thinking => entry.text.push_str(text),
            _ => self.entries.push(Entry::new(EntryKind::Thinking, text)),
        }
    }

    /// Records one tool call's start (or replaces an existing row for it).
    pub fn start_tool(&mut self, call_id: &str, name: &str) {
        let entry = Entry::tool(call_id, name, String::new());
        match self
            .entries
            .iter_mut()
            .find(|row| row.tool_id.as_deref() == Some(call_id))
        {
            Some(existing) => {
                existing.tool_name = Some(name.to_owned());
            }
            None => self.entries.push(entry),
        }
        self.state = RunState::Executing;
    }

    /// Appends live output to a running tool row.
    pub fn tool_progress(&mut self, call_id: &str, chunk: &str) {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|row| row.tool_id.as_deref() == Some(call_id))
        {
            entry.text.push_str(chunk);
        }
    }

    /// Marks a tool row finished.
    pub fn finish_tool(&mut self, call_id: &str, name: &str, result: &str, is_error: bool) {
        match self
            .entries
            .iter_mut()
            .find(|row| row.tool_id.as_deref() == Some(call_id))
        {
            Some(entry) => {
                entry.text = result.to_owned();
                entry.is_error = is_error;
                entry.tool_name = Some(name.to_owned());
            }
            None => {
                let mut entry = Entry::tool(call_id, name, result);
                entry.is_error = is_error;
                self.entries.push(entry);
            }
        }
    }

    /// Commits the streaming buffers so the next delta starts a fresh row.
    pub fn seal_stream(&mut self) {
        if !self.streaming_text.trim().is_empty() {
            if let Some(entry) = self.entries.last_mut() {
                if entry.kind == EntryKind::Assistant {
                    entry.text = self.streaming_text.trim().to_owned();
                }
            }
        }
        self.streaming_text.clear();
        self.reasoning_text.clear();
    }

    /// Opens a turn: the collapsed `⌄ N steps` header Electron shows.
    pub fn begin_turn(&mut self) {
        self.entries.push(Entry::new(EntryKind::TurnHeader, "0 steps"));
        self.turn_started = Some(chrono::Utc::now().timestamp());
        self.state = RunState::Streaming;
    }

    /// Updates the open turn header's step count.
    pub fn count_steps(&mut self) {
        let steps = self
            .entries
            .iter()
            .filter(|entry| entry.kind == EntryKind::Step)
            .count();
        if let Some(header) = self
            .entries
            .iter_mut()
            .rev()
            .find(|entry| entry.kind == EntryKind::TurnHeader)
        {
            header.text = if steps == 1 {
                "1 step".to_owned()
            } else {
                format!("{steps} steps")
            };
            header.depth = steps.min(255) as u8;
        }
    }

    /// Records the turn footer ("Worked for Ns") and returns to idle.
    pub fn finish_turn(&mut self) {
        self.seal_stream();
        if let Some(start) = self.turn_started.take() {
            let seconds = (now_stamp() - start).max(0) as u64;
            self.turn_seconds = seconds;
            if seconds > 0 {
                let mut footer = Entry::new(EntryKind::Footer, format!("Worked for {seconds}s"));
                footer.seconds = seconds;
                self.entries.push(footer);
            }
        }
        self.state = RunState::Idle;
        self.approvals.clear();
        self.retry = None;
        self.updated_at = now_stamp();
    }

    /// Cost label for the status row, honest about estimates.
    pub fn spend_label(&self) -> String {
        if self.spend_usd == 0.0 {
            return if self.has_unpriced {
                "unpriced".to_owned()
            } else {
                "free".to_owned()
            };
        }
        let prefix = if self.spend_estimated { "~$" } else { "$" };
        let suffix = if self.has_unpriced { "+" } else { "" };
        if self.spend_usd < 0.001 {
            return format!("{prefix}<0.001{suffix}");
        }
        format!("{prefix}{:.3}{suffix}", self.spend_usd)
    }

    /// Cache-hit rate, hidden until the provider reports cache fields.
    pub fn cache_label(&self) -> Option<String> {
        let reusable = self.cache_read_tokens + self.cache_write_tokens;
        if reusable == 0 {
            return None;
        }
        let prompt = self.prompt_tokens + reusable;
        if prompt == 0 {
            return None;
        }
        let percent = (self.cache_read_tokens as f64 / prompt as f64 * 100.0).floor();
        Some(format!("{percent:.0}% cached"))
    }
}

/// One date group in the session list.
#[derive(Clone, Debug)]
pub struct ChatGroup {
    pub label: String,
    pub ids: Vec<String>,
}

fn group_label(days: i64) -> &'static str {
    if days <= 0 {
        "Today"
    } else if days == 1 {
        "Yesterday"
    } else if days <= 6 {
        "Previous 7 days"
    } else if days <= 29 {
        "Previous 30 days"
    } else {
        "Older"
    }
}

/// Every open session plus the active one and the composer draft.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ChatState {
    pub sessions: Vec<Session>,
    pub active_id: Option<String>,
    #[serde(skip)]
    pub draft: String,
    /// Messages typed while a turn ran; they are handed to the live turn.
    #[serde(skip)]
    pub queue: Vec<String>,
    /// Files attached to the next send (paths already stored by the core).
    #[serde(skip)]
    pub attachments: Vec<agente_protocol::Attachment>,
    /// The mention or slash completion currently open, if any.
    #[serde(skip)]
    pub completion: Option<Completion>,
}

/// A completion popup above the composer: slash commands or @file mentions.
#[derive(Clone, Debug)]
pub struct Completion {
    pub kind: CompletionKind,
    pub query: String,
    pub index: usize,
    pub items: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CompletionKind {
    Slash,
    Mention,
}

impl Completion {
    pub fn slash(query: &str) -> Self {
        let items = crate::app::commands::filtered(query)
            .iter()
            .map(|command| format!("/{}  {}", command.slash, command.title))
            .collect();
        Self {
            kind: CompletionKind::Slash,
            query: query.to_owned(),
            index: 0,
            items,
        }
    }

    pub fn mention(query: &str, files: &[String]) -> Self {
        let needle = query.to_lowercase();
        let items: Vec<String> = files
            .iter()
            .filter(|path| needle.is_empty() || path.to_lowercase().contains(&needle))
            .take(40)
            .cloned()
            .collect();
        Self {
            kind: CompletionKind::Mention,
            query: query.to_owned(),
            index: 0,
            items,
        }
    }
}

impl ChatState {
    pub fn active(&self) -> Option<&Session> {
        self.active_id
            .as_ref()
            .and_then(|id| self.sessions.iter().find(|session| &session.id == id))
    }

    pub fn active_mut(&mut self) -> Option<&mut Session> {
        let id = self.active_id.clone()?;
        self.sessions.iter_mut().find(|session| session.id == id)
    }

    pub fn by_id_mut(&mut self, id: &str) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|session| session.id == id)
    }

    /// A fresh session is created when the active one belongs elsewhere.
    pub fn ensure_session(&mut self, space: SessionSpace) {
        let belongs = self.active().is_some_and(|s| s.space == space);
        if belongs {
            return;
        }
        if let Some(existing) = self
            .sessions
            .iter()
            .find(|s| s.space == space && s.conversation.is_empty())
        {
            self.active_id = Some(existing.id.clone());
            return;
        }
        self.new_session(space);
    }

    pub fn new_session(&mut self, space: SessionSpace) -> String {
        let session = Session::new(space);
        let id = session.id.clone();
        self.active_id = Some(id.clone());
        self.sessions.push(session);
        id
    }

    pub fn select(&mut self, id: &str) {
        if self.sessions.iter().any(|s| s.id == id) {
            self.active_id = Some(id.to_owned());
        }
    }

    pub fn sessions_in(&self, space: SessionSpace) -> Vec<&Session> {
        let mut sessions: Vec<&Session> = self
            .sessions
            .iter()
            .filter(|s| s.space == space && !s.entries.is_empty())
            .collect();
        sessions.sort_by_key(|s| -s.updated_at);
        sessions
    }

    /// Date-grouped session ids, newest group first.
    pub fn grouped(&self, space: SessionSpace) -> Vec<ChatGroup> {
        let today = chrono::Utc::now().date_naive();
        let mut buckets: Vec<(i64, Vec<String>)> = Vec::new();
        for session in self.sessions_in(space) {
            let day = chrono::DateTime::from_timestamp(session.updated_at, 0)
                .map(|dt| dt.date_naive())
                .unwrap_or(today);
            let days = (today - day).num_days().max(0);
            let bucket = if days <= 0 {
                0
            } else if days == 1 {
                1
            } else if days <= 6 {
                2
            } else if days <= 29 {
                3
            } else {
                4
            };
            match buckets.iter_mut().find(|(key, _)| *key == bucket) {
                Some((_, ids)) => ids.push(session.id.clone()),
                None => buckets.push((bucket, vec![session.id.clone()])),
            }
        }
        buckets.sort_by_key(|(key, _)| *key);
        buckets
            .into_iter()
            .map(|(key, ids)| ChatGroup {
                label: group_label(key).to_owned(),
                ids,
            })
            .collect()
    }

    pub fn title_of(&self, id: &str) -> String {
        self.sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.title.clone())
            .unwrap_or_default()
    }

    /// Removes a transcript row. A user turn also truncates the conversation
    /// there, so a retry re-runs from a clean state.
    pub fn delete_entry(&mut self, session_id: &str, index: usize) -> bool {
        let Some(session) = self.by_id_mut(session_id) else {
            return false;
        };
        if index >= session.entries.len() {
            return false;
        }
        let entry = session.entries.remove(index);
        if entry.kind == EntryKind::User {
            if let Some(position) = session
                .conversation
                .iter()
                .position(|message| message.role == Role::User && message.content == entry.text)
            {
                session.conversation.truncate(position);
            }
        }
        true
    }

    /// True while any session has a turn in flight.
    pub fn any_running(&self) -> bool {
        self.sessions.iter().any(|s| s.state.working())
    }
}

/// One project folder in the code sidebar.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ProjectItem {
    pub root: String,
    pub title: String,
}

/// Code workspace. Ports the code surface: projects, the session that runs
/// the workspace turns, approvals, diffs and todos.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CodeState {
    pub projects: Vec<ProjectItem>,
    pub active_project: Option<usize>,
    pub project_dir: String,
    pub mode: AgentMode,
    pub auto_approve: bool,
    pub run: Session,
    #[serde(skip)]
    pub composer: String,
    #[serde(skip)]
    pub new_todo: String,
}

impl Default for CodeState {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            active_project: None,
            project_dir: String::new(),
            mode: AgentMode::Plan,
            auto_approve: false,
            run: Session::new(SessionSpace::Code),
            composer: String::new(),
            new_todo: String::new(),
        }
    }
}

impl CodeState {
    pub fn add_project(&mut self) {
        let index = self.projects.len() + 1;
        let root = if self.project_dir.trim().is_empty() {
            format!("Project {index}")
        } else {
            self.project_dir.trim().to_owned()
        };
        self.projects.push(ProjectItem {
            title: root.clone(),
            root,
        });
        self.active_project = Some(self.projects.len() - 1);
    }

    pub fn select_project(&mut self, index: usize) {
        if index < self.projects.len() {
            self.active_project = Some(index);
        }
    }

    pub fn toggle_mode(&mut self) {
        self.mode = self.mode.toggle();
    }

    pub fn toggle_auto_approve(&mut self) {
        self.auto_approve = !self.auto_approve;
    }

    /// The folder this workspace runs in: the project root or the process cwd.
    pub fn effective_dir(&self) -> String {
        if !self.project_dir.trim().is_empty() {
            return self.project_dir.trim().to_owned();
        }
        if let Some(project) = self
            .active_project
            .and_then(|index| self.projects.get(index))
        {
            return project.root.clone();
        }
        std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".to_owned())
    }

    pub fn add_todo(&mut self) {
        let text = std::mem::take(&mut self.new_todo);
        let text = text.trim().to_owned();
        if !text.is_empty() {
            self.run.todos.push(TodoItem { text, done: false });
        }
    }

    /// Drops a changed-file row; returns the path it described.
    pub fn forget_file(&mut self, index: usize) -> Option<String> {
        if index < self.run.files.len() {
            return Some(self.run.files.remove(index).path);
        }
        None
    }

    /// Drops every changed-file row and returns their paths.
    pub fn forget_all_files(&mut self) -> Vec<String> {
        self.run.files.drain(..).map(|file| file.path).collect()
    }
}

/// Artifact registry row. Ports the artifact library + studio state.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ArtifactItem {
    pub name: String,
    pub kind: String,
    pub summary: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ArtifactState {
    pub items: Vec<ArtifactItem>,
    pub selected: Option<usize>,
    #[serde(skip)]
    pub filter: String,
    #[serde(skip)]
    pub new_name: String,
}

impl ArtifactState {
    pub fn visible(&self) -> Vec<(usize, &ArtifactItem)> {
        let needle = self.filter.to_lowercase();
        self.items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                needle.is_empty()
                    || item.name.to_lowercase().contains(&needle)
                    || item.kind.to_lowercase().contains(&needle)
            })
            .collect()
    }

    pub fn select(&mut self, index: usize) {
        self.selected = Some(index);
    }

    pub fn add(&mut self) {
        let name = std::mem::take(&mut self.new_name);
        let name = name.trim().to_owned();
        if name.is_empty() {
            return;
        }
        self.items.push(ArtifactItem {
            name,
            kind: "note".to_owned(),
            summary: "Draft artifact".to_owned(),
        });
    }

    pub fn remove_selected(&mut self) {
        if let Some(index) = self.selected.take() {
            if index < self.items.len() {
                self.items.remove(index);
            }
        }
    }
}

/// Bot roster row. Ports the bots screen state.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BotItem {
    pub name: String,
    pub model: String,
    pub status: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct BotState {
    pub bots: Vec<BotItem>,
    pub selected: Option<usize>,
    #[serde(skip)]
    pub new_name: String,
    #[serde(skip)]
    pub query: String,
}

impl BotState {
    pub fn visible(&self) -> Vec<(usize, &BotItem)> {
        let needle = self.query.to_lowercase();
        self.bots
            .iter()
            .enumerate()
            .filter(|(_, bot)| needle.is_empty() || bot.name.to_lowercase().contains(&needle))
            .collect()
    }

    pub fn select(&mut self, index: usize) {
        self.selected = Some(index);
    }

    pub fn add(&mut self) {
        let name = std::mem::take(&mut self.new_name);
        let name = name.trim().to_owned();
        if name.is_empty() {
            return;
        }
        self.bots.push(BotItem {
            name,
            model: "default".to_owned(),
            status: "idle".to_owned(),
        });
    }

    pub fn remove_selected(&mut self) {
        if let Some(index) = self.selected.take() {
            if index < self.bots.len() {
                self.bots.remove(index);
            }
        }
    }
}

/// Roleplay cast row. Ports characters + cast state.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CharacterItem {
    pub name: String,
    pub persona: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RoleplayState {
    pub characters: Vec<CharacterItem>,
    pub active: Option<usize>,
    #[serde(skip)]
    pub new_name: String,
}

impl RoleplayState {
    pub fn set_active(&mut self, index: usize) {
        self.active = Some(index);
    }

    pub fn add(&mut self) {
        let name = std::mem::take(&mut self.new_name);
        let name = name.trim().to_owned();
        if name.is_empty() {
            return;
        }
        self.characters.push(CharacterItem {
            name,
            persona: "New persona".to_owned(),
        });
    }
}

/// Canvas board. Ports the canvas doc + handoff state.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct CanvasState {
    pub title: String,
    pub notes: String,
    #[serde(skip)]
    pub open: bool,
    #[serde(skip)]
    pub loaded_for: Option<String>,
}

impl CanvasState {
    /// Boards are per conversation, like the Electron canvas annotating the
    /// open chat: the file name carries the session id.
    pub fn load_for(&mut self, session_id: &str) {
        if self.loaded_for.as_deref() == Some(session_id) {
            return;
        }
        self.notes = crate::backend::read_text(&format!("canvas-{session_id}.md"));
        self.loaded_for = Some(session_id.to_owned());
    }

    pub fn save_for(&self, session_id: &str) {
        crate::backend::write_text(&format!("canvas-{session_id}.md"), &self.notes);
    }

    pub fn clear(&mut self) {
        self.notes.clear();
    }

    pub fn toggle(&mut self) {
        self.open = !self.open;
    }
}

/// Landing state: hero dismissal, home view, composer loop.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct HomeState {
    pub hero_dismissed: bool,
    pub view: HomeView,
    pub composer_mode: ComposerMode,
}

impl HomeState {
    pub fn dismiss_hero(&mut self) {
        self.hero_dismissed = true;
    }

    pub fn show_artifacts(&mut self) {
        self.view = HomeView::Artifacts;
    }

    pub fn show_chat(&mut self) {
        self.view = HomeView::Chat;
    }

    pub fn toggle_composer_mode(&mut self) {
        self.composer_mode = self.composer_mode.toggle();
    }
}

/// Search drawer. Ports the search sidebar state.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct SearchState {
    pub query: String,
    pub searched: bool,
    pub deep_research: bool,
    #[serde(skip)]
    pub open: bool,
}

impl SearchState {
    pub fn submit(&mut self) {
        self.searched = !self.query.trim().is_empty();
    }

    pub fn toggle_deep_research(&mut self) {
        self.deep_research = !self.deep_research;
    }

    pub fn toggle(&mut self) {
        self.open = !self.open;
    }
}

/// Browser dock panel. Ports the browser panel store.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct BrowserPanelState {
    pub url: String,
    pub notes: String,
    #[serde(skip)]
    pub open: bool,
}

impl BrowserPanelState {
    pub fn clear(&mut self) {
        self.url.clear();
        self.notes.clear();
    }

    pub fn toggle(&mut self) {
        self.open = !self.open;
    }
}

/// One download row. Ports the downloads store.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DownloadItem {
    pub name: String,
    pub detail: String,
}

/// Downloads popover state. The titlebar button owns it.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct DownloadState {
    pub items: Vec<DownloadItem>,
    #[serde(skip)]
    pub open: bool,
}

impl DownloadState {
    pub fn toggle(&mut self) {
        self.open = !self.open;
    }
}

/// Onboarding wizard. Ports the onboarding steps.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct OnboardingState {
    pub step: usize,
    pub done: bool,
}

impl OnboardingState {
    pub const STEPS: &[&str] = &["Welcome", "Model", "Runtime", "Ready"];

    pub fn next(&mut self) {
        if self.step + 1 < Self::STEPS.len() {
            self.step += 1;
        } else {
            self.done = true;
        }
    }

    pub fn back(&mut self) {
        self.step = self.step.saturating_sub(1);
    }

    pub fn finish(&mut self) {
        self.done = true;
    }
}

/// One toast row. Ports `toast.svelte.ts`: a kind, a message and an age.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Toast {
    pub kind: ToastKind,
    pub text: String,
    pub at: i64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub enum ToastKind {
    Info,
    Success,
    Error,
}

impl Toast {
    pub fn info(text: impl Into<String>) -> Self {
        Self {
            kind: ToastKind::Info,
            text: text.into(),
            at: chrono::Utc::now().timestamp(),
        }
    }

    pub fn success(text: impl Into<String>) -> Self {
        Self {
            kind: ToastKind::Success,
            text: text.into(),
            at: chrono::Utc::now().timestamp(),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            kind: ToastKind::Error,
            text: text.into(),
            at: chrono::Utc::now().timestamp(),
        }
    }

    /// Toasts fade after a few seconds, like the Electron stack.
    pub fn expired(&self) -> bool {
        chrono::Utc::now().timestamp() - self.at > 6
    }
}

/// The settings sections, in the order the Electron rail lists them.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum SettingsSection {
    #[default]
    General,
    Search,
    Artifacts,
    ThisComputer,
    Voice,
    Accessibility,
    /// One provider's own page, keyed by its id.
    Provider,
}

impl SettingsSection {
    pub const ALL: &[Self] = &[
        Self::General,
        Self::Search,
        Self::Artifacts,
        Self::ThisComputer,
        Self::Voice,
        Self::Accessibility,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::General => "General",
            Self::Search => "Web search",
            Self::Artifacts => "Artifacts",
            Self::ThisComputer => "On this computer",
            Self::Voice => "Voice",
            Self::Accessibility => "Accessibility",
            Self::Provider => "Provider",
        }
    }

    pub fn blurb(self) -> &'static str {
        match self {
            Self::General => "Your name, the language and how chats behave.",
            Self::Search => "How the agent searches the web and which sources it trusts.",
            Self::Artifacts => "Which artifact types the studio may build and preview.",
            Self::ThisComputer => "Local runtimes, downloaded models and what is loaded.",
            Self::Voice => "Dictation, playback and the voice used for replies.",
            Self::Accessibility => "Text size, contrast and motion.",
            Self::Provider => "Endpoint, key and models for this provider.",
        }
    }
}

/// Settings screen chrome (the values live in the core `AppConfig`).
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct SettingsUiState {
    pub show_advanced: bool,
    pub section: SettingsSection,
    #[serde(skip)]
    pub filter: String,
    #[serde(skip)]
    pub provider: String,
    #[serde(skip)]
    pub key_draft: String,
    #[serde(skip)]
    pub name: String,
    #[serde(skip)]
    pub language: String,
    #[serde(skip)]
    pub show_assistant_text: bool,
    #[serde(skip)]
    pub thinking_enabled: bool,
    #[serde(skip)]
    pub roleplay_enabled: bool,
    #[serde(skip)]
    pub search_provider: String,
    #[serde(skip)]
    pub deep_research_default: bool,
    #[serde(skip)]
    pub contrast: bool,
    #[serde(skip)]
    pub reading_font: String,
}

impl SettingsUiState {
    pub fn toggle_advanced(&mut self) {
        self.show_advanced = !self.show_advanced;
    }
}
