//! Unified clickable button/chip strip registering [`HitTarget`]s automatically.
//!
//! Shared by `approval`, `plan_review`, `plan_ask`, and `subagent_detail` so
//! horizontal chip/button bars never duplicate cursor-x accounting or hit-rect
//! registration.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::text::{display_width, s};
use crate::state::{HitMap, HitTarget};
use crate::style;

/// One clickable button or chip inside an action strip.
#[derive(Debug, Clone)]
pub struct ActionChip {
    /// Leading badge/cap text (or the whole chip text when `label` is empty).
    pub cap: String,
    pub cap_style: Style,
    /// Optional trailing label text rendered immediately after `cap`.
    pub label: String,
    pub label_style: Style,
    /// Hit target registered for the rendered chip rect.
    pub target: HitTarget,
    /// Columns trimmed from the right edge of the registered hit rect (e.g.
    /// when `label` carries trailing visual spacing).
    pub hit_trim: u16,
}

impl ActionChip {
    /// Single-segment chip (tabs, option chips).
    pub fn chip(text: impl Into<String>, chip_style: Style, target: HitTarget) -> Self {
        Self {
            cap: text.into(),
            cap_style: chip_style,
            label: String::new(),
            label_style: Style::default(),
            target,
            hit_trim: 0,
        }
    }

    /// Two-segment button (`cap` + `label`, e.g. ` Allow ` + ` Enter` or ` A ` + ` Accept  `).
    pub fn button(
        cap: impl Into<String>,
        cap_style: Style,
        label: impl Into<String>,
        label_style: Style,
        target: HitTarget,
    ) -> Self {
        Self {
            cap: cap.into(),
            cap_style,
            label: label.into(),
            label_style,
            target,
            hit_trim: 0,
        }
    }

    pub fn with_hit_trim(mut self, trim: u16) -> Self {
        self.hit_trim = trim;
        self
    }

    pub fn width(&self) -> u16 {
        (display_width(&self.cap) + display_width(&self.label)) as u16
    }
}

/// Register [`HitTarget`]s for `chips` laid out left-to-right starting at
/// `row.x` and return the corresponding spans. Callers that need to right-align
/// metadata on the same row (e.g. `subagent_detail` tabs + scroll position) can
/// pass the returned spans directly to [`crate::widgets::justify`].
pub fn build_action_spans(
    row: Rect,
    chips: &[ActionChip],
    gap: u16,
    gap_style: Style,
    hits: &HitMap,
) -> Vec<Span<'static>> {
    let mut spans = Vec::with_capacity(chips.len() * 3);
    let mut x = row.x;
    for (idx, chip) in chips.iter().enumerate() {
        if idx > 0 && gap > 0 {
            let avail = row.right().saturating_sub(x);
            if avail == 0 {
                break;
            }
            let gap_w = gap.min(avail);
            spans.push(s(" ".repeat(gap_w as usize), gap_style));
            x = x.saturating_add(gap_w);
        }
        let avail = row.right().saturating_sub(x);
        if avail == 0 {
            break;
        }
        let width = chip.width();
        let hit_w = width.saturating_sub(chip.hit_trim).min(avail);
        if hit_w > 0 && row.height > 0 {
            hits.push(Rect::new(x, row.y, hit_w, 1), chip.target.clone());
        }
        if !chip.cap.is_empty() {
            spans.push(s(chip.cap.clone(), chip.cap_style));
        }
        if !chip.label.is_empty() {
            spans.push(s(chip.label.clone(), chip.label_style));
        }
        x = x.saturating_add(width);
    }
    spans
}

/// Paint a horizontal action bar on `BG_PANEL` into `row`, registering each
/// chip's [`HitTarget`] automatically, followed by any optional `trailing` spans.
pub fn render_action_bar(
    frame: &mut Frame,
    row: Rect,
    chips: &[ActionChip],
    gap: u16,
    trailing: Vec<Span<'static>>,
    hits: &HitMap,
) {
    if row.width == 0 || row.height == 0 {
        return;
    }
    let panel = style::panel();
    frame.render_widget(Paragraph::new("").style(panel), row);
    let mut spans = build_action_spans(row, chips, gap, panel, hits);
    spans.extend(trailing);
    frame.render_widget(Paragraph::new(Line::from(spans)).style(panel), row);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn action_bar_paints_chips_and_registers_exact_hit_rects() {
        let hits = HitMap::default();
        let chips = vec![
            ActionChip::chip(" One ", style::bold(), HitTarget::PlanAction(0)),
            ActionChip::chip(" Two ", style::muted(), HitTarget::PlanAction(1)),
        ];
        let mut terminal = Terminal::new(TestBackend::new(30, 1)).unwrap();
        terminal
            .draw(|f| {
                render_action_bar(f, Rect::new(2, 0, 26, 1), &chips, 2, Vec::new(), &hits);
            })
            .unwrap();
        assert_eq!(hits.at(2, 0), Some(HitTarget::PlanAction(0)));
        assert_eq!(hits.at(6, 0), Some(HitTarget::PlanAction(0)));
        assert_eq!(hits.at(7, 0), None, "gap between chips is not a hit");
        assert_eq!(hits.at(9, 0), Some(HitTarget::PlanAction(1)));
        assert_eq!(hits.at(13, 0), Some(HitTarget::PlanAction(1)));
    }
}
