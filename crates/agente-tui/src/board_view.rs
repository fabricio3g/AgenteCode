//! `/board`: the swarm board, read-only — the main model plans it, its
//! subagents work it.
//!
//! Four columns hard-left to hard-right: Backlog, Working, Review, Done
//! (failed cards sit in Done with a red `✗`). A card is two lines: its title,
//! then `role · model` dim; the working ones carry the accent `●`, cards
//! waiting on others say what for. Esc closes, `s` turns swarm mode off/on.

use agente_core::swarm::{Board, Card, CardStatus};
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::AppState;
use crate::style;
use crate::widgets::markdown::wrap_line;
use crate::widgets::{
    centered_panel, footer_hints, modal_card, modal_footer, panel_row, s, truncate_cells,
};

const COLUMNS: [(&str, &[CardStatus]); 4] = [
    ("Backlog", &[CardStatus::Backlog]),
    ("Working", &[CardStatus::Working]),
    ("Review", &[CardStatus::Review]),
    ("Done", &[CardStatus::Done, CardStatus::Failed]),
];

fn card_lines(card: &Card, width: usize) -> [Line<'static>; 2] {
    let (mark, mark_style) = match card.status {
        CardStatus::Working => ("● ", style::accent()),
        CardStatus::Review => ("◆ ", style::warning()),
        CardStatus::Failed => ("✗ ", style::error()),
        CardStatus::Done => ("✓ ", style::dim()),
        CardStatus::Backlog => ("○ ", style::dim()),
    };
    let title_style = if card.status == CardStatus::Done {
        style::muted()
    } else {
        style::bold()
    };
    let title = Line::from(vec![
        s(mark, mark_style),
        s(
            truncate_cells(
                &format!("{} {}", card.id, card.title),
                width.saturating_sub(2),
            ),
            title_style,
        ),
    ]);
    let mut detail = card.role.clone();
    if let Some(model) = &card.model {
        detail.push_str(&format!(" · {model}"));
    }
    if card.status == CardStatus::Backlog && !card.depends_on.is_empty() {
        detail = format!("waits for {}", card.depends_on.join(", "));
    }
    let detail = Line::from(vec![
        s("  ", style::dim()),
        s(
            truncate_cells(&detail, width.saturating_sub(2)),
            style::dim(),
        ),
    ]);
    [title, detail]
}

/// The count line under the title: what is moving and what needs you.
fn tally(board: &Board) -> String {
    let count = |status: CardStatus| board.cards.iter().filter(|c| c.status == status).count();
    let mut parts = vec![format!("{} cards", board.cards.len())];
    for (status, label) in [
        (CardStatus::Working, "working"),
        (CardStatus::Review, "to review"),
        (CardStatus::Failed, "failed"),
    ] {
        let n = count(status);
        if n > 0 {
            parts.push(format!("{n} {label}"));
        }
    }
    parts.join(" · ")
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_board || area.width < 24 || area.height < 8 {
        return;
    }
    let empty = Board::default();
    let board = state.agent.board.as_ref().unwrap_or(&empty);
    let panel = centered_panel(
        area,
        area.width.saturating_sub(4).min(120),
        area.height.saturating_sub(2).min(28),
    );
    let mut title = vec![s("Board", style::bold())];
    title.push(s(
        if board.enabled {
            "  swarm on"
        } else {
            "  swarm off"
        },
        if board.enabled {
            style::accent()
        } else {
            style::dim()
        },
    ));
    let body = modal_card(frame, panel, title);

    let mut scrollable = false;
    if let Some(top) = panel_row(body, 1, 1) {
        let inner_width = top.width;
        if board.cards.is_empty() {
            let hint = if board.enabled {
                "No cards yet. Ask for something big: the agent plans it here and its subagents work it."
            } else {
                "Swarm mode is off. Press s (or /swarm) to let the agent plan work as a board."
            };
            let hint_area = Rect {
                height: body.height.saturating_sub(3).max(1),
                ..top
            };
            let wrapped = wrap_line(&Line::from(s(hint, style::dim())), inner_width as usize);
            frame.render_widget(Paragraph::new(wrapped), hint_area);
        } else {
            frame.render_widget(Paragraph::new(s(tally(board), style::dim())), top);
            let gap = 2u16;
            let column_width = (inner_width.saturating_sub(gap * 3)) / 4;
            let rows = body.height.saturating_sub(6);
            let rows_usize = rows as usize;
            // Each card occupies 2 lines + 1 gap row (the final card needs no gap).
            let full_cap = ((rows_usize + 1) / 3).max(1);
            let max_col_cards = COLUMNS
                .iter()
                .map(|(_, statuses)| {
                    board
                        .cards
                        .iter()
                        .filter(|card| statuses.contains(&card.status))
                        .count()
                })
                .max()
                .unwrap_or(0);
            let max_scroll = max_col_cards.saturating_sub(full_cap);
            scrollable = max_scroll > 0;
            let scroll = state.input.board_scroll.min(max_scroll);

            for (index, (label, statuses)) in COLUMNS.iter().enumerate() {
                let x = top.x + index as u16 * (column_width + gap);
                let cards: Vec<&Card> = board
                    .cards
                    .iter()
                    .filter(|card| statuses.contains(&card.status))
                    .collect();
                let header = Rect::new(x, top.y + 2, column_width, 1);
                frame.render_widget(
                    Paragraph::new(Line::from(vec![
                        s(label.to_string(), style::muted()),
                        s(format!("  {}", cards.len()), style::dim()),
                    ])),
                    header,
                );
                let col_scroll = scroll.min(cards.len().saturating_sub(full_cap));
                let remaining = &cards[col_scroll..];
                let mut lines: Vec<Line<'static>> = Vec::new();
                if rows_usize > 0 {
                    let overflow = remaining.len() > full_cap;
                    let shown = if overflow {
                        // Reserve 1 row for `+N more`.
                        let avail = rows_usize.saturating_sub(1);
                        if avail >= 2 {
                            ((avail + 1) / 3)
                                .max(1)
                                .min(remaining.len().saturating_sub(1))
                        } else {
                            0
                        }
                    } else {
                        remaining.len()
                    };
                    for (card_idx, card) in remaining.iter().take(shown).enumerate() {
                        lines.extend(card_lines(card, column_width as usize));
                        let need_gap =
                            card_idx + 1 < shown || (overflow && lines.len() + 2 <= rows_usize);
                        if need_gap {
                            lines.push(Line::from(""));
                        }
                    }
                    let hidden = remaining.len().saturating_sub(shown);
                    if hidden > 0 {
                        let more =
                            truncate_cells(&format!("  +{hidden} more"), column_width as usize);
                        lines.push(Line::from(s(more, style::dim())));
                    }
                }
                let list = Rect::new(x, top.y + 3, column_width, rows);
                frame.render_widget(Paragraph::new(lines), list);
            }
        }
    }
    let mut hints = vec![(
        "s",
        if board.enabled {
            "swarm off"
        } else {
            "swarm on"
        },
    )];
    if scrollable {
        hints.push(("↑↓", "scroll"));
    }
    hints.push(("Esc", "close"));
    modal_footer(
        frame,
        body,
        footer_hints(&hints, body.width.saturating_sub(2)),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use agente_core::swarm::CardSpec;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn draw(state: &AppState) -> String {
        let mut terminal = Terminal::new(TestBackend::new(110, 26)).unwrap();
        terminal.draw(|f| render(f, f.area(), state)).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    #[test]
    fn columns_show_cards_by_status() {
        let mut board = Board::default();
        board.enabled = true;
        let spec = |title: &str, deps: &[&str]| -> CardSpec {
            serde_json::from_value(serde_json::json!({
                "title": title, "role": "Mapper", "model": "scout", "prompt": "p",
                "depends_on": deps
            }))
            .unwrap()
        };
        board
            .add(vec![spec("Map code", &[]), spec("Write docs", &["c1"])])
            .unwrap();
        board.start("c1", "child");
        let mut state = AppState::new(AppConfig::default(), "/tmp/board".into());
        state.agent.board = Some(board);
        state.input.show_board = true;
        let text = draw(&state);
        assert!(text.contains("swarm on"), "{text}");
        assert!(text.contains("Working  1"), "{text}");
        assert!(text.contains("● c1 Map code"), "{text}");
        assert!(text.contains("Mapper · scout"), "{text}");
        assert!(text.contains("○ c2 Write docs"), "{text}");
        assert!(text.contains("waits for c1"), "{text}");
        assert!(text.contains("2 cards · 1 working"), "{text}");
    }

    #[test]
    fn an_empty_board_says_how_to_start() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/board".into());
        state.input.show_board = true;
        assert!(draw(&state).contains("Swarm mode is off"));

        // Narrow terminal still wraps the hint cleanly across lines.
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let narrow: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(narrow.contains("Swarm mode is off"), "{narrow}");
        assert!(narrow.contains("board."), "wrapped tail visible: {narrow}");
    }

    #[test]
    fn overflowing_column_shows_more_indicator_and_scrolls() {
        let mut board = Board::default();
        board.enabled = true;
        let specs: Vec<CardSpec> = (1..=8)
            .map(|i| {
                serde_json::from_value(serde_json::json!({
                    "title": format!("Task {i}"),
                    "role": "Worker",
                    "prompt": "p",
                }))
                .unwrap()
            })
            .collect();
        board.add(specs).unwrap();
        let mut state = AppState::new(AppConfig::default(), "/tmp/board-overflow".into());
        state.agent.board = Some(board);
        state.input.show_board = true;

        let mut terminal = Terminal::new(TestBackend::new(100, 14)).unwrap();
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let first: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(first.contains("more"), "overflow indicator shown: {first}");
        assert!(first.contains("c1 Task 1"), "{first}");

        state.input.board_scroll = 10;
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let scrolled: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(
            scrolled.contains("c8 Task 8"),
            "scrolling reaches bottom cards: {scrolled}"
        );
    }
}
