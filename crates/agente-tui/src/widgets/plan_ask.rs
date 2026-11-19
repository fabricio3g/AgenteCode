//! Ask card: multi-step list with focus (one expanded step at a time).

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::{footer_hints, modal_card, modal_footer, truncate_cells};
use crate::state::{AppState, PlanReviewPhase};
use crate::style;
use crate::style::*;

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if state.plan_review.phase != PlanReviewPhase::Asking {
        return;
    }
    let Some(ask) = state.plan_review.ask.as_ref() else {
        return;
    };
    if area.width < 24 || area.height < 5 {
        return;
    }

    let width = area.width.saturating_sub(4).min(72);
    let q_idx = ask
        .question_index
        .min(ask.questions.len().saturating_sub(1));
    let active_options = ask.questions.get(q_idx).map_or(0, |q| q.options.len());

    // Row budget, top down: title, blank, "you said" + gap, the step list, a
    // gap, the footer, the bottom pad. Rows drop in that order of importance,
    // so a cramped terminal still shows the open step and its field instead of
    // nothing at all.
    let cap = area.height.saturating_sub(2).max(5);
    let roomy = cap >= 11;
    let show_comment = cap >= 9;
    let gap_above_footer = cap >= 8;
    let reserved =
        3 + u16::from(roomy) + if show_comment { 2 } else { 0 } + u16::from(gap_above_footer);
    let steps_budget = cap.saturating_sub(reserved).max(1);
    let show_chips = active_options > 0 && steps_budget >= 3;
    let active_rows = 2 + u16::from(show_chips);

    // Window the list around the open step. Neighbours fill whatever the
    // active step leaves, so "Step i of n" never points at a row that got
    // clipped off the bottom of the card.
    let n = ask.questions.len() as u16;
    let (mut shown_before, mut shown_after) = (0u16, 0u16);
    let mut left = steps_budget.saturating_sub(active_rows);
    let before = q_idx as u16;
    let after = n.saturating_sub(1).saturating_sub(q_idx as u16);
    let mut prefer_before = true;
    while left > 0 && (shown_before < before || shown_after < after) {
        if shown_after >= after || (prefer_before && shown_before < before) {
            shown_before += 1;
        } else {
            shown_after += 1;
        }
        left -= 1;
        prefer_before = !prefer_before;
    }

    let steps_rows = if ask.questions.is_empty() {
        0
    } else {
        shown_before + active_rows + shown_after
    };
    let height = (reserved + steps_rows).min(cap).max(5);
    let panel = super::centered_panel(area, width, height);

    let (step_i, step_n) = ask.step_display();
    let body = modal_card(
        frame,
        panel,
        vec![
            Span::styled("◇ ", style::accent()),
            Span::styled("Clarify", style::bold()),
            Span::styled(format!(" · Step {step_i} of {step_n}"), style::dim()),
        ],
    );
    if body.width == 0 || body.height < 3 {
        return;
    }

    // Uniform popup inset: content sits 2 columns in from the card edges
    // (1 border + 1 pad).
    let content_x = body.x + 1;
    let content_w = body.width.saturating_sub(2);

    let footer_y = body.y + body.height - 1;
    let mut y = body.y + u16::from(roomy);

    if show_comment {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("You said: ", Style::default().fg(FG_DIM()).bg(BG_PANEL())),
                Span::styled(
                    format!(
                        "“{}”",
                        truncate_cells(
                            &ask.original_comment,
                            content_w.saturating_sub(12) as usize
                        )
                    ),
                    Style::default().fg(FG_MUTED()).bg(BG_PANEL()),
                ),
            ])),
            Rect::new(content_x, y, content_w, 1),
        );
        y = y.saturating_add(2);
    }

    let first = q_idx.saturating_sub(shown_before as usize);
    let last = (q_idx + shown_after as usize).min(ask.questions.len().saturating_sub(1));
    let window = ask
        .questions
        .get(first..=last)
        .filter(|w| !w.is_empty())
        .unwrap_or(&[]);

    for (offset, q) in window.iter().enumerate() {
        if y >= footer_y {
            break;
        }
        let i = first + offset;
        let active = i == q_idx;
        let done = q.is_answered();
        let mark = if active {
            "›"
        } else if done {
            "✓"
        } else {
            " "
        };
        let style = if active {
            Style::default()
                .fg(FG())
                .bg(BG_PANEL())
                .add_modifier(Modifier::BOLD)
        } else if done {
            Style::default().fg(SUCCESS()).bg(BG_PANEL())
        } else {
            Style::default().fg(FG_MUTED()).bg(BG_PANEL())
        };

        // Compact line for every step
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(format!("{mark} {}. ", i + 1), style),
                Span::styled(
                    truncate_cells(&q.prompt, content_w.saturating_sub(6) as usize),
                    style,
                ),
            ])),
            Rect::new(content_x, y, content_w, 1),
        );
        y = y.saturating_add(1);

        // Expanded body only for active step
        if active {
            // Optional chips — never required; user can always type instead
            if show_chips && y < footer_y {
                let mut spans = vec![Span::styled("  ", Style::default().bg(BG_PANEL()))];
                for (oi, opt) in q.options.iter().enumerate() {
                    let sel = q.selected == Some(oi);
                    let st = if sel {
                        style::accent()
                            .bg(super::pick::RowState::Selected.bg())
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(FG_MUTED()).bg(BG_PANEL())
                    };
                    spans.push(Span::styled(format!(" {opt} "), st));
                }
                frame.render_widget(
                    Paragraph::new(Line::from(spans)),
                    Rect::new(content_x, y, content_w, 1),
                );
                y = y.saturating_add(1);
            }
            // Always show free-text escape hatch (even when options exist)
            if y < footer_y {
                let placeholder = if q.options.is_empty() {
                    "Type your answer"
                } else {
                    "Or type your own answer"
                };
                super::pick::search_field(
                    frame,
                    Rect::new(content_x + 2, y, content_w.saturating_sub(2), 1),
                    &q.free_text,
                    placeholder,
                );
                y = y.saturating_add(1);
            }
        }
    }

    let reask = format!("re-ask {}/3", ask.reask_count.min(3));
    modal_footer(
        frame,
        body,
        footer_hints(
            &[
                ("Enter", if ask.at_last_step() { "submit" } else { "next" }),
                ("←→", "options"),
                ("Ctrl+Q", &reask),
                ("Esc", "close"),
            ],
            body.width.saturating_sub(2),
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{template_ask_questions, PlanAskState};
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    /// Each of the four template steps, cut to a fragment that survives the
    /// 26-cell truncation a 40-column terminal gives it.
    const STEP_FRAGMENTS: [&str; 4] = [
        "You said “make it",
        "How big should the change",
        "What is the main outcome",
        "Anything else the plan",
    ];

    fn state_at_step(step: usize) -> AppState {
        let mut state = AppState::new(AppConfig::default(), "/tmp/plan-ask-test".to_string());
        state.plan_review.phase = PlanReviewPhase::Asking;
        state.plan_review.ask = Some(PlanAskState {
            original_comment: "make it better".into(),
            questions: template_ask_questions("make it better"),
            question_index: step,
            reask_count: 0,
        });
        state
    }

    fn screen(state: &AppState, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("terminal");
        terminal
            .draw(|frame| render(frame, frame.area(), state))
            .expect("draw");
        let buf = terminal.backend().buffer();
        let mut out = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                out.push_str(buf[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    /// The four-step flow used to render every step at one row each and let
    /// the tail fall off the panel: on a 60x18 terminal steps 3 and 4 were
    /// invisible and the card vanished below 10 rows of chat area. The open
    /// step and its answer field must always be on screen.
    #[test]
    fn the_open_step_and_its_field_stay_on_screen_at_every_size() {
        for &(w, h) in &[(120u16, 40u16), (100, 30), (80, 24), (60, 18), (40, 12)] {
            for (step, fragment) in STEP_FRAGMENTS.iter().enumerate() {
                let text = screen(&state_at_step(step), w, h);
                assert!(
                    text.contains(fragment),
                    "step {} is off screen at {w}x{h}:\n{text}",
                    step + 1
                );
                assert!(
                    text.contains("type your own answer") || text.contains("Type your answer"),
                    "step {} has no answer field at {w}x{h}:\n{text}",
                    step + 1
                );
                assert!(
                    text.contains(&format!("Step {} of 4", step + 1)),
                    "header lost the step counter at {w}x{h}:\n{text}"
                );
            }
        }
    }

    /// The card used to bail out entirely under ten rows of chat area, leaving
    /// an Asking phase with nothing on screen to answer.
    #[test]
    fn a_cramped_chat_area_still_shows_the_card() {
        let text = screen(&state_at_step(0), 40, 12);
        assert!(text.contains("Clarify"), "no card:\n{text}");
        assert!(text.contains("Esc close"), "no footer:\n{text}");
    }
}
