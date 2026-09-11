use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::truncate_cells;
use crate::state::AppState;
use crate::style::{self, *};
use crate::widgets::diff_view::DiffView;

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    state.ui.approval_hitboxes.clear();
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
    let desired_height = 7 + action_rows + desired_diff_height;
    let panel = super::centered_panel(
        area,
        area.width.saturating_sub(4).min(76),
        desired_height.min(area.height.saturating_sub(2)),
    );
    // Opaque: a bare background `Block` only restyles the cells, so the chat
    // text underneath used to read straight through the approval card.
    super::panel_bg(frame, panel);

    let accent = if request.is_dangerous {
        ERROR()
    } else {
        PRIMARY()
    };

    // Solid accent rail on the panel's left edge: a frozen bar reads as
    // "paused on you" without any spinner motion (the activity strip pulses a
    // ◆ in the same state — one cue, two surfaces).
    for y in panel.y..panel.y.saturating_add(panel.height) {
        frame.buffer_mut()[(panel.x, y)]
            .set_symbol("┃")
            .set_style(Style::default().fg(accent).bg(BG_PANEL()));
    }

    let inner = Rect::new(
        panel.x.saturating_add(2),
        panel.y.saturating_add(1),
        panel.width.saturating_sub(4),
        panel.height.saturating_sub(2),
    );
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let title = if request.is_dangerous {
        "Review destructive tool call"
    } else {
        "Review tool call"
    };
    // Rows are derived against the actions row instead of assuming the panel
    // reached its desired height: a clamped panel (short terminal) must drop
    // the middle rows rather than paint over the action bar — or past the
    // panel bottom, which panics.
    let actions_dy = inner.height.saturating_sub(action_rows);
    let row = |dy: u16| -> Option<Rect> {
        if dy >= actions_dy {
            None
        } else {
            Some(Rect::new(inner.x, inner.y + dy, inner.width, 1))
        }
    };

    if let Some(row_area) = row(0) {
        // Name the origin when a child raised the request: parent and child
        // approvals used to be indistinguishable.
        let mut title_spans = vec![
            Span::styled("◆ ", Style::default().fg(accent).bg(BG_PANEL())),
            Span::styled(
                title,
                Style::default()
                    .fg(FG())
                    .bg(BG_PANEL())
                    .add_modifier(Modifier::BOLD),
            ),
        ];
        if let Some(agente_core::agent::ApprovalSource::Subagent { id }) =
            state.agent.current_approval_source()
        {
            let label = state
                .agent
                .subagents
                .get(id)
                .map(|ui| ui.subagent_type.clone())
                .unwrap_or_else(|| id.chars().take(8).collect());
            title_spans.push(Span::styled(
                format!("   subagent {label}"),
                style::dim().bg(BG_PANEL()),
            ));
        }
        frame.render_widget(
            Paragraph::new(Line::from(title_spans)).style(style::panel()),
            row_area,
        );
    }

    if let Some(row_area) = row(2) {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("tool  ", style::dim().bg(BG_PANEL())),
                Span::styled(request.tool_name.clone(), style::accent().bg(BG_PANEL())),
                Span::styled(
                    format!(
                        "  {}",
                        truncate_cells(
                            &request.description,
                            inner.width.saturating_sub(16) as usize
                        )
                    ),
                    style::muted().bg(BG_PANEL()),
                ),
            ]))
            .style(style::panel()),
            row_area,
        );
    }

    if let Some(target) = request_target(request) {
        if let Some(row_area) = row(3) {
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled("target  ", style::dim().bg(BG_PANEL())),
                    Span::styled(
                        truncate_cells(&target, inner.width.saturating_sub(8) as usize),
                        Style::default().fg(SECONDARY()).bg(BG_PANEL()),
                    ),
                ]))
                .style(style::panel()),
                row_area,
            );
        }
    }

    if let Some(view) = &diff {
        let diff_height = actions_dy.saturating_sub(5).min(desired_diff_height);
        if diff_height > 0 {
            frame.render_widget(
                view,
                Rect::new(inner.x, inner.y + 5, inner.width, diff_height),
            );
        }
    } else if request.is_dangerous {
        if let Some(row_area) = row(5) {
            frame.render_widget(
                Paragraph::new("This operation can modify or remove data.")
                    .style(style::error().bg(BG_PANEL())),
                row_area,
            );
        }
    }

    let actions_y = inner.y + actions_dy;

    let mut hitboxes = Vec::new();
    if action_rows == 1 {
        frame.render_widget(
            Paragraph::new(action_line(true)).style(style::panel()),
            Rect::new(inner.x, actions_y, inner.width, 1),
        );
        hitboxes.push((
            agente_core::types::ApprovalAction::ApproveOnce,
            Rect::new(inner.x, actions_y, 17, 1),
        ));
        hitboxes.push((
            agente_core::types::ApprovalAction::ApproveAll,
            Rect::new(inner.x + 17, actions_y, 21, 1),
        ));
        hitboxes.push((
            agente_core::types::ApprovalAction::Deny,
            Rect::new(inner.x + 38, actions_y, 8, 1),
        ));
        hitboxes.push((
            agente_core::types::ApprovalAction::Deny,
            Rect::new(inner.x + 46, actions_y, 13, 1),
        ));
    } else {
        frame.render_widget(
            Paragraph::new(action_line(false)).style(style::panel()),
            Rect::new(inner.x, actions_y, inner.width, 1),
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("Esc", style::dim().bg(BG_PANEL())),
                Span::styled(" cancel", style::muted().bg(BG_PANEL())),
            ]))
            .style(style::panel()),
            Rect::new(inner.x, actions_y.saturating_add(1), inner.width, 1),
        );
        hitboxes.push((
            agente_core::types::ApprovalAction::ApproveOnce,
            Rect::new(inner.x, actions_y, 17, 1),
        ));
        hitboxes.push((
            agente_core::types::ApprovalAction::ApproveAll,
            Rect::new(inner.x + 17, actions_y, 21, 1),
        ));
        hitboxes.push((
            agente_core::types::ApprovalAction::Deny,
            Rect::new(inner.x + 38, actions_y, 8, 1),
        ));
        hitboxes.push((
            agente_core::types::ApprovalAction::Deny,
            Rect::new(inner.x, actions_y.saturating_add(1), 13, 1),
        ));
    }
    state.ui.approval_hitboxes = hitboxes;
}

fn action_line(include_escape: bool) -> Line<'static> {
    let mut spans = vec![
        Span::styled(" Y ", style::button_primary()),
        Span::styled(" allow once   ", style::text().bg(BG_PANEL())),
        Span::styled(" A ", style::button_secondary()),
        Span::styled(" allow for turn   ", style::text().bg(BG_PANEL())),
        Span::styled(" N ", style::button_danger()),
        Span::styled(" deny", style::text().bg(BG_PANEL())),
    ];
    if include_escape {
        spans.push(Span::styled("   Esc", style::dim().bg(BG_PANEL())));
        spans.push(Span::styled(" cancel", style::muted().bg(BG_PANEL())));
    }
    Line::from(spans)
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
