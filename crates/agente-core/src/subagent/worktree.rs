//! Git worktree isolation for subagents.
//!
//! Every child normally runs in its own checkout under
//! `<repo>/.agente/worktrees/<short-id>`, seeded with the parent's uncommitted
//! changes so the child sees exactly what the user sees. A small pool keeps one
//! checkout warm; a warm worktree is reset and handed to the next child in
//! milliseconds, while cold creation runs on a blocking thread and never stalls
//! the parent loop.
//!
//! The parent root is never mutated by a child. When a child finishes with a
//! dirty worktree (seeded changes excluded), the worktree is kept for review;
//! untouched worktrees are reset and returned to the pool.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, SystemTime};

/// One child's isolated checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeInfo {
    pub repo_root: String,
    pub path: String,
    pub branch: String,
    /// Commit the checkout started from.
    pub base_commit: String,
    /// True once the child changed anything beyond the seeded parent state.
    pub dirty: bool,
    /// Relative path plus content hash of every file seeded from the parent's
    /// dirty state. Comparing these at release time detects child edits even
    /// when the child changed a file the parent had already modified.
    seed_fingerprint: Vec<(String, u64)>,
}

impl WorktreeInfo {
    /// Build a record without a seed fingerprint. Used by UI fixtures; live
    /// records always come from [`WorktreePool::acquire`].
    pub fn synthetic(
        repo_root: impl Into<String>,
        path: impl Into<String>,
        branch: impl Into<String>,
        base_commit: impl Into<String>,
        dirty: bool,
    ) -> Self {
        Self {
            repo_root: repo_root.into(),
            path: path.into(),
            branch: branch.into(),
            base_commit: base_commit.into(),
            dirty,
            seed_fingerprint: Vec::new(),
        }
    }

    /// Short label for the UI (`explore · a1b2c3d4`).
    pub fn label(&self) -> &str {
        Path::new(&self.path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("worktree")
    }
}

/// Warm checkouts kept ready. Only writing children take one (read-only
/// children run in the parent root), and they tend to arrive in pairs when
/// the model fans out, so two warm ones cover the common burst.
const WARM_TARGET: usize = 2;

/// Worktree directories older than this are collected at pool creation. Only
/// checkouts explicitly marked [`STATE_DISPOSABLE`] are ever removed.
const STALE_AGE_SECS: u64 = 24 * 60 * 60;

/// Ownership marker written on disk next to a checkout (never inside it, so it
/// cannot show up as an untracked file): a child currently holds the checkout.
const STATE_RUNNING: &str = "running";
/// The checkout was released clean and is safe to reuse or delete.
const STATE_DISPOSABLE: &str = "disposable";
/// The child changed something; the checkout is kept for review.
const STATE_RETAINED: &str = "retained";

/// Checkouts claimed by a resuming child. A resumed child runs in the same
/// directory as its source, so two concurrent resumes of one source must not
/// both enter it.
static RESUME_CLAIMS: OnceLock<StdMutex<HashSet<PathBuf>>> = OnceLock::new();

fn claim_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Claim a terminal child's checkout for a resume. Returns `false` when
/// another resume already holds it.
pub fn claim_for_resume(path: &Path) -> bool {
    let claims = RESUME_CLAIMS.get_or_init(|| StdMutex::new(HashSet::new()));
    claims
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(claim_key(path))
}

/// Release a resume claim once the resumed child no longer needs it.
pub fn release_resume_claim(path: &Path) {
    if let Some(claims) = RESUME_CLAIMS.get() {
        claims
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&claim_key(path));
    }
}

static POOLS: OnceLock<StdMutex<HashMap<PathBuf, Arc<WorktreePool>>>> = OnceLock::new();

/// Walk up from `start` until a directory containing `.git` is found.
pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut dir = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };
    loop {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Shared pool for a repository. Creation is cheap after the first call and
/// runs the stale-worktree GC once per process.
pub fn pool_for(repo_root: &Path) -> Arc<WorktreePool> {
    let key = std::fs::canonicalize(repo_root).unwrap_or_else(|_| repo_root.to_path_buf());
    let pools = POOLS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut guard = pools
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(pool) = guard.get(&key) {
        return Arc::clone(pool);
    }
    let pool = Arc::new(WorktreePool::new(repo_root.to_path_buf()));
    pool.gc();
    guard.insert(key, Arc::clone(&pool));
    pool
}

/// Acquire an isolated checkout for a child on a blocking thread.
pub async fn acquire_for(repo_root: &Path, label: &str) -> Option<WorktreeInfo> {
    let root = repo_root.to_path_buf();
    let label = label.to_string();
    let pool = tokio::task::spawn_blocking(move || pool_for(&root))
        .await
        .ok()?;
    pool.acquire(&label).await
}

/// Release a worktree after the child finishes. Clean worktrees return to the
/// pool; dirty ones stay on disk for review. Returns `true` when it was clean.
pub async fn release(info: &WorktreeInfo) -> bool {
    let info = info.clone();
    tokio::task::spawn_blocking(move || {
        let pool = pool_for(Path::new(&info.repo_root));
        pool.release_blocking(&info)
    })
    .await
    .unwrap_or(false)
}

/// Blocking [`release`] for callers outside the async runtime (the subagent
/// event-forwarder thread).
pub fn release_sync(info: &WorktreeInfo) -> bool {
    let pool = pool_for(Path::new(&info.repo_root));
    pool.release_blocking(info)
}

/// Remove a worktree from disk and prune git's metadata.
pub async fn remove(info: &WorktreeInfo) -> Result<(), String> {
    let info = info.clone();
    tokio::task::spawn_blocking(move || {
        let pool = pool_for(Path::new(&info.repo_root));
        pool.remove_blocking(&info)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `git status --porcelain` inside the worktree, capped.
pub async fn changed_files(info: &WorktreeInfo) -> Vec<String> {
    let path = PathBuf::from(&info.path);
    tokio::task::spawn_blocking(move || {
        git(&path, &["status", "--porcelain"])
            .map(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .take(200)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Unified diff of the child's tree against its base commit, capped.
pub async fn diff(info: &WorktreeInfo) -> Option<String> {
    let info = info.clone();
    tokio::task::spawn_blocking(move || diff_sync(&info))
        .await
        .ok()
        .flatten()
}

/// Blocking diff used by the TUI when the user opens the review view.
pub fn diff_sync(info: &WorktreeInfo) -> Option<String> {
    let path = PathBuf::from(&info.path);
    let base = info.base_commit.clone();
    let out = git(&path, &["diff", &base, "--no-color"]).ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    const CAP: usize = 512 * 1024;
    if text.len() > CAP {
        let end = crate::util::truncate_at_char_boundary(&text, CAP).len();
        text.truncate(end);
        text.push_str("\n… diff truncated …\n");
    }
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Pool state for one repository root.
pub struct WorktreePool {
    repo_root: PathBuf,
    worktrees_dir: PathBuf,
    inner: StdMutex<PoolInner>,
}

#[derive(Default)]
struct PoolInner {
    warm: Vec<PathBuf>,
    warming: usize,
}

impl WorktreePool {
    fn new(repo_root: PathBuf) -> Self {
        let worktrees_dir = repo_root.join(".agente").join("worktrees");
        Self {
            repo_root,
            worktrees_dir,
            inner: StdMutex::new(PoolInner::default()),
        }
    }

    async fn acquire(self: &Arc<Self>, label: &str) -> Option<WorktreeInfo> {
        let me = Arc::clone(self);
        let label = label.to_string();
        let info = tokio::task::spawn_blocking(move || me.acquire_blocking(&label))
            .await
            .ok()??;
        // Refill in the background so the next child skips the checkout cost.
        let me = Arc::clone(self);
        tokio::spawn(async move { me.replenish().await });
        Some(info)
    }

    fn acquire_blocking(&self, label: &str) -> Option<WorktreeInfo> {
        let short = sanitize_label(label);
        let path = self.worktrees_dir.join(&short);

        // Warm path: reuse whatever checkout release put back, not just one
        // whose directory happens to match this label. Reset it to the parent
        // HEAD and re-seed so the child sees current files.
        let warm = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            inner.warm.pop()
        };
        if let Some(warm) = warm {
            if warm.is_dir() && self.reset_to_parent_head(&warm).is_some() {
                if let Some(info) = self.seed_and_info(&warm, &short) {
                    self.write_marker(&warm, STATE_RUNNING);
                    return Some(info);
                }
            }
            self.clear_marker(&warm);
            self.force_remove(&warm);
        }

        // A retained or running checkout answers for the same label: never
        // delete it. Give the new child a distinct directory instead.
        let mut path = path;
        if matches!(
            self.marker_state(&path).as_deref(),
            Some(STATE_RETAINED) | Some(STATE_RUNNING)
        ) {
            path = self.worktrees_dir.join(format!("{short}-{}", short_uuid()));
        }

        self.force_remove(&path);
        std::fs::create_dir_all(&self.worktrees_dir).ok()?;
        let base =
            String::from_utf8_lossy(&git(&self.repo_root, &["rev-parse", "HEAD"]).ok()?.stdout)
                .trim()
                .to_string();
        let branch = format!("agente/{short}");
        let added = git(
            &self.repo_root,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                path.to_string_lossy().as_ref(),
                &base,
            ],
        )
        .map(|out| out.status.success())
        .unwrap_or(false)
            || git(
                &self.repo_root,
                &[
                    "worktree",
                    "add",
                    "--detach",
                    path.to_string_lossy().as_ref(),
                    &base,
                ],
            )
            .map(|out| out.status.success())
            .unwrap_or(false);
        if !added {
            return None;
        }

        let info = self.seed_and_info(&path, &short).or_else(|| {
            self.force_remove(&path);
            None
        });
        if info.is_some() {
            self.write_marker(&path, STATE_RUNNING);
        }
        info
    }

    /// Move a reused checkout to the parent's current HEAD. `None` when git
    /// refuses.
    fn reset_to_parent_head(&self, path: &Path) -> Option<String> {
        let base =
            String::from_utf8_lossy(&git(&self.repo_root, &["rev-parse", "HEAD"]).ok()?.stdout)
                .trim()
                .to_string();
        let reset = git(path, &["reset", "--hard", "--quiet", &base]).ok()?;
        if !reset.status.success() {
            return None;
        }
        let clean = git(path, &["clean", "-fdq"]).ok()?;
        if !clean.status.success() {
            return None;
        }
        Some(base)
    }

    /// Apply the parent's uncommitted state to a fresh checkout and build the
    /// info record. `None` when the checkout is unusable.
    ///
    /// Files are copied rather than patch-applied: `git apply` is fragile
    /// around `core.autocrlf`, and a worktree checkout can normalize line
    /// endings differently from the parent tree.
    fn seed_and_info(&self, path: &Path, short: &str) -> Option<WorktreeInfo> {
        let repo = &self.repo_root;
        let mut fingerprint: Vec<(String, u64)> = Vec::new();
        let seed_one = |rel: String, fingerprint: &mut Vec<(String, u64)>| {
            // Agente's own checkout pool must never be seeded into a child:
            // nested worktrees and their ownership markers would make the
            // child look dirty.
            if rel == ".agente/worktrees" || rel.starts_with(".agente/worktrees/") {
                return;
            }
            let from = repo.join(&rel);
            let to = path.join(&rel);
            if from.exists() {
                if let Some(parent) = to.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                if std::fs::copy(&from, &to).is_ok() {
                    if let Some(hash) = file_hash(&to) {
                        fingerprint.push((rel, hash));
                    }
                }
            } else {
                let _ = std::fs::remove_file(&to);
            }
        };
        // Tracked changes against HEAD (staged + unstaged).
        if let Ok(out) = git(repo, &["diff", "--name-only", "-z", "HEAD"]) {
            for rel in out
                .stdout
                .split(|byte| *byte == 0)
                .filter(|s| !s.is_empty())
            {
                seed_one(String::from_utf8_lossy(rel).to_string(), &mut fingerprint);
            }
        }
        // Untracked files (respecting the parent's ignore rules).
        if let Ok(out) = git(repo, &["ls-files", "--others", "--exclude-standard", "-z"]) {
            for rel in out
                .stdout
                .split(|byte| *byte == 0)
                .filter(|s| !s.is_empty())
            {
                let rel = String::from_utf8_lossy(rel).to_string();
                if !fingerprint.iter().any(|(seeded, _)| seeded == &rel) {
                    seed_one(rel, &mut fingerprint);
                }
            }
        }
        let base_commit = String::from_utf8_lossy(&git(path, &["rev-parse", "HEAD"]).ok()?.stdout)
            .trim()
            .to_string();
        Some(WorktreeInfo {
            repo_root: repo.to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            branch: format!("agente/{short}"),
            base_commit,
            dirty: false,
            seed_fingerprint: fingerprint,
        })
    }

    /// True when the child changed anything past the seeded parent state.
    fn is_dirty(&self, info: &WorktreeInfo) -> bool {
        let path = Path::new(&info.path);
        // Committed work on the child branch also counts.
        let committed = git(
            path,
            &[
                "rev-list",
                "--count",
                &format!("{}..HEAD", info.base_commit),
            ],
        )
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() != "0")
        .unwrap_or(false);
        if committed {
            return true;
        }
        // Any status entry whose path was not seeded is the child's own change.
        if let Ok(out) = git(path, &["status", "--porcelain", "-z"]) {
            let seeded: std::collections::HashSet<&str> = info
                .seed_fingerprint
                .iter()
                .map(|(rel, _)| rel.as_str())
                .collect();
            let mut fields = out.stdout.split(|byte| *byte == 0);
            while let Some(entry) = fields.next() {
                if entry.len() <= 3 {
                    continue;
                }
                let rel = String::from_utf8_lossy(&entry[3..]).to_string();
                if !seeded.contains(rel.as_str()) {
                    // `git status` can collapse an untracked directory to one
                    // entry (`.agente/`). That is not a child change when the
                    // seeded snapshot contains only files below it.
                    let prefix = format!("{}/", rel.trim_end_matches('/'));
                    if !info
                        .seed_fingerprint
                        .iter()
                        .any(|(seeded_rel, _)| seeded_rel.starts_with(&prefix))
                    {
                        return true;
                    }
                }
                // Rename/copy entries carry the source path in the next field.
                let code = entry[0];
                if code == b'R' || code == b'C' {
                    let _ = fields.next();
                }
            }
        }
        // Seeded files must still match their parent snapshot byte for byte.
        for (rel, hash) in &info.seed_fingerprint {
            match file_hash(&path.join(rel)) {
                Some(current) if current == *hash => {}
                _ => return true,
            }
        }
        false
    }

    fn release_blocking(&self, info: &WorktreeInfo) -> bool {
        let path = PathBuf::from(&info.path);
        release_resume_claim(&path);
        if self.is_dirty(info) {
            self.write_marker(&path, STATE_RETAINED);
            return false;
        }
        let _ = git(&path, &["reset", "--hard", "--quiet", "HEAD"]);
        let _ = git(&path, &["clean", "-fdq"]);
        self.write_marker(&path, STATE_DISPOSABLE);
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !inner.warm.contains(&path) {
            inner.warm.push(path);
        }
        drop(inner);
        true
    }

    fn remove_blocking(&self, info: &WorktreeInfo) -> Result<(), String> {
        let path = PathBuf::from(&info.path);
        release_resume_claim(&path);
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            inner.warm.retain(|warm| warm != &path);
        }
        self.force_remove(&path);
        self.clear_marker(&path);
        let _ = git(&self.repo_root, &["worktree", "prune"]);
        Ok(())
    }

    /// `git worktree remove --force`, falling back to a directory delete when
    /// git refuses (locked files on Windows, half-created dirs).
    fn force_remove(&self, path: &Path) {
        if !path.exists() {
            return;
        }
        let removed = git(
            &self.repo_root,
            &[
                "worktree",
                "remove",
                "--force",
                path.to_string_lossy().as_ref(),
            ],
        )
        .map(|out| out.status.success())
        .unwrap_or(false);
        if !removed {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    /// Reset-and-return path for the next child. Cold creation is expensive,
    /// so this always runs on the blocking pool first.
    async fn replenish(self: &Arc<Self>) {
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if inner.warm.len() + inner.warming >= WARM_TARGET {
                return;
            }
            inner.warming += 1;
        }
        let me = Arc::clone(self);
        let created = tokio::task::spawn_blocking(move || me.create_warm_blocking())
            .await
            .ok()
            .flatten();
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.warming = inner.warming.saturating_sub(1);
        if let Some(path) = created {
            if !inner.warm.contains(&path) {
                inner.warm.push(path);
            }
        }
    }

    fn create_warm_blocking(&self) -> Option<PathBuf> {
        let label = format!("warm-{}", short_uuid());
        let path = self.worktrees_dir.join(&label);
        std::fs::create_dir_all(&self.worktrees_dir).ok()?;
        self.force_remove(&path);
        let base =
            String::from_utf8_lossy(&git(&self.repo_root, &["rev-parse", "HEAD"]).ok()?.stdout)
                .trim()
                .to_string();
        let branch = format!("agente/{label}");
        let ok = git(
            &self.repo_root,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                path.to_string_lossy().as_ref(),
                &base,
            ],
        )
        .map(|out| out.status.success())
        .unwrap_or(false);
        if !ok {
            return None;
        }
        self.write_marker(&path, STATE_DISPOSABLE);
        Some(path)
    }

    /// Sidecar marker path for a checkout (`<dir>/<name>.state`). Never inside
    /// the checkout, so it cannot pollute `git status`.
    fn marker_path(&self, path: &Path) -> Option<PathBuf> {
        let name = path.file_name()?.to_str()?;
        Some(self.worktrees_dir.join(format!("{name}.state")))
    }

    fn write_marker(&self, path: &Path, state: &str) {
        if let Some(marker) = self.marker_path(path) {
            let _ = std::fs::write(marker, format!("{state} {}", std::process::id()));
        }
    }

    fn marker_state(&self, path: &Path) -> Option<String> {
        let marker = self.marker_path(path)?;
        let raw = std::fs::read_to_string(marker).ok()?;
        Some(
            raw.split_whitespace()
                .next()
                .unwrap_or_default()
                .to_string(),
        )
    }

    fn clear_marker(&self, path: &Path) {
        if let Some(marker) = self.marker_path(path) {
            let _ = std::fs::remove_file(marker);
        }
    }

    /// Remove stale worktree directories at process start. Only checkouts
    /// explicitly marked [`STATE_DISPOSABLE`] (clean, released) are eligible;
    /// running or retained checkouts survive any age. This keeps a crashed
    /// child's unreviewed work from being deleted by a later process.
    fn gc(&self) {
        self.gc_with_max_age(Duration::from_secs(STALE_AGE_SECS));
    }

    fn gc_with_max_age(&self, max_age: Duration) {
        let Ok(entries) = std::fs::read_dir(&self.worktrees_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if self.marker_state(&path).as_deref() != Some(STATE_DISPOSABLE) {
                continue;
            }
            let stale = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .map(|age| age > max_age)
                .unwrap_or(false);
            if stale {
                self.force_remove(&path);
                self.clear_marker(&path);
            }
        }
        let _ = git(&self.repo_root, &["worktree", "prune"]);
    }
}

fn sanitize_label(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(24)
        .collect();
    if cleaned.is_empty() {
        short_uuid()
    } else {
        cleaned
    }
}

fn short_uuid() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// Content hash for the seed fingerprint. `DefaultHasher` is per-process but
/// the fingerprint never leaves the process.
fn file_hash(path: &Path) -> Option<u64> {
    use std::hash::Hasher;
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(&bytes);
    Some(hasher.finish())
}

fn git(dir: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("git").current_dir(dir).args(args).output()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            assert!(git(dir, args).unwrap().status.success(), "git {args:?}");
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "T"]);
        std::fs::write(dir.join("tracked.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "-m", "init"]);
    }

    #[test]
    fn find_repo_root_walks_up_from_a_subdirectory() {
        let temp = tempfile::tempdir().unwrap();
        if !git_available() {
            return;
        }
        init_repo(temp.path());
        let nested = temp.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        let found = find_repo_root(&nested).unwrap();
        assert_eq!(
            std::fs::canonicalize(found).unwrap(),
            std::fs::canonicalize(temp.path()).unwrap()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn acquire_seeds_parent_dirty_state_and_release_cleans_up() {
        let temp = tempfile::tempdir().unwrap();
        if !git_available() {
            return;
        }
        init_repo(temp.path());
        // Parent dirty state: one edited tracked file + one untracked file.
        std::fs::write(temp.path().join("tracked.txt"), "one\ntwo\n").unwrap();
        std::fs::write(temp.path().join("untracked.txt"), "new\n").unwrap();

        let pool = pool_for(temp.path());
        let info = pool.acquire("child-1").await.expect("worktree");
        let wt = Path::new(&info.path);
        assert!(wt.join("tracked.txt").exists());
        assert_eq!(
            std::fs::read_to_string(wt.join("tracked.txt")).unwrap(),
            "one\ntwo\n",
            "seeded edit missing"
        );
        assert_eq!(
            std::fs::read_to_string(wt.join("untracked.txt")).unwrap(),
            "new\n",
            "seeded untracked file missing"
        );

        // No child changes: release returns true and the tree resets.
        assert!(release(&info).await, "seeded-only worktree must be clean");
        let info2 = pool.acquire("child-2").await.expect("worktree reuse");
        std::fs::write(Path::new(&info2.path).join("tracked.txt"), "child\n").unwrap();
        assert!(!release(&info2).await, "child edit must keep the worktree");
        remove(&info2).await.unwrap();
        assert!(!Path::new(&info2.path).exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn child_commit_marks_the_worktree_dirty() {
        let temp = tempfile::tempdir().unwrap();
        if !git_available() {
            return;
        }
        init_repo(temp.path());
        let pool = pool_for(temp.path());
        let info = pool.acquire("child-c").await.expect("worktree");
        let wt = Path::new(&info.path);
        std::fs::write(wt.join("tracked.txt"), "committed\n").unwrap();
        for args in [
            ["add", "."].as_slice(),
            ["commit", "--quiet", "-m", "child"].as_slice(),
        ] {
            assert!(git(wt, args).unwrap().status.success());
        }
        assert!(
            !release(&info).await,
            "a child commit must survive release for review"
        );
        assert_eq!(changed_files(&info).await.len(), 0);
        remove(&info).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn warm_checkout_is_reused_for_a_new_label() {
        let temp = tempfile::tempdir().unwrap();
        if !git_available() {
            return;
        }
        init_repo(temp.path());
        let pool = pool_for(temp.path());
        let first = pool.acquire_blocking("child-a").expect("worktree");
        let first_path = first.path.clone();
        assert!(
            pool.release_blocking(&first),
            "seeded-only checkout is clean"
        );
        // Parent edits after the release must reach the reused checkout.
        std::fs::write(temp.path().join("tracked.txt"), "one\ntwo\n").unwrap();
        let second = pool.acquire_blocking("child-b").expect("reuse");
        assert_eq!(
            second.path, first_path,
            "a released checkout must serve the next child, whatever its label"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&second.path).join("tracked.txt")).unwrap(),
            "one\ntwo\n",
            "reused checkout must be re-seeded from the parent"
        );
        pool.remove_blocking(&second).unwrap();
        assert!(!Path::new(&second.path).exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn gc_removes_only_disposable_checkouts() {
        let temp = tempfile::tempdir().unwrap();
        if !git_available() {
            return;
        }
        init_repo(temp.path());
        let pool = pool_for(temp.path());

        let running = pool.acquire_blocking("run-a").expect("running");
        let disposable = pool.acquire_blocking("clean-b").expect("clean");
        let retained = pool.acquire_blocking("dirty-c").expect("dirty");
        assert!(pool.release_blocking(&disposable));
        std::fs::write(
            Path::new(&retained.path).join("tracked.txt"),
            "child edit\n",
        )
        .unwrap();
        assert!(!pool.release_blocking(&retained), "child edit is retained");

        pool.gc_with_max_age(std::time::Duration::ZERO);

        assert!(
            Path::new(&running.path).exists(),
            "a running checkout must survive GC"
        );
        assert!(
            Path::new(&retained.path).exists(),
            "a retained checkout must survive GC at any age"
        );
        assert!(
            !Path::new(&disposable.path).exists(),
            "a disposable checkout is collected when stale"
        );

        pool.remove_blocking(&running).unwrap();
        pool.remove_blocking(&retained).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn releasing_a_checkout_frees_its_resume_claim() {
        let temp = tempfile::tempdir().unwrap();
        if !git_available() {
            return;
        }
        init_repo(temp.path());
        let pool = pool_for(temp.path());
        let info = pool.acquire_blocking("child-a").expect("worktree");
        let path = Path::new(&info.path);
        assert!(claim_for_resume(path), "first resume claims the checkout");
        assert!(!claim_for_resume(path), "a second resume is rejected");
        assert!(
            pool.release_blocking(&info),
            "seeded-only checkout is clean"
        );
        assert!(
            claim_for_resume(path),
            "release frees the claim for a later resume"
        );
        release_resume_claim(path);
        pool.remove_blocking(&info).unwrap();
    }

    #[test]
    fn resume_claims_are_exclusive() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("checkout");
        std::fs::create_dir_all(&path).unwrap();
        assert!(claim_for_resume(&path));
        assert!(!claim_for_resume(&path), "second claim must be rejected");
        release_resume_claim(&path);
        assert!(claim_for_resume(&path), "released claim is available again");
        release_resume_claim(&path);
    }
}
