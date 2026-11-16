//! Modular state management for the TUI application
//!
//! This module splits the monolithic AppState into focused sub-modules:
//! - `agent`: Agent runtime state (mode, streaming, approvals)
//! - `session`: Session data (chat history, conversation, files)
//! - `ui`: UI state (scrolling, dimensions, effects)
//! - `input`: User input state (text buffer, history, pickers)
//! - `config`: Configuration state (providers, models, connections)
//! - `picker`: Session picker state
//! - `todo`: Todo list state

mod agent;
pub mod anim;
mod chat_summary;
mod config;
mod hits;
mod input;
mod picker;
mod plan_review;
mod session;
mod tabs;
mod todo;
mod ui;

pub use session::diff_line_counts;

pub use agent::{
    format_usd, AgentRuntimeState, ApprovalQueue, ContextState, LiveToolCall, PendingApproval,
    QueuedMessage, RetryStatus, Spend, SubagentToolRow, SubagentUiState, WorkMode,
};
pub use config::{ConfigState, ConnectScreen, DiscoveryStatus, ModelEntry};
pub use hits::{HitMap, HitTarget, ListId};
pub use input::{paste_wants_chip, InputState, PastedBlock};
pub use picker::SessionPickerState;
pub use plan_review::{
    is_vague_feedback, synthesize_feedback, template_ask_questions, AskQuestion, PendingPlan,
    PlanAskState, PlanReviewPhase, PlanReviewState,
};
pub use session::SessionState;
pub use tabs::{tab_label, TabLabel, TabState, TabStatus, TabStrip};
pub use todo::TodoState;
pub use ui::{
    is_hover_target, ChatCacheKey, ChatFrameSnapshot, ChatPlainLine, ChatSelection, Fold,
    ProcessView, RenderedChatBlock, StreamMarkdownCache, SubagentDetailTab, UiState,
};

use agente_core::cancellation::AbortController;
use agente_core::permissions::shared_permission_engine_with_config;

/// Main application state - orchestrates all sub-states
///
/// This is the top-level state that combines all focused state modules.
/// Each module handles a specific domain of the application state.
///
/// For backward compatibility, fields are accessed directly as `state.field_name`
/// rather than through accessor methods.
pub struct AppState {
    /// Agent runtime state (mode, streaming, approvals)
    pub agent: AgentRuntimeState,

    /// Session state (chat history, conversation, files)
    pub session: SessionState,

    /// UI state (scrolling, dimensions, effects)
    pub ui: UiState,

    /// Input state (text buffer, history, pickers)
    pub input: InputState,

    /// Configuration state (providers, models, connections)
    pub config: ConfigState,

    /// Session picker state
    pub picker: SessionPickerState,

    /// Todo state
    pub todo: TodoState,

    /// Plan review card (Accept / Redo / Comment) + ask flow
    pub plan_review: PlanReviewState,

    /// Cancellation channel sender
    pub cancel_tx: AbortController,

    /// Shared subagent registry. Lives here so the TUI (status bar counter,
    /// `/subagents` kill) and the running agent loop (task/task_output/kill_task)
    /// observe the same set of children.
    pub subagent_registry: agente_core::subagent::SubagentRegistry,
}

/// Prefix marking a compaction notice in the transcript (rendered as a
/// divider by the chat widget).
pub const COMPACTION_MARK: &str = "⟲ ";

/// Transcript line for a compaction: `⟲ Context compacted · ~182k → ~64k ·
/// summarized` (or `trimmed`).
pub fn compaction_notice(before: usize, after: usize, smart: bool) -> String {
    use crate::widgets::hints::format_token_count as k;
    format!(
        // The loop's sizes are estimates (it decides before the request).
        "{COMPACTION_MARK}Context compacted · ~{} → ~{} · {}",
        k(before),
        k(after),
        if smart { "summarized" } else { "trimmed" }
    )
}

impl AppState {
    /// Create a new AppState with default values
    pub fn new(app_config: agente_core::config::AppConfig, project_dir: String) -> Self {
        #[cfg(test)]
        crate::test_support::sandbox_user_state();
        let cancel_tx = AbortController::new();
        let project_dir = agente_core::util::normalize_project_dir(project_dir);
        let work_mode = WorkMode::parse(app_config.default_mode.as_deref());
        let mode = work_mode.agent_mode();

        let mut agent = AgentRuntimeState {
            mode,
            auto_mode: work_mode == WorkMode::Auto,
            current_turn_mode: mode,
            shared_permission_engine: shared_permission_engine_with_config(
                mode,
                &app_config.auto_approve,
                &project_dir,
            ),
            ..AgentRuntimeState::default()
        };
        if let Some(level) = &app_config.default_thinking_level {
            if !level.is_empty() {
                agent.thinking_level = level.clone();
            }
        }
        let config = ConfigState::for_project(app_config, &project_dir);

        Self {
            agent,
            session: SessionState::new(project_dir.clone()),
            ui: UiState::default(),
            input: InputState::default(),
            config,
            picker: SessionPickerState::default(),
            todo: TodoState::default(),
            plan_review: PlanReviewState::default(),
            cancel_tx,
            subagent_registry: agente_core::subagent::SubagentRegistry::new(),
        }
    }

    // === Single session ===

    /// Whether the current session may be replaced right now (agent idle and
    /// no running subagents). Guards new-session, session-load, and
    /// project-switch paths.
    pub fn can_replace_session(&self) -> bool {
        self.agent.is_idle() && self.subagent_registry.running_count() == 0
    }

    /// Reset to a fresh session in the same project, preserving user-level
    /// choices (provider, model, mode, thinking level, input history).
    /// The caller flushes the outgoing session to disk first.
    pub fn reset_for_new_session(&mut self) {
        self.agent.abort_task();
        self.agent.state = agente_core::types::AgentState::Idle;
        self.agent.clear_stream_buffers();
        self.agent.clear_approvals();
        self.agent.message_queue.clear();
        self.agent.steering_queue.clear();
        self.agent.subagents.clear();
        self.agent.total_tokens = 0;
        self.agent.context_measured = false;
        self.agent.last_turn_prompt_tokens = 0;
        self.agent.last_turn_completion_tokens = 0;
        self.agent.last_turn_cache_read_tokens = 0;
        self.agent.last_turn_cache_creation_tokens = 0;
        self.agent.spend = Spend::default();
        self.agent.last_response_duration = None;

        self.session = SessionState::new(self.session.project_dir.clone());
        self.todo = TodoState::default();
        self.plan_review = PlanReviewState::default();
        self.subagent_registry = agente_core::subagent::SubagentRegistry::new();
        let input_history = std::mem::take(&mut self.input.input_history);
        self.input = InputState::default();
        self.input.input_history = input_history;
        self.input.input_history_index = self.input.input_history.len();
        self.picker = SessionPickerState::default();
        self.ui.reset_for_workspace();
    }

    /// The provider the model selector is currently browsing.
    ///
    /// The explicit scope when one is set, otherwise the active provider --
    /// what a refresh (Ctrl+R) and the "refreshing" badge should target.
    /// Reasoning-effort levels the resolved model reports, in ladder order.
    ///
    /// Empty when the model has no `reasoning_options` in models.dev, which the
    /// picker shows as an explanation rather than pushing a system message into
    /// the transcript.
    /// The core's thinking profile for the current model (empty when none).
    pub fn thinking_profile_for_current_model(&self) -> agente_core::thinking::ThinkingProfile {
        let provider = self.config.current_provider.clone();
        let model_id = self.config.current_model.clone();
        self.resolve_model(&provider, &model_id)
            .filter(|_| !model_id.is_empty())
            .map(|model| agente_core::thinking::profile(&model))
            .unwrap_or_else(|| {
                agente_core::thinking::profile(&agente_core::providers::fallback_model_info("", ""))
            })
    }

    pub fn thinking_levels_for_current_model(&self) -> Vec<String> {
        let provider = self.config.current_provider.clone();
        let model_id = self.config.current_model.clone();
        if model_id.is_empty() {
            return Vec::new();
        }
        match self.resolve_model(&provider, &model_id) {
            Some(model) => agente_core::thinking::supported_thinking_levels(&model),
            None => Vec::new(),
        }
    }

    /// Keep the active level valid after a TUI model/provider switch.
    pub fn clamp_thinking_level_for_current_model(&mut self) {
        let provider = self.config.current_provider.clone();
        let model_id = self.config.current_model.clone();
        if let Some(model) = self.resolve_model(&provider, &model_id) {
            self.agent.thinking_level =
                agente_core::thinking::clamp_thinking_level(&model, &self.agent.thinking_level);
        }
    }

    pub fn browsed_model_provider(&self) -> String {
        self.input
            .model_selector_provider
            .clone()
            .unwrap_or_else(|| self.config.current_provider.clone())
    }

    /// Human-readable provider label, for chips and headers.
    pub fn provider_display_name(&self, provider: &str) -> String {
        self.config.get_provider_display_name(provider)
    }

    // === Convenience methods ===

    /// Toggle the selected mode. While a turn is running, this only changes
    /// the mode for the next turn; the live permission engine stays pinned to
    /// `current_turn_mode` until the next turn starts.
    pub fn toggle_mode(&mut self) {
        let next = self.agent.work_mode().next();
        let idle = self.agent.is_idle();
        self.agent.select_work_mode(next, idle);
        self.config.config.default_mode = Some(next.label().to_string());
        // No immediate disk write: the mode is persisted on the next config
        // flush (model change, session save, quit), keeping this path pure
        // state and testable without touching the user's real config.
    }

    pub fn set_auto_approve(&mut self, auto_approve: bool) -> bool {
        if !self.agent.is_idle() && self.agent.approval_queue.is_empty() {
            return false;
        }
        self.agent.set_auto_approve(auto_approve);
        self.persist_config();
        true
    }

    /// Sync the TUI's current state into the on-disk AppConfig (workspace mirror + global).
    /// Best-effort: failures are logged, never propagated to the UI.
    pub fn persist_config(&mut self) {
        self.config.persist(&self.session.project_dir);
    }

    /// Apply a theme switch end to end: set the global theme and drop all
    /// theme-colored render caches. The per-entry cache key carries no theme
    /// component, so without the clear, stale rows with baked previous-theme
    /// colors — e.g. timestamp bars with explicit dark backgrounds — survive
    /// amid fresh ones. Every theme-switching path must route through here.
    pub fn apply_theme(&mut self, theme: crate::style::Theme) {
        crate::style::set_theme(theme);
        self.ui.clear_chat_render_cache();
    }

    /// Replace every project/session-owned state component as one transaction.
    /// The caller loads `app_config` before invoking this method, so the target
    /// workspace is never overwritten with the previous workspace's settings.
    pub fn reset_for_project(
        &mut self,
        project_dir: String,
        app_config: agente_core::config::AppConfig,
    ) {
        let project_dir = agente_core::util::normalize_project_dir(project_dir);
        let work_mode = WorkMode::parse(app_config.default_mode.as_deref());
        let mode = work_mode.agent_mode();
        let thinking_level = app_config
            .default_thinking_level
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| agente_core::thinking::THINKING_AUTO.to_string());
        let permission_engine =
            shared_permission_engine_with_config(mode, &app_config.auto_approve, &project_dir);

        self.agent.abort_task();
        self.agent.state = agente_core::types::AgentState::Idle;
        self.agent.clear_stream_buffers();
        self.agent.clear_approvals();
        self.agent.message_queue.clear();
        self.agent.steering_queue.clear();
        self.agent.mode = mode;
        self.agent.auto_mode = work_mode == WorkMode::Auto;
        self.agent.current_turn_mode = mode;
        self.agent.thinking_level = thinking_level;
        self.agent.shared_permission_engine = permission_engine;
        self.agent.subagents.clear();
        self.agent.total_tokens = 0;
        self.agent.context_measured = false;
        self.agent.last_turn_prompt_tokens = 0;
        self.agent.last_turn_completion_tokens = 0;
        self.agent.last_turn_cache_read_tokens = 0;
        self.agent.last_turn_cache_creation_tokens = 0;
        self.agent.spend = Spend::default();
        self.agent.last_response_duration = None;

        // A new session in the same project keeps its live MCP connections.
        let keep_mcp = (self.session.project_dir == project_dir
            && self.config.config.mcp == app_config.mcp
            && self.config.config.approved_mcp_servers == app_config.approved_mcp_servers)
            .then(|| std::sync::Arc::clone(&self.config.mcp_manager));
        self.config = ConfigState::for_project(app_config, &project_dir);
        if let Some(manager) = keep_mcp {
            self.config.mcp_manager = manager;
        }
        self.session = SessionState::new(project_dir);
        self.todo = TodoState::default();
        self.plan_review = PlanReviewState::default();
        self.subagent_registry = agente_core::subagent::SubagentRegistry::new();
        let input_history = std::mem::take(&mut self.input.input_history);
        self.input = InputState::default();
        self.input.input_history = input_history;
        self.input.input_history_index = self.input.input_history.len();
        self.picker = SessionPickerState::default();
        self.ui.reset_for_workspace();
    }

    /// Add user message to chat history
    pub fn add_user_message(&mut self, content: String) {
        self.add_user_message_with(content, Vec::new());
    }

    /// A sent prompt with media attachments.
    pub fn add_user_message_with(
        &mut self,
        content: String,
        attachments: Vec<agente_core::media::Attachment>,
    ) {
        // The prompt rises out of the composer into its bubble: glide to the
        // new bottom while the new block fades in.
        self.ui.glide_to_bottom();
        self.append_user_message(content, attachments);
    }

    /// Record a queued prompt when the model receives it, preserving the viewport.
    pub(crate) fn append_user_message(
        &mut self,
        content: String,
        attachments: Vec<agente_core::media::Attachment>,
    ) {
        let mode_str = self.agent.mode.to_string();
        self.session
            .add_user_message_with(content, mode_str, attachments);
        self.ui.trigger_message_fade();
    }

    /// Add system message to chat history
    pub fn add_system_message(&mut self, content: String) {
        self.session.add_system_message(content);
    }

    /// Take live reasoning buffer for persistence onto a chat entry.
    pub fn take_reasoning(&mut self) -> Option<String> {
        let text = self.agent.reasoning_text.trim();
        if text.is_empty() {
            None
        } else {
            let owned = self.agent.reasoning_text.clone();
            self.agent.reasoning_text.clear();
            Some(owned)
        }
    }

    /// Add assistant message to chat history
    pub fn add_assistant_message(&mut self, content: String) {
        let duration = self
            .agent
            .thinking_start_time
            .map(|t| (chrono::Utc::now() - t).num_milliseconds() as f64);
        self.agent.thinking_start_time = None;
        let mode_str = self.agent.current_turn_mode.to_string();
        let reasoning = self.take_reasoning();
        self.session
            .add_assistant_message(content, mode_str, duration, reasoning);
    }

    /// Add interrupted message to chat history
    pub fn add_interrupted_message(&mut self) {
        let duration = self
            .agent
            .thinking_start_time
            .map(|t| (chrono::Utc::now() - t).num_milliseconds() as f64);
        self.agent.thinking_start_time = None;
        let mode_str = self.agent.current_turn_mode.to_string();
        let partial = self.agent.streaming_text.clone();
        let clean = if partial.is_empty() {
            String::new()
        } else {
            strip_thinking_tags_inline(&partial)
        };
        let reasoning = self.take_reasoning();
        self.session
            .add_interrupted_message(clean, mode_str, duration, reasoning);
    }

    /// Persist any remaining live reasoning onto the last assistant message.
    pub fn flush_live_reasoning(&mut self) {
        if let Some(reasoning) = self.take_reasoning() {
            if let Some(id) = self.session.attach_reasoning_to_last_assistant(reasoning) {
                self.ui.invalidate_chat_entry(&id);
            }
        }
    }

    /// Add tool call to chat history
    pub fn add_tool_call(&mut self, name: String, args: String) {
        let mode_str = self.agent.current_turn_mode.to_string();
        self.session.add_tool_call(name, args, mode_str);
    }

    /// Add tool result to chat history
    pub fn add_tool_result(
        &mut self,
        tool_name: &str,
        content: String,
        is_error: bool,
        duration_ms: Option<f64>,
    ) {
        let mode_str = self.agent.current_turn_mode.to_string();
        self.session
            .add_tool_result(tool_name, content, is_error, duration_ms, mode_str);
    }

    /// Stamp the newest un-stamped file-mutating tool result with this edit's
    /// `(+additions, -deletions)` so its collapsed card shows a `+N/-M` badge.
    ///
    /// The `FileChange` event arrives right after the tool result, so the
    /// matching entry is the last write-tool entry still missing stats. The
    /// cached render is dropped for that entry only.
    pub fn stamp_tool_diff_stats(&mut self, stats: (usize, usize)) {
        const WRITE_TOOLS: [&str; 2] = ["write_file", "edit_file"];
        let entry = self.session.chat_history.iter_mut().rev().find(|e| {
            e.role == agente_core::types::Role::Tool
                && e.diff_stats.is_none()
                && e.tool_name
                    .as_deref()
                    .is_some_and(|n| WRITE_TOOLS.contains(&n))
        });
        if let Some(entry) = entry {
            entry.diff_stats = Some(stats);
            let id = entry.id;
            self.ui.invalidate_chat_entry(&id);
        }
    }

    /// Track a file change
    pub fn track_file_change(&mut self, path: &str, before: Option<String>, after: Option<String>) {
        self.session.track_file_change(path, before, after);
    }

    /// Track a file deletion
    pub fn track_file_deletion(&mut self, path: &str) {
        self.session.track_file_deletion(path);
    }

    /// Open the diff peek for a tracked file. Sets `ui.diff_peek` only when
    /// the path has tracked changes (present in `file_originals` or
    /// `file_versions` with differing before/after); otherwise leaves state
    /// untouched so an open peek is never clobbered by an untracked path.
    pub fn open_diff_peek(&mut self, path: &str) {
        let in_originals = self.session.file_originals.contains_key(path);
        let in_versions = self.session.file_versions.contains_key(path);
        if !in_originals && !in_versions {
            return;
        }
        let before = self
            .session
            .file_originals
            .get(path)
            .cloned()
            .unwrap_or(None);
        let after = self.session.file_versions.get(path).cloned();
        if before == after {
            return;
        }
        self.ui.diff_peek = Some(path.to_string());
        self.ui.diff_peek_scroll = 0;
        self.ui.diff_peek_max = 0;
        self.ui.needs_render = true;
    }

    /// Undo last agent file mutation batch
    pub fn undo_last_change(&mut self) -> Result<String, String> {
        self.session.undo_last_change()
    }

    /// Redo last undone file mutation batch
    pub fn redo_last_change(&mut self) -> Result<String, String> {
        self.session.redo_last_change()
    }

    /// Submit input and add to history
    pub fn submit_input(&mut self) -> Option<String> {
        self.input.submit_input()
    }

    /// Navigate up through input history
    pub fn history_up(&mut self) {
        self.input.history_up();
    }

    /// Navigate down through input history
    pub fn history_down(&mut self) {
        self.input.history_down();
    }

    /// Check if any provider is connected
    pub fn is_connected(&self) -> bool {
        self.config.is_connected()
    }

    /// Check if specific provider is connected
    pub fn is_provider_connected(&self, provider: &str) -> bool {
        self.config.is_provider_connected(provider)
    }

    /// Connect a provider with an API key
    pub fn connect_provider(&mut self, provider: &str, api_key: &str) {
        self.config.connect_provider(provider, api_key);
    }

    /// Disconnect a provider (optionally forget stored key)
    pub fn disconnect_provider(&mut self, provider: &str, forget_key: bool) {
        self.config.disconnect_provider(provider, forget_key);
    }

    /// Open the connect screen
    pub fn open_connect_screen(&mut self) {
        self.config.open_connect_screen();
    }

    /// Close the connect screen
    pub fn close_connect_screen(&mut self) {
        self.config.close_connect_screen();
    }

    pub fn open_enter_key(&mut self, provider: &str, query: String, replace: bool, error: String) {
        self.config.open_enter_key(provider, query, replace, error);
    }

    pub fn can_activate_without_key(&self, provider: &str) -> bool {
        self.config.can_activate_without_key(provider)
    }

    /// Get all provider entries
    pub fn all_provider_entries(&self) -> Vec<agente_core::config::ProviderEntry> {
        self.config.all_provider_entries()
    }

    /// Get resolved API key for current provider
    pub fn get_resolved_api_key(&self) -> Option<String> {
        self.config.get_resolved_api_key()
    }

    /// Get resolved base URL for current provider
    pub fn get_resolved_base_url(&self) -> Option<String> {
        self.config.get_resolved_base_url()
    }

    /// Get API key for specific provider
    pub fn get_api_key_for(&self, provider: &str) -> Option<String> {
        self.config.get_api_key_for(provider)
    }

    /// Get base URL for specific provider
    pub fn get_base_url_for(&self, provider: &str) -> Option<String> {
        self.config.get_base_url_for(provider)
    }

    /// Set discovered models for a provider
    pub fn set_discovered_models(
        &mut self,
        provider: &str,
        models: Vec<agente_core::providers::ModelInfo>,
    ) {
        self.config.set_discovered_models(provider, models);
    }

    /// Set discovery failed status
    pub fn set_discovery_failed(&mut self, provider: &str, error: String) {
        self.config.set_discovery_failed(provider, error);
    }

    /// Get model entries for a provider
    pub fn get_models_for_provider(&self, provider: &str) -> Vec<ModelEntry> {
        self.config.get_models_for_provider(provider)
    }

    /// Get all model entries
    pub fn get_all_model_entries(&self) -> Vec<ModelEntry> {
        self.config.get_all_model_entries()
    }

    /// Check if provider has API key
    pub fn provider_has_key(&self, provider: &str) -> bool {
        self.config.provider_has_key(provider)
    }

    /// Get provider display name
    pub fn get_provider_display_name(&self, provider: &str) -> String {
        self.config.get_provider_display_name(provider)
    }

    pub fn get_model_display_name(&self, provider: &str, model_id: &str) -> String {
        self.config.get_model_display_name(provider, model_id)
    }

    /// Resolve model metadata (registry → discovered → inferred).
    pub fn resolve_model(
        &self,
        provider: &str,
        model_id: &str,
    ) -> Option<agente_core::providers::ModelInfo> {
        self.config.resolve_model(provider, model_id)
    }

    /// Load session data
    pub fn load_from_session(&mut self, data: &agente_core::session::SessionData) {
        self.session.load_from_session(data);
        self.ui.clear_chat_render_cache();
        if !data.meta.provider.is_empty() {
            self.config.current_provider = data.meta.provider.clone();
        }
        if !data.meta.model.is_empty() {
            self.config.current_model = data.meta.model.clone();
        }
        if !data.meta.thinking_level.is_empty() {
            self.agent.thinking_level = data.meta.thinking_level.clone();
        }
        // Leave the welcome hero so chat history is painted immediately
        // (otherwise the list stays hidden until the user sends a message).
        self.ui.show_welcome_screen = false;
        self.ui.chat_scroll = 0;
        self.ui.chat_auto_scroll = true;
        self.ui.needs_render = true;
    }

    /// Tick FPS counter
    pub fn tick_fps(&mut self) {
        self.ui.tick_fps();
    }

    /// Refresh the recent-sessions list shown on the welcome screen.
    pub fn refresh_recent_sessions(&mut self) {
        use agente_core::session;
        const MAX_RECENT: usize = 4;
        let mut list = session::list_sessions();
        list.truncate(MAX_RECENT);
        self.ui.recent_sessions = list;
    }

    /// Apply a background-generated title to the active session.
    /// Returns false when the result belongs to a session that is no longer
    /// active — the caller routes those to disk instead of clobbering the
    /// new session.
    pub fn apply_session_title(&mut self, session_id: uuid::Uuid, title: String) -> bool {
        if self.session.session_id != session_id {
            return false;
        }
        self.session.title = title;
        self.ui.needs_render = true;
        true
    }

    /// Scroll chat up
    pub fn scroll_up(&mut self, amount: usize) {
        self.ui.scroll_up(amount);
    }

    /// Scroll chat down
    pub fn scroll_down(&mut self, amount: usize) {
        self.ui.scroll_down(amount);
    }

    /// Eased chat scroll by `delta` rows (negative = up).
    pub fn glide_by(&mut self, delta: isize) {
        self.ui.glide_by(delta);
    }

    /// Scroll to bottom of chat
    pub fn scroll_to_bottom(&mut self) {
        self.ui.scroll_to_bottom();
    }

    /// Get maximum scroll position
    pub fn max_scroll(&self) -> usize {
        self.ui.max_scroll()
    }

    /// Set chat dimensions
    pub fn set_chat_dimensions(&mut self, content_height: usize, visible_height: usize) {
        self.ui.set_chat_dimensions(content_height, visible_height);
    }

    /// Find clicked entry at Y position
    pub fn find_clicked_entry(&self, y: u16) -> Option<uuid::Uuid> {
        self.ui.find_clicked_entry(y)
    }

    /// Update todos
    pub fn update_todos(&mut self, todos: Vec<agente_core::types::Todo>) {
        self.todo.update(todos);
    }

    /// Get all todos
    pub fn get_todos(&self) -> &[agente_core::types::Todo] {
        self.todo.get_all()
    }

    /// Trigger message fade effect
    pub fn trigger_message_fade(&mut self) {
        self.ui.trigger_message_fade();
    }

    /// Whether any continuous UI animation or active turn needs smooth continuous rendering
    /// The hero's tile field is on screen and should keep drifting (a slow
    /// ~15 fps ambient repaint, separate from the fast animation tick).
    /// The `/mcp` dialog also repaints this way: server statuses change in
    /// the background while it is open.
    pub fn wants_ambient_paint(&self) -> bool {
        if self.input.show_mcp {
            return true;
        }
        self.ui.show_welcome_screen
            && self.session.chat_history.is_empty()
            && !self.ui.reduce_motion
            && !self.plan_review.takes_chat_area()
    }

    pub fn has_active_animation(&self) -> bool {
        self.ui.has_active_animation()
            || !matches!(
                self.agent.state,
                agente_core::types::AgentState::Idle | agente_core::types::AgentState::Error(_)
            )
    }

    /// Tick effects and return delta time
    pub fn tick_effects(&mut self) -> std::time::Duration {
        self.ui.tick_effects()
    }

    /// Clear reasoning text
    pub fn clear_reasoning(&mut self) {
        self.agent.clear_reasoning();
    }

    /// Compact conversation. Returns `(messages removed, tokens saved)`.
    pub fn compact_conversation(&mut self) -> (usize, usize) {
        use agente_core::context::CompactionStrategy;

        // Sized to the selected model's window, and always shrinking what is
        // there (the runtime's `session.compact` does the same).
        let window = self
            .resolve_model(&self.config.current_provider, &self.config.current_model)
            .map(|m| m.limits.context as usize)
            .unwrap_or(0);
        let current = agente_core::context::estimate_message_tokens(&self.session.conversation);
        let strategy = CompactionStrategy::manual(window, current);
        let (removed, saved) = self.session.compact_conversation(strategy);
        if saved > 0 {
            self.agent
                .recompute_total_from_conversation(&self.session.conversation);
        }
        (removed, saved)
    }

    /// Convert to session state for saving
    pub fn to_session_state(&self) -> agente_core::session::SessionState {
        self.session.to_session_state(
            self.config.current_provider.clone(),
            self.config.current_model.clone(),
            self.agent.thinking_level.clone(),
        )
    }
}

/// Strip thinking tags from content (inline version)
fn strip_thinking_tags_inline(content: &str) -> String {
    let re = regex::Regex::new(r"<(?:think|thinking)>[\s\S]*?</(?:think|thinking)>").unwrap();
    re.replace_all(content, "").trim().to_string()
}

/// Which input surface currently owns keyboard / mouse / paste focus.
///
/// Order encodes priority: the topmost active owner wins, and lower dialogs
/// must never render over it. Global shortcuts (quit / interrupt) and
/// mode-toggle bindings always bypass this resolver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModalOwner {
    None,
    /// Tool-approval popup — highest priority; nothing may cover it.
    Approval,
    /// Permission to open/attach an image, audio or video.
    MediaConsent,
    /// Plan clarify (Ask) card.
    PlanAsk,
    /// Full-screen plan review (Accept / Redo / Comment).
    PlanReview,
    /// Plan comment mode — the composer is live but the plan fills the chat.
    PlanComment,
    SessionPicker,
    Subagents,
    /// Live per-subagent detail (opened by clicking a subagent card).
    SubagentDetail,
    Connect,
    ModelSelector,
    /// Per-subagent-type model overrides (`/subagent-models`).
    SubagentModels,
    /// Preferences dialog (`/settings`).
    Settings,
    /// Installed agent skills (`/skills`).
    Skills,
    /// MCP server status (`/mcp`).
    Mcp,
    /// Revert / fork / copy for a clicked sent message.
    MessageActions,
    /// Live output of a running tool call.
    ProcessView,
    ThinkingSelector,
    CommandPalette,
    Help,
    DiffPeek,
    Doctor,
    /// Composer-level pickers (`@` file mention / `/` command).
    AtPicker,
    SlashPicker,
    Welcome,
}

impl ModalOwner {
    /// True when the composer still receives typed/pasted text, i.e. no modal
    /// is blocking normal input. Global shortcut keys still bypass this.
    pub fn allows_composer_input(self) -> bool {
        matches!(
            self,
            ModalOwner::None
                | ModalOwner::PlanComment
                | ModalOwner::AtPicker
                | ModalOwner::SlashPicker
                | ModalOwner::Welcome
        )
    }

    /// True when mouse wheel / clicks must not reach the chat list underneath
    /// (a blocking overlay owns the pointer instead).
    pub fn blocks_chat_mouse(self) -> bool {
        !matches!(self, ModalOwner::None | ModalOwner::Welcome)
    }

    /// True when the plan review surface owns the whole chat area (scroll
    /// targets the plan body, never the hidden chat list).
    pub fn is_plan_surface(self) -> bool {
        matches!(self, ModalOwner::PlanReview | ModalOwner::PlanComment)
    }
}

/// Resolve the single modal/input owner currently active, in priority order.
///
/// Approval ranks above everything (a subagent approval must never be hidden
/// behind a palette or model picker); plan ask/review follow; then the
/// session/subagent/connect/model/palette/help/diff/pickers chain that matches
/// the historical keyboard routing.
impl ModalOwner {
    /// True for floating cards with no scrollable body of their own
    /// (approval, plan ask, connect, doctor): the transcript stays visible
    /// behind them, so an unconsumed wheel falls through to the chat instead
    /// of dying on the overlay. Takeover surfaces and pickers consume the
    /// wheel themselves and are excluded.
    pub fn wheel_falls_through_to_chat(self) -> bool {
        matches!(
            self,
            Self::Approval | Self::PlanAsk | Self::Connect | Self::Doctor
        )
    }
    /// True for dialogs drawn as a floating card over the live transcript.
    ///
    /// These need a dimmed backdrop: the card covers only its own rect, so
    /// without one the chat keeps rendering at full brightness around it and
    /// through the rows beside it. Surfaces that own their whole area
    /// (session picker, help, diff peek, plan review) paint opaquely and must
    /// not be dimmed underneath; composer pickers and the welcome screen are
    /// not modal at all.
    pub fn floats_over_chat(self) -> bool {
        matches!(
            self,
            Self::Approval
                | Self::MediaConsent
                | Self::PlanAsk
                | Self::Subagents
                | Self::SubagentDetail
                | Self::Connect
                | Self::ModelSelector
                | Self::SubagentModels
                | Self::Settings
                | Self::Skills
                | Self::Mcp
                | Self::MessageActions
                | Self::ProcessView
                | Self::ThinkingSelector
                | Self::CommandPalette
                | Self::Doctor
        )
    }

    /// True while any modal owns the screen. The chat scrollbar is suppressed
    /// for these — it is painted after the transcript but before the overlay,
    /// so its track used to run down the right edge across the open card.
    pub fn is_modal(self) -> bool {
        !matches!(
            self,
            Self::None | Self::AtPicker | Self::SlashPicker | Self::Welcome
        )
    }
}

pub fn modal_owner(state: &AppState) -> ModalOwner {
    if !state.agent.approval_queue.is_empty() {
        return ModalOwner::Approval;
    }
    if state.ui.media_consent.is_some() {
        return ModalOwner::MediaConsent;
    }
    if state.plan_review.phase == PlanReviewPhase::Asking {
        return ModalOwner::PlanAsk;
    }
    if state.plan_review.phase == PlanReviewPhase::Review {
        return ModalOwner::PlanReview;
    }
    if state.plan_review.phase == PlanReviewPhase::AwaitingComment {
        return ModalOwner::PlanComment;
    }
    if state.picker.show_session_picker {
        return ModalOwner::SessionPicker;
    }
    if state.ui.message_actions.is_some() {
        return ModalOwner::MessageActions;
    }
    if state.ui.process_view.is_some() {
        return ModalOwner::ProcessView;
    }
    if state.ui.subagent_detail_id.is_some() {
        return ModalOwner::SubagentDetail;
    }
    if state.input.show_subagents {
        return ModalOwner::Subagents;
    }
    if state.config.connect_screen != ConnectScreen::Closed {
        return ModalOwner::Connect;
    }
    if state.input.show_model_selector {
        return ModalOwner::ModelSelector;
    }
    if state.input.show_subagent_models {
        return ModalOwner::SubagentModels;
    }
    if state.input.show_settings {
        return ModalOwner::Settings;
    }
    if state.input.show_skills {
        return ModalOwner::Skills;
    }
    if state.input.show_mcp {
        return ModalOwner::Mcp;
    }
    if state.input.show_thinking_selector {
        return ModalOwner::ThinkingSelector;
    }
    if state.input.show_command_palette {
        return ModalOwner::CommandPalette;
    }
    if state.input.show_doctor {
        return ModalOwner::Doctor;
    }
    if state.ui.show_help {
        return ModalOwner::Help;
    }
    if state.ui.diff_peek.is_some() {
        return ModalOwner::DiffPeek;
    }
    if state.input.show_at_picker {
        return ModalOwner::AtPicker;
    }
    if state.input.show_slash_picker {
        return ModalOwner::SlashPicker;
    }
    if state.ui.show_welcome_screen {
        return ModalOwner::Welcome;
    }
    ModalOwner::None
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use agente_core::session::{SessionData, SessionMeta};
    use agente_core::types::AgentMode;
    use agente_core::types::{ChatEntry, Role};

    #[test]
    fn incoming_transcript_entries_preserve_the_viewport_mode() {
        for pinned in [false, true] {
            let mut state = AppState::new(AppConfig::default(), "/tmp/agente".into());
            state.ui.set_chat_dimensions(80, 20);
            if !pinned {
                state.ui.scroll_up(1);
            }
            state.add_tool_call("read_file".into(), "{}".into());
            state.add_tool_result("read_file", "result".into(), false, None);
            state.add_assistant_message("done".into());
            state.append_user_message("queued".into(), Vec::new());
            state.ui.set_chat_dimensions(90, 20);

            assert_eq!(state.ui.chat_auto_scroll, pinned);
            assert_eq!(state.ui.chat_scroll, if pinned { 70 } else { 59 });
            assert!(state.ui.scroll_target.is_none());
        }
    }

    #[test]
    fn load_from_session_dismisses_welcome_screen() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/agente".into());
        assert!(
            state.ui.show_welcome_screen,
            "fresh state should start on welcome"
        );

        let data = SessionData {
            meta: SessionMeta {
                session_id: uuid::Uuid::new_v4(),
                title: "Loaded session".into(),
                project_dir: "/tmp/proj".into(),
                created_at: chrono::Utc::now(),
                last_active: chrono::Utc::now(),
                message_count: 1,
                provider: "openai".into(),
                model: "gpt-test".into(),
                thinking_level: String::new(),
                first_prompt: String::new(),
            },
            chat_history: vec![ChatEntry {
                id: uuid::Uuid::new_v4(),
                role: Role::User,
                content: "hello from saved session".into(),
                tool_name: None,
                tool_args: None,
                is_error: false,
                timestamp: chrono::Utc::now(),
                response_duration: None,
                mode: "Build".into(),
                interrupted: false,
                reasoning: None,
                subagent_id: None,
                subagent_type: None,
                diff_stats: None,
                attachments: Vec::new(),
            }],
            conversation: vec![],
            file_versions: Default::default(),
            modified_files: vec![],
        };

        state.load_from_session(&data);

        assert!(
            !state.ui.show_welcome_screen,
            "loading a conversation must leave the welcome screen so chat is visible"
        );
        assert_eq!(state.session.chat_history.len(), 1);
        assert_eq!(
            state.session.chat_history[0].content,
            "hello from saved session"
        );
        assert!(state.ui.chat_auto_scroll);
        assert_eq!(state.ui.chat_scroll, 0);
        assert_eq!(state.config.current_provider, "openai");
        assert_eq!(state.config.current_model, "gpt-test");
    }

    fn chat_entry(content: &str) -> ChatEntry {
        ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: Role::User,
            content: content.to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: None,
            mode: "Build".into(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        }
    }

    #[test]
    fn reset_for_new_session_assigns_fresh_identity_and_clears_conversation() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/session-one".into());
        state.config.current_provider = "provider-one".into();
        state.config.current_model = "model-one".into();
        state.agent.set_mode(AgentMode::Plan);
        state.agent.thinking_level = "high".into();
        state.session.chat_history.push(chat_entry("old task"));
        state.session.title = "Old Title".into();
        state.input.input_text = "old draft".into();
        state
            .input
            .input_history
            .push("keep command history".into());
        state.todo.todos.update(vec![agente_core::todo::TodoInput {
            content: "old todo".into(),
            status: "pending".into(),
            priority: "high".into(),
        }]);
        state
            .plan_review
            .open_review("old-plan.md".into(), "Old".into(), "body".into());
        state.agent.total_tokens = 99;
        let old_id = state.session.session_id;

        assert!(state.can_replace_session());
        state.reset_for_new_session();

        assert_ne!(state.session.session_id, old_id);
        assert!(state.session.chat_history.is_empty());
        assert!(state.session.conversation.is_empty());
        assert!(state.session.title.is_empty());
        assert!(state.input.input_text.is_empty());
        assert!(state.todo.get_all().is_empty());
        assert!(state.plan_review.pending.is_none());
        assert_eq!(state.agent.total_tokens, 0);
        // User-level choices survive the reset.
        assert_eq!(state.config.current_provider, "provider-one");
        assert_eq!(state.config.current_model, "model-one");
        assert_eq!(state.agent.mode, AgentMode::Plan);
        assert_eq!(state.agent.thinking_level, "high");
        assert_eq!(state.input.input_history, vec!["keep command history"]);
        assert!(state.ui.show_welcome_screen);
    }

    #[test]
    fn can_replace_session_refuses_busy_agent() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/session-guard".into());
        assert!(state.can_replace_session());
        state.agent.state = agente_core::types::AgentState::Executing;
        assert!(!state.can_replace_session());
    }

    #[test]
    fn project_reset_clears_project_scoped_state_and_loads_target_config() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/project-one".into());
        state.session.chat_history.push(chat_entry("old project"));
        state.input.input_text = "old draft".into();
        state
            .input
            .input_history
            .push("keep command history".into());
        state.input.at_file_cache.push("old/src/main.rs".into());
        state.input.show_at_picker = true;
        state.ui.diff_peek = Some("old/src/main.rs".into());
        state.ui.selection = Some(crate::state::ChatSelection {
            start_line: 0,
            start_col: 0,
            end_line: 0,
            end_col: 1,
        });
        state.agent.total_tokens = 99;
        state.agent.last_response_duration = Some(12.0);
        state
            .plan_review
            .open_review("old-plan.md".into(), "Old".into(), "body".into());

        let target = AppConfig {
            default_provider: Some("anthropic".into()),
            default_model: Some("claude-sonnet-4-5".into()),
            default_mode: Some("Plan".into()),
            ..AppConfig::default()
        };
        state.reset_for_project("/tmp/project-two".into(), target);

        assert!(state.session.chat_history.is_empty());
        assert!(state.input.input_text.is_empty());
        assert_eq!(state.input.input_history, vec!["keep command history"]);
        assert!(state.input.at_file_cache.is_empty());
        assert!(!state.input.show_at_picker);
        assert!(state.ui.diff_peek.is_none() && state.ui.selection.is_none());
        assert_eq!(state.agent.total_tokens, 0);
        assert!(state.agent.last_response_duration.is_none());
        assert_eq!(state.agent.mode, AgentMode::Plan);
        assert_eq!(
            state.config.config.default_provider.as_deref(),
            Some("anthropic")
        );
        assert_eq!(
            state.config.config.default_model.as_deref(),
            Some("claude-sonnet-4-5")
        );
        assert!(state.plan_review.pending.is_none());
    }

    #[test]
    fn apply_session_title_rejects_stale_session_ids() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/session-title".into());
        let stale = uuid::Uuid::new_v4();
        assert!(!state.apply_session_title(stale, "Stale Title".into()));
        assert!(state.session.title.is_empty());

        let active = state.session.session_id;
        assert!(state.apply_session_title(active, "Active Title".into()));
        assert_eq!(state.session.title, "Active Title");
    }

    #[test]
    fn open_diff_peek_opens_tracked_files_only() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/diff-peek-opener".into());
        state
            .session
            .track_file_change("src/main.rs", Some("old\n".into()), Some("new\n".into()));
        state.open_diff_peek("src/main.rs");
        assert_eq!(state.ui.diff_peek.as_deref(), Some("src/main.rs"));
        state.open_diff_peek("src/untracked.rs");
        assert_eq!(
            state.ui.diff_peek.as_deref(),
            Some("src/main.rs"),
            "untracked path must not clobber the open peek"
        );
    }
}
