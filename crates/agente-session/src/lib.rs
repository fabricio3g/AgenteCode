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

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agente_protocol::{Message, SessionId, SessionSnapshot, PROTOCOL_VERSION};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const LOG_SUFFIX: &str = ".events.ndjson";
const SNAPSHOT_SUFFIX: &str = ".snapshot.json";
const LOG_BUFFER_CAPACITY: usize = 64 * 1024;

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

#[derive(Debug, Clone)]
pub struct RecoveredSession {
    pub snapshot: SessionSnapshot,
    pub last_sequence: u64,
}

#[derive(Debug, Clone)]
pub struct SessionStore {
    root: PathBuf,
    logs: Arc<Mutex<HashMap<SessionId, BufWriter<fs::File>>>>,
}

impl SessionStore {
    /// Create-or-open the store directory. Cheap to clone; every clone shares
    /// the same per-session log writers.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, SessionStoreError> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            logs: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Buffer one event line. Cheap: opens the session log lazily on first
    /// use and never fsyncs. Durability comes from [`SessionStore::flush`],
    /// [`SessionStore::durable_flush`], or [`SessionStore::append_durable`].
    pub fn append(&self, record: &SessionEventRecord) -> Result<(), SessionStoreError> {
        if record.protocol_version != PROTOCOL_VERSION {
            return Err(SessionStoreError::UnsupportedVersion(
                record.protocol_version,
            ));
        }
        let mut logs = self.logs.lock().unwrap();
        let writer = match logs.entry(record.session_id) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.log_path(record.session_id))?;
                entry.insert(BufWriter::with_capacity(LOG_BUFFER_CAPACITY, file))
            }
        };
        serde_json::to_writer(&mut *writer, record)?;
        writer.write_all(b"\n")?;
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
        let mut logs = self.logs.lock().unwrap();
        if let Some(writer) = logs.get_mut(&session_id) {
            writer.flush()?;
        }
        Ok(())
    }

    /// Flush and `sync_data` this session's log — the record contents survive
    /// power loss once this returns.
    pub fn durable_flush(&self, session_id: SessionId) -> Result<(), SessionStoreError> {
        let mut logs = self.logs.lock().unwrap();
        if let Some(writer) = logs.get_mut(&session_id) {
            writer.flush()?;
            writer.get_ref().sync_data()?;
        }
        Ok(())
    }

    /// Push every buffered session log to the OS (e.g. before shutdown).
    pub fn flush_all(&self) -> Result<(), SessionStoreError> {
        let mut logs = self.logs.lock().unwrap();
        for writer in logs.values_mut() {
            writer.flush()?;
        }
        Ok(())
    }

    /// Flush and `sync_data` every buffered session log.
    pub fn durable_flush_all(&self) -> Result<(), SessionStoreError> {
        let mut logs = self.logs.lock().unwrap();
        for writer in logs.values_mut() {
            writer.flush()?;
            writer.get_ref().sync_data()?;
        }
        Ok(())
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
        let stored = StoredSnapshot {
            protocol_version: PROTOCOL_VERSION,
            last_sequence,
            snapshot: snapshot.clone(),
        };
        let target = self.snapshot_path(snapshot.session_id);
        let temporary = self.root.join(format!(
            "{}{SNAPSHOT_SUFFIX}.tmp-{}-{}",
            snapshot.session_id,
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        ));
        let outcome: Result<(), SessionStoreError> = (|| {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)?;
            serde_json::to_writer(&mut file, &stored)?;
            file.flush()?;
            file.sync_data()?;
            rename_replace(&temporary, &target)?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        outcome
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
            let file = fs::File::open(self.snapshot_path(session_id))?;
            let stored: StoredSnapshot = serde_json::from_reader(file)?;
            if stored.protocol_version != PROTOCOL_VERSION {
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
                Ok(record) if record.protocol_version == PROTOCOL_VERSION && terminated => {
                    if record.sequence > recovered.last_sequence {
                        apply_event(&mut recovered.snapshot, record.event);
                        recovered.last_sequence = record.sequence;
                    }
                    last_good_offset = scanned_bytes;
                }
                Ok(record) if record.protocol_version != PROTOCOL_VERSION => {
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
                .or_else(|| name.strip_suffix(LOG_SUFFIX));
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

    fn log_path(&self, session_id: SessionId) -> PathBuf {
        self.root.join(format!("{session_id}{LOG_SUFFIX}"))
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
            Err(error) if attempt < ATTEMPTS && is_transient_replace_error(&error) => {
                std::thread::sleep(std::time::Duration::from_millis(25 * u64::from(attempt)));
            }
            Err(_) => break,
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
}
