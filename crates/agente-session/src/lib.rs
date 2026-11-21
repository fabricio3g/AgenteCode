//! Versioned, append-oriented session persistence.
//!
//! Durability model:
//!
//! * [`SessionStore::append`] buffers event lines in a long-lived
//!   `BufWriter<File>` per session — no per-append open/fsync.
//! * [`SessionStore::flush`] pushes buffered bytes to the OS;
//!   [`SessionStore::durable_flush`] additionally `sync_data`s the file.
//!   [`SessionStore::append_durable`] is the one-call commit point. Callers
//!   flush at commit points (turn end, snapshot, shutdown).
//! * [`SessionStore::write_snapshot`] writes a temp file in the same
//!   directory, flushes + syncs it, then renames it over the target (atomic
//!   replace; Windows retries transient sharing violations before a documented
//!   remove-then-rename last resort).
//! * [`SessionStore::recover`] is crash-tolerant: it replays every complete,
//!   valid line. A torn or invalid log tail is truncated back to the last
//!   good offset (best effort); a corrupt line that valid data still follows
//!   is skipped and logged, with appends continuing at EOF — the O_APPEND
//!   cursor is always past the last good byte offset.
//!
//! Callers should [`SessionStore::recover`] right after [`SessionStore::open`]
//! and before the first `append` for a session; recovery scans the whole log
//! and is not designed to run concurrently with appends.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agente_protocol::{Message, SessionId, SessionInfo, SessionSnapshot, PROTOCOL_VERSION};

/// Oldest protocol version whose stored sessions this store still reads.
/// Versions since then only added fields, so older records load as-is.
const OLDEST_READABLE_VERSION: u16 = 1;

fn readable(version: u16) -> bool {
    (OLDEST_READABLE_VERSION..=PROTOCOL_VERSION).contains(&version)
}
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const LOG_SUFFIX: &str = ".events.ndjson";
const SNAPSHOT_SUFFIX: &str = ".snapshot.json";
const META_SUFFIX: &str = ".meta.json";
const LOG_BUFFER_CAPACITY: usize = 64 * 1024;
const MAX_OPEN_LOGS: usize = 64;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum SessionStoreError {
    #[error("session I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid session record: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported session protocol version: {0}")]
    UnsupportedVersion(u16),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    MessageAppended { message: Message },
    ConversationReplaced { conversation: Vec<Message> },
    TurnCommitted { revision: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEventRecord {
    pub protocol_version: u16,
    pub sequence: u64,
    pub session_id: SessionId,
    pub timestamp: DateTime<Utc>,
    pub event: SessionEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSnapshot {
    protocol_version: u16,
    last_sequence: u64,
    snapshot: SessionSnapshot,
}

#[derive(Serialize)]
struct StoredSnapshotRef<'a> {
    protocol_version: u16,
    last_sequence: u64,
    snapshot: &'a SessionSnapshot,
}

#[derive(Debug, Clone)]
pub struct RecoveredSession {
    pub snapshot: SessionSnapshot,
    pub last_sequence: u64,
}

/// A session's list entry plus what each client keeps about it (the TUI's
/// on-screen transcript and file versions, Desktop's view state…), keyed by
/// client name. The runtime never interprets a client's value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub info: SessionInfo,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub clients: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
struct StoredMeta {
    protocol_version: u16,
    #[serde(flatten)]
    meta: SessionMeta,
}

#[derive(Serialize)]
struct StoredMetaRef<'a> {
    protocol_version: u16,
    #[serde(flatten)]
    meta: &'a SessionMeta,
}

// Listing does not need to allocate a client's transcript or file versions.
#[derive(Deserialize)]
struct StoredInfo {
    protocol_version: u16,
    info: SessionInfo,
}

#[derive(Debug)]
struct LogEntry {
    writer: BufWriter<fs::File>,
    last_used: u64,
}

#[derive(Debug, Default)]
struct LogCache {
    tick: u64,
    entries: HashMap<SessionId, LogEntry>,
}

impl LogCache {
    fn get_mut(&mut self, session_id: &SessionId) -> Option<&mut BufWriter<fs::File>> {
        let entry = self.entries.get_mut(session_id)?;
        self.tick = self.tick.wrapping_add(1);
        entry.last_used = self.tick;
        Some(&mut entry.writer)
    }

    fn get_or_open(
        &mut self,
        session_id: SessionId,
        path: &Path,
    ) -> std::io::Result<&mut BufWriter<fs::File>> {
        if self.entries.contains_key(&session_id) {
            self.tick = self.tick.wrapping_add(1);
            let tick = self.tick;
            let entry = self
                .entries
                .get_mut(&session_id)
                .expect("checked contains_key");
            entry.last_used = tick;
            return Ok(&mut entry.writer);
        }
        while self.entries.len() >= MAX_OPEN_LOGS {
            let Some(&lru_id) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(id, _)| id)
            else {
                break;
            };
            if let Some(mut evicted) = self.entries.remove(&lru_id) {
                if let Err(error) = evicted.writer.flush() {
                    tracing::warn!(session = %lru_id, %error, "failed to flush evicted session log");
                }
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        self.tick = self.tick.wrapping_add(1);
        let entry = self.entries.entry(session_id).or_insert(LogEntry {
            writer: BufWriter::with_capacity(LOG_BUFFER_CAPACITY, file),
            last_used: self.tick,
        });
        Ok(&mut entry.writer)
    }

    fn remove(&mut self, session_id: &SessionId) {
        self.entries.remove(session_id);
    }
}

#[derive(Debug, Clone)]
pub struct SessionStore {
    root: PathBuf,
    logs: Arc<Mutex<LogCache>>,
}

impl SessionStore {
    /// Create-or-open the store directory. Cheap to clone; every clone shares
    /// the same per-session log writers.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, SessionStoreError> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            logs: Arc::new(Mutex::new(LogCache::default())),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn lock_logs(&self) -> std::sync::MutexGuard<'_, LogCache> {
        self.logs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Buffer one event line. Cheap: opens the session log lazily on first
    /// use and never fsyncs. Durability comes from [`SessionStore::flush`],
    /// [`SessionStore::durable_flush`], or [`SessionStore::append_durable`].
    pub fn append(&self, record: &SessionEventRecord) -> Result<(), SessionStoreError> {
        if !readable(record.protocol_version) {
            return Err(SessionStoreError::UnsupportedVersion(
                record.protocol_version,
            ));
        }
        let mut line = serde_json::to_vec(record)?;
        line.push(b'\n');
        let path = self.log_path(record.session_id);
        let mut logs = self.lock_logs();
        let writer = logs.get_or_open(record.session_id, &path)?;
        writer.write_all(&line)?;
        Ok(())
    }

    /// Append and make the log durable up to (at least) this record: flush the
    /// buffer and `sync_data` the file. Use at commit points.
    pub fn append_durable(&self, record: &SessionEventRecord) -> Result<(), SessionStoreError> {
        self.append(record)?;
        self.durable_flush(record.session_id)
    }

    /// Push this session's buffered event bytes to the OS (not yet durable
    /// against power loss, but visible to any reader of the file).
    pub fn flush(&self, session_id: SessionId) -> Result<(), SessionStoreError> {
        let mut logs = self.lock_logs();
        if let Some(writer) = logs.get_mut(&session_id) {
            writer.flush()?;
        }
        Ok(())
    }

    /// Flush and `sync_data` this session's log — the record contents survive
    /// power loss once this returns.
    pub fn durable_flush(&self, session_id: SessionId) -> Result<(), SessionStoreError> {
        let mut logs = self.lock_logs();
        if let Some(writer) = logs.get_mut(&session_id) {
            writer.flush()?;
            writer.get_ref().sync_data()?;
        } else {
            drop(logs);
            let path = self.log_path(session_id);
            if path.exists() {
                OpenOptions::new().append(true).open(path)?.sync_data()?;
            }
        }
        Ok(())
    }

    /// Push every buffered session log to the OS (e.g. before shutdown).
    pub fn flush_all(&self) -> Result<(), SessionStoreError> {
        let mut logs = self.lock_logs();
        let mut first_error = None;
        for entry in logs.entries.values_mut() {
            if let Err(error) = entry.writer.flush() {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error.into()),
            None => Ok(()),
        }
    }

    /// Atomically replace the session snapshot. The session log is flushed
    /// first so the on-disk log is at least as current as the snapshot; replay
    /// then skips everything with `sequence <= last_sequence`.
    ///
    /// The temp file lives in the same directory as the target, is flushed and
    /// `sync_data`d, and is renamed over the target — a crash at any point
    /// leaves either the old or the new snapshot, never a partial one.
    pub fn write_snapshot(
        &self,
        snapshot: &SessionSnapshot,
        last_sequence: u64,
    ) -> Result<(), SessionStoreError> {
        self.flush(snapshot.session_id)?;
        let stored = StoredSnapshotRef {
            protocol_version: PROTOCOL_VERSION,
            last_sequence,
            snapshot,
        };
        self.write_atomic(&self.snapshot_path(snapshot.session_id), &stored)
    }

    /// Write `value` as JSON to `target` through a synced temp file, so a
    /// crash leaves either the old file or the new one, never half of one.
    fn write_atomic(&self, target: &Path, value: &impl Serialize) -> Result<(), SessionStoreError> {
        let name = target.file_name().unwrap_or_default().to_string_lossy();
        let temporary = self.root.join(format!(
            "{name}.tmp-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        ));
        let outcome: Result<(), SessionStoreError> = (|| {
            let file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)?;
            let mut writer = BufWriter::with_capacity(LOG_BUFFER_CAPACITY, file);
            serde_json::to_writer(&mut writer, value)?;
            writer.flush()?;
            writer.get_ref().sync_data()?;
            drop(writer);
            rename_replace(&temporary, target)?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        outcome
    }

    pub fn write_meta(&self, meta: &SessionMeta) -> Result<(), SessionStoreError> {
        let stored = StoredMetaRef {
            protocol_version: PROTOCOL_VERSION,
            meta,
        };
        self.write_atomic(&self.meta_path(meta.info.session_id), &stored)
    }

    /// The session's list entry and client state, if it has been saved.
    pub fn read_meta(
        &self,
        session_id: SessionId,
    ) -> Result<Option<SessionMeta>, SessionStoreError> {
        let path = self.meta_path(session_id);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let stored: StoredMeta = serde_json::from_slice(&bytes)?;
        if !readable(stored.protocol_version) {
            return Err(SessionStoreError::UnsupportedVersion(
                stored.protocol_version,
            ));
        }
        Ok(Some(stored.meta))
    }

    fn read_info(&self, session_id: SessionId) -> Result<Option<SessionInfo>, SessionStoreError> {
        let bytes = match fs::read(self.meta_path(session_id)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let stored: StoredInfo = serde_json::from_slice(&bytes)?;
        if !readable(stored.protocol_version) {
            return Err(SessionStoreError::UnsupportedVersion(
                stored.protocol_version,
            ));
        }
        Ok(Some(stored.info))
    }

    /// Every saved session's list entry, most recently active first. Sessions
    /// without one (saved before metadata existed) are skipped; unreadable
    /// entries are logged and skipped so one bad file never hides the rest.
    pub fn list_infos(&self) -> Result<Vec<SessionInfo>, SessionStoreError> {
        let mut infos = Vec::new();
        for session_id in self.list_sessions()? {
            match self.read_info(session_id) {
                Ok(Some(info)) => infos.push(info),
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(session = %session_id, %error, "unreadable session metadata")
                }
            }
        }
        infos.sort_by_key(|info| std::cmp::Reverse(info.last_active));
        Ok(infos)
    }

    /// Rebuild a session from its snapshot plus the event log.
    ///
    /// Crash-tolerant: every newline-terminated, parseable line at or after the
    /// snapshot's sequence is replayed. If the tail after the last good offset
    /// is torn or invalid (the usual mid-write crash), the log is truncated
    /// back to the last good offset — best effort, warned via `tracing`. A
    /// corrupt line that valid data still follows is skipped and logged, never
    /// truncated away, and the append cursor continues at EOF.
    pub fn recover(&self, session_id: SessionId) -> Result<RecoveredSession, SessionStoreError> {
        // Flush our own buffer first so every event this process appended is a
        // complete, newline-terminated line on disk before the scan below
        // decides what counts as torn.
        self.flush(session_id)?;

        let mut recovered = if self.snapshot_path(session_id).exists() {
            let bytes = fs::read(self.snapshot_path(session_id))?;
            let stored: StoredSnapshot = serde_json::from_slice(&bytes)?;
            if !readable(stored.protocol_version) {
                return Err(SessionStoreError::UnsupportedVersion(
                    stored.protocol_version,
                ));
            }
            RecoveredSession {
                snapshot: stored.snapshot,
                last_sequence: stored.last_sequence,
            }
        } else {
            RecoveredSession {
                snapshot: SessionSnapshot {
                    session_id,
                    revision: 0,
                    conversation: Vec::new(),
                },
                last_sequence: 0,
            }
        };

        let log = self.log_path(session_id);
        let mut reader = match fs::File::open(&log) {
            Ok(file) => BufReader::new(file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(recovered),
            Err(error) => return Err(error.into()),
        };

        let mut last_good_offset: u64 = 0;
        let mut scanned_bytes: u64 = 0;
        let mut line = Vec::new();
        loop {
            line.clear();
            let chunk = reader.read_until(b'\n', &mut line)?;
            if chunk == 0 {
                break;
            }
            scanned_bytes += chunk as u64;
            let terminated = line.last() == Some(&b'\n');
            let payload = if terminated {
                &line[..line.len() - 1]
            } else {
                &line[..]
            };
            if terminated && payload.iter().all(|byte| byte.is_ascii_whitespace()) {
                // Blank framing line: well-formed, keep it on disk.
                last_good_offset = scanned_bytes;
                continue;
            }
            match serde_json::from_slice::<SessionEventRecord>(payload) {
                Ok(record) if readable(record.protocol_version) && terminated => {
                    if record.sequence > recovered.last_sequence {
                        apply_event(&mut recovered.snapshot, record.event);
                        recovered.last_sequence = record.sequence;
                    }
                    last_good_offset = scanned_bytes;
                }
                Ok(record) if !readable(record.protocol_version) => {
                    tracing::warn!(
                        session = %session_id,
                        offset = scanned_bytes,
                        version = record.protocol_version,
                        "skipping session log line with unsupported protocol version"
                    );
                }
                Ok(_) => {
                    // A parseable record whose newline never made it to disk is
                    // an interrupted write: treated as torn tail below.
                    tracing::warn!(
                        session = %session_id,
                        offset = scanned_bytes,
                        "unterminated session log record treated as torn tail"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        session = %session_id,
                        offset = scanned_bytes,
                        %error,
                        "skipping corrupt session log line"
                    );
                }
            }
        }

        if scanned_bytes > last_good_offset {
            // Everything past the last good offset is a torn or corrupt tail
            // with no valid data after it: truncate (best effort) so the log
            // starts clean. O_APPEND keeps future appends at EOF either way.
            tracing::warn!(
                session = %session_id,
                good = last_good_offset,
                torn = scanned_bytes - last_good_offset,
                "truncating torn session log tail"
            );
            match OpenOptions::new().write(true).open(&log) {
                Ok(file) => {
                    if let Err(error) = file.set_len(last_good_offset) {
                        tracing::warn!(
                            session = %session_id,
                            %error,
                            "could not truncate torn session log tail"
                        );
                    }
                }
                Err(error) => tracing::warn!(
                    session = %session_id,
                    %error,
                    "could not reopen session log to truncate torn tail"
                ),
            }
        }
        Ok(recovered)
    }

    /// All sessions with any artifact (snapshot or event log) in the store,
    /// sorted by id.
    pub fn list_sessions(&self) -> Result<Vec<SessionId>, SessionStoreError> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let id_text = name
                .strip_suffix(SNAPSHOT_SUFFIX)
                .or_else(|| name.strip_suffix(LOG_SUFFIX))
                .or_else(|| name.strip_suffix(META_SUFFIX));
            if let Some(id_text) = id_text {
                if let Ok(id) = SessionId::from_str(id_text) {
                    ids.push(id);
                }
            }
        }
        ids.sort_by_key(|id| id.as_uuid());
        ids.dedup();
        Ok(ids)
    }

    /// Remove a session's snapshot and event log. Missing files are fine;
    /// returns whether anything was on disk.
    pub fn delete(&self, session_id: SessionId) -> Result<bool, SessionStoreError> {
        self.lock_logs().remove(&session_id);
        let mut removed = false;
        for path in [
            self.snapshot_path(session_id),
            self.log_path(session_id),
            self.meta_path(session_id),
        ] {
            match fs::remove_file(&path) {
                Ok(()) => removed = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(removed)
    }

    fn log_path(&self, session_id: SessionId) -> PathBuf {
        self.root.join(format!("{session_id}{LOG_SUFFIX}"))
    }

    fn meta_path(&self, session_id: SessionId) -> PathBuf {
        self.root.join(format!("{session_id}{META_SUFFIX}"))
    }

    fn snapshot_path(&self, session_id: SessionId) -> PathBuf {
        self.root.join(format!("{session_id}{SNAPSHOT_SUFFIX}"))
    }
}

fn apply_event(snapshot: &mut SessionSnapshot, event: SessionEvent) {
    match event {
        SessionEvent::MessageAppended { message } => snapshot.conversation.push(message),
        SessionEvent::ConversationReplaced { conversation } => {
            snapshot.conversation = conversation;
        }
        SessionEvent::TurnCommitted { revision } => snapshot.revision = revision,
    }
}

/// Replace `to` with `from` as atomically as the platform allows.
///
/// `std::fs::rename` maps to `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on
/// Windows, so a plain rename already replaces an existing destination.
/// Antivirus scanners and indexers can hold the destination briefly open;
/// those sharing violations are retried a few times. As a documented last
/// resort the destination is removed and the rename retried once — that
/// reopens the crash window the atomic path closed, but only after repeated
/// replace failures.
#[cfg(windows)]
fn rename_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    const ATTEMPTS: u32 = 5;
    for attempt in 1..=ATTEMPTS {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if is_transient_replace_error(&error) => {
                if attempt < ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(25 * u64::from(attempt)));
                }
            }
            Err(error) => return Err(error),
        }
    }
    let _ = fs::remove_file(to);
    fs::rename(from, to)
}

#[cfg(not(windows))]
fn rename_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn is_transient_replace_error(error: &std::io::Error) -> bool {
    // ERROR_ACCESS_DENIED (5) and ERROR_SHARING_VIOLATION (32) are what
    // MoveFileEx reports while another handle still holds the destination.
    matches!(error.raw_os_error(), Some(5 | 32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("agente-session-{tag}-{}", SessionId::new()))
    }

    fn record(session_id: SessionId, sequence: u64, content: &str) -> SessionEventRecord {
        SessionEventRecord {
            protocol_version: PROTOCOL_VERSION,
            sequence,
            session_id,
            timestamp: Utc::now(),
            event: SessionEvent::MessageAppended {
                message: Message::user(content),
            },
        }
    }

    #[test]
    fn snapshot_plus_tail_recovers() {
        let root = test_root("tail");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        let snapshot = SessionSnapshot {
            session_id,
            revision: 1,
            conversation: vec![Message::user("first")],
        };
        store.write_snapshot(&snapshot, 1).unwrap();
        store.append(&record(session_id, 2, "second")).unwrap();
        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 2);
        assert_eq!(recovered.last_sequence, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn append_is_buffered_until_flush() {
        let root = test_root("buffered");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        let log = store.log_path(session_id);

        store.append(&record(session_id, 1, "one")).unwrap();
        assert_eq!(
            fs::metadata(&log).unwrap().len(),
            0,
            "append must be buffered, not written straight to disk"
        );

        store.flush(session_id).unwrap();
        let after_flush = fs::metadata(&log).unwrap().len();
        assert!(after_flush > 0);

        store.append(&record(session_id, 2, "two")).unwrap();
        store.durable_flush(session_id).unwrap();
        let after_durable = fs::metadata(&log).unwrap().len();
        assert!(after_durable > after_flush);

        // A fresh store instance (fresh handles) recovers everything flushed.
        let reopened = SessionStore::open(&root).unwrap();
        let recovered = reopened.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 2);
        assert_eq!(recovered.last_sequence, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sessions_saved_by_older_protocol_versions_still_recover() {
        let root = test_root("older-version");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        let mut old = record(session_id, 1, "from v1");
        old.protocol_version = 1;
        store.append_durable(&old).unwrap();
        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn meta_round_trips_and_lists_newest_first() {
        let root = test_root("meta");
        let store = SessionStore::open(&root).unwrap();
        let info = |minutes: i64| SessionInfo {
            session_id: SessionId::new(),
            title: format!("t{minutes}"),
            first_prompt: String::new(),
            project_dir: "/p".into(),
            created_at: Utc::now(),
            last_active: Utc::now() + chrono::Duration::minutes(minutes),
            message_count: 2,
            provider: "p".into(),
            model: "m".into(),
            thinking_level: "off".into(),
            profile: None,
        };
        let older = SessionMeta {
            info: info(0),
            clients: BTreeMap::new(),
        };
        let mut newer = SessionMeta {
            info: info(5),
            clients: BTreeMap::new(),
        };
        newer
            .clients
            .insert("tui".into(), serde_json::json!({ "chat_history": [] }));
        store.write_meta(&older).unwrap();
        store.write_meta(&newer).unwrap();

        assert_eq!(
            store.read_meta(newer.info.session_id).unwrap(),
            Some(newer.clone())
        );
        let titles: Vec<_> = store
            .list_infos()
            .unwrap()
            .into_iter()
            .map(|i| i.title)
            .collect();
        assert_eq!(titles, vec!["t5", "t0"]);
        assert!(store.delete(older.info.session_id).unwrap());
        assert_eq!(store.read_meta(older.info.session_id).unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_removes_snapshot_and_log() {
        let root = test_root("delete");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        store.append_durable(&record(session_id, 1, "x")).unwrap();
        assert!(store.delete(session_id).unwrap());
        assert!(store.list_sessions().unwrap().is_empty());
        assert!(!store.delete(session_id).unwrap(), "already gone");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn append_rejects_wrong_protocol_version() {
        let root = test_root("version");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        let mut bad = record(session_id, 1, "x");
        bad.protocol_version = 999;
        assert!(matches!(
            store.append(&bad),
            Err(SessionStoreError::UnsupportedVersion(999))
        ));
        assert!(!store.log_path(session_id).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recover_tolerates_torn_tail() {
        let root = test_root("torn");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        store.append_durable(&record(session_id, 1, "one")).unwrap();
        store.append_durable(&record(session_id, 2, "two")).unwrap();
        let log = store.log_path(session_id);
        let good_len = fs::metadata(&log).unwrap().len();

        // Simulate a crash mid-line: partial JSON, no newline.
        {
            let mut file = OpenOptions::new().append(true).open(&log).unwrap();
            file.write_all(br#"{"protocol_version":1,"sequence":3,"sess"#)
                .unwrap();
        }
        assert!(fs::metadata(&log).unwrap().len() > good_len);

        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 2);
        assert_eq!(recovered.last_sequence, 2);
        assert_eq!(
            fs::metadata(&log).unwrap().len(),
            good_len,
            "torn tail must be truncated back to the last good offset"
        );

        // Recovery is idempotent and the log stays appendable afterwards.
        let again = store.recover(session_id).unwrap();
        assert_eq!(again.last_sequence, 2);
        store
            .append_durable(&record(session_id, 3, "three"))
            .unwrap();
        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recover_truncates_unterminated_final_record() {
        let root = test_root("unterminated");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        store.append_durable(&record(session_id, 1, "one")).unwrap();
        let log = store.log_path(session_id);
        let good_len = fs::metadata(&log).unwrap().len();

        // Complete JSON whose terminating newline was lost counts as torn:
        // the write never became durable.
        let raw = serde_json::to_string(&record(session_id, 2, "two")).unwrap();
        {
            let mut file = OpenOptions::new().append(true).open(&log).unwrap();
            file.write_all(raw.as_bytes()).unwrap();
        }

        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 1);
        assert_eq!(recovered.last_sequence, 1);
        assert_eq!(fs::metadata(&log).unwrap().len(), good_len);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recover_skips_corrupt_midlog_lines() {
        let root = test_root("midlog");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        store.append_durable(&record(session_id, 1, "one")).unwrap();
        store.append_durable(&record(session_id, 2, "two")).unwrap();
        let log = store.log_path(session_id);
        let before_corruption = fs::metadata(&log).unwrap().len();

        {
            let mut file = OpenOptions::new().append(true).open(&log).unwrap();
            file.write_all(b"{not json at all\n").unwrap();
            let mut stale = record(session_id, 3, "stale-version");
            stale.protocol_version = 999;
            file.write_all(serde_json::to_string(&stale).unwrap().as_bytes())
                .unwrap();
            file.write_all(b"\n").unwrap();
        }
        // New events continue past the corruption (append cursor at EOF).
        store
            .append_durable(&record(session_id, 4, "four"))
            .unwrap();

        let recovered = store.recover(session_id).unwrap();
        assert_eq!(
            recovered.snapshot.conversation.len(),
            3,
            "one + two + four; corrupt lines skipped"
        );
        assert_eq!(recovered.last_sequence, 4);

        // Mid-log corruption is skipped, not truncated: the bytes stay put.
        let contents = fs::read(&log).unwrap();
        let text = String::from_utf8_lossy(&contents);
        assert!(
            text.contains("{not json"),
            "mid-log corruption must be preserved"
        );
        assert!(fs::metadata(&log).unwrap().len() > before_corruption);

        // Appends after recovery still land and still recover.
        store
            .append_durable(&record(session_id, 5, "five"))
            .unwrap();
        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 4);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_replace_overwrites_existing_atomically() {
        let root = test_root("snapshot-atomic");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        let first = SessionSnapshot {
            session_id,
            revision: 1,
            conversation: vec![Message::user("first")],
        };
        store.write_snapshot(&first, 1).unwrap();
        let second = SessionSnapshot {
            session_id,
            revision: 2,
            conversation: vec![Message::user("first"), Message::user("second")],
        };
        store.write_snapshot(&second, 2).unwrap();

        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.revision, 2);
        assert_eq!(recovered.snapshot.conversation.len(), 2);
        assert_eq!(recovered.last_sequence, 2);

        let leftovers: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp snapshot files must not leak: {leftovers:?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_plus_torn_log_tail_recovers() {
        let root = test_root("snapshot-torn");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        let snapshot = SessionSnapshot {
            session_id,
            revision: 1,
            conversation: vec![Message::user("first")],
        };
        store.write_snapshot(&snapshot, 1).unwrap();
        store
            .append_durable(&record(session_id, 2, "second"))
            .unwrap();
        let log = store.log_path(session_id);
        let good_len = fs::metadata(&log).unwrap().len();

        {
            let mut file = OpenOptions::new().append(true).open(&log).unwrap();
            file.write_all(b"torn-garbage-without-newline").unwrap();
        }

        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 2);
        assert_eq!(recovered.last_sequence, 2);
        assert_eq!(fs::metadata(&log).unwrap().len(), good_len);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_sessions_finds_snapshotted_and_logged_sessions() {
        let root = test_root("list");
        let store = SessionStore::open(&root).unwrap();
        let logged = SessionId::new();
        let snapshotted = SessionId::new();
        store.append(&record(logged, 1, "a")).unwrap();
        store
            .write_snapshot(
                &SessionSnapshot {
                    session_id: snapshotted,
                    revision: 1,
                    conversation: Vec::new(),
                },
                1,
            )
            .unwrap();
        store.flush_all().unwrap();

        let mut listed = store.list_sessions().unwrap();
        listed.sort_by_key(|id| id.as_uuid());
        let mut expected = vec![logged, snapshotted];
        expected.sort_by_key(|id| id.as_uuid());
        assert_eq!(listed, expected);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recover_rejects_unsupported_snapshot_version() {
        let root = test_root("snapshot-version");
        let store = SessionStore::open(&root).unwrap();
        let session_id = SessionId::new();
        let raw = serde_json::json!({
            "protocol_version": 999,
            "last_sequence": 5,
            "snapshot": {
                "session_id": session_id.to_string(),
                "revision": 0,
                "conversation": []
            }
        });
        fs::write(store.snapshot_path(session_id), raw.to_string()).unwrap();
        assert!(matches!(
            store.recover(session_id),
            Err(SessionStoreError::UnsupportedVersion(999))
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_logs_are_bounded_and_eviction_flushes_oldest_writer() {
        let root = test_root("lru-eviction");
        let store = SessionStore::open(&root).unwrap();
        let mut sessions = Vec::new();
        for index in 0..(MAX_OPEN_LOGS + 4) {
            let session_id = SessionId::new();
            sessions.push(session_id);
            store
                .append(&record(session_id, 1, &format!("msg-{index}")))
                .unwrap();
        }
        assert_eq!(store.lock_logs().entries.len(), MAX_OPEN_LOGS);
        // The first four sessions were evicted and flushed to disk on eviction.
        for &evicted in &sessions[..4] {
            assert!(!store.lock_logs().entries.contains_key(&evicted));
            assert!(
                fs::metadata(store.log_path(evicted)).unwrap().len() > 0,
                "evicted writer must flush buffered records before closing"
            );
        }
        // Re-appending to an evicted session reopens the log in append mode.
        let first = sessions[0];
        store
            .append_durable(&record(first, 2, "msg-0-second"))
            .unwrap();
        let recovered = store.recover(first).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 2);
        assert_eq!(recovered.last_sequence, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_replace_preserves_destination_on_non_transient_error() {
        let root = test_root("rename-preserve");
        fs::create_dir_all(&root).unwrap();
        let missing_from = root.join("missing.tmp");
        let existing_to = root.join("existing.json");
        fs::write(&existing_to, b"keep-me").unwrap();
        assert!(rename_replace(&missing_from, &existing_to).is_err());
        assert_eq!(fs::read(&existing_to).unwrap(), b"keep-me");
        fs::remove_dir_all(root).unwrap();
    }
}
