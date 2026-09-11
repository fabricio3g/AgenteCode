use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::tools::{atomic_fs, resolve_project_path, with_file_mutation_queue, ToolError};
use crate::types::FileChangeStatus;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangedFileInfo {
    pub path: String,
    pub status: FileChangeStatus,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiffInfo {
    pub path: String,
    pub status: FileChangeStatus,
    pub additions: usize,
    pub deletions: usize,
    pub unified_diff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevertResult {
    pub path: String,
    pub reverted: bool,
    pub conflict: bool,
    pub message: String,
}

#[derive(Debug, Clone)]
struct FileSnapshot {
    path: String,
    before: Option<String>,
    after: Option<String>,
    after_hash: Option<String>,
}

#[derive(Debug, Default)]
pub struct ChangeTracker {
    snapshots: HashMap<String, FileSnapshot>,
}

impl ChangeTracker {
    pub async fn capture_before(&mut self, project_dir: &str, path: &str) -> Result<(), ToolError> {
        let normalized = normalize_project_path(project_dir, path)?;
        if self.snapshots.contains_key(&normalized) {
            return Ok(());
        }

        let resolved = resolve_project_path(path, project_dir)?;
        let before = tokio::fs::read_to_string(&resolved).await.ok();
        self.snapshots.insert(
            normalized.clone(),
            FileSnapshot {
                path: normalized,
                before,
                after: None,
                after_hash: None,
            },
        );
        Ok(())
    }

    pub async fn capture_after(&mut self, project_dir: &str, path: &str) -> Result<(), ToolError> {
        let normalized = normalize_project_path(project_dir, path)?;
        let resolved = resolve_project_path(path, project_dir)?;
        let after = tokio::fs::read_to_string(&resolved).await.ok();

        let snapshot = self
            .snapshots
            .entry(normalized.clone())
            .or_insert_with(|| FileSnapshot {
                path: normalized,
                before: None,
                after: None,
                after_hash: None,
            });
        snapshot.after_hash = after.as_deref().map(hash_content);
        snapshot.after = after;
        Ok(())
    }

    pub fn changed_files(&self) -> Vec<ChangedFileInfo> {
        let mut files: Vec<ChangedFileInfo> = self
            .snapshots
            .values()
            .filter_map(snapshot_to_changed_file)
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files
    }

    pub fn file_diff(&self, project_dir: &str, path: &str) -> Option<FileDiffInfo> {
        let normalized = normalize_project_path(project_dir, path).ok()?;
        let snapshot = self.snapshots.get(&normalized)?;
        let changed = snapshot_to_changed_file(snapshot)?;
        Some(FileDiffInfo {
            path: changed.path,
            status: changed.status,
            additions: changed.additions,
            deletions: changed.deletions,
            unified_diff: generate_unified_diff(
                snapshot.before.as_deref().unwrap_or(""),
                snapshot.after.as_deref().unwrap_or(""),
                &snapshot.path,
            ),
        })
    }

    pub async fn revert_file(&mut self, project_dir: &str, path: &str) -> RevertResult {
        let normalized = match normalize_project_path(project_dir, path) {
            Ok(path) => path,
            Err(err) => {
                return RevertResult {
                    path: path.to_string(),
                    reverted: false,
                    conflict: false,
                    message: err.to_string(),
                };
            }
        };

        let Some(snapshot) = self.snapshots.get(&normalized).cloned() else {
            return RevertResult {
                path: normalized,
                reverted: false,
                conflict: false,
                message: "No tracked change for file".to_string(),
            };
        };

        let resolved = match resolve_project_path(&normalized, project_dir) {
            Ok(path) => path,
            Err(err) => {
                return RevertResult {
                    path: normalized,
                    reverted: false,
                    conflict: false,
                    message: err.to_string(),
                };
            }
        };

        let current = tokio::fs::read_to_string(&resolved).await.ok();
        let already_reverted_created_file = snapshot.before.is_none() && current.is_none();
        if !already_reverted_created_file
            && current.as_deref().map(hash_content) != snapshot.after_hash
        {
            return RevertResult {
                path: normalized,
                reverted: false,
                conflict: true,
                message: "File changed after the agent edit; refusing to overwrite".to_string(),
            };
        }

        if already_reverted_created_file {
            self.snapshots.remove(&normalized);
            return RevertResult {
                path: normalized,
                reverted: true,
                conflict: false,
                message: "Created file was already removed".to_string(),
            };
        }

        let resolved_str = resolved.to_string_lossy().to_string();
        let before = snapshot.before.clone();
        let result = with_file_mutation_queue(
            &resolved_str,
            crate::cancellation::AbortSignal::never(),
            move |_signal| async move {
                match before.as_deref() {
                    Some(content) => {
                        if let Some(parent) = resolved.parent() {
                            let _ = tokio::fs::create_dir_all(parent).await;
                        }
                        atomic_fs::write_and_record(&resolved, content).await
                    }
                    None => tokio::fs::remove_file(&resolved).await.map_err(|err| {
                        ToolError::ExecutionError(format!(
                            "Failed to remove {}: {err}",
                            resolved.display()
                        ))
                    }),
                }
            },
        )
        .await;

        match result {
            Ok(()) => {
                self.snapshots.remove(&normalized);
                RevertResult {
                    path: normalized,
                    reverted: true,
                    conflict: false,
                    message: "Reverted file".to_string(),
                }
            }
            Err(err) => RevertResult {
                path: normalized,
                reverted: false,
                conflict: false,
                message: err.to_string(),
            },
        }
    }

    pub async fn revert_all(&mut self, project_dir: &str) -> Vec<RevertResult> {
        let paths: Vec<String> = self.snapshots.keys().cloned().collect();
        let mut results = Vec::with_capacity(paths.len());
        for path in paths {
            results.push(self.revert_file(project_dir, &path).await);
        }
        results
    }
}

fn snapshot_to_changed_file(snapshot: &FileSnapshot) -> Option<ChangedFileInfo> {
    if snapshot.before == snapshot.after {
        return None;
    }

    let status = match (&snapshot.before, &snapshot.after) {
        (None, Some(_)) => FileChangeStatus::Created,
        (Some(_), None) => FileChangeStatus::Deleted,
        (Some(_), Some(_)) => FileChangeStatus::Modified,
        (None, None) => return None,
    };

    let additions = count_added_lines(
        snapshot.before.as_deref().unwrap_or(""),
        snapshot.after.as_deref().unwrap_or(""),
    );
    let deletions = count_removed_lines(
        snapshot.before.as_deref().unwrap_or(""),
        snapshot.after.as_deref().unwrap_or(""),
    );

    Some(ChangedFileInfo {
        path: snapshot.path.clone(),
        status,
        additions,
        deletions,
    })
}

fn normalize_project_path(project_dir: &str, path: &str) -> Result<String, ToolError> {
    let resolved = resolve_project_path(path, project_dir)?;
    let base =
        std::fs::canonicalize(project_dir).unwrap_or_else(|_| Path::new(project_dir).to_path_buf());
    let relative = resolved.strip_prefix(&base).unwrap_or(&resolved);
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn hash_content(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

/// Myers-based line counts shared with the TUI's differ. The previous
/// `Vec::contains` scans were O(n²) and counted a duplicated line as neither
/// an addition nor a deletion.
fn count_added_lines(old: &str, new: &str) -> usize {
    similar::TextDiff::from_lines(old, new)
        .iter_all_changes()
        .filter(|change| change.tag() == similar::ChangeTag::Insert)
        .count()
}

fn count_removed_lines(old: &str, new: &str) -> usize {
    similar::TextDiff::from_lines(old, new)
        .iter_all_changes()
        .filter(|change| change.tag() == similar::ChangeTag::Delete)
        .count()
}

fn generate_unified_diff(old: &str, new: &str, path: &str) -> String {
    let diff = similar::TextDiff::from_lines(old, new);
    let mut out = diff
        .unified_diff()
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_project_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agente-change-tracker-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn tracks_diff_and_reverts_modified_file() {
        let dir = test_project_dir("modified");
        let path = dir.join("src.txt");
        tokio::fs::write(&path, "one\ntwo\n").await.unwrap();

        let mut tracker = ChangeTracker::default();
        tracker
            .capture_before(dir.to_str().unwrap(), "src.txt")
            .await
            .unwrap();
        tokio::fs::write(&path, "one\nthree\n").await.unwrap();
        tracker
            .capture_after(dir.to_str().unwrap(), "./src.txt")
            .await
            .unwrap();

        let files = tracker.changed_files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, FileChangeStatus::Modified);

        let diff = tracker
            .file_diff(dir.to_str().unwrap(), "./src.txt")
            .unwrap();
        assert!(diff.unified_diff.contains("-two"));
        assert!(diff.unified_diff.contains("+three"));

        let result = tracker.revert_file(dir.to_str().unwrap(), "src.txt").await;
        assert!(result.reverted);
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "one\ntwo\n"
        );
        assert!(tracker.changed_files().is_empty());
    }

    #[tokio::test]
    async fn refuses_revert_when_file_changed_externally() {
        let dir = test_project_dir("conflict");
        let path = dir.join("src.txt");
        tokio::fs::write(&path, "before\n").await.unwrap();

        let mut tracker = ChangeTracker::default();
        tracker
            .capture_before(dir.to_str().unwrap(), "src.txt")
            .await
            .unwrap();
        tokio::fs::write(&path, "agent\n").await.unwrap();
        tracker
            .capture_after(dir.to_str().unwrap(), "src.txt")
            .await
            .unwrap();
        tokio::fs::write(&path, "external\n").await.unwrap();

        let result = tracker.revert_file(dir.to_str().unwrap(), "src.txt").await;
        assert!(!result.reverted);
        assert!(result.conflict);
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "external\n"
        );
    }
}
