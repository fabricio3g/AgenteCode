//! Project-scoped Git operations for daemon clients (`git_v1`):
//! `git.changes`, `git.diff`, `git.revert`, `git.branches`, `git.switch_branch`,
//! and `git.pull_request`.
//!
//! Runs async `tokio::process::Command` in parallel (`tokio::join!`) off the
//! JSON-RPC reader loop, with symlink-safe project-root confinement.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use agente_protocol::rpc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::connection::{parse, Failure};

const MAX_DIFF_BYTES: usize = 400_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const GH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
struct ProjectParams {
    project_dir: String,
}

#[derive(Deserialize)]
struct PathParams {
    project_dir: String,
    path: String,
}

#[derive(Deserialize)]
struct SwitchBranchParams {
    project_dir: String,
    branch: String,
    #[serde(default)]
    create: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ChangeKind {
    Created,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ChangedFile {
    path: String,
    kind: ChangeKind,
    additions: usize,
    deletions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct GitBranch {
    name: String,
    commit: String,
    current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
}

pub(crate) async fn handle_async(method: &str, params: Value) -> Result<Value, Failure> {
    match method {
        "git.changes" => {
            let ProjectParams { project_dir } = parse(params)?;
            Ok(list_changes(&project_dir).await)
        }
        "git.diff" => {
            let PathParams { project_dir, path } = parse(params)?;
            file_diff(&project_dir, &path)
                .await
                .map_err(|error| (rpc::INVALID_PARAMS, error))
        }
        "git.revert" => {
            let PathParams { project_dir, path } = parse(params)?;
            revert_file(&project_dir, &path)
                .await
                .map(|()| json!({ "ok": true }))
                .map_err(|error| (rpc::INVALID_PARAMS, error))
        }
        "git.branches" => {
            let ProjectParams { project_dir } = parse(params)?;
            Ok(branch_state(&project_dir).await)
        }
        "git.switch_branch" => {
            let SwitchBranchParams {
                project_dir,
                branch,
                create,
            } = parse(params)?;
            Ok(switch_branch(&project_dir, &branch, create).await)
        }
        "git.pull_request" => {
            let ProjectParams { project_dir } = parse(params)?;
            Ok(pull_request_state(&project_dir).await)
        }
        _ => Err((rpc::METHOD_NOT_FOUND, format!("unknown method {method}"))),
    }
}

async fn run_cmd(
    program: &str,
    cwd: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| format!("{program} timed out"))?
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{program} exited with {}", output.status)
        } else {
            stderr
        })
    }
}

async fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    run_cmd("git", cwd, args, GIT_TIMEOUT).await
}

async fn is_git_repo(project_root: &str) -> bool {
    if project_root.is_empty() || !Path::new(project_root).is_dir() {
        return false;
    }
    git(project_root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .is_ok_and(|out| out.trim() == "true")
}

fn comparable_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        const VERBATIM: &str = r"\\?\";
        const VERBATIM_UNC: &str = r"\\?\UNC\";
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(VERBATIM_UNC) {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(VERBATIM) {
            return PathBuf::from(rest);
        }
        path.to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

/// Resolve `relative` inside `project_root`, rejecting symlink (including
/// dangling symlink) and `..` escapes.
fn resolve_in_root(project_root: &str, relative: &str) -> Result<(PathBuf, String), String> {
    let abs = agente_core::tools::resolve_project_path(relative, project_root)
        .map_err(|_| format!("Path \"{relative}\" escapes the project root"))?;
    let canon_root =
        std::fs::canonicalize(project_root).unwrap_or_else(|_| PathBuf::from(project_root));
    let abs_cmp = comparable_path(&abs);
    let root_cmp = comparable_path(&canon_root);
    let stripped = abs_cmp
        .strip_prefix(&root_cmp)
        .map_err(|_| format!("Path \"{relative}\" escapes the project root"))?;
    let rel_posix = stripped.to_string_lossy().replace('\\', "/");
    Ok((abs, rel_posix))
}

fn line_count(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let newlines = text.bytes().filter(|b| *b == b'\n').count();
    newlines + usize::from(!text.ends_with('\n'))
}

fn looks_binary(text: &str) -> bool {
    let prefix = text.as_bytes();
    let end = prefix.len().min(8000);
    prefix[..end].contains(&0)
}

fn parse_porcelain(raw: &str) -> Vec<(String, ChangeKind)> {
    let mut out = Vec::new();
    let parts: Vec<&str> = raw.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let entry = parts[i];
        i += 1;
        if entry.len() < 4 {
            continue;
        }
        let bytes = entry.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let file = entry[3..].to_string();
        let kind = if x == 'R' || x == 'C' {
            i += 1; // skip original path
            ChangeKind::Renamed
        } else if x == '?' || x == 'A' {
            ChangeKind::Created
        } else if x == 'D' || y == 'D' {
            ChangeKind::Deleted
        } else {
            ChangeKind::Modified
        };
        out.push((file, kind));
    }
    out
}

async fn list_changes(project_root: &str) -> Value {
    if !is_git_repo(project_root).await {
        return json!({ "source": "none", "files": [] });
    }
    let (status_res, numstat_res, branch_res, prefix_res) = tokio::join!(
        git(
            project_root,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                "."
            ]
        ),
        git(
            project_root,
            &["diff", "HEAD", "--numstat", "-z", "--relative"]
        ),
        git(project_root, &["rev-parse", "--abbrev-ref", "HEAD"]),
        git(project_root, &["rev-parse", "--show-prefix"])
    );
    let status = status_res.unwrap_or_default();
    let numstat = numstat_res.unwrap_or_default();
    let branch = branch_res.map(|s| s.trim().to_string()).unwrap_or_default();
    let prefix = prefix_res.map(|s| s.trim().to_string()).unwrap_or_default();

    let mut counts: HashMap<String, (usize, usize)> = HashMap::new();
    for line in numstat.split('\0') {
        let mut cols = line.splitn(3, '\t');
        if let (Some(add), Some(del), Some(path)) = (cols.next(), cols.next(), cols.next()) {
            if !path.is_empty() {
                counts.insert(
                    path.to_string(),
                    (add.parse().unwrap_or(0), del.parse().unwrap_or(0)),
                );
            }
        }
    }

    let mut files = Vec::new();
    for (raw_path, kind) in parse_porcelain(&status) {
        let rel = if prefix.is_empty() {
            raw_path
        } else if let Some(rest) = raw_path.strip_prefix(&prefix) {
            rest.to_string()
        } else {
            continue;
        };
        let (additions, deletions) = if let Some(&(a, d)) = counts.get(&rel) {
            (a, d)
        } else if kind == ChangeKind::Created {
            let full = Path::new(project_root).join(&rel);
            let text = tokio::fs::read_to_string(full).await.unwrap_or_default();
            (line_count(&text), 0)
        } else {
            (0, 0)
        };
        files.push(ChangedFile {
            path: rel,
            kind,
            additions,
            deletions,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let mut result = json!({
        "source": "git",
        "files": files,
    });
    if !branch.is_empty() && branch != "HEAD" {
        result["branch"] = Value::String(branch);
    }
    result
}

async fn file_diff(project_root: &str, rel_path: &str) -> Result<Value, String> {
    let (abs, rel) = resolve_in_root(project_root, rel_path)?;
    let after = tokio::fs::read_to_string(&abs).await.unwrap_or_default();
    let before = if is_git_repo(project_root).await {
        let spec = format!("HEAD:./{rel}");
        git(project_root, &["show", &spec])
            .await
            .unwrap_or_default()
    } else {
        String::new()
    };
    let binary = looks_binary(&before) || looks_binary(&after);
    let too_large = before.len() + after.len() > MAX_DIFF_BYTES;
    Ok(json!({
        "path": rel,
        "before": if binary || too_large { "" } else { before.as_str() },
        "after": if binary || too_large { "" } else { after.as_str() },
        "binary": binary,
        "tooLarge": too_large,
    }))
}

async fn revert_file(project_root: &str, rel_path: &str) -> Result<(), String> {
    let (abs, rel) = resolve_in_root(project_root, rel_path)?;
    if !is_git_repo(project_root).await {
        return Err(format!("No earlier version of {rel} was recorded."));
    }
    let spec = format!("HEAD:./{rel}");
    let tracked_args = ["ls-files", "--error-unmatch", "--", rel.as_str()];
    let in_head_args = ["cat-file", "-e", spec.as_str()];
    let (tracked_res, in_head_res) = tokio::join!(
        git(project_root, &tracked_args),
        git(project_root, &in_head_args)
    );
    if in_head_res.is_ok() {
        git(project_root, &["checkout", "HEAD", "--", &rel]).await?;
    } else {
        if tracked_res.is_ok() {
            let _ = git(project_root, &["rm", "--cached", "--quiet", "--", &rel]).await;
        }
        let _ = tokio::fs::remove_file(&abs).await;
    }
    Ok(())
}

fn parse_track(track: &str) -> (usize, usize) {
    let parse_after = |needle: &str| -> usize {
        track
            .find(needle)
            .and_then(|idx| {
                let rest = &track[idx + needle.len()..];
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse().ok()
            })
            .unwrap_or(0)
    };
    (parse_after("ahead "), parse_after("behind "))
}

fn parse_refs(raw: &str) -> Vec<GitBranch> {
    let mut out = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let Some(name) = parts.next().filter(|s| !s.is_empty()) else {
            continue;
        };
        let commit = parts.next().unwrap_or_default().to_string();
        let upstream = parts
            .next()
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);
        let track = parts.next().unwrap_or_default();
        let head = parts.next().unwrap_or_default().trim() == "*";
        let (ahead, behind) = parse_track(track);
        out.push(GitBranch {
            name: name.to_string(),
            commit,
            current: head,
            upstream,
            ahead,
            behind,
        });
    }
    out
}

const REF_FORMAT: &str =
    "--format=%(refname:short)\t%(objectname:short)\t%(upstream:short)\t%(upstream:track)\t%(HEAD)";

async fn list_branches(project_root: &str) -> Vec<GitBranch> {
    git(
        project_root,
        &["for-each-ref", REF_FORMAT, "--sort=refname", "refs/heads"],
    )
    .await
    .map(|raw| parse_refs(&raw))
    .unwrap_or_default()
}

async fn branch_state(project_root: &str) -> Value {
    if !is_git_repo(project_root).await {
        return json!({
            "source": "none",
            "current": null,
            "detached": false,
            "dirty": false,
            "branches": []
        });
    }
    let (branches, head_res, dirty_res) = tokio::join!(
        list_branches(project_root),
        git(project_root, &["rev-parse", "--abbrev-ref", "HEAD"]),
        git(
            project_root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=no"]
        )
    );
    let head = head_res.map(|s| s.trim().to_string()).unwrap_or_default();
    let dirty = dirty_res.is_ok_and(|out| !out.is_empty());
    if !head.is_empty() && head != "HEAD" {
        return json!({
            "source": "git",
            "current": head,
            "detached": false,
            "dirty": dirty,
            "branches": branches,
        });
    }
    let sha = git(project_root, &["rev-parse", "--short", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty());
    json!({
        "source": "git",
        "current": sha,
        "detached": true,
        "dirty": dirty,
        "branches": branches,
    })
}

async fn switch_branch(project_root: &str, name: &str, create: bool) -> Value {
    let branch = name.trim();
    if branch.is_empty() {
        return json!({ "ok": false, "error": "Enter a branch name." });
    }
    if !is_git_repo(project_root).await {
        return json!({ "ok": false, "error": "This project is not a git repository." });
    }
    if branch.starts_with('-') {
        return json!({ "ok": false, "error": format!("\"{branch}\" is not a valid branch name.") });
    }
    if create {
        let valid = git(project_root, &["check-ref-format", "--branch", branch])
            .await
            .is_ok();
        if !valid {
            return json!({ "ok": false, "error": format!("\"{branch}\" is not a valid branch name.") });
        }
    } else {
        let known = list_branches(project_root)
            .await
            .iter()
            .any(|item| item.name == branch);
        if !known {
            return json!({ "ok": false, "error": format!("No local branch named \"{branch}\".") });
        }
    }
    let result = if create {
        git(project_root, &["switch", "-c", branch]).await
    } else {
        git(project_root, &["switch", branch]).await
    };
    match result {
        Ok(_) => json!({ "ok": true, "branch": branch }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn web_url(remote: &str) -> Option<String> {
    let value = remote.trim().trim_end_matches('/');
    if let Some(rest) = value
        .strip_prefix("ssh://git@")
        .or_else(|| value.strip_prefix("git@"))
    {
        let sep = rest.find([':', '/'])?;
        let host = &rest[..sep];
        let path = rest[sep + 1..].trim_end_matches(".git");
        if host.is_empty() || path.is_empty() {
            return None;
        }
        return Some(format!("https://{host}/{path}"));
    }
    if let Some(rest) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    {
        let without_auth = rest.split_once('/').map(|(authority, path)| {
            let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
            (host, path.trim_end_matches(".git"))
        })?;
        if without_auth.0.is_empty() || without_auth.1.is_empty() {
            return None;
        }
        return Some(format!("https://{}/{}", without_auth.0, without_auth.1));
    }
    None
}

fn rollup_checks(rollup: Option<&Value>) -> &'static str {
    let Some(items) = rollup.and_then(Value::as_array).filter(|a| !a.is_empty()) else {
        return "none";
    };
    let mut pending = false;
    for item in items {
        let status = item
            .get("status")
            .or_else(|| item.get("state"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_uppercase();
        let conclusion = item
            .get("conclusion")
            .or_else(|| item.get("state"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(
            conclusion.as_str(),
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
        ) {
            return "fail";
        }
        if (!status.is_empty() && status != "COMPLETED" && status != "SUCCESS")
            || matches!(conclusion.as_str(), "PENDING" | "EXPECTED")
        {
            pending = true;
        }
    }
    if pending {
        "pending"
    } else {
        "pass"
    }
}

async fn base_branch(cwd: &str) -> Option<String> {
    if let Ok(head) = git(
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .await
    {
        if let Some(name) = head.trim().strip_prefix("origin/") {
            return Some(name.to_string());
        }
    }
    for name in ["main", "master"] {
        let ref_name = format!("refs/remotes/origin/{name}");
        if git(cwd, &["rev-parse", "--verify", "--quiet", &ref_name])
            .await
            .is_ok_and(|out| !out.trim().is_empty())
        {
            return Some(name.to_string());
        }
    }
    None
}

async fn existing_pr(cwd: &str) -> Option<Value> {
    let raw = run_cmd(
        "gh",
        cwd,
        &[
            "pr",
            "view",
            "--json",
            "number,title,url,state,isDraft,statusCheckRollup",
        ],
        GH_TIMEOUT,
    )
    .await
    .ok()?;
    let data: Value = serde_json::from_str(&raw).ok()?;
    let state = match data.get("state").and_then(Value::as_str) {
        Some("MERGED") => "MERGED",
        Some("CLOSED") => "CLOSED",
        _ => "OPEN",
    };
    Some(json!({
        "number": data.get("number").and_then(Value::as_u64)?,
        "title": data.get("title").and_then(Value::as_str).unwrap_or_default(),
        "url": data.get("url").and_then(Value::as_str).unwrap_or_default(),
        "state": state,
        "draft": data.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        "checks": rollup_checks(data.get("statusCheckRollup")),
    }))
}

fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

async fn pull_request_state(project_root: &str) -> Value {
    if !is_git_repo(project_root).await {
        return json!({
            "source": "none",
            "branch": null,
            "base": null,
            "ahead": 0,
            "compareUrl": null,
            "pr": null
        });
    }
    let branch = git(project_root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if branch.is_empty() || branch == "HEAD" {
        return json!({
            "source": "git",
            "branch": null,
            "base": null,
            "ahead": 0,
            "compareUrl": null,
            "pr": null
        });
    }
    let (base, remote, pr) = tokio::join!(
        base_branch(project_root),
        git(project_root, &["remote", "get-url", "origin"]),
        existing_pr(project_root)
    );
    let ahead = match base.as_deref() {
        Some(base_name) if base_name != branch => {
            let range = format!("refs/remotes/origin/{base_name}..HEAD");
            git(project_root, &["rev-list", "--count", &range])
                .await
                .ok()
                .and_then(|s| s.trim().parse::<usize>().ok())
                .unwrap_or(0)
        }
        _ => 0,
    };
    let web = remote.ok().and_then(|r| web_url(&r));
    let compare_url = match (web.as_deref(), base.as_deref()) {
        (Some(w), Some(b)) if b != branch && w.contains("github.com/") => Some(format!(
            "{w}/compare/{}...{}?expand=1",
            encode_uri_component(b),
            encode_uri_component(&branch)
        )),
        _ => None,
    };
    json!({
        "source": "git",
        "branch": branch,
        "base": base,
        "ahead": ahead,
        "compareUrl": compare_url,
        "pr": pr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_refs_urls_and_checks() {
        let entries =
            parse_porcelain("?? new.txt\0 M mod.rs\0 D gone.rs\0R  after.rs\0before.rs\0");
        assert_eq!(
            entries,
            vec![
                ("new.txt".into(), ChangeKind::Created),
                ("mod.rs".into(), ChangeKind::Modified),
                ("gone.rs".into(), ChangeKind::Deleted),
                ("after.rs".into(), ChangeKind::Renamed),
            ]
        );
        assert_eq!(parse_track("[ahead 3, behind 1]"), (3, 1));
        assert_eq!(
            web_url("git@github.com:fabricio3g/AgenteCode.git").as_deref(),
            Some("https://github.com/fabricio3g/AgenteCode")
        );
        assert_eq!(
            rollup_checks(Some(
                &json!([{"status":"COMPLETED","conclusion":"SUCCESS"}])
            )),
            "pass"
        );
        assert_eq!(
            rollup_checks(Some(
                &json!([{"status":"COMPLETED","conclusion":"FAILURE"}])
            )),
            "fail"
        );
    }

    #[test]
    fn resolve_in_root_blocks_parent_traversal() {
        let dir = std::env::temp_dir().join(format!("agente-git-root-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(resolve_in_root(dir.to_str().unwrap(), "../escape.txt").is_err());
        assert!(resolve_in_root(dir.to_str().unwrap(), "sub/file.txt").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_in_root_blocks_dangling_symlink_escape() {
        let tmp =
            std::env::temp_dir().join(format!("agente-git-dangling-{}", uuid::Uuid::new_v4()));
        let proj = tmp.join("proj");
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.join("missing"), proj.join("dangling")).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(outside.join("missing"), proj.join("dangling"))
            .is_ok();
        if made {
            assert!(resolve_in_root(proj.to_str().unwrap(), "dangling/file.txt").is_err());
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn lists_diffs_reverts_and_switches_branches_in_real_repo() {
        let dir = std::env::temp_dir().join(format!("agente-git-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        git(root, &["init", "-b", "main"]).await.unwrap();
        git(root, &["config", "core.autocrlf", "false"])
            .await
            .unwrap();
        git(root, &["config", "user.email", "test@example.com"])
            .await
            .unwrap();
        git(root, &["config", "user.name", "Test"]).await.unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "."]).await.unwrap();
        git(root, &["commit", "-m", "init"]).await.unwrap();

        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("new.txt"), "hello\n").unwrap();

        let changes = list_changes(root).await;
        assert_eq!(changes["source"], "git");
        assert_eq!(changes["files"].as_array().unwrap().len(), 2);

        let diff = file_diff(root, "a.txt").await.unwrap();
        assert_eq!(diff["before"], "one\n");
        assert_eq!(diff["after"], "one\ntwo\n");

        revert_file(root, "a.txt").await.unwrap();
        revert_file(root, "new.txt").await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        assert!(!dir.join("new.txt").exists());

        let switched = switch_branch(root, "feat/test", true).await;
        assert_eq!(switched["ok"], true);
        let state = branch_state(root).await;
        assert_eq!(state["current"], "feat/test");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
