//! What a bot did: one line per tool call in `activity.jsonl` (the command it
//! ran, the file it wrote, the page it fetched), newest last. The owner reads
//! it from any client (`bots.activity`); it's how unattended work stays
//! accountable. Kept to the newest [`KEEP_LINES`] once it grows past
//! [`MAX_BYTES`].

use std::io::Write;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{BotError, BotStore};

const FILE: &str = "activity.jsonl";
/// Past this size the log is trimmed…
const MAX_BYTES: u64 = 1024 * 1024;
/// …to this many of its newest lines.
const KEEP_LINES: usize = 1000;
/// Longest `detail` kept, in characters.
const DETAIL_CHARS: usize = 200;

/// One tool call a bot made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    pub at: DateTime<Utc>,
    pub tool: String,
    /// What it acted on: the command, path, address or teammate.
    pub detail: String,
    pub ok: bool,
    /// How long it took, in milliseconds.
    pub ms: u64,
}

impl Activity {
    /// The line for a tool call, its `detail` read from the call's JSON
    /// arguments: the field that says what it acted on, on one short line.
    pub fn new(at: DateTime<Utc>, tool: &str, arguments: &str, ok: bool, ms: u64) -> Self {
        Self {
            at,
            tool: tool.to_string(),
            detail: detail(arguments),
            ok,
            ms,
        }
    }
}

fn detail(arguments: &str) -> String {
    const FIELDS: &[&str] = &[
        "command",
        "path",
        "file_path",
        "url",
        "query",
        "to",
        "pattern",
        "id",
    ];
    let value: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
    let text = FIELDS
        .iter()
        .find_map(|field| value.get(field).and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .unwrap_or_default();
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= DETAIL_CHARS {
        line
    } else {
        let mut cut: String = line.chars().take(DETAIL_CHARS).collect();
        cut.push('…');
        cut
    }
}

impl BotStore {
    /// Add one line to `handle`'s activity log.
    pub fn record_activity(&self, handle: &str, entry: &Activity) -> Result<(), BotError> {
        self.get(handle)?;
        let path = self.dir(handle).join(FILE);
        let mut line = serde_json::to_string(entry).map_err(|error| BotError::Config {
            handle: handle.to_string(),
            message: error.to_string(),
        })?;
        line.push('\n');
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?
            .write_all(line.as_bytes())?;
        if std::fs::metadata(&path)?.len() > MAX_BYTES {
            let text = std::fs::read_to_string(&path)?;
            let lines: Vec<&str> = text.lines().collect();
            let keep = &lines[lines.len().saturating_sub(KEEP_LINES)..];
            std::fs::write(&path, keep.join("\n") + "\n")?;
        }
        Ok(())
    }

    /// The newest `limit` entries, oldest first. Lines that don't read (a
    /// hand edit, a torn write) are skipped.
    pub fn activity(&self, handle: &str, limit: usize) -> Result<Vec<Activity>, BotError> {
        self.get(handle)?;
        let text = match std::fs::read_to_string(self.dir(handle).join(FILE)) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let entries: Vec<Activity> = text
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        Ok(entries[entries.len().saturating_sub(limit)..].to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn details_name_what_a_call_acted_on() {
        assert_eq!(detail(r#"{"command":"ls   -la\n/tmp"}"#), "ls -la /tmp");
        assert_eq!(detail(r#"{"path":"notes.md","content":"x"}"#), "notes.md");
        assert_eq!(detail(r#"{"to":"@scout","message":"hi"}"#), "@scout");
        assert_eq!(detail("not json"), "");
        let long = format!(r#"{{"command":"{}"}}"#, "a".repeat(300));
        assert_eq!(detail(&long).chars().count(), DETAIL_CHARS + 1);
    }

    #[test]
    fn the_log_keeps_the_newest_entries() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        for index in 0..3 {
            let entry = Activity::new(
                Utc::now(),
                "shell",
                &format!(r#"{{"command":"echo {index}"}}"#),
                true,
                5,
            );
            store.record_activity("colina", &entry).unwrap();
        }
        let last_two = store.activity("colina", 2).unwrap();
        assert_eq!(last_two.len(), 2);
        assert_eq!(last_two[1].detail, "echo 2");
        assert!(store.activity("nobody", 5).is_err());
    }
}
