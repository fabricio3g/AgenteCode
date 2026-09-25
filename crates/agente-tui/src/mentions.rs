//! `@path` file mentions: expand on submit + shared path token helpers.

use std::path::{Path, PathBuf};

const MAX_ATTACH: usize = 8;
const MAX_BYTES: usize = 32 * 1024;

/// Characters that end a `@path` token.
fn is_token_end(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '`' | ')' | ']' | ',' | ';' | '"' | '\'' | '<' | '>' | '|' | '{' | '}'
        )
}

/// Extract path token after `@` (may be empty).
pub fn path_token_at(after_at: &str) -> &str {
    let end = after_at.find(is_token_end).unwrap_or(after_at.len());
    &after_at[..end]
}

/// Resolve `@token` against the project directory.
pub fn resolve_mention_path(project_dir: &str, token: &str) -> Option<PathBuf> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    let stripped = token
        .strip_prefix("./")
        .or_else(|| token.strip_prefix(".\\"))
        .unwrap_or(token);

    let candidates: Vec<PathBuf> = {
        let p = Path::new(stripped);
        if p.is_absolute() {
            vec![p.to_path_buf()]
        } else {
            vec![
                Path::new(project_dir).join(stripped),
                Path::new(project_dir).join(token),
            ]
        }
    };

    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
        // Try canonicalize if parent exists (symlink / case)
        if let Ok(can) = c.canonicalize() {
            if can.is_file() {
                return Some(can);
            }
        }
    }
    None
}

fn read_capped(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    if content.len() <= MAX_BYTES {
        return Some(content);
    }
    Some(format!(
        "{}...\n[truncated {} bytes]",
        agente_core::util::truncate_at_char_boundary(&content, MAX_BYTES),
        content.len()
    ))
}

/// Expand `@relative/or/absolute/path` tokens into the prompt, keeping the
/// original mention text and appending fenced file bodies (capped).
pub fn expand_at_file_mentions(text: &str, project_dir: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut attachments = String::new();
    let mut rest = text;
    let mut attached = 0usize;

    while let Some(at) = rest.find('@') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let token = path_token_at(after);

        // Extensionless files are valid too; resolution below distinguishes
        // file mentions from social handles. Reject embedded @ (e.g. email).
        if token.is_empty() || token.contains('@') {
            out.push('@');
            rest = after;
            continue;
        }

        // Always keep the original `@token` in the user-visible / prompt text.
        out.push('@');
        out.push_str(token);

        if attached < MAX_ATTACH {
            if let Some(full) = resolve_mention_path(project_dir, token) {
                if let Some(content) = read_capped(&full) {
                    let display = full
                        .strip_prefix(project_dir)
                        .ok()
                        .map(|p| {
                            p.to_string_lossy()
                                .trim_start_matches(['/', '\\'])
                                .to_string()
                        })
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| token.to_string());
                    attachments.push_str(&format!(
                        "\n\nAttached file `@{}`:\n```\n{}\n```",
                        display.replace('\\', "/"),
                        content
                    ));
                    attached += 1;
                }
            }
        }

        rest = &after[token.len()..];
    }
    out.push_str(rest);
    out.push_str(&attachments);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_project() -> (TempDirGuard, String) {
        let dir = std::env::temp_dir().join(format!("agente_mention_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let mut f = std::fs::File::create(dir.join("src").join("main.rs")).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();
        let mut f2 = std::fs::File::create(dir.join("README.md")).unwrap();
        writeln!(f2, "# hi").unwrap();
        let s = dir.to_string_lossy().to_string();
        (TempDirGuard(dir), s)
    }

    #[test]
    fn expands_relative_path_and_keeps_prompt() {
        let (_g, root) = temp_project();
        let out = expand_at_file_mentions("look at @src/main.rs please", &root);
        assert!(
            out.contains("look at @src/main.rs please"),
            "prompt preserved: {out}"
        );
        assert!(out.contains("Attached file"), "{out}");
        assert!(out.contains("fn main()"), "{out}");
    }

    #[test]
    fn expands_filename_with_extension() {
        let (_g, root) = temp_project();
        let out = expand_at_file_mentions("see @README.md", &root);
        assert!(out.contains("# hi"), "{out}");
        assert!(out.contains("@README.md"), "{out}");
    }

    #[test]
    fn missing_file_leaves_token() {
        let (_g, root) = temp_project();
        let out = expand_at_file_mentions("x @no/such.rs y", &root);
        assert_eq!(out, "x @no/such.rs y");
        assert!(!out.contains("Attached file"));
    }

    #[test]
    fn social_handle_not_expanded() {
        let (_g, root) = temp_project();
        let out = expand_at_file_mentions("hi @alice", &root);
        // @alice has no path chars and won't resolve as file
        assert_eq!(out, "hi @alice");
    }

    #[test]
    fn absolute_path_works() {
        let (_g, root) = temp_project();
        let abs = Path::new(&root).join("src").join("main.rs");
        let abs_s = abs.to_string_lossy();
        let out = expand_at_file_mentions(&format!("file @{abs_s}"), &root);
        assert!(out.contains("fn main()"), "{out}");
    }

    #[test]
    fn expands_extensionless_files() {
        let (_g, root) = temp_project();
        std::fs::write(Path::new(&root).join("LICENSE"), "license text").unwrap();
        let out = expand_at_file_mentions("see @LICENSE", &root);
        assert!(out.contains("Attached file `@LICENSE`"), "{out}");
        assert!(out.contains("license text"), "{out}");
    }

    #[test]
    fn embedded_at_is_not_a_file_mention() {
        let (_g, root) = temp_project();
        std::fs::write(Path::new(&root).join("alice@example.com"), "not attached").unwrap();
        let prompt = "contact @alice@example.com";
        assert_eq!(expand_at_file_mentions(prompt, &root), prompt);
    }

    #[test]
    fn capped_attachment_preserves_utf8() {
        let (_g, root) = temp_project();
        let path = Path::new(&root).join("large.txt");
        let prefix = "a".repeat(MAX_BYTES - 1);
        let content = format!("{prefix}🎉tail");
        std::fs::write(&path, &content).unwrap();
        assert_eq!(
            read_capped(&path).unwrap(),
            format!("{prefix}...\n[truncated {} bytes]", content.len())
        );
    }

    #[test]
    fn path_token_stops_at_punctuation() {
        assert_eq!(path_token_at("src/a.rs)"), "src/a.rs");
        assert_eq!(path_token_at("src/a.rs "), "src/a.rs");
    }
}
