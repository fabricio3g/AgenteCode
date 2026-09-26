//! Inline `@` file picker above the input (slash-picker style).

use std::path::{Path, PathBuf};

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style::{self, BG_PANEL, FG_MUTED};
use crate::widgets::pick::{pick_list, row_label, PickItem};
use crate::widgets::{panel_bg, panel_header, s};

const MAX_SCAN: usize = 2000;
const MAX_DEPTH: usize = 6;
const MAX_SHOWN: usize = 12;

const SKIP_DIRS: &[&str] = &[
    ".git",
    "target",
    "node_modules",
    ".agente",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
];

/// A parsed `.gitignore` pattern. Supports `*`/`?` globs, leading `/` anchors,
/// and trailing `/` directory-only rules. Negation (`!`) is intentionally
/// unsupported (rare in this context).
struct GitignorePattern {
    regex: regex::Regex,
    anchored: bool,
    dir_only: bool,
}

impl GitignorePattern {
    fn parse(line: &str) -> Option<Self> {
        let raw = line.trim();
        if raw.is_empty() || raw.starts_with('#') || raw.starts_with('!') {
            return None;
        }
        let mut p = raw;
        let anchored = p.starts_with('/');
        if anchored {
            p = &p[1..];
        }
        let dir_only = p.ends_with('/');
        if dir_only {
            p = &p[..p.len() - 1];
        }
        if p.is_empty() {
            return None;
        }
        Some(Self {
            regex: glob_to_regex(p),
            anchored,
            dir_only,
        })
    }

    fn matches(&self, rel: &str, is_dir: bool) -> bool {
        if self.dir_only && !is_dir {
            return false;
        }
        if self.regex.is_match(rel) {
            return true;
        }
        if self.anchored {
            return false;
        }
        // Non-anchored: match any path suffix (and the basename).
        let mut segments: Vec<&str> = rel.split('/').collect();
        while !segments.is_empty() {
            if self.regex.is_match(&segments.join("/")) {
                return true;
            }
            segments.remove(0);
        }
        false
    }
}

fn glob_to_regex(pattern: &str) -> regex::Regex {
    let mut re = String::from("^");
    for ch in pattern.chars() {
        match ch {
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\' => {
                re.push('\\');
                re.push(ch);
            }
            c => re.push(c),
        }
    }
    re.push('$');
    regex::Regex::new(&re).unwrap_or_else(|_| regex::Regex::new("$^").unwrap())
}

/// Respects the project's root `.gitignore` in addition to the built-in skip
/// list.
struct GitignoreMatcher {
    patterns: Vec<GitignorePattern>,
}

impl GitignoreMatcher {
    fn load(project_dir: &str) -> Self {
        let content =
            std::fs::read_to_string(Path::new(project_dir).join(".gitignore")).unwrap_or_default();
        let patterns = content
            .lines()
            .filter_map(GitignorePattern::parse)
            .collect();
        Self { patterns }
    }

    fn ignored(&self, rel: &str, is_dir: bool) -> bool {
        self.patterns.iter().any(|p| p.matches(rel, is_dir))
    }
}

/// Collect relative file paths under project_dir (capped), respecting the
/// project `.gitignore` and built-in skip dirs.
pub fn list_project_files(project_dir: &str) -> Vec<String> {
    let root = Path::new(project_dir);
    if !root.is_dir() {
        return Vec::new();
    }
    let gitignore = GitignoreMatcher::load(project_dir);
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= MAX_SCAN || depth > MAX_DEPTH {
            continue;
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            if out.len() >= MAX_SCAN {
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if name.starts_with('.') && name != ".env" && name != ".gitignore" {
                // allow common dotfiles, skip most hidden
                if path.is_dir() {
                    continue;
                }
            }
            if path.is_dir() {
                if SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                    continue;
                }
                if !rel.is_empty() && gitignore.ignored(&rel, true) {
                    continue;
                }
                stack.push((path, depth + 1));
            } else if path.is_file() {
                if rel.is_empty() || gitignore.ignored(&rel, false) {
                    continue;
                }
                out.push(rel);
            }
        }
    }
    out.sort();
    out
}

/// Score a path against a query (higher is better). Returns None if no match.
pub fn score_path(path: &str, query: &str) -> Option<i32> {
    let q = query.trim();
    if q.is_empty() {
        return Some(0);
    }
    let path_l = path.to_ascii_lowercase();
    let q_l = q.to_ascii_lowercase().replace('\\', "/");
    let file = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_ascii_lowercase();

    if path_l == q_l {
        return Some(10_000);
    }
    if file == q_l {
        return Some(9_000);
    }
    if path_l.starts_with(&q_l) {
        return Some(8_000 - path_l.len() as i32);
    }
    if file.starts_with(&q_l) {
        return Some(7_000 - file.len() as i32);
    }
    if path_l.contains(&q_l) {
        return Some(5_000 - path_l.find(&q_l).unwrap_or(0) as i32);
    }
    if file.contains(&q_l) {
        return Some(4_000 - file.find(&q_l).unwrap_or(0) as i32);
    }
    // Fuzzy: all query chars in order
    let mut it = path_l.chars();
    for ch in q_l.chars() {
        loop {
            match it.next() {
                Some(c) if c == ch => break,
                Some(_) => continue,
                None => return None,
            }
        }
    }
    Some(1_000 - path_l.len() as i32)
}

/// Filtered, ranked matches for the picker.
pub fn filter_files(files: &[String], query: &str) -> Vec<String> {
    let mut scored: Vec<(i32, &String)> = files
        .iter()
        .filter_map(|p| score_path(p, query).map(|s| (s, p)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    scored
        .into_iter()
        .take(MAX_SHOWN)
        .map(|(_, p)| p.clone())
        .collect()
}

/// Find the active `@` mention: char index of `@` and query after it (cursor-aware).
pub fn active_at_mention(text: &str, cursor: usize) -> Option<(usize, String)> {
    let chars: Vec<char> = text.chars().collect();
    let cur = cursor.min(chars.len());
    // Search backward from cursor for `@` that starts a token
    let mut i = cur;
    while i > 0 {
        i -= 1;
        if chars[i] == '@' {
            let ok_start = i == 0 || chars[i - 1].is_whitespace();
            if !ok_start {
                return None;
            }
            let query: String = chars[i + 1..cur].iter().collect();
            // If query has whitespace, mention already finished
            if query.chars().any(|c| c.is_whitespace()) {
                return None;
            }
            return Some((i, query));
        }
        if chars[i].is_whitespace() {
            break;
        }
    }
    None
}

pub fn render_above_input(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_at_picker || area.width < 8 || area.y == 0 {
        return;
    }

    let files = if state.input.at_file_cache.is_empty() {
        // Fallback scan if cache empty (should be filled on open)
        list_project_files(&state.session.project_dir)
    } else {
        state.input.at_file_cache.clone()
    };
    let matches = filter_files(&files, &state.input.at_picker_query);
    if matches.is_empty() {
        // Still show a header + one-line empty state.
        let height = 2u16;
        if height > area.y {
            return;
        }
        let picker = Rect::new(area.x, area.y.saturating_sub(height), area.width, height);
        panel_bg(frame, picker);
        let body = panel_header(frame, picker, vec![s("@ files", style::bold())]);
        if body.height > 0 {
            frame.render_widget(
                ratatui::widgets::Paragraph::new(Line::from(Span::styled(
                    "  no matches",
                    Style::default().fg(FG_MUTED()).bg(BG_PANEL()),
                ))),
                body,
            );
        }
        return;
    }

    // Slim header(1) + list rows; the picker hugs the composer.
    let list_rows = matches
        .len()
        .clamp(1, 8)
        .min(area.y.saturating_sub(1) as usize);
    if list_rows == 0 {
        return;
    }
    let height = (list_rows as u16).saturating_add(1);
    if height > area.y {
        return;
    }

    let picker = Rect::new(area.x, area.y.saturating_sub(height), area.width, height);

    panel_bg(frame, picker);
    let body = panel_header(frame, picker, vec![s("@ files", style::bold())]);

    let selected = state.input.at_picker_selected;
    let items = matches
        .iter()
        .enumerate()
        .map(|(idx, path)| PickItem::row(vec![s(path.clone(), row_label(idx == selected))]))
        .collect();
    pick_list(
        frame,
        body,
        &state.ui.hits,
        ListId::AtPicker,
        items,
        selected,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_prefers_filename_prefix() {
        let files = vec![
            "src/lib.rs".into(),
            "src/main.rs".into(),
            "README.md".into(),
        ];
        let m = filter_files(&files, "main");
        assert_eq!(m.first().map(|s| s.as_str()), Some("src/main.rs"));
    }

    #[test]
    fn active_at_mention_detects_query() {
        let (i, q) = active_at_mention("see @src/li", 11).unwrap();
        assert_eq!(i, 4);
        assert_eq!(q, "src/li");
    }

    #[test]
    fn active_at_mention_ignores_emailish() {
        assert!(active_at_mention("a@b.com", 7).is_none());
    }

    #[test]
    fn list_and_filter_temp_tree() {
        let dir = std::env::temp_dir().join(format!("agente_at_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.rs"), "a").unwrap();
        std::fs::write(dir.join("src/b.rs"), "b").unwrap();
        let root = dir.to_string_lossy().to_string();
        let files = list_project_files(&root);
        assert!(files.iter().any(|f| f.ends_with("a.rs")));
        let m = filter_files(&files, "a.rs");
        assert!(!m.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn gitignore_pattern_matches_basename_dir_and_glob() {
        let p = GitignorePattern::parse("target/").unwrap();
        assert!(p.matches("target", true));
        assert!(!p.matches("target", false));
        // A bare pattern with no slash matches directories at any depth.
        assert!(p.matches("src/target", true));

        let glob = GitignorePattern::parse("*.log").unwrap();
        assert!(glob.matches("app.log", false));
        assert!(glob.matches("logs/err.log", false));
        assert!(!glob.matches("app.logging", false));

        let anchored = GitignorePattern::parse("/agente.json").unwrap();
        assert!(anchored.matches("agente.json", false));
        assert!(!anchored.matches("sub/agente.json", false));
    }

    #[test]
    fn list_project_files_respects_gitignore() {
        let dir = std::env::temp_dir().join(format!("agente_atgi_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("keep")).unwrap();
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join(".gitignore"), "*.log\n/target\nlogs/\n").unwrap();
        std::fs::write(dir.join("keep/main.rs"), "a").unwrap();
        std::fs::write(dir.join("logs/out.log"), "a").unwrap();
        std::fs::write(dir.join("debug.log"), "a").unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(dir.join("target/x.rs"), "a").unwrap();

        let root = dir.to_string_lossy().to_string();
        let files = list_project_files(&root);
        assert!(files.iter().any(|f| f.ends_with("keep/main.rs")));
        assert!(!files.iter().any(|f| f.ends_with("debug.log")));
        assert!(!files.iter().any(|f| f.ends_with("out.log")));
        assert!(!files.iter().any(|f| f.contains("/target/")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
