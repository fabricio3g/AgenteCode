//! Project path resolution and symlink-safe containment checks.

use super::ToolError;

/// Canonical form of the project directory, cached per process: every tool
/// preparation used to re-canonicalize the same root (two syscalls per call).
/// Only canonicalized (existing) roots are cached so a path checked before the
/// directory exists never permanently pins a non-canonical form.
pub(crate) fn canonical_base_cached(project_dir: &str) -> std::path::PathBuf {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
    > = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    {
        let guard = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = guard.get(project_dir) {
            return cached.clone();
        }
    }
    let base = std::path::Path::new(project_dir);
    match std::fs::canonicalize(base) {
        Ok(canonical) => {
            let mut guard = cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.insert(project_dir.to_string(), canonical.clone());
            canonical
        }
        Err(_) => base.to_path_buf(),
    }
}

/// Resolve a path relative to the project directory and ensure it doesn't escape.
/// Returns the canonicalized path or an error if path traversal is detected.
pub fn resolve_project_path(
    path: &str,
    project_dir: &str,
) -> Result<std::path::PathBuf, ToolError> {
    let base = std::path::Path::new(project_dir);
    let target = base.join(path);

    let canonical_base = canonical_base_cached(project_dir);

    let canonical_target = match std::fs::canonicalize(&target) {
        Ok(canonical) => canonical,
        // `canonicalize` fails for not-yet-existing paths (every new-file
        // write) and for dangling symlinks. Resolving only the nearest
        // existing ancestor keeps symlinked parents (or a symlinked leaf)
        // from slipping past the check on a purely lexical fallback.
        Err(_) => canonicalize_closest_ancestor(&resolve_leaf_symlink(&target)?)?,
    };

    // Containment is compared on verbatim-prefix-stripped forms: canonicalize
    // yields `\\?\C:\...` while the fallback normalization of a not-yet-
    // existing target does not, and a raw prefix compare would deny every
    // NEW file (write_file) under a plain project root.
    if !comparable_path(&canonical_target).starts_with(comparable_path(&canonical_base)) {
        return Err(ToolError::ExecutionError(format!(
            "Access denied: '{path}' is outside the project directory"
        )));
    }

    Ok(canonical_target)
}

/// [`resolve_project_path`] for the read-only tools, which may also open
/// files bundled with a discovered skill (a user-level skill lives outside
/// the project, and its instructions point at its own `scripts/` and
/// `references/`).
pub fn resolve_read_path(path: &str, project_dir: &str) -> Result<std::path::PathBuf, ToolError> {
    resolve_project_path(path, project_dir).or_else(|denied| {
        let candidate = std::path::Path::new(path);
        match std::fs::canonicalize(candidate) {
            Ok(canonical)
                if candidate.is_absolute()
                    && crate::extensions::skills::within_skill_dir(project_dir, &canonical) =>
            {
                Ok(canonical)
            }
            _ => Err(denied),
        }
    })
}

/// Strip Windows verbatim prefixes so canonicalized and normalized paths can
/// be compared; identity on other platforms.
pub(crate) fn comparable_path(path: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        const VERBATIM: &str = r"\\?\";
        const VERBATIM_UNC: &str = r"\\?\UNC\";
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(VERBATIM_UNC) {
            return std::path::PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(VERBATIM) {
            return std::path::PathBuf::from(rest);
        }
        path.to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

/// Maximum symlink expansions allowed while resolving dangling or chained links
/// (matches POSIX `SYMLOOP_MAX` / Linux `MAXSYMLINKS`).
const MAX_SYMLINK_HOPS: usize = 40;

fn is_symlink(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Follow a leaf symlink chain (including dangling links, which `canonicalize`
/// refuses to resolve) up to [`MAX_SYMLINK_HOPS`] hops so the containment check
/// sees the real destination instead of the link's location.
fn resolve_leaf_symlink(target: &std::path::Path) -> Result<std::path::PathBuf, ToolError> {
    let mut current = target.to_path_buf();
    for _ in 0..MAX_SYMLINK_HOPS {
        if !is_symlink(&current) {
            return Ok(current);
        }
        let link = std::fs::read_link(&current).map_err(|_| {
            ToolError::ExecutionError(format!(
                "Access denied: cannot resolve symlink '{}'",
                target.display()
            ))
        })?;
        current = if link.is_absolute() {
            link
        } else {
            current.parent().map(|p| p.join(&link)).unwrap_or(link)
        };
    }
    if is_symlink(&current) {
        return Err(ToolError::ExecutionError(format!(
            "Access denied: symlink chain exceeds {MAX_SYMLINK_HOPS} hops for '{}'",
            target.display()
        )));
    }
    Ok(current)
}

/// Canonicalize the nearest existing ancestor of `target` and re-attach the
/// missing remainder. Unlike a purely lexical normalization this resolves
/// symlinked parent directories — including intermediate dangling symlink
/// directories and chained symlinks — so a new file under `link -> /outside/missing`
/// cannot slip past the project-containment check.
fn canonicalize_closest_ancestor(
    target: &std::path::Path,
) -> Result<std::path::PathBuf, ToolError> {
    let mut current = resolve_leaf_symlink(target)?;
    let mut hops = 0usize;

    'resolve: loop {
        let mut ancestor = current.as_path();
        let mut remainder: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if let Ok(canonical) = std::fs::canonicalize(ancestor) {
                let mut out = canonical;
                for component in remainder.iter().rev() {
                    if component == ".." {
                        out.pop();
                    } else if component != "." {
                        out.push(component);
                    }
                }
                return Ok(normalize_path(&out));
            }
            // An intermediate component may itself be a dangling symlink (or
            // chain of symlinks) pointing outside the project: `canonicalize`
            // fails on dangling links, so expand the link and keep resolving
            // instead of walking past it to an in-project parent.
            if is_symlink(ancestor) {
                hops += 1;
                if hops > MAX_SYMLINK_HOPS {
                    return Err(ToolError::ExecutionError(format!(
                        "Access denied: symlink chain exceeds {MAX_SYMLINK_HOPS} hops for '{}'",
                        target.display()
                    )));
                }
                let mut next = resolve_leaf_symlink(ancestor)?;
                for component in remainder.iter().rev() {
                    next.push(component);
                }
                current = next;
                continue 'resolve;
            }
            match ancestor.parent() {
                Some(parent) => {
                    match ancestor.components().next_back() {
                        Some(std::path::Component::Normal(name)) => {
                            remainder.push(name.to_os_string());
                        }
                        Some(std::path::Component::ParentDir) => {
                            remainder.push(std::ffi::OsString::from(".."));
                        }
                        _ => {}
                    }
                    ancestor = parent;
                }
                None => {
                    return Err(ToolError::ExecutionError(format!(
                        "Access denied: '{}' is outside the project directory",
                        target.display()
                    )));
                }
            }
        }
    }
}

/// Normalize a path by resolving `.` and `..` components without requiring the
/// path to exist. On Windows, verbatim paths (`\\?\...`) emit `.` and `..` as
/// `Component::Normal` rather than `CurDir`/`ParentDir`, so those are collapsed
/// here too.
fn normalize_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut result = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(p) => result.push(p.as_os_str()),
            std::path::Component::RootDir => result.push(std::path::MAIN_SEPARATOR_STR),
            std::path::Component::CurDir => {}
            std::path::Component::Normal(p) if p == "." => {}
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::Normal(p) if p == ".." => {
                result.pop();
            }
            std::path::Component::Normal(p) => result.push(p),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Best-effort symlink creation: Windows machines without Developer Mode
    /// cannot create symlinks, so those environments skip instead of failing.
    fn try_symlink_dir(original: &std::path::Path, link: &std::path::Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(original, link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(original, link).is_ok();
        if !made {
            eprintln!("skipping symlink test: cannot create symlinks on this machine");
        }
        made
    }

    #[test]
    fn resolve_project_path_rejects_new_file_through_symlinked_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        if !try_symlink_dir(&outside, &project.join("link")) {
            return;
        }

        let err = resolve_project_path("link/new.txt", &project.to_string_lossy())
            .expect_err("new file through a symlinked parent must be rejected");
        assert!(err.to_string().contains("outside the project directory"));
    }

    #[test]
    fn resolve_project_path_rejects_dangling_symlink_pointing_outside() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // Dangling on purpose: outside/target.txt is never created.
        if !try_symlink_dir(&outside.join("target.txt"), &project.join("evil")) {
            return;
        }

        let err = resolve_project_path("evil", &project.to_string_lossy())
            .expect_err("dangling symlink pointing outside must be rejected");
        assert!(err.to_string().contains("outside the project directory"));
    }

    #[test]
    fn resolve_project_path_allows_new_file_and_in_project_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("real.txt"), "x").unwrap();

        let canon_project = std::fs::canonicalize(&project).unwrap();
        let resolved = resolve_project_path("new.txt", &project.to_string_lossy()).unwrap();
        assert!(resolved.starts_with(&canon_project));

        if !try_symlink_dir(&project, &project.join("self")) {
            return;
        }
        let resolved = resolve_project_path("self/real.txt", &project.to_string_lossy()).unwrap();
        assert!(resolved.starts_with(&canon_project));
        assert_eq!(std::fs::read_to_string(&resolved).unwrap(), "x");
    }

    #[test]
    fn resolve_project_path_rejects_chained_dangling_symlinks_pointing_outside() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        if !try_symlink_dir(&outside.join("missing"), &project.join("b")) {
            return;
        }
        if !try_symlink_dir(&project.join("b"), &project.join("a")) {
            return;
        }

        let err = resolve_project_path("a", &project.to_string_lossy())
            .expect_err("chained dangling symlink pointing outside must be rejected");
        assert!(err.to_string().contains("outside the project directory"));
    }

    #[test]
    fn resolve_project_path_rejects_new_file_under_dangling_symlink_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        if !try_symlink_dir(&outside.join("missing"), &project.join("dangling_dir")) {
            return;
        }

        let err = resolve_project_path("dangling_dir/new.txt", &project.to_string_lossy())
            .expect_err("new file under dangling symlink dir pointing outside must be rejected");
        assert!(err.to_string().contains("outside the project directory"));
    }

    #[test]
    fn resolve_project_path_rejects_symlink_cycle() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        if !try_symlink_dir(&project.join("b"), &project.join("a")) {
            return;
        }
        if !try_symlink_dir(&project.join("a"), &project.join("b")) {
            return;
        }

        let err = resolve_project_path("a", &project.to_string_lossy())
            .expect_err("symlink cycle must fail closed");
        assert!(err.to_string().contains("symlink chain exceeds"));

        let err_nested = resolve_project_path("a/new.txt", &project.to_string_lossy())
            .expect_err("nested path through symlink cycle must fail closed");
        assert!(err_nested.to_string().contains("symlink chain exceeds"));
    }

    #[test]
    fn canonical_base_cached_does_not_pin_missing_project_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("created-later");
        let project_str = project.to_string_lossy().into_owned();

        let before = canonical_base_cached(&project_str);
        assert_eq!(before, project);

        std::fs::create_dir_all(&project).unwrap();
        let after = canonical_base_cached(&project_str);
        let expected = std::fs::canonicalize(&project).unwrap();
        assert_eq!(after, expected);
    }

    #[test]
    fn resolve_project_path_rejects_parent_traversal_after_nonexistent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let project_str = project.to_string_lossy().into_owned();

        let err = resolve_project_path("nonexistent/../../outside.txt", &project_str)
            .expect_err("traversal through nonexistent/../.. must be rejected");
        assert!(err.to_string().contains("outside the project directory"));

        let canon_project = std::fs::canonicalize(&project).unwrap();
        let inside = resolve_project_path("nonexistent/../inside.txt", &project_str).unwrap();
        assert_eq!(inside, canon_project.join("inside.txt"));
    }
}
