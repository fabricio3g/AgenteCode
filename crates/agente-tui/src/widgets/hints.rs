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

pub fn render(frame: &mut Frame, area: ratatui::layout::Rect, state: &AppState) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let canvas = Style::default().bg(BG());
    // Typing is when the hints matter least: the row goes quiet until the
    // composer is empty again.
    if !state.input.input_text.is_empty() {
        frame.render_widget(Paragraph::new("").style(canvas), area);
        return;
    }

    // Same `key action · key action` grammar as every modal footer; middle
    // hints drop whole when narrow, the trailing `F1 help` stays.
    let max = area.width as usize;
    let mut spans = vec![Span::styled(" ", canvas)];
    spans.extend(footer_hints(HINTS, area.width.saturating_sub(1)));

    // Right-aligned version watermark.
    let version = format!("v{} ", env!("CARGO_PKG_VERSION"));
    let used: usize = spans
        .iter()
        .map(|sp| crate::widgets::display_width(&sp.content))
        .sum();
    let vw = crate::widgets::display_width(&version);
    if used + vw + 1 < max {
        spans.push(Span::styled(" ".repeat(max - used - vw), canvas));
        spans.push(Span::styled(version, Style::default().fg(FG_DIM())));
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
        assert!(text.contains("Shift+Tab mode"), "got: {text}");
        assert!(text.contains("F1 help"), "got: {text}");
    }

    #[test]
    fn hints_drop_middle_segments_when_narrow() {
        let state = AppState::new(AppConfig::default(), "/tmp/hints-test".to_string());
        let backend = TestBackend::new(24, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let text: String = (0..24)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(!text.contains("Ctrl+P"), "got: {text}");
        assert!(text.contains("F1 help"), "escape hatch stays: {text}");
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
        assert!(text.trim().is_empty(), "got: {text}");
    }
}
