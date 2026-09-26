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
    if area.width < 24 || area.height < 10 {
        return;
    }

    let width = area.width.saturating_sub(4).min(72);
    // Hug the content: border(2) + gap + "you said" + gap + one row per
    // question + the active step's options/answer/gap + gap + footer.
    let content_rows = 1 + 1 + 1 + ask.questions.len() as u16 + 3 + 1 + 1;
    let height = (content_rows + 2).min(area.height.saturating_sub(2));
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
    if body.width == 0 || body.height < 4 {
        return;
    }

    // Uniform popup inset: content sits 2 columns in from the card edges
    // (1 border + 1 pad).
    let content_x = body.x + 1;
    let content_w = body.width.saturating_sub(2);

    let mut y = body.y + 1;
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("You said: ", Style::default().fg(FG_DIM()).bg(BG_PANEL())),
            Span::styled(
                format!(
                    "“{}”",
                    truncate_cells(&ask.original_comment, content_w.saturating_sub(12) as usize)
                ),
                Style::default().fg(FG_MUTED()).bg(BG_PANEL()),
            ),
        ])),
        Rect::new(content_x, y, content_w, 1),
    );
    y = y.saturating_add(2);

    let q_idx = ask
        .question_index
        .min(ask.questions.len().saturating_sub(1));
    // Content stops one gap row above the footer row.
    let max_y = body.y + body.height.saturating_sub(2);

    for (i, q) in ask.questions.iter().enumerate() {
        if y >= max_y {
            break;
        }
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
            if !q.options.is_empty() && y < max_y {
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
            if y < max_y {
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
            // Spacer after expanded step
            y = y.saturating_add(1);
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
