use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

use crate::style::*;

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
/// Dark-theme syntect palette, loaded once and selected at highlight time.
static DARK_THEME: OnceLock<Theme> = OnceLock::new();
/// Light-theme syntect palette, loaded once and selected at highlight time.
static LIGHT_THEME: OnceLock<Theme> = OnceLock::new();
/// Intern table for code-fence language tags. `detect_language` must return a
/// `&'static str`, which used to mean a fresh `Box::leak` on every call — an
/// unbounded leak proportional to rendered code blocks. Each UNIQUE tag is now
/// leaked exactly once; repeats are a hash lookup, so memory is bounded by the
/// number of distinct tags a session ever sees.
static INTERNED_LANGS: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();

fn get_syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(|| {
        // Load default syntaxes
        SyntaxSet::load_defaults_nonewlines()
    })
}

/// Syntect palette name per app theme (both ship in syntect's defaults).
fn syntect_theme_name(theme: crate::style::Theme) -> &'static str {
    match theme {
        crate::style::Theme::Light => "InspiredGitHub",
        crate::style::Theme::Dark => "base16-ocean.dark",
    }
}

/// The syntect palette for the current app theme, selected on every highlight
/// call so lines rendered after a `/theme` toggle pick up the new palette.
///
/// NOTE: the per-entry chat render cache (`state::ui::RenderedChatBlock`) is
/// keyed on width/expand only, so already-rendered blocks keep their old
/// colors until invalidated. `style::syntax_generation()` (bumped by
/// `style::set_theme`) exists for Wave 4 to fold into that cache key.
fn get_theme() -> &'static Theme {
    let theme = crate::style::current_theme();
    let name = syntect_theme_name(theme);
    match theme {
        crate::style::Theme::Light => LIGHT_THEME.get_or_init(|| load_theme(name)),
        crate::style::Theme::Dark => DARK_THEME.get_or_init(|| load_theme(name)),
    }
}

fn load_theme(name: &str) -> Theme {
    let ts = ThemeSet::load_defaults();
    ts.themes[name].clone()
}

/// Get language name from file extension or explicit language tag
pub fn detect_language(_code: &str, explicit_lang: Option<&str>) -> Option<&'static str> {
    let lang = explicit_lang?;
    let lower = lang.to_lowercase();
    let table = INTERNED_LANGS.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut set) = table.lock() {
        if let Some(existing) = set.get(lower.as_str()).copied() {
            return Some(existing);
        }
        let leaked: &'static str = Box::leak(lower.into_boxed_str());
        set.insert(leaked);
        return Some(leaked);
    }
    // Mutex poisoned (a panic while interning): fall back to a one-off leak so
    // highlighting keeps working; this path is unreachable in practice.
    Some(Box::leak(lower.into_boxed_str()))
}

/// Map common language identifiers to syntect syntax names
fn map_language_name(lang: &str) -> Vec<&'static str> {
    let lower = lang.to_lowercase();
    match lower.as_str() {
        "rs" => vec!["Rust"],
        "js" | "jsx" | "javascript" => vec!["JavaScript"],
        "ts" | "tsx" | "typescript" => vec!["TypeScript"],
        "py" | "python" | "python3" => vec!["Python"],
        "go" | "golang" => vec!["Go"],
        "c" | "h" => vec!["C"],
        "cpp" | "cc" | "cxx" | "hpp" | "c++" => vec!["C++"],
        "java" => vec!["Java"],
        "rb" | "ruby" => vec!["Ruby"],
        "php" => vec!["PHP"],
        "swift" => vec!["Swift"],
        "kt" | "kotlin" => vec!["Kotlin"],
        "scala" => vec!["Scala"],
        "clj" | "clojure" => vec!["Clojure"],
        "ex" | "exs" | "elixir" => vec!["Elixir"],
        "erl" | "erlang" => vec!["Erlang"],
        "hs" | "haskell" => vec!["Haskell"],
        "lua" => vec!["Lua"],
        "r" => vec!["R"],
        "sh" | "bash" | "zsh" | "shell" => vec!["Bourne Again Shell (bash)", "Bash"],
        "fish" => vec!["Fish"],
        "ps1" | "powershell" => vec!["PowerShell"],
        "yaml" | "yml" => vec!["YAML"],
        "json" => vec!["JSON"],
        "toml" => vec!["TOML"],
        "xml" | "svg" => vec!["XML"],
        "html" | "htm" => vec!["HTML"],
        "css" | "scss" | "sass" | "less" => vec!["CSS"],
        "md" | "markdown" => vec!["Markdown"],
        "dockerfile" => vec!["Dockerfile"],
        "sql" => vec!["SQL"],
        "graphql" | "gql" => vec!["GraphQL"],
        "proto" | "protobuf" => vec!["Protocol Buffer"],
        "vue" => vec!["Vue Component"],
        "svelte" => vec!["Svelte"],
        "zig" => vec!["Zig"],
        "nim" => vec!["Nim"],
        "cr" | "crystal" => vec!["Crystal"],
        "gleam" => vec!["Gleam"],
        "objc" | "m" => vec!["Objective-C"],
        "objcpp" | "mm" => vec!["Objective-C++"],
        "perl" | "pl" => vec!["Perl"],
        "dart" => vec!["Dart"],
        "regex" | "regexp" => vec!["Regular Expression"],
        "ini" | "cfg" | "conf" => vec!["INI"],
        "makefile" => vec!["Makefile"],
        "cmake" => vec!["CMake"],
        "nix" => vec!["Nix"],
        "rego" => vec!["Rego"],
        _ => vec![],
    }
}

/// Highlight code and return styled lines
pub fn highlight_code(code: &str, language: &str) -> Vec<Line<'static>> {
    let syntax_set = get_syntax_set();
    let theme = get_theme();

    // Try multiple lookup strategies
    let syntax = {
        // 1. Direct name match
        if let Some(s) = syntax_set.find_syntax_by_name(language) {
            Some(s)
        }
        // 2. Extension match
        else if let Some(s) = syntax_set.find_syntax_by_extension(language) {
            Some(s)
        }
        // 3. Mapped names
        else {
            let names = map_language_name(language);
            let mut found = None;
            for name in names {
                if let Some(s) = syntax_set.find_syntax_by_name(name) {
                    found = Some(s);
                    break;
                }
            }
            found
        }
    }
    .or_else(|| detect_language_from_code(code))
    .unwrap_or_else(|| syntax_set.find_syntax_plain_text());

    let mut highlighter = HighlightLines::new(syntax, theme);

    let mut lines = Vec::new();
    for line in LinesWithEndings::from(code) {
        let line_without_ending = line.trim_end_matches('\n').trim_end_matches('\r');
        let highlighted = highlighter.highlight_line(line_without_ending, syntax_set);

        match highlighted {
            Ok(regions) => {
                let mut spans = vec![Span::styled("  ".to_string(), Style::default())];
                for (style, text) in regions {
                    let ratatui_style = convert_syntect_style(style);
                    spans.push(Span::styled(text.to_string(), ratatui_style));
                }
                lines.push(Line::from(spans));
            }
            Err(_) => {
                lines.push(Line::from(vec![
                    Span::styled("  ".to_string(), Style::default()),
                    Span::styled(
                        line_without_ending.to_string(),
                        Style::default().fg(FG_MUTED()),
                    ),
                ]));
            }
        }
    }

    lines
}

/// Detect language from code content patterns
fn detect_language_from_code(code: &str) -> Option<&'static SyntaxReference> {
    let syntax_set = get_syntax_set();

    // Check for shebang
    if code.starts_with("#!/bin/bash") || code.starts_with("#!/bin/sh") {
        return syntax_set.find_syntax_by_name("Bourne Again Shell (bash)");
    }
    if code.starts_with("#!/usr/bin/env python") || code.starts_with("#!/usr/bin/python") {
        return syntax_set.find_syntax_by_name("Python");
    }
    if code.starts_with("#!/usr/bin/env node") || code.starts_with("#!/usr/bin/node") {
        return syntax_set.find_syntax_by_name("JavaScript");
    }
    if code.starts_with("#!/usr/bin/env ruby") || code.starts_with("#!/usr/bin/ruby") {
        return syntax_set.find_syntax_by_name("Ruby");
    }

    // Try to detect from common patterns
    if code.contains("fn main()") || code.contains("use std::") || code.contains("impl ") {
        return syntax_set.find_syntax_by_name("Rust");
    }
    if code.contains("import ") && (code.contains("from ") || code.contains("as ")) {
        return syntax_set.find_syntax_by_name("Python");
    }
    if code.contains("function ") || code.contains("const ") || code.contains("let ") {
        if code.contains(": ") && code.contains("{") && !code.contains("def ") {
            return syntax_set.find_syntax_by_name("TypeScript");
        }
        return syntax_set.find_syntax_by_name("JavaScript");
    }

    None
}

/// Convert syntect style to ratatui style
fn convert_syntect_style(style: syntect::highlighting::Style) -> Style {
    let fg = convert_syntect_color(style.foreground);
    let mut ratatui_style = Style::default().fg(fg);

    if style
        .font_style
        .contains(syntect::highlighting::FontStyle::BOLD)
    {
        ratatui_style = ratatui_style.add_modifier(ratatui::style::Modifier::BOLD);
    }
    if style
        .font_style
        .contains(syntect::highlighting::FontStyle::ITALIC)
    {
        ratatui_style = ratatui_style.add_modifier(ratatui::style::Modifier::ITALIC);
    }
    if style
        .font_style
        .contains(syntect::highlighting::FontStyle::UNDERLINE)
    {
        ratatui_style = ratatui_style.add_modifier(ratatui::style::Modifier::UNDERLINED);
    }

    ratatui_style
}

/// Convert syntect color to ratatui color
fn convert_syntect_color(color: syntect::highlighting::Color) -> Color {
    Color::Rgb(color.r, color.g, color.b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syntect_theme_follows_app_theme() {
        assert_eq!(
            syntect_theme_name(crate::style::Theme::Dark),
            "base16-ocean.dark"
        );
        assert_eq!(
            syntect_theme_name(crate::style::Theme::Light),
            "InspiredGitHub"
        );
    }

    #[test]
    fn both_syntect_themes_load_from_defaults() {
        let ts = ThemeSet::load_defaults();
        for name in [
            syntect_theme_name(crate::style::Theme::Dark),
            syntect_theme_name(crate::style::Theme::Light),
        ] {
            assert!(ts.themes.contains_key(name), "missing syntect theme {name}");
        }
    }
}
