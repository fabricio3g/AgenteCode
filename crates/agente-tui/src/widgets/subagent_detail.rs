//! Focused, read-only child session: activity, explicit handoff, and result.
//! The main agent remains the only author of delegated instructions.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::markdown::{markdown_display_lines, wrap_line};
use crate::state::{AppState, SubagentDetailTab, SubagentUiState};
use crate::style::*;
use crate::widgets::{
    centered_panel, footer_hints, modal_footer, panel_bg, panel_row, s, truncate_cells,
    SubagentStatusKind,
};

/// No borders or separate composer: inspect the handoff and return to main.
pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    state.ui.subagent_detail_area = None;
    let Some(id) = state.ui.subagent_detail_id.clone() else {
        return;
    };
    if area.width == 0 || area.height == 0 {
        return;
    }
    let panel = centered_panel(
        area,
        area.width.saturating_sub(4).clamp(1, 104),
        area.height.saturating_sub(6).clamp(1, 28),
    );
    panel_bg(frame, panel);
    let snapshot = state.subagent_registry.get(&id);
    let live = state.agent.subagents.get(&id);
    let anchor = state
        .session
        .chat_history
        .iter()
        .find(|entry| entry.subagent_id.as_deref() == Some(&id));
    let sub_type = snapshot
        .as_ref()
        .map(|s| s.subagent_type.as_str())
        .or_else(|| live.map(|s| s.subagent_type.as_str()))
        .or_else(|| anchor.and_then(|e| e.subagent_type.as_deref()))
        .unwrap_or("subagent");
    let description = snapshot
        .as_ref()
        .map(|s| s.description.as_str())
        .or_else(|| live.map(|s| s.description.as_str()))
        .unwrap_or("Saved child session");
    let kind = snapshot
        .as_ref()
        .map(|s| SubagentStatusKind::from_core(s.status))
        .or_else(|| live.map(SubagentUiState::status_kind))
        .unwrap_or(if anchor.is_some_and(|e| e.is_error) {
            SubagentStatusKind::Failed
        } else {
            SubagentStatusKind::Completed
        });
    let width = panel.width.saturating_sub(2) as usize;
    let paint_row = |frame: &mut Frame, y, line: Line<'static>| {
        if let Some(row) = panel_row(panel, y, 1) {
            frame.render_widget(
                Paragraph::new(line).style(Style::default().bg(BG_PANEL())),
                row,
            );
        }
    };
    paint_row(
        frame,
        0,
        Line::from(vec![
            s("‹ main", muted()),
            s(" / ", dim()),
            s(sub_type.to_string(), bold()),
        ]),
    );
    if panel.height < 8 {
        return;
    }
    paint_row(
        frame,
        1,
        Line::from(s(truncate_cells(description, width), bold())),
    );
    let model = snapshot
        .as_ref()
        .map(|s| s.model.as_str())
        .or_else(|| live.map(|s| s.model.as_str()))
        .unwrap_or("");
    let count = live.map(|s| s.tool_rows.len()).unwrap_or(0);
    let mut meta = format!("{} {} · {count} tools", kind.glyph(), kind.label());
    if !model.is_empty() {
        meta.push_str(&format!(" · {model}"));
    }
    paint_row(
        frame,
        2,
        Line::from(s(truncate_cells(&meta, width), muted())),
    );

    let diff_open = state.ui.subagent_diff.is_some();
    let tabs = [
        (SubagentDetailTab::Activity, "1 Activity"),
        (SubagentDetailTab::Handoff, "2 Handoff"),
        (SubagentDetailTab::Result, "3 Result"),
    ];
    let mut tab_spans = Vec::new();
    for (tab, label) in tabs {
        let selected = tab == state.ui.subagent_detail_tab && !diff_open;
        tab_spans.push(s(
            format!(" {label} "),
            if selected {
                bold().bg(BG_ELEMENT()).add_modifier(Modifier::UNDERLINED)
            } else {
                muted()
            },
        ));
    }
    if diff_open {
        tab_spans.push(s(
            " d Diff ",
            bold().bg(BG_ELEMENT()).add_modifier(Modifier::UNDERLINED),
        ));
    }
    paint_row(frame, 4, Line::from(tab_spans));

    let content = if let Some(diff) = &state.ui.subagent_diff {
        match diff {
            Some(text) => text
                .lines()
                .flat_map(|line| {
                    let color = if line.starts_with('+') {
                        DIFF_ADDED()
                    } else if line.starts_with('-') {
                        DIFF_REMOVED()
                    } else {
                        FG_MUTED()
                    };
                    wrap_line(
                        &Line::from(s(line.to_string(), Style::default().fg(color))),
                        width,
                    )
                })
                .collect(),
            None => prose("No worktree diff available.", width),
        }
    } else {
        match state.ui.subagent_detail_tab {
            SubagentDetailTab::Handoff => {
                let mut lines = prose("Main → child · explicit instructions only", width);
                lines.push(Line::default());
                if let Some(prompt) = snapshot
                    .as_ref()
                    .map(|s| s.prompt.as_str())
                    .filter(|s| !s.is_empty())
                {
                    // Render literally: this is the actual handoff, not a generated summary.
                    for line in prompt.lines() {
                        lines.extend(wrap_line(&Line::from(line.to_string()), width.max(1)));
                    }
                } else {
                    lines.extend(prose("Handoff unavailable for this saved session.", width));
                }
                lines
            }
            SubagentDetailTab::Activity => {
                activity_lines(live, kind, width, state.ui.subagent_detail_show_output)
            }
            SubagentDetailTab::Result => {
                let summary = snapshot
                    .as_ref()
                    .and_then(|s| s.summary.as_deref())
                    .or_else(|| live.and_then(|s| s.summary.as_deref()))
                    .or_else(|| anchor.map(|e| e.content.as_str()));
                if kind.is_live() {
                    prose("Working on the main agent's handoff. The result will appear here when this task finishes.", width)
                } else {
                    prose(
                        summary
                            .filter(|s| !s.trim().is_empty())
                            .unwrap_or("No result was retained for this child session."),
                        width,
                    )
                }
            }
        }
    };
    let visible = panel.height.saturating_sub(8) as usize;
    let max_scroll = content.len().saturating_sub(visible);
    state.ui.subagent_detail_max_scroll = max_scroll;
    let scroll = if state.ui.subagent_detail_follow {
        max_scroll
    } else {
        state.ui.subagent_detail_scroll.min(max_scroll)
    };
    state.ui.subagent_detail_scroll = scroll;
    state.ui.subagent_detail_area = Some(Rect::new(
        panel.x + 1,
        panel.y + 6,
        width as u16,
        visible as u16,
    ));
    for (i, line) in content.into_iter().skip(scroll).take(visible).enumerate() {
        paint_row(frame, 6 + i as u16, line);
    }
    let position = if state.ui.subagent_detail_follow {
        "following · Home to read from top".to_string()
    } else if max_scroll > 0 {
        format!(
            "{}–{} / {} · End to follow",
            scroll + 1,
            (scroll + visible).min(max_scroll + visible),
            max_scroll + visible
        )
    } else {
        "Main supplies context · child reports back".to_string()
    };
    paint_row(
        frame,
        panel.height - 2,
        Line::from(s(truncate_cells(&position, width), dim())),
    );
    let mut hints = vec![
        (
            "Esc",
            if state.input.show_subagents {
                "back"
            } else {
                "main"
            },
        ),
        ("Tab/1–3", "view"),
        ("↑↓", "scroll"),
        ("o", "output"),
        ("d", "diff"),
    ];
    if kind.is_live() {
        hints.push(("Del", "stop"));
    }
    modal_footer(
        frame,
        panel,
        footer_hints(&hints, panel.width.saturating_sub(2)),
    );
}

fn prose(text: &str, width: usize) -> Vec<Line<'static>> {
    markdown_display_lines(text, width.max(1))
}

fn activity_lines(
    live: Option<&SubagentUiState>,
    kind: SubagentStatusKind,
    width: usize,
    show_output: bool,
) -> Vec<Line<'static>> {
    let Some(live) = live else {
        return prose(
            "No live activity retained. Open Result for the saved report.",
            width,
        );
    };
    let mut lines = Vec::new();
    for row in &live.tool_rows {
        let row_kind = if !row.finished {
            SubagentStatusKind::Running
        } else if row.is_error {
            SubagentStatusKind::Failed
        } else {
            SubagentStatusKind::Completed
        };
        let (verb, subject) =
            super::chat::tool_header_parts(&row.name, Some(&row.args), width.saturating_sub(3));
        let label = format!(
            "{} Run {} {}",
            row_kind.glyph(),
            verb.as_deref().unwrap_or(""),
            subject
        );
        lines.extend(wrap_line(
            &Line::from(s(
                label.trim_end().to_string(),
                Style::default().fg(row_kind.color()),
            )),
            width.max(1),
        ));
        if show_output {
            if let Some(output) = &row.result {
                for text in output.lines() {
                    lines.extend(wrap_line(
                        &Line::from(s(format!("  {text}"), muted())),
                        width.max(1),
                    ));
                }
            }
        }
    }
    if kind.is_live() {
        if let Some(tool) = &live.preparing_tool {
            lines.extend(prose(&format!("∴ Preparing {tool}…"), width));
        }
        if !live.streaming_text.trim().is_empty() {
            lines.push(Line::default());
            lines.extend(prose(&live.streaming_text, width));
        } else if lines.is_empty() {
            lines.extend(prose(
                if kind == SubagentStatusKind::Queued {
                    "⋯ Queued · waiting for a slot"
                } else {
                    "∴ Working on the handoff…"
                },
                width,
            ));
        }
    } else {
        lines.push(Line::default());
        lines.extend(prose("Task finished · open Result for the report.", width));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::SubagentToolRow;
    use agente_core::config::AppConfig;
    use ratatui::{backend::TestBackend, Terminal};

    fn state_with_subagent() -> AppState {
        let mut state = AppState::new(AppConfig::default(), "/tmp/subdetail-test".into());
        state.ui.show_welcome_screen = false;
        state.ui.open_subagent_detail("sub-1".into());
        state.agent.subagents.insert(
            "sub-1".into(),
            SubagentUiState {
                id: "sub-1".into(),
                subagent_type: "explore".into(),
                description: "Explore checkout flow".into(),
                status: "running".into(),
                streaming_text: "Reading src/api/checkout.ts…".into(),
                tool_rows: vec![SubagentToolRow {
                    call_id: "c1".into(),
                    name: "read_file".into(),
                    args: r#"{"path":"src/api/checkout.ts"}"#.into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        );
        state
    }

    fn draw(state: &mut AppState, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| render(f, f.area(), state)).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn detail_shows_breadcrumb_activity_and_navigation() {
        let text = draw(&mut state_with_subagent(), 80, 24);
        for expected in [
            "‹ main", "explore", "Read", "checkout", "Handoff", "Result", "Esc",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
    }

    #[test]
    fn detail_survives_small_and_unknown_sessions() {
        for (w, h) in [(1, 1), (8, 4), (20, 8), (60, 18)] {
            let mut state = state_with_subagent();
            state.ui.open_subagent_detail("missing".into());
            draw(&mut state, w, h);
        }
    }

    #[test]
    fn follow_reaches_latest_text_and_manual_scroll_stays_put() {
        let mut state = state_with_subagent();
        state
            .agent
            .subagents
            .get_mut("sub-1")
            .unwrap()
            .streaming_text = format!("{}\nLATEST CHILD UPDATE", "earlier text\n".repeat(500));
        state.ui.subagent_detail_follow = true;
        assert!(draw(&mut state, 80, 24).contains("LATEST CHILD UPDATE"));
        state.ui.scroll_subagent_detail(-8);
        let offset = state.ui.subagent_detail_scroll;
        state
            .agent
            .subagents
            .get_mut("sub-1")
            .unwrap()
            .streaming_text
            .push_str("\nnew tail");
        draw(&mut state, 80, 24);
        assert_eq!(state.ui.subagent_detail_scroll, offset);
        assert!(!state.ui.subagent_detail_follow);
    }

    #[test]
    fn tool_output_is_disclosed_only_on_request() {
        let mut state = state_with_subagent();
        let row = &mut state.agent.subagents.get_mut("sub-1").unwrap().tool_rows[0];
        row.result = Some("TOOL OUTPUT PAYLOAD".into());
        assert!(!draw(&mut state, 80, 24).contains("TOOL OUTPUT PAYLOAD"));
        state.ui.subagent_detail_show_output = true;
        assert!(draw(&mut state, 80, 24).contains("TOOL OUTPUT PAYLOAD"));
    }
}
