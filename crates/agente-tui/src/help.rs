use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::AppState;
use crate::style::{self, *};
use crate::widgets::ModalChrome;

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
    let bg_style = Style::new().bg(BG_PANEL());

    let modal = ModalChrome::new(vec![
        Span::styled("Keyboard Shortcuts", style::bold()),
        Span::styled(
            format!(" · {} bindings", SHORTCUTS.len()),
            Style::default().fg(FG_DIM()),
        ),
    ])
    .render_centered(frame, area, width, content_height);

    let visible_rows = modal.body.height as usize;
    let start = state.ui.help_scroll.sync(SHORTCUTS.len(), visible_rows);
    let end = (start + visible_rows).min(SHORTCUTS.len());
    for (i, (key, action)) in SHORTCUTS[start..end].iter().enumerate() {
        let Some(row) = modal.row(i as u16) else {
            break;
        };
        let line = Line::from(vec![
            Span::styled(format!("{key:<18}"), crate::style::hint_key()),
            Span::styled(action.to_string(), Style::default().fg(FG())),
        ]);
        frame.render_widget(Paragraph::new(line).style(bg_style), row);
    }

    // The overlay covers the header, which is where the "F1 close" affordance
    // normally lives — so the footer has to carry it, overflow or not.
    if let Some(pos) = state
        .ui
        .help_scroll
        .position_label()
        .filter(|_| end > start)
    {
        modal.render_footer(
            frame,
            &[("↑↓", "scroll"), (pos.as_str(), ""), ("? / F1", "close")],
        );
    } else {
        modal.render_footer(frame, &[("? / F1", "close")]);
    }
}
