//! Live subagent detail modal — opened by clicking a subagent card.
//!
//! Subagents render as transcript cards; clicking the bubble
//! pops a focused modal showing what the child is doing right now
//! (status, nested tools, streaming text, final summary). v1 scope is
//! live view + kill; full transcript/resume stays in `/subagents` + core.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::AppState;
use crate::style::*;
use crate::widgets::{
    centered_panel, footer_hints, modal_card, modal_footer, panel_row, truncate_cells,
    SubagentStatusKind,
};

use super::markdown::{markdown_display_lines, wrap_line};

/// Render the focused subagent modal. No-op when no detail id is set.
pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    let Some(id) = state.ui.subagent_detail_id.clone() else {
        return;
    };
    if area.width < 16 || area.height < 6 {
        return;
    }

    let panel_width = area.width.saturating_sub(6).min(76).max(16.min(area.width));
    let panel_height = area
        .height
        .saturating_sub(4)
        .min(30)
        .max(6.min(area.height));
    let panel = centered_panel(area, panel_width, panel_height);

    let ui_opt = state.agent.subagents.get(&id);
    // Live map first; fallback to the persisted chat anchor so a reloaded
    // session still shows type/desc instead of "running" forever.
    let (sub_type, desc, status, model, tool_count, worktree) = match &ui_opt {
        Some(u) => (
            u.subagent_type.clone(),
            u.description.clone(),
            u.status.clone(),
            u.model.clone(),
            u.tool_rows.len(),
            registry_worktree(state, &id).or_else(|| u.worktree.clone()),
        ),
        None => {
            let anchored = state
                .session
                .chat_history
                .iter()
                .find(|e| e.subagent_id.as_deref() == Some(id.as_str()));
            match anchored {
                Some(e) => (
                    e.subagent_type
                        .clone()
                        .unwrap_or_else(|| "subagent".to_string()),
                    e.content.clone(),
                    "completed".to_string(),
                    String::new(),
                    0,
                    registry_worktree(state, &id),
                ),
                None => (
                    "subagent".to_string(),
                    id.clone(),
                    "unknown".to_string(),
                    String::new(),
                    0,
                    None,
                ),
            }
        }
    };
    let kind = SubagentStatusKind::from_status(&status);

    // Header: one marker + `[type]` + description + right-side meta.
    let mut meta_parts: Vec<String> = Vec::new();
    if !model.is_empty() {
        meta_parts.push(model.clone());
    }
    if let Some(u) = &ui_opt {
        if let Some(ms) = u.elapsed_ms() {
            meta_parts.push(if ms < 1000.0 {
                format!("{ms:.0}ms")
            } else {
                format!("{:.0}s", ms / 1000.0)
            });
        }
        if let Some(wt) = &u.worktree {
            meta_parts.push(format!("wt {}", wt.label()));
        }
    }
    if tool_count > 0 {
        meta_parts.push(format!("{tool_count} tools"));
    }
    let desc_budget = (panel_width as usize)
        .saturating_sub(18 + meta_parts.iter().map(String::len).sum::<usize>())
        .max(8);
    let mut title = vec![
        Span::styled(
            format!("{} ", kind.glyph()),
            Style::default().fg(kind.color()).bg(BG_PANEL()),
        ),
        Span::styled(
            format!("[{sub_type}] "),
            Style::default()
                .fg(SECONDARY())
                .bg(BG_PANEL())
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            truncate_cells(&desc, desc_budget),
            Style::default().fg(FG()).bg(BG_PANEL()),
        ),
    ];
    if !meta_parts.is_empty() {
        title.push(Span::styled(
            format!("  {}", meta_parts.join(" · ")),
            Style::default().fg(FG_DIM()).bg(BG_PANEL()),
        ));
    }

    let body = modal_card(frame, panel, title);

    // Collect body lines, then apply scroll windowing.
    let mut content: Vec<Line<'static>> = Vec::new();
    let inner_w = panel_width.saturating_sub(4) as usize;

    if let Some(u) = &ui_opt {
        // Worktree review pointer: branch + path (the `d` key opens the diff).
        if let Some(wt) = &worktree {
            content.push(Line::from(vec![
                Span::styled("  ", Style::default().bg(BG_PANEL())),
                Span::styled("wt ", Style::default().fg(META()).bg(BG_PANEL())),
                Span::styled(
                    wt.branch.clone(),
                    Style::default().fg(FG_MUTED()).bg(BG_PANEL()),
                ),
                Span::styled(
                    if wt.dirty { "  modified" } else { "  clean" },
                    Style::default()
                        .fg(if wt.dirty { WARNING() } else { FG_DIM() })
                        .bg(BG_PANEL()),
                ),
            ]));
            content.push(Line::from(vec![
                Span::styled("     ", Style::default().bg(BG_PANEL())),
                Span::styled(
                    truncate_cells(&wt.path, inner_w.saturating_sub(6)),
                    Style::default().fg(FG_DIM()).bg(BG_PANEL()),
                ),
            ]));
        }

        // Nested tool rows in the reference grammar: `◆ Run <verb> <subject>`,
        // failed rows carry the `┃` rail, results indent under `│`.
        if u.tool_rows.is_empty() {
            content.push(Line::from(vec![Span::styled(
                "  No tool calls yet — child is thinking…",
                Style::default().fg(FG_DIM()).bg(BG_PANEL()),
            )]));
        } else {
            for row in &u.tool_rows {
                let row_kind = if row.result.is_none() {
                    SubagentStatusKind::Running
                } else if row.is_error {
                    SubagentStatusKind::Failed
                } else {
                    SubagentStatusKind::Completed
                };
                let (verb, subject) =
                    super::chat::tool_header_parts(&row.name, Some(&row.args), inner_w);
                let action = match verb {
                    Some(verb) => format!("Run {verb}"),
                    None => "Run".to_string(),
                };
                let label = if subject.is_empty() {
                    action
                } else {
                    format!("{action} {subject}")
                };
                content.push(Line::from(vec![
                    Span::styled("  ", Style::default().bg(BG_PANEL())),
                    Span::styled(
                        format!("{} ", row_kind.glyph()),
                        Style::default().fg(row_kind.color()).bg(BG_PANEL()),
                    ),
                    Span::styled(
                        label,
                        Style::default()
                            .fg(FG())
                            .bg(BG_PANEL())
                            .add_modifier(Modifier::BOLD),
                    ),
                ]));
                // Full retained output is inspectable here, with tree indentation.
                if let Some(result) = &row.result {
                    for text in result.lines() {
                        for mut line in
                            wrap_line(&Line::from(text.to_string()), inner_w.saturating_sub(6))
                        {
                            line.spans.insert(
                                0,
                                Span::styled(
                                    "    │ ",
                                    Style::default().fg(FG_MUTED()).bg(BG_PANEL()),
                                ),
                            );
                            content.push(line);
                        }
                    }
                }
            }
        }

        // The modal exposes all retained child text, including its live tail.
        let stream = u.streaming_text.trim();
        if !stream.is_empty() {
            content.push(Line::from(vec![Span::styled(
                "  ∴ streaming",
                Style::default().fg(FG_DIM()).bg(BG_PANEL()),
            )]));
            for row in markdown_display_lines(stream, inner_w.saturating_sub(2)) {
                let mut spans = vec![Span::styled("  ", Style::default().bg(BG_PANEL()))];
                spans.extend(row.spans);
                content.push(Line::from(spans));
            }
        }

        // Final summary.
        if let Some(summary) = u.summary.as_deref() {
            if !summary.trim().is_empty() {
                content.push(Line::from(vec![Span::styled(
                    "  ◆ result",
                    Style::default().fg(FG_DIM()).bg(BG_PANEL()),
                )]));
                for row in markdown_display_lines(summary, inner_w.saturating_sub(2)) {
                    let mut spans = vec![Span::styled("  ", Style::default().bg(BG_PANEL()))];
                    spans.extend(row.spans);
                    content.push(Line::from(spans));
                }
            }
        }
    } else {
        content.push(Line::from(vec![Span::styled(
            "  No live state — showing persisted summary (if any).",
            Style::default().fg(FG_DIM()).bg(BG_PANEL()),
        )]));
        if let Some(entry) = state
            .session
            .chat_history
            .iter()
            .find(|e| e.subagent_id.as_deref() == Some(id.as_str()))
        {
            for row in markdown_display_lines(&entry.content, inner_w.saturating_sub(2)) {
                let mut spans = vec![Span::styled("  ", Style::default().bg(BG_PANEL()))];
                spans.extend(row.spans);
                content.push(Line::from(spans));
            }
        }
    }

    // Worktree diff review (`d` toggles it on).
    if let Some(diff) = &state.ui.subagent_diff {
        content.push(Line::from(vec![
            Span::styled("  ◆ diff", Style::default().fg(META()).bg(BG_PANEL())),
            Span::styled("  (d closes)", Style::default().fg(FG_DIM()).bg(BG_PANEL())),
        ]));
        match diff {
            Some(text) => {
                for line in text.lines() {
                    let style = if line.starts_with('+') {
                        Style::default().fg(DIFF_ADDED()).bg(BG_PANEL())
                    } else if line.starts_with('-') {
                        Style::default().fg(DIFF_REMOVED()).bg(BG_PANEL())
                    } else if line.starts_with("@@") {
                        Style::default().fg(SECONDARY()).bg(BG_PANEL())
                    } else {
                        Style::default().fg(FG_MUTED()).bg(BG_PANEL())
                    };
                    content.push(Line::from(vec![
                        Span::styled("  ", Style::default().bg(BG_PANEL())),
                        Span::styled(truncate_cells(line, inner_w.saturating_sub(2)), style),
                    ]));
                }
            }
            None => content.push(Line::from(vec![Span::styled(
                "  no changes in this worktree",
                Style::default().fg(FG_DIM()).bg(BG_PANEL()),
            )])),
        }
    }

    // Scroll window: title on the card border + footer(1) + gaps.
    let panel_bottom = body.y + body.height;
    let first_row_y = body.y + 1;
    let last_row_y = panel_bottom.saturating_sub(2);
    let visible = last_row_y.saturating_sub(first_row_y) as usize;
    state.ui.subagent_detail_area =
        Some(Rect::new(panel.x, first_row_y, panel.width, visible as u16));
    if visible == 0 {
        modal_footer(
            frame,
            body,
            footer_hints(&[("Esc", "close")], body.width.saturating_sub(2)),
        );
        return;
    }
    let max_scroll = content.len().saturating_sub(visible);
    let scroll = state.ui.subagent_detail_scroll.min(max_scroll);
    state.ui.subagent_detail_scroll = scroll;

    for (i, line) in content.iter().skip(scroll).take(visible).enumerate() {
        if let Some(row) = panel_row(body, 1 + i as u16, 1) {
            frame.render_widget(
                Paragraph::new(line.clone()).style(Style::default().bg(BG_PANEL())),
                row,
            );
        }
    }
    // Scroll position hint when clipped.
    if max_scroll > 0 {
        if let Some(hint_row) = panel_row(body, visible as u16, 1) {
            let _ = hint_row;
        }
    }

    let running = ui_opt.as_ref().map(|u| u.is_running()).unwrap_or(false);
    let diff_loaded = state.ui.subagent_diff.is_some();
    let mut hints: Vec<(&str, &str)> = vec![
        ("Esc", "close"),
        ("↑↓/wheel", "scroll"),
        ("d", if diff_loaded { "hide diff" } else { "diff" }),
    ];
    if running {
        hints.push(("k", "kill"));
    }
    modal_footer(
        frame,
        body,
        footer_hints(&hints, body.width.saturating_sub(2)),
    );
}

/// Live worktree record from the core registry (reflects the dirty flag that
/// the async release pass sets after the child finishes).
fn registry_worktree(state: &AppState, id: &str) -> Option<agente_core::subagent::WorktreeInfo> {
    state
        .subagent_registry
        .get(id)
        .and_then(|snap| snap.worktree.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::SubagentUiState;
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn state_with_subagent() -> AppState {
        let mut state = AppState::new(AppConfig::default(), "/tmp/subdetail-test".to_string());
        state.ui.show_welcome_screen = false;
        state.ui.subagent_detail_id = Some("sub-1".to_string());
        state.agent.subagents.insert(
            "sub-1".to_string(),
            SubagentUiState {
                id: "sub-1".to_string(),
                subagent_type: "explore".to_string(),
                description: "Explore checkout flow".to_string(),
                status: "running".to_string(),
                streaming_text: "Reading src/api/checkout.ts…".to_string(),
                tool_rows: vec![crate::state::SubagentToolRow {
                    call_id: "c1".to_string(),
                    name: "read_file".to_string(),
                    args: r#"{"path":"src/api/checkout.ts"}"#.to_string(),
                    result: None,
                    is_error: false,
                }],
                summary: None,
                generated_output_bytes: 0,
                preparing_tool: None,
                ..Default::default()
            },
        );
        state
    }

    #[test]
    fn detail_modal_shows_live_status_and_tool() {
        let mut state = state_with_subagent();
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), &mut state)).unwrap();
        let buf = terminal.backend().buffer().clone();
        let text: String = (0..24)
            .map(|y| {
                (0..80)
                    .map(|x| buf[(x, y)].symbol().to_string())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("explore"), "got:\n{text}");
        assert!(
            text.contains("read_file") || text.contains("Read"),
            "got:\n{text}"
        );
        assert!(text.contains("checkout"), "got:\n{text}");
        assert!(text.contains("Esc"), "footer hints: {text}");
    }

    #[test]
    fn detail_modal_unknown_id_falls_back_without_panic() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/subdetail-test".to_string());
        state.ui.show_welcome_screen = false;
        state.ui.subagent_detail_id = Some("missing".to_string());
        let backend = TestBackend::new(60, 18);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), &mut state)).unwrap();
    }

    #[test]
    fn detail_modal_can_scroll_past_the_old_text_cap() {
        let mut state = state_with_subagent();
        state
            .agent
            .subagents
            .get_mut("sub-1")
            .unwrap()
            .streaming_text = format!("{}\nLATEST CHILD UPDATE", "earlier text\n".repeat(500));
        state.ui.subagent_detail_scroll = usize::MAX;
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|f| render(f, f.area(), &mut state)).unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(text.contains("LATEST CHILD UPDATE"));
    }
}
