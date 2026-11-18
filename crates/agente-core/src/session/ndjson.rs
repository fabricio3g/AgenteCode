//! Session persistence with NDJSON (newline-delimited JSON).
//!
//! Each session snapshot is encoded as self-contained JSON objects, one per
//! line. Complete saves atomically replace the file.
//!
//! The existing `.json` session format is still supported for backward
//! compatibility. New sessions use NDJSON; old sessions continue to work.

use std::fs;
use std::io::{BufRead, BufReader};
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

fn ndjson_sessions_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agente")
        .join("sessions")
}

pub fn ndjson_session_path(id: &Uuid) -> PathBuf {
    ndjson_sessions_dir().join(format!("{id}.ndjson"))
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
