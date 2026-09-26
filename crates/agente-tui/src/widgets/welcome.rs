//! Welcome screen — clean wordmark card over the theme canvas.
//!
//! The home screen is static: a rounded hero card with the wordmark and the
//! quick actions. No background animation, no logo art.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::pick::{pick_list, row_label, PickItem};
use crate::command_palette::Command;
use crate::state::{AppState, ListId};
use crate::style;

/// Welcome home actions (label, key hint, command).
pub const WELCOME_ACTIONS: &[(&str, &str, Command)] = &[
    ("New session", "Ctrl+N", Command::NewSession),
    ("Open project", "", Command::OpenProject),
    ("Resume session", "Ctrl+S", Command::OpenSession),
    ("Help", "F1", Command::ShowHelp),
    ("Quit", "Ctrl+C", Command::Quit),
];

/// Number of quick-action buttons.
pub fn action_count() -> usize {
    WELCOME_ACTIONS.len()
}

/// Quick-action command at index.
pub fn action_at(index: usize) -> Option<Command> {
    WELCOME_ACTIONS.get(index).map(|(_, _, cmd)| *cmd)
}

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    if !state.ui.show_welcome_screen {
        return;
    }
    if area.width == 0 || area.height == 0 {
        return;
    }

    // Theme canvas. `render_app` already paints it; the standalone test and
    // harness callers rely on this fill for opaque (non-`Reset`) cells.
    frame.render_widget(
        Paragraph::new("").style(Style::default().bg(style::BG())),
        area,
    );

    // Card geometry — clamped, never a preference: a rect wider than the
    // buffer makes `Clear` index outside it (panic, not a clipped card).
    let connected = !state.config.current_provider.is_empty();
    // A connected session gets one guidance row under the wordmark.
    let detail_rows = if connected && area.height >= 13 { 1 } else { 0 };
    // Content rows: title + details + gap + menu.
    let content_rows = 1 + detail_rows + 1 + action_count() as u16;

    // Hero card: rounded border, narrow side margins, wide cap.
    let card_w = area.width.saturating_sub(6).min(96).min(area.width);
    if card_w < 10 || area.height < 4 {
        return;
    }
    let card_h = (content_rows + 2).min(area.height);
    let card_x = area.x + area.width.saturating_sub(card_w) / 2;

    // Vertical centering with a top bias (top_pad ≈ slack / 3): the card
    // floats just above center, leaving the tip + composer air below.
    let slack = area.height.saturating_sub(card_h);
    let top_pad = (slack / 3).min(slack);
    let box_y = area.y + top_pad;
    let panel = Rect::new(card_x, box_y, card_w, card_h);

    // Same untitled card chrome as every modal.
    let inner = super::modal_card(frame, panel, Vec::new());
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let panel_bg = style::BG_PANEL();
    let brand_y = inner.y;
    // Two-column inset shared by the title, detail and menu rows, so nothing
    // sits flush against the card border.
    let text_x = inner.x + 2.min(inner.width);
    let text_w = inner.width.saturating_sub(2);

    let selected = state
        .ui
        .welcome_selected
        .min(action_count().saturating_sub(1));
    state.ui.welcome_selected = selected;

    // ── Title: theme-foreground wordmark + dim version ──
    let title_spans = vec![
        Span::styled(
            "Agente Code",
            Style::default()
                .fg(style::FG())
                .bg(panel_bg)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  v{}", env!("CARGO_PKG_VERSION")),
            Style::default().fg(style::FG_DIM()).bg(panel_bg),
        ),
    ];
    if brand_y < inner.y + inner.height {
        frame.render_widget(
            Paragraph::new(Line::from(title_spans)).style(Style::default().bg(panel_bg)),
            Rect::new(text_x, brand_y, text_w, 1),
        );
    }

    if detail_rows > 0 {
        frame.render_widget(
            Paragraph::new(crate::widgets::truncate_cells(
                "Ask anything below · /model to switch",
                text_w as usize,
            ))
            .style(Style::default().fg(style::FG_DIM()).bg(panel_bg)),
            Rect::new(text_x, brand_y + 1, text_w, 1),
        );
    }

    // Menu rows share a measured column with the brand.
    let menu_y = brand_y.saturating_add(1 + detail_rows + 1);

    let menu_rows = (inner.y + inner.height).saturating_sub(menu_y);
    let items = WELCOME_ACTIONS
        .iter()
        .enumerate()
        .map(|(i, (label, hint, _))| {
            PickItem::row_with_trail(
                vec![Span::styled(label.to_string(), row_label(i == selected))],
                vec![Span::styled(hint.to_string(), style::dim())],
            )
        })
        .collect();
    pick_list(
        frame,
        Rect::new(text_x, menu_y, text_w, menu_rows.min(action_count() as u16)),
        &state.ui.hits,
        ListId::Welcome,
        items,
        selected,
    );

    // ── Tip line (bottom of the canvas, above the composer) ──
    let tip_y = area.y + area.height.saturating_sub(1);
    if connected && tip_y > panel.bottom() {
        let tip = "Tip: Try /model to switch models · /help for shortcuts";
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                format!(" {tip}"),
                Style::default().fg(style::FG_DIM()).bg(style::BG()),
            ))),
            Rect::new(area.x, tip_y, area.width, 1),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn shot(state: &mut AppState, w: u16, h: u16) -> String {
        let backend = TestBackend::new(w, h);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), state)).unwrap();
        let buf = terminal.backend().buffer();
        let mut s = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                s.push_str(buf[(x, y)].symbol());
            }
            s.push('\n');
        }
        s
    }

    fn menu_row(text: &str, needle: &str) -> u16 {
        text.lines()
            .position(|l| l.contains(needle))
            .expect("menu row") as u16
    }

    #[test]
    fn agente_welcome_is_normal_font_box_with_buttons() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/agente".into());
        state.ui.show_welcome_screen = true;
        let text = shot(&mut state, 80, 20);

        assert!(text.contains("Agente"), "wordmark");
        assert!(text.contains("Code"), "title-case Code suffix");
        assert!(!text.contains("CODE"), "no all-caps CODE");
        assert!(text.contains("New session"));
        assert!(text.contains("Resume session"));
        assert!(text.contains("Ctrl+C"), "key hints on the menu rows");
        assert!(
            !text.contains('█') && !text.contains('▀') && !text.contains('▄'),
            "no block letter art"
        );
        assert!(!text.contains('◆'), "no logo art");
        assert!(
            !text.contains("is ready"),
            "the welcome screen must not name the active model"
        );
        assert!(state.ui.hits.at(10, menu_row(&text, "Quit")).is_some());
    }

    #[test]
    fn first_run_hero_keeps_connection_guidance_in_the_composer() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/agente".into());
        state.ui.show_welcome_screen = true;
        let text = shot(&mut state, 80, 24);
        assert!(text.contains("Agente"), "wordmark rendered");
        assert!(!text.to_lowercase().contains("connect a provider"));
        assert!(!text.contains("Tip:"));
        assert!(text.contains("New session") && text.contains("Quit"));
        assert!(state.ui.hits.at(10, menu_row(&text, "Quit")).is_some());
    }
}
