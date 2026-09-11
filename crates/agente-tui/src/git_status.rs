//! Git repository status detection for header and UI chrome.
//!
//! Non-blocking, pure-filesystem detection reading `.git/HEAD` so it adds zero
//! process-spawning overhead to the frame-render loop.

use agente_core::types::ModifiedFile;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHeaderInfo {
    pub branch: String,
    pub is_dirty: bool,
    pub additions: usize,
    pub deletions: usize,
}

/// Resolve the path to the `.git` directory, supporting git worktrees and
/// submodules where `.git` is a file containing `gitdir: <path>`.
fn resolve_git_dir(project_dir: &Path) -> Option<PathBuf> {
    let dot_git = project_dir.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    if dot_git.is_file() {
        if let Ok(content) = fs::read_to_string(&dot_git) {
            for line in content.lines() {
                let trimmed = line.trim();
                if let Some(target) = trimmed.strip_prefix("gitdir:") {
                    let gitdir_path = PathBuf::from(target.trim());
                    return if gitdir_path.is_absolute() {
                        Some(gitdir_path)
                    } else {
                        Some(project_dir.join(gitdir_path))
                    };
                }
            }
        }
    }
    None
}

/// Get the current branch name or short commit hash from `.git/HEAD`.
pub fn get_git_branch(project_dir: &str) -> Option<String> {
    let proj = Path::new(project_dir);
    let git_dir = resolve_git_dir(proj)?;
    let head_file = git_dir.join("HEAD");
    let content = fs::read_to_string(head_file).ok()?;
    let trimmed = content.trim();

    if let Some(ref_path) = trimmed.strip_prefix("ref: refs/heads/") {
        Some(ref_path.trim().to_string())
    } else if let Some(ref_path) = trimmed.strip_prefix("ref: ") {
        // Detached or non-head ref (e.g. refs/tags/v1.0)
        let name = ref_path
            .trim()
            .rsplit('/')
            .next()
            .unwrap_or(ref_path.trim());
        Some(name.to_string())
    } else if trimmed.len() >= 7 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        // Detached commit hash
        Some(trimmed[..7].to_string())
    } else {
        None
    }
}

/// Query git header info combining branch detection and modified file stats.
pub fn get_git_header_info(
    project_dir: &str,
    modified_files: &[ModifiedFile],
) -> Option<GitHeaderInfo> {
    let branch = get_git_branch(project_dir)?;
    let is_dirty = !modified_files.is_empty();
    let mut additions = 0;
    let mut deletions = 0;
    for file in modified_files {
        additions += file.additions;
        deletions += file.deletions;
    }
    Some(GitHeaderInfo {
        branch,
        is_dirty,
        additions,
        deletions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_normal_branch_head() {
        let dir = tempdir().unwrap();
        let git = dir.path().join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        assert_eq!(
            get_git_branch(dir.path().to_str().unwrap()),
            Some("main".to_string())
        );
    }

    #[test]
    fn parses_feature_branch_with_slashes() {
        let dir = tempdir().unwrap();
        let git = dir.path().join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/feature/tui-upgrade\n").unwrap();

        assert_eq!(
            get_git_branch(dir.path().to_str().unwrap()),
            Some("feature/tui-upgrade".to_string())
        );
    }

    #[test]
    fn parses_detached_head_commit() {
        let dir = tempdir().unwrap();
        let git = dir.path().join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(
            git.join("HEAD"),
            "0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();

        assert_eq!(
            get_git_branch(dir.path().to_str().unwrap()),
            Some("0123456".to_string())
        );
    }

    #[test]
    fn parses_worktree_gitdir_file() {
        let dir = tempdir().unwrap();
        let real_git = tempdir().unwrap();
        fs::write(
            real_git.path().join("HEAD"),
            "ref: refs/heads/worktree-branch\n",
        )
        .unwrap();

        // Write .git file pointing to real_git
        fs::write(
            dir.path().join(".git"),
            format!("gitdir: {}\n", real_git.path().display()),
        )
        .unwrap();

        assert_eq!(
            get_git_branch(dir.path().to_str().unwrap()),
            Some("worktree-branch".to_string())
        );
    }

    #[test]
    fn computes_header_info_with_modifications() {
        let dir = tempdir().unwrap();
        let git = dir.path().join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/dev\n").unwrap();

        let modified = vec![
            ModifiedFile {
                path: "src/main.rs".to_string(),
                additions: 12,
                deletions: 3,
                status: agente_core::types::FileChangeStatus::Modified,
            },
            ModifiedFile {
                path: "README.md".to_string(),
                additions: 5,
                deletions: 0,
                status: agente_core::types::FileChangeStatus::Modified,
            },
        ];

        let info = get_git_header_info(dir.path().to_str().unwrap(), &modified).unwrap();
        assert_eq!(info.branch, "dev");
        assert!(info.is_dirty);
        assert_eq!(info.additions, 17);
        assert_eq!(info.deletions, 3);
    }
}
