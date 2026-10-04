//! File operation tools
//!
//! This module provides tools for file system operations:
//! - read_file: Read file contents with optional line range
//! - write_file: Write content to a file
//! - edit_file: Apply search-replace edits to a file
//! - list_dir: List files and directories

use super::{
    atomic_fs, ensure_not_cancelled, fuzzy_find_text, truncate_tool_output,
    with_file_mutation_queue, ToolCore, ToolError, ToolExecutionContext, ToolExecutionMode,
    ToolKind, MAX_DIR_ENTRIES, MAX_FILE_LINES,
};
use std::io::BufRead;

#[derive(Default)]
pub struct ReadFileTool;

// Doc comments on the fields below become the generated schema descriptions.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct ReadFileArgs {
    /// Path to the file to read
    #[schemars(required)]
    #[serde(alias = "file_path", alias = "filepath", alias = "file")]
    path: Option<String>,
    /// Start line (1-indexed, default: 1)
    #[serde(default)]
    start_line: Option<u64>,
    /// End line (inclusive, default: end of file)
    #[serde(default)]
    end_line: Option<u64>,
}

impl ToolCore for ReadFileTool {
    type Args = ReadFileArgs;

    fn name(&self) -> &str {
        "read_file"
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }

    fn icon(&self) -> &'static str {
        "◉"
    }

    fn description(&self) -> &str {
        "Read the contents of a file, optionally a 1-indexed line range. A whole-file read is limited to 1 MB; larger files must be read with start_line/end_line. Long lines are truncated."
    }

    async fn run(
        &self,
        args: ReadFileArgs,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let path = args
            .path
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'path' parameter".to_string()))?;

        let resolved = super::resolve_read_path(&path, project_dir)?;
        let resolved_str = resolved.to_string_lossy().to_string();

        let context = context.clone();
        tokio::task::spawn_blocking(move || {
            ensure_not_cancelled(&context.cancellation)?;
            let metadata = std::fs::metadata(&resolved).map_err(|e| {
                ToolError::ExecutionError(format!("Failed to read file {resolved_str}: {e}"))
            })?;

            let start_line = args.start_line.unwrap_or(1) as usize;
            let end_line = args.end_line.map(|v| v as usize);
            let range_requested = start_line > 1 || end_line.is_some();

            if !range_requested && metadata.len() > super::MAX_READ_FILE_BYTES {
                return Err(ToolError::ExecutionError(format!(
                    "File {resolved_str} is {} bytes (whole-file limit {}). \
                 Read it with start_line/end_line instead.",
                    metadata.len(),
                    super::MAX_READ_FILE_BYTES
                )));
            }

            if range_requested {
                // Stream the range so a huge file never lands in memory whole.
                let file = std::fs::File::open(&resolved).map_err(|e| {
                    ToolError::ExecutionError(format!("Failed to read file {resolved_str}: {e}"))
                })?;
                let mut stream = std::io::BufReader::with_capacity(64 * 1024, file);
                let mut line = String::new();
                atomic_fs::record_read_partial(&resolved);

                let mut selected: Vec<String> = Vec::new();
                let mut total = 0usize;
                let mut hit_line_cap = false;
                let mut stopped_at_end_line = false;
                loop {
                    ensure_not_cancelled(&context.cancellation)?;
                    line.clear();
                    if stream.read_line(&mut line).map_err(|e| {
                        ToolError::ExecutionError(format!(
                            "Failed to read file {resolved_str}: {e}"
                        ))
                    })? == 0
                    {
                        break;
                    }
                    if line.ends_with('\n') {
                        line.pop();
                        if line.ends_with('\r') {
                            line.pop();
                        }
                    }
                    total += 1;
                    let before_end = end_line.map(|e| total <= e).unwrap_or(true);
                    if total >= start_line && before_end {
                        if selected.len() >= MAX_FILE_LINES {
                            hit_line_cap = true;
                            break;
                        }
                        selected.push(cap_line(&line));
                    }
                    if end_line.is_some_and(|e| total >= e) {
                        stopped_at_end_line = true;
                        break;
                    }
                }

                if selected.is_empty() {
                    let end = end_line.unwrap_or(total).min(total).max(start_line);
                    let plus = if stopped_at_end_line || hit_line_cap {
                        "+"
                    } else {
                        ""
                    };
                    return Ok(format!(
                        "[No lines in range {start_line}-{end} of {total}{plus}]"
                    ));
                }

                let last_shown = start_line.saturating_add(selected.len()).saturating_sub(1);
                let body = selected.join("\n");
                if hit_line_cap {
                    // Lead with the incomplete-view signal and the exact next call.
                    // A trailing note is read as commentary; agents overwhelmingly
                    // stop after the first chunk (see Claude Code's PARTIAL view
                    // change and the "Agents Don't Paginate" telemetry study).
                    let next = last_shown.saturating_add(1);
                    return Ok(format!(
                        "[PARTIAL view — lines {start_line}-{last_shown} of {total}+; \
                     {MAX_FILE_LINES}-line read cap]\n\
                     next: read_file with start_line={next}\n\n{body}"
                    ));
                }

                let plus = if stopped_at_end_line { "+" } else { "" };
                return Ok(format!(
                    "[Lines {start_line}-{last_shown} of {total}{plus}]\n{body}"
                ));
            }

            let content = std::fs::read_to_string(&resolved).map_err(|e| {
                ToolError::ExecutionError(format!("Failed to read file {resolved_str}: {e}"))
            })?;

            // Record before any early return so an empty file still counts as read.
            atomic_fs::record_read(&resolved, &content);

            let lines: Vec<&str> = content.lines().collect();
            let total = lines.len();
            if total == 0 {
                return Ok("[File is empty]".to_string());
            }
            let start = start_line.saturating_sub(1).min(total);
            let end = end_line
                .map(|e| e.max(1))
                .unwrap_or(total)
                .min(total)
                .max(start);

            let selected: Vec<String> = lines[start..end]
                .iter()
                .map(|line| cap_line(line))
                .collect();
            let mut result = selected.join("\n");

            if result.is_empty() {
                result = format!("[No lines in range {}-{} of {}]", start + 1, end, total);
            }

            if start_line > 1 {
                result = format!("[Lines {}-{} of {}]\n{}", start + 1, end, total, result);
            }

            ensure_not_cancelled(&context.cancellation)?;
            Ok(truncate_tool_output(&result, MAX_FILE_LINES, "head"))
        })
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Read task failed: {e}")))?
    }
}

/// Cap one line at [`super::MAX_LINE_BYTES`] on a char boundary.
fn cap_line(line: &str) -> String {
    if line.len() <= super::MAX_LINE_BYTES {
        line.to_string()
    } else {
        format!(
            "{}... [line truncated]",
            crate::util::truncate_at_char_boundary(line, super::MAX_LINE_BYTES)
        )
    }
}

#[derive(Default)]
pub struct WriteFileTool;

#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct WriteFileArgs {
    /// Path to the file to write
    #[schemars(required)]
    #[serde(alias = "file_path", alias = "filepath", alias = "file")]
    path: Option<String>,
    /// Content to write to the file
    #[schemars(required)]
    #[serde(alias = "text", alias = "contents")]
    content: Option<String>,
}

impl ToolCore for WriteFileTool {
    type Args = WriteFileArgs;

    fn name(&self) -> &str {
        "write_file"
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Write
    }

    fn icon(&self) -> &'static str {
        "✎"
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    fn description(&self) -> &str {
        "Write content to a file. Creates parent directories if needed. Overwrites existing files, but an existing file must be read with read_file first and be unchanged on disk since."
    }

    async fn run(
        &self,
        args: WriteFileArgs,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let path = args
            .path
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'path' parameter".to_string()))?;
        let content = args.content.ok_or_else(|| {
            ToolError::InvalidArguments("Missing 'content' parameter".to_string())
        })?;

        let resolved = super::resolve_project_path(&path, project_dir)?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let queue_key = resolved_str.clone();

        with_file_mutation_queue(
            &queue_key,
            context.cancellation.clone(),
            move |signal| async move {
                if let Some(parent) = resolved.parent() {
                    if !parent.as_os_str().is_empty() {
                        tokio::fs::create_dir_all(parent).await.map_err(|e| {
                            ToolError::ExecutionError(format!("Failed to create directory: {e}"))
                        })?;
                    }
                }

                atomic_fs::ensure_fresh_full_overwrite(&resolved).await?;
                ensure_not_cancelled(&signal)?;
                atomic_fs::write_and_record(&resolved, &content).await?;

                Ok(format!(
                    "Successfully wrote {} bytes to {}",
                    content.len(),
                    resolved_str
                ))
            },
        )
        .await
    }
}

#[derive(Default)]
pub struct EditFileTool;

#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct EditFileArgs {
    /// Path to the file to edit
    #[schemars(required)]
    #[serde(alias = "file_path", alias = "filepath", alias = "file")]
    path: Option<String>,
    /// Legacy single-edit search text (supports fuzzy matching)
    #[serde(default)]
    #[serde(alias = "query", alias = "pattern", alias = "find")]
    search: Option<String>,
    /// Legacy single-edit replacement text
    #[serde(default)]
    #[serde(alias = "replacement")]
    replace: Option<String>,
    /// One or more targeted replacements. Each edit is matched against the original file.
    #[serde(default, deserialize_with = "deserialize_tolerant_edits")]
    edits: Option<Vec<FileEdit>>,
}

/// One targeted replacement inside `edit_file`'s `edits` array.
#[derive(Debug, Default, Clone, serde::Deserialize, schemars::JsonSchema)]
pub struct FileEdit {
    /// Exact text to find. Must be unique in the file.
    // Legacy key aliases stay accepted exactly like the old hand parser did.
    // (No `#[serde(default)]`: Option fields are implicitly optional, and a
    // serde default would drop the entry from the schema's required list.)
    #[serde(rename = "oldText", alias = "old_text", alias = "old")]
    #[schemars(required)]
    old_text: Option<String>,
    /// Replacement text
    #[serde(rename = "newText", alias = "new_text", alias = "new")]
    #[schemars(required)]
    new_text: Option<String>,
}

/// The old hand-rolled parser accepted shapes the typed one would reject, so
/// `edits` deserializes tolerantly: a non-array value is ignored (the legacy
/// search/replace path takes over, as before) and malformed entries surface
/// later from `run` as the same "requires an oldText/newText string" errors.
fn deserialize_tolerant_edits<'de, D>(deserializer: D) -> Result<Option<Vec<FileEdit>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = <Option<serde_json::Value> as serde::Deserialize>::deserialize(deserializer)?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let serde_json::Value::Array(items) = raw else {
        return Ok(None);
    };
    Ok(Some(
        items
            .into_iter()
            .map(|item| serde_json::from_value(item).unwrap_or_default())
            .collect(),
    ))
}

impl ToolCore for EditFileTool {
    type Args = EditFileArgs;

    fn name(&self) -> &str {
        "edit_file"
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Edit
    }

    fn icon(&self) -> &'static str {
        "✎"
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    fn description(&self) -> &str {
        "Edit a file using one or more exact targeted replacements. Every oldText must be unique and non-overlapping. Supports fuzzy matching for a single legacy search/replace call. The file must be read with read_file first and be unchanged on disk since."
    }

    async fn run(
        &self,
        args: EditFileArgs,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let EditFileArgs {
            path,
            search,
            replace,
            edits,
        } = args;
        let path = path
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'path' parameter".to_string()))?;
        // Only legacy search/replace permits fuzzy recovery. An edits array
        // promises exact matching even when it contains just one replacement.
        let exact = edits.as_ref().is_some_and(|items| !items.is_empty());
        let edits = collect_edits(search.as_deref(), replace.as_deref(), edits.as_deref())?;

        let resolved = super::resolve_project_path(&path, project_dir)?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let queue_key = resolved_str.clone();

        with_file_mutation_queue(&queue_key, context.cancellation.clone(), move |signal| async move {
            let metadata = tokio::fs::metadata(&resolved).await.map_err(|e| {
                ToolError::ExecutionError(format!("Failed to read file {resolved_str}: {e}"))
            })?;
            if metadata.len() > super::MAX_EDIT_FILE_BYTES {
                return Err(ToolError::ExecutionError(format!(
                    "File {resolved_str} is {} bytes; edit_file is limited to {} bytes. \
                     Split the change into smaller edits.",
                    metadata.len(),
                    super::MAX_EDIT_FILE_BYTES
                )));
            }
            let content = tokio::fs::read_to_string(&resolved).await.map_err(|e| {
                ToolError::ExecutionError(format!("Failed to read file {resolved_str}: {e}"))
            })?;

            let multi = edits.len() > 1;
            let mut matches: Vec<(usize, usize, String, bool)> = Vec::new();

            for (index, (old_text, new_text)) in edits.iter().enumerate() {
                let (idx, end, fuzzy) = if exact {
                    let idx = content.find(old_text.as_str()).ok_or_else(|| {
                        ToolError::ExecutionError(format!(
                            "Could not find edits[{index}] in {resolved_str}. The oldText must match exactly."
                        ))
                    })?;
                    (idx, idx + old_text.len(), false)
                } else {
                    // A silent first-match replacement is how an edit lands in
                    // the wrong place: exact text must be unique, and the fuzzy
                    // fallback must be unique after normalization too.
                    let occurrences = content.match_indices(old_text.as_str()).count();
                    if occurrences > 1 {
                        return Err(ToolError::ExecutionError(format!(
                            "Found {occurrences} occurrences of the search text in {resolved_str}. \
                             It must be unique; widen the search with more surrounding context."
                        )));
                    }
                    if occurrences == 1 {
                        let idx = content.find(old_text.as_str()).expect("counted above");
                        (idx, idx + old_text.len(), false)
                    } else {
                        let normalized_text = super::normalize_for_fuzzy_match(old_text);
                        let normalized_occurrences = super::normalize_for_fuzzy_match(&content)
                            .match_indices(&normalized_text)
                            .count();
                        if normalized_occurrences > 1 {
                            return Err(ToolError::ExecutionError(format!(
                                "Found {normalized_occurrences} similar occurrences of the search text \
                                 in {resolved_str}. It must be unique; widen the search with more \
                                 surrounding context."
                            )));
                        }
                        let m = fuzzy_find_text(&content, old_text);
                        if !m.found {
                            let preview: Vec<&str> = content.lines().take(5).collect();
                            return Err(ToolError::ExecutionError(format!(
                                "Search text not found in file {}. File starts with:\n{}",
                                resolved_str,
                                preview.join("\n")
                            )));
                        }
                        (m.index, m.end_index, m.used_fuzzy)
                    }
                };

                if exact {
                    let occurrences = content.match_indices(old_text.as_str()).count();
                    if occurrences != 1 {
                        return Err(ToolError::ExecutionError(format!(
                            "Found {occurrences} occurrences of edits[{index}] in {resolved_str}. Each oldText must be unique."
                        )));
                    }
                }

                matches.push((idx, end, new_text.clone(), fuzzy));
            }

            if multi {
                matches.sort_by_key(|m| m.0);
                for pair in matches.windows(2) {
                    if pair[0].1 > pair[1].0 {
                        return Err(ToolError::ExecutionError(format!(
                            "Overlapping edits are not allowed in {resolved_str}."
                        )));
                    }
                }
            }

            let mut new_content = content.clone();
            for (idx, end, replacement, _) in matches.iter().rev() {
                new_content = format!(
                    "{}{}{}",
                    &new_content[..*idx],
                    replacement,
                    &new_content[*end..]
                );
            }

            let first_line = matches
                .first()
                .map(|(idx, _, _, _)| content[..*idx].lines().count() + 1)
                .unwrap_or(1);
            atomic_fs::ensure_fresh(&resolved).await?;
            ensure_not_cancelled(&signal)?;
            atomic_fs::write_and_record(&resolved, &new_content).await?;

            if multi {
                Ok(format!(
                    "Successfully edited {} with {} replacements",
                    resolved_str,
                    edits.len()
                ))
            } else {
                let fuzzy_tag = if matches[0].3 { " (fuzzy match)" } else { "" };
                Ok(format!(
                    "Successfully edited {resolved_str} at line {first_line}{fuzzy_tag}"
                ))
            }
        })
        .await
    }
}

fn collect_edits(
    search: Option<&str>,
    replace: Option<&str>,
    edits: Option<&[FileEdit]>,
) -> Result<Vec<(String, String)>, ToolError> {
    if let Some(edits) = edits {
        if !edits.is_empty() {
            let mut result = Vec::with_capacity(edits.len());
            for edit in edits {
                let old_text = edit.old_text.as_deref().ok_or_else(|| {
                    ToolError::InvalidArguments(
                        "Each edits[] entry requires an oldText string".to_string(),
                    )
                })?;
                let new_text = edit.new_text.as_deref().ok_or_else(|| {
                    ToolError::InvalidArguments(
                        "Each edits[] entry requires a newText string".to_string(),
                    )
                })?;
                result.push((old_text.to_string(), new_text.to_string()));
            }
            return Ok(result);
        }
    }

    let search = search
        .ok_or_else(|| ToolError::InvalidArguments("Missing 'search' parameter".to_string()))?;
    let replace = replace
        .ok_or_else(|| ToolError::InvalidArguments("Missing 'replace' parameter".to_string()))?;
    Ok(vec![(search.to_string(), replace.to_string())])
}

#[derive(Default)]
pub struct ListDirTool;

#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct ListDirArgs {
    /// Directory path to list
    #[schemars(required)]
    path: Option<String>,
}

impl ToolCore for ListDirTool {
    type Args = ListDirArgs;

    fn name(&self) -> &str {
        "list_dir"
    }

    fn kind(&self) -> ToolKind {
        ToolKind::List
    }

    fn icon(&self) -> &'static str {
        "≡"
    }

    fn description(&self) -> &str {
        "List files and directories in a path"
    }

    async fn run(
        &self,
        args: ListDirArgs,
        project_dir: &str,
        _context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let path = args
            .path
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'path' parameter".to_string()))?;

        let resolved = super::resolve_read_path(&path, project_dir)?;
        let resolved_str = resolved.to_string_lossy().to_string();

        let mut entries = tokio::fs::read_dir(&resolved).await.map_err(|e| {
            ToolError::ExecutionError(format!("Failed to list directory {resolved_str}: {e}"))
        })?;

        let mut result = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| ToolError::ExecutionError(format!("Failed to read entry: {e}")))?
        {
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = entry
                .file_type()
                .await
                .map_err(|e| ToolError::ExecutionError(format!("Failed to get file type: {e}")))?;
            let prefix = if file_type.is_dir() {
                "[DIR]  "
            } else {
                "[FILE] "
            };
            result.push(format!("{prefix}{name}"));
        }

        result.sort();
        if result.len() > MAX_DIR_ENTRIES {
            let total = result.len();
            result.truncate(MAX_DIR_ENTRIES);
            result.push(format!(
                "[Output truncated: showing {MAX_DIR_ENTRIES} of {total} entries]"
            ));
        }
        Ok(result.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{Tool, ToolRegistry, TypedTool};
    use serde_json::json;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("agente_{}_{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn ranged_reads_preserve_crlf_unicode_and_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\r\n日\r\nlast\n").unwrap();
        let tool = ReadFileTool;
        let args = || ReadFileArgs {
            path: Some("a.txt".into()),
            start_line: Some(2),
            end_line: Some(3),
        };
        let output = tool
            .run(
                args(),
                dir.path().to_str().unwrap(),
                &ToolExecutionContext::default(),
            )
            .await
            .unwrap();
        assert_eq!(output, "[Lines 2-3 of 3+]\n日\nlast");
        let cancel = crate::cancellation::AbortController::new();
        cancel.abort();
        let context = ToolExecutionContext {
            cancellation: cancel.signal(),
            ..Default::default()
        };
        assert!(tool
            .run(args(), dir.path().to_str().unwrap(), &context)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn read_file_out_of_range_is_safe() {
        let dir = temp_dir("read_range");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "one\ntwo\nthree\n").await.unwrap();
        let tool = TypedTool::new(ReadFileTool);
        let path_arg = path.to_string_lossy().to_string();

        let res = tool
            .execute(
                json!({"path": path_arg, "start_line": 99, "end_line": 100}),
                dir.to_str().unwrap(),
            )
            .await;
        assert!(res.is_ok(), "{:?}", res.err());

        let res = tool
            .execute(
                json!({"path": path_arg, "start_line": 3, "end_line": 1}),
                dir.to_str().unwrap(),
            )
            .await;
        assert!(res.is_ok(), "{:?}", res.err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn single_array_edit_never_falls_back_to_fuzzy_matching() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        let original = "say “hello”\n";
        std::fs::write(&path, original).unwrap();
        atomic_fs::record_read(&path, original);
        let tool = TypedTool::new(EditFileTool);
        let err = tool
            .execute(
                json!({
                    "path": "a.txt",
                    "edits": [{"oldText": "say \"hello\"", "newText": "changed"}]
                }),
                dir.path().to_str().unwrap(),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("match exactly"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

        // Legacy callers explicitly retain the documented fuzzy behavior.
        let result = tool
            .execute(
                json!({
                    "path": "a.txt", "search": "say \"hello\"", "replace": "changed"
                }),
                dir.path().to_str().unwrap(),
            )
            .await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "changed\n");
    }

    #[tokio::test]
    async fn rejected_multi_edit_does_not_partially_modify_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        let original = "one\ntwo\nthree\n";
        std::fs::write(&path, original).unwrap();
        atomic_fs::record_read(&path, original);
        let tool = TypedTool::new(EditFileTool);
        for edits in [
            json!([{"oldText": "one", "newText": "1"}, {"oldText": "missing", "newText": "2"}]),
            json!([{"oldText": "one\ntwo", "newText": "1"}, {"oldText": "two\nthree", "newText": "2"}]),
        ] {
            let result = tool
                .execute(
                    json!({"path": "a.txt", "edits": edits}),
                    dir.path().to_str().unwrap(),
                )
                .await;
            assert!(result.is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
    }

    #[tokio::test]
    async fn edit_file_supports_multiple_edits() {
        let dir = temp_dir("multi_edit");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "one\ntwo\nthree\n").await.unwrap();
        atomic_fs::record_read(&path, "one\ntwo\nthree\n");
        let tool = TypedTool::new(EditFileTool);
        let path_arg = path.to_string_lossy().to_string();

        let res = tool
            .execute(
                json!({
                    "path": path_arg,
                    "edits": [
                        {"oldText": "one", "newText": "1"},
                        {"oldText": "three", "newText": "3"}
                    ]
                }),
                dir.to_str().unwrap(),
            )
            .await;
        assert!(res.is_ok(), "{:?}", res.err());
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "1\ntwo\n3\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn edit_file_rejects_non_unique_multi_edits() {
        let dir = temp_dir("multi_edit_dup");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "dup\ndup\n").await.unwrap();
        let tool = TypedTool::new(EditFileTool);
        let path_arg = path.to_string_lossy().to_string();

        let res = tool
            .execute(
                json!({
                    "path": path_arg,
                    "edits": [
                        {"oldText": "dup", "newText": "x"},
                        {"oldText": "dup", "newText": "y"}
                    ]
                }),
                dir.to_str().unwrap(),
            )
            .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().to_string().contains("unique"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn edit_file_rejects_ambiguous_legacy_search() {
        let dir = temp_dir("legacy_dup");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "dup\ndup\n").await.unwrap();
        atomic_fs::record_read(&path, "dup\ndup\n");
        let tool = TypedTool::new(EditFileTool);
        let path_arg = path.to_string_lossy().to_string();

        let err = tool
            .execute(
                json!({"path": path_arg, "search": "dup", "replace": "x"}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("2 occurrences"), "{err}");
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "dup\ndup\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_file_gates_large_files_and_caps_long_lines() {
        let dir = temp_dir("read_limits");
        let big = dir.join("big.txt");
        let line = "a".repeat(super::super::MAX_READ_FILE_BYTES as usize + 16);
        tokio::fs::write(&big, &line).await.unwrap();
        let tool = TypedTool::new(ReadFileTool);
        let path_arg = big.to_string_lossy().to_string();

        let err = tool
            .execute(json!({"path": path_arg}), dir.to_str().unwrap())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("whole-file limit"), "{err}");

        // A ranged read streams the giant line and caps it instead of refusing.
        let out = tool
            .execute(
                json!({"path": big.to_string_lossy(), "start_line": 1, "end_line": 1}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap();
        assert!(
            out.contains("[line truncated]"),
            "{}",
            &out[..out.len().min(200)]
        );

        // Small files still read whole and record for the write guard.
        let small = dir.join("small.txt");
        tokio::fs::write(&small, "one\ntwo\n").await.unwrap();
        let out = tool
            .execute(
                json!({"path": small.to_string_lossy()}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(out, "one\ntwo");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn write_file_refuses_to_overwrite_a_partially_read_file() {
        let dir = temp_dir("partial_write");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "one\ntwo\nthree\n").await.unwrap();
        let path_arg = path.to_string_lossy().to_string();

        let reader = TypedTool::new(ReadFileTool);
        let _ = reader
            .execute(
                json!({"path": path_arg, "start_line": 1, "end_line": 2}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap();

        let writer = TypedTool::new(WriteFileTool);
        let err = writer
            .execute(
                json!({"path": path_arg, "content": "x"}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("only part of the file was read"),
            "{err}"
        );
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "one\ntwo\nthree\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn write_file_rejects_unread_existing_file() {
        let dir = temp_dir("write_guard");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "old").await.unwrap();
        let tool = TypedTool::new(WriteFileTool);
        let path_arg = path.to_string_lossy().to_string();

        let err = tool
            .execute(
                json!({"path": path_arg, "content": "new"}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("read the file with read_file first"),
            "{err}"
        );
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "old");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn edit_file_legacy_single_search_replace_works() {
        let dir = temp_dir("legacy_edit");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "one\ntwo\nthree\n").await.unwrap();
        atomic_fs::record_read(&path, "one\ntwo\nthree\n");
        let tool = TypedTool::new(EditFileTool);
        let path_arg = path.to_string_lossy().to_string();

        let res = tool
            .execute(
                json!({"path": path_arg, "search": "two", "replace": "2"}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap();
        assert!(res.contains("at line 2"), "{}", res);
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "one\n2\nthree\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn edit_file_accepts_old_new_aliases_in_edits() {
        let dir = temp_dir("edit_alias");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "one\ntwo\nthree\n").await.unwrap();
        atomic_fs::record_read(&path, "one\ntwo\nthree\n");
        let tool = TypedTool::new(EditFileTool);
        let path_arg = path.to_string_lossy().to_string();

        let res = tool
            .execute(
                json!({"path": path_arg, "edits": [{"old": "one", "new": "1"}]}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap();
        assert!(res.contains("at line 1"), "{}", res);
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "1\ntwo\nthree\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn edit_file_empty_edits_array_falls_back_to_search() {
        let dir = temp_dir("edit_empty");
        let path = dir.join("a.txt");
        tokio::fs::write(&path, "one\n").await.unwrap();
        let tool = TypedTool::new(EditFileTool);
        let path_arg = path.to_string_lossy().to_string();

        let err = tool
            .execute(
                json!({"path": path_arg, "edits": []}),
                dir.to_str().unwrap(),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Missing 'search' parameter"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn file_tools_missing_argument_errors_are_preserved() {
        let tool = TypedTool::new(ReadFileTool);
        let err = tool.execute(json!({}), ".").await.unwrap_err();
        assert!(err.to_string().contains("Missing 'path' parameter"));

        let tool = TypedTool::new(WriteFileTool);
        let err = tool.execute(json!({}), ".").await.unwrap_err();
        assert!(err.to_string().contains("Missing 'path' parameter"));
        let err = tool.execute(json!({"path": "x"}), ".").await.unwrap_err();
        assert!(err.to_string().contains("Missing 'content' parameter"));

        let tool = TypedTool::new(EditFileTool);
        let err = tool.execute(json!({}), ".").await.unwrap_err();
        assert!(err.to_string().contains("Missing 'path' parameter"));
        let err = tool.execute(json!({"path": "x"}), ".").await.unwrap_err();
        assert!(err.to_string().contains("Missing 'search' parameter"));

        let tool = TypedTool::new(ListDirTool);
        let err = tool.execute(json!({}), ".").await.unwrap_err();
        assert!(err.to_string().contains("Missing 'path' parameter"));
    }

    #[tokio::test]
    async fn registry_path_runs_through_the_compat_shims() {
        let dir = temp_dir("registry_shim");
        std::fs::create_dir_all(dir.join(".agente")).unwrap();
        tokio::fs::write(dir.join("a.txt"), "one\ntwo\n")
            .await
            .unwrap();
        let registry = ToolRegistry::new(dir.to_str().unwrap());

        let out = registry
            .execute("read_file", json!({"path": "a.txt"}))
            .await
            .unwrap();
        assert_eq!(out, "one\ntwo");

        let out = registry
            .execute("list_dir", json!({"path": "."}))
            .await
            .unwrap();
        assert!(out.contains("[FILE] a.txt"));

        let out = registry
            .execute(
                "edit_file",
                json!({"path": "a.txt", "search": "two", "replace": "2"}),
            )
            .await
            .unwrap();
        assert!(out.contains("at line 2"), "{}", out);

        // b.txt is pre-created so resolve_project_path can canonicalize it
        // (non-existent paths fall back to a non-verbatim form on Windows).
        tokio::fs::write(dir.join("b.txt"), "").await.unwrap();
        let _ = registry
            .execute("read_file", json!({"path": "b.txt"}))
            .await
            .unwrap();
        let out = registry
            .execute("write_file", json!({"path": "b.txt", "content": "hi"}))
            .await
            .unwrap();
        assert!(out.contains("2 bytes"), "{}", out);

        let out = registry
            .execute("todo_write", json!({"todos": [{"content": "x"}]}))
            .await
            .unwrap();
        assert_eq!(out, "Todos updated successfully");

        let out = registry
            .execute(
                "present_plan",
                json!({"title": "T", "markdown": "## Steps"}),
            )
            .await
            .unwrap();
        assert!(out.contains("__PLAN_READY__"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_schema_keeps_required_path_and_descriptions() {
        let schema = Tool::parameters(&TypedTool::new(ReadFileTool));
        assert_eq!(schema["required"], json!(["path"]));
        assert_eq!(schema["properties"]["path"]["type"], "string");
        assert_eq!(
            schema["properties"]["path"]["description"],
            "Path to the file to read"
        );
        assert!(schema["properties"]["start_line"]["type"]
            .as_array()
            .is_some_and(|t| t.contains(&json!("integer"))));
        assert_eq!(
            schema["properties"]["start_line"]["description"],
            "Start line (1-indexed, default: 1)"
        );
        assert!(schema["properties"]["end_line"]["type"]
            .as_array()
            .is_some_and(|t| t.contains(&json!("integer"))));
        assert_eq!(
            schema["properties"]["end_line"]["description"],
            "End line (inclusive, default: end of file)"
        );
    }

    #[test]
    fn write_file_schema_keeps_required_path_and_content() {
        let schema = Tool::parameters(&TypedTool::new(WriteFileTool));
        let required = schema["required"].as_array().unwrap();
        assert!(required.contains(&json!("path")));
        assert!(required.contains(&json!("content")));
        assert_eq!(
            schema["properties"]["path"]["description"],
            "Path to the file to write"
        );
        assert_eq!(
            schema["properties"]["content"]["description"],
            "Content to write to the file"
        );
    }

    #[test]
    fn edit_file_schema_describes_edits_array() {
        let schema = Tool::parameters(&TypedTool::new(EditFileTool));
        assert_eq!(schema["required"], json!(["path"]));
        assert!(schema["properties"]["edits"]["type"]
            .as_array()
            .is_some_and(|t| t.contains(&json!("array"))));
        assert_eq!(
            schema["properties"]["edits"]["description"],
            "One or more targeted replacements. Each edit is matched against the original file."
        );
        assert_eq!(
            schema["properties"]["search"]["description"],
            "Legacy single-edit search text (supports fuzzy matching)"
        );
        // Nested entry schemas are hoisted into `definitions` (schemars 0.8).
        let items = &schema["properties"]["edits"]["items"];
        assert_eq!(items["$ref"], "#/definitions/FileEdit");
        let file_edit = &schema["definitions"]["FileEdit"];
        let required = file_edit["required"].as_array().unwrap();
        assert!(required.contains(&json!("oldText")));
        assert!(required.contains(&json!("newText")));
        assert_eq!(
            file_edit["properties"]["oldText"]["description"],
            "Exact text to find. Must be unique in the file."
        );
        assert_eq!(
            file_edit["properties"]["newText"]["description"],
            "Replacement text"
        );
    }

    #[test]
    fn list_dir_schema_keeps_required_path() {
        let schema = Tool::parameters(&TypedTool::new(ListDirTool));
        assert_eq!(schema["required"], json!(["path"]));
        assert_eq!(
            schema["properties"]["path"]["description"],
            "Directory path to list"
        );
    }
}
