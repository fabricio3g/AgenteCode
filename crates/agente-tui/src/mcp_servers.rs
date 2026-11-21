//! `/mcp`: every MCP server, its live status, and the few actions it needs.
//!
//! Rows show the server name with its status on the right (`● 12 tools`,
//! `connecting…`, `failed`, `off`, `needs approval`); under the list, the
//! selected server's command/URL and, when it failed, why. Enter does the
//! obvious thing for the row (approve / enable / reconnect), `d` turns a
//! server off. Statuses change in the background, so the dialog repaints
//! while open.

use agente_core::mcp::{ServerSnapshot, ServerSource, ServerStatus};
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style;
use crate::widgets::pick::{pick_list, row_label, PickItem};
use crate::widgets::{
    centered_panel, footer_hints, modal_card, modal_footer, panel_row, s, truncate_cells,
};

const MAX_ROWS: usize = 10;
/// Detail lines under the list: target + status detail.
const DETAIL_ROWS: u16 = 2;

/// What Enter does for a server in this state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpAction {
    Approve,
    Enable,
    Reconnect,
}

pub fn primary_action(server: &ServerSnapshot) -> McpAction {
    match server.status {
        ServerStatus::NeedsApproval => McpAction::Approve,
        ServerStatus::Disabled => McpAction::Enable,
        _ => McpAction::Reconnect,
    }
}

fn status_trail(server: &ServerSnapshot) -> (String, Style) {
    match &server.status {
        ServerStatus::Ready => (
            match server.tools {
                1 => "● 1 tool".to_string(),
                n => format!("● {n} tools"),
            },
            style::dim(),
        ),
        ServerStatus::Connecting => ("connecting…".to_string(), style::dim()),
        ServerStatus::Failed(_) => ("failed".to_string(), style::error()),
        ServerStatus::Disabled => ("off".to_string(), style::dim()),
        ServerStatus::NeedsApproval => ("needs approval".to_string(), style::warning()),
    }
}

/// Second detail line: why it failed, or what approving means.
fn status_detail(server: &ServerSnapshot) -> Option<(String, Style)> {
    match &server.status {
        ServerStatus::Failed(reason) => {
            let mut text = reason.clone();
            if let Some(line) = &server.last_stderr {
                text = format!("{text} · {line}");
            }
            Some((text, style::error()))
        }
        _ => None,
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_mcp || area.width < 16 || area.height < 9 {
        return;
    }
    let servers = state.config.mcp_manager.snapshots();
    let rows = servers.len().clamp(1, MAX_ROWS) as u16;
    let panel = centered_panel(
        area,
        area.width.saturating_sub(4).min(76),
        rows + DETAIL_ROWS + 6,
    );
    let ready = servers
        .iter()
        .filter(|s| s.status == ServerStatus::Ready)
        .count();
    let body = modal_card(
        frame,
        panel,
        vec![
            s("MCP servers", style::bold()),
            s(
                if servers.is_empty() {
                    String::new()
                } else {
                    format!(" · {ready} of {} connected", servers.len())
                },
                style::dim(),
            ),
        ],
    );
    let text_w = body.width.saturating_sub(2) as usize;

    if servers.is_empty() {
        let lines = [
            s("No MCP servers configured.", style::muted()),
            s(
                "Add one under \"mcp\" in agente.json, or in the project's .mcp.json",
                style::dim(),
            ),
        ];
        for (dy, line) in (1u16..).zip(lines) {
            if let Some(row) = panel_row(body, dy, 1) {
                frame.render_widget(Paragraph::new(Line::from(line)), row);
            }
        }
    } else if let Some(top) = panel_row(body, 1, 1) {
        let selected = state.input.mcp_selected.min(servers.len() - 1);
        // Reserve top gap (1), gap after list (1), detail rows, gap (1),
        // and modal_footer (1) so short terminals never let the list paint
        // over the detail lines or footer.
        let list_h = rows
            .min(body.height.saturating_sub(4 + DETAIL_ROWS).max(1))
            .min(body.height.saturating_sub(2));
        let list_area = Rect {
            height: list_h,
            ..top
        };
        let items = servers
            .iter()
            .enumerate()
            .map(|(i, server)| {
                let (trail, trail_style) = status_trail(server);
                let mut label = vec![s(server.name.clone(), row_label(i == selected))];
                if server.source == ServerSource::ProjectFile {
                    label.push(s("  .mcp.json", style::dim()));
                }
                PickItem::row_with_trail(label, vec![s(trail, trail_style)])
            })
            .collect();
        pick_list(
            frame,
            list_area,
            &state.ui.hits,
            ListId::Mcp,
            items,
            selected,
        );

        let server = &servers[selected];
        let kind = if server.remote { "http" } else { "stdio" };
        let mut details = vec![(format!("{kind} · {}", server.target), style::dim())];
        if let Some(detail) = status_detail(server) {
            details.push(detail);
        }
        let footer_dy = body.height.saturating_sub(1);
        for (i, (text, text_style)) in details.into_iter().enumerate() {
            let dy = list_area.height + 2 + i as u16;
            if dy >= footer_dy {
                break;
            }
            if let Some(row) = panel_row(body, dy, 1) {
                frame.render_widget(
                    Paragraph::new(Line::from(s(truncate_cells(&text, text_w), text_style))),
                    row,
                );
            }
        }
    }

    let enter = servers
        .get(
            state
                .input
                .mcp_selected
                .min(servers.len().saturating_sub(1)),
        )
        .map_or("close", |server| match primary_action(server) {
            McpAction::Approve => "approve",
            McpAction::Enable => "enable",
            McpAction::Reconnect => "reconnect",
        });
    let hints: Vec<(&str, &str)> = if servers.is_empty() {
        vec![("Esc", "close")]
    } else {
        vec![
            ("↑↓", "move"),
            ("Enter", enter),
            ("d", "turn off"),
            ("Esc", "close"),
        ]
    };
    modal_footer(
        frame,
        body,
        footer_hints(&hints, body.width.saturating_sub(2)),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(status: ServerStatus) -> ServerSnapshot {
        ServerSnapshot {
            name: "docs".into(),
            source: ServerSource::Config,
            target: "npx -y docs-server".into(),
            remote: false,
            status,
            tools: 3,
            last_stderr: Some("ENOENT npx".into()),
        }
    }

    #[test]
    fn enter_does_what_the_row_needs() {
        assert_eq!(
            primary_action(&snapshot(ServerStatus::NeedsApproval)),
            McpAction::Approve
        );
        assert_eq!(
            primary_action(&snapshot(ServerStatus::Disabled)),
            McpAction::Enable
        );
        assert_eq!(
            primary_action(&snapshot(ServerStatus::Failed("x".into()))),
            McpAction::Reconnect
        );
        assert_eq!(
            primary_action(&snapshot(ServerStatus::Ready)),
            McpAction::Reconnect
        );
    }

    #[test]
    fn statuses_read_at_a_glance() {
        assert_eq!(status_trail(&snapshot(ServerStatus::Ready)).0, "● 3 tools");
        let failed = status_detail(&snapshot(ServerStatus::Failed("exit 1".into()))).unwrap();
        assert_eq!(
            failed.0, "exit 1 · ENOENT npx",
            "the stderr tail explains it"
        );
    }

    #[test]
    fn short_terminal_keeps_footer_visible_without_list_overlap() {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;

        let mut cfg = agente_core::config::AppConfig::default();
        for i in 0..8 {
            cfg.mcp.insert(
                format!("srv-{i}"),
                agente_core::mcp::McpConfig {
                    command: vec!["echo".into(), format!("{i}")],
                    enabled: false,
                    ..Default::default()
                },
            );
        }
        let mut state = AppState::new(cfg, "/tmp/mcp-short".into());
        state.input.show_mcp = true;
        let mut terminal = Terminal::new(TestBackend::new(60, 10)).unwrap();
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(text.contains("srv-0"), "{text}");
        assert!(text.contains("stdio · echo"), "{text}");
        assert!(text.contains("Esc") && text.contains("close"), "{text}");
    }
}
