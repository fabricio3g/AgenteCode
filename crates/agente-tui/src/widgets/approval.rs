use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::pick::RowState;
use super::{display_width, truncate_cells};
use crate::state::{AppState, HitTarget};
use crate::style::{self, *};
use crate::widgets::diff_view::DiffView;
use agente_core::types::ApprovalAction;

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    let Some(request) = state.agent.current_approval() else {
        return;
    };
    if area.width < 16 || area.height < 6 {
        return;
    }

    let diff = match (&request.old_content, &request.new_content) {
        (Some(old), Some(new)) => {
            let path = request.file_path.as_deref().unwrap_or("file");
            Some(DiffView::from_content(
                old,
                new,
                path.to_string(),
                path.to_string(),
            ))
        }
        _ => None,
    };
    let desired_diff_height = diff
        .as_ref()
        .map(|view| view.rendered_height().clamp(3, 12) as u16)
        .unwrap_or(0);
    let action_rows = if area.width >= 64 { 1 } else { 2 };
    // Border(2) + gap + tool + target + gap + [diff|warning + gap] + actions.
    let middle = if diff.is_some() {
        desired_diff_height + 1
    } else if request.is_dangerous {
        2
    } else {
        0
    };
    let desired_height = 6 + middle + action_rows;
    let panel = super::centered_panel(
        area,
        area.width.saturating_sub(4).min(76),
        desired_height.min(area.height.saturating_sub(2)),
    );

    // Same card as every modal; the ◆ and the border tint carry the urgency
    // (red for destructive calls), echoing the activity strip's ◆.
    let accent = if request.is_dangerous {
        ERROR()
    } else {
        PRIMARY()
    };
    let mut title = vec![
        Span::styled("◆ ", Style::default().fg(accent)),
        Span::styled(
            if request.is_dangerous {
                "Review destructive tool call"
            } else {
                "Review tool call"
            },
            style::bold(),
        ),
    ];
    // Name the origin when a child raised the request: parent and child
    // approvals used to be indistinguishable.
    if let Some(agente_core::agent::ApprovalSource::Subagent { id }) =
        state.agent.current_approval_source()
    {
        let label = state
            .agent
            .subagents
            .get(id)
            .map(|ui| ui.subagent_type.clone())
            .unwrap_or_else(|| id.chars().take(8).collect());
        title.push(Span::styled(format!(" · subagent {label}"), style::dim()));
    }
    let body = super::modal_card_tinted(
        frame,
        panel,
        title,
        blend_colors(accent, BORDER_RULE(), 0.3),
    );
    let inner = Rect::new(
        body.x.saturating_add(1),
        body.y,
        body.width.saturating_sub(2),
        body.height,
    );
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    // Rows are derived against the actions row instead of assuming the panel
    // reached its desired height: a clamped panel (short terminal) must drop
    // the middle rows rather than paint over the action bar — or past the
    // panel bottom, which panics.
    let actions_dy = inner.height.saturating_sub(action_rows);
    let row = |dy: u16| -> Option<Rect> {
        (dy < actions_dy).then(|| Rect::new(inner.x, inner.y + dy, inner.width, 1))
    };
    let label_w = 8u16;
    let field = |frame: &mut Frame, dy: u16, label: &str, value: Span<'static>| {
        if let Some(row_area) = row(dy) {
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled(format!("{label:<w$}", w = label_w as usize), style::dim()),
                    value,
                ]))
                .style(style::panel()),
                row_area,
            );
        }
    };
    let value_w = inner.width.saturating_sub(label_w) as usize;
    field(
        frame,
        1,
        "tool",
        Span::styled(
            truncate_cells(
                &format!("{}  {}", request.tool_name, request.description),
                value_w,
            ),
            style::text(),
        ),
    );
    if let Some(target) = request_target(request) {
        field(
            frame,
            2,
            "target",
            Span::styled(
                truncate_cells(&target, value_w),
                Style::default().fg(SECONDARY()),
            ),
        );
    }

    if let Some(view) = &diff {
        let diff_height = actions_dy.saturating_sub(5).min(desired_diff_height);
        if diff_height > 0 {
            frame.render_widget(
                view,
                Rect::new(inner.x, inner.y + 4, inner.width, diff_height),
            );
        }
    } else if request.is_dangerous {
        if let Some(row_area) = row(4) {
            frame.render_widget(
                Paragraph::new("This operation can modify or remove data.")
                    .style(style::error().bg(BG_PANEL())),
                row_area,
            );
        }
    }

    let actions_y = inner.y + actions_dy;

    // Two-row layout moves `Esc cancel` under the buttons on narrow panels.
    let first_row = if action_rows == 1 {
        ACTIONS
    } else {
        &ACTIONS[..3]
    };
    render_actions(
        frame,
        state,
        Rect::new(inner.x, actions_y, inner.width, 1),
        first_row,
    );
    if action_rows > 1 {
        render_actions(
            frame,
            state,
            Rect::new(inner.x, actions_y.saturating_add(1), inner.width, 1),
            &ACTIONS[3..],
        );
    }
}

/// One approval button: key cap, label, and the action it resolves to.
struct ActionButton {
    key: &'static str,
    label: &'static str,
    action: ApprovalAction,
    cap: fn() -> Style,
}

const ACTIONS: &[ActionButton] = &[
    ActionButton {
        key: " Y ",
        label: " allow once",
        action: ApprovalAction::ApproveOnce,
        cap: style::button_primary,
    },
    ActionButton {
        key: " A ",
        label: " allow for turn",
        action: ApprovalAction::ApproveAll,
        cap: style::button_secondary,
    },
    ActionButton {
        key: " N ",
        label: " deny",
        action: ApprovalAction::Deny,
        cap: style::button_danger,
    },
    // `Esc` resolves to Deny, same as the keyboard.
    ActionButton {
        key: "Esc",
        label: " cancel",
        action: ApprovalAction::Deny,
        cap: style::dim,
    },
];

/// Paint `buttons` left to right in `row`, registering each one's hit rect
/// from its drawn width, centered in `row`. The hovered button's label gets
/// a lifted band.
fn render_actions(frame: &mut Frame, state: &AppState, row: Rect, buttons: &[ActionButton]) {
    const GAP: u16 = 3;
    frame.render_widget(Paragraph::new("").style(style::panel()), row);
    // Centered like every modal footer.
    let widths: Vec<u16> = buttons
        .iter()
        .map(|b| (display_width(b.key) + display_width(b.label)) as u16)
        .collect();
    let total = widths.iter().sum::<u16>() + GAP * (widths.len() as u16).saturating_sub(1);
    let mut x = row.x + row.width.saturating_sub(total) / 2;
    for (button, width) in buttons.iter().zip(widths) {
        let rect = Rect::new(x, row.y, width.min(row.right().saturating_sub(x)), 1);
        if rect.width == 0 {
            break;
        }
        let target = HitTarget::Approval(button.action.clone());
        let hovered = state.ui.hovered_hit.as_ref() == Some(&target);
        let band = RowState::from_flags(false, hovered).bg();
        let label = if hovered {
            style::text().bg(band)
        } else {
            style::muted().bg(band)
        };
        let cap = (button.cap)();
        let cap = if cap.bg.is_none() { cap.bg(band) } else { cap };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(button.key, cap),
                Span::styled(button.label, label),
            ])),
            rect,
        );
        state.ui.hits.push(rect, target);
        x = x.saturating_add(width + GAP);
    }
}

fn request_target(request: &agente_core::types::ApprovalRequest) -> Option<String> {
    if let Some(path) = &request.file_path {
        return Some(path.clone());
    }
    let val = serde_json::from_str::<serde_json::Value>(&request.tool_args).ok()?;
    if let Some(cmd) = val
        .get("command")
        .or_else(|| val.get("cmd"))
        .and_then(|v| v.as_str())
    {
        return Some(cmd.to_string());
    }
    if let Some(path) = val
        .get("path")
        .or_else(|| val.get("file_path"))
        .or_else(|| val.get("file"))
        .and_then(|v| v.as_str())
    {
        return Some(path.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(file_path: Option<&str>, tool_args: &str) -> agente_core::types::ApprovalRequest {
        agente_core::types::ApprovalRequest {
            request_id: "test".into(),
            tool_name: "test".into(),
            tool_args: tool_args.into(),
            description: "test".into(),
            is_dangerous: false,
            old_content: None,
            new_content: None,
            file_path: file_path.map(str::to_string),
        }
    }

    #[test]
    fn request_target_prefers_explicit_file_path() {
        let req = request(Some("src/main.rs"), r#"{"command":"cargo check"}"#);
        assert_eq!(request_target(&req).as_deref(), Some("src/main.rs"));
    }

    #[test]
    fn request_target_reads_command_then_path_from_args() {
        let cmd = request(None, r#"{"command":"cargo check"}"#);
        assert_eq!(request_target(&cmd).as_deref(), Some("cargo check"));
        let alias = request(None, r#"{"cmd":"ls"}"#);
        assert_eq!(request_target(&alias).as_deref(), Some("ls"));
        let path = request(None, r#"{"path":"src/lib.rs"}"#);
        assert_eq!(request_target(&path).as_deref(), Some("src/lib.rs"));
        let none = request(None, r#"{"other":1}"#);
        assert_eq!(request_target(&none), None);
    }
}
