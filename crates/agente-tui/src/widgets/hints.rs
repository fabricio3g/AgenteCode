//! Bottom hint bar — static key hints, no live state.
//!
//! ```text
//!  Shift+Tab mode · Ctrl+P commands · Ctrl+C quit · F1 help
//! ```
//!
//! Keys render bright, actions dim; the row hides while the composer has
//! text. Live state (approval, retry, stalled,
//! error) intentionally does not appear here: approvals have their floating
//! card, retry/stalled surface in the streaming footer, errors render as chat
//! entries and tint the composer border.

use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::AppState;
use crate::style::*;
use crate::widgets::footer_hints;

const HINTS: &[(&str, &str)] = &[
    ("Shift+Tab", "mode"),
    ("Ctrl+P", "commands"),
    ("Ctrl+C", "quit"),
    ("F1", "help"),
];

/// `(used, room, estimated)` for the context meter, `None` when nothing is
/// known yet. Prefers the budget the loop reported — the same arithmetic the
/// compaction gate uses — so the amber line and the compaction line are the
/// same place. Before the first request of a session it falls back to the
/// transcript estimate against the model's window.
pub(crate) fn context_ratio(state: &AppState) -> Option<(usize, usize, bool)> {
    let reported = state.agent.context;
    if reported.is_known() {
        return Some((
            reported.used as usize,
            reported.room as usize,
            !reported.measured,
        ));
    }
    let model = state.resolve_model(&state.config.current_provider, &state.config.current_model)?;
    let limit = model.limits.context as usize;
    (limit > 0).then_some((
        state.agent.total_tokens as usize,
        limit,
        !state.agent.context_measured,
    ))
}

/// `61k`, `1.5M`: the one token scale, shared with the loop's own counts.
pub(crate) fn format_token_count(tokens: usize) -> String {
    agente_core::context::format_tokens(tokens)
}

/// Status segments for the row under the composer, in drop order (first
/// to go when narrow): `plan │ $0.042 · 82% cached │ ━━━━━━━━ 61k / 262k`.
fn status_segments(state: &AppState) -> Vec<Vec<Span<'static>>> {
    let on_bg = |text: String, fg| Span::styled(text, Style::default().fg(fg).bg(BG()));
    let mut segments = vec![crate::widgets::input::mode_spans(state)];
    if let Some(spend) = state.agent.spend.label() {
        segments.push(vec![on_bg(spend, FG_DIM())]);
    }
    if let Some(smart) = state.agent.compacting {
        let label = if smart {
            "summarizing context…"
        } else {
            "compacting…"
        };
        segments.push(vec![on_bg(label.to_string(), PRIMARY())]);
    } else if let Some((used, room, estimated)) = context_ratio(state) {
        segments.push(context_meter(used, room, estimated));
    }
    segments
}

/// `━━━━━━━━ 61k / 100k`: an 8-cell fill meter plus the numbers, measured
/// against the room the compaction gate uses (window minus tool schemas, the
/// tokenizer gap and the reply reserve), so 85% is the same line here and in
/// the loop. Muted normally, amber past 70%, red past 85%. `~61k` when the
/// size is our estimate rather than the provider's count.
fn context_meter(used: usize, limit: usize, estimated: bool) -> Vec<Span<'static>> {
    const CELLS: usize = 8;
    let ratio = used as f64 / limit.max(1) as f64;
    let color = if ratio >= 0.85 {
        ERROR()
    } else if ratio >= 0.7 {
        WARNING()
    } else {
        FG_MUTED()
    };
    let filled = ((ratio * CELLS as f64).round() as usize).min(CELLS);
    vec![
        Span::styled("━".repeat(filled), Style::default().fg(color).bg(BG())),
        Span::styled(
            "━".repeat(CELLS - filled),
            Style::default().fg(BORDER_RULE()).bg(BG()),
        ),
        Span::styled(
            format!(
                " {}{} / {}",
                if estimated { "~" } else { "" },
                format_token_count(used),
                format_token_count(limit)
            ),
            Style::default().fg(color).bg(BG()),
        ),
    ]
}

fn width_of(spans: &[Span<'static>]) -> usize {
    spans
        .iter()
        .map(|sp| crate::widgets::display_width(&sp.content))
        .sum()
}

/// The row under the composer: key hints on the left (hidden while typing),
/// live status on the right. Status wins the space; hints take what is left.
pub fn render(frame: &mut Frame, area: ratatui::layout::Rect, state: &AppState) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let canvas = Style::default().bg(BG());
    let max = area.width as usize;

    let mut segments = status_segments(state);
    let joined_width = |segs: &[Vec<Span<'static>>]| -> usize {
        segs.iter().map(|seg| width_of(seg)).sum::<usize>() + 3 * segs.len().saturating_sub(1)
    };
    while segments.len() > 1 && joined_width(&segments) + 2 > max {
        segments.remove(0);
    }
    let mut status: Vec<Span<'static>> = Vec::new();
    for (i, segment) in segments.into_iter().enumerate() {
        if i > 0 {
            status.push(Span::styled(" │ ", Style::default().fg(FG_DIM()).bg(BG())));
        }
        status.extend(segment);
    }
    status.push(Span::styled(" ", canvas));
    let status_w = width_of(&status);

    // `key action · key action` in the space the status leaves; quiet while
    // the composer has text.
    let mut spans = vec![Span::styled(" ", canvas)];
    let hint_budget = max.saturating_sub(status_w + 3);
    if state.input.input_text.is_empty() && hint_budget >= 12 {
        spans.extend(footer_hints(HINTS, hint_budget as u16));
    }
    let used = width_of(&spans);
    if used + status_w <= max {
        spans.push(Span::styled(" ".repeat(max - used - status_w), canvas));
        spans.extend(status);
    }
    frame.render_widget(Paragraph::new(Line::from(spans)).style(canvas), area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::catalog::ModelCatalog;
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn format_token_count_scales() {
        assert_eq!(format_token_count(42), "42");
        assert_eq!(format_token_count(1500), "1.5k");
        assert_eq!(format_token_count(12300), "12.3k");
        assert_eq!(format_token_count(200_000), "200k");
        assert_eq!(format_token_count(2_000_000), "2M");
    }

    #[test]
    fn context_meter_reads_model_limit() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/hints-test".to_string());
        state.config.config.catalog = Some(
            ModelCatalog::parse_json(
                r#"{
                  "test": {
                    "id": "test",
                    "name": "Test",
                    "api": "https://example.com",
                    "models": {
                      "m": {
                        "id": "m",
                        "name": "M",
                        "tool_call": true,
                        "limit": { "context": 200000, "output": 8192 }
                      }
                    }
                  }
                }"#,
            )
            .unwrap(),
        );
        state.config.current_provider = "test".to_string();
        state.config.current_model = "m".to_string();
        state.config.connected_providers.push("test".to_string());
        state.agent.total_tokens = 9500;

        let (used, limit, estimated) = context_ratio(&state).expect("usage");
        assert_eq!((used, limit, estimated), (9_500, 200_000, true));
        let text = |spans: Vec<Span<'static>>| -> String {
            spans.iter().map(|s| s.content.as_ref()).collect()
        };
        let meter = context_meter(used, limit, false);
        assert_eq!(text(meter.clone()), "━━━━━━━━ 9.5k / 200k");
        assert_eq!(
            text(context_meter(used, limit, true)),
            "━━━━━━━━ ~9.5k / 200k",
            "an estimate says so"
        );
        assert_eq!(meter[2].style.fg, Some(FG_MUTED()));
        // Past the 85% auto-compact line the meter turns red.
        assert_eq!(
            context_meter(180_000, limit, false)[0].style.fg,
            Some(ERROR())
        );
    }

    #[test]
    fn hints_fit_at_typical_width() {
        let state = AppState::new(AppConfig::default(), "/tmp/hints-test".to_string());
        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let text: String = (0..80)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(text.contains("Shift+Tab mode"), "got: {text}");
        assert!(text.contains("F1 help"), "got: {text}");
    }

    #[test]
    fn narrow_rows_keep_status_and_shed_hints() {
        let state = AppState::new(AppConfig::default(), "/tmp/hints-test".to_string());
        let row = |width: u16| -> String {
            let mut terminal = Terminal::new(TestBackend::new(width, 1)).unwrap();
            terminal.draw(|f| render(f, f.area(), &state)).unwrap();
            (0..width)
                .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
                .collect()
        };
        // Wide: hints left, status right.
        let wide = row(120);
        assert!(wide.contains("F1 help") && wide.contains("build"), "{wide}");
        // Narrow: the status wins the row; hints give way whole.
        let narrow = row(24);
        assert!(!narrow.contains("Ctrl+P"), "got: {narrow}");
        // What the status holds depends on the model catalog on this machine
        // (context size or just the mode), so compare against the wide row:
        // the narrow row still ends with the same status.
        let tail = narrow.split_whitespace().last().unwrap_or_default();
        assert!(
            !tail.is_empty() && wide.trim_end().ends_with(tail),
            "status stays: {narrow} (wide: {wide})"
        );
    }

    #[test]
    fn hints_hide_while_typing() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/hints-test".to_string());
        state.input.input_text = "draft".into();
        let mut terminal = Terminal::new(TestBackend::new(80, 1)).unwrap();
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let text: String = (0..80)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(!text.contains("Shift+Tab"), "hints hide: {text}");
        assert!(text.contains("build"), "status stays: {text}");
    }
}
