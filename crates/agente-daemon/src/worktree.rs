//! Per-session isolated Git worktree management (`worktrees_v1`).
//!
//! Promotes `agente-core`'s pooled checkout primitives to daemon JSON-RPC and
//! orchestrator consumers so any coding CLI engine (built-in or external) can
//! work inside its own clean branch and checkout without colliding on files.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use agente_core::subagent::worktree::{self, WorktreeInfo};
use agente_protocol::{rpc, SessionId, SessionWorktree};
use agente_runtime::RuntimeHandle;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;

use crate::connection::{parse, Failure};

#[derive(Deserialize)]
struct CreateWorktreeParams {
    project_dir: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    session_id: Option<SessionId>,
}

#[derive(Deserialize)]
struct ListWorktreesParams {
    project_dir: String,
}

#[derive(Deserialize)]
struct MergeWorktreeParams {
    repo_root: String,
    path: String,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    base_commit: Option<String>,
    #[serde(default)]
    commit_message: Option<String>,
    #[serde(default)]
    remove_after: bool,
}

#[derive(Deserialize)]
struct RemoveWorktreeParams {
    repo_root: String,
    path: String,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    base_commit: Option<String>,
    #[serde(default)]
    session_id: Option<SessionId>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ListedWorktree {
    pub(crate) repo_root: String,
    pub(crate) path: String,
    pub(crate) branch: String,
    pub(crate) base_commit: String,
    pub(crate) dirty: bool,
    pub(crate) changed_files: Vec<String>,
}

pub(crate) async fn handle_async(
    runtime: &RuntimeHandle,
    method: &str,
    params: Value,
) -> Result<Value, Failure> {
    match method {
        "worktree.create" => {
            let CreateWorktreeParams {
                project_dir,
                label,
                session_id,
            } = parse(params)?;
            let worktree =
                create_worktree(runtime, &project_dir, label.as_deref(), session_id).await?;
            Ok(json!({ "worktree": worktree }))
        }
        "worktree.list" => {
            let ListWorktreesParams { project_dir } = parse(params)?;
            let worktrees = list_worktrees(&project_dir).await?;
            Ok(json!({ "worktrees": worktrees }))
        }
        "worktree.merge" => {
            let MergeWorktreeParams {
                repo_root,
                path,
                branch,
                base_commit,
                commit_message,
                remove_after,
            } = parse(params)?;
            merge_worktree(
                &repo_root,
                &path,
                branch.as_deref(),
                base_commit.as_deref(),
                commit_message.as_deref(),
                remove_after,
            )
            .await
        }
        "worktree.remove" => {
            let RemoveWorktreeParams {
                repo_root,
                path,
                branch,
                base_commit,
                session_id,
            } = parse(params)?;
            remove_worktree(
                Some(runtime),
                &repo_root,
                &path,
                branch.as_deref(),
                base_commit.as_deref(),
                session_id,
            )
            .await?;
            Ok(json!({ "removed": true }))
        }
        _ => Err((rpc::METHOD_NOT_FOUND, format!("unknown method {method}"))),
    }
}

pub(crate) async fn create_worktree(
    runtime: &RuntimeHandle,
    project_dir: &str,
    label: Option<&str>,
    session_id: Option<SessionId>,
) -> Result<SessionWorktree, Failure> {
    let project_path = Path::new(project_dir);
    if !project_path.is_dir() {
        return Err((
            rpc::INVALID_PARAMS,
            format!("project folder does not exist: {project_dir}"),
        ));
    }
    let repo_root = worktree::find_repo_root(project_path).ok_or_else(|| {
        (
            rpc::INVALID_PARAMS,
            format!("project is not inside a Git repository: {project_dir}"),
        )
    })?;

    let derived_label = label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            session_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "session".to_string())
        });

    let canon_repo = std::fs::canonicalize(&repo_root).unwrap_or(repo_root);
    let repo_norm = PathBuf::from(display_path(&canon_repo));
    let info = worktree::acquire_for(&repo_norm, &derived_label)
        .await
        .ok_or_else(|| {
            (
                rpc::INTERNAL_ERROR,
                "failed to create isolated Git worktree (ensure repository has at least one commit)".to_string(),
            )
        })?;

    let wt = SessionWorktree {
        repo_root: display_path(
            &std::fs::canonicalize(&info.repo_root)
                .unwrap_or_else(|_| PathBuf::from(&info.repo_root)),
        ),
        path: display_path(
            &std::fs::canonicalize(&info.path).unwrap_or_else(|_| PathBuf::from(&info.path)),
        ),
        branch: info.branch,
        base_commit: info.base_commit,
    };

    if let Some(sid) = session_id {
        runtime.set_session_worktree(sid, project_dir, Some(wt.clone()));
    }
    Ok(wt)
}

pub(crate) async fn list_worktrees(project_dir: &str) -> Result<Vec<ListedWorktree>, Failure> {
    let project_path = Path::new(project_dir);
    if !project_path.is_dir() {
        return Err((
            rpc::INVALID_PARAMS,
            format!("project folder does not exist: {project_dir}"),
        ));
    }
    let Some(repo_root) = worktree::find_repo_root(project_path) else {
        return Ok(Vec::new());
    };
    let canon_repo = std::fs::canonicalize(&repo_root).unwrap_or(repo_root);
    let repo_display = display_path(&canon_repo);
    let pool_root = canon_repo.join(".agente").join("worktrees");
    if !pool_root.is_dir() {
        return Ok(Vec::new());
    }

    let out = git_output(&canon_repo, &["worktree", "list", "--porcelain"]).await?;
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_head = String::new();
    let mut current_branch = String::new();

    for line in out.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if let Some(raw_path) = current_path.take() {
                let candidate = PathBuf::from(&raw_path);
                let canon_candidate = std::fs::canonicalize(&candidate).unwrap_or(candidate);
                if canon_candidate.starts_with(&pool_root) && canon_candidate != pool_root {
                    let wt_display = display_path(&canon_candidate);
                    let info = WorktreeInfo::synthetic(
                        repo_display.clone(),
                        wt_display,
                        current_branch.clone(),
                        current_head.clone(),
                        false,
                    );
                    let changed_files = worktree::changed_files(&info).await;
                    let dirty = !changed_files.is_empty();
                    entries.push(ListedWorktree {
                        repo_root: info.repo_root,
                        path: info.path,
                        branch: info.branch,
                        base_commit: info.base_commit,
                        dirty,
                        changed_files,
                    });
                }
            }
            current_head.clear();
            current_branch.clear();
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            current_path = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            current_head = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("branch ") {
            current_branch = rest
                .trim()
                .strip_prefix("refs/heads/")
                .unwrap_or(rest.trim())
                .to_string();
        }
    }

    Ok(entries)
}

pub(crate) async fn merge_worktree(
    repo_root: &str,
    path: &str,
    branch: Option<&str>,
    base_commit: Option<&str>,
    commit_message: Option<&str>,
    remove_after: bool,
) -> Result<Value, Failure> {
    let (canon_repo, canon_wt) = confine_existing_worktree(repo_root, path)?;

    let status_out = git_output(&canon_wt, &["status", "--porcelain"]).await?;
    if !status_out.trim().is_empty() {
        let dir_label = canon_wt
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("worktree");
        let message = commit_message
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Merge session worktree {dir_label}"));
        git_output(&canon_wt, &["add", "-A"]).await?;
        git_output(&canon_wt, &["commit", "-m", &message]).await?;
    }

    let wt_sha = git_output(&canon_wt, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();

    let merge_res = git_raw(&canon_repo, &["merge", "--no-edit", &wt_sha]).await?;
    if !merge_res.status.success() {
        let conflicts = git_output(&canon_repo, &["diff", "--name-only", "--diff-filter=U"])
            .await
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        let _ = git_raw(&canon_repo, &["merge", "--abort"]).await;
        if !conflicts.is_empty() {
            return Ok(json!({
                "merged": false,
                "conflicts": conflicts,
            }));
        }
        let stderr = String::from_utf8_lossy(&merge_res.stderr)
            .trim()
            .to_string();
        return Err((
            rpc::INTERNAL_ERROR,
            if stderr.is_empty() {
                "git merge failed".to_string()
            } else {
                stderr
            },
        ));
    }

    let mut removed = false;
    if remove_after {
        remove_worktree(
            None,
            &canon_repo.to_string_lossy(),
            &canon_wt.to_string_lossy(),
            branch,
            base_commit,
            None,
        )
        .await?;
        removed = true;
    }

    Ok(json!({
        "merged": true,
        "commit": wt_sha,
        "removed": removed,
    }))
}

pub(crate) async fn remove_worktree(
    runtime: Option<&RuntimeHandle>,
    repo_root: &str,
    path: &str,
    branch: Option<&str>,
    base_commit: Option<&str>,
    session_id: Option<SessionId>,
) -> Result<(), Failure> {
    let (canon_repo, confined_wt) = confine_worktree_for_remove(repo_root, path)?;
    let info = WorktreeInfo::synthetic(
        canon_repo.to_string_lossy().into_owned(),
        confined_wt.to_string_lossy().into_owned(),
        branch.unwrap_or_default(),
        base_commit.unwrap_or_default(),
        true,
    );
    worktree::remove(&info)
        .await
        .map_err(|error| (rpc::INTERNAL_ERROR, error))?;

    if let (Some(rt), Some(sid)) = (runtime, session_id) {
        rt.set_session_worktree(sid, repo_root, None);
    }
    Ok(())
}

fn confine_existing_worktree(
    repo_root: &str,
    wt_path: &str,
) -> Result<(PathBuf, PathBuf), Failure> {
    let canon_repo = canonical_repo_root(repo_root)?;
    let pool_root = canon_repo.join(".agente").join("worktrees");
    let wt = Path::new(wt_path);
    if !wt.exists() {
        return Err((
            rpc::INVALID_PARAMS,
            format!("worktree does not exist: {wt_path}"),
        ));
    }
    let canon_wt = std::fs::canonicalize(wt).map_err(|error| {
        (
            rpc::INVALID_PARAMS,
            format!("invalid worktree path: {error}"),
        )
    })?;
    if !canon_wt.starts_with(&pool_root) || canon_wt == pool_root {
        return Err((
            rpc::INVALID_PARAMS,
            format!("worktree path escapes repository pool: {wt_path}"),
        ));
    }
    Ok((canon_repo, canon_wt))
}

fn confine_worktree_for_remove(
    repo_root: &str,
    wt_path: &str,
) -> Result<(PathBuf, PathBuf), Failure> {
    let canon_repo = canonical_repo_root(repo_root)?;
    let pool_root = canon_repo.join(".agente").join("worktrees");
    let raw = Path::new(wt_path);
    if raw.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err((
            rpc::INVALID_PARAMS,
            format!("worktree path contains '..': {wt_path}"),
        ));
    }
    if raw.exists() {
        let canon_wt = std::fs::canonicalize(raw).map_err(|error| {
            (
                rpc::INVALID_PARAMS,
                format!("invalid worktree path: {error}"),
            )
        })?;
        if !canon_wt.starts_with(&pool_root) || canon_wt == pool_root {
            return Err((
                rpc::INVALID_PARAMS,
                format!("worktree path escapes repository pool: {wt_path}"),
            ));
        }
        return Ok((canon_repo, canon_wt));
    }
    if raw.is_absolute() && raw.starts_with(&pool_root) && raw != pool_root {
        return Ok((canon_repo, raw.to_path_buf()));
    }
    Err((
        rpc::INVALID_PARAMS,
        format!("worktree path escapes repository pool: {wt_path}"),
    ))
}

fn canonical_repo_root(repo_root: &str) -> Result<PathBuf, Failure> {
    let root = Path::new(repo_root);
    if !root.is_dir() {
        return Err((
            rpc::INVALID_PARAMS,
            format!("repository root does not exist: {repo_root}"),
        ));
    }
    std::fs::canonicalize(root)
        .map_err(|error| (rpc::INVALID_PARAMS, format!("invalid repo root: {error}")))
}

fn display_path(path: &Path) -> String {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
        raw.into_owned()
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

async fn git_raw(cwd: &Path, args: &[&str]) -> Result<std::process::Output, Failure> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output().await.map_err(|error| {
        (
            rpc::INTERNAL_ERROR,
            format!("git {}: {error}", args.join(" ")),
        )
    })
}

async fn git_output(cwd: &Path, args: &[&str]) -> Result<String, Failure> {
    let out = git_raw(cwd, args).await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err((
            rpc::INTERNAL_ERROR,
            if stderr.is_empty() {
                format!("git {} failed with {}", args.join(" "), out.status)
            } else {
                stderr
            },
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use agente_runtime::{RuntimeConfig, RuntimeSupervisor};

    fn git_sync(cwd: &Path, args: &[&str]) {
        let mut cmd = std::process::Command::new("git");
        cmd.args(args).current_dir(cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let status = cmd.status().unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git_sync(dir, &["init", "-b", "main"]);
        git_sync(dir, &["config", "user.name", "Test User"]);
        git_sync(dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(dir.join("README.md"), "base\n").unwrap();
        git_sync(dir, &["add", "."]);
        git_sync(dir, &["commit", "-m", "initial"]);
    }

    #[tokio::test]
    async fn worktree_create_list_merge_conflict_and_remove_lifecycle() {
        let root =
            std::env::temp_dir().join(format!("agente-daemon-wt-test-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        init_repo(&repo);

        let rt = RuntimeSupervisor::start(
            RuntimeConfig::from_app_config(&AppConfig::default(), repo.to_string_lossy())
                .with_persistence_dir(root.join("sessions"))
                .unwrap(),
        );
        let sid = SessionId::new();
        let repo_str = repo.to_string_lossy().into_owned();

        // 1. Create and list.
        let created = create_worktree(&rt, &repo_str, Some("worker-a"), Some(sid))
            .await
            .unwrap();
        assert!(Path::new(&created.path).is_dir());
        assert_eq!(
            rt.session_meta(sid).unwrap().info.worktree,
            Some(created.clone())
        );

        std::fs::write(Path::new(&created.path).join("feature.txt"), "hello\n").unwrap();
        let listed = list_worktrees(&repo_str).await.unwrap();
        assert!(listed
            .iter()
            .any(|item| item.path == created.path && item.dirty));

        // 2. Traversal rejection outside .agente/worktrees.
        let outside = merge_worktree(&repo_str, &repo_str, None, None, None, false).await;
        assert!(outside.is_err());

        // 3. Clean merge with remove_after = true.
        let merged = merge_worktree(
            &repo_str,
            &created.path,
            Some(&created.branch),
            Some(&created.base_commit),
            Some("Add feature"),
            true,
        )
        .await
        .unwrap();
        assert_eq!(merged["merged"], true);
        assert_eq!(merged["removed"], true);
        assert_eq!(
            std::fs::read_to_string(repo.join("feature.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "hello\n"
        );
        assert!(!Path::new(&created.path).exists());

        // 4. Conflict detection + clean merge --abort + explicit remove.
        let conflict_wt = create_worktree(&rt, &repo_str, Some("worker-b"), None)
            .await
            .unwrap();
        std::fs::write(Path::new(&conflict_wt.path).join("README.md"), "branch\n").unwrap();
        std::fs::write(repo.join("README.md"), "main-change\n").unwrap();
        git_sync(&repo, &["add", "README.md"]);
        git_sync(&repo, &["commit", "-m", "main edit"]);

        let conflicted = merge_worktree(
            &repo_str,
            &conflict_wt.path,
            Some(&conflict_wt.branch),
            Some(&conflict_wt.base_commit),
            None,
            false,
        )
        .await
        .unwrap();
        assert_eq!(conflicted["merged"], false);
        assert_eq!(conflicted["conflicts"], json!(["README.md"]));
        assert_eq!(
            std::fs::read_to_string(repo.join("README.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "main-change\n"
        );

        remove_worktree(
            None,
            &repo_str,
            &conflict_wt.path,
            Some(&conflict_wt.branch),
            Some(&conflict_wt.base_commit),
            None,
        )
        .await
        .unwrap();
        assert!(!Path::new(&conflict_wt.path).exists());

        let _ = std::fs::remove_dir_all(root);
    }
}
