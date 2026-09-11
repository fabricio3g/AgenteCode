//! Welcome screen — clean wordmark card over the theme canvas.
//!
//! The home screen is static: a rounded hero card with the wordmark and the
//! quick actions. No background animation, no logo art.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::command_palette::Command;
use crate::state::AppState;
use crate::style;

/// Welcome home actions (label, key hint, command).
pub const WELCOME_ACTIONS: &[(&str, &str, Command)] = &[
    ("New session", "ctrl+n", Command::NewSession),
    ("Open project", "", Command::OpenProject),
    ("Resume session", "ctrl+s", Command::OpenSession),
    ("Help", "f1", Command::ShowHelp),
    ("Quit", "ctrl+c", Command::Quit),
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
        state.ui.welcome_button_rects.clear();
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

    // Bordered hero card: opaque surface, then the rounded rule border.
    let card_block = ratatui::widgets::Block::default()
        .borders(ratatui::widgets::Borders::ALL)
        .border_type(ratatui::widgets::BorderType::Rounded)
        .border_style(
            Style::default()
                .fg(style::BORDER_RULE())
                .bg(style::BG_PANEL()),
        )
        .style(Style::default().bg(style::BG_PANEL()));
    super::panel_block(frame, panel, card_block);
    let inner = Rect::new(
        panel.x.saturating_add(1),
        panel.y.saturating_add(1),
        panel.width.saturating_sub(2),
        panel.height.saturating_sub(2),
    );

    if inner.width == 0 || inner.height == 0 {
        state.ui.welcome_button_rects.clear();
        return;
    }

    let panel_bg = style::BG_PANEL();
    let brand_y = inner.y;
    // Left inset matching the menu's `› `/`  ` prefix, so the title and
    // detail rows never sit flush against the card border.
    let text_x = inner.x + 2.min(inner.width);
    let text_w = inner.width.saturating_sub(2);

    let selected = state
        .ui
        .welcome_selected
        .min(action_count().saturating_sub(1));
    state.ui.welcome_selected = selected;
    state.ui.welcome_button_rects.clear();

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

    for (i, (label, hint, _)) in WELCOME_ACTIONS.iter().enumerate() {
        let row_y = menu_y + i as u16;
        if row_y >= inner.y + inner.height {
            break;
        }
        let is_sel = i == selected;
        let band = if is_sel {
            style::BG_ELEMENT()
        } else {
            panel_bg
        };
        let (prefix, prefix_style) = if is_sel {
            (
                "› ",
                Style::default()
                    .fg(style::PRIMARY())
                    .bg(band)
                    .add_modifier(Modifier::BOLD),
            )
        } else {
            ("  ", Style::default().fg(style::FG_DIM()).bg(band))
        };
        let label_style = Style::default()
            .fg(if is_sel {
                style::FG()
            } else {
                style::FG_MUTED()
            })
            .bg(band)
            .add_modifier(if is_sel {
                Modifier::BOLD
            } else {
                Modifier::empty()
            });
        let mut spans = vec![
            Span::styled(prefix, prefix_style),
            Span::styled(label.to_string(), label_style),
        ];
        if !hint.is_empty() {
            let used =
                2 + crate::widgets::display_width(label) + crate::widgets::display_width(hint);
            // Stop one cell short of the card border: a hint flush against
            // the rule reads cramped, so the menu insets the same way.
            let budget = (text_w as usize).saturating_sub(1);
            let pad = budget.saturating_sub(used).max(1);
            spans.push(Span::styled(" ".repeat(pad), Style::default().bg(band)));
            spans.push(Span::styled(
                hint.to_string(),
                Style::default()
                    .fg(if is_sel {
                        style::FG_MUTED()
                    } else {
                        style::FG_DIM()
                    })
                    .bg(band),
            ));
        }
        let spans = crate::widgets::fill_row(spans, text_w as usize, band);
        frame.render_widget(
            Paragraph::new(Line::from(spans)),
            Rect::new(text_x, row_y, text_w, 1),
        );
        state
            .ui
            .welcome_button_rects
            .push(Rect::new(text_x, row_y, text_w, 1));
    }

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

/// Hit-test a cell against the welcome action buttons.
pub fn hit_test(state: &AppState, x: u16, y: u16) -> Option<usize> {
    if !state.ui.show_welcome_screen {
        return None;
    }
    state
        .ui
        .welcome_button_rects
        .iter()
        .position(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
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
        assert!(text.contains("ctrl+c"), "key hints on the menu rows");
        assert!(
            !text.contains('█') && !text.contains('▀') && !text.contains('▄'),
            "no block letter art"
        );
        assert!(!text.contains('◆'), "no logo art");
        assert!(
            !text.contains("is ready"),
            "the welcome screen must not name the active model"
        );
        assert_eq!(state.ui.welcome_button_rects.len(), 5);
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
        assert_eq!(state.ui.welcome_button_rects.len(), 5);
    }
}
