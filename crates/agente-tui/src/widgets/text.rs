//! Text, cell-width, span, path-shortening, and elapsed-time formatting helpers.

use std::borrow::Cow;

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};

/// True for code points terminals render two columns wide (CJK, emoji, …).
pub(crate) fn is_wide_char(c: char) -> bool {
    let cp = c as u32;
    (0x1100..=0x115F).contains(&cp)
        || (0x2329..=0x232A).contains(&cp)
        || (0x2E80..=0xA4CF).contains(&cp)
        || (0xAC00..=0xD7A3).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0xFE30..=0xFE6F).contains(&cp)
        || (0xFF00..=0xFF60).contains(&cp)
        || (0x1F300..=0x1FAFF).contains(&cp)
        || (0x23E9..=0x23FA).contains(&cp)
}

/// Terminal display width of `s` in columns (emoji/CJK count as 2).
pub(crate) fn display_width(s: &str) -> usize {
    s.chars().map(|c| if is_wide_char(c) { 2 } else { 1 }).sum()
}

/// Convert a char index into a valid UTF-8 byte offset in `s` (clamped to `s.len()`).
pub(crate) fn char_to_byte(s: &str, char_idx: usize) -> usize {
    s.char_indices()
        .nth(char_idx)
        .map(|(byte_idx, _)| byte_idx)
        .unwrap_or(s.len())
}

/// Trim `text` to `budget` *cells*, char-boundary safe, marking the cut with `…`.
///
/// Budgets are display widths (CJK/emoji count as 2): a char-count trim lets
/// wide glyphs slip past the caller's column math.
pub fn truncate_cells(text: &str, budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }
    if display_width(text) <= budget {
        return text.to_string();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for c in text.chars() {
        let cw = if is_wide_char(c) { 2 } else { 1 };
        if used + cw > budget.saturating_sub(1) {
            break;
        }
        out.push(c);
        used += cw;
    }
    out.push('…');
    out
}

/// Fit styled text to terminal cells, retaining its leading styles and gutter.
pub(crate) fn truncate_spans(spans: Vec<Span<'static>>, budget: usize) -> Vec<Span<'static>> {
    if budget == 0 {
        return Vec::new();
    }
    if spans
        .iter()
        .map(|span| display_width(&span.content))
        .sum::<usize>()
        <= budget
    {
        return spans;
    }
    let mut result = Vec::new();
    let mut remaining = budget - 1;
    for span in spans {
        let mut text = String::new();
        for ch in span.content.chars() {
            let width = if is_wide_char(ch) { 2 } else { 1 };
            if width > remaining {
                text.push('…');
                result.push(Span::styled(text, span.style));
                return result;
            }
            text.push(ch);
            remaining -= width;
        }
        result.push(Span::styled(text, span.style));
    }
    result
}

/// `lead ········ trail`, exactly `width` cells on `bg`.
///
/// The trail keeps a two-cell gap and one cell of right padding. The lead
/// truncates to make room, down to 12 cells; past that the trail is dropped,
/// so a label is never squeezed out by its metadata.
pub fn justify(
    mut lead: Vec<Span<'static>>,
    trail: Vec<Span<'static>>,
    width: usize,
    bg: Color,
) -> Vec<Span<'static>> {
    const MIN_LEAD: usize = 12;
    let cells = |spans: &[Span<'static>]| -> usize {
        spans.iter().map(|sp| display_width(&sp.content)).sum()
    };
    let lead_w = cells(&lead);
    let trail_w = cells(&trail);
    let lead_budget = width.saturating_sub(trail_w + 3);
    if trail_w > 0 && width >= trail_w + 3 && lead_budget >= lead_w.min(MIN_LEAD) {
        if lead_w > lead_budget {
            lead = fill_row(lead, lead_budget, bg);
        }
        let pad = width.saturating_sub(lead_w.min(lead_budget) + trail_w + 1);
        lead.push(s(" ".repeat(pad), Style::default().bg(bg)));
        lead.extend(trail);
    }
    fill_row(lead, width, bg)
}

/// Pad `spans` with background spaces out to `width` cells.
///
/// Paragraph only paints graphemes, so a row that stops mid-line leaves the
/// app background showing through a card. The pad uses `bg` alone — padding
/// spaces carry no visible fg.
pub fn fill_row(mut spans: Vec<Span<'static>>, width: usize, bg: Color) -> Vec<Span<'static>> {
    let used: usize = spans
        .iter()
        .map(|span| display_width(span.content.as_ref()))
        .sum();

    if used > width {
        return clamp_row(spans, width, bg);
    }

    if used < width {
        spans.push(Span::styled(
            " ".repeat(width - used),
            Style::default().bg(bg),
        ));
    }
    spans
}

/// Trim `spans` to `width` display cells, ending in an ellipsis, keeping each
/// surviving fragment's own style.
fn clamp_row(spans: Vec<Span<'static>>, width: usize, bg: Color) -> Vec<Span<'static>> {
    if width == 0 {
        return Vec::new();
    }
    let budget = width - 1; // room for the ellipsis
    let mut out: Vec<Span<'static>> = Vec::new();
    let mut used = 0usize;

    for span in spans {
        let span_width = display_width(span.content.as_ref());
        if used + span_width <= budget {
            used += span_width;
            out.push(span);
            continue;
        }
        // Partial: take whole chars while they fit.
        let mut taken = String::new();
        for ch in span.content.chars() {
            let ch_width = if is_wide_char(ch) { 2 } else { 1 };
            if used + ch_width > budget {
                break;
            }
            used += ch_width;
            taken.push(ch);
        }
        if !taken.is_empty() {
            out.push(Span::styled(taken, span.style));
        }
        break;
    }

    out.push(Span::styled("…".to_string(), Style::default().bg(bg)));
    used += 1;
    if used < width {
        out.push(Span::styled(
            " ".repeat(width - used),
            Style::default().bg(bg),
        ));
    }
    out
}

// ── Span / row helpers shared by chat and markdown ──────────────────────────

pub(crate) fn s(content: impl Into<Cow<'static, str>>, style: Style) -> Span<'static> {
    Span::styled(content, style)
}

pub(crate) fn sp(text: &'static str) -> Span<'static> {
    Span::styled(text, Style::default())
}

pub(crate) fn sf(text: &'static str, color: Color) -> Span<'static> {
    Span::styled(text, Style::default().fg(color))
}

/// Full-width blank row on the app background (never Reset).
pub(crate) fn themed_blank_row(width: usize) -> Line<'static> {
    if width == 0 {
        return Line::from(Span::styled("", Style::default().bg(crate::style::BG())));
    }
    Line::from(Span::styled(
        " ".repeat(width),
        Style::default().bg(crate::style::BG()),
    ))
}

// ── Path helpers ────────────────────────────────────────────────────────────

/// Worktree-relative form of a path inside `.agente/worktrees/<name>/`, so a
/// subagent's activity reads `crates/foo.rs` instead of a 90-column prefix.
/// The worktree root itself becomes `.`; other paths pass through.
pub(crate) fn short_path(path: &str) -> &str {
    const MARK: &str = "/.agente/worktrees/";
    let Some(at) = path.find(MARK) else {
        return path;
    };
    let rest = &path[at + MARK.len()..];
    match rest.find('/') {
        Some(slash) if slash + 1 < rest.len() => &rest[slash + 1..],
        _ => ".",
    }
}

/// Collapse the user's home directory prefix to `~`, normalize separators, and
/// optionally trim deep paths exceeding `max_chars` to their last two parts
/// (`…/parent/leaf`).
pub(crate) fn shorten_path(path: &str, max_chars: Option<usize>) -> String {
    let normalized = agente_core::util::normalize_project_dir(path).replace('\\', "/");
    let display = dirs::home_dir()
        .map(|h| agente_core::util::normalize_project_dir(h).replace('\\', "/"))
        .filter(|h| !h.is_empty())
        .and_then(|home| {
            normalized
                .strip_prefix(&home)
                .map(|rest| format!("~{rest}"))
        })
        .unwrap_or(normalized);
    let Some(limit) = max_chars else {
        return display;
    };
    if display.chars().count() <= limit {
        return display;
    }
    let parts: Vec<&str> = display.split('/').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 => display,
        1 => format!("…/{}", parts[0]),
        _ => format!("…/{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]),
    }
}

// ── Elapsed-time formatters ─────────────────────────────────────────────────

/// Whole-second live readout (`42s`, `6m03s`) used by live tool calls and
/// subagent rows.
pub(crate) fn format_elapsed_secs(secs: u64) -> String {
    if secs >= 60 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

/// Sub-minute tenth-of-a-second readout (`4.2s`, `6m03s`) used by the live
/// activity strip.
pub(crate) fn format_elapsed_secs_f64(secs: f64) -> String {
    if secs >= 60.0 {
        let whole = secs as u64;
        format!("{}m{:02}s", whole / 60, whole % 60)
    } else {
        format!("{secs:.1}s")
    }
}

/// Millisecond / tenth-of-a-second timing (`412ms`, `3.4s`) used by settled
/// tool cards, thought headers, and subagent cards.
pub(crate) fn format_duration_ms(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{ms:.0}ms")
    } else {
        format!("{:.1}s", ms / 1000.0)
    }
}

/// Whole-second turn footer timing (`10s`, or `412ms` below 1s) used by
/// `Worked for Ns`.
pub(crate) fn format_worked_for_ms(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{ms:.0}ms")
    } else {
        format!("{:.0}s", ms / 1000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_path_strips_worktree_prefixes_only() {
        let wt = "/home/me/proj/.agente/worktrees/explore-554b35d2";
        assert_eq!(
            short_path(&format!("{wt}/crates/core/src")),
            "crates/core/src"
        );
        assert_eq!(short_path(wt), ".");
        assert_eq!(short_path(&format!("{wt}/")), ".");
        assert_eq!(short_path("src/main.rs"), "src/main.rs");
    }

    #[test]
    fn shorten_path_respects_optional_max_chars() {
        assert_eq!(shorten_path("/tmp/x", Some(32)), "/tmp/x");
        assert_eq!(
            shorten_path("/a/very/long/path/with/many/components/here", Some(32)),
            "…/components/here"
        );
        assert_eq!(
            shorten_path("/a/very/long/path/with/many/components/here", None),
            "/a/very/long/path/with/many/components/here"
        );
    }

    #[test]
    fn elapsed_formatters_keep_exact_formats() {
        assert_eq!(format_elapsed_secs(42), "42s");
        assert_eq!(format_elapsed_secs(363), "6m03s");
        assert_eq!(format_elapsed_secs_f64(4.2), "4.2s");
        assert_eq!(format_elapsed_secs_f64(125.7), "2m05s");
        assert_eq!(format_duration_ms(412.0), "412ms");
        assert_eq!(format_duration_ms(3450.0), "3.5s");
        assert_eq!(format_worked_for_ms(412.0), "412ms");
        assert_eq!(format_worked_for_ms(10_400.0), "10s");
    }

    #[test]
    fn char_to_byte_handles_multibyte_and_oob() {
        assert_eq!(char_to_byte("aé中", 0), 0);
        assert_eq!(char_to_byte("aé中", 1), 1);
        assert_eq!(char_to_byte("aé中", 2), 3);
        assert_eq!(char_to_byte("aé中", 3), 6);
        assert_eq!(char_to_byte("aé中", 99), 6);
    }
}
