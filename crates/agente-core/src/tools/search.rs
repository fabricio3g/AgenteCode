//! Search tools
//!
//! This module provides tools for searching content in files:
//! - grep: Search for regex patterns in files

use super::{ToolCore, ToolError, ToolExecutionContext, MAX_GREP_LINE_LEN};

/// Upper bounds on model-supplied search parameters. Unbounded `context` or
/// `limit` overflowed the arithmetic and let a single call grow `results` to
/// tree size before the final truncate.
const MAX_GREP_MATCHES: usize = 5_000;
const MAX_GREP_CONTEXT: usize = 50;
const MAX_FIND_RESULTS: usize = 5_000;
/// Per-file read cap; larger files are skipped and counted in the output.
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
/// Whole-scan byte budget so one call cannot read an arbitrarily large tree.
const MAX_SEARCH_SCAN_BYTES: u64 = 256 * 1024 * 1024;

/// `.gitignore`-aware, symlink-safe walk rooted at `root`. Skipping symlinks
/// matters for containment: a link inside the project can otherwise point at
/// a file outside it.
fn walker_builder(root: &std::path::Path) -> ignore::WalkBuilder {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .filter_entry(|entry| {
            !(entry.file_type().is_some_and(|t| t.is_dir())
                && matches!(
                    entry.file_name().to_str(),
                    Some(".git" | "target" | "node_modules" | ".venv")
                ))
        });
    builder
}

fn build_walker(root: &std::path::Path) -> ignore::Walk {
    walker_builder(root).build()
}

fn relative_display(root: &std::path::Path, path: &std::path::Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Arguments accepted by the `grep` tool.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct GrepArgs {
    /// Regex or literal pattern to search for
    #[serde(default)]
    pub pattern: Option<String>,
    /// Directory or file to search in (default: current directory)
    #[serde(default)]
    pub path: Option<String>,
    /// File glob pattern to include, e.g. '*.rs' or '**/*.spec.ts'
    #[serde(default)]
    pub glob: Option<String>,
    /// Alias for glob
    #[serde(default)]
    pub include: Option<String>,
    /// Case-insensitive search (default: false)
    #[serde(default)]
    pub ignore_case: Option<bool>,
    /// Treat pattern as a literal string instead of regex (default: false)
    #[serde(default)]
    pub literal: Option<bool>,
    /// Number of lines to show before and after each match (default: 0)
    #[serde(default)]
    pub context: Option<usize>,
    /// Maximum number of matches (default: 100)
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Default)]
pub struct GrepTool;

impl ToolCore for GrepTool {
    type Args = GrepArgs;

    fn name(&self) -> &str {
        "grep"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Search
    }

    fn icon(&self) -> &'static str {
        "◎"
    }

    fn description(&self) -> &str {
        "Search for a pattern in files. Supports regex or literal strings, case control, glob filtering, context lines, and result limits."
    }

    async fn run(
        &self,
        args: GrepArgs,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let pattern = args.pattern.ok_or_else(|| {
            ToolError::InvalidArguments("Missing 'pattern' parameter".to_string())
        })?;
        let path = args.path.as_deref().unwrap_or(".");
        let glob = args
            .glob
            .as_deref()
            .or(args.include.as_deref())
            .unwrap_or("*");
        let ignore_case = args.ignore_case.unwrap_or(false);
        let literal = args.literal.unwrap_or(false);
        let match_context = args.context.unwrap_or(0).min(MAX_GREP_CONTEXT);
        let limit = args.limit.unwrap_or(100).clamp(1, MAX_GREP_MATCHES);

        let pattern_source = if literal {
            regex::escape(&pattern)
        } else {
            pattern.to_string()
        };
        let re = regex::RegexBuilder::new(&pattern_source)
            .case_insensitive(ignore_case)
            .build()
            .map_err(|e| ToolError::InvalidArguments(format!("Invalid regex: {e}")))?;

        let resolved = super::resolve_read_path(path, project_dir)?;
        let include_glob = glob::Pattern::new(glob)
            .map_err(|e| ToolError::InvalidArguments(format!("Invalid glob pattern: {e}")))?;

        let tool_context = context.clone();
        let results = tokio::task::spawn_blocking(move || {
            grep_blocking(
                &re,
                &resolved,
                &include_glob,
                match_context,
                limit,
                tool_context,
            )
        })
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Search task failed: {e}")))?;

        if results.is_empty() {
            Ok("No matches found".to_string())
        } else {
            Ok(results.join("\n"))
        }
    }
}

fn grep_blocking(
    re: &regex::Regex,
    root: &std::path::Path,
    include_glob: &glob::Pattern,
    context: usize,
    limit: usize,
    tool_context: ToolExecutionContext,
) -> Vec<String> {
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Mutex,
    };
    let results = Mutex::new(Vec::<(std::path::PathBuf, Vec<String>)>::new());
    let skipped = AtomicUsize::new(0);
    let scanned = AtomicU64::new(0);
    let matches = AtomicUsize::new(0);
    let budget_hit = AtomicBool::new(false);
    // Avoid multiplying worker pools across simultaneous parent/child calls.
    // File searches and calls beyond the first two scan directly on their
    // existing blocking worker; at most two directory calls use extra workers.
    static ACTIVE_SEARCHES: AtomicUsize = AtomicUsize::new(0);
    struct ActiveSearch;
    impl Drop for ActiveSearch {
        fn drop(&mut self) {
            ACTIVE_SEARCHES.fetch_sub(1, Ordering::Relaxed);
        }
    }
    let active = ACTIVE_SEARCHES.fetch_add(1, Ordering::Relaxed) + 1;
    let _active = ActiveSearch;
    let scan = |entry: Result<ignore::DirEntry, ignore::Error>| {
        if tool_context.cancellation.is_aborted() || matches.load(Ordering::Relaxed) >= limit {
            return ignore::WalkState::Quit;
        }
        let Ok(entry) = entry else {
            return ignore::WalkState::Continue;
        };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            return ignore::WalkState::Continue;
        }
        let rel = relative_display(root, entry.path());
        if !(include_glob.matches(&rel)
            || include_glob.matches(&entry.file_name().to_string_lossy()))
        {
            return ignore::WalkState::Continue;
        }
        let Ok(metadata) = entry.metadata() else {
            return ignore::WalkState::Continue;
        };
        if metadata.len() > MAX_SEARCH_FILE_BYTES {
            skipped.fetch_add(1, Ordering::Relaxed);
            return ignore::WalkState::Continue;
        }
        if scanned
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |bytes| {
                bytes
                    .checked_add(metadata.len())
                    .filter(|n| *n <= MAX_SEARCH_SCAN_BYTES)
            })
            .is_err()
        {
            budget_hit.store(true, Ordering::Relaxed);
            return ignore::WalkState::Quit;
        }
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            return ignore::WalkState::Continue;
        };
        // Allocate context lines only when requested; preserve per-line anchors.
        let lines = (context > 0).then(|| content.lines().collect::<Vec<_>>());
        let mut output = Vec::new();
        let mut last_emitted = None;
        for (line_num, line) in content.lines().enumerate() {
            if tool_context.cancellation.is_aborted() {
                return ignore::WalkState::Quit;
            }
            if !re.is_match(line) {
                continue;
            }
            if matches
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                    (count < limit).then_some(count + 1)
                })
                .is_err()
            {
                break;
            }
            if let Some(lines) = &lines {
                let start = line_num.saturating_sub(context);
                let end = line_num.saturating_add(context + 1).min(lines.len());
                if last_emitted.is_some_and(|prev| start > prev + 1) {
                    output.push("--".to_string());
                }
                for (index, text) in lines[start..end].iter().enumerate() {
                    let actual = start + index;
                    let marker = if actual == line_num {
                        ":"
                    } else if actual < line_num {
                        "-"
                    } else {
                        "+"
                    };
                    output.push(format!(
                        "{}:{}{} {}",
                        entry.path().display(),
                        actual + 1,
                        marker,
                        truncate_search_line(text)
                    ));
                    last_emitted = Some(actual);
                }
            } else {
                output.push(format!(
                    "{}:{}: {}",
                    entry.path().display(),
                    line_num + 1,
                    truncate_search_line(line)
                ));
            }
        }
        if !output.is_empty() {
            results
                .lock()
                .unwrap()
                .push((entry.path().to_owned(), output));
        }
        ignore::WalkState::Continue
    };
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(2));
    if root.is_file() || active > 2 || threads == 1 {
        for entry in build_walker(root) {
            if scan(entry) == ignore::WalkState::Quit {
                break;
            }
        }
    } else {
        walker_builder(root)
            .threads(threads)
            .build_parallel()
            .run(|| Box::new(&scan));
    }
    let mut files = results.into_inner().unwrap();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut results: Vec<String> = files.into_iter().flat_map(|(_, lines)| lines).collect();
    if matches.load(Ordering::Relaxed) >= limit {
        results.push(format!(
            "[Truncated: showing {limit} matches; use limit/context to narrow]"
        ));
    }
    let skipped_files = skipped.load(Ordering::Relaxed);
    if skipped_files > 0 {
        results.push(format!(
            "[{skipped_files} files skipped: larger than {MAX_SEARCH_FILE_BYTES} bytes]"
        ));
    }
    if budget_hit.load(Ordering::Relaxed) {
        results.push(format!(
            "[Scan budget reached ({MAX_SEARCH_SCAN_BYTES} bytes); narrow path/glob]"
        ));
    }
    results
}

fn truncate_search_line(line: &str) -> String {
    let mut chars = line.char_indices();
    match chars.nth(MAX_GREP_LINE_LEN) {
        Some((end, _)) => format!("{}...", &line[..end]),
        None => line.to_string(),
    }
}

/// Arguments accepted by the `find` tool.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct FindArgs {
    /// Glob pattern to match files, e.g. '*.rs' or 'src/**/*.ts'
    #[serde(default)]
    pub pattern: Option<String>,
    /// Directory to search in (default: current directory)
    #[serde(default)]
    pub path: Option<String>,
    /// Maximum number of results (default: 200)
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Default)]
pub struct FindTool;

impl ToolCore for FindTool {
    type Args = FindArgs;

    fn name(&self) -> &str {
        "find"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Search
    }

    fn icon(&self) -> &'static str {
        "◇"
    }

    fn description(&self) -> &str {
        "Search for files by glob pattern, e.g. '*.rs' or 'src/**/*.ts'. Returns paths relative to the search directory."
    }

    async fn run(
        &self,
        args: FindArgs,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let pattern = args.pattern.ok_or_else(|| {
            ToolError::InvalidArguments("Missing 'pattern' parameter".to_string())
        })?;
        let path = args.path.as_deref().unwrap_or(".");
        let limit = args.limit.unwrap_or(200).clamp(1, MAX_FIND_RESULTS);

        let resolved = super::resolve_read_path(path, project_dir)?;
        let matcher = glob::Pattern::new(&pattern)
            .map_err(|e| ToolError::InvalidArguments(format!("Invalid glob pattern: {e}")))?;

        let mut results = Vec::new();
        if resolved.is_file() {
            let name = resolved
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if matcher.matches(&name) {
                results.push(name);
            }
        } else if resolved.is_dir() {
            let tool_context = context.clone();
            results = tokio::task::spawn_blocking(move || {
                find_blocking(&matcher, &resolved, limit, tool_context)
            })
            .await
            .map_err(|e| ToolError::ExecutionError(format!("Search task failed: {e}")))?;
        } else {
            return Err(ToolError::ExecutionError(format!(
                "Path not found: {}",
                resolved.to_string_lossy()
            )));
        }

        results.sort();
        let total = results.len();
        if total > limit {
            results.truncate(limit);
            results.push(format!("[Truncated: showing {limit} of {total} results]"));
        }

        if results.is_empty() {
            Ok("No files found matching pattern".to_string())
        } else {
            Ok(results.join("\n"))
        }
    }
}

fn find_blocking(
    matcher: &glob::Pattern,
    root: &std::path::Path,
    limit: usize,
    tool_context: ToolExecutionContext,
) -> Vec<String> {
    let mut results = Vec::new();
    for entry in build_walker(root) {
        // Keep four times the requested results, matching the old traversal
        // bound, and stop early on cancellation.
        if tool_context.cancellation.is_aborted() || results.len() >= limit.saturating_mul(4) {
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = relative_display(root, entry.path());
        if matcher.matches(&rel) || matcher.matches(&name) {
            results.push(rel);
        }
    }
    results
}

#[cfg(test)]
mod extra_tests {
    use super::*;
    use crate::tools::{Tool, TypedTool};
    use serde_json::json;

    #[tokio::test]
    async fn parallel_grep_counts_matches_not_context_and_sees_external_edits() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(dir.path().join(name), "before\nneedle\nafter\n").unwrap();
        }
        let tool = TypedTool::new(GrepTool);
        let args = json!({"pattern": "^needle$", "context": 1, "limit": 2});
        let output = tool
            .execute(args, dir.path().to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(
            output
                .lines()
                .filter(|line| line.ends_with(": needle"))
                .count(),
            2,
            "{output}"
        );
        assert_eq!(
            output
                .lines()
                .filter(|line| line.ends_with("- before"))
                .count(),
            2
        );
        std::fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        let output = tool
            .execute(
                json!({"pattern": "^changed$"}),
                dir.path().to_str().unwrap(),
            )
            .await
            .unwrap();
        assert!(output.contains("a.txt:1: changed"), "{output}");
    }

    #[tokio::test]
    async fn find_matches_globs_across_directories() {
        let dir = std::env::temp_dir().join(format!("agente_find_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        tokio::fs::write(dir.join("a.rs"), "fn a() {}\n")
            .await
            .unwrap();
        tokio::fs::write(dir.join("b.txt"), "hello\n")
            .await
            .unwrap();
        tokio::fs::write(dir.join("nested").join("c.rs"), "fn c() {}\n")
            .await
            .unwrap();

        let tool = TypedTool::new(FindTool);
        let result = tool
            .execute(
                json!({"pattern": "*.rs", "path": "."}),
                dir.to_str().unwrap(),
            )
            .await;
        assert!(result.is_ok(), "{:?}", result.err());
        let output = result.unwrap();
        assert!(output.contains("a.rs"));
        assert!(output.contains("nested/c.rs"));
        assert!(!output.contains("b.txt"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn grep_supports_literal_context_and_limit() {
        let dir = std::env::temp_dir().join(format!("agente_grep_opts_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        tokio::fs::write(dir.join("a.txt"), "alpha\nbeta\nalpha\ngamma\n")
            .await
            .unwrap();

        let tool = TypedTool::new(GrepTool);
        let result = tool
            .execute(
                json!({
                    "pattern": "alpha",
                    "path": ".",
                    "literal": true,
                    "context": 1,
                    "limit": 1
                }),
                dir.to_str().unwrap(),
            )
            .await;
        assert!(result.is_ok(), "{:?}", result.err());
        let output = result.unwrap();
        assert!(output.contains("alpha"));
        assert!(output.contains("beta"));
        assert!(output.contains("Truncated"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn grep_respects_gitignore() {
        let dir = std::env::temp_dir().join(format!("agente_grep_ignore_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("ignored")).unwrap();
        std::fs::write(dir.join(".gitignore"), "ignored/\nsecret.txt\n").unwrap();
        std::fs::write(dir.join("kept.txt"), "needle\n").unwrap();
        std::fs::write(dir.join("secret.txt"), "needle\n").unwrap();
        std::fs::write(dir.join("ignored").join("x.txt"), "needle\n").unwrap();

        let out = TypedTool::new(GrepTool)
            .execute(
                json!({"pattern": "needle", "path": "."}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap();
        assert!(out.contains("kept.txt"), "{out}");
        assert!(!out.contains("secret.txt"), "{out}");
        assert!(!out.contains("ignored"), "{out}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn grep_skips_files_over_the_size_cap() {
        let dir = std::env::temp_dir().join(format!("agente_grep_big_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("small.txt"), "needle\n").unwrap();
        std::fs::write(
            dir.join("big.txt"),
            format!("{}\nneedle\n", "x".repeat(1024 * 1024)),
        )
        .unwrap();

        let out = TypedTool::new(GrepTool)
            .execute(
                json!({"pattern": "needle", "path": "."}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap();
        assert!(out.contains("small.txt"), "{out}");
        assert!(!out.contains("big.txt"), "{out}");
        assert!(out.contains("files skipped"), "{out}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grep_schema_documents_args() {
        let schema = TypedTool::new(GrepTool).parameters();
        assert_eq!(
            schema["properties"]["pattern"]["description"],
            "Regex or literal pattern to search for"
        );
        assert_eq!(
            schema["properties"]["include"]["description"],
            "Alias for glob"
        );
        assert_eq!(
            schema["properties"]["limit"]["description"],
            "Maximum number of matches (default: 100)"
        );
    }

    #[test]
    fn find_schema_documents_args() {
        let schema = TypedTool::new(FindTool).parameters();
        assert_eq!(
            schema["properties"]["pattern"]["description"],
            "Glob pattern to match files, e.g. '*.rs' or 'src/**/*.ts'"
        );
        assert_eq!(
            schema["properties"]["path"]["description"],
            "Directory to search in (default: current directory)"
        );
        assert_eq!(
            schema["properties"]["limit"]["description"],
            "Maximum number of results (default: 200)"
        );
    }
}
