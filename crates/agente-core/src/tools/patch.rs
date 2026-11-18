//! Patch tool — apply unified diffs and patches directly to files.
//!
//! Supports standard Myers / unified diff format (`@@ -l,s +l,s @@`) with
//! header extraction, line-offset fuzz tolerance, and atomic file mutation.

use super::{
    atomic_fs, ensure_not_cancelled, resolve_project_path, with_file_mutation_queue, ToolCore,
    ToolError, ToolExecutionContext, ToolExecutionMode, ToolKind,
};

/// Arguments accepted by the `apply_patch` tool.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct PatchArgs {
    /// Target file path. If omitted, extracted from the patch header (`+++ b/...`).
    #[serde(default)]
    #[serde(alias = "file_path", alias = "filepath", alias = "file")]
    pub path: Option<String>,
    /// The unified diff / patch content to apply
    #[schemars(required)]
    #[serde(alias = "diff", alias = "unified_diff")]
    pub patch: Option<String>,
}

#[derive(Default)]
pub struct ApplyPatchTool;

#[derive(Debug)]
struct PatchHunk {
    old_start: usize,
    old_lines: Vec<String>,
    new_lines: Vec<String>,
}

impl ToolCore for ApplyPatchTool {
    type Args = PatchArgs;

    fn name(&self) -> &str {
        "apply_patch"
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Edit
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    fn description(&self) -> &str {
        "Apply a unified diff / patch to one file. Fuzzes the line offset per hunk, tolerates whitespace drift in context lines, and reports every hunk (applied, moved by N lines, or failed with the nearest actual lines). The target file must be read first and unchanged on disk since."
    }

    async fn run(
        &self,
        args: PatchArgs,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let patch_text = args
            .patch
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'patch' parameter".to_string()))?;

        // Resolve target file: either from argument or from diff header
        let path = if let Some(p) = args.path.filter(|p| !p.trim().is_empty()) {
            p
        } else {
            extract_target_file_from_patch(&patch_text).ok_or_else(|| {
                ToolError::InvalidArguments(
                    "Missing 'path' parameter and could not extract target filename from patch header"
                        .to_string(),
                )
            })?
        };

        let resolved = resolve_project_path(&path, project_dir)?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let queue_key = resolved_str.clone();

        let hunks = parse_unified_diff(&patch_text).map_err(ToolError::ExecutionError)?;
        if hunks.is_empty() {
            return Err(ToolError::ExecutionError(
                "No valid unified diff hunks found in patch".to_string(),
            ));
        }

        with_file_mutation_queue(
            &queue_key,
            context.cancellation.clone(),
            move |signal| async move {
                let metadata = tokio::fs::metadata(&resolved).await.map_err(|e| {
                    ToolError::ExecutionError(format!(
                        "Failed to read target file {resolved_str}: {e}"
                    ))
                })?;
                if metadata.len() > super::MAX_EDIT_FILE_BYTES {
                    return Err(ToolError::ExecutionError(format!(
                    "Target file {resolved_str} is {} bytes; apply_patch is limited to {} bytes.",
                    metadata.len(),
                    super::MAX_EDIT_FILE_BYTES
                )));
                }
                let original_content = tokio::fs::read_to_string(&resolved).await.map_err(|e| {
                    ToolError::ExecutionError(format!(
                        "Failed to read target file {resolved_str}: {e}"
                    ))
                })?;

                let (new_content, added, removed, report) =
                    apply_hunks_to_content(&original_content, &hunks)
                        .map_err(ToolError::ExecutionError)?;

                atomic_fs::ensure_fresh(&resolved).await?;
                ensure_not_cancelled(&signal)?;
                atomic_fs::write_and_record(&resolved, &new_content).await?;

                Ok(format!(
                    "Successfully applied patch to {resolved_str} (+{added} / -{removed} lines):\n  {}",
                    report.join("\n  ")
                ))
            },
        )
        .await
    }
}

/// Extract target file path from unified diff headers (`--- a/...`, `+++ b/...`)
fn extract_target_file_from_patch(patch: &str) -> Option<String> {
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("+++ ") {
            let clean = rest.trim();
            let clean = clean.split('\t').next().unwrap_or(clean).trim();
            let path = clean
                .strip_prefix("b/")
                .or_else(|| clean.strip_prefix("a/"))
                .unwrap_or(clean);
            if path != "/dev/null" && !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// Parse unified diff text into structured hunks
fn parse_unified_diff(patch: &str) -> Result<Vec<PatchHunk>, String> {
    let mut hunks = Vec::new();
    let mut current_hunk: Option<PatchHunk> = None;

    for line in patch.lines() {
        if line.starts_with("@@") {
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }

            // Parse hunk header: @@ -old_start[,old_count] +new_start[,new_count] @@
            let old_start = parse_hunk_header(line)?;
            current_hunk = Some(PatchHunk {
                old_start,
                old_lines: Vec::new(),
                new_lines: Vec::new(),
            });
            continue;
        }

        if let Some(ref mut hunk) = current_hunk {
            if let Some(stripped) = line.strip_prefix(' ') {
                hunk.old_lines.push(stripped.to_string());
                hunk.new_lines.push(stripped.to_string());
            } else if let Some(stripped) = line.strip_prefix('-') {
                hunk.old_lines.push(stripped.to_string());
            } else if let Some(stripped) = line.strip_prefix('+') {
                hunk.new_lines.push(stripped.to_string());
            } else if line.starts_with('\\') {
                // "\ No newline at end of file" - ignore
                continue;
            } else if line.is_empty() {
                // Empty line inside hunk treated as empty context line
                hunk.old_lines.push(String::new());
                hunk.new_lines.push(String::new());
            }
        }
    }

    if let Some(hunk) = current_hunk {
        hunks.push(hunk);
    }

    Ok(hunks)
}

fn parse_hunk_header(header: &str) -> Result<usize, String> {
    // Expected format: @@ -start,count +start,count @@
    let parts: Vec<&str> = header.split("@@").collect();
    if parts.len() < 2 {
        return Err(format!("Invalid hunk header format: {header}"));
    }
    let range_part = parts[1].trim();
    for token in range_part.split_whitespace() {
        if let Some(minus_part) = token.strip_prefix('-') {
            let num_str = minus_part.split(',').next().unwrap_or(minus_part);
            if let Ok(line_num) = num_str.parse::<usize>() {
                return Ok(line_num);
            }
        }
    }
    Ok(1)
}

/// Apply a sequence of hunks to original file content
fn apply_hunks_to_content(
    content: &str,
    hunks: &[PatchHunk],
) -> Result<(String, usize, usize, Vec<String>), String> {
    let mut file_lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
    let had_trailing_newline = content.ends_with('\n');

    let mut total_added = 0;
    let mut total_removed = 0;
    let mut line_offset: isize = 0;
    // One line per hunk: what happened to it, so a partially applied patch is
    // never reported as a success in silence.
    let mut report: Vec<String> = Vec::new();

    for (hunk_idx, hunk) in hunks.iter().enumerate() {
        if hunk.old_lines.is_empty() && hunk.new_lines.is_empty() {
            report.push(format!("#{} skipped (empty hunk)", hunk_idx + 1));
            continue;
        }

        // Target 0-indexed line in current file_lines
        let target_line = ((hunk.old_start as isize - 1) + line_offset).max(0) as usize;

        let Some((match_idx, tolerant)) =
            find_hunk_match(&file_lines, &hunk.old_lines, target_line)
        else {
            return Err(hunk_failure(&file_lines, hunk_idx, hunk, target_line));
        };

        let old_count = hunk.old_lines.len();
        let new_count = hunk.new_lines.len();

        file_lines.splice(
            match_idx..match_idx + old_count,
            hunk.new_lines.iter().cloned(),
        );

        let delta = new_count as isize - old_count as isize;
        line_offset += delta;

        total_added += hunk.new_lines.len().saturating_sub(hunk.old_lines.len());
        total_removed += hunk.old_lines.len().saturating_sub(hunk.new_lines.len());

        let moved = match_idx as isize - target_line as isize;
        let mut entry = format!("#{} applied at line {}", hunk_idx + 1, match_idx + 1);
        if moved != 0 {
            entry.push_str(&format!(" ({moved:+} lines)"));
        }
        if tolerant {
            entry.push_str(" with whitespace tolerance");
        }
        report.push(entry);
    }

    let mut result = file_lines.join("\n");
    if had_trailing_newline && !result.is_empty() {
        result.push('\n');
    }

    Ok((result, total_added, total_removed, report))
}

/// A failed hunk names the context it wanted and what the file has there, so
/// the retry can be written without another read.
fn hunk_failure(
    file_lines: &[String],
    hunk_idx: usize,
    hunk: &PatchHunk,
    target_line: usize,
) -> String {
    let wanted: Vec<String> = hunk
        .old_lines
        .iter()
        .take(3)
        .map(|line| format!("    | {line}"))
        .collect();
    let start = target_line.min(file_lines.len().saturating_sub(1));
    let actual: Vec<String> = file_lines
        .iter()
        .enumerate()
        .skip(start)
        .take(3)
        .map(|(index, line)| format!("  {:>4} | {line}", index + 1))
        .collect();
    format!(
        "Hunk #{} failed to match around line {}.\nWanted:\n{}\nFile has:\n{}",
        hunk_idx + 1,
        hunk.old_start,
        wanted.join("\n"),
        actual.join("\n")
    )
}

/// Search for the hunk within a fuzz window around the target line. Returns
/// the match position and whether whitespace tolerance was needed.
fn find_hunk_match(
    file_lines: &[String],
    old_lines: &[String],
    target: usize,
) -> Option<(usize, bool)> {
    if old_lines.is_empty() {
        return Some((target.min(file_lines.len()), false));
    }

    let n = old_lines.len();
    if n > file_lines.len() {
        return None;
    }

    let max_start = file_lines.len() - n;
    let target = target.min(max_start);

    // 1. Try the exact target line.
    if let Some(tolerant) = matches_at(file_lines, old_lines, target) {
        return Some((target, tolerant));
    }

    // 2. Search radiating outward up to 100 lines.
    let fuzz_range = 100usize;
    for offset in 1..=fuzz_range {
        if target >= offset {
            let pos = target - offset;
            if let Some(tolerant) = matches_at(file_lines, old_lines, pos) {
                return Some((pos, tolerant));
            }
        }
        if target + offset <= max_start {
            let pos = target + offset;
            if let Some(tolerant) = matches_at(file_lines, old_lines, pos) {
                return Some((pos, tolerant));
            }
        }
    }

    None
}

/// `Some(tolerant)` when every context line matches at `start`; `tolerant` is
/// true when indentation or runs of spaces/tabs had to be ignored.
fn matches_at(file_lines: &[String], old_lines: &[String], start: usize) -> Option<bool> {
    if start + old_lines.len() > file_lines.len() {
        return None;
    }
    let mut tolerant = false;
    for (i, expected) in old_lines.iter().enumerate() {
        let actual = &file_lines[start + i];
        if actual == expected {
            continue;
        }
        if actual.trim_end() == expected.trim_end() {
            tolerant = true;
            continue;
        }
        let collapse = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
        if collapse(actual) == collapse(expected) {
            tolerant = true;
            continue;
        }
        return None;
    }
    Some(tolerant)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_target_file() {
        let patch = r#"
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {}
"#;
        assert_eq!(
            extract_target_file_from_patch(patch),
            Some("src/main.rs".to_string())
        );
    }

    #[test]
    fn test_apply_simple_hunk() {
        let content = "fn main() {\n    println!(\"hello\");\n}\n";
        let patch = r#"@@ -1,3 +1,4 @@
 fn main() {
+    // greeting
     println!("hello");
 }
"#;
        let hunks = parse_unified_diff(patch).unwrap();
        assert_eq!(hunks.len(), 1);
        let (res, _, _, report) = apply_hunks_to_content(content, &hunks).unwrap();
        assert_eq!(
            res,
            "fn main() {\n    // greeting\n    println!(\"hello\");\n}\n"
        );
        assert_eq!(report, vec!["#1 applied at line 1"]);
    }

    #[test]
    fn test_apply_hunk_with_offset() {
        let content = "// Header\n// Extra line\nfn main() {\n    hello();\n}\n";
        let patch = r#"@@ -1,3 +1,3 @@
 fn main() {
-    hello();
+    world();
 }
"#;
        let hunks = parse_unified_diff(patch).unwrap();
        let (res, _, _, report) = apply_hunks_to_content(content, &hunks).unwrap();
        assert!(res.contains("world();"));
        assert!(!res.contains("hello();"));
        // The hunk declared line 1 but lives at line 3: say so instead of
        // moving silently.
        assert_eq!(report, vec!["#1 applied at line 3 (+2 lines)"]);
    }

    #[test]
    fn a_context_line_with_drifted_indentation_still_applies() {
        let content = "fn main() {\n        hello();\n}\n";
        let patch = "@@ -1,2 +1,2 @@\n fn main() {\n-    hello();\n+    world();\n";
        let hunks = parse_unified_diff(patch).unwrap();
        let (res, _, _, report) = apply_hunks_to_content(content, &hunks).unwrap();
        assert_eq!(res, "fn main() {\n    world();\n}\n");
        assert!(
            report[0].contains("with whitespace tolerance"),
            "{report:?}"
        );
    }

    #[test]
    fn a_failed_hunk_names_the_context_wanted_and_found() {
        let content = "fn main() {\n    actual();\n}\n";
        let patch = "@@ -1,2 +1,2 @@\n fn main() {\n-    missing();\n+    world();\n";
        let hunks = parse_unified_diff(patch).unwrap();
        let err = apply_hunks_to_content(content, &hunks).unwrap_err();
        assert!(err.contains("Hunk #1 failed to match"), "{err}");
        assert!(err.contains("Wanted:"), "{err}");
        assert!(err.contains("File has:"), "{err}");
        assert!(err.contains("actual();"), "{err}");
    }
}
