//! Activity strip — the one-line "turn in progress" readout between the chat
//! and the composer.
//!
//! ```text
//!  ∴ Thinking...  4.1s
//! ```
//!
//! One dim line: a static `∴` marker, the live phase, and the ticking
//! elapsed time. Retry backoff and stalls override the phase word. The
//! clickable `[stop]` hitbox stays live but paints only on hover, so the
//! strip stays silent at rest.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::AppState;
use crate::style::*;
use crate::widgets::truncate_cells;
use agente_core::types::AgentState;

/// True while the strip should be visible: a turn is in flight, or background
/// subagents are still running after the parent turn settled.
fn active(state: &AppState) -> bool {
    !matches!(state.agent.state, AgentState::Idle | AgentState::Error(_))
        || state.subagent_registry.running_count() > 0
}

fn turn_elapsed(state: &AppState) -> Option<String> {
    let secs = state
        .agent
        .turn_started_at
        .map(|t| t.elapsed().as_secs_f64())
        .or_else(|| {
            state
                .agent
                .thinking_start_time
                .map(|t| (chrono::Utc::now() - t).num_milliseconds().max(0) as f64 / 1000.0)
        })
        .or_else(|| {
            // Parent idle but children still running: clock from the oldest.
            state
                .subagent_registry
                .list_running()
                .iter()
                .map(|snap| snap.started_at)
                .min()
                .map(|t| (chrono::Utc::now() - t).num_milliseconds().max(0) as f64 / 1000.0)
        })?;
    Some(if secs >= 60.0 {
        let whole = secs as u64;
        format!("{}m{:02}s", whole / 60, whole % 60)
    } else {
        format!("{secs:.1}s")
    })
}

pub fn visible_height(state: &AppState) -> u16 {
    if active(state) {
        1
    } else {
        0
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    state.ui.stop_hitbox = None;
    if area.height == 0 || area.width == 0 || !active(state) {
        return;
    }
    if state.ui.show_welcome_screen && state.session.chat_history.is_empty() {
        // Welcome screen owns the content area; a bare spinner row under it
        // reads as a glitch.
        return;
    }

    let anim_tick = state.ui.anim_frame;
    let anim_f = anim_tick as usize;

    // "Waiting on you" vs "working": an approval block pulses a diamond —
    // brightness breathes but nothing moves, so it never reads as busywork —
    // while running states keep the reference's static `∴`.
    let (glyph, glyph_color) = if state.agent.state == AgentState::WaitingApproval {
        (
            "◆",
            crate::widgets::waiting_diamond_color(BG(), WARNING(), anim_tick),
        )
    } else {
        ("∴", MACHINERY())
    };

    // Left: phase label (+ retry/stall overrides).
    let (label, label_style) = if state.agent.state == AgentState::WaitingApproval {
        (
            "Waiting for approval…".to_string(),
            Style::default().fg(FG_MUTED()),
        )
    } else if let Some(retry) = state.agent.retry_status {
        (
            format!("retry {}/{}", retry.attempt, retry.max_attempts),
            Style::default().fg(WARNING()),
        )
    } else if let Some(secs) = state
        .agent
        .secs_since_last_agent_event()
        .filter(|&s| s >= 15)
    {
        (
            format!("No activity for {secs}s"),
            Style::default().fg(WARNING()),
        )
    } else {
        let running_children = state.subagent_registry.running_count();
        let phase = if running_children > 0 && matches!(state.agent.state, AgentState::Idle) {
            format!(
                "Waiting on {running_children} subagent{}…",
                if running_children == 1 { "" } else { "s" }
            )
        } else {
            state
                .agent
                .preparing_tool
                .as_deref()
                .map(|name| format!("Preparing {name}…"))
                .unwrap_or_else(|| phase_label(state).to_string())
        };
        (phase, Style::default().fg(FG_MUTED()))
    };
    let elapsed = turn_elapsed(state).unwrap_or_default();
    let counter = state.subagent_registry.running_count();
    let counter_text = (counter > 0).then(|| format!("⧗ {counter}"));

    // Give Stop a dedicated rectangle so clipping metadata cannot move its
    // painted label away from the pointer target. The label itself paints on
    // hover only — the reference strip shows no stop chrome.
    let stop_width = area.width.min(7);
    let stop_rect = Rect::new(area.right() - stop_width, area.y, stop_width, 1);
    let content_width = area.width.saturating_sub(stop_width) as usize;
    let counter_w = counter_text
        .as_ref()
        .map(|text| crate::widgets::display_width(text) + 1)
        .unwrap_or(0);
    let suffix_width = if elapsed.is_empty() {
        0
    } else {
        2 + elapsed.len()
    };
    let label_width = content_width.saturating_sub(3 + suffix_width + counter_w);
    let truncated = truncate_cells(&label, label_width);
    let mut left_spans = vec![Span::styled(
        format!(" {glyph} "),
        Style::default().fg(glyph_color),
    )];
    if label.starts_with("Thinking") {
        left_spans.extend(crate::widgets::shimmer_text(&truncated, anim_f));
    } else {
        left_spans.push(Span::styled(truncated, label_style));
    }
    if !elapsed.is_empty() {
        left_spans.push(Span::styled(
            format!("  {elapsed}"),
            Style::default().fg(FG_DIM()),
        ));
    }
    frame.render_widget(
        Paragraph::new(Line::from(left_spans)).style(Style::default().bg(BG())),
        Rect::new(area.x, area.y, content_width as u16, 1),
    );
    if let Some(text) = counter_text {
        let width = crate::widgets::display_width(&text) as u16;
        if width < content_width as u16 {
            frame.render_widget(
                Paragraph::new(text).style(Style::default().fg(SECONDARY()).bg(BG())),
                Rect::new(area.x + content_width as u16 - width, area.y, width, 1),
            );
        }
    }

    let mouse_at = state.ui.mouse_pos.or_else(|| {
        state
            .ui
            .mouse_seen
            .then_some((state.ui.mouse_x, state.ui.mouse_y))
    });
    let hovered = mouse_at
        .is_some_and(|(x, y)| x >= stop_rect.x && x < stop_rect.right() && y == stop_rect.y);
    state.ui.stop_hitbox = Some(stop_rect);
    if hovered {
        let stop = if stop_width >= 7 {
            " [stop]"
        } else if stop_width >= 6 {
            "[stop]"
        } else {
            "■"
        };
        // A filled danger chip, not bare red text: ERROR-on-canvas washes out
        // on dark terminals and under the modal dim veil. Same treatment as
        // the approval card's deny chip.
        frame.render_widget(Paragraph::new(stop).style(button_danger()), stop_rect);
    }
}

/// Phase label for the left side of the strip.
///
/// Never says "Thinking..." while the transcript is already drawing its own live
/// thinking block — the two rendered the same word on adjacent rows. The strip
/// is the global turn status; the chat block owns the thinking detail.
fn phase_label(state: &AppState) -> &'static str {
    let thinking_off = state.agent.thinking_level == agente_core::thinking::THINKING_OFF;
    let echoing_chat = state.agent.chat_shows_thinking(thinking_off);
    match state.agent.state {
        AgentState::Planning => {
            if echoing_chat {
                "Working…"
            } else {
                "Thinking..."
            }
        }
        AgentState::StreamingResponse => {
            if !state.agent.streaming_text.is_empty() {
                "Responding…"
            } else if echoing_chat {
                "Working…"
            } else {
                "Thinking..."
            }
        }
        AgentState::Executing => "Working…",
        AgentState::WaitingApproval => "Waiting for approval…",
        _ => "Responding…",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn test_state(agent_state: AgentState) -> AppState {
        let mut state = AppState::new(AppConfig::default(), "/tmp/activity-test".to_string());
        state.agent.state = agent_state;
        state.agent.thinking_start_time = Some(chrono::Utc::now());
        state.ui.show_welcome_screen = false;
        state
    }

    #[test]
    fn strip_hidden_when_idle() {
        let state = test_state(AgentState::Idle);
        assert_eq!(visible_height(&state), 0);
    }

    #[test]
    fn strip_shows_stop_hitbox_while_streaming() {
        let mut state = test_state(AgentState::StreamingResponse);
        state.agent.streaming_text = "partial response text here".to_string();
        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                render(f, area, &mut state);
            })
            .unwrap();
        let text: String = (0..80)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(text.contains("Responding"), "got: {text}");
        // The label is hover-only; the hitbox must still be live.
        assert!(
            !text.contains("[stop]"),
            "stop label must stay hidden: {text}"
        );
        assert!(state.ui.stop_hitbox.is_some(), "hitbox must be set");

        state.ui.mouse_pos = Some((79, 0));
        terminal.draw(|f| render(f, f.area(), &mut state)).unwrap();
        let hovered: String = (0..80)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(
            hovered.contains("[stop]"),
            "hover must paint stop: {hovered}"
        );
    }

    #[test]
    fn hovered_stop_paints_a_filled_danger_chip() {
        crate::style::set_theme(crate::style::Theme::Dark);
        let mut state = test_state(AgentState::Executing);
        state.ui.mouse_pos = Some((79, 0));
        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), &mut state)).unwrap();
        let buf = terminal.backend().buffer();
        // " [stop]" fills the last 7 cells with the danger background, not
        // bare red text on the canvas (which washed out in dark mode).
        for x in 73..80 {
            assert_eq!(
                buf[(x, 0)].bg,
                crate::style::ERROR(),
                "cell {x} must sit on the danger fill"
            );
        }
        let text: String = (73..80).map(|x| buf[(x, 0)].symbol()).collect();
        assert_eq!(text, " [stop]");
    }

    #[test]
    fn strip_uses_reference_marker_and_elapsed() {
        let mut state = test_state(AgentState::Planning);
        state.agent.thinking_level = "high".to_string();
        state.agent.thinking_start_time = None;
        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), &mut state)).unwrap();
        let text: String = (0..80)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(text.starts_with(" ∴ "), "got: {text}");
        assert!(text.contains("Thinking..."), "got: {text}");
        assert!(!text.contains('⇣'), "token estimate must be gone: {text}");
        for frame in ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] {
            assert!(
                !text.contains(frame),
                "no braille in the reference strip: {text}"
            );
        }
    }

    #[test]
    fn strip_survives_tiny_width() {
        for width in [1, 5, 6, 7, 20, 40, 60, 80] {
            let mut state = test_state(AgentState::Executing);
            state.agent.thinking_start_time =
                Some(chrono::Utc::now() - chrono::Duration::seconds(125));
            state.ui.mouse_pos = Some((width - 1, 0));
            let mut terminal = Terminal::new(TestBackend::new(width, 1)).unwrap();
            terminal.draw(|f| render(f, f.area(), &mut state)).unwrap();
            let hitbox = state.ui.stop_hitbox.unwrap();
            assert!(hitbox.right() <= width);
            let button: String = (hitbox.x..hitbox.right())
                .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
                .collect();
            assert_eq!(button.trim(), if width >= 6 { "[stop]" } else { "■" });
            let text: String = (0..width)
                .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
                .collect();
            assert!(text.matches("2m").count() <= 1);
        }
    }

    #[test]
    fn waiting_for_approval_pulses_a_diamond_not_a_spinner() {
        let mut state = test_state(AgentState::WaitingApproval);
        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                render(f, area, &mut state);
            })
            .unwrap();
        let text: String = (0..80)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(text.contains("Waiting for approval"), "got: {text}");
        assert!(text.contains('◆'), "pulsing diamond expected, got: {text}");
        for frame in ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] {
            assert!(
                !text.contains(frame),
                "braille frame {frame} must not appear while blocked"
            );
        }
    }

    #[test]
    fn thinking_phase_uses_reference_copy() {
        let mut state = test_state(AgentState::Planning);
        state.agent.thinking_level = "high".to_string();
        // No live chat thinking block (no start time) so the strip owns the
        // phase label instead of deferring to `Working…`.
        state.agent.thinking_start_time = None;
        assert_eq!(phase_label(&state), "Thinking...");
        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                render(f, area, &mut state);
            })
            .unwrap();
        let text: String = (0..80)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect();
        assert!(text.contains("Thinking..."), "got: {text}");
    }
}
