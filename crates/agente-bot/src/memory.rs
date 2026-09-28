//! A bot's memory is MEMORY.md: one note per line. The bot edits it a line at
//! a time, so every change is small, visible in the chat, and within the cap.

use serde::Deserialize;

use crate::DOC_CAP_CHARS;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum MemoryEdit {
    /// Add a note.
    Add { line: String },
    /// Change the one note containing `old` to `new`.
    Replace { old: String, new: String },
    /// Remove the one note containing `line`.
    Remove { line: String },
}

impl MemoryEdit {
    /// The memory after this edit, or why it can't be made.
    pub fn apply(&self, memory: &str) -> Result<String, String> {
        let mut lines: Vec<String> = memory
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_string)
            .collect();
        match self {
            MemoryEdit::Add { line } => {
                let line = one_line(line)?;
                if lines.iter().any(|existing| existing.trim() == line) {
                    return Err("That note is already in memory.".into());
                }
                lines.push(line);
            }
            MemoryEdit::Replace { old, new } => {
                let at = find_one(&lines, old)?;
                lines[at] = one_line(new)?;
            }
            MemoryEdit::Remove { line } => {
                let at = find_one(&lines, line)?;
                lines.remove(at);
            }
        }
        let mut next = lines.join("\n");
        if !next.is_empty() {
            next.push('\n');
        }
        let len = next.chars().count();
        if len > DOC_CAP_CHARS {
            return Err(format!(
                "Memory would be {len} characters; the limit is {DOC_CAP_CHARS}. Remove or shorten notes first."
            ));
        }
        Ok(next)
    }
}

fn one_line(text: &str) -> Result<String, String> {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return Err("A note can't be empty.".into());
    }
    Ok(line)
}

fn find_one(lines: &[String], needle: &str) -> Result<usize, String> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Err("Say which note to change.".into());
    }
    let matches: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.contains(needle))
        .map(|(index, _)| index)
        .collect();
    match matches.as_slice() {
        [index] => Ok(*index),
        [] => Err(format!("No note contains {needle:?}.")),
        _ => Err(format!(
            "{} notes contain {needle:?}; quote more of the one you mean.",
            matches.len()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add(line: &str) -> MemoryEdit {
        MemoryEdit::Add { line: line.into() }
    }

    #[test]
    fn add_replace_remove() {
        let memory = add("Prefers Rust.").apply("").unwrap();
        let memory = add("Lives in Lima.").apply(&memory).unwrap();
        assert_eq!(memory, "Prefers Rust.\nLives in Lima.\n");
        let memory = MemoryEdit::Replace {
            old: "Lima".into(),
            new: "Lives in Quito.".into(),
        }
        .apply(&memory)
        .unwrap();
        assert_eq!(memory, "Prefers Rust.\nLives in Quito.\n");
        let memory = MemoryEdit::Remove {
            line: "Rust".into(),
        }
        .apply(&memory)
        .unwrap();
        assert_eq!(memory, "Lives in Quito.\n");
    }

    #[test]
    fn refuses_what_it_cannot_do_cleanly() {
        let memory = "Likes tea.\nLikes coffee.\n";
        assert!(add("  ").apply(memory).is_err());
        assert!(add("Likes tea.")
            .apply(memory)
            .unwrap_err()
            .contains("already"));
        let ambiguous = MemoryEdit::Remove {
            line: "Likes".into(),
        };
        assert!(ambiguous.apply(memory).unwrap_err().contains("2 notes"));
        let missing = MemoryEdit::Remove {
            line: "juice".into(),
        };
        assert!(missing.apply(memory).unwrap_err().contains("No note"));
        let too_long = add(&"x".repeat(DOC_CAP_CHARS));
        assert!(too_long.apply(memory).unwrap_err().contains("limit"));
    }

    #[test]
    fn notes_stay_on_one_line() {
        assert_eq!(add("two\nlines").apply("").unwrap(), "two lines\n");
    }

    #[test]
    fn parses_the_tool_arguments() {
        let edit: MemoryEdit =
            serde_json::from_value(serde_json::json!({"action": "add", "line": "x"})).unwrap();
        assert_eq!(edit, add("x"));
    }
}
