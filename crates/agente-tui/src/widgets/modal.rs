//! Borderless floating modal chrome, panel geometry, and footer hint layout.
//!
//! Every floating dialog shares one borderless surface (`BG_PANEL`) painted via
//! [`ModalChrome`] (or the lower-level [`centered_panel`] + [`modal_card`] +
//! [`modal_footer`] helpers). [`ModalChrome`] computes an inset `body: Rect`
//! guaranteed never to overlap the footer row, and sizes [`footer_hints`] to
//! the modal's inner width automatically.

use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph};
use ratatui::Frame;

use super::text::{display_width, s, truncate_cells, truncate_spans};

// ── Panel geometry ───────────────────────────────────────────────────────────

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

// ── Unified modal chrome ─────────────────────────────────────────────────────

/// Geometry produced by painting [`ModalChrome`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModalLayout {
    /// The outer panel rectangle.
    pub panel: Rect,
    /// The raw [`modal_card`] inner rect (inside the title row and bottom pad).
    pub inner: Rect,
    /// Inset content region guaranteed never to overlap the footer row.
    pub body: Rect,
}

impl ModalLayout {
    /// One row at offset `dy` inside `self.body`, clamped strictly above the footer.
    pub fn row(&self, dy: u16) -> Option<Rect> {
        if dy >= self.body.height || self.body.width == 0 {
            return None;
        }
        Some(Rect::new(self.body.x, self.body.y + dy, self.body.width, 1))
    }

    /// Remaining vertical slice of `self.body` starting at `dy` (guaranteed
    /// never to overlap the footer).
    pub fn slice_from(&self, dy: u16) -> Option<Rect> {
        if dy >= self.body.height || self.body.width == 0 {
            return None;
        }
        Some(Rect::new(
            self.body.x,
            self.body.y + dy,
            self.body.width,
            self.body.height - dy,
        ))
    }

    /// Paint a footer using the standard [`footer_hints`] grammar sized to this
    /// modal's inner width. Use when the hint list depends on content computed
    /// inside `self.body` (for example scrollability or current page range).
    pub fn render_footer(&self, frame: &mut Frame, hints: &[(&str, &str)]) {
        modal_footer(
            frame,
            self.inner,
            footer_hints(hints, self.inner.width.saturating_sub(2)),
        );
    }
}

/// Declarative borderless modal chrome: centered (or pre-placed) panel,
/// title row (optionally carrying a single status tint dot), safe inset body,
/// and width-budgeted footer hints.
pub struct ModalChrome<'a> {
    title: Vec<Span<'static>>,
    tint: Option<Color>,
    footer: &'a [(&'a str, &'a str)],
    top_gap: u16,
    footer_gap: u16,
    inset_x: u16,
}

impl<'a> ModalChrome<'a> {
    pub fn new(title: Vec<Span<'static>>) -> Self {
        Self {
            title,
            tint: None,
            footer: &[],
            top_gap: 1,
            footer_gap: 1,
            inset_x: 1,
        }
    }

    /// Add a status tint dot (`● `) before the title.
    pub fn tinted(mut self, color: Color) -> Self {
        self.tint = Some(color);
        self
    }

    /// Footer hint pairs rendered with [`footer_hints`] on the last inner row.
    pub fn footer(mut self, hints: &'a [(&'a str, &'a str)]) -> Self {
        self.footer = hints;
        self
    }

    /// Override the blank gap row(s) between the title row and `body` (default: 1).
    pub fn top_gap(mut self, rows: u16) -> Self {
        self.top_gap = rows;
        self
    }

    /// Override the blank gap row(s) between `body` and the footer row (default: 1).
    pub fn footer_gap(mut self, rows: u16) -> Self {
        self.footer_gap = rows;
        self
    }

    /// Override the horizontal inset inside `inner` (default: 1).
    pub fn inset_x(mut self, cols: u16) -> Self {
        self.inset_x = cols;
        self
    }

    /// Center a panel of `(want_w, want_h)` inside `area`, paint the modal
    /// chrome and footer, and return the safe [`ModalLayout`].
    pub fn render_centered(
        self,
        frame: &mut Frame,
        area: Rect,
        want_w: u16,
        want_h: u16,
    ) -> ModalLayout {
        let panel = centered_panel(area, want_w, want_h);
        self.render_in(frame, panel)
    }

    /// Paint the modal chrome and footer inside a pre-positioned `panel` rect.
    pub fn render_in(self, frame: &mut Frame, panel: Rect) -> ModalLayout {
        let inner = match self.tint {
            Some(color) => modal_card_tinted(frame, panel, self.title, color),
            None => modal_card(frame, panel, self.title),
        };
        if !self.footer.is_empty() {
            modal_footer(
                frame,
                inner,
                footer_hints(self.footer, inner.width.saturating_sub(2)),
            );
        }
        // Reserve footer row (1) + footer_gap below body, and top_gap above body.
        let footer_reserve = 1u16.saturating_add(self.footer_gap);
        let body_y = inner.y.saturating_add(self.top_gap);
        let max_y = inner.bottom().saturating_sub(footer_reserve);
        let body_h = max_y.saturating_sub(body_y);
        let body_x = inner.x.saturating_add(self.inset_x);
        let body_w = inner.width.saturating_sub(self.inset_x.saturating_mul(2));
        let body = Rect::new(body_x, body_y, body_w, body_h);
        ModalLayout { panel, inner, body }
    }
}

// ── Popup chrome: header rule + footer hints ─────────────────────────────────

/// A full-width horizontal rule (`─`) in the barely-visible `BORDER_RULE`
/// tone — the quiet separator under popup headers.
fn rule_span(width: usize) -> Span<'static> {
    s(
        "─".repeat(width),
        Style::default().fg(crate::style::BORDER_RULE()),
    )
}

/// Paint the header row of an already-backgrounded floating panel and return
/// the content region **below** it.
pub fn panel_header(frame: &mut Frame, panel: Rect, title_spans: Vec<Span<'static>>) -> Rect {
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
        spans.push(s(" ", Style::default()));
        if rule_w > 0 {
            spans.push(rule_span(rule_w));
        }
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(crate::style::BG_PANEL())),
        Rect::new(panel.x + inset, panel.y, row_w, 1),
    );
    Rect::new(panel.x, panel.y + 1, panel.width, panel.height - 1)
}

/// Modal card: a borderless opaque panel with the title on its first row.
/// The panel's background is the edge — no frame, so nothing inside it is a
/// box within a box.
pub fn modal_card(frame: &mut Frame, panel: Rect, title: Vec<Span<'static>>) -> Rect {
    modal_card_tinted(frame, panel, title, crate::style::BORDER_RULE())
}

/// [`modal_card`] carrying a status color (running subagent, destructive
/// approval, …) as one mark before the title, never a coloured frame.
pub fn modal_card_tinted(
    frame: &mut Frame,
    panel: Rect,
    title: Vec<Span<'static>>,
    border: Color,
) -> Rect {
    if panel.width < 10 || panel.height < 4 {
        panel_bg(frame, panel);
        return panel_header(frame, panel, title);
    }
    panel_bg(frame, panel);
    let bg = Style::default().bg(crate::style::BG_PANEL());
    let mut spans = Vec::new();
    if border != crate::style::BORDER_RULE() {
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
    frame.render_widget(Paragraph::new(Line::from(spans)).style(bg), title_row);
    Rect::new(
        panel.x.saturating_add(1),
        panel.y.saturating_add(1),
        panel.width.saturating_sub(2),
        panel.height.saturating_sub(2),
    )
}

/// Footer hints on the last row of a [`modal_card`] inner rect.
pub fn modal_footer(frame: &mut Frame, inner: Rect, hint_spans: Vec<Span<'static>>) {
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    let spans = truncate_spans(hint_spans, inner.width as usize);
    let pad = 1;
    let row = Rect::new(inner.x, inner.y + inner.height - 1, inner.width, 1);
    let mut padded = vec![s(
        " ".repeat(pad),
        Style::default().bg(crate::style::BG_PANEL()),
    )];
    padded.extend(spans);
    frame.render_widget(
        Paragraph::new(Line::from(padded)).style(Style::default().bg(crate::style::BG_PANEL())),
        row,
    );
}

/// Paint one hint row pinned to the last row of an already-backgrounded
/// panel (clamp-safe: a zero-sized panel is skipped).
pub fn panel_footer(frame: &mut Frame, panel: Rect, hint_spans: Vec<Span<'static>>) {
    if panel.width == 0 || panel.height == 0 {
        return;
    }
    let inset = 2u16.min(panel.width / 2);
    let row_w = panel.width.saturating_sub(inset.saturating_mul(2));
    if row_w == 0 {
        return;
    }
    frame.render_widget(
        Paragraph::new(Line::from(hint_spans)).style(Style::default().bg(crate::style::BG_PANEL())),
        Rect::new(panel.x + inset, panel.y + panel.height - 1, row_w, 1),
    );
}

/// How many leading segments survive next to the mandatory trailing segment.
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
pub fn footer_hints(hints: &[(&str, &str)], width: u16) -> Vec<Span<'static>> {
    use crate::style::{dim, hint_action, hint_key};
    const SEP: &str = " · ";
    if hints.is_empty() || width == 0 {
        return Vec::new();
    }
    let seg = |key: &str, action: &str| -> Vec<Span<'static>> {
        if action.is_empty() {
            vec![s(key.to_string(), hint_action())]
        } else {
            vec![
                s(key.to_string(), hint_key()),
                s(format!(" {action}"), hint_action()),
            ]
        }
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
        let fallback = if last_action.is_empty() {
            last_key.to_string()
        } else {
            format!("{last_key} {last_action}")
        };
        out.push(s(truncate_cells(&fallback, budget), hint_action()));
    }
    out
}

/// Make `panel` an opaque floating surface: wipe whatever the layer below
/// painted, then fill with the panel background.
pub fn panel_bg(frame: &mut Frame, panel: Rect) {
    if panel.width == 0 || panel.height == 0 {
        return;
    }
    frame.render_widget(Clear, panel);
    frame.render_widget(
        Block::default().style(Style::default().bg(crate::style::BG_PANEL())),
        panel,
    );
}

/// [`panel_bg`] for a bordered panel: wipe the layer below, then paint the
/// caller's `block` (borders, title, background) across the panel.
pub fn panel_block(frame: &mut Frame, panel: Rect, block: Block<'_>) {
    if panel.width == 0 || panel.height == 0 {
        return;
    }
    frame.render_widget(Clear, panel);
    frame.render_widget(block, panel);
}

/// Dim everything behind a floating dialog without hiding it: glyphs stay
/// visible, recolored toward dim gray over a slightly lifted background.
pub fn dim_backdrop(frame: &mut Frame, area: Rect) {
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
                Color::Reset => canvas_fg,
                c => c,
            };
            let bg = match cell.bg {
                Color::Reset => canvas_bg,
                c => c,
            };
            cell.set_fg(crate::style::blend_colors(fg, dim_fg, 0.65));
            cell.set_bg(crate::style::blend_colors(bg, veil_bg, 0.5));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::widgets::sp;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn centered_panel_never_exceeds_its_area() {
        let area = Rect::new(0, 0, 10, 4);
        let panel = centered_panel(area, 52, 9);
        assert_eq!(panel, Rect::new(0, 0, 10, 4));

        let area = Rect::new(3, 2, 40, 20);
        let panel = centered_panel(area, 20, 10);
        assert_eq!(panel, Rect::new(13, 7, 20, 10));
        assert!(panel.right() <= area.right() && panel.bottom() <= area.bottom());
    }

    #[test]
    fn modal_chrome_body_never_overlaps_footer() {
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        let mut layout = None;
        terminal
            .draw(|f| {
                layout = Some(
                    ModalChrome::new(vec![sp("Test")])
                        .footer(&[("Enter", "ok"), ("Esc", "close")])
                        .render_centered(f, f.area(), 30, 8),
                );
            })
            .unwrap();
        let layout = layout.unwrap();
        let footer_y = layout.inner.y + layout.inner.height - 1;
        assert!(
            layout.body.bottom() < footer_y,
            "body {:?} must stay strictly above footer row {footer_y}",
            layout.body
        );
    }

    #[test]
    fn panel_header_clamps_one_row_panel_and_returns_content_region() {
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
        let backend = TestBackend::new(20, 4);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                panel_footer(f, Rect::new(0, 0, 20, 4), vec![sp("Esc close")]);
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

        assert_eq!(
            text(footer_hints(&hints, 60)),
            "↑↓ move · Enter run · Esc close"
        );
        assert_eq!(text(footer_hints(&hints, 19)), "↑↓ move · Esc close");
        assert_eq!(text(footer_hints(&hints, 12)), "Esc close");
        assert_eq!(text(footer_hints(&hints, 5)), "Esc …");
    }

    #[test]
    fn dim_backdrop_keeps_glyphs_but_mutes_them_toward_gray() {
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
        let row0: String = (0..10).map(|x| buf[(x, 0)].symbol()).collect();
        assert!(row0.starts_with("hi!"), "glyphs stay visible: {row0:?}");
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
        assert_ne!(
            buf[(0, 1)].bg,
            Color::Reset,
            "no Reset background survives the veil"
        );
        assert_eq!(buf[(0, 3)].fg, Color::Reset);
        assert_eq!(buf[(0, 3)].bg, Color::Reset);
    }
}
