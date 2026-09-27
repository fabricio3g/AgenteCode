//! The session tab strip: one row at the top, shown once two or more tabs
//! are open.
//!
//! `1 ● Fix the parser ×   2 ◆ Release notes   +`
//!
//! The active tab sits on the `BG_ACTIVE` band in bold; a hovered tab lifts
//! to `BG_HOVER`. The mark before a title says what the tab is doing:
//! accent `●` working, warning `◆` waiting for approval, success `●`
//! finished while you were elsewhere. `×` shows on the active and the
//! hovered tab. When the tabs do not fit, the window slides to keep the
//! active one visible and `‹ n` / `n ›` count the hidden ones.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::{display_width, truncate_cells};
use crate::state::{HitTarget, TabLabel, TabStatus, UiState};
use crate::style::{ACCENT, BG, BG_ACTIVE, BG_HOVER, FG, FG_DIM, FG_MUTED, SUCCESS, WARNING};

/// Longest title a tab shows.
const MAX_TITLE: usize = 24;

fn status_mark(status: TabStatus) -> Option<(&'static str, ratatui::style::Color)> {
    match status {
        TabStatus::Idle => None,
        TabStatus::Working => Some(("●", ACCENT())),
        TabStatus::NeedsApproval => Some(("◆", WARNING())),
        TabStatus::Unseen => Some(("●", SUCCESS())),
    }
}

/// One tab's cells: ` 1 ● title × `.
struct Cell {
    spans: Vec<Span<'static>>,
    width: u16,
    /// Offset of the `×` inside the cell, when shown.
    close_at: Option<u16>,
}

fn build_cell(index: usize, tab: &TabLabel, active: bool, hovered: bool) -> Cell {
    let bg = if active {
        BG_ACTIVE()
    } else if hovered {
        BG_HOVER()
    } else {
        BG()
    };
    let text = Style::default()
        .bg(bg)
        .fg(if active { FG() } else { FG_MUTED() });
    let text = if active {
        text.add_modifier(Modifier::BOLD)
    } else {
        text
    };
    let mut spans = vec![
        Span::styled(" ", Style::default().bg(bg)),
        Span::styled(
            format!("{} ", index + 1),
            Style::default().bg(bg).fg(FG_DIM()),
        ),
    ];
    if let Some((mark, color)) = status_mark(tab.status) {
        spans.push(Span::styled(
            format!("{mark} "),
            Style::default().bg(bg).fg(color),
        ));
    }
    spans.push(Span::styled(truncate_cells(&tab.title, MAX_TITLE), text));
    let mut close_at = None;
    if active || hovered {
        let used: usize = spans.iter().map(|s| display_width(&s.content)).sum();
        close_at = Some(used as u16 + 1);
        spans.push(Span::styled(" ×", Style::default().bg(bg).fg(FG_DIM())));
    }
    spans.push(Span::styled(" ", Style::default().bg(bg)));
    let width = spans
        .iter()
        .map(|s| display_width(&s.content))
        .sum::<usize>() as u16;
    Cell {
        spans,
        width,
        close_at,
    }
}

/// Which tabs fit in `budget` cells, as a range around `active`.
fn window(widths: &[u16], active: usize, budget: u16) -> (usize, usize) {
    let (mut start, mut end) = (active, active + 1);
    let mut used = widths[active];
    loop {
        let mut grew = false;
        if end < widths.len() && used + widths[end] <= budget {
            used += widths[end];
            end += 1;
            grew = true;
        }
        if start > 0 && used + widths[start - 1] <= budget {
            used += widths[start - 1];
            start -= 1;
            grew = true;
        }
        if !grew {
            return (start, end);
        }
    }
}

pub fn render(frame: &mut Frame, area: Rect, ui: &UiState) {
    let strip = &ui.tab_strip;
    if area.height == 0 || area.width < 12 || strip.tabs.is_empty() {
        return;
    }
    frame.render_widget(Paragraph::new("").style(Style::default().bg(BG())), area);
    let hovered_tab = match &ui.hovered_hit {
        Some(HitTarget::Tab(i) | HitTarget::TabClose(i)) => Some(*i),
        _ => None,
    };
    let active = strip.active.min(strip.tabs.len() - 1);
    let cells: Vec<Cell> = strip
        .tabs
        .iter()
        .enumerate()
        .map(|(i, tab)| build_cell(i, tab, i == active, hovered_tab == Some(i)))
        .collect();
    let plus_hover = matches!(ui.hovered_hit, Some(HitTarget::NewTab));
    // Room for `+` and the overflow counters.
    let budget = area.width.saturating_sub(12);
    let widths: Vec<u16> = cells.iter().map(|c| c.width).collect();
    let (start, end) = window(&widths, active, budget.max(widths[active]));

    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut x = area.x;
    let dim = Style::default().bg(BG()).fg(FG_DIM());
    if start > 0 {
        let text = format!(" ‹ {start} ");
        x += display_width(&text) as u16;
        spans.push(Span::styled(text, dim));
    } else {
        spans.push(Span::styled(" ", dim));
        x += 1;
    }
    for (offset, cell) in cells[start..end].iter().enumerate() {
        let index = start + offset;
        let rect = Rect::new(x, area.y, cell.width.min(area.right().saturating_sub(x)), 1);
        ui.hits.push(rect, HitTarget::Tab(index));
        if let Some(close) = cell.close_at {
            ui.hits.push(
                Rect::new(x + close, area.y, 2, 1),
                HitTarget::TabClose(index),
            );
        }
        spans.extend(cell.spans.iter().cloned());
        x += cell.width;
    }
    if end < cells.len() {
        let text = format!(" {} › ", cells.len() - end);
        x += display_width(&text) as u16;
        spans.push(Span::styled(text, dim));
    }
    let plus_bg = if plus_hover { BG_HOVER() } else { BG() };
    let plus = Span::styled(
        " + ",
        Style::default()
            .bg(plus_bg)
            .fg(if plus_hover { FG() } else { FG_DIM() }),
    );
    if x + 3 <= area.right() {
        ui.hits.push(Rect::new(x, area.y, 3, 1), HitTarget::NewTab);
        spans.push(plus);
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(BG())),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::TabStrip;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn label(title: &str, status: TabStatus) -> TabLabel {
        TabLabel {
            title: title.into(),
            status,
        }
    }

    fn draw(ui: &UiState, width: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, 1)).unwrap();
        terminal.draw(|f| render(f, f.area(), ui)).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    #[test]
    fn strip_shows_numbers_status_and_the_close_mark_on_the_active_tab() {
        let ui = UiState {
            tab_strip: TabStrip {
                tabs: vec![
                    label("Fix the parser", TabStatus::Working),
                    label("Release notes", TabStatus::NeedsApproval),
                    label("New session", TabStatus::Unseen),
                ],
                active: 1,
            },
            ..UiState::default()
        };
        let text = draw(&ui, 100);
        assert!(text.contains("1 ● Fix the parser"), "{text}");
        assert!(text.contains("2 ◆ Release notes ×"), "{text}");
        assert!(text.contains("3 ● New session"), "{text}");
        assert!(
            !text.contains("Fix the parser ×"),
            "× only on active/hovered"
        );
        assert!(text.contains(" + "), "{text}");
        assert_eq!(ui.hits.at(2, 0), Some(HitTarget::Tab(0)));
    }

    #[test]
    fn overflow_keeps_the_active_tab_in_view() {
        let ui = UiState {
            tab_strip: TabStrip {
                tabs: (0..8)
                    .map(|i| label(&format!("session number {i}"), TabStatus::Idle))
                    .collect(),
                active: 6,
            },
            ..UiState::default()
        };
        let text = draw(&ui, 60);
        assert!(text.contains("7 session number 6"), "{text}");
        assert!(
            text.contains("‹"),
            "hidden tabs on the left are counted: {text}"
        );
    }
}
