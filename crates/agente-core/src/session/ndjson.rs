//! Session persistence with NDJSON (newline-delimited JSON).
//!
//! Each session snapshot is encoded as self-contained JSON objects, one per
//! line. Complete saves atomically replace the file; `append_entry` is retained
//! for the one-time legacy JSON migration path.
//!
//! The existing `.json` session format is still supported for backward
//! compatibility. New sessions use NDJSON; old sessions continue to work.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::types::{ChatEntry, Message, ModifiedFile};

/// Loaded NDJSON session state.
pub type LoadedSession = (
    Vec<ChatEntry>,
    Vec<Message>,
    std::collections::HashMap<String, String>,
    Vec<ModifiedFile>,
);

/// A single entry in an NDJSON session file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEntry {
    /// Session metadata (usually the first line)
    Meta {
        session_id: Uuid,
        #[serde(default)]
        title: String,
        project_dir: String,
        created_at: DateTime<Utc>,
        provider: String,
        model: String,
        #[serde(default)]
        thinking_level: String,
    },
    /// A chat entry added to the history
    Chat { entry: ChatEntry },
    /// A conversation message for LLM context
    Message { msg: Message },
    /// A file modification tracking update
    FileVersion { path: String, content: String },
    /// A modified file record
    ModifiedFile { file: ModifiedFile },
}

pub fn ndjson_sessions_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agente")
        .join("sessions")
}

pub fn ndjson_session_path(id: &Uuid) -> PathBuf {
    ndjson_sessions_dir().join(format!("{id}.ndjson"))
}

/// Ensure the sessions directory exists.
pub fn ensure_sessions_dir() -> anyhow::Result<()> {
    let dir = ndjson_sessions_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
    }
    Ok(())
}

/// Append a single entry to a session file.
/// Creates the file if it doesn't exist.
pub fn append_entry(id: &Uuid, entry: &SessionEntry) -> anyhow::Result<()> {
    ensure_sessions_dir()?;
    let path = ndjson_session_path(id);
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    let line = serde_json::to_string(entry)?;
    writeln!(file, "{line}")?;
    Ok(())
}

/// Reconstruct a full session from its NDJSON file.
pub fn load_ndjson_session(id: &Uuid) -> anyhow::Result<LoadedSession> {
    let path = ndjson_session_path(id);
    if !path.exists() {
        anyhow::bail!("Session NDJSON file not found: {path:?}");
    }

    let file = fs::File::open(&path)?;
    let reader = BufReader::new(file);

    let mut chat_history = Vec::new();
    let mut conversation = Vec::new();
    let mut file_versions = std::collections::HashMap::new();
    let mut modified_files: Vec<crate::types::ModifiedFile> = Vec::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: SessionEntry = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("Skipping corrupt session line: {}", e);
                continue;
            }
        };
        match entry {
            SessionEntry::Meta { .. } => {}
            SessionEntry::Chat { entry } => chat_history.push(entry),
            SessionEntry::Message { msg } => conversation.push(msg),
            SessionEntry::FileVersion { path, content } => {
                file_versions.insert(path, content);
            }
            SessionEntry::ModifiedFile { file } => {
                if let Some(existing) = modified_files.iter_mut().find(|f| f.path == file.path) {
                    existing.additions += file.additions;
                    existing.deletions += file.deletions;
                    existing.status = file.status;
                } else {
                    modified_files.push(file);
                }
            }
        }
    }

    Ok((chat_history, conversation, file_versions, modified_files))
}

/// Migrate an old JSON session to NDJSON format.
/// Returns true if migration happened, false if already NDJSON or not found.
pub fn migrate_json_to_ndjson(id: &Uuid) -> anyhow::Result<bool> {
    let json_path = ndjson_sessions_dir().join(format!("{id}.json"));
    let ndjson_path = ndjson_session_path(id);

    if !json_path.exists() || ndjson_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&json_path)?;
    let data: super::SessionData = serde_json::from_str(&content)?;

    // Write meta first
    append_entry(
        id,
        &SessionEntry::Meta {
            session_id: data.meta.session_id,
            title: data.meta.title.clone(),
            project_dir: data.meta.project_dir.clone(),
            created_at: data.meta.created_at,
            provider: data.meta.provider.clone(),
            model: data.meta.model.clone(),
            thinking_level: data.meta.thinking_level.clone(),
        },
    )?;

    // Write conversation messages
    for msg in &data.conversation {
        append_entry(id, &SessionEntry::Message { msg: msg.clone() })?;
    }

    // Write chat history
    for entry in &data.chat_history {
        append_entry(
            id,
            &SessionEntry::Chat {
                entry: entry.clone(),
            },
        )?;
    }

    // Write file versions
    for (path, content) in &data.file_versions {
        append_entry(
            id,
            &SessionEntry::FileVersion {
                path: path.clone(),
                content: content.clone(),
            },
        )?;
    }

    // Write modified files
    for file in &data.modified_files {
        append_entry(id, &SessionEntry::ModifiedFile { file: file.clone() })?;
    }

    // Delete old JSON file after successful migration
    fs::remove_file(&json_path)?;

    Ok(true)
}

/// Check whether a session exists in NDJSON format.
pub fn ndjson_session_exists(id: &Uuid) -> bool {
    ndjson_session_path(id).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ChatEntry, Role};

    #[test]
    fn test_ndjson_roundtrip() {
        let id = Uuid::new_v4();
        let temp_dir = std::env::temp_dir().join(format!("agente_test_{id}"));
        fs::create_dir_all(&temp_dir).unwrap();

        // Override the sessions dir for this test
        // (We'd need a way to inject the dir, but for now just test serialization)
        let entry = SessionEntry::Chat {
            entry: ChatEntry {
                id: Uuid::new_v4(),
                role: Role::User,
                content: "Hello".to_string(),
                tool_name: None,
                tool_args: None,
                is_error: false,
                timestamp: Utc::now(),
                response_duration: None,
                mode: "Plan".to_string(),
                interrupted: false,
                reasoning: None,
                subagent_id: None,
                subagent_type: None,
                diff_stats: None,
                attachments: Vec::new(),
            },
        };

        let line = serde_json::to_string(&entry).unwrap();
        let parsed: SessionEntry = serde_json::from_str(&line).unwrap();
        match parsed {
            SessionEntry::Chat { entry } => assert_eq!(entry.content, "Hello"),
            _ => panic!("Expected Chat entry"),
        }
    }
}
