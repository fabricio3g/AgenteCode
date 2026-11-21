//! Focused, read-only child session: activity, explicit handoff, and result.
//! The main agent remains the only author of delegated instructions.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::action_bar::{build_action_spans, ActionChip};
use super::markdown::{markdown_display_lines, wrap_line};
use super::pick::RowState;
use crate::state::{AppState, HitTarget, SubagentDetailTab, SubagentUiState};
use crate::style::*;
use crate::widgets::{s, truncate_cells, ModalChrome, SubagentStatusKind};

/// Same card chrome as every modal: status + type on the border, the task,
/// tabs, the scrollable view, and the shared footer hints.
pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    state.ui.subagent_detail_area = None;
    let Some(id) = state.ui.subagent_detail_id.clone() else {
        return;
    };
    if area.width == 0 || area.height == 0 {
        return;
    }
    let want_w = area.width.saturating_sub(8).clamp(1, 96);
    let want_h = area.height.saturating_sub(4).clamp(1, 30);
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
    let model = snapshot
        .as_ref()
        .map(|s| s.model_label())
        .or_else(|| live.map(|s| s.model.clone()))
        .unwrap_or_default();
    let count = live.map(|s| s.tool_rows.len()).unwrap_or(0);
    let mut meta = format!(
        " · {} · {count} tool{}",
        kind.label(),
        if count == 1 { "" } else { "s" }
    );
    if !model.is_empty() {
        meta.push_str(&format!(" · {model}"));
    }
    if let Some(cost) = live.and_then(|s| s.spend.cost_label()) {
        meta.push_str(&format!(" · {cost}"));
    }
    let mut hints = vec![
        (
            "Esc",
            if state.input.show_subagents {
                "back"
            } else {
                "close"
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
    let modal = ModalChrome::new(vec![
        s(kind.glyph(), Style::default().fg(kind.color())),
        s(format!(" {sub_type}"), bold()),
        s(meta, dim()),
    ])
    .tinted(kind.border_color())
    .footer(&hints)
    .render_centered(frame, area, want_w, want_h);

    let width = modal.body.width as usize;
    let paint_row = |frame: &mut Frame, dy, line: Line<'static>| {
        if let Some(row) = modal.row(dy) {
            frame.render_widget(
                Paragraph::new(line).style(Style::default().bg(BG_PANEL())),
                row,
            );
        }
    };
    paint_row(
        frame,
        0,
        Line::from(s(truncate_cells(description, width), text())),
    );
    if modal.inner.height < 8 {
        return;
    }

    // Tabs are real buttons via action_bar: click selects, hover lifts, keys still work.
    let diff_open = state.ui.subagent_diff.is_some();
    let tabs = [
        (SubagentDetailTab::Activity, "1 Activity"),
        (SubagentDetailTab::Handoff, "2 Handoff"),
        (SubagentDetailTab::Result, "3 Result"),
    ];
    let tab_chips: Vec<ActionChip> = tabs
        .into_iter()
        .map(|(tab, label)| {
            let selected = tab == state.ui.subagent_detail_tab && !diff_open;
            let target = HitTarget::DetailTab(tab);
            let hovered = state.ui.hovered_hit.as_ref() == Some(&target);
            let row = RowState::from_flags(selected, hovered);
            let chip_style = match row {
                RowState::Selected => bold().bg(row.bg()),
                RowState::Hovered => text().bg(row.bg()),
                RowState::Idle => muted(),
            };
            ActionChip::chip(format!(" {label} "), chip_style, target)
        })
        .collect();
    let mut tab_spans = modal
        .row(2)
        .map(|row| build_action_spans(row, &tab_chips, 0, panel(), &state.ui.hits))
        .unwrap_or_default();
    if diff_open {
        tab_spans.push(s(" d Diff ", bold().bg(RowState::Selected.bg())));
    }

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
                let mut lines = Vec::new();
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
    // Body rows: task (0), gap (1), tabs (2), gap (3), content (4..).
    let content_area = modal.slice_from(4).unwrap_or_default();
    let visible = content_area.height as usize;
    let scroll = state.ui.subagent_detail_scroll.sync(content.len(), visible);
    let viewport = state.ui.subagent_detail_scroll.viewport();
    state.ui.subagent_detail_area = Some(content_area);
    for (i, line) in content.into_iter().skip(scroll).take(visible).enumerate() {
        paint_row(frame, 4 + i as u16, line);
    }
    // Scrollbar in the card's right padding column, beside the content.
    super::scrollbar::render(
        frame,
        Rect::new(
            modal.inner.right().saturating_sub(1),
            content_area.y,
            1,
            content_area.height,
        ),
        super::scrollbar::ScrollSurface::SubagentDetail,
        viewport,
        BG_PANEL(),
        &state.ui,
    );

    // Tabs on the left, scroll position (only when it scrolls) on the right.
    let position = if state.ui.subagent_detail_scroll.follow {
        "following".to_string()
    } else {
        state
            .ui
            .subagent_detail_scroll
            .position_label()
            .unwrap_or_default()
    };
    paint_row(
        frame,
        2,
        Line::from(super::justify(
            tab_spans,
            vec![s(position, dim())],
            width,
            BG_PANEL(),
        )),
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
        // `✓ List crates/core/src` — glyph carries the status, the verb
        // reads as the action, the subject stays quiet. One row per call.
        let (verb, subject) =
            super::chat::tool_header_parts(&row.name, Some(&row.args), width.saturating_sub(3));
        let verb = verb.unwrap_or_else(|| row.name.clone());
        let verb_style = if row_kind == SubagentStatusKind::Failed {
            Style::default().fg(ERROR())
        } else {
            text()
        };
        let budget = width.saturating_sub(3 + super::display_width(&verb));
        lines.push(Line::from(vec![
            s(row_kind.glyph(), Style::default().fg(row_kind.color())),
            s(" ", Style::default()),
            s(verb, verb_style),
            s(format!(" {}", truncate_cells(&subject, budget)), muted()),
        ]));
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
    fn detail_shows_title_activity_and_navigation() {
        let text = draw(&mut state_with_subagent(), 80, 24);
        for expected in [
            "explore",
            "Read",
            "checkout",
            "Handoff",
            "Result",
            "Esc close",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
    }

    #[test]
    fn tabs_are_hit_targets() {
        let mut state = state_with_subagent();
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|f| render(f, f.area(), &mut state)).unwrap();
        let buf = terminal.backend().buffer();
        let (x, y) = (0..24)
            .find_map(|y| {
                let row: String = (0..80).map(|x| buf[(x, y)].symbol()).collect();
                row.find("2 Handoff")
                    .map(|byte| (row[..byte].chars().count() as u16 + 2, y))
            })
            .expect("tab row painted");
        assert_eq!(
            state.ui.hits.at(x, y),
            Some(HitTarget::DetailTab(SubagentDetailTab::Handoff))
        );
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
        state.ui.subagent_detail_scroll.follow = true;
        assert!(draw(&mut state, 80, 24).contains("LATEST CHILD UPDATE"));
        state.ui.scroll_subagent_detail(-8);
        let offset = state.ui.subagent_detail_scroll.offset;
        state
            .agent
            .subagents
            .get_mut("sub-1")
            .unwrap()
            .streaming_text
            .push_str("\nnew tail");
        draw(&mut state, 80, 24);
        assert_eq!(state.ui.subagent_detail_scroll.offset, offset);
        assert!(!state.ui.subagent_detail_scroll.follow);
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
