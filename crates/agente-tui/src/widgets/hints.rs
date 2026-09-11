//! Bottom hint bar — static key hints, no live state.
//!
//! ```text
//!  Shift+Tab:mode │ Ctrl+P:commands │ Ctrl+C:quit │ F1:help
//! ```
//!
//! Keys render bright, actions dim. Live state (approval, retry, stalled,
//! error) intentionally does not appear here: approvals have their floating
//! card, retry/stalled surface in the streaming footer, errors render as chat
//! entries and tint the composer border.

use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::AppState;
use crate::style::*;
use crate::widgets::truncate_cells;

const HINTS: &[(&str, &str)] = &[
    ("Shift+Tab", "mode"),
    ("Ctrl+P", "commands"),
    ("Ctrl+C", "quit"),
    ("F1", "help"),
];

/// Compact `9.5k / 200k` context readout for the header (no
/// percentage). `None` when no context window is known. The bool flags >70%
/// full (warning color). `total_tokens` is the live transcript estimate
/// (recomputed from `session.conversation` on Done/Cancelled/compact — see
/// `state/agent.rs`), not a cumulative sum.
pub(crate) fn context_usage(state: &AppState) -> Option<(String, bool)> {
    let model = state.resolve_model(&state.config.current_provider, &state.config.current_model)?;
    let limit = model.limits.context as usize;
    if limit == 0 {
        return None;
    }
    let used = state.agent.total_tokens as usize;
    let pct = used as f64 / limit as f64;
    Some((
        format!(
            "{} / {}",
            format_token_count(used),
            format_token_count(limit)
        ),
        pct > 0.7,
    ))
}

pub(crate) fn format_token_count(tokens: usize) -> String {
    if tokens >= 1_000_000 {
        let v = tokens as f64 / 1_000_000.0;
        if v == v.trunc() {
            format!("{}M", v as u64)
        } else {
            format!("{v:.1}M")
        }
    } else if tokens >= 1_000 {
        let v = tokens as f64 / 1_000.0;
        if v == v.trunc() {
            format!("{}k", v as u64)
        } else {
            format!("{v:.1}k")
        }
    } else {
        tokens.to_string()
    }
}

pub fn render(frame: &mut Frame, area: ratatui::layout::Rect, _state: &AppState) {
    if area.height == 0 || area.width == 0 {
        return;
    }

    let separator = Span::styled(" │ ", Style::default().fg(BORDER_ACTIVE()));
    let mut hints: Vec<Span<'static>> = Vec::new();
    for (i, (key, action)) in HINTS.iter().enumerate() {
        if i > 0 {
            hints.push(separator.clone());
        }
        hints.push(Span::styled(key.to_string(), hint_key()));
        hints.push(Span::styled(format!(":{action}"), hint_action()));
    }

    // Drop whole hints from the end until the row fits — a clipped `help` is
    // noise, a missing one is just less info.
    let width = |spans: &[Span<'static>]| -> usize {
        spans
            .iter()
            .map(|sp| crate::widgets::display_width(&sp.content))
            .sum()
    };
    let max = area.width as usize;
    // Each hint after the first is three spans: separator, key, action.
    while width(&hints) + 1 > max && hints.len() > 2 {
        hints.truncate(hints.len() - 3);
    }
    if width(&hints) + 1 > max {
        // Even the first hint does not fit — clip it rather than overflow.
        let full = format!("{}:{}", HINTS[0].0, HINTS[0].1);
        hints.clear();
        hints.push(Span::styled(
            truncate_cells(&full, max.saturating_sub(1).max(1)),
            hint_key(),
        ));
    }

    let mut spans = Vec::with_capacity(hints.len() + 3);
    spans.push(Span::styled(" ", Style::default().bg(BG())));
    spans.extend(hints);

    // Right-aligned version watermark (the "Beta" corner of the reference).
    let version = format!("v{} ", env!("CARGO_PKG_VERSION"));
    let used: usize = spans
        .iter()
        .map(|sp| crate::widgets::display_width(&sp.content))
        .sum();
    let vw = crate::widgets::display_width(&version);
    if used + vw + 1 < max {
        let pad = max - used - vw;
        spans.push(Span::styled(" ".repeat(pad), Style::default().bg(BG())));
        spans.push(Span::styled(version, Style::default().fg(FG_DIM())));
    }

    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(BG())),
        area,
    );
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
    fn context_usage_reads_model_limit() {
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

        let (text, warn) = context_usage(&state).expect("usage");
        assert_eq!(text, "9.5k / 200k");
        assert!(!warn);

        state.agent.total_tokens = 180_000;
        let (_, warn) = context_usage(&state).expect("usage");
        assert!(warn);
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
        assert!(text.contains("Shift+Tab:mode"), "got: {text}");
        assert!(text.contains("F1:help"), "got: {text}");
    }

    #[test]
    fn hints_drop_from_the_end_when_narrow() {
        let state = AppState::new(AppConfig::default(), "/tmp/hints-test".to_string());
        let backend = TestBackend::new(24, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let text: String = (0..24)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(text.contains("Shift+Tab"), "got: {text}");
        assert!(!text.contains("F1:help"), "got: {text}");
    }
}
