//! Reasoning-effort picker (Ctrl+T, `/thinking`).
//!
//! The levels come from the resolved model's catalog metadata via
//! `agente_core::thinking::supported_thinking_levels`; the TUI does not invent
//! a global effort ladder.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style::{self, *};
use crate::widgets::pick::{current_mark, pick_list, row_label, PickItem};
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, panel_row, s};

/// One-line explanation of what each level costs the model.
fn level_hint(level: &str) -> &'static str {
    match level {
        "off" => "no reasoning tokens",
        "on" => "reasoning enabled",
        "low" => "brief reasoning",
        "medium" => "balanced",
        "high" => "thorough reasoning",
        "minimal" => "minimal reasoning",
        "xhigh" => "extra-high reasoning",
        "max" => "highest available effort",
        _ => "",
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_thinking_selector {
        return;
    }

    let levels = &state.input.thinking_selector_levels;
    let rows = if levels.is_empty() {
        3
    } else {
        levels.len().min(8)
    };
    // gap(1) + list + gap(1) + footer(1); the title rides the card border.
    let panel_height = (rows + 5) as u16;
    let panel_width = 46u16.min(area.width);
    let panel = centered_panel(area, panel_width, panel_height);
    if panel.width < 12 || panel.height < 5 {
        return;
    }

    let mut title_spans = vec![s(
        "Thinking effort",
        Style::default().fg(FG()).add_modifier(Modifier::BOLD),
    )];
    if !state.config.current_model.is_empty() {
        let display = state
            .get_model_display_name(&state.config.current_provider, &state.config.current_model);
        title_spans.push(s(format!(" · {display}"), Style::default().fg(FG_DIM())));
    }
    let body = modal_card(frame, panel, title_spans);

    let Some(list_top) = panel_row(body, 1, 1) else {
        return;
    };
    let list_area = Rect {
        height: body.height.saturating_sub(3),
        ..list_top
    };

    // No levels: explain it here rather than writing to chat history, which is
    // where this used to land.
    if levels.is_empty() {
        let model = state
            .config
            .resolve_model(&state.config.current_provider, &state.config.current_model);
        let (title, reason) = if state.config.current_model.is_empty() {
            ("No model selected", "Select a model first (/model).")
        } else if model.as_ref().is_some_and(|m| m.capabilities.reasoning) {
            (
                "Automatic reasoning",
                "This model exposes no effort controls.",
            )
        } else if state.config.config.catalog.is_none() {
            (
                "Reasoning metadata unavailable",
                "Refresh models with Ctrl+R in /model.",
            )
        } else {
            (
                "No reasoning controls",
                "This model reports no reasoning support.",
            )
        };
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(s(format!("  ◇ {title}"), Style::default().fg(FG_DIM()))),
                Line::from(""),
                Line::from(s(format!("  {reason}"), style::muted())),
            ]),
            list_area,
        );
    } else {
        let active = state.agent.thinking_level.as_str();
        let selected = state.input.thinking_selector_selected;
        let items = levels
            .iter()
            .enumerate()
            .map(|(i, level)| {
                let hint = level_hint(level);
                PickItem::row_with_trail(
                    vec![
                        current_mark(level == active),
                        s(level.clone(), row_label(i == selected)),
                    ],
                    if hint.is_empty() {
                        Vec::new()
                    } else {
                        vec![s(hint, style::dim())]
                    },
                )
            })
            .collect();
        pick_list(
            frame,
            list_area,
            &state.ui.hits,
            ListId::ThinkingSelector,
            items,
            selected,
        );
    }

    modal_footer(
        frame,
        body,
        footer_hints(
            &[("↑↓", "move"), ("Enter", "apply"), ("Esc", "close")],
            body.width.saturating_sub(2),
        ),
    );
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
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn state() -> AppState {
        let mut state = AppState::new(AppConfig::default(), "/tmp/thinking".into());
        state.input.show_thinking_selector = true;
        state
    }

    /// With no levels available the dialog explains itself instead of pushing a
    /// system message into the transcript, which is what the old cycle did.
    #[test]
    fn empty_levels_explain_inside_the_dialog() {
        let mut state = state();
        let text = shot(&mut state, 80, 24);
        assert!(text.contains("No model selected"), "{text}");
        assert!(
            state.session.chat_history.is_empty(),
            "the dialog must not write to chat history"
        );
    }

    #[test]
    fn long_catalog_keeps_the_selected_row_visible() {
        let mut state = state();
        let levels = (0..12).map(|i| format!("level-{i}")).collect::<Vec<_>>();
        state.input.open_thinking_selector(&levels, "level-11");
        let text = shot(&mut state, 80, 12);
        assert!(text.contains("level-11"), "{text}");
        assert!(
            !text.contains("level-0"),
            "the bounded picker should window long catalogs: {text}"
        );
    }

    #[test]
    fn empty_catalog_has_room_for_all_explanation_lines() {
        let mut state = state();
        let text = shot(&mut state, 80, 10);
        assert!(text.contains("No model selected"), "{text}");
        assert!(text.contains("Select a model first (/model)."), "{text}");
    }

    #[test]
    fn reasoning_without_effort_controls_is_shown_as_automatic() {
        let mut state = state();
        state.config.current_provider = "test-provider".into();
        state.config.current_model = "automatic".into();
        let mut model = agente_core::providers::fallback_model_info("test-provider", "automatic");
        model.capabilities.reasoning = true;
        state
            .config
            .discovered_models
            .insert("test-provider".into(), vec![model]);
        let text = shot(&mut state, 80, 12);
        assert!(text.contains("Automatic reasoning"), "{text}");
        assert!(text.contains("no effort controls"), "{text}");
    }

    /// A degenerate terminal must not panic or paint outside the frame.
    #[test]
    fn tiny_terminals_are_safe() {
        let state = state();
        for (w, h) in [(1u16, 1u16), (4, 3), (12, 5), (20, 8)] {
            let backend = TestBackend::new(w, h);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal.draw(|f| render(f, f.area(), &state)).unwrap();
            let buf = terminal.backend().buffer();
            assert_eq!((buf.area.width, buf.area.height), (w, h));
        }
    }
}
