//! Chat widget - transcript with user bubbles and scrollbar
//! - User messages: full-width gray background card with colored mode bar
//! - Assistant messages: content + footer line
//! - Proper scrollbar on the right edge
//! - Icons instead of text labels
//! - Collapsed thinking by default; hover borders; expand long pastes

mod blocks;
mod overlay;
mod snapshot;
mod streaming;
#[cfg(test)]
mod tests;

pub(crate) use blocks::tool_header_parts;
pub use overlay::render_toast;
pub(crate) use snapshot::derive_tool_groups;

use std::sync::Arc;

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use agente_core::types::{ClickKind, ClickRegion};

use crate::state::{AppState, ChatFrameSnapshot, RenderedChatBlock};
use crate::style::*;
use crate::widgets::{s, sf, sp, themed_blank_row};

use blocks::{push_wrapped, render_thinking_block};
use overlay::{
    apply_selection_style, paint_hover_tint, paint_message_fade, render_jump_to_bottom,
    render_scrollbar,
};
use snapshot::{
    render_history_range, skipped_entries, subagent_fingerprint, HistoryFrame, HistoryRenderCtx,
    HistorySink,
};
use streaming::{live_tool_entry_id, render_live_tool, render_streaming};

/// Max body lines shown for long user messages when collapsed.
pub(crate) const USER_PREVIEW_LINES: usize = 8;
/// Sentinel entry id for the live (in-progress) thinking panel.
const LIVE_THINKING_ID: uuid::Uuid = uuid::Uuid::nil();

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    if area.width < 2 || area.height == 0 {
        state.ui.chat_content_height = 0;
        state.ui.chat_visible_height = area.height as usize;
        state.ui.chat_plain_lines.clear();
        state.ui.chat_frame_snapshot = None;
        state.ui.update_click_regions(Vec::new());
        return;
    }

    // Split chat area from scrollbar
    let [chat_area, scroll_area] =
        Layout::horizontal([Constraint::Min(1), Constraint::Length(1)]).areas(area);

    state.ui.chat_area_x = chat_area.x;
    state.ui.chat_area_y = chat_area.y;

    let chat_width = chat_area.width as usize;
    let visible_height = chat_area.height as usize;

    // ── Frame snapshot ────────────────────────────────────────────────────
    // The rendered history is cached at frame level: when only the streaming
    // section changed (text deltas, live tool cards, thinking), the previous
    // flat plain lines, blocks and click regions are reused as-is. History
    // growth reuses the cached prefix and renders only the new entries.
    let expand_fingerprint = state.ui.chat_expand_fingerprint();
    let live_tools_epoch = state.agent.live_tools_epoch;
    let subagent_fp = subagent_fingerprint(&state.agent.subagents, chat_width);
    let history_len = state.session.chat_history.len();
    let last_entry_id = state
        .session
        .chat_history
        .last()
        .map_or(uuid::Uuid::nil(), |e| e.id);

    // History render inputs are derived once: which entries are invisible
    // (pending-call stubs / live tools) and which runs of consecutive
    // collapsed tool cards fold into one group header. Both must be computed
    // over the *whole* history so an appended entry can extend a run that
    // started earlier.
    let history_ctx = HistoryRenderCtx {
        live_tools: &state.agent.live_tool_calls,
        subagents: &state.agent.subagents,
    };
    let reuse_history = state.ui.chat_frame_snapshot.as_ref().is_some_and(|s| {
        s.matches(
            chat_width,
            expand_fingerprint,
            live_tools_epoch,
            subagent_fp,
        ) && s.history_len == history_len
            && s.last_entry_id == last_entry_id
    });
    let skipped = if reuse_history {
        Vec::new()
    } else {
        skipped_entries(&state.session.chat_history, &history_ctx)
    };
    let groups = if reuse_history {
        Vec::new()
    } else {
        derive_tool_groups(
            &state.session.chat_history,
            &skipped,
            &|id| state.ui.tool_fold_of(id),
            &state.ui.expanded_groups,
        )
    };

    enum HistoryPlan {
        /// Inputs unchanged: reuse the snapshot's blocks / regions / plain lines.
        Reuse(ChatFrameSnapshot),
        /// Append-only growth: drop the previously-final entry's contribution
        /// (its completed-tool-call skip state may have flipped now that a
        /// result followed it) and render from that entry on.
        Extend(ChatFrameSnapshot, usize),
        /// Rebuild everything.
        Rebuild,
    }
    let plan = match state.ui.chat_frame_snapshot.take() {
        None => HistoryPlan::Rebuild,
        Some(s)
            if !s.matches(
                chat_width,
                expand_fingerprint,
                live_tools_epoch,
                subagent_fp,
            ) =>
        {
            HistoryPlan::Rebuild
        }
        Some(s) => {
            if history_len == s.history_len {
                if s.last_entry_id == last_entry_id {
                    HistoryPlan::Reuse(s)
                } else {
                    // Same length, different tail: history was rewritten.
                    HistoryPlan::Rebuild
                }
            } else if history_len > s.history_len {
                // Re-render from the previously-final entry: its completed-
                // tool-call skip state may have flipped now that a result
                // followed it. A tool run that spans the boundary re-derives
                // as a whole: rewind to the run start so the group header can
                // replace its members.
                let from_entry = s.history_len.saturating_sub(1);
                let from_entry = groups
                    .iter()
                    .filter(|(_, _, info)| {
                        info.members
                            .first()
                            .is_some_and(|&first| first < from_entry)
                            && info.members.last().is_some_and(|&last| last >= from_entry)
                    })
                    .filter_map(|(_, _, info)| info.members.first().copied())
                    .min()
                    .unwrap_or(from_entry);
                HistoryPlan::Extend(s, from_entry)
            } else {
                HistoryPlan::Rebuild
            }
        }
    };

    let mut history_blocks: Vec<(usize, usize, Arc<RenderedChatBlock>)> = Vec::new();
    let mut history_height = 0usize;
    let mut content_regions: Vec<(ClickRegion, usize, usize)> = Vec::new();
    let mut lines: Vec<Line<'static>> = Vec::new();

    match plan {
        HistoryPlan::Reuse(s) => {
            history_height = s.history_line_count;
            history_blocks = s.blocks;
            content_regions = s.regions;
            // Drop the previous frame's streaming rows; history rows stay.
            state.ui.chat_plain_lines.truncate(s.history_plain_len);
        }
        HistoryPlan::Extend(s, from_entry) => {
            let drop_from = s
                .blocks
                .iter()
                .find(|(entry_index, _, _)| *entry_index >= from_entry)
                .map_or(s.history_line_count, |&(_, start, _)| start);
            history_height = drop_from;
            history_blocks = s
                .blocks
                .into_iter()
                .filter(|(entry_index, _, _)| *entry_index < from_entry)
                .collect();
            content_regions = s
                .regions
                .into_iter()
                .filter(|(_, _, end)| *end <= drop_from)
                .collect();
            state.ui.chat_plain_lines.truncate(drop_from);
            render_history_range(
                &state.session.chat_history,
                from_entry,
                chat_width,
                HistoryFrame {
                    ctx: &history_ctx,
                    skipped: &skipped,
                    groups: &groups,
                },
                &mut state.ui,
                HistorySink {
                    blocks: &mut history_blocks,
                    regions: &mut content_regions,
                    height: &mut history_height,
                },
            );
        }
        HistoryPlan::Rebuild => {
            state.ui.chat_frame_rebuilds = state.ui.chat_frame_rebuilds.wrapping_add(1);
            state.ui.chat_plain_lines.clear();
            render_history_range(
                &state.session.chat_history,
                0,
                chat_width,
                HistoryFrame {
                    ctx: &history_ctx,
                    skipped: &skipped,
                    groups: &groups,
                },
                &mut state.ui,
                HistorySink {
                    blocks: &mut history_blocks,
                    regions: &mut content_regions,
                    height: &mut history_height,
                },
            );
        }
    }
    // Plain-line count belonging to history (recorded before the live
    // sections append their rows to `chat_plain_lines`).
    let history_plain_len = state.ui.chat_plain_lines.len();

    // Live-section inputs (snapshotted so the sections below read state through
    // immutable borrows disjoint from the `chat_plain_lines` pushes).
    let live_thinking_expanded = state.agent.thinking_expanded;
    let thinking_level = state.agent.thinking_level.as_str();
    let reasoning_text = state.agent.reasoning_text.as_str();
    let streaming_text = state.agent.streaming_text.as_str();
    let thinking_start = state.agent.thinking_start_time;
    let fps_frame = state.ui.anim_frame as usize;
    // A copy of just the state discriminant used below — no per-frame clone.
    let agent_running = matches!(
        state.agent.state,
        agente_core::types::AgentState::StreamingResponse
            | agente_core::types::AgentState::Planning
            | agente_core::types::AgentState::Executing
    );

    // Live thinking panel — always show collapsed by default while active/has text
    let thinking_live = !reasoning_text.is_empty()
        || (agent_running
            && thinking_start.is_some()
            && thinking_level != agente_core::thinking::THINKING_OFF
            && streaming_text.is_empty());

    if thinking_live || !reasoning_text.is_empty() {
        let still_streaming_thoughts =
            agent_running && !reasoning_text.is_empty() && streaming_text.is_empty();

        let think_start = history_height + lines.len();
        // Live panel: once the text phase starts (thoughts settled), show the
        // elapsed think time instead of a bare "Thought".
        let live_duration = if still_streaming_thoughts {
            None
        } else {
            thinking_start.map(|t| (chrono::Utc::now() - t).num_milliseconds() as f64)
        };
        let think_raw = render_thinking_block(
            reasoning_text,
            live_thinking_expanded,
            thinking_live,
            still_streaming_thoughts,
            fps_frame,
            chat_width,
            live_duration,
        );
        for line in think_raw {
            push_wrapped(
                &mut lines,
                &mut state.ui.chat_plain_lines,
                line,
                chat_width,
                Some(LIVE_THINKING_ID),
            );
        }
        // Header-only hit target (see finished thinking cards).
        let header_end = (think_start + 1).min(history_height + lines.len());
        if header_end > think_start {
            content_regions.push((
                ClickRegion {
                    entry_id: LIVE_THINKING_ID,
                    y_start: 0,
                    y_end: 0,
                    is_reasoning: true,
                    kind: ClickKind::Thinking,
                    user_truncated: false,
                    tool_name: None,
                    content_start: think_start,
                    content_end: think_start,
                    asset_path: None,
                    live_call: None,
                },
                think_start,
                header_end,
            ));
        }
    }

    let mut live_tools: Vec<_> = state.agent.live_tool_calls.iter().collect();
    live_tools.sort_by_key(|(left, _)| *left);
    for (call_id, call) in live_tools {
        // Each running row is a click target: it opens the live output view.
        let start = history_height + lines.len();
        for line in render_live_tool(call, chat_width, fps_frame) {
            push_wrapped(
                &mut lines,
                &mut state.ui.chat_plain_lines,
                line,
                chat_width,
                None,
            );
        }
        let end = history_height + lines.len();
        content_regions.push((
            ClickRegion {
                entry_id: live_tool_entry_id(call_id),
                y_start: 0,
                y_end: 0,
                is_reasoning: false,
                kind: ClickKind::LiveTool,
                user_truncated: false,
                tool_name: Some(call.name.clone()),
                content_start: start,
                content_end: end.saturating_sub(1),
                asset_path: None,
                live_call: Some(call_id.clone()),
            },
            start,
            end,
        ));
    }

    // Streaming: frozen-prefix model. Completed blocks (blank-line or
    // fence boundaries) render through the full markdown pipeline once and
    // freeze into cached styled rows; only the open block (plain) and the
    // live tail re-render per frame. Live status ("Responding…", [stop])
    // lives in the activity strip, not inside the transcript.
    if !streaming_text.is_empty() {
        let text_style = Style::default().fg(FG());
        let stream_lines = render_streaming(
            streaming_text,
            chat_width,
            text_style,
            fps_frame,
            &mut state.ui.stream_markdown_cache,
        );
        for line in stream_lines {
            push_wrapped(
                &mut lines,
                &mut state.ui.chat_plain_lines,
                line,
                chat_width,
                None,
            );
        }
    } else if state.ui.stream_markdown_cache.settled > 0
        || !state.ui.stream_markdown_cache.rows.is_empty()
        || !state.ui.stream_markdown_cache.block_lines.is_empty()
    {
        state.ui.stream_markdown_cache.reset(chat_width);
    }

    // Empty state (non-welcome path)
    if state.session.chat_history.is_empty()
        && streaming_text.is_empty()
        && reasoning_text.is_empty()
    {
        for line in empty_state_lines() {
            push_wrapped(
                &mut lines,
                &mut state.ui.chat_plain_lines,
                line,
                chat_width,
                None,
            );
        }
    }

    // Exact scroll state derived from the same rendered lines.
    // Both are `usize`. Clamping the rendered-line count into a `u16` capped
    // the transcript at 65,535 rows: past that, `skip` stopped tracking the
    // real content and auto-scroll pinned to the wrong row, so a long session
    // could not be scrolled to its own end.
    let rendered_lines = history_height + lines.len();
    state.ui.chat_content_height = rendered_lines;
    state.ui.chat_visible_height = visible_height;

    // Eased scrolls step here, against the height just measured, so a glide
    // to a freshly grown bottom (a sent prompt) lands on the real end.
    if state.ui.step_scroll() {
        state.ui.chat_scroll = state.ui.chat_scroll.min(state.max_scroll());
    } else if state.ui.chat_auto_scroll {
        state.ui.chat_scroll = state.max_scroll();
    } else {
        state.ui.chat_scroll = state.ui.chat_scroll.min(state.max_scroll());
    }

    let skip = state.ui.chat_scroll;

    // Build scroll-corrected click regions for visible lines only. The
    // absolute regions stay owned by the frame snapshot below.
    let mut regions: Vec<ClickRegion> = Vec::new();
    for (region, start, end) in &content_regions {
        let vis_start = (*start).max(skip);
        let vis_end = (*end).min(skip + visible_height);
        if vis_start < vis_end {
            let mut region = region.clone();
            region.y_start = chat_area.y.saturating_add((vis_start - skip) as u16);
            region.y_end = chat_area.y.saturating_add((vis_end - skip - 1) as u16);
            regions.push(region);
        }
    }
    state.ui.update_click_regions(regions);

    let visible_end = skip.saturating_add(visible_height);
    let mut visible_lines: Vec<Line<'static>> = Vec::with_capacity(visible_height);
    for (_, block_start, block) in &history_blocks {
        let block_end = block_start + block.lines.len();
        if block_end <= skip || *block_start >= visible_end {
            continue;
        }
        let local_start = skip.saturating_sub(*block_start);
        let local_end = visible_end
            .saturating_sub(*block_start)
            .min(block.lines.len());
        visible_lines.extend(
            block.lines[local_start..local_end]
                .iter()
                .cloned()
                .enumerate()
                .map(|(offset, line)| {
                    apply_selection_style(line, block_start + local_start + offset, state)
                }),
        );
    }
    visible_lines.extend(lines.into_iter().enumerate().filter_map(|(offset, line)| {
        let index = history_height + offset;
        (index >= skip && index < visible_end).then(|| apply_selection_style(line, index, state))
    }));

    // Ensure we always have height-matching rows. Paint them with the theme
    // background so short transcripts never leave Color::Reset holes (terminal
    // default black ≠ app BG).
    let blank = themed_blank_row(chat_width);
    while visible_lines.len() < visible_height && visible_height > 0 {
        visible_lines.push(blank.clone());
    }

    // Base style fills any cell the line spans don't cover (and anchors the
    // chat rect on the themed background rather than Reset).
    frame.render_widget(
        Paragraph::new(visible_lines).style(Style::default().bg(BG()).fg(FG())),
        chat_area,
    );

    // Publish the frame snapshot for the next paint.
    state.ui.chat_frame_snapshot = Some(ChatFrameSnapshot {
        width: chat_width,
        history_len,
        last_entry_id,
        expand_fingerprint,
        live_tools_epoch,
        subagent_fingerprint: subagent_fp,
        history_plain_len,
        history_line_count: history_height,
        blocks: history_blocks,
        regions: content_regions,
    });

    paint_hover_tint(frame, chat_area, state);
    paint_message_fade(frame, chat_area, state);

    // Scrollbar (or a themed 1-col gutter when content fits — never leave Reset)
    render_scrollbar(frame, scroll_area, state);

    // Jump-to-bottom chip when the user has scrolled up (esp. during streaming).
    render_jump_to_bottom(frame, chat_area, state);
}

fn empty_state_lines() -> Vec<Line<'static>> {
    vec![
        Line::from(""),
        Line::from(vec![
            sp("  "),
            sf("◆", PRIMARY()),
            sp(" "),
            s(
                "Ready",
                Style::default().fg(FG()).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(vec![
            sp("  "),
            s(
                "Type below · / commands · @ path/to/file",
                Style::default().fg(FG_MUTED()),
            ),
        ]),
        Line::from(""),
        Line::from(vec![
            sp("  "),
            s("Shift+↑↓", Style::default().fg(FG_DIM())),
            sp(" scroll  "),
            s("Ctrl+P", Style::default().fg(FG_DIM())),
            sp(" palette  "),
            s("Shift+Tab", Style::default().fg(FG_DIM())),
            sp(" mode"),
        ]),
    ]
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    use agente_core::config::AppConfig;
    use agente_core::types::{ApprovalRequest, ChatEntry, Role};
    use chrono::TimeZone;
    use insta::assert_debug_snapshot;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn fixed_time() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc
            .with_ymd_and_hms(2024, 1, 1, 12, 0, 0)
            .single()
            .unwrap()
    }

    fn base_state() -> AppState {
        AppState::new(AppConfig::default(), "/tmp/agente-snapshot".to_string())
    }

    #[test]
    fn chat_renders_deterministically() {
        let mut state = base_state();
        state.session.chat_history.push(ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: Role::User,
            content: "Implement the plan".to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: fixed_time(),
            response_duration: None,
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        });
        state.session.chat_history.push(ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: Role::Assistant,
            content: "Done.".to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: fixed_time(),
            response_duration: Some(1250.0),
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        });
        state.session.chat_history.push(ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: Role::Tool,
            content: "STDOUT:\nok\nEXIT CODE: 0".to_string(),
            tool_name: Some("shell".to_string()),
            tool_args: None,
            is_error: false,
            timestamp: fixed_time(),
            response_duration: Some(500.0),
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        });

        let backend = TestBackend::new(60, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| crate::widgets::chat::render(f, f.area(), &mut state))
            .unwrap();
        insta::with_settings!({ snapshot_path => "../snapshots" }, {
            assert_debug_snapshot!("chat_60x16", terminal.backend().buffer().clone());
        });
    }

    #[test]
    fn input_renders_deterministically() {
        let state = base_state();
        // Composer is taller now (bordered card, min body rows).
        let backend = TestBackend::new(60, 8);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| crate::widgets::input::render(f, f.area(), &state))
            .unwrap();
        insta::with_settings!({ snapshot_path => "../snapshots" }, {
            assert_debug_snapshot!("input_60x8", terminal.backend().buffer().clone());
        });
    }

    #[test]
    fn input_command_renders_highlighted_slash() {
        let mut state = base_state();
        state.input.input_text = "/model gpt-4o".to_string();
        // Cursor right after the command token, on the split boundary.
        state.input.input_cursor = 6;

        let backend = TestBackend::new(60, 8);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| crate::widgets::input::render(f, f.area(), &state))
            .unwrap();
        insta::with_settings!({ snapshot_path => "../snapshots" }, {
            assert_debug_snapshot!("input_command_60x8", terminal.backend().buffer().clone());
        });
    }

    #[test]
    fn shell_layout_screenshot_80x24() {
        // Visual dump of header + empty chat + composer + status.
        let mut state = base_state();
        state.ui.show_welcome_screen = true;
        state.config.current_provider.clear();
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                // Mimic app layout: content + input + status
                use ratatui::layout::{Constraint, Layout};
                let size = f.area();
                let input_h = crate::widgets::input::desired_height(
                    &state.input.input_text,
                    size.width,
                    0,
                    false,
                )
                .max(crate::widgets::input::min_height());
                let [content, input, status] = Layout::vertical([
                    Constraint::Fill(1),
                    Constraint::Length(input_h.min(size.height.saturating_sub(2))),
                    Constraint::Length(1),
                ])
                .areas(size);
                crate::widgets::welcome::render(f, content, &mut state);
                crate::widgets::input::render(f, input, &state);
                crate::widgets::hints::render(f, status, &state);
            })
            .unwrap();
        // Write human-readable screenshot for review
        let buf = terminal.backend().buffer().clone();
        let mut shot = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                let cell = &buf[(x, y)];
                shot.push_str(cell.symbol());
            }
            shot.push('\n');
        }
        let dir = std::path::Path::new("target/ui-shots");
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join("welcome_80x24.txt"), &shot);
        insta::with_settings!({ snapshot_path => "../snapshots" }, {
            assert_debug_snapshot!("shell_welcome_80x24", buf);
        });
    }

    #[test]
    fn help_renders_deterministically() {
        let mut state = base_state();
        state.ui.show_help = true;

        let backend = TestBackend::new(60, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| crate::help::render(f, f.area(), &mut state))
            .unwrap();
        insta::with_settings!({ snapshot_path => "../snapshots" }, {
            assert_debug_snapshot!("help_60x24", terminal.backend().buffer().clone());
        });
    }

    #[test]
    fn approval_renders_deterministically() {
        let mut state = base_state();
        state.agent.enqueue_approval(
            agente_core::agent::ApprovalSource::Parent,
            ApprovalRequest {
                request_id: "test-approval".to_string(),
                tool_name: "shell".to_string(),
                tool_args: r#"{"command":"cargo check"}"#.to_string(),
                description: "Run command: cargo check".to_string(),
                is_dangerous: false,
                old_content: None,
                new_content: None,
                file_path: None,
            },
        );

        let backend = TestBackend::new(60, 12);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| crate::widgets::approval::render(f, f.area(), &mut state))
            .unwrap();
        insta::with_settings!({ snapshot_path => "../snapshots" }, {
            assert_debug_snapshot!("approval_60x12", terminal.backend().buffer().clone());
        });
    }
}
