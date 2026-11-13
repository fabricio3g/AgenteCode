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
    let action_rows = if area.width >= 56 { 1 } else { 2 };
    // The full target is shown: a long command wrapped over several rows, never
    // cut off where its tail (`; rm -rf …`) would go unread before approving.
    // A diff names its own file and counts in its header, so with a diff the
    // target line would only repeat it.
    let target = if diff.is_some() { None } else { request_target(request) };
    let target_lines = target
        .as_deref()
        .map(|text| wrap_target(text, panel_inner_width(area) as usize))
        .unwrap_or_default();
    let warning_rows = u16::from(request.is_dangerous);
    // Border(2) + gap + [target rows | diff] + [warning] + gap + actions.
    let middle = if diff.is_some() {
        desired_diff_height
    } else {
        target_lines.len() as u16
    };
    let desired_height = 4 + middle + warning_rows + action_rows;
    // Docked on the composer, as the desktop's approval bar is: the transcript
    // above stays readable while the question waits right where the keys are.
    let height = desired_height.min(area.height.saturating_sub(1));
    let panel = Rect::new(
        area.x + 1.min(area.width),
        area.bottom().saturating_sub(height),
        area.width.saturating_sub(2),
        height,
    );

    // The card's tint (amber, red for a destructive call) is the one status
    // mark; the title asks the question by kind, as the desktop does.
    let accent = if request.is_dangerous {
        ERROR()
    } else {
        WARNING()
    };
    let mut title = vec![Span::styled(question(request), style::bold())];
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

    let mut dy = 1u16;
    if let Some(view) = &diff {
        let diff_height = actions_dy
            .saturating_sub(2 + warning_rows)
            .min(desired_diff_height);
        if diff_height > 0 {
            frame.render_widget(view, Rect::new(inner.x, inner.y + dy, inner.width, diff_height));
        }
        dy += diff_height;
    } else {
        for line in &target_lines {
            if let Some(row_area) = row(dy) {
                frame.render_widget(
                    Paragraph::new(Line::from(Span::styled(line.clone(), style::text())))
                        .style(style::panel()),
                    row_area,
                );
            }
            dy += 1;
        }
    }
    if request.is_dangerous {
        if let Some(row_area) = row(dy) {
            frame.render_widget(
                Paragraph::new("This can modify or remove data.")
                    .style(style::error().bg(BG_PANEL())),
                row_area,
            );
        }
    }

    let actions_y = inner.y + actions_dy;

    // Two-row layout moves Deny under the two allows on narrow panels.
    let first_row = if action_rows == 1 {
        ACTIONS
    } else {
        &ACTIONS[..2]
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
            &ACTIONS[2..],
        );
    }
}

/// One approval button: the answer as a cap, then the key that gives it —
/// the desktop bar's "Allow Enter / Deny Esc", in cells.
struct ActionButton {
    key: &'static str,
    label: &'static str,
    action: ApprovalAction,
    cap: fn() -> Style,
}

/// Enter allows and Esc denies, as on the desktop; `Y`/`A`/`N` still work
/// (`handle_approval_key`) but the buttons name the keys people reach for.
const ACTIONS: &[ActionButton] = &[
    ActionButton {
        key: " Allow ",
        label: " Enter",
        action: ApprovalAction::ApproveOnce,
        cap: style::button_primary,
    },
    ActionButton {
        key: " Allow for turn ",
        label: " A",
        action: ApprovalAction::ApproveAll,
        cap: style::button_secondary,
    },
    ActionButton {
        key: " Deny ",
        label: " Esc",
        action: ApprovalAction::Deny,
        cap: style::text,
    },
];

/// The question the card asks, by the kind of call.
fn question(request: &agente_core::types::ApprovalRequest) -> String {
    match request.tool_name.as_str() {
        "edit_file" | "write_file" | "apply_patch" | "edit" | "write" => "Allow this edit?".into(),
        "shell" | "bash" | "process_stop" => "Run this command?".into(),
        "present_plan" => "Approve this plan?".into(),
        other => format!("Allow {}?", other.replace('_', " ")),
    }
}

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
/// [`render`]: the card spans the area less a 1-cell gutter each side).
fn panel_inner_width(area: Rect) -> u16 {
    area.width.saturating_sub(2).saturating_sub(4)
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
