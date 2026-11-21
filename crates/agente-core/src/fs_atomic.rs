//! Shared atomic file write primitive: stage into a same-directory temp file,
//! fsync, and rename into place with Windows sharing-violation retries.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

const MAX_PERSIST_ATTEMPTS: u32 = 5;

fn is_retryable_persist_error(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    #[cfg(windows)]
    {
        // ERROR_ACCESS_DENIED (5), ERROR_SHARING_VIOLATION (32), ERROR_LOCK_VIOLATION (33)
        matches!(error.raw_os_error(), Some(5 | 32 | 33))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Atomically write `bytes` to `path`: creates parent directories if missing,
/// stages into a sibling temp file, fsyncs, and persists over `path` (retrying
/// transient Windows sharing/access violations).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;

    let mut temp = tempfile::Builder::new()
        .prefix(".agente-tmp-")
        .tempfile_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;

    let mut attempts = 0u32;
    loop {
        match temp.persist(path) {
            Ok(_) => return Ok(()),
            Err(err) => {
                attempts += 1;
                if attempts >= MAX_PERSIST_ATTEMPTS || !is_retryable_persist_error(&err.error) {
                    return Err(err.error);
                }
                std::thread::sleep(Duration::from_millis(40 * u64::from(attempts)));
                temp = err.file;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_creates_parent_and_replaces_cleanly() {
        let dir = std::env::temp_dir().join(format!("agente-fs-atomic-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested").join("file.txt");

        write_atomic(&path, b"first").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first");

        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");

        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with(".agente-tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
