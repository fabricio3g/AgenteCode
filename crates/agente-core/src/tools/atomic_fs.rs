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
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use super::ToolError;
use crate::util::clean_path;

#[derive(Clone)]
struct ReadState {
    modified: Option<SystemTime>,
    len: u64,
    /// `None` when only part of the file was read, so a full-content compare
    /// is unavailable and freshness falls back to len+timestamp.
    hash: Option<[u8; 32]>,
}

static READ_STATES: LazyLock<Mutex<HashMap<PathBuf, ReadState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn state_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn lock_states() -> MutexGuard<'static, HashMap<PathBuf, ReadState>> {
    READ_STATES.lock().unwrap_or_else(PoisonError::into_inner)
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
    lock_states().insert(
        key,
        ReadState {
            modified,
            len,
            hash: Some(hash),
        },
    );
}

/// Record that only a slice of `path` was seen: freshness degrades to
/// len+timestamp because the full content is not in hand.
pub fn record_read_partial(path: &Path) {
    let (modified, len) = match std::fs::metadata(path) {
        Ok(metadata) => (metadata.modified().ok(), metadata.len()),
        Err(_) => (None, 0),
    };
    let key = state_key(path);
    lock_states().insert(
        key,
        ReadState {
            modified,
            len,
            hash: None,
        },
    );
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
                lock_states().insert(
                    key,
                    ReadState {
                        modified,
                        len,
                        hash: Some(hash),
                    },
                );
                Ok(())
            }
            _ => Err(stale_error(path)),
        },
        // A partial read cannot prove anything beyond an unchanged length.
        None if recorded.len == len => Ok(()),
        None => Err(stale_error(path)),
    }
}

fn stale_error(path: &Path) -> ToolError {
    ToolError::ExecutionError(format!(
        "Refusing to modify {}: the file changed on disk since it was last read. \
         Read it again with read_file.",
        clean_path(&path.to_string_lossy())
    ))
}

/// [`ensure_fresh`] plus a partial-view guard for whole-file replacement:
/// overwriting a file whose tail the model never read would silently destroy
/// it, so a full `write_file` over a partial record is refused.
pub async fn ensure_fresh_full_overwrite(path: &Path) -> Result<(), ToolError> {
    ensure_fresh(path).await?;
    if tokio::fs::metadata(path).await.is_err() {
        return Ok(());
    }
    let is_partial = lock_states()
        .get(&state_key(path))
        .is_some_and(|state| state.hash.is_none());
    if is_partial {
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
    tokio::task::spawn_blocking(move || write_atomic_blocking(&path, &bytes))
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Atomic write task failed: {e}")))?
}

fn write_atomic_blocking(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut temp = tempfile::Builder::new()
        .prefix(".agente-tmp-")
        .tempfile_in(&parent)
        .map_err(|e| {
            ToolError::ExecutionError(format!(
                "Failed to create a temp file in {}: {e}",
                parent.display()
            ))
        })?;
    temp.write_all(bytes)
        .map_err(|e| ToolError::ExecutionError(format!("Failed to write temp file: {e}")))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| ToolError::ExecutionError(format!("Failed to flush temp file: {e}")))?;

    let mut attempts = 0u32;
    loop {
        match temp.persist(path) {
            Ok(_) => return Ok(()),
            Err(err) => {
                attempts += 1;
                if attempts >= 5 {
                    return Err(ToolError::ExecutionError(format!(
                        "Failed to replace {}: {}",
                        path.display(),
                        err.error
                    )));
                }
                std::thread::sleep(std::time::Duration::from_millis(40 * u64::from(attempts)));
                temp = err.file;
            }
        }
    }
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
    async fn partial_read_degrades_to_length_check() {
        let dir = temp_dir("partial");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "hello").await.unwrap();
        record_read_partial(&path);
        assert!(ensure_fresh(&path).await.is_ok());

        tokio::fs::write(&path, "hello world").await.unwrap();
        assert!(ensure_fresh(&path).await.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn partial_view_blocks_a_full_overwrite() {
        let dir = temp_dir("partial-overwrite");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "hello\nworld\n").await.unwrap();
        record_read_partial(&path);

        let err = ensure_fresh_full_overwrite(&path).await.unwrap_err();
        assert!(
            err.to_string().contains("only part of the file was read"),
            "{err}"
        );

        record_read(&path, "hello\nworld\n");
        assert!(ensure_fresh_full_overwrite(&path).await.is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
