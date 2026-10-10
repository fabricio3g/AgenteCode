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
    // The full target is shown: a long command wrapped over several rows, never
    // cut off where its tail (`; rm -rf …`) would go unread before approving.
    let target = request_target(request);
    let target_lines = target
        .as_deref()
        .map(|text| wrap_target(text, (panel_inner_width(area) as usize).saturating_sub(8)))
        .unwrap_or_default();
    let extra = target_lines.len().saturating_sub(1) as u16;
    // Border(2) + gap + tool + target + gap + [diff|warning + gap] + actions.
    let middle = if diff.is_some() {
        desired_diff_height + 1
    } else if request.is_dangerous {
        2
    } else {
        0
    };
    let desired_height = 6 + middle + action_rows + extra;
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
    for (index, line) in target_lines.iter().enumerate() {
        field(
            frame,
            2 + index as u16,
            if index == 0 { "target" } else { "" },
            Span::styled(line.clone(), Style::default().fg(SECONDARY())),
        );
    }

    if let Some(view) = &diff {
        let diff_height = actions_dy
            .saturating_sub(5 + extra)
            .min(desired_diff_height);
        if diff_height > 0 {
            frame.render_widget(
                view,
                Rect::new(inner.x, inner.y + 4 + extra, inner.width, diff_height),
            );
        }
    } else if request.is_dangerous {
        if let Some(row_area) = row(4 + extra) {
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
/// from its drawn width, from `row`'s left edge (the edge the tool and target
/// rows share). The hovered button's label gets a lifted band.
fn render_actions(frame: &mut Frame, state: &AppState, row: Rect, buttons: &[ActionButton]) {
    const GAP: u16 = 3;
    frame.render_widget(Paragraph::new("").style(style::panel()), row);
    let widths: Vec<u16> = buttons
        .iter()
        .map(|b| (display_width(b.key) + display_width(b.label)) as u16)
        .collect();
    let mut x = row.x;
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

/// Inner width of the review card for an `area` (mirrors the panel sizing in
/// [`render`]: the card is at most 76 wide with a 1-cell gutter each side).
fn panel_inner_width(area: Rect) -> u16 {
    area.width.saturating_sub(4).min(76).saturating_sub(4)
}

/// Hard-wrap `text` into at most six rows of `width` cells (the last row
/// ends in `…` when more remains). Newlines in a command start a new row.
fn wrap_target(text: &str, width: usize) -> Vec<String> {
    const MAX_ROWS: usize = 6;
    let width = width.max(8);
    let mut rows: Vec<String> = Vec::new();
    for raw in text.lines() {
        let mut current = String::new();
        let mut cells = 0;
        for ch in raw.chars() {
            let w = display_width(&ch.to_string());
            if cells + w > width {
                rows.push(std::mem::take(&mut current));
                cells = 0;
            }
            current.push(ch);
            cells += w;
        }
        rows.push(current);
    }
    if rows.len() > MAX_ROWS {
        rows.truncate(MAX_ROWS);
        if let Some(last) = rows.last_mut() {
            *last = truncate_cells(&format!("{last}…"), width);
            if !last.ends_with('…') {
                last.push('…');
            }
        }
    }
    rows
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
    // Other tools (MCP, patches): the arguments themselves, so the person
    // approves what will actually be sent, not just a tool name.
    let obj = val.as_object().filter(|obj| !obj.is_empty())?;
    Some(
        obj.iter()
            .map(|(key, value)| match value.as_str() {
                Some(text) => format!("{key}={}", text.replace('\n', " ")),
                None => format!("{key}={value}"),
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
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
        let other = request(None, r#"{"other":1}"#);
        assert_eq!(request_target(&other).as_deref(), Some("other=1"));
        let none = request(None, "{}");
        assert_eq!(request_target(&none), None);
    }

    #[test]
    fn wrap_target_keeps_the_whole_short_command_and_flags_overflow() {
        let rows = wrap_target("ls -la; rm -rf build", 10);
        assert_eq!(rows.concat(), "ls -la; rm -rf build");
        let long = "x".repeat(500);
        let rows = wrap_target(&long, 20);
        assert_eq!(rows.len(), 6);
        assert!(rows[5].ends_with('…'));
    }
}
