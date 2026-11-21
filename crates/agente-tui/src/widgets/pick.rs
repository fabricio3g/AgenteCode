//! Shared selectable lists: one row look, one scroll window, pointer hits.
//!
//! Every picker (palette, slash, @file, model, thinking, sessions, connect,
//! subagents, welcome menu) renders through [`pick_list`], so selection looks
//! the same everywhere: an accent `›` marker, a lifted `BG_ACTIVE` band and a
//! bold label. Rows register [`HitTarget::Row`] regions, which is what lets
//! the mouse router hover-select and click-confirm them.

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::{display_width, fill_row, justify, s};
use crate::state::{HitMap, HitTarget, ListId};
use crate::style;

/// Visual state of an interactive row or button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RowState {
    #[default]
    Idle,
    /// Under the pointer (buttons only — list rows select on hover).
    Hovered,
    Selected,
}

impl RowState {
    pub fn from_flags(selected: bool, hovered: bool) -> Self {
        if selected {
            Self::Selected
        } else if hovered {
            Self::Hovered
        } else {
            Self::Idle
        }
    }

    /// Background band for this state on a panel surface.
    pub fn bg(self) -> Color {
        match self {
            Self::Idle => style::BG_PANEL(),
            Self::Hovered => style::BG_HOVER(),
            Self::Selected => style::BG_ACTIVE(),
        }
    }
}

/// Label style for a list row: bold foreground when selected.
pub fn row_label(selected: bool) -> Style {
    let base = Style::default().fg(style::FG());
    if selected {
        base.add_modifier(Modifier::BOLD)
    } else {
        base
    }
}

/// Leading `◈` for the entry that is currently in effect (active model,
/// thinking level, …), or matching blank space so labels stay aligned.
pub fn current_mark(is_current: bool) -> Span<'static> {
    if is_current {
        s("◈ ", style::success())
    } else {
        s("  ", Style::default())
    }
}

/// One entry of a [`pick_list`].
pub enum PickItem {
    /// Non-selectable group title (provider name, "Available", …).
    Header(String),
    /// Selectable row: `lead` hugs the marker, `trail` is right-aligned and
    /// dropped first when the row is too narrow.
    Row {
        lead: Vec<Span<'static>>,
        trail: Vec<Span<'static>>,
    },
}

impl PickItem {
    pub fn row(lead: Vec<Span<'static>>) -> Self {
        Self::Row {
            lead,
            trail: Vec::new(),
        }
    }

    pub fn row_with_trail(lead: Vec<Span<'static>>, trail: Vec<Span<'static>>) -> Self {
        Self::Row { lead, trail }
    }
}

/// `› lead ········ trail` on the row band, exactly `width` cells.
pub fn list_row(
    selected: bool,
    lead: Vec<Span<'static>>,
    trail: Vec<Span<'static>>,
    width: usize,
) -> Line<'static> {
    let bg = RowState::from_flags(selected, false).bg();
    let on_bg = |span: Span<'static>| {
        let style = span.style.bg(bg);
        span.style(style)
    };
    let marker = if selected {
        s("› ", style::accent().add_modifier(Modifier::BOLD))
    } else {
        s("  ", Style::default())
    };
    let lead = std::iter::once(marker).chain(lead).map(on_bg).collect();
    let trail = trail.into_iter().map(on_bg).collect();
    Line::from(justify(lead, trail, width, bg))
}

fn header_line(title: &str, width: usize) -> Line<'static> {
    let spans = vec![s(
        format!("  {title}"),
        Style::default()
            .fg(style::FG_DIM())
            .bg(style::BG_PANEL())
            .add_modifier(Modifier::BOLD),
    )];
    Line::from(fill_row(spans, width, style::BG_PANEL()))
}

/// Render `items` into `area` with row `selected` (logical row index, headers
/// excluded) highlighted and kept in view. Returns the number of rows drawn.
pub fn pick_list(
    frame: &mut Frame,
    area: Rect,
    hits: &HitMap,
    list: ListId,
    items: Vec<PickItem>,
    selected: usize,
) -> usize {
    frame.render_widget(
        Paragraph::new("").style(Style::default().bg(style::BG_PANEL())),
        area,
    );
    let rows = items
        .iter()
        .filter(|item| matches!(item, PickItem::Row { .. }))
        .count();
    if area.width == 0 || area.height == 0 || rows == 0 {
        return 0;
    }
    let selected = selected.min(rows - 1);

    // Logical row index per visual line (None for headers).
    let mut logical = Vec::with_capacity(items.len());
    let mut next = 0usize;
    for item in &items {
        if matches!(item, PickItem::Row { .. }) {
            logical.push(Some(next));
            next += 1;
        } else {
            logical.push(None);
        }
    }
    let selected_visual = logical
        .iter()
        .position(|idx| *idx == Some(selected))
        .unwrap_or(0);
    let visible = area.height as usize;
    let start = hits.window_start(list, items.len(), selected_visual, visible);
    let width = area.width as usize;

    let mut drawn = 0usize;
    for (offset, (item, index)) in items
        .into_iter()
        .zip(logical)
        .skip(start)
        .take(visible)
        .enumerate()
    {
        let row = Rect::new(area.x, area.y + offset as u16, area.width, 1);
        let line = match item {
            PickItem::Header(title) => header_line(&title, width),
            PickItem::Row { lead, trail } => {
                let index = index.unwrap_or_default();
                hits.push(row, HitTarget::Row { list, index });
                list_row(index == selected, lead, trail, width)
            }
        };
        frame.render_widget(Paragraph::new(line), row);
        drawn += 1;
    }
    drawn
}

/// One-row text field on a lifted `BG_ELEMENT` bar. The accent caret sits
/// where typing lands: after the typed `text`, or *before* the dim
/// `placeholder` when empty (a caret after the placeholder reads as if the
/// placeholder had been typed). Shared by every modal that takes input.
pub fn search_field(frame: &mut Frame, area: Rect, text: &str, placeholder: &str) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let bg = style::BG_ELEMENT();
    let pad = s(" ", Style::default().bg(bg));
    let caret = s("▌", style::accent().bg(bg));
    let line = if text.is_empty() {
        Line::from(vec![
            pad,
            caret,
            s(placeholder.to_string(), style::dim().bg(bg)),
        ])
    } else {
        // Keep the caret visible: show the trailing suffix that fits within
        // `budget` terminal cells (CJK/emoji count as 2 cells).
        let budget = (area.width as usize).saturating_sub(3);
        let shown = tail_cells(text, budget);
        Line::from(vec![pad, s(shown, style::text().bg(bg)), caret])
    };
    frame.render_widget(Paragraph::new(line).style(Style::default().bg(bg)), area);
}

/// Trailing suffix of `text` whose terminal cell width fits in `budget`.
fn tail_cells(text: &str, budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }
    if display_width(text) <= budget {
        return text.to_string();
    }
    let mut used = 0usize;
    let mut start = text.len();
    for (idx, ch) in text.char_indices().rev() {
        let w = if super::is_wide_char(ch) { 2 } else { 1 };
        if used + w > budget {
            break;
        }
        used += w;
        start = idx;
    }
    text[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn row_text(buf: &ratatui::buffer::Buffer, y: u16) -> String {
        (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect()
    }

    #[test]
    fn rows_share_one_selection_look_and_register_hits() {
        let hits = HitMap::default();
        let mut terminal = Terminal::new(TestBackend::new(30, 4)).unwrap();
        terminal
            .draw(|frame| {
                let items = vec![
                    PickItem::Header("Group".into()),
                    PickItem::row_with_trail(
                        vec![s("alpha", row_label(false))],
                        vec![s("⌘A", style::dim())],
                    ),
                    PickItem::row(vec![s("beta", row_label(true))]),
                ];
                pick_list(frame, frame.area(), &hits, ListId::CommandPalette, items, 1);
            })
            .unwrap();
        let buf = terminal.backend().buffer();
        assert!(row_text(buf, 0).starts_with("  Group"));
        assert!(row_text(buf, 1).starts_with("  alpha"));
        assert!(row_text(buf, 1).trim_end().ends_with("⌘A"));
        assert!(row_text(buf, 2).starts_with("› beta"));
        assert_eq!(buf[(10, 2)].bg, style::BG_ACTIVE());
        assert_eq!(
            hits.at(5, 1),
            Some(HitTarget::Row {
                list: ListId::CommandPalette,
                index: 0
            })
        );
        assert_eq!(hits.at(5, 0), None, "headers are not selectable");
    }

    #[test]
    fn narrow_rows_drop_the_trail_before_the_label() {
        let line = list_row(
            false,
            vec![s("a-long-label", Style::default())],
            vec![s("trail", Style::default())],
            16,
        );
        let text: String = line.spans.iter().map(|sp| sp.content.as_ref()).collect();
        assert_eq!(text, "  a-long-label  ");
    }

    #[test]
    fn long_leads_truncate_to_keep_the_trail() {
        let line = list_row(
            false,
            vec![s("name  a very long description", Style::default())],
            vec![s("key", Style::default())],
            24,
        );
        let text: String = line.spans.iter().map(|sp| sp.content.as_ref()).collect();
        assert_eq!(text, "  name  a very lo…  key ");
    }

    #[test]
    fn search_field_tail_scrolls_cjk_by_display_cells() {
        assert_eq!(tail_cells("你好世界测试", 6), "界测试");
        assert_eq!(tail_cells("你好世界测试", 5), "测试");
        assert_eq!(tail_cells("abc", 10), "abc");

        let mut terminal = Terminal::new(TestBackend::new(10, 1)).unwrap();
        terminal
            .draw(|frame| search_field(frame, frame.area(), "你好世界测试", "Search"))
            .unwrap();
        let row = row_text(terminal.backend().buffer(), 0);
        let compact: String = row.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            compact.contains("界测试▌"),
            "tail CJK chars and caret must stay visible: {row:?}"
        );
    }
}
