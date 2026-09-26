//! One scrollbar for every scrollable surface (chat, plan review, subagent
//! detail): a thin thumb with no track, brighter while hovered or dragged.
//!
//! Painting registers a [`HitTarget::Scrollbar`] carrying the bar's geometry,
//! so the mouse router can turn any pointer row into an offset for whichever
//! surface the bar belongs to — click the track to jump, drag to scrub.

use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::{HitTarget, UiState};
use crate::style::{FG_DIM, FG_MUTED};

/// Which surface a scrollbar drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollSurface {
    Chat,
    Plan,
    SubagentDetail,
    Process,
}

/// A painted scrollbar: enough to map a pointer row back to an offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollbarGeom {
    pub surface: ScrollSurface,
    /// The one-column track.
    pub track: Rect,
    pub thumb_len: u16,
    pub max_offset: usize,
}

impl ScrollbarGeom {
    /// Offset that puts the thumb's middle under `row`.
    pub fn offset_at(&self, row: u16) -> usize {
        let movable = self.track.height.saturating_sub(self.thumb_len);
        if movable == 0 || self.max_offset == 0 {
            return 0;
        }
        let pos = row
            .saturating_sub(self.track.y)
            .saturating_sub(self.thumb_len / 2)
            .min(movable);
        ((f64::from(pos) / f64::from(movable)) * self.max_offset as f64).round() as usize
    }
}

/// `12–25 of 120` — where the viewport sits, for a header or footer.
pub fn position_label(offset: usize, visible: usize, total: usize) -> Option<String> {
    (total > visible).then(|| {
        let first = offset.min(total.saturating_sub(visible)) + 1;
        format!("{first}–{} of {total}", (first - 1 + visible).min(total))
    })
}

/// A scrolled view: `visible` rows shown from `offset` of `total`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewport {
    pub offset: usize,
    pub visible: usize,
    pub total: usize,
}

/// Paint the thumb in the one-column `area` for `view`. Blank (and no hit
/// target) when everything fits.
pub fn render(
    frame: &mut Frame,
    area: Rect,
    surface: ScrollSurface,
    view: Viewport,
    bg: Color,
    ui: &UiState,
) -> Option<ScrollbarGeom> {
    let Viewport {
        offset,
        visible,
        total,
    } = view;
    let blank = |frame: &mut Frame| {
        frame.render_widget(Paragraph::new("").style(Style::default().bg(bg)), area);
    };
    if area.width == 0 || area.height == 0 || total <= visible {
        blank(frame);
        return None;
    }
    let height = area.height;
    let max_offset = total - visible;
    let thumb_len =
        ((f64::from(height) * visible as f64 / total as f64).round() as u16).clamp(1, height);
    let thumb_pos = ((f64::from(height - thumb_len) * offset.min(max_offset) as f64
        / max_offset as f64)
        .round()) as u16;
    let track = Rect::new(area.x, area.y, 1, height);
    let geom = ScrollbarGeom {
        surface,
        track,
        thumb_len,
        max_offset,
    };

    let active = ui.scroll_drag.is_some_and(|g| g.surface == surface)
        || matches!(ui.hovered_hit, Some(HitTarget::Scrollbar(g)) if g.surface == surface);
    let thumb = Style::default()
        .fg(if active { FG_MUTED() } else { FG_DIM() })
        .bg(bg);
    let lines: Vec<Line<'static>> = (0..height)
        .map(|i| {
            if (thumb_pos..thumb_pos + thumb_len).contains(&i) {
                Line::from(Span::styled("┃", thumb))
            } else {
                Line::from(Span::styled(" ", Style::default().bg(bg)))
            }
        })
        .collect();
    frame.render_widget(Paragraph::new(lines).style(Style::default().bg(bg)), track);
    // One extra column on the left: a one-cell target is fiddly to grab.
    let grab = Rect::new(area.x.saturating_sub(1), area.y, 2, height);
    ui.hits.push(grab, HitTarget::Scrollbar(geom));
    Some(geom)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_rows_map_across_the_whole_range() {
        let geom = ScrollbarGeom {
            surface: ScrollSurface::Plan,
            track: Rect::new(10, 5, 1, 20),
            thumb_len: 4,
            max_offset: 160,
        };
        assert_eq!(geom.offset_at(5), 0, "top of the track");
        assert_eq!(geom.offset_at(0), 0, "above clamps");
        assert_eq!(geom.offset_at(24), 160, "bottom of the track");
        assert_eq!(geom.offset_at(99), 160, "below clamps");
        let mid = geom.offset_at(15);
        assert!((70..=90).contains(&mid), "{mid}");
    }

    #[test]
    fn position_label_reads_like_a_pager() {
        assert_eq!(position_label(0, 20, 120).as_deref(), Some("1–20 of 120"));
        assert_eq!(
            position_label(100, 20, 120).as_deref(),
            Some("101–120 of 120")
        );
        assert_eq!(position_label(0, 20, 10), None, "fits: nothing to say");
    }
}
