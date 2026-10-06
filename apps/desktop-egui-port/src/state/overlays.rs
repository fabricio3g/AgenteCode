//! Overlay and dialog state: the command palette, confirms, the chat search,
//! the session picker, inline message editing, the plan review card, the
//! process view, the terminal, the artifact studio, the bot editor, the
//! roleplay editors, the local runtime panel and voice.
//!
//! Ports the Electron modals and drawers (`components/ui/Dialog.svelte`,
//! `ChatSearchModal`, `ConfirmDialog`, `ArtifactStudioModal`,
//! `BotEditor`, `CharacterEditorModal`, `LocalModelLoadModal`, `LLMDrawer`).

use crate::state::{ChangedFile, Entry, SubagentCard};

/// Which confirm dialog is open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfirmAction {
    DeleteSession(String),
    DeleteMessage(String, usize),
    ClearSession(String),
    RevertFile(String),
    RevertAll,
    DeleteArtifact(usize),
    DeleteBot(usize),
    CloseProject(usize),
}

/// A blocking question with a danger flag, like `ConfirmDialog.svelte`.
#[derive(Clone, Debug)]
pub struct ConfirmState {
    pub title: String,
    pub body: String,
    pub confirm_label: String,
    pub danger: bool,
    pub action: ConfirmAction,
}

impl ConfirmState {
    pub fn delete_session(title: &str, id: &str) -> Self {
        Self {
            title: "Delete this conversation?".to_owned(),
            body: format!("“{title}” and its transcript are removed. This cannot be undone."),
            confirm_label: "Delete".to_owned(),
            danger: true,
            action: ConfirmAction::DeleteSession(id.to_owned()),
        }
    }

    pub fn delete_message(session: &str, index: usize) -> Self {
        Self {
            title: "Delete this message?".to_owned(),
            body: "The row leaves the transcript; anything after a prompt is dropped from the model's context too."
                .to_owned(),
            confirm_label: "Delete".to_owned(),
            danger: true,
            action: ConfirmAction::DeleteMessage(session.to_owned(), index),
        }
    }

    pub fn clear_session(id: &str) -> Self {
        Self {
            title: "Clear this conversation?".to_owned(),
            body: "The transcript and the model's context are emptied; the session stays."
                .to_owned(),
            confirm_label: "Clear".to_owned(),
            danger: true,
            action: ConfirmAction::ClearSession(id.to_owned()),
        }
    }
}

/// One command row in the palette.
#[derive(Clone, Debug)]
pub struct CommandRow {
    pub id: &'static str,
    pub title: String,
    pub hint: &'static str,
}

/// What the palette is picking: an action, or a model for this session.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum PaletteMode {
    #[default]
    Commands,
    Models,
}

/// The command palette (Ctrl+P) and the model picker (`/model`).
#[derive(Clone, Debug, Default)]
pub struct PaletteState {
    pub query: String,
    pub index: usize,
    pub mode: PaletteMode,
    pub title: String,
}

/// One chat-search hit.
#[derive(Clone, Debug)]
pub struct SearchHit {
    pub session_id: String,
    pub session_title: String,
    pub entry_index: usize,
    pub snippet: String,
}

/// Full-text search across every session (Ctrl+Shift+K).
#[derive(Clone, Debug, Default)]
pub struct ChatSearchState {
    pub query: String,
    pub index: usize,
    pub hits: Vec<SearchHit>,
}

/// The session picker (Ctrl+S / bare `--resume`), like the TUI's picker.
#[derive(Clone, Debug, Default)]
pub struct SessionPickerState {
    pub query: String,
    pub index: usize,
}

/// Inline message editing, like `EditMessageInline.svelte`.
#[derive(Clone, Debug)]
pub struct EditMessageState {
    pub session_id: String,
    pub index: usize,
    pub text: String,
}

/// The plan review card: Accept / Redo / Comment, like `PlanPanel.svelte`.
#[derive(Clone, Debug)]
pub struct PlanReviewState {
    pub path: String,
    pub title: String,
    pub markdown: String,
    pub comment: String,
    pub asking: bool,
}

impl PlanReviewState {
    pub fn load(path: String, markdown: String) -> Self {
        let title = markdown
            .lines()
            .find(|line| line.starts_with("# "))
            .map(|line| line.trim_start_matches("# ").trim().to_owned())
            .unwrap_or_else(|| {
                path.rsplit('/')
                    .next()
                    .unwrap_or("Plan")
                    .trim_end_matches(".md")
                    .to_owned()
            });
        Self {
            path,
            title,
            markdown,
            comment: String::new(),
            asking: false,
        }
    }
}

/// The live output view for a background process (`widgets/process_view`).
#[derive(Clone, Debug, Default)]
pub struct ProcessViewState {
    pub id: String,
    pub content: String,
    pub follow: bool,
    pub stopped: bool,
}

/// The embedded terminal: a line runner over the shell tool.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TerminalState {
    pub cwd: String,
    pub input: String,
    pub lines: Vec<TerminalLine>,
    pub running: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TerminalLine {
    pub command: bool,
    pub text: String,
    pub is_error: bool,
}

impl TerminalState {
    pub fn new(cwd: String) -> Self {
        Self {
            cwd,
            input: String::new(),
            lines: vec![TerminalLine {
                command: false,
                text: "Commands run through the same shell tool the agent uses.".to_owned(),
                is_error: false,
            }],
            running: false,
        }
    }
}

/// The artifact studio: file rail, source editor and preview.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct StudioState {
    pub artifact: usize,
    pub files: Vec<StudioFile>,
    pub selected: usize,
    pub draft: String,
    pub dirty: bool,
    pub preview: bool,
    pub running: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct StudioFile {
    pub name: String,
    pub content: String,
    pub language: String,
}

impl StudioState {
    pub fn new(artifact: usize, files: Vec<StudioFile>) -> Self {
        let draft = files.first().map(|file| file.content.clone()).unwrap_or_default();
        Self {
            artifact,
            files,
            selected: 0,
            draft,
            dirty: false,
            preview: false,
            running: false,
        }
    }

    pub fn select(&mut self, index: usize) {
        if index < self.files.len() {
            self.selected = index;
            self.draft = self.files[index].content.clone();
            self.dirty = false;
        }
    }

    pub fn save(&mut self) {
        if let Some(file) = self.files.get_mut(self.selected) {
            file.content = self.draft.clone();
            self.dirty = false;
        }
    }

    pub fn add_file(&mut self, name: &str) {
        let language = language_of(name);
        self.files.push(StudioFile {
            name: name.to_owned(),
            content: String::new(),
            language,
        });
        self.select(self.files.len() - 1);
    }

    pub fn remove_selected(&mut self) {
        if self.files.len() > 1 && self.selected < self.files.len() {
            self.files.remove(self.selected);
            self.select(self.selected.min(self.files.len() - 1));
        }
    }
}

fn language_of(name: &str) -> String {
    match name.rsplit('.').next().unwrap_or("") {
        "rs" => "rust",
        "ts" => "typescript",
        "js" => "javascript",
        "html" => "html",
        "css" => "css",
        "json" => "json",
        "md" => "markdown",
        "py" => "python",
        "toml" => "toml",
        other => other,
    }
    .to_owned()
}

/// The bot editor: identity, model, tools, sandbox and Telegram.
#[derive(Clone, Debug, Default)]
pub struct BotEditorState {
    pub index: Option<usize>,
    pub name: String,
    pub handle: String,
    pub model: String,
    pub instructions: String,
    pub telegram_token: String,
    pub telegram_chat: String,
    pub sandbox_network: bool,
    pub sandbox_write: String,
    pub daily_budget: String,
}

impl BotEditorState {
    pub fn new_bot() -> Self {
        Self {
            name: "New bot".to_owned(),
            handle: "new-bot".to_owned(),
            daily_budget: "5.00".to_owned(),
            ..Default::default()
        }
    }

    pub fn from_item(index: usize, name: &str, model: &str) -> Self {
        Self {
            index: Some(index),
            name: name.to_owned(),
            handle: name.to_lowercase().replace(' ', "-"),
            model: model.to_owned(),
            daily_budget: "5.00".to_owned(),
            ..Default::default()
        }
    }
}

/// One routine row: a cron expression plus the prompt it runs.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Routine {
    pub schedule: String,
    pub prompt: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RoutineEditorState {
    pub routines: Vec<Routine>,
    pub draft_schedule: String,
    pub draft_prompt: String,
}

impl RoutineEditorState {
    pub fn add(&mut self) {
        let schedule = std::mem::take(&mut self.draft_schedule);
        let prompt = std::mem::take(&mut self.draft_prompt);
        if schedule.trim().is_empty() || prompt.trim().is_empty() {
            return;
        }
        self.routines.push(Routine {
            schedule: schedule.trim().to_owned(),
            prompt: prompt.trim().to_owned(),
            enabled: true,
        });
    }
}

/// Telegram pairing state for one bot.
#[derive(Clone, Debug, Default)]
pub struct TelegramState {
    pub paired: Vec<String>,
    pub pair_code: String,
    pub status: String,
}

/// The character editor: card fields plus the greeting.
#[derive(Clone, Debug)]
pub struct CharacterEditorState {
    pub index: Option<usize>,
    pub name: String,
    pub nickname: String,
    pub persona: String,
    pub greeting: String,
    pub scenario: String,
    pub example_dialogue: String,
}

impl CharacterEditorState {
    pub fn new_character() -> Self {
        Self {
            index: None,
            name: "New character".to_owned(),
            nickname: String::new(),
            persona: String::new(),
            greeting: String::new(),
            scenario: String::new(),
            example_dialogue: String::new(),
        }
    }

    pub fn from_item(index: usize, name: &str, persona: &str) -> Self {
        Self {
            index: Some(index),
            name: name.to_owned(),
            nickname: String::new(),
            persona: persona.to_owned(),
            greeting: String::new(),
            scenario: String::new(),
            example_dialogue: String::new(),
        }
    }
}

/// One lorebook entry: keys that trigger it, and the text it injects.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct LoreEntry {
    pub keys: String,
    pub content: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct LorebookState {
    pub entries: Vec<LoreEntry>,
    pub draft_keys: String,
    pub draft_content: String,
}

impl LorebookState {
    pub fn add(&mut self) {
        let keys = std::mem::take(&mut self.draft_keys);
        let content = std::mem::take(&mut self.draft_content);
        if keys.trim().is_empty() || content.trim().is_empty() {
            return;
        }
        self.entries.push(LoreEntry {
            keys: keys.trim().to_owned(),
            content: content.trim().to_owned(),
            enabled: true,
        });
    }
}

/// The prompt inspector: what the model actually receives.
#[derive(Clone, Debug, Default)]
pub struct PromptInspectorState {
    pub system: String,
    pub messages: String,
    pub tokens: u32,
}

/// The local runtime panel: hardware, downloaded models, load state.
#[derive(Clone, Debug, Default)]
pub struct RuntimePanelState {
    pub hardware: String,
    pub models: Vec<RuntimeModel>,
    pub loaded: Option<String>,
    pub note: String,
}

#[derive(Clone, Debug)]
pub struct RuntimeModel {
    pub name: String,
    pub path: String,
    pub size: String,
}

/// Voice: dictation and playback state, ported from the Electron stores.
#[derive(Clone, Debug, Default)]
pub struct VoiceState {
    pub listening: bool,
    pub hands_free: bool,
    pub last_transcript: String,
    pub speaking: bool,
    pub voice: String,
}

/// Everything modal or docked that is not part of a space's own state.
#[derive(Clone, Debug, Default)]
pub struct Overlays {
    pub palette: Option<PaletteState>,
    pub confirm: Option<ConfirmState>,
    pub chat_search: Option<ChatSearchState>,
    pub session_picker: Option<SessionPickerState>,
    pub edit_message: Option<EditMessageState>,
    pub subagent_detail: Option<usize>,
    pub plan_review: Option<PlanReviewState>,
    pub process_view: Option<ProcessViewState>,
    pub terminal: Option<TerminalState>,
    pub studio: Option<StudioState>,
    pub bot_editor: Option<BotEditorState>,
    pub routines: Option<RoutineEditorState>,
    pub telegram: Option<TelegramState>,
    pub character_editor: Option<CharacterEditorState>,
    pub lorebook: Option<LorebookState>,
    pub prompt_inspector: Option<PromptInspectorState>,
    pub runtime: Option<RuntimePanelState>,
    pub voice: VoiceState,
    pub help: bool,
}

impl Overlays {
    /// True while a modal owns the keyboard, so the shell does not also act
    /// on the key. Ports `openModalLayerCount()`.
    pub fn modal_open(&self) -> bool {
        self.palette.is_some()
            || self.confirm.is_some()
            || self.chat_search.is_some()
            || self.session_picker.is_some()
            || self.edit_message.is_some()
            || self.studio.is_some()
            || self.bot_editor.is_some()
            || self.routines.is_some()
            || self.telegram.is_some()
            || self.character_editor.is_some()
            || self.lorebook.is_some()
            || self.prompt_inspector.is_some()
            || self.runtime.is_some()
            || self.help
    }

    pub fn close_all(&mut self) {
        self.palette = None;
        self.confirm = None;
        self.chat_search = None;
        self.session_picker = None;
        self.edit_message = None;
        self.studio = None;
        self.bot_editor = None;
        self.routines = None;
        self.telegram = None;
        self.character_editor = None;
        self.lorebook = None;
        self.prompt_inspector = None;
        self.runtime = None;
        self.help = false;
    }

    /// Esc closes the topmost modal, in the same order the dialogs stack:
    /// the shortcut sheet is painted last, the palette first.
    pub fn escape(&mut self) -> bool {
        if self.help {
            self.help = false;
            return true;
        }
        if self.edit_message.is_some() {
            self.edit_message = None;
            return true;
        }
        if self.confirm.is_some() {
            self.confirm = None;
            return true;
        }
        if self.chat_search.is_some() {
            self.chat_search = None;
            return true;
        }
        if self.session_picker.is_some() {
            self.session_picker = None;
            return true;
        }
        if self.palette.is_some() {
            self.palette = None;
            return true;
        }
        if self.studio.is_some() {
            self.studio = None;
            return true;
        }
        if self.bot_editor.is_some() {
            self.bot_editor = None;
            return true;
        }
        if self.routines.is_some() {
            self.routines = None;
            return true;
        }
        if self.telegram.is_some() {
            self.telegram = None;
            return true;
        }
        if self.character_editor.is_some() {
            self.character_editor = None;
            return true;
        }
        if self.lorebook.is_some() {
            self.lorebook = None;
            return true;
        }
        if self.prompt_inspector.is_some() {
            self.prompt_inspector = None;
            return true;
        }
        if self.runtime.is_some() {
            self.runtime = None;
            return true;
        }
        if self.subagent_detail.is_some() {
            self.subagent_detail = None;
            return true;
        }
        if self.process_view.is_some() {
            self.process_view = None;
            return true;
        }
        false
    }
}

/// The changed-files panel, kept out of `Session` because it is a view of
/// state the engine already reported.
pub fn file_status_line(file: &ChangedFile) -> String {
    format!(
        "{} · {} · +{} −{}",
        file.path,
        file.status.label(),
        file.additions,
        file.deletions
    )
}

/// A one-line preview of a transcript row, for the chat search results.
pub fn entry_preview(entry: &Entry) -> String {
    let flat: String = entry.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.len() > 90 {
        format!("{}…", flat.chars().take(90).collect::<String>())
    } else {
        flat
    }
}

/// A subagent's status mark, like the Electron `SubagentCard`.
pub fn subagent_mark(card: &SubagentCard) -> &'static str {
    if card.is_error {
        "!"
    } else if card.done {
        "✓"
    } else {
        "…"
    }
}
