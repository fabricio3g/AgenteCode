use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::AppState;
use crate::style::{self, *};
use crate::widgets::{centered_panel, modal_card, modal_footer, truncate_cells};

const SHORTCUTS: &[(&str, &str)] = &[
    ("Ctrl+P", "Command palette"),
    ("Ctrl+N", "New session"),
    ("F2", "New tab (others keep running)"),
    ("Ctrl+PgUp/PgDn", "Switch tabs"),
    ("Ctrl+S", "Session picker"),
    ("Ctrl+Tab", "Cycle plan/build/auto mode"),
    ("Ctrl+O", "External editor"),
    ("Ctrl+L", "Clear conversation"),
    ("Ctrl+B", "Show changes in chat"),
    ("Ctrl+T", "Choose model thinking effort"),
    ("Ctrl+X", "View subagents"),
    ("Esc", "Interrupt / close popup"),
    ("Shift+Tab", "Cycle plan/build/auto mode"),
    ("Enter", "Submit message"),
    ("\\ + Enter", "Insert newline"),
    ("Paste", "Insert into input (never auto-sends)"),
    ("Drop / Ctrl+V", "Attach an image, audio, video or PDF"),
    ("Click tool", "Expand/collapse tool output"),
    ("Click subagent", "Open live detail modal · k kills"),
    ("Click msg", "Revert · fork · copy your message"),
    ("Drag select", "Copy selected chat text"),
    ("Click thinking", "Expand/collapse thinking header only"),
    ("Wheel / Shift+↑↓", "Scroll chat (works while generating)"),
    ("Click ↓", "Jump to bottom · resume follow"),
    ("Tab", "Slash command autocomplete"),
    ("PgUp/PgDn", "Scroll chat by page"),
    ("Shift+Up/Down", "Scroll chat by line"),
    ("Shift+G", "Scroll to bottom"),
    ("Shift+Home", "Scroll to top"),
];

/// Total binding count (used for scroll clamping outside the widget).
pub fn shortcut_count() -> usize {
    SHORTCUTS.len()
}

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    if !state.ui.show_help {
        return;
    }

    let width = 64u16;
    // gap(1) + rows + gap(1) + footer(1), title on the card border; clamp so
    // the panel scrolls on a short terminal instead of clipping out of bounds.
    let content_height = (SHORTCUTS.len() as u16 + 5).min(area.height);
    let panel = centered_panel(area, width, content_height);

    let bg_style = Style::new().bg(BG_PANEL());

    let body = modal_card(
        frame,
        panel,
        vec![
            Span::styled("Keyboard Shortcuts", style::bold()),
            Span::styled(
                format!(" · {} bindings", SHORTCUTS.len()),
                Style::default().fg(FG_DIM()),
            ),
        ],
    );

    let panel_bottom = body.y + body.height;
    // One gap row under the header, one above the footer.
    let first_row = body.y + 1;
    let row_limit = panel_bottom.saturating_sub(2);
    let visible_rows = row_limit.saturating_sub(first_row) as usize;
    state.ui.help_visible = visible_rows as u16;

    let start = state.ui.help_scroll as usize;
    let end = (start + visible_rows).min(SHORTCUTS.len());
    let row_w = body.width.saturating_sub(2);
    for (i, (key, action)) in SHORTCUTS[start..end].iter().enumerate() {
        let y = first_row + i as u16;
        if y >= row_limit {
            break;
        }
        let line = Line::from(vec![
            Span::styled(format!("{key:<18}"), Style::default().fg(PRIMARY())),
            Span::styled(action.to_string(), Style::default().fg(FG())),
        ]);
        frame.render_widget(
            Paragraph::new(line).style(bg_style),
            Rect::new(body.x + 1, y, row_w, 1),
        );
    }

    // The overlay covers the header, which is where the "F1 close" affordance
    // normally lives — so the footer has to carry it, overflow or not.
    let footer = if visible_rows < SHORTCUTS.len() && end > start {
        format!(
            "↑↓ scroll · {}–{} of {} · ? / F1 close",
            start + 1,
            end,
            SHORTCUTS.len()
        )
    } else {
        "? / F1 close".to_string()
    };
    modal_footer(
        frame,
        body,
        vec![Span::styled(
            truncate_cells(&footer, row_w as usize),
            Style::default().fg(FG_DIM()),
        )],
    );
}
