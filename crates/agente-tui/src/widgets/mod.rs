pub mod activity;
pub mod approval;
pub mod chat;
pub mod diff_view;
pub mod hints;
pub mod input;
pub mod markdown;
pub mod pick;
pub mod plan_ask;
pub mod plan_review;
pub mod process_view;
pub mod scrollbar;
pub mod subagent_detail;
pub mod tabs;
pub mod welcome;

use ratatui::text::Span;
use std::borrow::Cow;

/// Shared braille spinner frames used by chat streaming and the welcome screen.
pub const SPINNER: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Animation tick divisor: work spins at tick/4 (~7.5fps @30fps). All
/// spinners/pulses derive from `anim_frame` so cues never drift apart under load.
pub const SPINNER_DIVISOR: u64 = 4;
/// Waiting-on-you diamond pulse speed: sin²(tick·speed), period π,
/// ≈1.3s per cycle at ~30fps. Shared by approval/drain/plan waits.
pub const WAITING_PULSE_SPEED: f32 = 0.08;

/// Returns the spinner frame for the given animation frame index.
pub fn spinner_frame(frame: u32) -> &'static str {
    SPINNER[frame as usize % SPINNER.len()]
}

/// Working-spinner frame for a raw `anim_frame` tick (applies `SPINNER_DIVISOR`).
pub fn spinner_frame_for_tick(tick: u64) -> &'static str {
    spinner_frame((tick / SPINNER_DIVISOR) as u32)
}

/// Waiting-on-you diamond color: blends `bg → accent` with a sin² pulse
/// floored at 0.3 so the diamond stays visible at the trough.
/// Always route diamond waits through here so call sites never drift.
pub fn waiting_diamond_color(
    bg: ratatui::style::Color,
    accent: ratatui::style::Color,
    tick: u64,
) -> ratatui::style::Color {
    let t = tick as f32 * WAITING_PULSE_SPEED;
    let brightness = t.sin() * t.sin(); // sin², period π
    crate::style::blend_colors(bg, accent, 0.3 + brightness * 0.7)
}

/// One semantic status for every subagent surface (card, popup, detail modal).
/// Single source of truth for glyph and color so the three views never drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatusKind {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl SubagentStatusKind {
    /// Parse the live UI status string (`pending`, `running`, ...).
    pub fn from_status(status: &str) -> Self {
        match status {
            "pending" | "queued" => Self::Queued,
            "completed" | "done" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Running,
        }
    }

    /// Parse the core registry status.
    pub fn from_core(status: agente_core::subagent::SubagentStatus) -> Self {
        use agente_core::subagent::SubagentStatus as Core;
        match status {
            Core::Pending => Self::Queued,
            Core::Running => Self::Running,
            Core::Completed => Self::Completed,
            Core::Failed => Self::Failed,
            Core::Cancelled => Self::Cancelled,
        }
    }

    /// Single-width marker. Subagent card: `✓ Explore  desc ··· completed`,
    /// running on a spinner-ish glyph, queued on an ellipsis.
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Queued => "⋯",
            Self::Running => "⧗",
            Self::Completed => "✓",
            Self::Failed | Self::Cancelled => "✗",
        }
    }

    pub fn color(self) -> ratatui::style::Color {
        match self {
            Self::Queued => crate::style::DETAIL(),
            Self::Running => crate::style::SECONDARY(),
            Self::Completed => crate::style::FG_MUTED(),
            Self::Failed => crate::style::ERROR(),
            Self::Cancelled => crate::style::FG_DIM(),
        }
    }

    /// Edge color for cards about this subagent (detail modal border).
    pub fn border_color(self) -> ratatui::style::Color {
        let tint = match self {
            Self::Running => crate::style::SECONDARY(),
            Self::Completed => crate::style::SUCCESS(),
            Self::Failed => crate::style::ERROR(),
            Self::Queued | Self::Cancelled => crate::style::FG_DIM(),
        };
        crate::style::blend_colors(tint, crate::style::BORDER_RULE(), 0.3)
    }

    /// Word used by the popup and detail header.
    pub fn label(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// True while the child still occupies a concurrency slot or queue slot.
    pub fn is_live(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

/// Sweep a bright band across `text` for a soft shimmer (continuous sine wave).
///
/// Shared by the live thinking header (`widgets::chat`) and the activity-strip
/// `Thinking...` phase label so both animate with the same speed, direction
/// and palette. All glyphs stay single-width; colors route through `style.rs`.
pub(crate) fn shimmer_text(text: &str, frame: usize) -> Vec<Span<'static>> {
    use ratatui::style::{Modifier, Style};
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let speed = 0.35f32;
    let hi = crate::style::PRIMARY();
    let mid = crate::style::SECONDARY();
    let lo = crate::style::FG_DIM();

    chars
        .into_iter()
        .enumerate()
        .map(|(i, ch)| {
            let offset = (i as f32) * 0.6;
            let angle = (frame as f32) * speed - offset;
            let wave = (angle.sin() * 0.5 + 0.5).clamp(0.0, 1.0);
            let fg = if wave > 0.7 {
                crate::style::blend_colors(mid, hi, (wave - 0.7) / 0.3)
            } else {
                crate::style::blend_colors(lo, mid, wave / 0.7)
            };
            let mods = if wave > 0.75 {
                Modifier::BOLD
            } else if wave > 0.4 {
                Modifier::ITALIC
            } else {
                Modifier::empty()
            };
            Span::styled(ch.to_string(), Style::default().fg(fg).add_modifier(mods))
        })
        .collect()
}

// ── Panel geometry ───────────────────────────────────────────────────────────
//
// Every floating dialog needs the same two things: a centered rect that fits,
// and rows inside it that fit. Both used to be re-derived per dialog (five
// near-identical `centered_panel` copies), and none of the callers checked that
// `panel.y + 3` was still inside the panel — which panics, because `Clear` and
// `Paragraph` index the buffer directly.

use ratatui::layout::Rect;

/// A centered panel of the requested size, never larger than `area`.
///
/// A dialog that asks for 45 columns on a 20-column terminal gets 20, not a
/// rect hanging off the right edge.
pub fn centered_panel(area: Rect, want_w: u16, want_h: u16) -> Rect {
    let w = want_w.min(area.width);
    let h = want_h.min(area.height);
    Rect::new(
        area.x + area.width.saturating_sub(w) / 2,
        area.y + area.height.saturating_sub(h) / 2,
        w,
        h,
    )
}

/// Row `dy` of `panel`, inset by `inset` columns on both sides.
///
/// `None` when that row is past the panel's bottom or the inset eats the whole
/// width — the caller skips the element instead of painting outside the buffer.
/// This is the guard that makes a clamped panel safe: `centered_panel` shrinks
/// the panel, and every row derived from it has to cope with the new size.
pub fn panel_row(panel: Rect, dy: u16, inset: u16) -> Option<Rect> {
    if dy >= panel.height {
        return None;
    }
    let width = panel.width.checked_sub(inset.saturating_mul(2))?;
    if width == 0 {
        return None;
    }
    Some(Rect::new(panel.x + inset, panel.y + dy, width, 1))
}

// ── Popup chrome: header rule + footer hints ─────────────────────────────────
//
// Every floating surface is the same three-part sandwich: an opaque
// [`panel_bg`] panel, one header row (title + quiet rule), and one footer row
// of key hints. No `Block::bordered()` anywhere — popups are borderless.

/// A full-width horizontal rule (`─`) in the barely-visible `BORDER_RULE`
/// tone — the quiet separator under popup headers.
fn rule_span(width: usize) -> Span<'static> {
    s(
        "─".repeat(width),
        ratatui::style::Style::default().fg(crate::style::BORDER_RULE()),
    )
}

/// Paint the header row of an already-backgrounded floating panel and return
/// the content region **below** it.
///
/// The caller paints [`panel_bg`] for the full panel first. This helper draws
/// one row at the panel's top: `title_spans` (caller-built: icon, bold title,
/// dim suffix), then a one-column gap and a full-width [`rule_span`] running to
/// the content's right edge. Text is inset 2 columns on both sides, matching
/// every popup uses. A panel with no room for a header (0 or 1 rows) is
/// returned untouched — nothing is painted.
pub fn panel_header(
    frame: &mut ratatui::Frame,
    panel: Rect,
    title_spans: Vec<Span<'static>>,
) -> Rect {
    if panel.width == 0 || panel.height <= 1 {
        return panel;
    }
    let inset = 2u16.min(panel.width / 2);
    let row_w = panel.width.saturating_sub(inset * 2);
    let mut spans = truncate_spans(title_spans, row_w as usize);
    let used: usize = spans
        .iter()
        .map(|span| display_width(span.content.as_ref()))
        .sum();
    if used < row_w as usize {
        // One-column gap between title and rule; the rest is rule.
        let rule_w = row_w as usize - used - 1;
        spans.push(s(" ", ratatui::style::Style::default()));
        if rule_w > 0 {
            spans.push(rule_span(rule_w));
        }
    }
    frame.render_widget(
        ratatui::widgets::Paragraph::new(ratatui::text::Line::from(spans))
            .style(ratatui::style::Style::default().bg(crate::style::BG_PANEL())),
        Rect::new(panel.x + inset, panel.y, row_w, 1),
    );
    Rect::new(panel.x, panel.y + 1, panel.width, panel.height - 1)
}

/// Fit styled text to terminal cells, retaining its leading styles and gutter.
fn truncate_spans(spans: Vec<Span<'static>>, budget: usize) -> Vec<Span<'static>> {
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

/// Modal card: a borderless opaque panel with the title on its first row.
/// The panel's background is the edge — no frame, so nothing inside it is a
/// box within a box.
///
/// Returns the inner rect (one row and column in from each side, where a frame
/// used to sit). Derive rows with `panel_row(inner, dy, 1)` and pin hints with
/// [`modal_footer`]. Panels too small fall back to the [`panel_bg`] +
/// [`panel_header`] sandwich.
pub fn modal_card(frame: &mut ratatui::Frame, panel: Rect, title: Vec<Span<'static>>) -> Rect {
    modal_card_tinted(frame, panel, title, crate::style::BORDER_RULE())
}

/// [`modal_card`] carrying a status color (running subagent, destructive
/// approval, …) as one mark before the title, never a coloured frame.
pub fn modal_card_tinted(
    frame: &mut ratatui::Frame,
    panel: Rect,
    title: Vec<Span<'static>>,
    border: ratatui::style::Color,
) -> Rect {
    if panel.width < 10 || panel.height < 4 {
        panel_bg(frame, panel);
        return panel_header(frame, panel, title);
    }
    // Borderless: the panel's own background is the edge. The title sits on
    // the row a frame used to occupy, so the content rect is unchanged.
    panel_bg(frame, panel);
    let bg = ratatui::style::Style::default().bg(crate::style::BG_PANEL());
    let mut spans = Vec::new();
    if border != crate::style::BORDER_RULE() {
        // A status tint (running, destructive, …) survives as one mark before
        // the title instead of a coloured frame.
        spans.push(s("● ", bg.fg(border)));
    }
    spans.extend(title);
    let title_row = Rect::new(
        panel.x.saturating_add(1),
        panel.y,
        panel.width.saturating_sub(2),
        1,
    );
    let spans = truncate_spans(spans, title_row.width as usize);
    frame.render_widget(
        ratatui::widgets::Paragraph::new(ratatui::text::Line::from(spans)).style(bg),
        title_row,
    );
    Rect::new(
        panel.x.saturating_add(1),
        panel.y.saturating_add(1),
        panel.width.saturating_sub(2),
        panel.height.saturating_sub(2),
    )
}

/// Footer hints on the last row of a [`modal_card`] inner rect.
///
/// Hints start on the content rows' left edge, so the footer shares their edge.
/// Over-wide hints truncate with `…` (clamp-safe: zero-sized rects skip).
pub fn modal_footer(frame: &mut ratatui::Frame, inner: Rect, hint_spans: Vec<Span<'static>>) {
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    let spans = truncate_spans(hint_spans, inner.width as usize);
    let pad = 1;
    let row = Rect::new(inner.x, inner.y + inner.height - 1, inner.width, 1);
    let mut padded = vec![s(
        " ".repeat(pad),
        ratatui::style::Style::default().bg(crate::style::BG_PANEL()),
    )];
    padded.extend(spans);
    frame.render_widget(
        ratatui::widgets::Paragraph::new(ratatui::text::Line::from(padded))
            .style(ratatui::style::Style::default().bg(crate::style::BG_PANEL())),
        row,
    );
}

/// Paint one hint row pinned to the last row of an already-backgrounded
/// panel (clamp-safe: a zero-sized panel is skipped).
///
/// Text is inset 2 columns like the content rows; overflow is clipped by the
/// paragraph, never painted outside the panel.
pub fn panel_footer(frame: &mut ratatui::Frame, panel: Rect, hint_spans: Vec<Span<'static>>) {
    if panel.width == 0 || panel.height == 0 {
        return;
    }
    let inset = 2u16.min(panel.width / 2);
    let row_w = panel.width.saturating_sub(inset.saturating_mul(2));
    if row_w == 0 {
        return;
    }
    frame.render_widget(
        ratatui::widgets::Paragraph::new(ratatui::text::Line::from(hint_spans))
            .style(ratatui::style::Style::default().bg(crate::style::BG_PANEL())),
        Rect::new(panel.x + inset, panel.y + panel.height - 1, row_w, 1),
    );
}

/// How many leading segments survive next to the mandatory trailing segment.
///
/// Returns `(kept, last_fits)`: middle segments drop whole (from the right)
/// rather than being cut in half, and the trailing segment — the escape hatch
/// (`Esc close`) — is kept whenever it fits at all. `sep` is the fixed-width
/// separator drawn between adjacent kept segments.
fn fit_segments(widths: &[usize], budget: usize, sep: usize) -> (usize, bool) {
    let Some(&last_w) = widths.last() else {
        return (0, false);
    };
    if last_w > budget {
        return (0, false);
    }
    let mut used = last_w;
    let mut kept = 0usize;
    for &w in &widths[..widths.len() - 1] {
        if used + sep + w > budget {
            break;
        }
        used += sep + w;
        kept += 1;
    }
    (kept, true)
}

/// Build a `key action · key action · …` footer hint line from `(key, action)`
/// pairs: keys in the [`hint_key`](crate::style::hint_key) style, actions in
/// [`hint_action`](crate::style::hint_action), ` · ` separators dim.
///
/// When the row is narrower than the full hint, middle segments drop whole
/// from the right; the trailing segment is kept whenever it fits at all.
/// Pass `width` = the row width the spans will render into (the panel width
/// minus the footer inset).
pub fn footer_hints(hints: &[(&str, &str)], width: u16) -> Vec<Span<'static>> {
    use crate::style::{dim, hint_action, hint_key};
    const SEP: &str = " · ";
    if hints.is_empty() || width == 0 {
        return Vec::new();
    }
    let seg = |key: &str, action: &str| -> Vec<Span<'static>> {
        vec![
            s(key.to_string(), hint_key()),
            s(format!(" {action}"), hint_action()),
        ]
    };
    let seg_w = |seg: &[Span<'static>]| -> usize {
        seg.iter()
            .map(|span| display_width(span.content.as_ref()))
            .sum()
    };
    let sep_w = display_width(SEP);
    let widths: Vec<usize> = hints.iter().map(|(k, a)| seg_w(&seg(k, a))).collect();
    let budget = width as usize;
    let join = |pairs: &[(&str, &str)]| -> Vec<Span<'static>> {
        let mut out = Vec::new();
        for (i, (key, action)) in pairs.iter().enumerate() {
            if i > 0 {
                out.push(s(SEP, dim()));
            }
            out.extend(seg(key, action));
        }
        out
    };

    let total: usize = widths.iter().sum::<usize>() + sep_w * (widths.len().saturating_sub(1));
    if total <= budget {
        return join(hints);
    }

    let (kept, last_fits) = fit_segments(&widths, budget, sep_w);
    let mut out = join(&hints[..kept]);
    let Some(&(last_key, last_action)) = hints.last() else {
        return out;
    };
    if last_fits {
        if !out.is_empty() {
            out.push(s(SEP, dim()));
        }
        out.extend(seg(last_key, last_action));
    } else if out.is_empty() {
        // Even the escape hatch does not fit — clip it rather than overflow.
        out.push(s(
            truncate_cells(&format!("{last_key} {last_action}"), budget),
            hint_action(),
        ));
    }
    out
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

/// Make `panel` an opaque floating surface: wipe whatever the layer below
/// painted, then fill with the panel background.
///
/// Both halves matter. `Clear` alone leaves every cell on `Color::Reset`, so
/// the user's terminal background shows through a themed dialog; a background
/// `Block` alone only *restyles* the cells, leaving the chat text underneath
/// legible straight through the dialog.
pub fn panel_bg(frame: &mut ratatui::Frame, panel: Rect) {
    if panel.width == 0 || panel.height == 0 {
        return;
    }
    frame.render_widget(ratatui::widgets::Clear, panel);
    frame.render_widget(
        ratatui::widgets::Block::default()
            .style(ratatui::style::Style::default().bg(crate::style::BG_PANEL())),
        panel,
    );
}

/// [`panel_bg`] for a bordered panel: wipe the layer below, then paint the
/// caller's `block` (borders, title, background) across the panel.
pub fn panel_block(frame: &mut ratatui::Frame, panel: Rect, block: ratatui::widgets::Block<'_>) {
    if panel.width == 0 || panel.height == 0 {
        return;
    }
    frame.render_widget(ratatui::widgets::Clear, panel);
    frame.render_widget(block, panel);
}

/// Dim everything behind a floating dialog without hiding it: glyphs stay
/// visible, recolored toward dim gray over a slightly lifted background.
///
/// Terminals have no alpha, so the "transparent gray" veil is faked by
/// converging every cell toward gray — fg blends hard toward `FG_DIM()`, bg
/// blends halfway toward `BG_PANEL()`. The modal card paints opaquely on top
/// afterwards (`panel_bg` / `modal_card` Clear first), so only the backdrop
/// outside the card is affected. `Reset` cells resolve to the theme canvas
/// first, keeping the no-`Reset`-background invariant intact.
pub fn dim_backdrop(frame: &mut ratatui::Frame, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let dim_fg = crate::style::FG_DIM();
    let veil_bg = crate::style::BG_PANEL();
    let canvas_bg = crate::style::BG();
    let canvas_fg = crate::style::FG();
    let buf = frame.buffer_mut();
    for y in area.y..area.y.saturating_add(area.height) {
        for x in area.x..area.x.saturating_add(area.width) {
            let Some(cell) = buf.cell_mut((x, y)) else {
                continue;
            };
            let fg = match cell.fg {
                ratatui::style::Color::Reset => canvas_fg,
                c => c,
            };
            let bg = match cell.bg {
                ratatui::style::Color::Reset => canvas_bg,
                c => c,
            };
            cell.set_fg(crate::style::blend_colors(fg, dim_fg, 0.65));
            cell.set_bg(crate::style::blend_colors(bg, veil_bg, 0.5));
        }
    }
}

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

/// `lead ········ trail`, exactly `width` cells on `bg`.
///
/// The trail keeps a two-cell gap and one cell of right padding. The lead
/// truncates to make room, down to 12 cells; past that the trail is dropped,
/// so a label is never squeezed out by its metadata.
pub fn justify(
    mut lead: Vec<Span<'static>>,
    trail: Vec<Span<'static>>,
    width: usize,
    bg: ratatui::style::Color,
) -> Vec<Span<'static>> {
    const MIN_LEAD: usize = 12;
    let cells = |spans: &[Span<'static>]| -> usize {
        spans.iter().map(|sp| display_width(&sp.content)).sum()
    };
    let lead_w = cells(&lead);
    let trail_w = cells(&trail);
    let lead_budget = width.saturating_sub(trail_w + 3);
    if trail_w > 0 && lead_budget >= lead_w.min(MIN_LEAD) {
        if lead_w > lead_budget {
            lead = fill_row(lead, lead_budget, bg);
        }
        let pad = width - lead_w.min(lead_budget) - trail_w - 1;
        lead.push(s(" ".repeat(pad), ratatui::style::Style::default().bg(bg)));
        lead.extend(trail);
    }
    fill_row(lead, width, bg)
}

/// Pad `spans` with background spaces out to `width` cells.
///
/// Paragraph only paints graphemes, so a row that stops mid-line leaves the
/// app background showing through a card. The pad uses `bg` alone — padding
/// spaces carry no visible fg.
pub fn fill_row(
    mut spans: Vec<ratatui::text::Span<'static>>,
    width: usize,
    bg: ratatui::style::Color,
) -> Vec<ratatui::text::Span<'static>> {
    let used: usize = spans
        .iter()
        .map(|span| display_width(span.content.as_ref()))
        .sum();

    if used > width {
        // Over-wide rows used only to be padded, never trimmed, so the caller's
        // "one row" became two: a tool-card header whose path filled the width
        // pushed its trailing `412ms` onto a bare second line with no indent.
        // Clamp here instead — every caller of this helper wants a row that is
        // exactly `width` cells.
        return clamp_row(spans, width, bg);
    }

    if used < width {
        spans.push(ratatui::text::Span::styled(
            " ".repeat(width - used),
            ratatui::style::Style::default().bg(bg),
        ));
    }
    spans
}

/// Trim `spans` to `width` display cells, ending in an ellipsis, keeping each
/// surviving fragment's own style.
fn clamp_row(
    spans: Vec<ratatui::text::Span<'static>>,
    width: usize,
    bg: ratatui::style::Color,
) -> Vec<ratatui::text::Span<'static>> {
    if width == 0 {
        return Vec::new();
    }
    let budget = width - 1; // room for the ellipsis
    let mut out: Vec<ratatui::text::Span<'static>> = Vec::new();
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
            let ch_width = display_width(ch.encode_utf8(&mut [0u8; 4]));
            if used + ch_width > budget {
                break;
            }
            used += ch_width;
            taken.push(ch);
        }
        if !taken.is_empty() {
            out.push(ratatui::text::Span::styled(taken, span.style));
        }
        break;
    }

    out.push(ratatui::text::Span::styled(
        "…".to_string(),
        ratatui::style::Style::default().bg(bg),
    ));
    used += 1;
    if used < width {
        out.push(ratatui::text::Span::styled(
            " ".repeat(width - used),
            ratatui::style::Style::default().bg(bg),
        ));
    }
    out
}

// ── Span / row helpers shared by chat and markdown ──────────────────────────

pub(crate) fn s(
    content: impl Into<Cow<'static, str>>,
    style: ratatui::style::Style,
) -> Span<'static> {
    Span::styled(content, style)
}

pub(crate) fn sp(text: &'static str) -> Span<'static> {
    Span::styled(text, ratatui::style::Style::default())
}

pub(crate) fn sf(text: &'static str, color: ratatui::style::Color) -> Span<'static> {
    Span::styled(text, ratatui::style::Style::default().fg(color))
}

/// Full-width blank row on the app background (never Reset).
pub(crate) fn themed_blank_row(width: usize) -> ratatui::text::Line<'static> {
    use ratatui::text::Line;
    if width == 0 {
        return Line::from(Span::styled(
            "",
            ratatui::style::Style::default().bg(crate::style::BG()),
        ));
    }
    Line::from(Span::styled(
        " ".repeat(width),
        ratatui::style::Style::default().bg(crate::style::BG()),
    ))
}

/// Tool icon lookup populated from the actual ToolRegistry.
/// Maps tool name -> icon character. Shared by chat cards and the activity strip.
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

/// Presentation metadata for a tool card. ONE table keyed first by tool
/// name (the 14 built-ins, preserving their exact look) and then by
/// [`agente_core::tools::ToolKind`] for everything else — a new core tool
/// of an existing kind needs zero TUI code.
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

const fn presentation_for_kind(kind: agente_core::tools::ToolKind) -> ToolPresentation {
    use agente_core::tools::ToolKind;
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
    use std::collections::HashMap;
    use std::sync::LazyLock;

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
        None => presentation_for_kind(agente_core::tools::ToolKind::Other),
    }
}

pub(crate) fn tool_icon_for(tool: &str) -> &'static str {
    tool_presentation(tool).icon
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

    /// True for code points terminals render two columns wide.
    fn is_wide(c: char) -> bool {
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
                    !is_wide(c),
                    "chrome glyph {glyph:?} contains double-width char U+{:04X}",
                    c as u32
                );
            }
        }
    }

    #[test]
    fn centered_panel_never_exceeds_its_area() {
        use ratatui::layout::Rect;
        let area = Rect::new(0, 0, 10, 4);
        let panel = centered_panel(area, 52, 9);
        assert_eq!(panel, Rect::new(0, 0, 10, 4));

        let area = Rect::new(3, 2, 40, 20);
        let panel = centered_panel(area, 20, 10);
        assert_eq!(panel, Rect::new(13, 7, 20, 10));
        assert!(panel.right() <= area.right() && panel.bottom() <= area.bottom());
    }

    #[test]
    fn panel_header_clamps_one_row_panel_and_returns_content_region() {
        use ratatui::backend::TestBackend;
        use ratatui::layout::Rect;
        use ratatui::Terminal;

        // A 1-row panel has no room for a header: returned untouched, nothing
        // painted (painting would eat the only content row).
        let backend = TestBackend::new(20, 3);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let panel = Rect::new(0, 0, 20, 1);
                assert_eq!(panel_header(f, panel, vec![sp("Title")]), panel);
            })
            .unwrap();
        let row0: String = (0..20)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(
            !row0.contains('─'),
            "nothing painted on a 1-row panel: {row0:?}"
        );

        // A taller panel: rule fills row 0 (inset 2), content region below.
        let backend = TestBackend::new(20, 4);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut content = Rect::ZERO;
        terminal
            .draw(|f| {
                content = panel_header(f, Rect::new(0, 0, 20, 4), vec![sp("Title")]);
            })
            .unwrap();
        assert_eq!(
            content,
            Rect::new(0, 1, 20, 3),
            "content region is below the header"
        );
        let row0: String = (0..20)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(
            row0.trim_start().starts_with("Title"),
            "title inset at the left: {row0:?}"
        );
        assert!(row0.contains('─'), "rule fills the header row: {row0:?}");
        assert!(
            row0.ends_with("  "),
            "header keeps the same right gutter as the footer"
        );
        let row1: String = (0..20)
            .map(|x| terminal.backend().buffer()[(x, 1)].symbol())
            .collect();
        assert!(
            !row1.contains('─'),
            "rule stays on the header row: {row1:?}"
        );
    }

    #[test]
    fn panel_footer_pins_to_last_row_and_clamps() {
        use ratatui::backend::TestBackend;
        use ratatui::layout::Rect;
        use ratatui::Terminal;

        let backend = TestBackend::new(20, 4);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                panel_footer(f, Rect::new(0, 0, 20, 4), vec![sp("Esc close")]);
                // Zero-sized panel: skipped, must not panic.
                panel_footer(f, Rect::new(0, 0, 0, 4), vec![sp("x")]);
            })
            .unwrap();
        let buf = terminal.backend().buffer();
        let last: String = (0..20).map(|x| buf[(x, 3)].symbol()).collect();
        assert!(
            last.contains("Esc close"),
            "footer pinned to the last row: {last:?}"
        );
        let row0: String = (0..20).map(|x| buf[(x, 0)].symbol()).collect();
        assert!(
            row0.trim().is_empty(),
            "nothing above the footer row: {row0:?}"
        );
    }

    #[test]
    fn footer_hints_narrow_by_dropping_middle_segments() {
        let text = |spans: Vec<Span<'static>>| -> String {
            spans.iter().map(|s| s.content.as_ref()).collect()
        };
        let hints = [("↑↓", "move"), ("Enter", "run"), ("Esc", "close")];

        // Wide row: every segment survives.
        assert_eq!(
            text(footer_hints(&hints, 60)),
            "↑↓ move · Enter run · Esc close"
        );
        // Exact fit keeps the first and the escape hatch.
        assert_eq!(text(footer_hints(&hints, 19)), "↑↓ move · Esc close");
        // Narrow: middle segments drop whole, the escape hatch stays.
        assert_eq!(text(footer_hints(&hints, 12)), "Esc close");
        // Absurdly narrow: the escape hatch is clipped, never overflowed.
        assert_eq!(text(footer_hints(&hints, 5)), "Esc …");
    }

    #[test]
    fn dim_backdrop_keeps_glyphs_but_mutes_them_toward_gray() {
        use ratatui::backend::TestBackend;
        use ratatui::layout::Rect;
        use ratatui::style::{Color, Style};
        use ratatui::text::{Line, Span};
        use ratatui::widgets::Paragraph;
        use ratatui::Terminal;

        let backend = TestBackend::new(10, 4);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                f.render_widget(
                    Paragraph::new(Line::from(vec![
                        Span::styled(
                            "hi",
                            Style::default()
                                .fg(Color::Rgb(255, 255, 255))
                                .bg(Color::Rgb(0, 0, 0)),
                        ),
                        Span::styled(
                            "!",
                            Style::default()
                                .fg(Color::Rgb(97, 175, 239))
                                .bg(Color::Rgb(0, 0, 0)),
                        ),
                    ])),
                    Rect::new(0, 0, 10, 1),
                );
                dim_backdrop(f, Rect::new(0, 0, 10, 2));
            })
            .unwrap();
        let buf = terminal.backend().buffer();
        // Glyphs survive the veil.
        let row0: String = (0..10).map(|x| buf[(x, 0)].symbol()).collect();
        assert!(row0.starts_with("hi!"), "glyphs stay visible: {row0:?}");
        // Bright white converges toward dim gray, the blue accent desaturates.
        let dim = crate::style::FG_DIM();
        let veil = crate::style::BG_PANEL();
        assert_eq!(
            buf[(0, 0)].fg,
            crate::style::blend_colors(Color::Rgb(255, 255, 255), dim, 0.65)
        );
        assert_eq!(
            buf[(2, 0)].fg,
            crate::style::blend_colors(Color::Rgb(97, 175, 239), dim, 0.65)
        );
        assert_eq!(
            buf[(0, 0)].bg,
            crate::style::blend_colors(Color::Rgb(0, 0, 0), veil, 0.5)
        );
        // Blank veil row: Reset resolves to the canvas, never left as Reset.
        assert_ne!(
            buf[(0, 1)].bg,
            Color::Reset,
            "no Reset background survives the veil"
        );
        // Outside the veil rect: untouched.
        assert_eq!(buf[(0, 3)].fg, Color::Reset);
        assert_eq!(buf[(0, 3)].bg, Color::Reset);
    }
}
