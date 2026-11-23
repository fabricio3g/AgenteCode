//! Atomic file replacement and the session read/write guard.
//!
//! Every mutating file tool writes through [`write_atomic`]: the new content
//! is staged in a sibling temp file, flushed and fsynced, then renamed over
//! the destination. A crash, a concurrent `read_file`/`grep`, or an OS-level
//! failure therefore never observes a half-written file.
//!
//! [`ensure_fresh`] implements read-before-write: an existing file may only be
//! modified after `read_file` recorded it and while it is unchanged on disk.
//! The record also survives a same-content timestamp bump (cloud sync, AV),
//! which is why the check falls back to comparing file content when metadata
//! drifts.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use super::ToolError;
use crate::util::clean_path;

/// Upper bound on cached file read records across the daemon process so a
/// long-lived `agente serve` never grows memory unboundedly.
const MAX_READ_STATES: usize = 2048;

tokio::task_local! {
    static READ_SESSION: uuid::Uuid;
}

/// Scope read-before-write tracking inside `fut` to `session_id` so concurrent
/// daemon sessions cannot satisfy each other's freshness checks.
pub async fn scope_session<F: Future>(session_id: uuid::Uuid, fut: F) -> F::Output {
    READ_SESSION.scope(session_id, fut).await
}

fn current_session() -> Option<uuid::Uuid> {
    READ_SESSION.try_with(|id| *id).ok()
}

type StateKey = (Option<uuid::Uuid>, PathBuf);

#[derive(Clone)]
struct ReadState {
    modified: Option<SystemTime>,
    len: u64,
    /// Lines at record time, for a useful "changed since" message.
    lines: usize,
    /// Whether the whole content was seen. A ranged view proves the file's
    /// identity (hash) but not its tail, so a whole-file overwrite stays
    /// refused while a targeted edit is allowed.
    full: bool,
    /// `None` only when the file is too large to hash; freshness then falls
    /// back to len+timestamp.
    hash: Option<[u8; 32]>,
    /// Monotonic touch sequence for bounded eviction.
    seq: u64,
}

static READ_SEQ: AtomicU64 = AtomicU64::new(1);

static READ_STATES: LazyLock<Mutex<HashMap<StateKey, ReadState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn state_key(path: &Path) -> StateKey {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    (current_session(), canonical)
}

fn lock_states() -> MutexGuard<'static, HashMap<StateKey, ReadState>> {
    READ_STATES.lock().unwrap_or_else(PoisonError::into_inner)
}

fn insert_state(key: StateKey, mut state: ReadState) {
    state.seq = READ_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut states = lock_states();
    if states.len() >= MAX_READ_STATES && !states.contains_key(&key) {
        // Evict the oldest 25% of entries so insertion stays O(1) amortized.
        let mut seqs: Vec<u64> = states.values().map(|s| s.seq).collect();
        let cutoff_idx = seqs.len() / 4;
        let (_, cutoff, _) = seqs.select_nth_unstable(cutoff_idx);
        let cutoff = *cutoff;
        states.retain(|_, s| s.seq > cutoff);
    }
    states.insert(key, state);
}

/// Drop all cached read records owned by `session_id` (e.g. on session delete).
pub fn forget_session_reads(session_id: uuid::Uuid) {
    lock_states().retain(|(sid, _), _| *sid != Some(session_id));
}

fn content_hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Record the full current content of `path` (a `read_file` or a write).
pub fn record_read(path: &Path, content: &str) {
    let (modified, len) = match std::fs::metadata(path) {
        Ok(metadata) => (metadata.modified().ok(), metadata.len()),
        Err(_) => (None, content.len() as u64),
    };
    // Hashing and canonicalization can touch large files: keep them outside
    // the shared mutex so simultaneous agents only serialize the map insert.
    let key = state_key(path);
    let hash = content_hash(content.as_bytes());
    insert_state(
        key,
        ReadState {
            modified,
            len,
            lines: line_count(content),
            full: true,
            hash: Some(hash),
            seq: 0,
        },
    );
}

/// Record a ranged read. The whole file is hashed anyway (up to a size cap):
/// a range read used to leave no hash at all, which made "read a range, then
/// edit" fail on a file that had not changed.
pub fn record_read_range(path: &Path) {
    const MAX_HASH_BYTES: u64 = 8 * 1024 * 1024;
    let (modified, len) = match std::fs::metadata(path) {
        Ok(metadata) => (metadata.modified().ok(), metadata.len()),
        Err(_) => (None, 0),
    };
    let bytes = (len <= MAX_HASH_BYTES)
        .then(|| std::fs::read(path).ok())
        .flatten();
    let hash = bytes.as_deref().map(content_hash);
    let lines = bytes
        .as_deref()
        .map(|bytes| line_count(&String::from_utf8_lossy(bytes)))
        .unwrap_or(0);
    let key = state_key(path);
    insert_state(
        key,
        ReadState {
            modified,
            len,
            lines,
            full: false,
            hash,
            seq: 0,
        },
    );
}

fn line_count(text: &str) -> usize {
    let newlines = text.bytes().filter(|byte| *byte == b'\n').count();
    // A trailing newline closes the last line rather than opening a new one.
    newlines + usize::from(!text.is_empty() && !text.ends_with('\n'))
}

/// Read-before-write guard. A missing destination is a new file (allowed);
/// an existing one must have a recorded read and be unchanged since.
pub async fn ensure_fresh(path: &Path) -> Result<(), ToolError> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(_) => return Ok(()),
    };
    let key = state_key(path);
    let recorded = lock_states().get(&key).cloned();
    let Some(recorded) = recorded else {
        return Err(ToolError::ExecutionError(format!(
            "Refusing to modify {}: read the file with read_file first",
            clean_path(&path.to_string_lossy())
        )));
    };

    let modified = metadata.modified().ok();
    let len = metadata.len();
    if recorded.len == len && recorded.modified == modified {
        return Ok(());
    }

    match recorded.hash {
        Some(hash) => match tokio::fs::read(path).await {
            Ok(bytes) if content_hash(&bytes) == hash => {
                insert_state(
                    key,
                    ReadState {
                        modified,
                        len,
                        lines: recorded.lines,
                        full: recorded.full,
                        hash: Some(hash),
                        seq: 0,
                    },
                );
                Ok(())
            }
            Ok(bytes) => Err(stale_error(path, recorded.lines, &bytes)),
            _ => Err(stale_error(path, recorded.lines, &[])),
        },
        // Only a file too large to hash falls back to length equality.
        None if recorded.len == len => Ok(()),
        None => Err(stale_error(path, recorded.lines, &[])),
    }
}

/// The file changed since it was read. Say how much: a line count is the one
/// fact that tells a model whether to re-read a hunk or the whole file.
fn stale_error(path: &Path, recorded_lines: usize, current: &[u8]) -> ToolError {
    let now = if current.is_empty() {
        String::new()
    } else {
        let lines = line_count(&String::from_utf8_lossy(current));
        format!(" It is {lines} lines now, {recorded_lines} when you read it.")
    };
    ToolError::ExecutionError(format!(
        "Refusing to modify {}: the file changed on disk since it was last read.{now} \
         Read it again with read_file, then retry the edit.",
        clean_path(&path.to_string_lossy())
    ))
}

/// [`ensure_fresh`] plus a guard for whole-file replacement: overwriting a file
/// whose tail was never seen would silently destroy it, so a full `write_file`
/// over a ranged view is refused (a targeted `edit_file` is not: the hash
/// proves the bytes it matches are current).
pub async fn ensure_fresh_full_overwrite(path: &Path) -> Result<(), ToolError> {
    ensure_fresh(path).await?;
    if tokio::fs::metadata(path).await.is_err() {
        return Ok(());
    }
    let partial = lock_states()
        .get(&state_key(path))
        .is_some_and(|state| !state.full);
    if partial {
        return Err(ToolError::ExecutionError(format!(
            "Refusing to overwrite {}: only part of the file was read. \
             Read the whole file with read_file first.",
            clean_path(&path.to_string_lossy())
        )));
    }
    Ok(())
}

/// Atomically replace `path` with `content` and remember the new state so a
/// follow-up edit does not need another read.
pub async fn write_and_record(path: &Path, content: &str) -> Result<(), ToolError> {
    write_atomic(path, content.as_bytes()).await?;
    record_read(path, content);
    Ok(())
}

/// Stage `bytes` in a same-directory temp file, fsync it, then rename it over
/// `path`. On Windows a rename can fail while another process holds the
/// destination open, so it is retried a few times before giving up.
pub async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    let path = path.to_path_buf();
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || {
        crate::fs_atomic::write_atomic(&path, &bytes).map_err(|error| {
            ToolError::ExecutionError(format!("Failed to replace {}: {error}", path.display()))
        })
    })
    .await
    .map_err(|e| ToolError::ExecutionError(format!("Atomic write task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agente-atomic-fs-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn existing_file_requires_a_read_before_write() {
        let dir = temp_dir("guard");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "hello").await.unwrap();

        let err = ensure_fresh(&path).await.unwrap_err();
        assert!(err
            .to_string()
            .contains("read the file with read_file first"));

        record_read(&path, "hello");
        assert!(ensure_fresh(&path).await.is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn external_change_after_read_is_rejected() {
        let dir = temp_dir("stale");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "hello").await.unwrap();
        record_read(&path, "hello");

        tokio::fs::write(&path, "hello world").await.unwrap();
        let err = ensure_fresh(&path).await.unwrap_err();
        assert!(err.to_string().contains("changed on disk"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn same_content_timestamp_bump_is_allowed() {
        let dir = temp_dir("same-content");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "hello").await.unwrap();
        record_read(&path, "hello");

        // Simulate a cloud-sync/AV rewrite: same bytes, newer timestamp.
        tokio::fs::write(&path, "hello").await.unwrap();
        assert!(ensure_fresh(&path).await.is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn new_file_needs_no_prior_read() {
        let dir = temp_dir("new");
        let path = dir.join("fresh.txt");
        assert!(ensure_fresh(&path).await.is_ok());

        write_and_record(&path, "content").await.unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "content");
        assert!(ensure_fresh(&path).await.is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = temp_dir("atomic");
        let path = dir.join("a.txt");
        write_and_record(&path, "first").await.unwrap();
        write_and_record(&path, "second").await.unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "second");

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with(".agente-tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_ranged_read_records_a_hash_so_an_unchanged_file_can_be_edited() {
        let dir = temp_dir("partial");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "hello\nworld\n").await.unwrap();
        // A range view still proves the file's identity: the hash covers all
        // of it, so "read a range, then edit" no longer fails on its own.
        record_read_range(&path);
        assert!(ensure_fresh(&path).await.is_ok());
        // A targeted edit is fine; replacing the whole file is not, because the
        // tail was never seen.
        let refusal = ensure_fresh_full_overwrite(&path).await.unwrap_err();
        assert!(
            refusal
                .to_string()
                .contains("only part of the file was read"),
            "{refusal}"
        );

        tokio::fs::write(&path, "hello\nworld\nagain\n")
            .await
            .unwrap();
        let err = ensure_fresh(&path).await.unwrap_err();
        assert!(
            err.to_string()
                .contains("It is 3 lines now, 2 when you read it"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_unhashed_record_still_refuses_a_whole_file_overwrite() {
        let dir = temp_dir("partial-overwrite");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "hello\nworld\n").await.unwrap();
        // Simulate a record that could not hash the content (a file beyond the
        // hash cap): identity degrades to length, and a whole overwrite is
        // still refused.
        lock_states().insert(
            state_key(&path),
            ReadState {
                modified: std::fs::metadata(&path)
                    .ok()
                    .and_then(|m| m.modified().ok()),
                len: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                lines: 2,
                full: false,
                hash: None,
                seq: 0,
            },
        );

        let err = ensure_fresh_full_overwrite(&path).await.unwrap_err();
        assert!(
            err.to_string().contains("only part of the file was read"),
            "{err}"
        );

        record_read(&path, "hello\nworld\n");
        assert!(ensure_fresh_full_overwrite(&path).await.is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn session_scopes_isolate_read_before_write_state() {
        let dir = temp_dir("session-scope");
        let path = dir.join("shared.txt");
        tokio::fs::write(&path, "hello").await.unwrap();

        let session_a = uuid::Uuid::new_v4();
        let session_b = uuid::Uuid::new_v4();

        scope_session(session_a, async {
            record_read(&path, "hello");
            assert!(ensure_fresh(&path).await.is_ok());
        })
        .await;

        scope_session(session_b, async {
            let err = ensure_fresh(&path).await.unwrap_err();
            assert!(
                err.to_string().contains("read the file with read_file first"),
                "{err}"
            );
        })
        .await;

        forget_session_reads(session_a);
        scope_session(session_a, async {
            assert!(ensure_fresh(&path).await.is_err());
        })
        .await;

        let _ = std::fs::remove_dir_all(&dir);
    }
}
