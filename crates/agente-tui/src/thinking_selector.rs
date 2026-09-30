//! Thinking-effort scale (Ctrl+T, `/thinking`).
//!
//! The levels, their order (low → high), the default `auto` resolves to and
//! each level's thinking-token budget come from the resolved model's
//! `agente_core::thinking::ThinkingProfile` — the same profile Agente
//! Desktop's slider shows. The TUI does not invent a global effort ladder.
//!
//! ```text
//!  Faster              Thinking mode              Deeper
//!  ━━━━━━━━━━━●┄┄┄┄┄┄┄┄┄┄┄┄┄·┄┄┄┄┄┄┄┄┄┄┄┄┄·
//!  auto      off       low      medium     high     max
//!            Current ▂▄▆ medium · up to 2k tokens
//! ```

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::{AppState, HitTarget, ListId};
use crate::style::{self, *};
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, panel_row, s};

/// One-line explanation of what each level costs the model.
fn level_hint(level: &str) -> &'static str {
    match level {
        "auto" => "the provider's default",
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

/// How many of the meter's four bars a level fills (Desktop's `effortBars`).
fn effort_bars(level: &str) -> usize {
    match level {
        "auto" | "off" | "none" => 0,
        "minimal" | "low" => 1,
        "high" => 3,
        "xhigh" | "max" => 4,
        _ => 2,
    }
}

/// A budget as people read it: 512, 2k, 24k.
fn budget_text(tokens: u32) -> String {
    if tokens < 1000 {
        format!("up to {tokens} tokens")
    } else if tokens % 1024 == 0 {
        format!("up to {}k tokens", tokens / 1024)
    } else {
        format!("up to {:.1}k tokens", f64::from(tokens) / 1024.0)
    }
}

/// Column of stop `index` of `count` across a rail `width` cells wide.
fn stop_x(index: usize, count: usize, width: u16) -> u16 {
    let span = width.saturating_sub(1);
    if count < 2 {
        return 0;
    }
    ((index as u32 * u32::from(span) + (count as u32 - 1) / 2) / (count as u32 - 1)) as u16
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_thinking_selector {
        return;
    }

    let levels = &state.input.thinking_selector_levels;
    // Title rides the border; then ends, gap, rail, labels, gap, current, hint,
    // gap, footer — or the three-line explanation when nothing is offered.
    let panel_height = if levels.is_empty() { 8 } else { 11 };
    let panel_width = 58u16.min(area.width);
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

    if levels.is_empty() {
        render_unavailable(frame, body, state);
    } else {
        render_scale(frame, body, state);
    }

    modal_footer(
        frame,
        body,
        footer_hints(
            &[("←→", "move"), ("Enter", "apply"), ("Esc", "close")],
            body.width.saturating_sub(2),
        ),
    );
}

/// No levels: explain it here rather than writing to chat history, which is
/// where this used to land.
fn render_unavailable(frame: &mut Frame, body: Rect, state: &AppState) {
    let Some(top) = panel_row(body, 1, 1) else {
        return;
    };
    let area = Rect {
        height: body.height.saturating_sub(3),
        ..top
    };
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
        area,
    );
}

fn render_scale(frame: &mut Frame, body: Rect, state: &AppState) {
    let levels = &state.input.thinking_selector_levels;
    let selected = state
        .input
        .thinking_selector_selected
        .min(levels.len().saturating_sub(1));
    let active = state.agent.thinking_level.as_str();
    let name = |level: &str| -> String {
        match (level, state.input.thinking_selector_default.as_deref()) {
            ("auto", Some(default)) => format!("auto · {default}"),
            _ => level.to_string(),
        }
    };

    // Ends of the scale either side of the title.
    if let Some(row) = panel_row(body, 1, 2) {
        let width = row.width as usize;
        let (left, mid, right) = ("Faster", "Thinking mode", "Deeper");
        let gap = width.saturating_sub(left.len() + mid.len() + right.len());
        let spans = vec![
            s(left, style::dim()),
            s(" ".repeat(gap / 2), style::dim()),
            s(mid, style::muted()),
            s(" ".repeat(gap - gap / 2), style::dim()),
            s(right, style::dim()),
        ];
        frame.render_widget(Paragraph::new(Line::from(spans)), row);
    }

    let Some(rail) = panel_row(body, 3, 3) else {
        return;
    };
    let count = levels.len();
    let thumb = stop_x(selected, count, rail.width);
    let stops: Vec<u16> = (0..count).map(|i| stop_x(i, count, rail.width)).collect();
    let rail_spans: Vec<Span<'static>> = (0..rail.width)
        .map(|x| {
            if x == thumb {
                s("●", Style::default().fg(PRIMARY()).add_modifier(Modifier::BOLD))
            } else if let Some(i) = stops.iter().position(|&stop| stop == x) {
                if i < selected {
                    s("•", Style::default().fg(PRIMARY()))
                } else {
                    s("·", Style::default().fg(FG_MUTED()))
                }
            } else if x < thumb {
                s("━", Style::default().fg(PRIMARY()))
            } else {
                s("┄", Style::default().fg(FG_DIM()))
            }
        })
        .collect();
    frame.render_widget(Paragraph::new(Line::from(rail_spans)), rail);

    // Labels under their stops when they all fit, else just the chosen one.
    if let Some(row) = panel_row(body, 4, 3) {
        let placed: Vec<(u16, String)> = levels
            .iter()
            .enumerate()
            .map(|(i, level)| {
                let label = level.clone();
                let half = (label.chars().count() as u16) / 2;
                let x = stops[i].saturating_sub(half).min(row.width.saturating_sub(label.chars().count() as u16));
                (x, label)
            })
            .collect();
        let fits = placed.windows(2).all(|pair| {
            pair[0].0 + pair[0].1.chars().count() as u16 + 1 <= pair[1].0
        });
        let mut line = vec![' '; row.width as usize];
        let mut styles = vec![None::<usize>; row.width as usize];
        for (i, (x, label)) in placed.iter().enumerate() {
            if !fits && i != selected {
                continue;
            }
            for (offset, ch) in label.chars().enumerate() {
                let at = *x as usize + offset;
                if at < line.len() {
                    line[at] = ch;
                    styles[at] = Some(i);
                }
            }
            // Clicking a label picks its level, like the stop above it.
            state.ui.hits.push(
                Rect::new(row.x + x, row.y, label.chars().count() as u16, 1),
                HitTarget::Row {
                    list: ListId::ThinkingSelector,
                    index: i,
                },
            );
        }
        let spans: Vec<Span<'static>> = line
            .iter()
            .zip(&styles)
            .map(|(ch, owner)| {
                let style = match owner {
                    Some(i) if *i == selected => Style::default().fg(PRIMARY()).add_modifier(Modifier::BOLD),
                    Some(i) if levels[*i] == active => Style::default().fg(FG()),
                    _ => style::dim(),
                };
                s(ch.to_string(), style)
            })
            .collect();
        frame.render_widget(Paragraph::new(Line::from(spans)), row);
    }
    for (i, x) in stops.iter().enumerate() {
        state.ui.hits.push(
            Rect::new(rail.x + x.saturating_sub(1), rail.y, 3.min(rail.width), 1),
            HitTarget::Row {
                list: ListId::ThinkingSelector,
                index: i,
            },
        );
    }

    let level = levels[selected].as_str();
    if let Some(row) = panel_row(body, 6, 2) {
        let filled = effort_bars(level);
        let mut spans = vec![s("Current ", style::muted())];
        for (i, bar) in ["▂", "▄", "▆", "█"].iter().enumerate() {
            let color = if i < filled { PRIMARY() } else { FG_DIM() };
            spans.push(s(*bar, Style::default().fg(color)));
        }
        spans.push(s(
            format!(" {}", name(level)),
            Style::default().fg(PRIMARY()).add_modifier(Modifier::BOLD),
        ));
        // Only a real token budget: a level without one is sized by the
        // provider, which is not the same as unlimited.
        if let Some(Some(budget)) = state.input.thinking_selector_budgets.get(selected) {
            spans.push(s(format!(" · {}", budget_text(*budget)), style::dim()));
        }
        if level == active {
            spans.push(s("  ◈ in effect", style::dim()));
        }
        frame.render_widget(
            Paragraph::new(Line::from(spans)).alignment(ratatui::layout::Alignment::Center),
            row,
        );
    }
    if let Some(row) = panel_row(body, 7, 2) {
        frame.render_widget(
            Paragraph::new(Line::from(s(level_hint(level), style::dim())))
                .alignment(ratatui::layout::Alignment::Center),
            row,
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
        // The default config now names a model; this case is "none chosen".
        state.config.current_model.clear();
        let text = shot(&mut state, 80, 24);
        assert!(text.contains("No model selected"), "{text}");
        assert!(
            state.session.chat_history.is_empty(),
            "the dialog must not write to chat history"
        );
    }

    #[test]
    fn long_catalog_names_only_the_chosen_stop() {
        let mut state = state();
        let levels = (0..12).map(|i| format!("level-{i}")).collect::<Vec<_>>();
        state.input.open_thinking_selector(&levels, "level-11");
        let text = shot(&mut state, 80, 12);
        // Twelve names cannot sit under their stops; only the chosen one does.
        assert!(text.contains("Current"), "{text}");
        assert!(text.contains("level-11"), "{text}");
        assert!(!text.contains("level-5"), "{text}");
    }

    #[test]
    fn empty_catalog_has_room_for_all_explanation_lines() {
        let mut state = state();
        // The default config now names a model; this case is "none chosen".
        state.config.current_model.clear();
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

    #[test]
    fn scale_names_its_ends_stops_and_the_current_budget() {
        let mut state = state();
        let levels = ["auto", "off", "low", "medium", "high", "max"].map(String::from);
        state.input.open_thinking_selector(&levels, "medium");
        state.input.thinking_selector_budgets =
            vec![None, None, Some(512), Some(2048), Some(8192), None];
        let text = shot(&mut state, 80, 14);
        for word in ["Faster", "Thinking mode", "Deeper", "auto", "off", "low", "high", "max"] {
            assert!(text.contains(word), "{word}: {text}");
        }
        assert!(text.contains("●"), "{text}");
        assert!(text.contains("medium · up to 2k tokens"), "{text}");
        assert!(text.contains("balanced"), "{text}");

        // Max has no budget of its own: nothing claims it is unlimited.
        state.input.thinking_selector_selected = 5;
        let text = shot(&mut state, 80, 14);
        assert!(!text.contains("limit"), "{text}");
    }

    #[test]
    fn auto_names_the_provider_default() {
        let mut state = state();
        let levels = ["auto", "low", "high"].map(String::from);
        state.input.open_thinking_selector(&levels, "auto");
        state.input.thinking_selector_default = Some("high".into());
        let text = shot(&mut state, 80, 14);
        assert!(text.contains("auto · high"), "{text}");
    }

    #[test]
    fn stops_span_the_rail_evenly() {
        assert_eq!(stop_x(0, 3, 21), 0);
        assert_eq!(stop_x(1, 3, 21), 10);
        assert_eq!(stop_x(2, 3, 21), 20);
        assert_eq!(stop_x(0, 1, 21), 0);
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
