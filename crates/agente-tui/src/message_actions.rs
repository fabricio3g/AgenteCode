//! Click one of your sent messages: revert to it, fork from it, or copy it.
//!
//! - **Revert** undoes the file edits made after the message (through the
//!   conflict-checked undo stack, so Redo still works), rewinds the chat and
//!   the model's context to just before it, and puts the message back in
//!   the composer to edit and resend.
//! - **Fork** opens a new session with the chat up to the message and the
//!   message in the composer; this session is saved untouched.

use ratatui::layout::Rect;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style;
use crate::widgets::pick::{pick_list, row_label, PickItem};
use crate::widgets::{
    centered_panel, footer_hints, modal_card, modal_footer, panel_row, s, truncate_cells,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageAction {
    Revert,
    Fork,
    Copy,
    ToggleExpand,
}

/// Actions offered for `entry_id`, in display order.
pub fn actions(state: &AppState, entry_id: uuid::Uuid) -> Vec<MessageAction> {
    let mut list = vec![
        MessageAction::Revert,
        MessageAction::Fork,
        MessageAction::Copy,
    ];
    let long = state
        .session
        .chat_history
        .iter()
        .find(|e| e.id == entry_id)
        .is_some_and(|e| e.content.lines().count() > crate::widgets::chat::USER_PREVIEW_LINES);
    if long {
        list.push(MessageAction::ToggleExpand);
    }
    list
}

impl MessageAction {
    /// Label, the right-hand detail, and whether the action can run right
    /// now (when it cannot, the detail says why).
    fn row(self, state: &AppState, entry_id: uuid::Uuid) -> (&'static str, String, bool) {
        let busy = !state.agent.is_idle();
        let point = state.session.rewind_point(entry_id);
        match self {
            Self::Revert => {
                let detail = match (&point, busy) {
                    (_, true) => ("wait for the agent to finish".to_string(), false),
                    (Err(reason), _) => (reason.to_string(), false),
                    (Ok(point), _) => match point.later_file_edits {
                        Some(0) => ("rewind the chat".to_string(), true),
                        Some(n) => (
                            format!(
                                "undo {n} file edit{} + rewind",
                                if n == 1 { "" } else { "s" }
                            ),
                            true,
                        ),
                        None => ("rewind the chat (files unchanged)".to_string(), true),
                    },
                };
                ("↺ Revert to here", detail.0, detail.1)
            }
            Self::Fork => {
                let detail = match (&point, busy) {
                    (_, true) => ("wait for the agent to finish".to_string(), false),
                    (Err(reason), _) => (reason.to_string(), false),
                    (Ok(_), _) => ("new session from here".to_string(), true),
                };
                ("⎇ Fork into a new session", detail.0, detail.1)
            }
            Self::Copy => ("⧉ Copy message", String::new(), true),
            Self::ToggleExpand => {
                let expanded = state.ui.expanded_message_ids.contains(&entry_id);
                (
                    if expanded {
                        "▾ Collapse"
                    } else {
                        "▸ Expand"
                    },
                    String::new(),
                    true,
                )
            }
        }
    }

    /// Single-key shortcut shown in the footer.
    pub fn key(self) -> char {
        match self {
            Self::Revert => 'r',
            Self::Fork => 'f',
            Self::Copy => 'c',
            Self::ToggleExpand => 'e',
        }
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    let Some(entry_id) = state.ui.message_actions else {
        return;
    };
    let Some(entry) = state.session.chat_history.iter().find(|e| e.id == entry_id) else {
        return;
    };
    if area.width < 16 || area.height < 9 {
        return;
    }
    let list = actions(state, entry_id);
    // gap + preview(2) + gap + actions + gap + footer inside the border.
    let panel = centered_panel(
        area,
        area.width.saturating_sub(4).min(72),
        list.len() as u16 + 8,
    );
    let body = modal_card(
        frame,
        panel,
        vec![
            s("Your message", style::bold()),
            s(
                format!(
                    " · {}",
                    entry
                        .timestamp
                        .with_timezone(&chrono::Local)
                        .format("%-I:%M %p")
                ),
                style::dim(),
            ),
        ],
    );
    let text_w = body.width.saturating_sub(4) as usize;
    let mut preview = entry.content.lines().filter(|l| !l.trim().is_empty());
    for dy in [1u16, 2] {
        if let (Some(row), Some(line)) = (panel_row(body, dy, 1), preview.next()) {
            let prefix = if dy == 1 { "> " } else { "  " };
            frame.render_widget(
                ratatui::widgets::Paragraph::new(ratatui::text::Line::from(vec![
                    s(prefix, style::accent()),
                    s(truncate_cells(line, text_w), style::muted()),
                ])),
                row,
            );
        }
    }
    if let Some(top) = panel_row(body, 4, 1) {
        let list_area = Rect {
            height: body.height.saturating_sub(6),
            ..top
        };
        let selected = state.input.message_actions_selected;
        let items = list
            .iter()
            .enumerate()
            .map(|(i, action)| {
                let (label, detail, available) = action.row(state, entry_id);
                let label_style = if available {
                    row_label(i == selected)
                } else {
                    style::dim()
                };
                PickItem::row_with_trail(
                    vec![s(label, label_style)],
                    vec![s(
                        detail,
                        if available {
                            style::dim()
                        } else {
                            style::warning()
                        },
                    )],
                )
            })
            .collect();
        pick_list(
            frame,
            list_area,
            &state.ui.hits,
            ListId::MessageActions,
            items,
            selected,
        );
    }
    modal_footer(
        frame,
        body,
        footer_hints(
            &[
                ("↑↓", "move"),
                ("Enter", "choose"),
                ("r/f/c", "shortcut"),
                ("Esc", "close"),
            ],
            body.width.saturating_sub(2),
        ),
    );
}

/// Whether `action` can run right now (the dialog greys out the rest).
pub fn is_available(state: &AppState, entry_id: uuid::Uuid, action: MessageAction) -> bool {
    action.row(state, entry_id).2
}
