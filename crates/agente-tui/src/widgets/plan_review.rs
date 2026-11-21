//! Full-area plan review: hides chat list, formatted markdown, scrollable body.
//! On Comment (C) the plan stays visible while the composer takes feedback.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use crate::state::{AppState, HitTarget, PlanReviewPhase};
use crate::style::*;
use crate::widgets::action_bar::{render_action_bar, ActionChip};
use crate::widgets::markdown::markdown_display_lines;

const BUTTONS: &[&str] = &["Accept", "Redo", "Comment"];
const BUTTON_KEYS: &[&str] = &["A", "R", "C"];

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    if !state.plan_review.takes_chat_area() {
        state.ui.plan_review_area = None;
        return;
    }
    state.ui.plan_review_area = Some(area);
    let Some(plan) = state.plan_review.pending.clone() else {
        return;
    };
    if area.width < 12 || area.height < 6 {
        return;
    }

    // Fill entire chat region — hide other list chrome
    super::panel_block(
        frame,
        area,
        Block::default().style(Style::default().bg(BG())),
    );

    let commenting = state.plan_review.phase == PlanReviewPhase::AwaitingComment;

    // Centered bordered card for plan approval: the title
    // rides the card border, the meta row sits inside, margins stay clean.
    let card = super::centered_panel(
        area,
        area.width.saturating_sub(4).min(104),
        area.height.saturating_sub(2),
    );
    if card.width < 10 || card.height < 8 {
        return;
    }
    let inner = super::modal_card(
        frame,
        card,
        vec![
            Span::styled("◇ ", Style::default().fg(WARNING())),
            Span::styled(
                "Plan ready",
                Style::default().fg(WARNING()).add_modifier(Modifier::BOLD),
            ),
            Span::styled("  ·  ", Style::default().fg(FG_DIM())),
            Span::styled(
                plan.title.clone(),
                Style::default().fg(FG()).add_modifier(Modifier::BOLD),
            ),
        ],
    );
    if inner.width < 8 || inner.height < 5 {
        return;
    }

    // Meta row + air gap, then the body, then the footer (2 rows + banner).
    let footer_h: u16 = 2;
    let banner_h: u16 = if commenting { 1 } else { 0 };
    let chrome_h = (2 + footer_h + banner_h).min(inner.height);
    let [meta_row, body, footer] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Fill(1),
        Constraint::Length(chrome_h.saturating_sub(2)),
    ])
    .areas(inner);

    // ── Body: full-width markdown ────────────────────────────────────────
    let [body_main, scroll_col] =
        Layout::horizontal([Constraint::Fill(1), Constraint::Length(1)]).areas(body);

    frame.render_widget(
        Block::default().style(Style::default().bg(BG_PANEL())),
        body_main,
    );

    let pad = 1u16;
    let text_w = body_main.width.saturating_sub(pad.saturating_mul(2)).max(8) as usize;
    // Empty-plan placeholder: an exited-without-plan turn still
    // explains the three actions instead of showing a bare "(empty plan)".
    let body_source = if plan.body_markdown.trim().is_empty() {
        "# No plan written yet\n\nThe agent exited plan mode without writing a plan.\n\n\
         - **Accept**: leave plan mode and start implementing\n\
         - **Redo**: ask the agent for a fresh plan\n\
         - **Comment**: send feedback and keep planning"
            .to_string()
    } else {
        plan.body_markdown.clone()
    };
    let lines = markdown_display_lines(&body_source, text_w);

    let total = lines.len();
    let visible = body_main.height as usize;
    let scroll = state.plan_review.scroll.sync(total, visible);
    let viewport = state.plan_review.scroll.viewport();

    let start = scroll;
    let end = (start + visible).min(lines.len());
    let window: Vec<Line> = lines[start..end]
        .iter()
        .cloned()
        .map(|mut line| {
            // Paint the card bg so the body never punches app-bg holes.
            for span in &mut line.spans {
                span.style = span.style.bg(BG_PANEL());
            }
            if line.spans.is_empty() {
                line.spans
                    .push(Span::styled(" ", Style::default().bg(BG_PANEL())));
            }
            line
        })
        .collect();

    let text_area = Rect::new(
        body_main.x.saturating_add(pad),
        body_main.y,
        body_main.width.saturating_sub(pad.saturating_mul(2)),
        body_main.height,
    );
    frame.render_widget(
        Paragraph::new(window).style(Style::default().bg(BG_PANEL())),
        text_area,
    );

    crate::widgets::scrollbar::render(
        frame,
        scroll_col,
        crate::widgets::scrollbar::ScrollSurface::Plan,
        viewport,
        BG_PANEL(),
        &state.ui,
    );

    // ── Meta: file · version on the left, where you are on the right ─────
    {
        let position = state
            .plan_review
            .scroll
            .position_label()
            .map(|at| format!("↑↓ scroll · {at}"))
            .unwrap_or_default();
        let meta = crate::widgets::justify(
            vec![Span::styled(
                format!("{} · v{}", plan.path, plan.version),
                Style::default().fg(FG_DIM()),
            )],
            vec![Span::styled(position, Style::default().fg(FG_DIM()))],
            meta_row.width as usize,
            BG_PANEL(),
        );
        frame.render_widget(
            Paragraph::new(Line::from(meta)).style(Style::default().bg(BG_PANEL())),
            Rect::new(meta_row.x, meta_row.y, meta_row.width, 1),
        );
    }

    // ── Footer: borderless air gap + actions or comment banner ───────────
    frame.render_widget(
        Block::default().style(Style::default().bg(BG_PANEL())),
        footer,
    );
    let fin = Rect::new(
        footer.x.saturating_add(1),
        footer.y.saturating_add(1),
        footer.width.saturating_sub(2),
        footer.height.saturating_sub(1),
    );
    if fin.height == 0 || fin.width == 0 {
        return;
    }

    if commenting {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("✎ ", Style::default().fg(PRIMARY()).bg(BG_PANEL())),
                Span::styled(
                    "Comment on the plan — type below and Enter to send",
                    Style::default().fg(FG()).bg(BG_PANEL()),
                ),
                Span::styled(
                    "  ·  Esc cancel",
                    Style::default().fg(FG_DIM()).bg(BG_PANEL()),
                ),
            ])),
            fin,
        );
    } else {
        let selected = state.plan_review.button_index.min(2);
        let chips: Vec<ActionChip> = BUTTONS
            .iter()
            .zip(BUTTON_KEYS.iter())
            .enumerate()
            .map(|(i, (label, key))| {
                let target = HitTarget::PlanAction(i);
                let hovered = state.ui.hovered_hit == Some(target.clone());
                let chip_style = if i == selected {
                    Style::default()
                        .fg(BG())
                        .bg(PRIMARY())
                        .add_modifier(Modifier::BOLD)
                } else if hovered {
                    Style::default().fg(FG()).bg(BG_HOVER())
                } else {
                    Style::default().fg(FG()).bg(BG_ELEMENT())
                };
                ActionChip::button(
                    format!(" {key} "),
                    chip_style,
                    format!(" {label}  "),
                    Style::default().fg(FG()).bg(BG_PANEL()),
                    target,
                )
                .with_hit_trim(1)
            })
            .collect();
        let trailing = vec![Span::styled(
            "  Esc hide",
            Style::default().fg(FG_DIM()).bg(BG_PANEL()),
        )];
        render_action_bar(frame, fin, &chips, 0, trailing, &state.ui.hits);
    }
}
