//! Crash-safe session snapshot persistence with NDJSON and legacy JSON support.

use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod ndjson;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub session_id: Uuid,
    /// Short model-generated label shown in tabs and session lists.
    #[serde(default)]
    pub title: String,
    pub project_dir: String,
    pub created_at: DateTime<Utc>,
    pub last_active: DateTime<Utc>,
    pub message_count: usize,
    pub provider: String,
    pub model: String,
    /// Thinking level active when the session was saved (`off`, `high`, …).
    #[serde(default)]
    pub thinking_level: String,
    /// First user message, trimmed to a label. The session list falls back to
    /// this before the generic placeholder, so sessions stay distinguishable
    /// while the background title request is pending — or forever, when no
    /// provider is connected to generate one.
    #[serde(default)]
    pub first_prompt: String,
}

impl SessionMeta {
    /// What the session list should show for this session.
    pub fn label(&self) -> String {
        session_label(&self.title, &self.first_prompt)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub meta: SessionMeta,
    pub chat_history: Vec<crate::types::ChatEntry>,
    pub conversation: Vec<crate::types::Message>,
    pub file_versions: std::collections::HashMap<String, String>,
    pub modified_files: Vec<crate::types::ModifiedFile>,
}

/// Session state that can be saved/loaded without TUI dependencies
#[derive(Debug, Clone)]
pub struct SessionState {
    pub session_id: Uuid,
    pub title: String,
    pub project_dir: String,
    pub created_at: DateTime<Utc>,
    pub chat_history: Vec<crate::types::ChatEntry>,
    pub conversation: Vec<crate::types::Message>,
    pub file_versions: std::collections::HashMap<String, String>,
    pub modified_files: Vec<crate::types::ModifiedFile>,
    pub current_provider: String,
    pub current_model: String,
    pub thinking_level: String,
}

/// Root of the session store.
///
/// `AGENTE_SESSIONS_DIR` overrides the default so a test run (or a sandboxed
/// invocation) never writes into the user's real store. Test sessions used to
/// land in `~/.opendev/sessions` alongside real ones — several rooted at
/// `target/debug`, from harness runs.
fn sessions_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AGENTE_SESSIONS_DIR") {
        return PathBuf::from(dir);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agente")
        .join("sessions")
}

fn session_json_path(id: &Uuid) -> PathBuf {
    sessions_dir().join(format!("{id}.json"))
}

fn index_path() -> PathBuf {
    sessions_dir().join("index.json")
}

pub fn ensure_sessions_dir() -> anyhow::Result<()> {
    let dir = sessions_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
    }
    Ok(())
}

pub fn load_index() -> Vec<SessionMeta> {
    let path = index_path();
    if !path.exists() {
        return Vec::new();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<Vec<SessionMeta>>(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn save_index(sessions: &[SessionMeta]) -> anyhow::Result<()> {
    ensure_sessions_dir()?;
    let content = serde_json::to_string_pretty(sessions)?;
    atomic_write(&index_path(), content.as_bytes())?;
    Ok(())
}

/// Save a complete session snapshot. Existing NDJSON sessions remain NDJSON;
/// legacy JSON sessions retain their format. Each replacement is committed by
/// a same-directory atomic rename so a crash cannot expose a partial file.
pub fn save_session(state: &SessionState) -> anyhow::Result<()> {
    ensure_sessions_dir()?;

    let meta = SessionMeta {
        session_id: state.session_id,
        title: state.title.clone(),
        project_dir: state.project_dir.clone(),
        created_at: state.created_at,
        last_active: Utc::now(),
        message_count: state.chat_history.len(),
        provider: state.current_provider.clone(),
        model: state.current_model.clone(),
        thinking_level: state.thinking_level.clone(),
        first_prompt: first_user_prompt(&state.chat_history),
    };

    let ndjson_path = ndjson::ndjson_session_path(&state.session_id);
    let json_path = session_json_path(&state.session_id);

    if ndjson_path.exists() || !json_path.exists() {
        // Rebuild a full NDJSON snapshot; the atomic replacement preserves the
        // previous complete file until this snapshot has been flushed.
        let mut entries: Vec<ndjson::SessionEntry> = Vec::new();
        entries.push(ndjson::SessionEntry::Meta {
            session_id: state.session_id,
            title: state.title.clone(),
            project_dir: state.project_dir.clone(),
            created_at: state.created_at,
            provider: state.current_provider.clone(),
            model: state.current_model.clone(),
            thinking_level: state.thinking_level.clone(),
        });
        for msg in &state.conversation {
            entries.push(ndjson::SessionEntry::Message { msg: msg.clone() });
        }
        for entry in &state.chat_history {
            entries.push(ndjson::SessionEntry::Chat {
                entry: entry.clone(),
            });
        }
        for (path, content) in &state.file_versions {
            entries.push(ndjson::SessionEntry::FileVersion {
                path: path.clone(),
                content: content.clone(),
            });
        }
        for file in &state.modified_files {
            entries.push(ndjson::SessionEntry::ModifiedFile { file: file.clone() });
        }

        let mut lines = Vec::new();
        for entry in entries {
            lines.push(serde_json::to_string(&entry)?);
        }
        atomic_write(&ndjson_path, (lines.join("\n") + "\n").as_bytes())?;
    } else {
        // Legacy JSON fallback
        let data = SessionData {
            meta: meta.clone(),
            chat_history: state.chat_history.clone(),
            conversation: state.conversation.clone(),
            file_versions: state.file_versions.clone(),
            modified_files: state.modified_files.clone(),
        };
        let content = serde_json::to_string_pretty(&data)?;
        atomic_write(&json_path, content.as_bytes())?;
    }

    // Update index
    let mut index = load_index();
    if let Some(existing) = index.iter_mut().find(|s| s.session_id == meta.session_id) {
        *existing = meta;
    } else {
        index.push(meta);
    }
    save_index(&index)?;

    Ok(())
}

fn atomic_write(path: &std::path::Path, content: &[u8]) -> anyhow::Result<()> {
    if path.parent().is_none() {
        anyhow::bail!("Missing parent directory for {}", path.display());
    }
    crate::fs_atomic::write_atomic(path, content)?;
    Ok(())
}

/// Load a session. Tries NDJSON first, then falls back to legacy JSON.
pub fn load_session(id: &Uuid) -> anyhow::Result<SessionData> {
    let ndjson_path = ndjson::ndjson_session_path(id);
    let json_path = session_json_path(id);

    if ndjson_path.exists() {
        let (chat_history, conversation, file_versions, modified_files) =
            ndjson::load_ndjson_session(id)?;

        // Reconstruct meta from the first Meta entry or use defaults
        let (title, project_dir, created_at, provider, model, thinking_level) =
            if let Ok(lines) = fs::read_to_string(&ndjson_path) {
                let first = lines.lines().next().unwrap_or("");
                if let Ok(ndjson::SessionEntry::Meta {
                    title,
                    project_dir,
                    created_at,
                    provider,
                    model,
                    thinking_level,
                    ..
                }) = serde_json::from_str(first)
                {
                    (
                        title,
                        project_dir,
                        created_at,
                        provider,
                        model,
                        thinking_level,
                    )
                } else {
                    (
                        String::new(),
                        String::new(),
                        Utc::now(),
                        String::new(),
                        String::new(),
                        String::new(),
                    )
                }
            } else {
                (
                    String::new(),
                    String::new(),
                    Utc::now(),
                    String::new(),
                    String::new(),
                    String::new(),
                )
            };

        let meta = SessionMeta {
            session_id: *id,
            title,
            project_dir,
            created_at,
            last_active: Utc::now(),
            message_count: chat_history.len(),
            provider,
            model,
            thinking_level,
            first_prompt: first_user_prompt(&chat_history),
        };

        Ok(SessionData {
            meta,
            chat_history,
            conversation,
            file_versions,
            modified_files,
        })
    } else if json_path.exists() {
        let content = fs::read_to_string(&json_path)?;
        let data: SessionData = serde_json::from_str(&content)?;
        Ok(data)
    } else {
        anyhow::bail!("Session not found: {id}")
    }
}

pub fn delete_session(id: &Uuid) -> anyhow::Result<()> {
    let ndjson_path = ndjson::ndjson_session_path(id);
    let json_path = session_json_path(id);

    if ndjson_path.exists() {
        fs::remove_file(&ndjson_path)?;
    }
    if json_path.exists() {
        fs::remove_file(&json_path)?;
    }

    let mut index = load_index();
    index.retain(|s| s.session_id != *id);
    save_index(&index)?;

    Ok(())
}

pub fn list_sessions() -> Vec<SessionMeta> {
    let mut sessions = load_index();
    sessions.sort_by_key(|a| std::cmp::Reverse(a.last_active));
    sessions
}

pub fn create_session_meta(project_dir: &str) -> SessionMeta {
    SessionMeta {
        session_id: Uuid::new_v4(),
        title: String::new(),
        project_dir: project_dir.to_string(),
        created_at: Utc::now(),
        last_active: Utc::now(),
        message_count: 0,
        provider: String::new(),
        model: String::new(),
        thinking_level: String::new(),
        first_prompt: String::new(),
    }
}

/// The first user message in a transcript, trimmed to a one-line label.
///
/// Newlines collapse to spaces and the result is capped so a pasted wall of
/// text cannot become a tab title.
pub fn first_user_prompt(history: &[crate::types::ChatEntry]) -> String {
    const MAX_CHARS: usize = 60;
    let Some(entry) = history
        .iter()
        .find(|e| e.role == crate::types::Role::User && !e.content.trim().is_empty())
    else {
        return String::new();
    };
    let flattened = entry
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flattened.chars().count() <= MAX_CHARS {
        return flattened;
    }
    let truncated: String = flattened.chars().take(MAX_CHARS - 1).collect();
    format!("{}…", truncated.trim_end())
}

/// Label for a session: its generated title, else its first prompt, else the
/// generic placeholder.
///
/// The placeholder used to be the only fallback, so every untitled session —
/// and every session at all with no provider connected — showed as
/// "New session", making the picker unusable.
pub fn session_label(title: &str, first_prompt: &str) -> String {
    let title = title.trim();
    if !title.is_empty() {
        return title.to_string();
    }
    let prompt = first_prompt.trim();
    if !prompt.is_empty() {
        return prompt.to_string();
    }
    "New session".to_string()
}

/// Persist a generated title without loading the whole session into the TUI.
/// The caller serializes this with normal session saves, so a late background
/// result remains valid even when its tab was switched or closed.
pub fn update_session_title(id: &Uuid, title: &str) -> anyhow::Result<()> {
    let title = title.trim();
    if title.is_empty() {
        anyhow::bail!("Session title cannot be empty");
    }

    let ndjson_path = ndjson::ndjson_session_path(id);
    if ndjson_path.exists() {
        let content = fs::read_to_string(&ndjson_path)?;
        let mut updated = false;
        let mut lines = Vec::new();
        for line in content.lines() {
            if !updated {
                if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) {
                    if value.get("type").and_then(|kind| kind.as_str()) == Some("meta") {
                        value["title"] = serde_json::Value::String(title.to_string());
                        lines.push(serde_json::to_string(&value)?);
                        updated = true;
                        continue;
                    }
                }
            }
            lines.push(line.to_string());
        }
        if updated {
            atomic_write(&ndjson_path, (lines.join("\n") + "\n").as_bytes())?;
        }
    }

    let json_path = session_json_path(id);
    if json_path.exists() {
        let content = fs::read_to_string(&json_path)?;
        let mut data: SessionData = serde_json::from_str(&content)?;
        data.meta.title = title.to_string();
        atomic_write(&json_path, serde_json::to_string_pretty(&data)?.as_bytes())?;
    }

    let mut index = load_index();
    if let Some(meta) = index.iter_mut().find(|meta| meta.session_id == *id) {
        meta.title = title.to_string();
        save_index(&index)?;
    }
    Ok(())
}

pub fn format_time_ago(dt: &DateTime<Utc>) -> String {
    let now = Utc::now();
    let diff = now.signed_duration_since(*dt);

    if diff.num_seconds() < 60 {
        "just now".to_string()
    } else if diff.num_minutes() < 60 {
        format!("{}m ago", diff.num_minutes())
    } else if diff.num_hours() < 24 {
        format!("{}h ago", diff.num_hours())
    } else if diff.num_days() < 30 {
        format!("{}d ago", diff.num_days())
    } else {
        dt.format("%Y-%m-%d").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_entry(content: &str) -> crate::types::ChatEntry {
        crate::types::ChatEntry {
            id: Uuid::new_v4(),
            role: crate::types::Role::User,
            content: content.to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: Utc::now(),
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

    /// Untitled sessions used to be indistinguishable: the picker showed a
    /// column of identical "New session" rows because the generated title was
    /// the only source of a label.
    #[test]
    fn an_untitled_session_is_labelled_by_its_first_prompt() {
        let history = vec![user_entry("add a retry guard to the provider client")];
        let prompt = first_user_prompt(&history);
        assert_eq!(prompt, "add a retry guard to the provider client");
        assert_eq!(
            session_label("", &prompt),
            "add a retry guard to the provider client"
        );
        // A generated title still wins once it arrives.
        assert_eq!(session_label("Retry guard", &prompt), "Retry guard");
        // Nothing to go on: the placeholder remains.
        assert_eq!(session_label("", ""), "New session");
        assert_eq!(session_label("   ", "  "), "New session");
    }

    /// A pasted wall of text must not become a tab title.
    #[test]
    fn first_prompt_is_flattened_and_capped() {
        let history = vec![user_entry("  line one\n\n  line two   spaced  ")];
        assert_eq!(first_user_prompt(&history), "line one line two spaced");

        let long = vec![user_entry(&"word ".repeat(100))];
        let label = first_user_prompt(&long);
        assert!(
            label.chars().count() <= 60,
            "got {} chars",
            label.chars().count()
        );
        assert!(label.ends_with('…'));
    }

    /// Tool and assistant rows are not prompts.
    #[test]
    fn first_prompt_skips_non_user_and_empty_entries() {
        let mut blank = user_entry("   ");
        blank.content = "   ".into();
        let mut assistant = user_entry("I will start by reading the file");
        assistant.role = crate::types::Role::Assistant;

        let history = vec![assistant, blank, user_entry("actually, run the tests")];
        assert_eq!(first_user_prompt(&history), "actually, run the tests");
        assert_eq!(first_user_prompt(&[]), "");
    }

    #[test]
    fn legacy_metadata_without_title_still_deserializes() {
        let current = SessionMeta {
            session_id: Uuid::new_v4(),
            title: "Generated title".into(),
            project_dir: "/tmp/project".into(),
            created_at: Utc::now(),
            last_active: Utc::now(),
            message_count: 2,
            provider: "test".into(),
            model: "test-model".into(),
            thinking_level: String::new(),
            first_prompt: String::new(),
        };
        let mut value = serde_json::to_value(current).unwrap();
        value.as_object_mut().unwrap().remove("title");

        let legacy: SessionMeta = serde_json::from_value(value).unwrap();
        assert!(legacy.title.is_empty());
    }
}
