//! Output bounds and truncation helpers for tool responses.

pub(super) const MAX_OUTPUT_LINES: usize = 2000;
pub(super) const MAX_OUTPUT_BYTES: usize = 50 * 1024;
pub(crate) const MAX_SHELL_LINES: usize = 500;
pub(crate) const MAX_FILE_LINES: usize = 2000;
pub(crate) const MAX_DIR_ENTRIES: usize = 500;
pub(crate) const MAX_GREP_LINE_LEN: usize = 200;
/// A full `read_file` above this size is refused with a pagination hint
/// instead of being buffered whole (a multi-GB log would OOM the agent).
pub(crate) const MAX_READ_FILE_BYTES: u64 = 1024 * 1024;
/// Per-line cap so a single minified/JSONL line cannot blow the result.
pub(crate) const MAX_LINE_BYTES: usize = 2000;
/// Wholesale rewrites above this size must go through shell/split edits.
pub(crate) const MAX_EDIT_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub content: String,
    pub truncated: bool,
}

impl ToolOutput {
    pub fn new(content: String) -> Self {
        Self {
            content,
            truncated: false,
        }
    }

    pub fn truncated(content: String) -> Self {
        Self {
            content,
            truncated: true,
        }
    }
}

impl From<String> for ToolOutput {
    fn from(content: String) -> Self {
        Self::new(content)
    }
}

pub fn truncate_output(content: &str) -> ToolOutput {
    let byte_len = content.len();
    let line_count = content.lines().count();

    if byte_len <= MAX_OUTPUT_BYTES && line_count <= MAX_OUTPUT_LINES {
        return ToolOutput::new(content.to_string());
    }

    let all_lines: Vec<&str> = content.lines().collect();
    let mut truncated = false;

    let truncated_content = if all_lines.len() > MAX_OUTPUT_LINES {
        let head = MAX_OUTPUT_LINES / 2;
        let tail = MAX_OUTPUT_LINES / 2;
        let omitted = all_lines.len() - head - tail;
        let head_part = all_lines[..head].join("\n");
        let tail_part = all_lines[all_lines.len() - tail..].join("\n");
        truncated = true;
        format!("{head_part}\n\n... {omitted} lines omitted ...\n\n{tail_part}")
    } else {
        content.to_string()
    };

    let final_result = if truncated_content.len() > MAX_OUTPUT_BYTES {
        truncated = true;
        format!(
            "{}\n\n... output truncated ...",
            crate::util::truncate_at_char_boundary(&truncated_content, MAX_OUTPUT_BYTES)
        )
    } else {
        truncated_content
    };

    if truncated {
        ToolOutput::truncated(final_result)
    } else {
        ToolOutput::new(final_result)
    }
}

pub fn truncate_tool_output(output: &str, max_lines: usize, mode: &str) -> String {
    let lines: Vec<&str> = output.lines().collect();
    if lines.len() <= max_lines {
        return output.to_string();
    }
    let total = lines.len();
    match mode {
        "tail" => {
            let kept: Vec<&str> = lines.iter().rev().take(max_lines).rev().copied().collect();
            format!(
                "[Output truncated: showing last {} of {} lines]\n{}",
                max_lines,
                total,
                kept.join("\n")
            )
        }
        _ => {
            let kept: Vec<&str> = lines.iter().take(max_lines).copied().collect();
            format!(
                "[Output truncated: showing first {} of {} lines. Use start_line/end_line parameters to read specific sections.]\n{}",
                max_lines, total, kept.join("\n")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_output_new() {
        let output = ToolOutput::new("test content".to_string());
        assert_eq!(output.content, "test content");
        assert!(!output.truncated);
    }

    #[test]
    fn test_tool_output_truncated() {
        let output = ToolOutput::truncated("test content".to_string());
        assert_eq!(output.content, "test content");
        assert!(output.truncated);
    }

    #[test]
    fn truncate_output_preserves_utf8_at_byte_limit() {
        let prefix = "a".repeat(MAX_OUTPUT_BYTES - 1);
        let result = truncate_output(&format!("{prefix}🎉tail"));
        assert!(result.truncated);
        assert_eq!(
            result.content,
            format!("{prefix}\n\n... output truncated ...")
        );
    }

    #[test]
    fn test_truncate_output_empty() {
        let result = truncate_output("");
        assert_eq!(result.content, "");
        assert!(!result.truncated);
    }

    #[test]
    fn test_truncate_output_small() {
        let content = "small content";
        let result = truncate_output(content);
        assert_eq!(result.content, content);
        assert!(!result.truncated);
    }

    #[test]
    fn test_max_output_constants() {
        const {
            assert!(MAX_OUTPUT_LINES > 0);
            assert!(MAX_OUTPUT_BYTES > 0);
        }
        assert_eq!(MAX_OUTPUT_BYTES, 50 * 1024);
    }
}
