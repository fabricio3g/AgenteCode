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
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, panel_row, s};

const COLUMNS: [(&str, &[CardStatus]); 4] = [
    ("Backlog", &[CardStatus::Backlog]),
    ("Working", &[CardStatus::Working]),
    ("Review", &[CardStatus::Review]),
    ("Done", &[CardStatus::Done, CardStatus::Failed]),
];

fn clip(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_string();
    }
    let mut out: String = text.chars().take(width.saturating_sub(1)).collect();
    out.push('…');
    out
}

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
        s(clip(&format!("{} {}", card.id, card.title), width.saturating_sub(2)), title_style),
    ]);
    let mut detail = card.role.clone();
    if let Some(model) = &card.model {
        detail.push_str(&format!(" · {model}"));
    }
    if card.status == CardStatus::Backlog && !card.depends_on.is_empty() {
        detail = format!("waits for {}", card.depends_on.join(", "));
    }
    let detail = Line::from(vec![s("  ", style::dim()), s(clip(&detail, width.saturating_sub(2)), style::dim())]);
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
    let panel = centered_panel(area, area.width.saturating_sub(4).min(120), area.height.saturating_sub(2).min(28));
    let mut title = vec![s("Board", style::bold())];
    title.push(s(
        if board.enabled { "  swarm on" } else { "  swarm off" },
        if board.enabled { style::accent() } else { style::dim() },
    ));
    let body = modal_card(frame, panel, title);

    if let Some(top) = panel_row(body, 1, 1) {
        let inner_width = top.width;
        if board.cards.is_empty() {
            let hint = if board.enabled {
                "No cards yet. Ask for something big: the agent plans it here and its subagents work it."
            } else {
                "Swarm mode is off. Press s (or /swarm) to let the agent plan work as a board."
            };
            frame.render_widget(Paragraph::new(s(hint, style::dim())), top);
        } else {
            frame.render_widget(Paragraph::new(s(tally(board), style::dim())), top);
            let gap = 2u16;
            let column_width = (inner_width.saturating_sub(gap * 3)) / 4;
            let rows = body.height.saturating_sub(6);
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
                let mut lines: Vec<Line<'static>> = Vec::new();
                for card in cards {
                    lines.extend(card_lines(card, column_width as usize));
                    lines.push(Line::from(""));
                }
                let list = Rect::new(x, top.y + 3, column_width, rows);
                frame.render_widget(Paragraph::new(lines), list);
            }
        }
    }
    modal_footer(
        frame,
        body,
        footer_hints(
            &[
                ("s", if board.enabled { "swarm off" } else { "swarm on" }),
                ("Esc", "close"),
            ],
            body.width.saturating_sub(2),
        ),
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
        board.add(vec![spec("Map code", &[]), spec("Write docs", &["c1"])]).unwrap();
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
    }
}
