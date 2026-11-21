//! Presentation metadata for tool cards and shared tool icon lookup.

use std::collections::HashMap;
use std::sync::LazyLock;

use agente_core::tools::ToolKind;

/// Presentation metadata for a tool card. ONE table keyed first by tool
/// name (the 15 built-ins, preserving their exact look) and then by
/// [`ToolKind`] for everything else — a new core tool of an existing kind
/// needs zero TUI code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubjectStyle {
    /// Raw path text.
    Path,
    /// Quoted query text.
    Quoted,
    /// Raw pattern text (no quotes).
    Pattern,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ToolPresentation {
    pub icon: &'static str,
    /// Card-header verb; `None` renders the raw tool name (unknown tools).
    pub verb: Option<&'static str>,
    /// `$ command` header style (Execute family).
    pub shell_style: bool,
    /// Grouping family: `Some` = the card can compress into verb groups.
    pub family: Option<FamilyKind>,
    pub group_verb: &'static str,
    pub group_noun: &'static str,
    /// (args key, style) the card header extracts its subject from.
    pub subject: Option<(&'static str, SubjectStyle)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FamilyKind {
    Read,
    Run,
    Edit,
}

const fn presentation_for_kind(kind: ToolKind) -> ToolPresentation {
    // Every step shares the single `◆` marker. Verbs/subjects
    // still carry the semantic meaning; the icon column stays uniform.
    match kind {
        ToolKind::Read => ToolPresentation {
            icon: "◆",
            verb: Some("Read"),
            shell_style: false,
            family: Some(FamilyKind::Read),
            group_verb: "Read",
            group_noun: "file",
            subject: Some(("path", SubjectStyle::Path)),
        },
        ToolKind::Write => ToolPresentation {
            icon: "◆",
            verb: Some("Write"),
            shell_style: false,
            family: Some(FamilyKind::Edit),
            group_verb: "Write",
            group_noun: "file",
            subject: Some(("path", SubjectStyle::Path)),
        },
        ToolKind::Edit => ToolPresentation {
            icon: "◆",
            verb: Some("Edit"),
            shell_style: false,
            family: Some(FamilyKind::Edit),
            group_verb: "Edit",
            group_noun: "file",
            subject: Some(("path", SubjectStyle::Path)),
        },
        ToolKind::Execute => ToolPresentation {
            icon: "◆",
            verb: None,
            shell_style: true,
            family: Some(FamilyKind::Run),
            group_verb: "Run",
            group_noun: "command",
            subject: Some(("command", SubjectStyle::Path)),
        },
        ToolKind::Search => ToolPresentation {
            icon: "◆",
            verb: Some("Search"),
            shell_style: false,
            family: Some(FamilyKind::Read),
            group_verb: "Search",
            group_noun: "pattern",
            subject: Some(("query", SubjectStyle::Quoted)),
        },
        ToolKind::List => ToolPresentation {
            icon: "◆",
            verb: Some("List"),
            shell_style: false,
            family: Some(FamilyKind::Read),
            group_verb: "List",
            group_noun: "dir",
            subject: Some(("path", SubjectStyle::Path)),
        },
        ToolKind::Web => ToolPresentation {
            icon: "◆",
            verb: Some("Fetch"),
            shell_style: false,
            family: Some(FamilyKind::Read),
            group_verb: "Fetch",
            group_noun: "page",
            subject: Some(("url", SubjectStyle::Path)),
        },
        ToolKind::Todo => ToolPresentation {
            icon: "◆",
            verb: Some("Todo"),
            shell_style: false,
            family: None,
            group_verb: "Todo",
            group_noun: "todo",
            subject: None,
        },
        ToolKind::Plan => ToolPresentation {
            icon: "◆",
            verb: Some("Plan"),
            shell_style: false,
            family: None,
            group_verb: "Plan",
            group_noun: "plan",
            subject: None,
        },
        ToolKind::Task => ToolPresentation {
            icon: "◆",
            verb: Some("Task"),
            shell_style: false,
            family: None,
            group_verb: "Task",
            group_noun: "task",
            subject: None,
        },
        ToolKind::Other => ToolPresentation {
            icon: "◆",
            verb: None,
            shell_style: false,
            family: None,
            group_verb: "Used",
            group_noun: "item",
            subject: None,
        },
    }
}

/// Resolve presentation for a tool name: exact per-name entry first, then
/// the kind fallback, then the generic `Other` shape.
pub(crate) fn tool_presentation(tool: &str) -> ToolPresentation {
    static NAMED: LazyLock<HashMap<&'static str, ToolPresentation>> = LazyLock::new(|| {
        let mut m = HashMap::new();
        let mut put = |name: &'static str, icon, verb, family, group_verb, group_noun, subject| {
            m.insert(
                name,
                ToolPresentation {
                    icon,
                    verb,
                    shell_style: false,
                    family,
                    group_verb,
                    group_noun,
                    subject,
                },
            );
        };
        put(
            "read_file",
            "◆",
            Some("Read"),
            Some(FamilyKind::Read),
            "Read",
            "file",
            Some(("path", SubjectStyle::Path)),
        );
        put(
            "write_file",
            "◆",
            Some("Write"),
            Some(FamilyKind::Edit),
            "Write",
            "file",
            Some(("path", SubjectStyle::Path)),
        );
        put(
            "edit_file",
            "◆",
            Some("Edit"),
            Some(FamilyKind::Edit),
            "Edit",
            "file",
            Some(("path", SubjectStyle::Path)),
        );
        put(
            "apply_patch",
            "◆",
            Some("Patch"),
            Some(FamilyKind::Edit),
            "Patch",
            "file",
            Some(("path", SubjectStyle::Path)),
        );
        put(
            "file_outline",
            "◆",
            Some("Outline"),
            Some(FamilyKind::Read),
            "Outline",
            "file",
            Some(("path", SubjectStyle::Path)),
        );
        put(
            "list_dir",
            "◆",
            Some("List"),
            Some(FamilyKind::Read),
            "List",
            "dir",
            Some(("path", SubjectStyle::Path)),
        );
        put(
            "grep",
            "◆",
            Some("Search"),
            Some(FamilyKind::Read),
            "Search",
            "pattern",
            Some(("query", SubjectStyle::Quoted)),
        );
        put(
            "find",
            "◆",
            Some("Find"),
            Some(FamilyKind::Read),
            "Find",
            "pattern",
            Some(("pattern", SubjectStyle::Pattern)),
        );
        put(
            "shell",
            "◆",
            None,
            Some(FamilyKind::Run),
            "Run",
            "command",
            Some(("command", SubjectStyle::Path)),
        );
        put("todo_write", "◆", Some("Todo"), None, "Todo", "todo", None);
        put(
            "web_fetch",
            "◆",
            Some("Fetch"),
            Some(FamilyKind::Read),
            "Fetch",
            "page",
            Some(("url", SubjectStyle::Path)),
        );
        put(
            "web_search",
            "◆",
            Some("Search"),
            Some(FamilyKind::Read),
            "Search",
            "result",
            Some(("query", SubjectStyle::Quoted)),
        );
        put(
            "task",
            "◆",
            Some("Task"),
            None,
            "Task",
            "task",
            Some(("description", SubjectStyle::Pattern)),
        );
        put(
            "skill",
            "◆",
            Some("Skill"),
            None,
            "Skill",
            "skill",
            Some(("name", SubjectStyle::Pattern)),
        );
        put(
            "present_plan",
            "◆",
            Some("Plan"),
            None,
            "Plan",
            "plan",
            None,
        );
        m
    });

    if let Some(mut known) = NAMED.get(tool).copied() {
        if tool == "shell" {
            known.shell_style = true;
        }
        return known;
    }
    let shell_style = tool == "shell";
    match agente_core::tools::known_kind(tool) {
        Some(kind) => {
            let mut p = presentation_for_kind(kind);
            if shell_style {
                p.shell_style = true;
            }
            p
        }
        None => presentation_for_kind(ToolKind::Other),
    }
}

pub(crate) fn tool_icon_for(tool: &str) -> &'static str {
    tool_presentation(tool).icon
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::widgets::{is_wide_char, SPINNER};

    /// Every glyph the app paints as *chrome* must occupy exactly one cell.
    ///
    /// A double-width glyph (emoji) breaks two things at once: the layout math
    /// everywhere assumes one column per icon, and ratatui blanks the
    /// continuation cell with a **default** style — punching a hole in the
    /// themed panel background that the terminal shows through.
    #[test]
    fn chrome_glyphs_are_single_width() {
        let mut chrome: Vec<&str> = vec![
            "read_file",
            "write_file",
            "edit_file",
            "apply_patch",
            "file_outline",
            "list_dir",
            "grep",
            "find",
            "shell",
            "todo_write",
            "web_fetch",
            "web_search",
            "task",
            "present_plan",
            "unknown_tool",
        ]
        .into_iter()
        .map(tool_icon_for)
        .collect();
        chrome.extend_from_slice(SPINNER);
        // Subagent status icons live next to the tool icons in the same column.
        chrome.extend_from_slice(&["✓", "✗", "⧗", "◆"]);
        // Popup chrome: header rule + footer separator.
        chrome.extend_from_slice(&["─", "·"]);
        // Thread rails: thinking block + markdown quotes + group nesting.
        chrome.extend_from_slice(&["│", "◆"]);
        // Transcript chrome: hollow thought diamond + activity marker.
        chrome.extend_from_slice(&["◇", "∴"]);
        // Error rows: thick left rail.
        chrome.extend_from_slice(&["┃"]);

        for glyph in chrome {
            for c in glyph.chars() {
                assert!(
                    !is_wide_char(c),
                    "chrome glyph {glyph:?} contains double-width char U+{:04X}",
                    c as u32
                );
            }
        }
    }
}
