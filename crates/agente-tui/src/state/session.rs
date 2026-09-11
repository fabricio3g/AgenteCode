//! Session-related state management
//!
//! This module contains state related to the user session:
//! - Session ID and creation time
//! - Conversation history
//! - Chat history (for UI display)
//! - File modifications tracking

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

use agente_core::context::{CompactionStrategy, ContextCompactor};
use agente_core::session;
use agente_core::types::{ChatEntry, FileChangeStatus, Message, ModifiedFile, Role};

#[derive(Debug, Clone)]
pub struct FileMutationRecord {
    pub path: String,
    pub restore_content: Option<String>,
    pub expected_hash: Option<String>,
}

/// Session state
#[derive(Debug, Clone)]
pub struct SessionState {
    /// Unique session identifier
    pub session_id: Uuid,
    /// Model-generated title persisted with the session.
    pub title: String,
    /// When the session was created
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Project directory path
    pub project_dir: String,
    /// Chat history for UI display
    pub chat_history: Vec<ChatEntry>,
    /// Conversation messages for LLM context
    pub conversation: Vec<Message>,
    /// Tracked file modifications
    pub modified_files: Vec<ModifiedFile>,
    /// File content versions for diffing
    pub file_versions: HashMap<String, String>,
    /// First-seen original content for undo (None = file did not exist).
    pub file_originals: HashMap<String, Option<String>>,
    /// Conflict-checked file snapshots to restore on undo.
    pub undo_stack: Vec<Vec<FileMutationRecord>>,
    /// Redo batches after undo.
    pub redo_stack: Vec<Vec<FileMutationRecord>>,
    /// Background-child completion notices waiting to join `conversation`.
    /// A notice that arrives mid-turn must not be pushed directly: the
    /// turn's terminal `Done`/`Cancelled` event replaces the conversation
    /// wholesale and would clobber it. Queued notices drain at the turn
    /// boundary (or immediately when the agent is idle).
    pub pending_notices: Vec<String>,
}

impl Default for SessionState {
    fn default() -> Self {
        SessionState::new(String::new())
    }
}

impl SessionState {
    /// Create a new session
    pub fn new(project_dir: String) -> Self {
        Self {
            session_id: Uuid::new_v4(),
            title: String::new(),
            created_at: chrono::Utc::now(),
            project_dir: agente_core::util::normalize_project_dir(project_dir),
            chat_history: Vec::new(),
            conversation: Vec::new(),
            modified_files: Vec::new(),
            file_versions: HashMap::new(),
            file_originals: HashMap::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            pending_notices: Vec::new(),
        }
    }

    /// Queue a background-child completion notice for the parent
    /// conversation (see `pending_notices`).
    pub fn queue_notice(&mut self, text: String) {
        self.pending_notices.push(text);
    }

    /// Drain queued completion notices as user messages onto the
    /// conversation. Called at turn boundaries after terminal events
    /// replace the transcript. Returns true when anything was drained so the
    /// caller can resume the model.
    pub fn drain_notices(&mut self) -> bool {
        let had_notices = !self.pending_notices.is_empty();
        for text in std::mem::take(&mut self.pending_notices) {
            self.conversation.push(Message {
                role: Role::User,
                content: text,
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
            });
        }
        had_notices
    }

    /// Add a user message to the chat history
    pub fn add_user_message(&mut self, content: String, mode: String) {
        self.chat_history.push(ChatEntry {
            id: Uuid::new_v4(),
            role: Role::User,
            content,
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: None,
            mode,
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
        });
    }

    /// Add a system message to the chat history
    pub fn add_system_message(&mut self, content: String) {
        self.chat_history.push(ChatEntry {
            id: Uuid::new_v4(),
            role: Role::System,
            content,
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: None,
            mode: String::new(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
        });
    }

    /// Add an assistant message to the chat history
    pub fn add_assistant_message(
        &mut self,
        content: String,
        mode: String,
        duration: Option<f64>,
        reasoning: Option<String>,
    ) {
        self.chat_history.push(ChatEntry {
            id: Uuid::new_v4(),
            role: Role::Assistant,
            content,
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: duration,
            mode,
            interrupted: false,
            reasoning,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
        });
    }

    /// Add an interrupted assistant message
    pub fn add_interrupted_message(
        &mut self,
        content: String,
        mode: String,
        duration: Option<f64>,
        reasoning: Option<String>,
    ) {
        self.chat_history.push(ChatEntry {
            id: Uuid::new_v4(),
            role: Role::Assistant,
            content,
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: duration,
            mode,
            interrupted: true,
            reasoning,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
        });
    }

    /// Add a tool call to the chat history
    pub fn add_tool_call(&mut self, name: String, args: String, mode: String) {
        self.chat_history.push(ChatEntry {
            id: Uuid::new_v4(),
            role: Role::Assistant,
            content: String::new(),
            tool_name: Some(name),
            tool_args: Some(args),
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: None,
            mode,
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
        });
    }

    /// Add a tool result to the chat history
    pub fn add_tool_result(
        &mut self,
        tool_name: &str,
        content: String,
        is_error: bool,
        duration_ms: Option<f64>,
        mode: String,
    ) {
        self.chat_history.push(ChatEntry {
            id: Uuid::new_v4(),
            role: Role::Tool,
            content,
            tool_name: Some(tool_name.to_string()),
            tool_args: None,
            is_error,
            timestamp: chrono::Utc::now(),
            response_duration: duration_ms,
            mode,
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
        });
    }

    /// Add a subagent card entry. The card's live content (status, streaming
    /// text, nested tool rows, final writeup) is rendered from the live
    /// `SubagentUiState`; this entry only anchors the card in chat history and
    /// persists the subagent id across session reloads.
    pub fn add_subagent_entry(
        &mut self,
        subagent_id: String,
        subagent_type: String,
        description: String,
    ) {
        self.chat_history.push(ChatEntry {
            id: Uuid::new_v4(),
            role: Role::Tool,
            content: description,
            tool_name: Some("task".to_string()),
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: None,
            mode: String::new(),
            interrupted: false,
            reasoning: None,
            subagent_id: Some(subagent_id),
            subagent_type: Some(subagent_type),
            diff_stats: None,
        });
    }

    /// Attach leftover reasoning to the last assistant message (if any).
    pub fn attach_reasoning_to_last_assistant(&mut self, reasoning: String) -> Option<uuid::Uuid> {
        if reasoning.trim().is_empty() {
            return None;
        }
        if let Some(entry) = self
            .chat_history
            .iter_mut()
            .rev()
            .find(|e| e.role == Role::Assistant && e.tool_name.is_none())
        {
            match &mut entry.reasoning {
                Some(existing) if !existing.is_empty() => {
                    if !existing.ends_with('\n') {
                        existing.push('\n');
                    }
                    existing.push_str(&reasoning);
                }
                _ => entry.reasoning = Some(reasoning),
            }
            return Some(entry.id);
        }
        None
    }

    /// Track an authoritative before/after snapshot emitted by the core tool
    /// runner. No disk read happens here: by this point the write already ran.
    pub fn track_file_change(&mut self, path: &str, before: Option<String>, after: Option<String>) {
        if before == after {
            return;
        }
        self.file_originals
            .entry(path.to_string())
            .or_insert_with(|| before.clone());
        self.undo_stack.push(vec![FileMutationRecord {
            path: path.to_string(),
            restore_content: before,
            expected_hash: hash_optional(after.as_deref()),
        }]);
        self.redo_stack.clear();
        self.set_tracked_content(path, after);
    }

    /// Track a deletion performed outside the normal file-tool event path.
    pub fn track_file_deletion(&mut self, path: &str) {
        let before = self.file_versions.get(path).cloned().or_else(|| {
            std::fs::read_to_string(std::path::Path::new(&self.project_dir).join(path)).ok()
        });
        self.track_file_change(path, before, None);
    }

    /// Undo the last mutation only when every file still matches the content
    /// produced by that mutation. Validation happens before any file is changed.
    pub fn undo_last_change(&mut self) -> Result<String, String> {
        let Some(batch) = self.undo_stack.pop() else {
            return Err("Nothing to undo".into());
        };
        if let Some(path) = self.batch_conflict(&batch) {
            self.undo_stack.push(batch);
            return Err(format!(
                "{path} changed after the agent edit; refusing to overwrite"
            ));
        }
        let inverse = self.apply_batch(&batch, "restore")?;
        self.redo_stack.push(inverse);
        Ok(format!(
            "Undo: {}",
            batch
                .iter()
                .map(|change| change.path.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }

    /// Redo is subject to the same external-change guard as undo.
    pub fn redo_last_change(&mut self) -> Result<String, String> {
        let Some(batch) = self.redo_stack.pop() else {
            return Err("Nothing to redo".into());
        };
        if let Some(path) = self.batch_conflict(&batch) {
            self.redo_stack.push(batch);
            return Err(format!("{path} changed after undo; refusing to overwrite"));
        }
        let inverse = self.apply_batch(&batch, "redo")?;
        self.undo_stack.push(inverse);
        Ok(format!(
            "Redo: {}",
            batch
                .iter()
                .map(|change| change.path.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }

    fn batch_conflict(&self, batch: &[FileMutationRecord]) -> Option<String> {
        batch.iter().find_map(|change| {
            let current =
                std::fs::read_to_string(std::path::Path::new(&self.project_dir).join(&change.path))
                    .ok();
            (hash_optional(current.as_deref()) != change.expected_hash).then(|| change.path.clone())
        })
    }

    fn apply_batch(
        &mut self,
        batch: &[FileMutationRecord],
        operation: &str,
    ) -> Result<Vec<FileMutationRecord>, String> {
        let mut inverse = Vec::with_capacity(batch.len());
        for change in batch {
            let full = std::path::Path::new(&self.project_dir).join(&change.path);
            let current = std::fs::read_to_string(&full).ok();
            inverse.push(FileMutationRecord {
                path: change.path.clone(),
                restore_content: current,
                expected_hash: hash_optional(change.restore_content.as_deref()),
            });
            match &change.restore_content {
                Some(content) => {
                    if let Some(parent) = full.parent() {
                        std::fs::create_dir_all(parent).map_err(|error| {
                            format!("Failed to {} {}: {}", operation, change.path, error)
                        })?;
                    }
                    std::fs::write(&full, content).map_err(|error| {
                        format!("Failed to {} {}: {}", operation, change.path, error)
                    })?;
                }
                None if full.exists() => {
                    std::fs::remove_file(&full).map_err(|error| {
                        format!("Failed to {} {}: {}", operation, change.path, error)
                    })?;
                }
                None => {}
            }
            self.set_tracked_content(&change.path, change.restore_content.clone());
        }
        Ok(inverse)
    }

    fn set_tracked_content(&mut self, path: &str, content: Option<String>) {
        match content {
            Some(content) => {
                self.file_versions.insert(path.to_string(), content);
            }
            None => {
                self.file_versions.remove(path);
            }
        }
        self.refresh_modified_file(path);
    }

    fn refresh_modified_file(&mut self, path: &str) {
        let original = self.file_originals.get(path).cloned().unwrap_or(None);
        let current = self.file_versions.get(path).cloned();
        self.modified_files.retain(|file| file.path != path);
        if original == current {
            return;
        }
        let old = original.as_deref().unwrap_or("");
        let new = current.as_deref().unwrap_or("");
        let (additions, deletions) = crate::widgets::diff_view::count_changed_lines(old, new);
        let status = match (&original, &current) {
            (None, Some(_)) => FileChangeStatus::Created,
            (Some(_), None) => FileChangeStatus::Deleted,
            (Some(_), Some(_)) => FileChangeStatus::Modified,
            (None, None) => return,
        };
        self.modified_files.push(ModifiedFile {
            path: path.to_string(),
            additions,
            deletions,
            status,
        });
    }

    /// Compact conversation to reduce token usage.
    /// Delegates to the core `ContextCompactor` so the TUI and runtime share
    /// one compaction implementation. The strategy is sized to the resolved
    /// model's real context window (falls back to a default when unknown).
    /// Always forces: the provider, not the local estimate, has the final
    /// say on what fits, and the user asked explicitly. Returns
    /// `(messages removed, estimated tokens saved)`.
    pub fn compact_conversation(&mut self, strategy: CompactionStrategy) -> (usize, usize) {
        let original_len = self.conversation.len();
        if original_len <= 1 {
            return (0, 0);
        }

        let compactor = ContextCompactor::new(strategy);
        let result = compactor.compact_forced(self.conversation.clone());

        let saved = result.summary.tokens_saved;
        if saved > 0 || result.messages.len() != original_len {
            self.conversation = result.messages;
        }

        (original_len.saturating_sub(self.conversation.len()), saved)
    }

    /// Load session data from stored session
    pub fn load_from_session(&mut self, data: &session::SessionData) {
        self.session_id = data.meta.session_id;
        self.title = data.meta.title.clone();
        self.created_at = data.meta.created_at;
        self.project_dir = agente_core::util::normalize_project_dir(&data.meta.project_dir);
        self.chat_history = data.chat_history.clone();
        self.conversation = data.conversation.clone();
        self.file_versions = data.file_versions.clone();
        self.modified_files = data.modified_files.clone();
        self.file_originals.clear();
        self.undo_stack.clear();
        self.redo_stack.clear();
    }

    /// Convert to session state for saving
    pub fn to_session_state(
        &self,
        current_provider: String,
        current_model: String,
        thinking_level: String,
    ) -> session::SessionState {
        session::SessionState {
            session_id: self.session_id,
            title: self.title.clone(),
            project_dir: self.project_dir.clone(),
            created_at: self.created_at,
            chat_history: self.chat_history.clone(),
            conversation: self.conversation.clone(),
            file_versions: self.file_versions.clone(),
            modified_files: self.modified_files.clone(),
            current_provider,
            current_model,
            thinking_level,
        }
    }
}

/// Per-edit `(+additions, -deletions)` between two file snapshots.
/// `None` before/after pair means the change isn't a plain edit (e.g. delete).
pub fn diff_line_counts(before: Option<&str>, after: Option<&str>) -> Option<(usize, usize)> {
    let (before, after) = (before?, after?);
    Some(crate::widgets::diff_view::count_changed_lines(
        before, after,
    ))
}

fn hash_optional(content: Option<&str>) -> Option<String> {
    content.map(|content| {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        format!("{:x}", hasher.finalize())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_session() -> (std::path::PathBuf, SessionState) {
        let dir = std::env::temp_dir().join(format!("agente-session-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = SessionState::new(dir.to_string_lossy().into_owned());
        (dir, state)
    }

    #[test]
    fn undo_and_redo_validate_the_expected_file_version() {
        let (dir, mut state) = temp_session();
        let file = dir.join("sample.txt");
        std::fs::write(&file, "after").unwrap();
        state.track_file_change("sample.txt", Some("before".into()), Some("after".into()));

        state.undo_last_change().unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before");
        assert!(state.modified_files.is_empty());

        state.redo_last_change().unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "after");
        assert_eq!(state.modified_files.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn undo_refuses_to_overwrite_an_external_edit() {
        let (dir, mut state) = temp_session();
        let file = dir.join("sample.txt");
        std::fs::write(&file, "agent").unwrap();
        state.track_file_change("sample.txt", Some("before".into()), Some("agent".into()));
        std::fs::write(&file, "external").unwrap();

        let error = state.undo_last_change().unwrap_err();
        assert!(error.contains("refusing to overwrite"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "external");
        assert_eq!(state.undo_stack.len(), 1, "failed undo remains available");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn undo_created_file_removes_it_and_redo_restores_it() {
        let (dir, mut state) = temp_session();
        let file = dir.join("created.txt");
        std::fs::write(&file, "new").unwrap();
        state.track_file_change("created.txt", None, Some("new".into()));

        state.undo_last_change().unwrap();
        assert!(!file.exists());
        state.redo_last_change().unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Manual `/compact` shrinks a tool-heavy transcript even when the local
    /// estimate sits below the auto-compact gate (the provider disagrees with
    /// the estimate — that is why the user asked).
    #[test]
    fn manual_compact_forces_through_the_threshold_gate() {
        use agente_core::context::CompactionStrategy;
        use agente_core::types::{FunctionCall, Message, Role, ToolCall};

        let (dir, mut state) = temp_session();
        let big_output: String = (0..400)
            .map(|i| format!("src/file{i}.rs:1:match item_{i}\n"))
            .collect();
        state.conversation = vec![
            Message {
                role: Role::System,
                content: "system prompt".to_string(),
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
            },
            Message {
                role: Role::Assistant,
                content: String::new(),
                tool_calls: Some(vec![ToolCall {
                    id: "c1".to_string(),
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: "grep".to_string(),
                        arguments: "{}".to_string(),
                    },
                }]),
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
            },
            Message {
                role: Role::Tool,
                content: big_output,
                tool_calls: None,
                tool_call_id: Some("c1".to_string()),
                thinking: None,
                thinking_signature: None,
                continuation: None,
            },
            Message {
                role: Role::User,
                content: "latest question".to_string(),
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
            },
            Message {
                role: Role::Assistant,
                content: "latest answer".to_string(),
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
            },
        ];
        let strategy = CompactionStrategy {
            max_tokens: 4_000,
            keep_recent: 2,
            summarize_threshold: 0.9,
            target_reduction: 0.5,
            reserve_tokens: 256,
            keep_recent_tokens: 200,
        };

        let (removed, saved) = state.compact_conversation(strategy);

        assert!(saved > 0, "forced /compact must save tokens");
        let _ = removed;
        let tail = &state.conversation[state.conversation.len() - 2..];
        assert_eq!(tail[0].content, "latest question");
        assert_eq!(tail[1].content, "latest answer");
        assert!(
            state
                .conversation
                .iter()
                .any(|m| m.content.contains("Tool output truncated")),
            "old tool output must be truncated"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
