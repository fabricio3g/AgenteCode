//! Chat widget - transcript with user bubbles and scrollbar
//! - User messages: full-width gray background card with colored mode bar
//! - Assistant messages: content + footer line
//! - Proper scrollbar on the right edge
//! - Icons instead of text labels
//! - Collapsed thinking by default; hover borders; expand long pastes

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use std::sync::Arc;

use super::markdown::{render_markdown, render_markdown_at_width, wrap_line};
use super::{s, sf, shimmer_text, sp, themed_blank_row};
use crate::state::{
    AppState, ChatFrameSnapshot, ChatPlainLine, Fold, LiveToolCall, RenderedChatBlock,
    StreamMarkdownCache, SubagentUiState, UiState,
};
use crate::style::*;
use crate::widgets::{display_width, fill_row, tool_icon_for, truncate_cells};
use agente_core::types::{ClickKind, ClickRegion};

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
            &|id, name| state.ui.tool_fold_of(id, name),
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
                true,
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
    live_tools.sort_by(|(left, _), (right, _)| left.cmp(right));
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
                false,
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
                false,
            );
        }
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
                false,
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

/// Background lift under the hovered card's rows, plus an accent rail on
/// subagent cards (they open a modal, so they should read as buttons).
/// Painted over the finished frame so hover never touches the render caches;
/// only bare canvas cells change, so prompt cards and diff rows keep their
/// own backgrounds, and blank spacer rows stay untouched.
fn paint_hover_tint(frame: &mut Frame, area: Rect, state: &AppState) {
    let Some(id) = state.ui.hovered_entry_id else {
        return;
    };
    let canvas = BG();
    let ease = state
        .ui
        .hover_fade
        .and_then(|t| t.progress())
        .unwrap_or(1.0);
    let tint = blend_colors(canvas, crate::style::hover_tint(), ease);
    let buf = frame.buffer_mut();
    for region in state
        .ui
        .click_regions
        .iter()
        .filter(|r| r.entry_id == id && crate::state::is_hover_target(r))
    {
        let top = region.y_start.max(area.y);
        let bottom = region.y_end.min(area.bottom().saturating_sub(1));
        if region.kind == ClickKind::Prompt {
            paint_prompt_hover(buf, area, top, bottom, ease);
            continue;
        }
        // Skip only the blank rows around the card (its trailing gap row):
        // an empty line *inside* the output must stay tinted, or the card
        // shows a hole.
        let blank = |buf: &ratatui::buffer::Buffer, y: u16| {
            (area.x..area.right()).all(|x| {
                buf.cell((x, y))
                    .is_none_or(|c| c.symbol().trim().is_empty())
            })
        };
        let Some(first) = (top..=bottom).find(|&y| !blank(buf, y)) else {
            continue;
        };
        let last = (top..=bottom)
            .rev()
            .find(|&y| !blank(buf, y))
            .unwrap_or(first);
        for y in first..=last {
            for x in area.x..area.right() {
                if let Some(cell) = buf.cell_mut((x, y)) {
                    if cell.bg == canvas {
                        cell.set_bg(tint);
                    }
                }
            }
            if region.kind == ClickKind::Subagent {
                if let Some(cell) = buf.cell_mut((area.x, y)) {
                    cell.set_symbol("▎").set_fg(PRIMARY());
                }
            }
        }
    }
}

/// Hover on a sent message: lift its band, brighten the rail, and swap the
/// timestamp for what a click offers. Only band cells change.
fn paint_prompt_hover(
    buf: &mut ratatui::buffer::Buffer,
    area: Rect,
    top: u16,
    bottom: u16,
    ease: f32,
) {
    const HINT: &str = "revert · fork · copy ";
    let band = USER_BUBBLE_BG();
    let lifted = blend_colors(band, BG_HOVER(), ease);
    let mut first_row = None;
    for y in top..=bottom {
        let mut band_end = None;
        let mut has_text = false;
        for x in area.x..area.right() {
            let Some(cell) = buf.cell_mut((x, y)) else {
                continue;
            };
            if cell.bg != band {
                continue;
            }
            match cell.symbol() {
                "▎" => {
                    cell.set_fg(user_rail_color(true));
                }
                " " => {}
                _ => has_text = true,
            }
            cell.set_bg(lifted);
            band_end = Some(x);
        }
        // The hint goes on the first text row (the one carrying the time),
        // not the card's padding row.
        if let (None, Some(end), true) = (first_row, band_end, has_text) {
            first_row = Some((y, end));
        }
    }
    // The hint replaces the time on the first row, right-aligned in the band.
    if let Some((y, end)) = first_row {
        let width = display_width(HINT) as u16;
        let start = (end + 1).saturating_sub(width + 1);
        // Never cover the message: only blank cells and the time give way.
        let under: String = (start..start + width)
            .filter_map(|x| buf.cell((x, y)).map(|c| c.symbol().to_string()))
            .collect();
        let under = under.trim();
        if !(under.is_empty() || (under.contains(':') && under.ends_with('M'))) {
            return;
        }
        for (i, ch) in HINT.chars().enumerate() {
            if let Some(cell) = buf.cell_mut((start + i as u16, y)) {
                cell.set_symbol(ch.encode_utf8(&mut [0u8; 4]))
                    .set_fg(FG_MUTED())
                    .set_bg(lifted);
            }
        }
    }
}

/// Fade the newest history block in (a just-sent prompt settling into its
/// bubble). Only that block's rows change; the rest of the transcript and
/// the streaming section stay steady.
fn paint_message_fade(frame: &mut Frame, area: Rect, state: &AppState) {
    let Some(p) = state.ui.message_fade.and_then(|t| t.progress()) else {
        return;
    };
    let Some((_, start, block)) = state
        .ui
        .chat_frame_snapshot
        .as_ref()
        .and_then(|snap| snap.blocks.last())
    else {
        return;
    };
    let skip = state.ui.chat_scroll;
    let (top, end) = (*start, start + block.lines.len());
    let (vis_top, vis_end) = (top.max(skip), end.min(skip + area.height as usize));
    if vis_top >= vis_end {
        return;
    }
    let rows = Rect::new(
        area.x,
        area.y + (vis_top - skip) as u16,
        area.width,
        (vis_end - vis_top) as u16,
    );
    crate::state::anim::fade_toward(frame.buffer_mut(), rows, BG(), 1.0 - p);
}

/// Render the live streaming section: frozen-prefix model.
///
/// Closed blocks (blank-line / fence boundaries) are markdown-rendered ONCE
/// into `cache.rows`; the open block plus the partial line re-renders
/// through the markdown pipeline every frame (unclosed markers styled,
/// not shown raw). The ingest-side auto-checkpoint bounds the per-frame
/// cost.
fn render_streaming(
    text: &str,
    width: usize,
    style: Style,
    fps_frame: usize,
    cache: &mut StreamMarkdownCache,
) -> Vec<Line<'static>> {
    let _ = style;
    let mut out = Vec::new();
    if width == 0 {
        return out;
    }
    // Markdown rows already own their gutter. Match the final-answer width.
    let content_w = width;
    let cursor_color = breathing_color(PRIMARY(), FG_DIM(), fps_frame, 0.25);
    let cursor_span = Span::styled("\u{258a}", Style::default().fg(cursor_color));

    if text.is_empty() {
        cache.reset(width);
        out.push(stream_cursor_row(width, &cursor_span));
        return out;
    }

    // Revalidate the append-only assumption + width + syntax theme; any
    // violation rebuilds completed blocks from scratch on this pass.
    let generation = crate::style::syntax_generation();
    let usable = cache.width == width
        && cache.generation == generation
        && text.len() >= cache.settled
        && (cache.settled == 0 || text.as_bytes().get(cache.settled - 1) == Some(&b'\n'))
        && stream_prefix_matches(text, cache);
    if !usable {
        cache.reset(width);
        cache.generation = generation;
    }
    cache.width = width;

    // Ingest newly completed lines. Closed blocks become styled rows; the
    // open block stays in the live section until its boundary arrives.
    while text.len() > cache.settled {
        let rest = &text[cache.settled..];
        let Some(pos) = rest.find('\n') else {
            break;
        };
        let line = &rest[..pos];
        cache.settled += pos + 1;
        cache.ingest_line(line, width);
    }
    cache.refresh_guards(text);

    for row in &cache.rows {
        out.push(row.clone());
    }

    let ends_with_newline = text.ends_with('\n');
    let live = &text[cache.consumed..];
    if !live.is_empty() {
        let live_rows: Vec<Line<'static>> = render_markdown_at_width(live, content_w)
            .iter()
            .flat_map(|l| wrap_line(l, content_w))
            .collect();
        let last = live_rows.len().saturating_sub(1);
        for (j, row) in live_rows.iter().enumerate() {
            if j == last && !ends_with_newline {
                push_stream_cursor_line(&mut out, row, &cursor_span, width);
            } else {
                out.push(row.clone());
            }
        }
    }
    if ends_with_newline || out.is_empty() {
        out.push(stream_cursor_row(width, &cursor_span));
    }

    out
}

/// Append an already-styled live line with the streaming cursor attached.
fn push_stream_cursor_line(
    out: &mut Vec<Line<'static>>,
    line: &Line<'static>,
    cursor: &Span<'static>,
    width: usize,
) {
    let mut row = line.clone();
    if row.width() < width {
        row.spans.push(cursor.clone());
        out.push(row);
    } else {
        out.push(row);
        out.push(stream_cursor_row(width, cursor));
    }
}

fn stream_cursor_row(width: usize, cursor: &Span<'static>) -> Line<'static> {
    Line::from(vec![
        sp(&"  "[..2.min(width.saturating_sub(1))]),
        cursor.clone(),
    ])
}

/// O(1) guard for the append-only assumption behind the incremental stream
/// wrap: the first/last bytes of the consumed prefix must still match. Any
/// mismatch falls back to a full re-wrap (never a wrong render).
fn stream_prefix_matches(text: &str, cache: &StreamMarkdownCache) -> bool {
    if cache.settled == 0 {
        return true;
    }
    let head_n = cache.settled.min(8);
    if text.as_bytes()[..head_n] != cache.head[..head_n] {
        return false;
    }
    let tail_n = cache.settled.min(8);
    text.as_bytes()[cache.settled - tail_n..cache.settled] == cache.tail[..tail_n]
}

/// Agent-derived inputs for [`render_history_range`], kept separate from the
/// `&mut UiState` parameter so the history slice, UI state and agent state
/// borrow disjoint fields.
struct HistoryRenderCtx<'a> {
    live_tools: &'a std::collections::HashMap<String, LiveToolCall>,
    subagents: &'a std::collections::HashMap<String, SubagentUiState>,
}

/// Entries that render no block of their own: pending tool-call stubs whose
/// result (or live card) follows. Runs of grouped tool cards skip over these.
fn skipped_entries(
    history: &[agente_core::types::ChatEntry],
    ctx: &HistoryRenderCtx<'_>,
) -> Vec<bool> {
    history
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            // A `task` spawn result echoes what its subagent card already
            // shows (status, id, how to poll): the card is the one view.
            let task_echo = entry.role == agente_core::types::Role::Tool
                && entry.tool_name.as_deref() == Some("task")
                && entry.subagent_id.is_none()
                && history.iter().any(|card| {
                    card.subagent_id
                        .as_deref()
                        .is_some_and(|id| entry.content.contains(id))
                });
            task_echo
                || entry.role == agente_core::types::Role::Assistant
                    && entry.content.is_empty()
                    && entry.tool_name.is_some()
                    && (history.get(index + 1).is_some_and(|next| {
                        next.role == agente_core::types::Role::Tool
                            && next.tool_name == entry.tool_name
                    }) || ctx
                        .live_tools
                        .values()
                        .any(|call| !call.direct && Some(&call.name) == entry.tool_name.as_ref()))
        })
        .collect()
}

/// Render chat entries `[from..]` into the given accumulators. On a frame-snapshot
/// reuse the accumulators already hold the earlier frames' prefix; on a rebuild
/// they start empty.
/// Where a history render deposits its results. The three sinks are always
/// filled together by one frame build, so they travel as one value.
/// The precomputed shape of one frame's history: the borrow-disjoint inputs
/// plus the two tables derived from them (which entries render nothing, and
/// which runs fold into a group header).
struct HistoryFrame<'a> {
    ctx: &'a HistoryRenderCtx<'a>,
    skipped: &'a [bool],
    groups: &'a [(usize, usize, GroupInfo)],
}

struct HistorySink<'a> {
    blocks: &'a mut Vec<(usize, usize, Arc<RenderedChatBlock>)>,
    regions: &'a mut Vec<(ClickRegion, usize, usize)>,
    height: &'a mut usize,
}

fn render_history_range(
    history: &[agente_core::types::ChatEntry],
    from: usize,
    chat_width: usize,
    frame: HistoryFrame<'_>,
    ui: &mut UiState,
    sink: HistorySink<'_>,
) {
    let HistoryFrame {
        ctx,
        skipped,
        groups,
    } = frame;
    let HistorySink {
        blocks,
        regions: regions_out,
        height: history_height,
    } = sink;
    // Group ownership per entry: index into `groups`. Group members of a
    // collapsed run render nothing; the head renders the group header.
    // Membership uses the exact member indices (runs are contiguous in the
    // rendered stream, not the raw entry list).
    let mut group_idx_of: Vec<Option<usize>> = vec![None; history.len()];
    for (gi, (_, _, info)) in groups.iter().enumerate() {
        for &member in &info.members {
            if member < group_idx_of.len() {
                group_idx_of[member] = Some(gi);
            }
        }
    }
    let is_hidden = |index: usize| -> bool {
        skipped.get(index).copied().unwrap_or(false)
            || group_idx_of[index].is_some_and(|gi| {
                let (start, _, info) = &groups[gi];
                !info.expanded && index != *start
            })
    };
    let next_rendered =
        |after: usize| -> Option<usize> { (after + 1..history.len()).find(|&j| !is_hidden(j)) };
    // Effective fold per entry, resolved once so the helper closures below
    // stay free of the `ui` borrow (the loop needs it mutably).
    let folds: Vec<Fold> = history
        .iter()
        .map(|e| ui.tool_fold_of(e.id, e.tool_name.as_deref()))
        .collect();
    // A finished tool card in Collapsed fold is a one-line dense block: the
    // gap rhythm suppresses the blank between consecutive dense cards.
    // Bare machinery rows — the `◆ read_file {…}` call announcer and a
    // thought without body text — flow inside the same dense run, so a
    // tool → thought → call → result sequence stacks with no air.
    let continues_dense_run = |index: usize| -> bool {
        let entry = &history[index];
        if entry.subagent_id.is_some() {
            return false;
        }
        if entry.role == agente_core::types::Role::Tool {
            return folds[index] == Fold::Collapsed;
        }
        entry.role == agente_core::types::Role::Assistant && entry.content.is_empty()
    };

    for (index, entry) in history.iter().enumerate().skip(from) {
        if is_hidden(index) {
            continue;
        }

        // Expanded group: the header row is followed by every member rendered
        // as its dense collapsed card, each still individually cyclable.
        if let Some(gi) = group_idx_of[index] {
            let (start, _, info) = &groups[gi];
            if index == *start {
                let last_member = info.members.last().copied().unwrap_or(index);
                let dense_next = next_rendered(last_member)
                    .map(continues_dense_run)
                    .unwrap_or(false);
                let block = Arc::new(render_group_header_block(
                    history, info, chat_width, dense_next,
                ));
                let block_start = *history_height;
                *history_height += block.lines.len();
                ui.chat_plain_lines.extend(block.plain.iter().cloned());
                regions_out.push((
                    ClickRegion {
                        entry_id: info.head_id,
                        y_start: 0,
                        y_end: 0,
                        is_reasoning: false,
                        kind: ClickKind::ToolGroup,
                        user_truncated: false,
                        tool_name: None,
                        content_start: block_start,
                        content_end: block_start + block.lines.len().saturating_sub(1),
                        asset_path: None,
                        live_call: None,
                    },
                    block_start,
                    block_start + block.lines.len(),
                ));
                blocks.push((index, block_start, block));
                if !info.expanded {
                    continue;
                }
            }
        }

        // The originating call entry (skipped above) carries the JSON args a
        // tool card may want — e.g. the shell command for the `$ cmd` header.
        let prev_call_args: Option<String> = if entry.role == agente_core::types::Role::Tool {
            history
                .get(index.wrapping_sub(1))
                .filter(|prev| {
                    prev.role == agente_core::types::Role::Assistant
                        && prev.tool_name == entry.tool_name
                })
                .and_then(|prev| prev.tool_args.clone())
        } else {
            None
        };

        let user_expanded = ui.expanded_message_ids.contains(&entry.id);
        let thinking_expanded = ui.expanded_thinking_ids.contains(&entry.id);
        let tool_fold = ui.tool_fold_of(entry.id, entry.tool_name.as_deref());
        let in_group = group_idx_of[index].is_some_and(|gi| groups[gi].2.expanded);
        let dense_next = (in_group
            && group_idx_of[index]
                .is_some_and(|gi| groups[gi].2.members.last().copied() != Some(index)))
            || next_rendered(index)
                .map(continues_dense_run)
                .unwrap_or(false);
        let block_width = if in_group {
            chat_width.saturating_sub(4).max(1)
        } else {
            chat_width
        };

        // Pull the entry's parsed block from the cache when possible (subagent
        // cards read live state and are always re-rendered). This skips the
        // markdown + word-wrap pass for unchanged history on every frame.
        let worked = worked_for_duration(history, index);
        let block = if entry.subagent_id.is_some() {
            Arc::new(render_entry_block(
                entry,
                chat_width,
                user_expanded,
                thinking_expanded,
                tool_fold,
                dense_next,
                ctx.subagents,
                prev_call_args.as_deref(),
                worked,
            ))
        } else {
            let cache_key = crate::state::ChatCacheKey {
                width: block_width,
                user_expanded,
                thinking_expanded,
                tool_fold,
                dense_next,
            };
            match ui.chat_cache_get(&entry.id, cache_key) {
                Some(b) => b,
                None => {
                    let b = render_entry_block(
                        entry,
                        block_width,
                        user_expanded,
                        thinking_expanded,
                        tool_fold,
                        dense_next,
                        ctx.subagents,
                        prev_call_args.as_deref(),
                        worked,
                    );
                    ui.chat_cache_put(entry.id, b)
                }
            }
        };

        let block = if in_group {
            let mut nested = (*block).clone();
            for line in &mut nested.lines {
                let blank = line.spans.iter().all(|span| span.content.trim().is_empty());
                line.spans
                    .insert(0, sf(if blank { "    " } else { "   │" }, MACHINERY()));
            }
            for line in &mut nested.plain {
                let prefix = if line.plain.trim().is_empty() {
                    "    "
                } else {
                    "   │"
                };
                line.plain = format!("{prefix}{}", line.plain).into();
            }
            Arc::new(nested)
        } else {
            block
        };
        let block_start = *history_height;
        *history_height += block.lines.len();
        ui.chat_plain_lines.extend(block.plain.iter().cloned());
        for &(s, e, kind, trunc) in &block.regions {
            let tool_name = if kind == ClickKind::Tool {
                entry.tool_name.clone()
            } else {
                None
            };
            let asset_path = if kind == ClickKind::OpenAsset {
                extract_media_path(&entry.content)
            } else {
                None
            };
            regions_out.push((
                ClickRegion {
                    entry_id: entry.id,
                    y_start: 0,
                    y_end: 0,
                    is_reasoning: kind == ClickKind::Thinking,
                    kind,
                    user_truncated: trunc,
                    tool_name,
                    content_start: block_start + s,
                    content_end: block_start + e.saturating_sub(1),
                    asset_path,
                    live_call: None,
                },
                block_start + s,
                block_start + e,
            ));
        }
        blocks.push((index, block_start, block));
    }
}

/// Order-independent fingerprint of the live subagent UI state. Subagent cards
/// are history blocks rendered from live state, so any visible change (status,
/// streamed text growth, nested tool rows, summary, expansion) must invalidate
/// the frame snapshot. XOR-combined per-entry hashes keep it stable against
/// HashMap iteration order.
fn subagent_fingerprint(
    subagents: &std::collections::HashMap<String, SubagentUiState>,
    width: usize,
) -> u64 {
    let mut fp = subagents.len() as u64;
    for (id, state) in subagents {
        let mut h = 0x2545_F491_4F6C_DD1D;
        for byte in id.bytes().chain(state.status.bytes()) {
            h = (h ^ u64::from(byte)).wrapping_mul(0x100_0000_01B3);
        }
        // Hidden tool history/progress must not rebuild the transcript. The
        // live elapsed readout is bucketed to seconds, so a running card
        // repaints its clock without rebuilding on every frame.
        let elapsed_bucket = state
            .elapsed_ms()
            .map(|ms| (ms / 1000.0) as u64)
            .unwrap_or(0);
        let worktree = state
            .worktree
            .as_ref()
            .map(|wt| format!("{}:{}", wt.branch, wt.dirty))
            .unwrap_or_default();
        for byte in state
            .description
            .bytes()
            .chain(subagent_activity(Some(state), width.saturating_sub(3)).bytes())
            .chain(state.model.bytes())
            .chain(worktree.bytes())
            .chain(elapsed_bucket.to_le_bytes())
            // Cost shows on the card: a new tenth of a cent re-renders it.
            .chain(((state.spend.cost_usd * 1000.0).round() as u64).to_le_bytes())
            .chain((state.tool_rows.len() as u64).to_le_bytes())
        {
            h = (h ^ u64::from(byte)).wrapping_mul(0x100_0000_01B3);
        }
        fp ^= h;
    }
    fp
}

/// Stable per-call id for a running row, so hover lights up only that row
/// (the live rows have no chat entry of their own).
fn live_tool_entry_id(call_id: &str) -> uuid::Uuid {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    call_id.hash(&mut hasher);
    let high = hasher.finish();
    "live-tool".hash(&mut hasher);
    uuid::Uuid::from_u64_pair(high, hasher.finish())
}

fn render_live_tool(
    call: &crate::state::LiveToolCall,
    width: usize,
    fps_frame: usize,
) -> Vec<Line<'static>> {
    let bg = BG();
    let tick = fps_frame as u64;
    let icon_color = breathing_color(PRIMARY(), ACCENT(), fps_frame, 0.2);
    let spinner_color = breathing_color(SECONDARY(), PRIMARY(), fps_frame, 0.25);
    let (verb, subject) = tool_header_parts(&call.name, Some(&call.args), width);
    let action = match verb {
        Some(v) => format!("Run {v}"),
        None => "Run".to_string(),
    };
    let label = if subject.is_empty() {
        action
    } else {
        format!("{action} {subject}")
    };
    let header = vec![
        Span::styled(" ", Style::default().bg(bg)),
        Span::styled(
            tool_icon_for(&call.name),
            Style::default().fg(icon_color).bg(bg),
        ),
        Span::styled(" ", Style::default().bg(bg)),
        Span::styled(
            crate::widgets::spinner_frame_for_tick(tick),
            Style::default().fg(spinner_color).bg(bg),
        ),
        Span::styled(" ", Style::default().bg(bg)),
        Span::styled(
            label,
            Style::default()
                .fg(FG())
                .bg(bg)
                .add_modifier(Modifier::BOLD),
        ),
    ];
    // How long it has been running, right-aligned: a silent install no
    // longer looks frozen.
    let header = crate::widgets::justify(
        header,
        vec![Span::styled(
            call.elapsed_label(),
            Style::default().fg(FG_DIM()).bg(bg),
        )],
        width,
        bg,
    );

    let mut lines = vec![Line::from(header)];
    if call.output.is_empty() {
        if call.started.elapsed().as_secs() >= 2 {
            lines.push(Line::from(vec![
                sp("      "),
                Span::styled(
                    format!(
                        "{} · click to watch",
                        crate::widgets::process_view::empty_output_hint(call)
                    ),
                    Style::default().fg(FG_DIM()),
                ),
            ]));
        }
        return lines;
    }

    let output_lines: Vec<&str> = call.output.lines().collect();
    let max_lines = 8usize;
    let first = output_lines.len().saturating_sub(max_lines);
    if first > 0 {
        lines.push(Line::from(vec![
            sp("      "),
            Span::styled(
                format!("… {first} earlier lines"),
                Style::default().fg(FG_DIM()),
            ),
        ]));
    }
    for output in output_lines.into_iter().skip(first) {
        lines.push(Line::from(vec![
            sp("      "),
            Span::styled(
                truncate_cells(output, width.saturating_sub(6)),
                Style::default().fg(FG_MUTED()),
            ),
        ]));
    }
    lines
}

/// Bottom-right ↓ control: click re-pins auto-scroll to the live tail.
fn render_jump_to_bottom(frame: &mut Frame, chat_area: Rect, state: &mut AppState) {
    state.ui.jump_bottom_area = None;
    if !state.ui.show_jump_to_bottom() || chat_area.width < 3 || chat_area.height < 1 {
        return;
    }
    // Single-width chrome: " ↓ " on a small chip, bottom-right of the chat pane.
    let chip_w: u16 = 3;
    let x = chat_area
        .x
        .saturating_add(chat_area.width.saturating_sub(chip_w + 1));
    let y = chat_area
        .y
        .saturating_add(chat_area.height.saturating_sub(1));
    let rect = Rect::new(x, y, chip_w, 1);
    state.ui.jump_bottom_area = Some(rect);
    // Hover brightens the chip's background so it reads as pressable.
    let hovered = state.ui.pointer_in(rect);
    let style = if hovered {
        Style::default()
            .fg(PRIMARY())
            .bg(BG_HOVER())
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
            .fg(PRIMARY())
            .bg(BG_ELEMENT())
            .add_modifier(Modifier::BOLD)
    };
    frame.render_widget(Paragraph::new(Line::from(Span::styled(" ↓ ", style))), rect);
}

/// Transient confirmation chip ("✓ copied 12 lines"), bottom-right of the
/// content area. Display-only: expires from `UiState::active_toast` and is
/// never written to history or disk. Shifted left when the jump-to-bottom
/// control occupies the same corner.
pub fn render_toast(frame: &mut Frame, area: Rect, state: &AppState) {
    let Some(text) = state.ui.active_toast() else {
        return;
    };
    if area.width < 12 || area.height < 1 {
        return;
    }
    const PADDING: usize = 2; // one space each side
    let mut width = display_width(text) + PADDING;
    let max = area.width as usize - 2;
    if width > max {
        width = max;
    }
    let jump_visible = state.ui.show_jump_to_bottom() && state.ui.jump_bottom_area.is_some();
    let right_gap: u16 = if jump_visible { 5 } else { 1 };
    let x = area.x + area.width.saturating_sub(width as u16 + right_gap);
    let y = area.y + area.height.saturating_sub(1);
    let label = format!(" {} ", truncate_cells(text, width.saturating_sub(PADDING)));
    let style = Style::default()
        .fg(SUCCESS())
        .bg(BG_ELEMENT())
        .add_modifier(Modifier::BOLD);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(label, style))),
        Rect::new(x, y, width as u16, 1),
    );
}

fn push_wrapped(
    lines: &mut Vec<Line<'static>>,
    plain: &mut Vec<ChatPlainLine>,
    line: Line<'_>,
    width: usize,
    entry_id: Option<uuid::Uuid>,
    is_thinking: bool,
) {
    let wrapped = wrap_line(&line, width);
    for w in wrapped {
        let text: String = w.spans.iter().map(|s| s.content.as_ref()).collect();
        plain.push(ChatPlainLine {
            entry_id,
            plain: text.into(),
            is_thinking,
        });
        lines.push(w);
    }
}

/// Own a single line (no wrap) as `'static` and append it — used for the
/// already-sized assistant edge rows.
fn push_owned_line(
    lines: &mut Vec<Line<'static>>,
    plain: &mut Vec<ChatPlainLine>,
    line: &Line<'_>,
    entry_id: Option<uuid::Uuid>,
) {
    let owned = Line {
        style: line.style,
        alignment: line.alignment,
        spans: line
            .spans
            .iter()
            .map(|s| Span::styled(s.content.clone().into_owned(), s.style))
            .collect(),
    };
    let text: String = owned.spans.iter().map(|s| s.content.as_ref()).collect();
    plain.push(ChatPlainLine {
        entry_id,
        plain: text.into(),
        is_thinking: false,
    });
    lines.push(owned);
}

fn entry_is_truncatable(entry: &agente_core::types::ChatEntry) -> bool {
    entry.content.lines().count() > USER_PREVIEW_LINES
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

/// Render one chat entry into a cacheable block: finished thinking card (if
/// any) + the role body, plus its click regions. The `frame` counter is unused
/// for finished cards (shimmer only applies to the live panel), so this is
/// deterministic given `(entry, width, fold states, dense-next, hover)`.
#[allow(clippy::too_many_arguments)]
fn render_entry_block(
    entry: &agente_core::types::ChatEntry,
    chat_width: usize,
    user_expanded: bool,
    thinking_expanded: bool,
    tool_fold: Fold,
    dense_next: bool,
    subagents: &std::collections::HashMap<String, SubagentUiState>,
    tool_args: Option<&str>,
    worked_for: Option<f64>,
) -> RenderedChatBlock {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut plain: Vec<ChatPlainLine> = Vec::new();
    let mut regions: Vec<(usize, usize, ClickKind, bool)> = Vec::new();

    let has_reasoning = entry
        .reasoning
        .as_ref()
        .is_some_and(|r| !r.trim().is_empty());
    // Assistant turn layout: a blank lead, a right-aligned timestamp row,
    // then the markdown body directly on the background — no bubble edges,
    // no card background. All other roles wrap plainly.
    //
    // When the entry carries finished reasoning, the chrome goes ABOVE the
    // thought and the blank lead is dropped (the thought header is
    // separation enough). Otherwise the blank + timestamp land between the
    // thought and its own text and divorce them with two dead rows.
    let is_assistant =
        entry.subagent_id.is_none() && matches!(entry.role, agente_core::types::Role::Assistant);
    if is_assistant && !entry.content.is_empty() {
        if !has_reasoning {
            push_owned_line(
                &mut lines,
                &mut plain,
                &themed_blank_row(chat_width),
                Some(entry.id),
            );
        }
        push_owned_line(
            &mut lines,
            &mut plain,
            &assistant_timestamp_row(chat_width, entry.timestamp),
            Some(entry.id),
        );
    }

    // Finished thinking card (collapsed by default).
    if let Some(reasoning) = entry.reasoning.as_ref().filter(|r| !r.trim().is_empty()) {
        let think_start = lines.len();
        let think_raw = render_thinking_block(
            reasoning,
            thinking_expanded,
            false,
            false,
            0,
            chat_width,
            entry.response_duration,
        );
        for line in think_raw {
            push_wrapped(
                &mut lines,
                &mut plain,
                line,
                chat_width,
                Some(entry.id),
                true,
            );
        }
        // The whole collapsed header is clickable (expand/collapse), including
        // wrapped continuation rows on narrow terminals. The expanded body
        // must not steal hits or shift hover onto neighbors after toggle, so
        // an open body keeps the first-row-only target.
        let header_end = if thinking_expanded {
            (think_start + 1).min(lines.len())
        } else {
            lines.len()
        };
        if header_end > think_start {
            regions.push((think_start, header_end, ClickKind::Thinking, false));
        }
    }

    let (raw, user_truncated) = if entry.subagent_id.is_some() {
        // Subagent activity renders as a dedicated card (live UI state).
        let ui = entry
            .subagent_id
            .as_deref()
            .and_then(|id| subagents.get(id));
        (render_subagent(entry, chat_width, ui, user_expanded), false)
    } else {
        match entry.role {
            agente_core::types::Role::User => {
                let truncated = entry_is_truncatable(entry) && !user_expanded;
                (render_user(entry, chat_width, user_expanded), truncated)
            }
            agente_core::types::Role::Assistant => {
                (render_assistant(entry, chat_width, worked_for), false)
            }
            agente_core::types::Role::System => (render_system(entry, chat_width), false),
            agente_core::types::Role::Tool => (
                render_tool(entry, chat_width, tool_fold, dense_next, tool_args),
                false,
            ),
        }
    };

    let start = lines.len();
    for line in raw {
        push_wrapped(
            &mut lines,
            &mut plain,
            line,
            chat_width,
            Some(entry.id),
            false,
        );
    }
    let end = lines.len();
    if end > start {
        if entry.subagent_id.is_some() {
            // The card's trailing gap row is not part of the hit target:
            // clicking empty air under a card used to open the detail modal.
            let click_end = if end > start + 1
                && lines[end - 1]
                    .spans
                    .iter()
                    .all(|span| span.content.trim().is_empty())
            {
                end - 1
            } else {
                end
            };
            regions.push((start, click_end, ClickKind::Subagent, false));
        } else if entry.role == agente_core::types::Role::Tool {
            if extract_media_path(&entry.content).is_some() && end > start + 1 {
                let btn_line = if !dense_next && end >= 2 {
                    end - 2
                } else {
                    end - 1
                };
                if btn_line > start {
                    regions.push((start, btn_line, ClickKind::Tool, false));
                    regions.push((btn_line, btn_line + 1, ClickKind::OpenAsset, false));
                } else {
                    regions.push((start, end, ClickKind::Tool, false));
                }
            } else {
                regions.push((start, end, ClickKind::Tool, false));
            }
        } else if entry.role == agente_core::types::Role::User {
            regions.push((start, end, ClickKind::Prompt, user_truncated));
        } else if entry.role == agente_core::types::Role::Assistant {
            regions.push((start, end, ClickKind::Message, user_truncated));
        }
    }

    RenderedChatBlock {
        width: chat_width,
        user_expanded,
        thinking_expanded,
        tool_fold,
        dense_next,
        lines,
        plain,
        regions,
    }
}

/// Thread rail joining the `◆` thinking header to its body lines.
///
/// Same 4-cell width as the old blank indent, so wrap budgets are untouched;
/// the rail sits exactly under the header diamond. The `│` rides the same
/// shimmer wave as the live header (single-char `shimmer_text` at the given
/// frame), so the thread visibly breathes with the sweep instead of sitting
/// static beside it. History entries pass frame `0`, freezing the rail at a
/// muted tone.
fn think_rail(frame: usize) -> Vec<Span<'static>> {
    let mut rail = shimmer_text("│", frame);
    let mut row = vec![sp("  ")];
    row.append(&mut rail);
    row.push(sp(" "));
    row
}

fn render_thinking_block(
    reasoning: &str,
    expanded: bool,
    live: bool,
    still_streaming: bool,
    frame: usize,
    chat_width: usize,
    duration: Option<f64>,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();

    // Live header mirrors the reference client: a static dim `◆` plus a
    // shimmer sweep across `Thinking...` while running; a finished thought
    // collapses to a dim `◇ Thought for 2.0s` one-liner. The header row stays
    // clickable (expand/collapse).
    let live_thoughts = still_streaming || (reasoning.is_empty() && live);
    let header = if live_thoughts {
        let mut row = vec![sp("  "), sf("◆", MACHINERY()), sp(" ")];
        row.extend(shimmer_text("Thinking...", frame));
        row
    } else {
        let label = match duration {
            Some(d) => format!("Thought for {}", format_duration(d)),
            None => "Thought".to_string(),
        };
        // Reference parity: hollow diamond, dim one-liner. No expand hint; the
        // header row stays toggleable without it.
        vec![
            sp("  "),
            sf("◇", MACHINERY()),
            sp(" "),
            s(label, thinking()),
        ]
    };
    lines.push(Line::from(header));

    // Collapsed preview: one dim line with the newest reasoning tail. Live
    // thoughts stream it under `◆ Thinking...`; finished thoughts keep the same
    // one-line preview under `◇ Thought for X` so the transcript shows what was
    // thought without a click.
    if !expanded && !reasoning.trim().is_empty() {
        let preview = reasoning
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        let budget = chat_width.saturating_sub(6).max(8);
        let preview = crate::widgets::truncate_cells(preview.trim(), budget);
        if !preview.is_empty() {
            let mut row = think_rail(frame);
            row.push(s(preview, thinking()));
            lines.push(Line::from(row));
        }
    }

    if expanded {
        if reasoning.is_empty() && live {
            lines.push(Line::from({
                let mut row = think_rail(frame.wrapping_mul(2));
                row.extend(shimmer_text("...", frame.wrapping_mul(2)));
                row
            }));
        } else {
            // Wrap long thought lines with the shared wrap engine instead of
            // hard-truncating mid-word. One rail per block: every row breathes
            // in the same phase.
            let wrap_w = chat_width.saturating_sub(6).max(8);
            let rail = think_rail(frame);
            for line in reasoning.lines() {
                for row in wrap_line(&Line::from(line.to_string()), wrap_w) {
                    let text: String = row.spans.iter().map(|s| s.content.as_ref()).collect();
                    let text = if text.is_empty() {
                        " ".to_string()
                    } else {
                        text
                    };
                    let mut out = rail.clone();
                    out.push(s(text, thinking()));
                    lines.push(Line::from(out));
                }
            }
        }
        lines.push(Line::from(""));
    }
    lines
}

fn apply_selection_style(
    line: Line<'static>,
    content_line: usize,
    state: &AppState,
) -> Line<'static> {
    if state.ui.selection.is_none() {
        return line;
    }

    // Fast path: nothing on this row is selected, so hand the line back
    // untouched. Every visible line used to be rebuilt whenever a selection
    // existed anywhere, which is half of why styling vanished on drag.
    let total_cols: usize = line
        .spans
        .iter()
        .map(|span| crate::widgets::display_width(span.content.as_ref()))
        .sum();
    if !(0..total_cols).any(|col| state.ui.cell_selected(content_line, col)) {
        return line;
    }

    // Overlay the highlight per character while keeping each span's OWN style.
    // The previous version took `line.spans.first().style` as the base for the
    // whole row, so selecting anything flattened syntax highlighting, bold,
    // headings and code colours into one colour.
    let mut spans = Vec::new();
    let mut col = 0usize;
    for span in &line.spans {
        let style = span.style;
        for ch in span.content.chars() {
            let mut ch_style = style;
            if state.ui.cell_selected(content_line, col) {
                ch_style = ch_style
                    .bg(BG_HOVER())
                    .fg(FG())
                    .add_modifier(Modifier::REVERSED);
            }
            spans.push(Span::styled(ch.to_string(), ch_style));
            // Advance by display width so wide glyphs keep the column map
            // aligned with what the terminal actually paints.
            col += crate::widgets::display_width(ch.encode_utf8(&mut [0u8; 4]));
        }
    }
    Line::from(spans)
}

fn render_scrollbar(frame: &mut Frame, area: Rect, state: &mut AppState) {
    // A modal owns the screen: the chat paints before the overlay, so a bar
    // drawn here would run down the edge across the open card (and grab its
    // clicks). The shared bar also blanks the gutter when everything fits.
    let (total, visible) = if crate::state::modal_owner(state).is_modal() {
        (0, 0)
    } else {
        (state.ui.chat_content_height, state.ui.chat_visible_height)
    };
    super::scrollbar::render(
        frame,
        area,
        super::scrollbar::ScrollSurface::Chat,
        super::scrollbar::Viewport {
            offset: state.ui.chat_scroll,
            visible,
            total,
        },
        BG(),
        &state.ui,
    );
}

// ── Tool verb groups ─────────────────────────────────────────────────────
// A run of ≥3 consecutive finished tool cards that all sit in effective
// Collapsed fold and share a family folds into one summary header row. The
// derivation is a pure function of (entries, fold states, expanded groups), so
// cached blocks invalidate exactly when the frame snapshot fingerprint does.

/// Which tools may share a group. Family peers are visually interchangeable
/// lines of work; `todo_write`/`task`/`present_plan` and unknown tools never
/// group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolFamily {
    Read,
    Run,
    Edit,
}

fn tool_family(tool_name: &str) -> Option<ToolFamily> {
    match super::tool_presentation(tool_name).family {
        Some(super::FamilyKind::Read) => Some(ToolFamily::Read),
        Some(super::FamilyKind::Run) => Some(ToolFamily::Run),
        Some(super::FamilyKind::Edit) => Some(ToolFamily::Edit),
        None => None,
    }
}

/// Minimum run length before compression kicks in — a pair of cards is still
/// readable as-is.
const GROUP_MIN_RUN: usize = 3;

/// Metadata for one derived run of consecutive collapsed tool cards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GroupInfo {
    pub family: ToolFamily,
    /// First member's entry id — the group's toggle key and click identity.
    pub head_id: uuid::Uuid,
    /// History indices of the run's members, in render order. Members are
    /// contiguous in the *rendered* stream, not the raw entry list (pending
    /// call stubs sit between results), so the exact indices are carried.
    pub members: Vec<usize>,
    /// Any member errored (the header gains an `N failed` suffix).
    pub any_error: bool,
    /// The user expanded this group: members render as a dense stack below.
    pub expanded: bool,
}

/// Derive verb groups over the rendered history. `skip` marks invisible
/// entries (pending-call stubs / live tools) — a run stays contiguous across
/// them but breaks at any *rendered* non-tool entry, any Truncated/Expanded
/// member, or a family change.
pub(crate) fn derive_tool_groups(
    entries: &[agente_core::types::ChatEntry],
    skip: &[bool],
    fold_of: &dyn Fn(uuid::Uuid, Option<&str>) -> Fold,
    expanded_groups: &std::collections::HashSet<uuid::Uuid>,
) -> Vec<(usize, usize, GroupInfo)> {
    let mut groups: Vec<(usize, usize, GroupInfo)> = Vec::new();
    let mut run: Vec<usize> = Vec::new();
    let mut run_family: Option<ToolFamily> = None;
    let mut run_error = false;
    // Last rendered (non-skipped) index seen — runs must be contiguous in the
    // rendered stream, not the raw entry list.
    let mut prev_rendered: Option<usize> = None;

    let flush = |run: &mut Vec<usize>,
                 family: &mut Option<ToolFamily>,
                 any_error: &mut bool,
                 out: &mut Vec<(usize, usize, GroupInfo)>| {
        if let (Some(head), Some(family)) = (run.first(), *family) {
            if run.len() >= GROUP_MIN_RUN {
                let head_id = entries[*head].id;
                out.push((
                    *head,
                    run.len(),
                    GroupInfo {
                        family,
                        head_id,
                        members: run.clone(),
                        any_error: *any_error,
                        expanded: expanded_groups.contains(&head_id),
                    },
                ));
            }
        }
        run.clear();
        *family = None;
        *any_error = false;
    };

    for (index, entry) in entries.iter().enumerate() {
        if !skip.is_empty() && skip.get(index).copied().unwrap_or(false) {
            continue;
        }
        let is_tool = entry.role == agente_core::types::Role::Tool && entry.subagent_id.is_none();
        if is_tool {
            let family = tool_family(entry.tool_name.as_deref().unwrap_or(""));
            let collapsed = fold_of(entry.id, entry.tool_name.as_deref()) == Fold::Collapsed
                || expanded_groups.contains(&entry.id)
                || run
                    .first()
                    .is_some_and(|&head| expanded_groups.contains(&entries[head].id));
            let contiguous = match (run.last(), prev_rendered) {
                (Some(&last), Some(prev)) => last == prev,
                _ => false,
            };
            if contiguous && family.is_some() && family == run_family && collapsed {
                run.push(index);
                run_error |= entry.is_error;
            } else {
                flush(&mut run, &mut run_family, &mut run_error, &mut groups);
                if family.is_some() && collapsed {
                    run.push(index);
                    run_family = family;
                    run_error = entry.is_error;
                }
            }
        } else {
            flush(&mut run, &mut run_family, &mut run_error, &mut groups);
        }
        prev_rendered = Some(index);
    }
    flush(&mut run, &mut run_family, &mut run_error, &mut groups);
    groups
}

/// (verb, noun) for a grouped tool's summary phrase.
fn group_verb_noun(tool_name: &str) -> (&'static str, &'static str) {
    let p = super::tool_presentation(tool_name);
    (p.group_verb, p.group_noun)
}

/// The single summary row that replaces a collapsed run of tool cards:
/// ` ◆ Read 3 files · Search 1 pattern` (+ ` · N failed` when a member errored).
/// The reference has no fold chevrons; the member stack below signals expand.
fn render_group_header_block(
    history: &[agente_core::types::ChatEntry],
    info: &GroupInfo,
    width: usize,
    dense_next: bool,
) -> RenderedChatBlock {
    let _ = info.family;
    // Per-verb counts, aggregated in first-appearance (run) order.
    let mut parts: Vec<(&'static str, &'static str, usize)> = Vec::new(); // (verb, noun, count)
    let mut failed = 0usize;
    for &index in &info.members {
        let Some(member) = history.get(index) else {
            continue;
        };
        if member.is_error {
            failed += 1;
        }
        let (verb, noun) = group_verb_noun(member.tool_name.as_deref().unwrap_or(""));
        match parts.iter_mut().find(|(v, _, _)| *v == verb) {
            Some((_, _, count)) => *count += 1,
            None => parts.push((verb, noun, 1)),
        }
    }

    let verb_style = Style::default().fg(FG()).add_modifier(Modifier::BOLD);
    let count_style = Style::default().fg(FG());
    let noun_style = Style::default().fg(DETAIL());
    let mut spans = vec![sp(" "), sf("◆", META())];
    for (i, (verb, noun, count)) in parts.iter().enumerate() {
        spans.push(sp(" "));
        spans.push(s((*verb).to_string(), verb_style));
        spans.push(sp(" "));
        spans.push(s(count.to_string(), count_style));
        spans.push(sp(" "));
        spans.push(s(pluralize_noun(noun, *count), noun_style));
        if i + 1 < parts.len() {
            spans.push(sf(" ·", DETAIL()));
        }
    }
    if failed > 0 {
        spans.push(sf(" · ", DETAIL()));
        spans.push(s(format!("{failed} failed"), Style::default().fg(ERROR())));
    }
    let mut lines = vec![Line::from(spans)];
    if !dense_next && !info.expanded {
        lines.push(themed_blank_row(width));
    }

    let plain = lines
        .iter()
        .map(|line| ChatPlainLine {
            entry_id: Some(info.head_id),
            plain: line
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
                .into(),
            is_thinking: false,
        })
        .collect();

    RenderedChatBlock {
        width,
        user_expanded: false,
        thinking_expanded: false,
        tool_fold: Fold::Collapsed,
        dense_next,
        lines,
        plain,
        regions: vec![(0, 1, ClickKind::ToolGroup, false)],
    }
}

fn pluralize_noun(noun: &str, count: usize) -> String {
    if count == 1 {
        noun.to_string()
    } else {
        format!("{noun}s")
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────
// Span constructors (`s`/`sp`/`sf`), `themed_blank_row`, and the single wrap
// engine (`wrap_line`) live in `widgets/mod.rs` and `widgets/markdown.rs`.

// ── User message: shaded prompt box with `>` ──────────────────────────

fn render_user(
    entry: &agente_core::types::ChatEntry,
    width: usize,
    expanded: bool,
) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    if entry.content.is_empty() && entry.attachments.is_empty() {
        return lines;
    }

    // `▎  Validate the cart total …                4:23 AM` — a card in the
    // panel tone with a full-height accent rail, inset one column from the
    // transcript edges, with a padded row above and below the text so it
    // reads as a bubble, not a band. Hover (painted over the frame by
    // `paint_hover_tint`) lifts it, brightens the rail and swaps the time
    // for the click hint.
    let bg = USER_BUBBLE_BG();
    let rail_style = Style::default().fg(user_rail_color(false)).bg(bg);
    let text_style = Style::default().fg(FG()).bg(bg);
    let hint_style = Style::default().fg(FG_DIM()).bg(bg);
    const INSET: usize = 1;
    let inset = INSET.min(width / 4);
    let box_width = width.saturating_sub(inset * 2).max(8);
    // `▎  ` rail + gap, one column of right padding.
    const LEFT_CHROME: usize = 3;
    let content_width = box_width.saturating_sub(LEFT_CHROME + 1).max(8);

    let content_lines: Vec<&str> = entry.content.lines().collect();
    let total_src_lines = content_lines.len();
    let truncatable = total_src_lines > USER_PREVIEW_LINES;
    let show_lines: Vec<&str> = if truncatable && !expanded {
        content_lines.into_iter().take(USER_PREVIEW_LINES).collect()
    } else {
        content_lines
    };
    let hidden = if truncatable && !expanded {
        total_src_lines.saturating_sub(USER_PREVIEW_LINES)
    } else {
        0
    };

    let mut wrapped_content: Vec<String> = Vec::new();
    for line in &show_lines {
        if line.is_empty() {
            wrapped_content.push(String::new());
        } else {
            for row in wrap_line(&Line::from(line.to_string()), content_width) {
                wrapped_content.push(row.spans.iter().map(|s| s.content.as_ref()).collect());
            }
        }
    }
    if wrapped_content.is_empty() && entry.attachments.is_empty() {
        wrapped_content.push(String::new());
    }

    let margin = Span::styled(" ".repeat(inset), Style::default().bg(BG()));
    let row = |body: Vec<Span<'static>>, trail: Vec<Span<'static>>| -> Line<'static> {
        let mut lead = vec![Span::styled("▎  ", rail_style)];
        lead.extend(body);
        let mut spans = vec![margin.clone()];
        spans.extend(crate::widgets::justify(lead, trail, box_width, bg));
        Line::from(spans)
    };

    lines.push(themed_blank_row(width)); // gap above the message
    lines.push(row(Vec::new(), Vec::new())); // padding inside the card
    for (index, text) in wrapped_content.iter().enumerate() {
        // The time rides the first row, right-aligned inside the band.
        let trail = if index == 0 {
            vec![Span::styled(
                format_time_am_pm(entry.timestamp),
                timestamp().bg(bg),
            )]
        } else {
            Vec::new()
        };
        lines.push(row(vec![Span::styled(text.clone(), text_style)], trail));
    }
    if hidden > 0 {
        lines.push(row(
            vec![Span::styled(format!("▸ +{hidden} lines"), hint_style)],
            Vec::new(),
        ));
    }
    if !entry.attachments.is_empty() {
        // Media under the text (or alone, carrying the time).
        let mut chips = crate::widgets::input::attachment_chips(&entry.attachments, bg);
        chips.remove(0);
        let trail = if wrapped_content.is_empty() {
            vec![Span::styled(
                format_time_am_pm(entry.timestamp),
                timestamp().bg(bg),
            )]
        } else {
            Vec::new()
        };
        lines.push(row(chips, trail));
    }
    lines.push(row(Vec::new(), Vec::new())); // padding inside the card
    lines.push(themed_blank_row(width)); // matching gap below

    lines
}

/// The user bubble's band: one step above the canvas.
#[allow(non_snake_case)]
fn USER_BUBBLE_BG() -> ratatui::style::Color {
    BG_PANEL()
}

/// Rail colour: a muted accent at rest, full accent under the pointer.
fn user_rail_color(hovered: bool) -> ratatui::style::Color {
    if hovered {
        PRIMARY()
    } else {
        blend_colors(PRIMARY(), USER_BUBBLE_BG(), 0.45)
    }
}

// ── Assistant message: content + footer ──────────────────────────────────

fn render_assistant(
    entry: &agente_core::types::ChatEntry,
    width: usize,
    worked_for: Option<f64>,
) -> Vec<Line<'_>> {
    let mut lines = Vec::new();

    // Tool call awaiting a result.
    if let Some(ref tool) = entry.tool_name {
        let tool_icon = tool_icon_for(tool);
        let args_preview = entry
            .tool_args
            .as_ref()
            .map(|a| truncate_cells(a, width.saturating_sub(12).clamp(10, 50)))
            .unwrap_or_default();

        let mut header = vec![
            sp("  "),
            Span::styled(tool_icon, Style::default().fg(PRIMARY())),
            sp("  "),
            Span::styled(tool.clone(), Style::default().fg(FG_MUTED())),
        ];
        if !args_preview.is_empty() {
            header.push(Span::styled(
                format!("  {args_preview}"),
                Style::default().fg(FG_DIM()),
            ));
        }
        lines.push(Line::from(header));
        if !entry.content.is_empty() {
            lines.push(Line::from(""));
        }
    }

    // Content. Errors carry a left rail in the error tone
    // (`┃ Bad request (400): …`), everything else renders as plain markdown.
    if !entry.content.is_empty() {
        if entry.is_error {
            for line in render_markdown_at_width(&entry.content, width.saturating_sub(2)) {
                let mut row = vec![sf("┃ ", ERROR())];
                row.extend(line.spans);
                lines.push(Line::from(row));
            }
        } else {
            for line in render_markdown_at_width(&entry.content, width) {
                lines.push(line);
            }
        }
    }

    // Dim turn summary under the reply — `Worked for 10s`.
    if let Some(ms) = worked_for.filter(|_| !entry.is_error) {
        lines.push(Line::from(vec![
            sp("  "),
            Span::styled(
                format!("Worked for {}", format_worked_for(ms)),
                Style::default().fg(FG_DIM()),
            ),
        ]));
    }

    // Error indicator & actionable guidance.
    if entry.is_error {
        let lower = entry.content.to_lowercase();
        if lower.contains("429") || lower.contains("rate") {
            lines.push(Line::from(vec![
                sp("  "),
                Span::styled(
                    "⚠ Rate limited",
                    Style::default().fg(WARNING()).add_modifier(Modifier::BOLD),
                ),
                Span::styled(" · Try ", Style::default().fg(FG_DIM())),
                Span::styled(
                    "/model",
                    Style::default().fg(PRIMARY()).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    " to switch providers or wait a few moments",
                    Style::default().fg(FG_DIM()),
                ),
            ]));
        } else if lower.contains("context")
            || lower.contains("overflow")
            || lower.contains("too long")
            || lower.contains("max_tokens")
        {
            lines.push(Line::from(vec![
                sp("  "),
                Span::styled(
                    "⚠ Context limit reached",
                    Style::default().fg(WARNING()).add_modifier(Modifier::BOLD),
                ),
                Span::styled(" · Run ", Style::default().fg(FG_DIM())),
                Span::styled(
                    "/compact",
                    Style::default().fg(PRIMARY()).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    " to truncate message history",
                    Style::default().fg(FG_DIM()),
                ),
            ]));
        } else if lower.contains("api key")
            || lower.contains("unauthorized")
            || lower.contains("401")
        {
            lines.push(Line::from(vec![
                sp("  "),
                Span::styled(
                    "✗ Authentication failed",
                    Style::default().fg(ERROR()).add_modifier(Modifier::BOLD),
                ),
                Span::styled(" · Use ", Style::default().fg(FG_DIM())),
                Span::styled(
                    "/provider",
                    Style::default().fg(PRIMARY()).add_modifier(Modifier::BOLD),
                ),
                Span::styled(" to check credentials", Style::default().fg(FG_DIM())),
            ]));
        } else {
            lines.push(Line::from(vec![sp("  "), sf("✗ error", ERROR())]));
        }
    }

    // Cancellation marker for turns the user interrupted mid-stream (errors
    // already carry their own indicator).
    if entry.interrupted && !entry.is_error {
        lines.push(Line::from(vec![sp("  "), sf("⚠ interrupted", DETAIL())]));
    }

    lines
}

/// Right-aligned timestamp row that opens an assistant turn.
fn assistant_timestamp_row(width: usize, ts: chrono::DateTime<chrono::Utc>) -> Line<'static> {
    let time = format_time_am_pm(ts);
    let pad = width.saturating_sub(display_width(&time) + 2);
    Line::from(vec![
        Span::styled(" ".repeat(pad), Style::default().bg(BG())),
        Span::styled(time, timestamp().bg(BG())),
        Span::styled("  ", Style::default().bg(BG())),
    ])
}

/// `8:19 AM` in the terminal's local timezone.
fn format_time_am_pm(ts: chrono::DateTime<chrono::Utc>) -> String {
    let local = ts.with_timezone(&chrono::Local);
    let s = local.format("%I:%M %p").to_string();
    match s.strip_prefix('0') {
        Some(trimmed) => trimmed.to_string(),
        None => s,
    }
}

fn render_system(entry: &agente_core::types::ChatEntry, width: usize) -> Vec<Line<'_>> {
    // Compaction notices read as a quiet divider across the transcript:
    // `── ⟲ Context compacted · ~182k → ~64k · summarized ────────`.
    if let Some(notice) = entry.content.strip_prefix(crate::state::COMPACTION_MARK) {
        let label = format!(" ⟲ {notice} ");
        let lead = 2usize;
        let tail = width.saturating_sub(lead + display_width(&label));
        return vec![
            themed_blank_row(width),
            Line::from(fill_row(
                vec![
                    s("─".repeat(lead), Style::default().fg(BORDER_RULE())),
                    s(label, Style::default().fg(FG_DIM())),
                    s("─".repeat(tail), Style::default().fg(BORDER_RULE())),
                ],
                width,
                BG(),
            )),
            themed_blank_row(width),
        ];
    }
    let mut lines = Vec::new();
    if !entry.content.is_empty() {
        for line in render_markdown(&entry.content) {
            lines.push(line);
        }
    }
    lines
}

/// Body rows previewed when a tool card is in Truncated fold.
const TOOL_PREVIEW_LINES: usize = 3;
/// Head/tail window when a tool card is expanded (display cap only).
const EXPANDED_TOOL_HEAD: usize = 200;
const EXPANDED_TOOL_TAIL: usize = 200;

/// Verb word for the card header grammar. `shell` is bash-style — the command
/// itself is the subject, so it has no verb; unknown tools fall back to their
/// raw name as the verb.
fn tool_verb(tool_name: &str) -> Option<String> {
    let p = super::tool_presentation(tool_name);
    if p.shell_style {
        return None; // shell embeds the command as a `$ ` subject instead
    }
    Some(p.verb.unwrap_or(tool_name).to_string())
}

/// (verb, subject) of the tool-card header. The subject is the extracted
/// target (path / query / url / command), truncated with `…` when it does not
/// fit; `shell` embeds the command in a `$ ` prefix instead of a verb.
pub(crate) fn tool_header_parts(
    tool_name: &str,
    tool_args: Option<&str>,
    width: usize,
) -> (Option<String>, String) {
    let parsed: Option<serde_json::Value> = tool_args.and_then(|a| serde_json::from_str(a).ok());
    let max_target_w = width.saturating_sub(16).clamp(12, 80);
    let str_at = |key: &str| {
        parsed
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_str())
    };

    let p = super::tool_presentation(tool_name);
    let subject = if p.shell_style {
        str_at("command").map_or_else(
            || tool_name.to_string(),
            |cmd| format!("$ {}", truncate_cells(cmd, max_target_w)),
        )
    } else {
        match p.subject {
            Some((key, style)) => str_at(key)
                .map(|value| match style {
                    super::SubjectStyle::Path => {
                        truncate_cells(super::short_path(value), max_target_w)
                    }
                    super::SubjectStyle::Quoted => {
                        format!("\"{}\"", truncate_cells(value, max_target_w))
                    }
                    super::SubjectStyle::Pattern => truncate_cells(value, max_target_w),
                })
                .unwrap_or_default(),
            None => String::new(),
        }
    };
    (tool_verb(tool_name), subject)
}

fn render_tool<'a>(
    entry: &'a agente_core::types::ChatEntry,
    width: usize,
    fold: Fold,
    dense_next: bool,
    tool_args: Option<&str>,
) -> Vec<Line<'a>> {
    let mut lines = Vec::new();

    // Header: ` ◆ Run Read src/lib.rs  [412ms]`. The diamond
    // carries status color; there is no separate ✓/✗ mark and no fold chevron.
    let tool_name = entry.tool_name.as_deref().unwrap_or("tool");

    // Shell results arrive framed as "STDOUT:\n…\nEXIT CODE: N" (see
    // agente_core::tools::exec). Strip the protocol labels for display and
    // surface non-zero exit codes in the header; zero is implied by the marker.
    let (body_lines, exit_code) = if tool_name == "shell" {
        shell_display(&entry.content)
    } else {
        (entry.content.lines().map(str::to_string).collect(), None)
    };

    let effective_args = tool_args.or(entry.tool_args.as_deref());
    let (verb, subject) = tool_header_parts(tool_name, effective_args, width);

    let tool_bg = BG();
    // A single solid diamond in action green (red on failure),
    // then a uniform `Run <verb> <subject>` line in bold near-white.
    let marker_style = Style::default()
        .fg(if entry.is_error { ERROR() } else { META() })
        .bg(tool_bg);
    let verb_style = Style::default()
        .fg(FG())
        .bg(tool_bg)
        .add_modifier(Modifier::BOLD);
    let subject_style =
        Style::default()
            .fg(FG())
            .bg(tool_bg)
            .add_modifier(if fold == Fold::Expanded {
                Modifier::BOLD
            } else {
                Modifier::empty()
            });

    let mut header_spans = vec![
        Span::styled(" ", Style::default().bg(tool_bg)),
        Span::styled("◆", marker_style),
        Span::styled(" ", Style::default().bg(tool_bg)),
    ];
    // Uniform grammar: `Run <verb>`; shell embeds the command as the subject,
    // unknown tools keep their raw name as the verb.
    let action = match verb {
        Some(verb) => format!("Run {verb}"),
        None => "Run".to_string(),
    };
    header_spans.push(Span::styled(action, verb_style));
    if !subject.is_empty() {
        header_spans.push(Span::styled(" ", Style::default().bg(tool_bg)));
        header_spans.push(Span::styled(subject, subject_style));
    }

    // Meta suffixes use the reference's green bracket grammar. Diff stats keep
    // their semantic colors; a non-zero exit stays fully red.
    let bracket = Style::default()
        .fg(META())
        .bg(tool_bg)
        .add_modifier(Modifier::DIM);
    if let Some((additions, deletions)) = entry.diff_stats {
        header_spans.push(Span::styled("  [", bracket));
        header_spans.push(Span::styled(
            format!("+{additions}"),
            Style::default().fg(SUCCESS()).bg(tool_bg),
        ));
        header_spans.push(Span::styled("/", bracket));
        header_spans.push(Span::styled(
            format!("-{deletions}"),
            Style::default().fg(ERROR()).bg(tool_bg),
        ));
        header_spans.push(Span::styled("]", bracket));
    }
    if let Some(d) = entry.response_duration {
        header_spans.push(Span::styled("  [", bracket));
        header_spans.push(Span::styled(
            format_duration(d),
            Style::default().fg(META()).bg(tool_bg),
        ));
        header_spans.push(Span::styled("]", bracket));
    }
    if let Some(code) = exit_code.filter(|code| *code != 0) {
        header_spans.push(Span::styled(
            format!("  [exit {code}]"),
            Style::default().fg(ERROR()).bg(tool_bg),
        ));
    }
    let header_spans = fill_row(header_spans, width, tool_bg);

    lines.push(Line::from(header_spans));

    // Three-state body. Truncated shows the first rows — the head of a result
    // is the useful part while scanning. Expanded shows a head+tail window so
    // a huge result can never flood the transcript. Truncation is display-only
    // — the full text stays in the conversation.
    if !body_lines.is_empty() {
        let body_width = width.saturating_sub(4);
        let push_body = |lines: &mut Vec<Line<'_>>, line: &str| {
            lines.push(Line::from(vec![
                sp("    "),
                Span::styled(
                    truncate_cells(line, body_width),
                    Style::default().fg(FG_MUTED()),
                ),
            ]));
        };
        // Edit previews: `write_file`/`edit_file`/`apply_patch` show a
        // short guttered code preview (numbers + active-line tint) instead of
        // plain muted rows, echoing `42 … 44(highlight) … 47`. Numbers are
        // preview-relative; the full diff lives in approval/diff-peek.
        let is_edit_preview = matches!(tool_name, "write_file" | "edit_file" | "apply_patch");
        let push_edit_preview = |lines: &mut Vec<Line<'_>>, preview: &[String]| {
            let gutter_w = preview.len().to_string().len().max(2);
            for (i, line) in preview.iter().enumerate() {
                let active = i == 0 && preview.len() > 1;
                let row_bg = if active { BG_ELEMENT() } else { BG() };
                let num = format!("{:>width$} ", i + 1, width = gutter_w);
                let mut spans = vec![
                    sp("    "),
                    Span::styled(num, Style::default().fg(FG_DIM()).bg(row_bg)),
                    Span::styled(
                        truncate_cells(line, body_width.saturating_sub(gutter_w + 1)),
                        Style::default()
                            .fg(if active { FG() } else { FG_MUTED() })
                            .bg(row_bg),
                    ),
                ];
                let used: usize = spans
                    .iter()
                    .map(|s| display_width(s.content.as_ref()))
                    .sum();
                spans.push(Span::styled(
                    " ".repeat(width.saturating_sub(used)),
                    Style::default().bg(row_bg),
                ));
                lines.push(Line::from(spans));
            }
        };

        match fold {
            Fold::Collapsed => {}
            Fold::Truncated => {
                if is_edit_preview {
                    const EDIT_PREVIEW_LINES: usize = 6;
                    let preview: Vec<String> = body_lines
                        .iter()
                        .take(EDIT_PREVIEW_LINES)
                        .cloned()
                        .collect();
                    let total_lines = entry.content.lines().count();
                    push_edit_preview(&mut lines, &preview);
                    if total_lines > EDIT_PREVIEW_LINES {
                        let hidden = total_lines - EDIT_PREVIEW_LINES;
                        lines.push(Line::from(vec![
                            sp("    "),
                            Span::styled(
                                format!("… +{hidden} lines · click to expand"),
                                Style::default().fg(DETAIL()),
                            ),
                        ]));
                    }
                } else {
                    for line in body_lines.iter().take(TOOL_PREVIEW_LINES) {
                        push_body(&mut lines, line);
                    }
                    if body_lines.len() > TOOL_PREVIEW_LINES {
                        let hidden = body_lines.len() - TOOL_PREVIEW_LINES;
                        lines.push(Line::from(vec![
                            sp("    "),
                            Span::styled(
                                format!("… +{hidden} lines · click to expand"),
                                Style::default().fg(DETAIL()),
                            ),
                        ]));
                    }
                }
            }
            Fold::Expanded => {
                let total = body_lines.len();
                let head = total.min(EXPANDED_TOOL_HEAD);
                let tail = total.saturating_sub(head).min(EXPANDED_TOOL_TAIL);
                let omitted = total - head - tail;
                for line in body_lines.iter().take(head) {
                    push_body(&mut lines, line);
                }
                if omitted > 0 {
                    lines.push(Line::from(vec![
                        sp("    "),
                        Span::styled(
                            format!("… {omitted} lines omitted …"),
                            Style::default().fg(DETAIL()),
                        ),
                    ]));
                }
                for line in body_lines.iter().skip(total - tail) {
                    push_body(&mut lines, line);
                }
                lines.push(Line::from(vec![
                    sp("    "),
                    Span::styled("▴ collapse", Style::default().fg(DETAIL())),
                ]));
            }
        }
    }

    if let Some(asset) = extract_media_path(&entry.content) {
        lines.push(Line::from(vec![
            sp("    "),
            Span::styled(
                " [Open] ",
                Style::default()
                    .fg(PRIMARY())
                    .bg(BG_HOVER())
                    .add_modifier(Modifier::BOLD),
            ),
            sp(" "),
            Span::styled(
                truncate_cells(&asset, width.saturating_sub(14)),
                Style::default().fg(FG_MUTED()),
            ),
        ]));
    }

    // Gap rhythm: consecutive dense (collapsed) tool cards stack without a
    // blank row between them; everything else keeps its breathing room.
    if !dense_next {
        lines.push(themed_blank_row(width));
    }

    lines
}

/// Look for a generated image, SVG, HTML, or media asset file in tool output or message text.
pub fn extract_media_path(text: &str) -> Option<String> {
    const EXTENSIONS: &[&str] = &[
        ".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".bmp", ".html", ".pdf",
    ];

    for word in text.split_whitespace() {
        let clean = word.trim_matches(|c: char| {
            c == '\''
                || c == '"'
                || c == '`'
                || c == '('
                || c == ')'
                || c == '['
                || c == ']'
                || c == '<'
                || c == '>'
        });
        let lower = clean.to_lowercase();
        if EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
            && clean.len() >= 4
            && !clean.starts_with("http://")
            && !clean.starts_with("https://")
        {
            return Some(clean.to_string());
        }
    }
    None
}

/// De-frame a shell tool result for display: drops the `STDOUT:`/`STDERR:`
/// label lines and the trailing `EXIT CODE: N` line, returning the visible
/// output lines and the exit code. `None` when the framing is absent (e.g.
/// results truncated by the core before the exit-code line was appended).
fn shell_display(content: &str) -> (Vec<String>, Option<i32>) {
    let mut display = Vec::new();
    let mut exit_code = None;
    for line in content.lines() {
        if let Some(code) = line.strip_prefix("EXIT CODE: ") {
            exit_code = code.trim().parse::<i32>().ok();
            continue;
        }
        if line == "STDOUT:" || line == "STDERR:" {
            continue;
        }
        display.push(line.to_string());
    }
    (display, exit_code)
}

/// Subagent card in the transcript grammar — flat canvas, like tool rows:
///
/// ```text
///  ⧗ Explore  Find every provider retry call site         running · 12.0s
///    └ Read providers/openai.rs · 2 tools · wt
/// ```
///
/// The card is anchored by a `ChatEntry` carrying a `subagent_id`; live state
/// comes from the `SubagentUiState` map. Clicking opens the detail modal,
/// which is where history lives.
fn render_subagent(
    entry: &agente_core::types::ChatEntry,
    width: usize,
    ui: Option<&crate::state::SubagentUiState>,
    _expanded: bool,
) -> Vec<Line<'static>> {
    use crate::widgets::SubagentStatusKind;
    let bg = BG();
    let on = |style: Style| style.bg(bg);
    let status = ui.map(|u| u.status.as_str()).unwrap_or(if entry.is_error {
        "failed"
    } else {
        "completed"
    });
    let kind = SubagentStatusKind::from_status(status);
    let type_label = capitalize_label(entry.subagent_type.as_deref().unwrap_or("subagent"));
    let description = ui.map(|u| u.description.as_str()).unwrap_or(&entry.content);

    // One-column inset, aligned with the `◆` of ordinary tool rows.
    let mut lead = vec![
        Span::styled(" ", on(Style::default())),
        Span::styled(kind.glyph(), on(Style::default().fg(kind.color()))),
        Span::styled(" ", on(Style::default())),
        Span::styled(
            type_label,
            on(Style::default().fg(FG()).add_modifier(Modifier::BOLD)),
        ),
    ];
    let first_line = description.lines().next().unwrap_or("");
    if !first_line.is_empty() {
        lead.push(Span::styled(
            format!("  {first_line}"),
            on(Style::default().fg(FG_MUTED())),
        ));
    }
    let mut status_text = kind.label().to_string();
    if let Some(ms) = ui.and_then(|u| u.elapsed_ms()) {
        status_text.push_str(&format!(" · {}", format_duration(ms)));
    }
    if let Some(cost) = ui.and_then(|u| u.spend.cost_label()) {
        status_text.push_str(&format!(" · {cost}"));
    }
    let header = crate::widgets::justify(
        lead,
        vec![Span::styled(status_text, on(Style::default().fg(FG_DIM())))],
        width,
        bg,
    );

    // `└ <current activity> · N tools · wt`. Failures say why in red.
    let activity_style = if kind == SubagentStatusKind::Failed {
        Style::default().fg(ERROR())
    } else {
        Style::default().fg(FG_MUTED())
    };
    let mut detail = vec![
        Span::styled("   └ ", on(Style::default().fg(FG_DIM()))),
        Span::styled(
            subagent_activity(ui, width.saturating_sub(5)),
            on(activity_style),
        ),
    ];
    if let Some(ui) = ui {
        let count = ui.tool_rows.len();
        if count > 0 {
            detail.push(Span::styled(
                format!(" · {count} tool{}", if count == 1 { "" } else { "s" }),
                on(Style::default().fg(FG_DIM())),
            ));
        }
        if let Some(wt) = &ui.worktree {
            detail.push(Span::styled(
                if wt.dirty { " · wt*" } else { " · wt" },
                on(Style::default().fg(FG_DIM())),
            ));
        }
    }

    vec![
        Line::from(header),
        Line::from(fill_row(detail, width, bg)),
        themed_blank_row(width),
    ]
}

/// `explore` to `Explore`; other labels keep their shape after the first char.
fn capitalize_label(label: &str) -> String {
    let mut chars = label.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Only the current activity is needed by the card and its invalidation key.
fn subagent_activity(ui: Option<&crate::state::SubagentUiState>, width: usize) -> String {
    let Some(ui) = ui else {
        return "Saved result · open details".to_string();
    };
    if ui.status_kind() == crate::widgets::SubagentStatusKind::Queued {
        return truncate_cells("queued · waiting for a slot", width);
    }
    if !ui.is_running() {
        return truncate_cells(
            ui.summary
                .as_deref()
                .unwrap_or("Finished")
                .lines()
                .next()
                .unwrap_or(""),
            width,
        );
    }
    if let Some(tool) = &ui.preparing_tool {
        return truncate_cells(&format!("Preparing {tool}…"), width);
    }
    if let Some(row) = ui.tool_rows.last() {
        let (verb, subject) = tool_header_parts(&row.name, Some(&row.args), width);
        let action = verb.unwrap_or_else(|| row.name.clone());
        let label = if subject.is_empty() {
            action
        } else {
            format!("{action} {subject}")
        };
        return truncate_cells(&label, width);
    }
    let latest = ui
        .streaming_text
        .trim_end()
        .rsplit('\n')
        .next()
        .unwrap_or("");
    if latest.is_empty() {
        "Thinking…".to_string()
    } else {
        truncate_cells(latest, width)
    }
}

// ── Text helpers ─────────────────────────────────────────────────────────

fn format_duration(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{ms:.0}ms")
    } else {
        format!("{:.1}s", ms / 1000.0)
    }
}

/// Whole-turn wall clock for the assistant reply at `index`: the gap between
/// the nearest preceding user message and this entry's commit timestamp.
/// `None` for tool stubs, errors, subagent cards, and sub-second turns.
fn worked_for_duration(history: &[agente_core::types::ChatEntry], index: usize) -> Option<f64> {
    let entry = history.get(index)?;
    if entry.role != agente_core::types::Role::Assistant
        || entry.content.is_empty()
        || entry.is_error
        || entry.subagent_id.is_some()
    {
        return None;
    }
    let start = history[..index]
        .iter()
        .rev()
        .find(|e| e.role == agente_core::types::Role::User)?
        .timestamp;
    let ms = (entry.timestamp - start).num_milliseconds();
    (ms >= 1000).then_some(ms as f64)
}

/// `Worked for` uses whole seconds (`10s`), unlike tool timings (`412ms`).
fn format_worked_for(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{ms:.0}ms")
    } else {
        format!("{:.0}s", ms / 1000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_spawn_results_hide_behind_their_subagent_card() {
        let card = agente_core::types::ChatEntry {
            subagent_id: Some("a4fd3374".into()),
            ..tool_entry("task", "Explore the repo", None)
        };
        let echo = tool_entry(
            "task",
            "Subagent a4fd3374 (running) started.\nstatus: running",
            None,
        );
        let unrelated = tool_entry("task", "Subagent zzzz started.", None);
        let history = vec![card, echo, unrelated];
        let ctx = HistoryRenderCtx {
            live_tools: &std::collections::HashMap::new(),
            subagents: &std::collections::HashMap::new(),
        };
        assert_eq!(skipped_entries(&history, &ctx), vec![false, true, false]);
    }

    #[test]
    fn subagent_card_stays_compact_with_long_history() {
        let mut entry = tool_entry("task", "Explore", None);
        entry.subagent_id = Some("child".into());
        entry.subagent_type = Some("explore".into());
        let mut ui = SubagentUiState {
            status: "running".into(),
            description: "Explore the project".into(),
            streaming_text: "old output\n".repeat(10_000),
            ..Default::default()
        };
        ui.tool_rows = (0..10_000)
            .map(|i| crate::state::SubagentToolRow {
                call_id: i.to_string(),
                name: "read_file".into(),
                args: format!(r#"{{"path":"src/file{i}.rs"}}"#),
                result: Some("large output\n".repeat(10)),
                is_error: false,
                finished: true,
            })
            .collect();
        for width in [1, 3, 20, 60, 100] {
            let lines = render_subagent(&entry, width, Some(&ui), true);
            assert_eq!(lines.len(), 3, "header + activity + gap");
            assert!(lines.iter().all(|line| line.width() <= width));
            assert!(
                lines[..2]
                    .iter()
                    .flat_map(|line| &line.spans)
                    .all(|span| span.style.bg == Some(BG())),
                "flat canvas, no band"
            );
        }
        // `⧗ Explore  desc ··· running` then `└ <activity> · 10000 tools`.
        let text = |line: &Line<'static>| -> String {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect()
        };
        let lines = render_subagent(&entry, 100, Some(&ui), false);
        let row1 = text(&lines[0]);
        assert!(
            row1.contains("Explore  Explore the project"),
            "row1: {row1:?}"
        );
        assert!(row1.trim_end().ends_with("running"), "row1: {row1:?}");
        let row2 = text(&lines[1]);
        assert!(row2.starts_with("   └ Read"), "row2: {row2:?}");
        assert!(row2.contains("· 10000 tools"), "row2: {row2:?}");
        assert!(subagent_activity(Some(&ui), 100).contains("file9999"));
        let mut map = std::collections::HashMap::from([("child".into(), ui)]);
        let before = subagent_fingerprint(&map, 100);
        map.get_mut("child").unwrap().tool_rows[0].result = Some("changed old output".into());
        assert_eq!(before, subagent_fingerprint(&map, 100));
    }

    #[test]
    fn expanded_group_survives_opening_a_child_and_keeps_line_alignment() {
        let entries: Vec<_> = (0..3).map(|_| tool_entry("grep", "output", None)).collect();
        let expanded = HashSet::from([entries[0].id]);
        let groups = derive_tool_groups(
            &entries,
            &[],
            &|id, _| {
                if id == entries[1].id {
                    Fold::Expanded
                } else {
                    Fold::Collapsed
                }
            },
            &expanded,
        );
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].2.members.len(), 3);
        for expanded in [false, true] {
            let mut info = groups[0].2.clone();
            info.expanded = expanded;
            let block = render_group_header_block(&entries, &info, 80, false);
            assert_eq!(block.lines.len(), block.plain.len());
        }
    }

    #[test]
    fn click_regions_keep_absolute_offsets_beyond_u16() {
        let history = vec![tool_entry("grep", "found", None)];
        let ctx = HistoryRenderCtx {
            live_tools: &std::collections::HashMap::new(),
            subagents: &std::collections::HashMap::new(),
        };
        let mut ui = UiState::default();
        let mut blocks = Vec::new();
        let mut regions = Vec::new();
        let mut height = 70_000;
        render_history_range(
            &history,
            0,
            80,
            HistoryFrame {
                ctx: &ctx,
                skipped: &[false],
                groups: &[],
            },
            &mut ui,
            HistorySink {
                blocks: &mut blocks,
                regions: &mut regions,
                height: &mut height,
            },
        );
        assert_eq!(regions[0].0.content_start, 70_000);
        assert!(regions[0].0.content_end >= 70_000);
    }

    /// Assistant layout: an assistant block leads with a blank row and a
    /// right-aligned timestamp row, and no row carries a card background.
    #[test]
    fn assistant_block_is_borderless_with_timestamp() {
        use std::collections::HashMap;
        let long = "I'm doing great, thanks for asking! I'm ready to help with whatever you need - whether it's coding, planning, research, or answering questions. What can I do for you today?";
        let entry = agente_core::types::ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: agente_core::types::Role::Assistant,
            content: long.to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: Some(3300.0),
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        };
        let width = 60;
        let block = render_entry_block(
            &entry,
            width,
            false,
            false,
            Fold::Collapsed,
            false,
            &HashMap::new(),
            None,
            None,
        );
        assert!(block.lines.len() >= 4, "blank + timestamp + body");
        // Borderless means every row sits on the flat canvas: spans carry
        // no bg or the canvas BG (the old card bg is now aliased to BG).
        for (i, line) in block.lines.iter().enumerate() {
            for span in &line.spans {
                assert!(
                    span.style.bg.is_none_or(|bg| bg == BG()),
                    "row {i} still carries a card bg: {:?}",
                    span.content
                );
            }
        }
        // Row 1 (after the blank) is the right-aligned timestamp row.
        let ts_text: String = block.lines[1]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(
            ts_text.trim().ends_with("AM") || ts_text.trim().ends_with("PM"),
            "got: {ts_text}"
        );
        let ts_used: usize = block.lines[1]
            .spans
            .iter()
            .map(|s| display_width(s.content.as_ref()))
            .sum();
        assert_eq!(ts_used, width, "timestamp row must span full width");
        // Body rows wrap within the width.
        for (i, line) in block.lines.iter().enumerate().skip(2) {
            let used: usize = line
                .spans
                .iter()
                .map(|s| display_width(s.content.as_ref()))
                .sum();
            assert!(used <= width, "body row {i} exceeds chat width, got {used}");
        }
    }

    /// A thought stays glued to its own text: the timestamp chrome moves
    /// above the thinking header and the blank lead is dropped, so no dead
    /// rows divorce the `Thought …` row from the body that follows it.
    #[test]
    fn thought_with_body_has_no_blank_between_them() {
        use std::collections::HashMap;
        let entry = agente_core::types::ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: agente_core::types::Role::Assistant,
            content: "The tool is restricting access to paths outside the project dir".to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: Some(9200.0),
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: Some("checking the workspace layout first".to_string()),
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        };
        let width = 100;
        let block = render_entry_block(
            &entry,
            width,
            false,
            false,
            Fold::Collapsed,
            false,
            &HashMap::new(),
            None,
            None,
        );
        let text: Vec<String> = block
            .lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        // timestamp, thought header, one-line preview, body — no blanks.
        assert_eq!(text.len(), 4, "got: {text:?}");
        assert!(
            text[0].trim().ends_with("AM") || text[0].trim().ends_with("PM"),
            "row 0 is the timestamp: {:?}",
            text[0]
        );
        assert!(text[1].contains("Thought for"), "got: {:?}", text[1]);
        assert!(
            text[2].contains("checking the workspace layout first"),
            "row 2 is the collapsed preview: {text:?}"
        );
        assert!(
            text[3].contains("restricting access"),
            "thought must sit directly above its body: {text:?}"
        );
        assert!(
            text.iter().all(|row| !row.trim().is_empty()),
            "no blank rows between thought and body: {text:?}"
        );
    }

    #[test]
    fn render_entry_block_is_deterministic() {
        use std::collections::HashMap;
        let entry = agente_core::types::ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: agente_core::types::Role::Assistant,
            content: "**bold** and `code`\n\n- list one\n- list two".to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: Some(1234.0),
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        };
        let subagents = HashMap::new();
        let a = render_entry_block(
            &entry,
            60,
            false,
            false,
            Fold::Collapsed,
            false,
            &subagents,
            None,
            None,
        );
        let b = render_entry_block(
            &entry,
            60,
            false,
            false,
            Fold::Collapsed,
            false,
            &subagents,
            None,
            None,
        );
        assert!(!a.lines.is_empty());
        // Same inputs ⇒ identical parsed output (so the cache is safe to reuse).
        assert_eq!(a.lines.len(), b.lines.len());
        let join = |block: &RenderedChatBlock| -> String {
            block
                .lines
                .iter()
                .map(|l| {
                    l.spans
                        .iter()
                        .map(|s| s.content.as_ref())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(join(&a), join(&b));
        // Width affects wrapping, so a different width must differ.
        let c = render_entry_block(
            &entry,
            20,
            false,
            false,
            Fold::Collapsed,
            false,
            &subagents,
            None,
            None,
        );
        assert!(join(&c) != join(&a));
        // Plain mirror has same row count as the display lines.
        assert_eq!(a.lines.len(), a.plain.len());
    }

    #[test]
    fn chat_cache_roundtrip_and_mismatch() {
        let mut ui = crate::state::UiState::default();
        let id = uuid::Uuid::new_v4();
        let block = RenderedChatBlock {
            width: 60,
            user_expanded: false,
            thinking_expanded: false,
            tool_fold: Fold::Collapsed,
            dense_next: false,
            lines: Vec::new(),
            plain: Vec::new(),
            regions: Vec::new(),
        };
        ui.chat_cache_put(id, block);
        // Matching inputs hit; a changed flag (fold/dense/hover/width) misses.
        assert!(ui
            .chat_cache_get(
                &id,
                crate::state::ChatCacheKey {
                    width: 60,
                    user_expanded: false,
                    thinking_expanded: false,
                    tool_fold: Fold::Collapsed,
                    dense_next: false
                }
            )
            .is_some());
        assert!(ui
            .chat_cache_get(
                &id,
                crate::state::ChatCacheKey {
                    width: 60,
                    user_expanded: false,
                    thinking_expanded: false,
                    tool_fold: Fold::Expanded,
                    dense_next: false
                }
            )
            .is_none());
        assert!(ui
            .chat_cache_get(
                &id,
                crate::state::ChatCacheKey {
                    width: 60,
                    user_expanded: false,
                    thinking_expanded: false,
                    tool_fold: Fold::Collapsed,
                    dense_next: true
                }
            )
            .is_none());
        assert!(ui
            .chat_cache_get(
                &id,
                crate::state::ChatCacheKey {
                    width: 40,
                    user_expanded: false,
                    thinking_expanded: false,
                    tool_fold: Fold::Collapsed,
                    dense_next: false
                }
            )
            .is_none());
    }

    #[test]
    fn shell_display_strips_framing_and_keeps_output() {
        let (lines, code) = shell_display("STDOUT:\nok\nEXIT CODE: 0");
        assert_eq!(lines, vec!["ok"]);
        assert_eq!(code, Some(0));
    }

    #[test]
    fn shell_display_surfaces_nonzero_exit_and_stderr() {
        let (lines, code) = shell_display("STDOUT:\nboom\nSTDERR:\npanic!\nEXIT CODE: 2");
        assert_eq!(lines, vec!["boom", "panic!"]);
        assert_eq!(code, Some(2));
    }

    #[test]
    fn shell_display_passthrough_without_framing() {
        let (lines, code) = shell_display("plain output\nno framing");
        assert_eq!(lines, vec!["plain output", "no framing"]);
        assert_eq!(code, None);
    }

    #[test]
    fn shell_display_handles_truncated_exit_code() {
        // Core truncates huge outputs; the "EXIT CODE:" tail may be cut off.
        let (lines, code) = shell_display("STDOUT:\npartial…");
        assert_eq!(lines, vec!["partial…"]);
        assert_eq!(code, None);
    }

    fn tool_entry(tool: &str, content: &str, args: Option<&str>) -> agente_core::types::ChatEntry {
        agente_core::types::ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: agente_core::types::Role::Tool,
            content: content.to_string(),
            tool_name: Some(tool.to_string()),
            tool_args: args.map(str::to_string),
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: None,
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        }
    }

    fn join_first_line(lines: &[Line<'_>]) -> String {
        lines[0].spans.iter().map(|s| s.content.as_ref()).collect()
    }

    /// A collapsed thought header that wraps (degenerate narrow terminal)
    /// keeps every visual row clickable — the region must span the wrapped
    /// rows, not just the first.
    #[test]
    fn collapsed_thought_region_covers_wrapped_header() {
        use std::collections::HashMap;
        let entry = agente_core::types::ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: agente_core::types::Role::Assistant,
            content: String::new(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: Some(9_200.0),
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: Some("checking the workspace layout first".to_string()),
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        };
        // 16 cols forces the ~20-col header onto two visual rows; the
        // collapsed preview adds the third.
        let block = render_entry_block(
            &entry,
            16,
            false,
            false,
            Fold::Collapsed,
            false,
            &HashMap::new(),
            None,
            None,
        );
        assert_eq!(block.lines.len(), 3, "header must wrap: {block:?}");
        let thinking: Vec<_> = block
            .regions
            .iter()
            .filter(|(_, _, kind, _)| *kind == ClickKind::Thinking)
            .collect();
        assert_eq!(thinking.len(), 1);
        assert_eq!((thinking[0].0, thinking[0].1), (0, 3));
    }

    /// A shell card is headed by the command, not the tool name.
    #[test]
    fn shell_card_header_shows_command() {
        let entry = tool_entry(
            "shell",
            "STDOUT:\nok\nEXIT CODE: 0",
            Some(r#"{"command":"cargo build"}"#),
        );
        let lines = render_tool(
            &entry,
            60,
            Fold::Truncated,
            false,
            Some(r#"{"command":"cargo build"}"#),
        );
        let header = join_first_line(&lines);
        assert!(header.contains("$ cargo build"), "header: {header:?}");
        assert!(!header.contains("shell"), "generic name leaked: {header:?}");
    }

    /// Without args the card falls back to the tool name.
    #[test]
    fn shell_card_header_falls_back_to_tool_name() {
        let entry = tool_entry("shell", "STDOUT:\nok\nEXIT CODE: 0", None);
        let lines = render_tool(&entry, 60, Fold::Truncated, false, None);
        assert!(join_first_line(&lines).contains("shell"));
    }

    /// Write/edit cards carry a `+A/-B` badge in the collapsed header.
    #[test]
    fn edit_card_header_shows_diff_stats() {
        let mut entry = tool_entry("edit_file", "Successfully edited src/lib.rs", None);
        entry.diff_stats = Some((3, 1));
        let lines = render_tool(&entry, 60, Fold::Collapsed, false, None);
        let header = join_first_line(&lines);
        assert!(header.contains("+3"), "header: {header:?}");
        assert!(header.contains("/-1"), "header: {header:?}");
    }

    /// Header grammar: `<verb> <subject>` — the verb owns the action word and
    /// the subject is the bare target.
    /// A tool-card header is exactly one row at any width.
    ///
    /// It used to be padded but never trimmed, so a long path plus a trailing
    /// duration overflowed and the generic wrapper broke it onto a second,
    /// un-indented line — `412ms` alone in column 1 (harness shot
    /// `sidebar_both_80x24.txt`).
    /// Selecting text must not strip styling from the rest of the transcript.
    ///
    /// `apply_selection_style` used to rebuild every visible line using only
    /// the FIRST span's style, so the moment a selection existed anywhere,
    /// syntax highlighting, bold and heading colours collapsed into one colour
    /// across the whole chat.
    #[test]
    fn selection_preserves_unselected_span_styles() {
        use ratatui::style::Color;

        let line = Line::from(vec![
            Span::styled("fn ", Style::default().fg(Color::Magenta)),
            Span::styled("main", Style::default().fg(Color::Blue)),
            Span::styled("() {", Style::default().fg(Color::Green)),
        ]);

        let mut state = crate::state::AppState::new(
            agente_core::config::AppConfig::default(),
            "/tmp/sel".into(),
        );
        // A selection exists, but on a different row than the one we render.
        state.ui.selection = Some(crate::state::ChatSelection {
            start_line: 99,
            start_col: 0,
            end_line: 99,
            end_col: 4,
        });

        let styled = apply_selection_style(line.clone(), 0, &state);
        let colours: Vec<Option<Color>> = styled.spans.iter().map(|s| s.style.fg).collect();

        assert!(
            colours.contains(&Some(Color::Magenta))
                && colours.contains(&Some(Color::Blue))
                && colours.contains(&Some(Color::Green)),
            "styles were flattened: {colours:?}"
        );
    }

    #[test]
    fn tool_card_header_never_wraps_to_a_second_row() {
        let entry = agente_core::types::ChatEntry {
            response_duration: Some(412.0),
            ..tool_entry(
                "read_file",
                "1  use reqwest::Client;",
                Some(r#"{"path":"crates/agente-core/src/providers/a_very_long_module_name.rs"}"#),
            )
        };

        for width in [28usize, 40, 52, 60, 80] {
            let block = render_entry_block(
                &entry,
                width,
                false,
                false,
                Fold::Collapsed,
                false,
                &std::collections::HashMap::new(),
                None,
                None,
            );
            // The collapsed card is header-only; every produced row must fit.
            for (row, line) in block.lines.iter().enumerate() {
                let cells: usize = line
                    .spans
                    .iter()
                    .map(|sp| crate::widgets::display_width(sp.content.as_ref()))
                    .sum();
                assert!(
                    cells <= width,
                    "row {row} is {cells} cells wide at width {width}: {:?}",
                    line.spans
                        .iter()
                        .map(|sp| sp.content.as_ref())
                        .collect::<String>()
                );
            }
        }
    }

    #[test]
    fn tool_header_grammar_uses_verb_plus_subject() {
        let read = tool_entry("read_file", "ok", Some(r#"{"path":"src/lib.rs"}"#));
        let header = join_first_line(&render_tool(&read, 60, Fold::Collapsed, true, None));
        assert!(header.contains("Run Read src/lib.rs"), "header: {header:?}");
        assert!(!header.contains("read_file"), "raw name leaked: {header:?}");
        assert!(
            !header.contains('✓') && !header.contains('✗'),
            "no status marks: {header:?}"
        );

        let grep = tool_entry("grep", "ok", Some(r#"{"query":"retry"}"#));
        let header = join_first_line(&render_tool(&grep, 60, Fold::Collapsed, true, None));
        assert!(
            header.contains("Run Search \"retry\""),
            "header: {header:?}"
        );

        // Unknown tools show their raw name as the verb.
        let custom = tool_entry("custom_tool", "ok", None);
        let header = join_first_line(&render_tool(&custom, 60, Fold::Collapsed, true, None));
        assert!(header.contains("Run custom_tool"), "header: {header:?}");
    }

    /// Collapsed fold is header-only (the trailing gap row is dropped when the
    /// next block is another dense tool card).
    #[test]
    fn collapsed_tool_card_is_header_only() {
        let entry = tool_entry("grep", "row1\nrow2\nrow3\nrow4", Some(r#"{"query":"x"}"#));
        let dense = render_tool(&entry, 60, Fold::Collapsed, true, None);
        assert_eq!(dense.len(), 1, "header only, no gap: {dense:?}");
        let lone = render_tool(&entry, 60, Fold::Collapsed, false, None);
        assert_eq!(lone.len(), 2, "header + trailing gap row");
        let body: String = dense.iter().map(|l| line_text(l)).collect();
        assert!(!body.contains("row2"), "no body rows when collapsed");
    }

    /// Truncated fold shows the first rows plus a `+N lines` hint.
    #[test]
    fn truncated_tool_card_shows_three_rows_and_hint() {
        let body: Vec<String> = (1..=10).map(|i| format!("row {i}")).collect();
        let entry = tool_entry("grep", &body.join("\n"), Some(r#"{"query":"x"}"#));
        let lines = render_tool(&entry, 60, Fold::Truncated, false, None);
        let text: Vec<String> = lines.iter().map(|l| line_text(l)).collect();
        // header + 3 preview rows + hint + trailing gap
        assert_eq!(lines.len(), 6, "rows: {text:?}");
        assert!(text[1].contains("row 1"));
        assert!(text[3].contains("row 3"));
        assert!(!text.join("\n").contains("row 4"), "preview stops at 3");
        assert!(
            text[4].contains("… +7 lines · click to expand"),
            "hint: {:?}",
            text[4]
        );

        // Short results show everything with no hint row.
        let short = tool_entry("grep", "only line", Some(r#"{"query":"x"}"#));
        let lines = render_tool(&short, 60, Fold::Truncated, true, None);
        assert_eq!(lines.len(), 2, "header + preview row, no hint, no gap");
    }

    /// Expanded fold keeps the head/tail window so huge results stay bounded.
    #[test]
    fn expanded_shell_card_keeps_head_and_tail_window() {
        let body: Vec<String> = (1..=410).map(|i| format!("line {i}")).collect();
        let content = format!("STDOUT:\n{}\nEXIT CODE: 0", body.join("\n"));
        let entry = tool_entry("shell", &content, None);
        let lines = render_tool(&entry, 80, Fold::Expanded, true, None);
        let body_text: String = lines
            .iter()
            .map(|l| line_text(l))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(body_text.contains("line 1\n"), "head window kept");
        assert!(body_text.contains("line 410"), "tail window kept");
        assert!(!body_text.contains("line 205"), "middle elided");
        assert!(
            body_text.contains("line 300"),
            "line 300 sits in the tail window"
        );
        assert!(body_text.contains("… 10 lines omitted …"), "elision marker");
        assert!(body_text.contains("▴ collapse"), "collapse affordance");

        // Small results fit entirely: no elision row.
        let small = tool_entry("shell", "STDOUT:\nok\nEXIT CODE: 0", None);
        let lines = render_tool(&small, 80, Fold::Expanded, true, None);
        let text: String = lines
            .iter()
            .map(|l| line_text(l))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!text.contains("omitted"));
        assert!(text.contains("▴ collapse"));
    }

    fn line_text(line: &Line<'_>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    /// An interrupted (cancelled) assistant turn carries a footer tag unless
    /// it is already an error entry.
    #[test]
    fn interrupted_assistant_shows_tag() {
        let mut entry = agente_core::types::ChatEntry {
            role: agente_core::types::Role::Assistant,
            content: "partial response".to_string(),
            interrupted: true,
            ..tool_entry("unused", "unused", None)
        };
        entry.tool_name = None;
        let lines = render_assistant(&entry, 60, None);
        let text: String = lines
            .iter()
            .map(|l| line_text(l))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("⚠ interrupted"), "tag: {text:?}");

        entry.is_error = true;
        let lines = render_assistant(&entry, 60, None);
        let text: String = lines
            .iter()
            .map(|l| line_text(l))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !text.contains("⚠ interrupted"),
            "errors keep their own marker"
        );
    }

    /// The reply closes with a dim whole-turn summary.
    #[test]
    fn assistant_reply_shows_worked_for_in_whole_seconds() {
        let entry = agente_core::types::ChatEntry {
            content: "Hello! How can I help you today?".to_string(),
            ..tool_entry("unused", "unused", None)
        };
        let lines = render_assistant(&entry, 60, Some(10_000.0));
        let text: String = lines
            .iter()
            .map(|l| line_text(l))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Worked for 10s"), "got: {text:?}");
        assert!(!text.contains("10.0s"), "whole seconds only: {text:?}");

        let lines = render_assistant(&entry, 60, None);
        let text: String = lines
            .iter()
            .map(|l| line_text(l))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !text.contains("Worked for"),
            "no duration, no row: {text:?}"
        );
    }

    /// The turn clock pairs the reply with the nearest preceding user message.
    #[test]
    fn worked_for_duration_reads_the_turn_clock() {
        let mut user = tool_entry("unused", "unused", None);
        user.role = agente_core::types::Role::User;
        user.content = "hello".to_string();
        user.tool_name = None;
        user.tool_args = None;
        user.timestamp = chrono::Utc::now() - chrono::Duration::seconds(10);

        let mut reply = tool_entry("unused", "unused", None);
        reply.role = agente_core::types::Role::Assistant;
        reply.content = "hi".to_string();
        reply.tool_name = None;
        reply.tool_args = None;

        let history = vec![user.clone(), reply.clone()];
        let worked = worked_for_duration(&history, 1).expect("turn clock");
        assert!((worked - 10_000.0).abs() < 1_500.0, "got {worked}");

        let mut err = reply.clone();
        err.is_error = true;
        let history = vec![user.clone(), err];
        assert!(worked_for_duration(&history, 1).is_none());

        let history = vec![reply];
        assert!(
            worked_for_duration(&history, 0).is_none(),
            "no preceding user message means no turn clock"
        );
    }

    // ── Verb groups ─────────────────────────────────────────────────────

    use std::collections::HashSet;

    /// Three consecutive collapsed read cards of the same family derive one
    /// group keyed by the first member's id.
    #[test]
    fn group_derivation_needs_three_consecutive_collapsed() {
        let entries: Vec<_> = (0..3).map(|_| tool_entry("grep", "x", None)).collect();
        let all_collapsed = |_id: uuid::Uuid, _name: Option<&str>| Fold::Collapsed;
        let groups = derive_tool_groups(&entries, &[false; 3], &all_collapsed, &HashSet::new());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].0, 0, "run start");
        assert_eq!(groups[0].1, 3, "run length");
        assert_eq!(groups[0].2.head_id, entries[0].id);
        assert!(!groups[0].2.expanded);

        // A pair is left alone.
        let pair: Vec<_> = (0..2).map(|_| tool_entry("grep", "x", None)).collect();
        let groups = derive_tool_groups(&pair, &[false; 2], &all_collapsed, &HashSet::new());
        assert!(groups.is_empty(), "runs of two do not compress");
    }

    /// Any Truncated/Expanded member, a family change, or a rendered non-tool
    /// entry between members breaks the run.
    #[test]
    fn group_derivation_breaks_on_family_fold_and_interleaves() {
        let entries = vec![
            tool_entry("grep", "x", None),
            tool_entry("grep", "x", None),
            // Family change (shell is Run, greps are Read) splits the run.
            tool_entry("shell", "x", None),
            tool_entry("grep", "x", None),
        ];
        let all_collapsed = |_id: uuid::Uuid, _name: Option<&str>| Fold::Collapsed;
        let groups = derive_tool_groups(&entries, &[false; 4], &all_collapsed, &HashSet::new());
        assert!(
            groups.is_empty(),
            "family change splits every run: {groups:?}"
        );

        // One member expanded below the default kills the run.
        let entries = vec![
            tool_entry("grep", "x", None),
            tool_entry("grep", "x", None),
            tool_entry("grep", "x", None),
        ];
        let third_expanded = |id: uuid::Uuid, _name: Option<&str>| {
            if id == entries[2].id {
                Fold::Expanded
            } else {
                Fold::Collapsed
            }
        };
        let groups = derive_tool_groups(&entries, &[false; 3], &third_expanded, &HashSet::new());
        assert!(groups.is_empty(), "expanded member breaks the run");

        // A rendered non-tool entry between tool cards also breaks the run…
        let mut interleaved = vec![tool_entry("grep", "x", None), tool_entry("grep", "x", None)];
        interleaved.push(agente_core::types::ChatEntry {
            role: agente_core::types::Role::Assistant,
            content: "meanwhile".to_string(),
            tool_name: None,
            ..tool_entry("grep", "x", None)
        });
        interleaved.push(tool_entry("grep", "x", None));
        let groups = derive_tool_groups(&interleaved, &[false; 4], &all_collapsed, &HashSet::new());
        assert!(groups.is_empty(), "assistant prose breaks the run");

        // …but invisible pending-call stubs do not.
        let mut stubbed: Vec<agente_core::types::ChatEntry> = Vec::new();
        let mut skip = Vec::new();
        for _ in 0..3 {
            let mut call = tool_entry("grep", "x", None);
            call.role = agente_core::types::Role::Assistant;
            call.content = String::new();
            skip.push(true); // the call stub is invisible
            stubbed.push(call);
            skip.push(false);
            stubbed.push(tool_entry("grep", "x", None));
        }
        let groups = derive_tool_groups(&stubbed, &skip, &all_collapsed, &HashSet::new());
        assert_eq!(groups.len(), 1, "stubs between results keep the run");
        assert_eq!(groups[0].1, 3);
    }

    /// Group header aggregates per-verb counts with pluralized nouns and a
    /// failure suffix, and is one ToolGroup hit target.
    #[test]
    fn group_header_aggregates_counts_and_failures() {
        let mut entries = vec![
            tool_entry("read_file", "1", None),
            tool_entry("read_file", "2", None),
            tool_entry("grep", "3", None),
        ];
        entries[2].is_error = true;
        let info = GroupInfo {
            family: ToolFamily::Read,
            head_id: entries[0].id,
            members: vec![0, 1, 2],
            any_error: true,
            expanded: false,
        };
        let block = render_group_header_block(&entries, &info, 60, true);
        let text = line_text(&block.lines[0]);
        assert!(text.contains("◆"), "header: {text:?}");
        assert!(text.contains("Read 2 files"), "header: {text:?}");
        assert!(text.contains("Search 1 pattern"), "header: {text:?}");
        assert!(text.contains("1 failed"), "header: {text:?}");
        assert_eq!(block.lines.len(), 1, "dense next: no trailing gap");
        assert_eq!(
            block.regions,
            vec![(0, 1, ClickKind::ToolGroup, false)],
            "one group hit target"
        );
        assert_eq!(block.plain[0].entry_id, Some(info.head_id));

        // Pluralization of the second verb and the gap row.
        let entries = vec![
            tool_entry("read_file", "1", None),
            tool_entry("grep", "2", None),
            tool_entry("grep", "3", None),
        ];
        let info = GroupInfo {
            family: ToolFamily::Read,
            head_id: entries[0].id,
            members: vec![0, 1, 2],
            any_error: false,
            expanded: false,
        };
        let block = render_group_header_block(&entries, &info, 60, false);
        let text = line_text(&block.lines[0]);
        assert!(text.contains("Read 1 file "), "singular noun: {text:?}");
        assert!(text.contains("Search 2 patterns"), "plural noun: {text:?}");
        assert!(!text.contains("failed"));
        assert_eq!(block.lines.len(), 2, "lone header keeps its trailing gap");
    }

    /// An expanded group renders its header plus every member as a dense
    /// stack; a collapsed group renders only the header row.
    #[test]
    fn group_render_collapses_and_expands_members() {
        use agente_core::types::Role;
        let mut history: Vec<agente_core::types::ChatEntry> = Vec::new();
        let mut skip = Vec::new();
        for _ in 0..3 {
            let mut call = tool_entry("grep", "x", None);
            call.role = Role::Assistant;
            call.content = String::new();
            skip.push(true);
            history.push(call);
            skip.push(false);
            history.push(tool_entry("grep", "x", None));
        }
        let all_collapsed = |_id: uuid::Uuid, _name: Option<&str>| Fold::Collapsed;

        let collapsed_groups = derive_tool_groups(&history, &skip, &all_collapsed, &HashSet::new());
        assert_eq!(collapsed_groups.len(), 1);
        let mut ui = crate::state::UiState::default();
        let ctx = HistoryRenderCtx {
            live_tools: &std::collections::HashMap::new(),
            subagents: &std::collections::HashMap::new(),
        };
        let mut blocks = Vec::new();
        let mut regions = Vec::new();
        let mut height = 0usize;
        render_history_range(
            &history,
            0,
            80,
            HistoryFrame {
                ctx: &ctx,
                skipped: &skip,
                groups: &collapsed_groups,
            },
            &mut ui,
            HistorySink {
                blocks: &mut blocks,
                regions: &mut regions,
                height: &mut height,
            },
        );
        assert_eq!(blocks.len(), 1, "collapsed group: one header block only");
        assert!(regions
            .iter()
            .all(|(r, _, _)| r.kind == ClickKind::ToolGroup));
        let header_text: String = blocks[0].2.plain.iter().map(|p| p.plain.as_ref()).collect();
        assert!(header_text.contains("Search 3 patterns"), "{header_text}");

        // Expanded: header + three member cards, densely stacked.
        let head_id = collapsed_groups[0].2.head_id;
        let mut expanded = HashSet::new();
        expanded.insert(head_id);
        let expanded_groups = derive_tool_groups(&history, &skip, &all_collapsed, &expanded);
        let mut ui = crate::state::UiState::default();
        let mut blocks = Vec::new();
        let mut regions = Vec::new();
        let mut height = 0usize;
        render_history_range(
            &history,
            0,
            80,
            HistoryFrame {
                ctx: &ctx,
                skipped: &skip,
                groups: &expanded_groups,
            },
            &mut ui,
            HistorySink {
                blocks: &mut blocks,
                regions: &mut regions,
                height: &mut height,
            },
        );
        assert_eq!(blocks.len(), 4, "header + three member cards");
        assert_eq!(ui.chat_plain_lines.len(), height);
        assert!(blocks[1..]
            .iter()
            .all(|(_, _, b)| b.plain[0].plain.starts_with("   │")));
        let tool_regions: Vec<_> = regions
            .iter()
            .filter(|(r, _, _)| r.kind == ClickKind::Tool)
            .collect();
        assert_eq!(tool_regions.len(), 3, "each member is clickable");
        assert!(
            tool_regions
                .iter()
                .all(|(r, _, _)| r.tool_name.as_deref() == Some("grep")),
            "regions carry the member's tool name"
        );
    }

    #[test]
    fn thinking_click_region_is_header_only_when_expanded() {
        use std::collections::HashMap;
        let entry = agente_core::types::ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: agente_core::types::Role::Assistant,
            content: "Done.".to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: Some(100.0),
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: Some("line one\nline two\nline three".to_string()),
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        };
        let block = render_entry_block(
            &entry,
            60,
            false,
            true,
            Fold::Collapsed,
            false,
            &HashMap::new(),
            None,
            None,
        );
        let thinking_regions: Vec<_> = block
            .regions
            .iter()
            .filter(|(_, _, k, _)| *k == ClickKind::Thinking)
            .collect();
        assert_eq!(thinking_regions.len(), 1, "one thinking hit target");
        let (start, end, _, _) = thinking_regions[0];
        assert_eq!(
            end - start,
            1,
            "thinking hit target must be header-only, got span {}",
            end - start
        );
        // Expanded body is present in the block lines.
        assert!(
            block.lines.len() > 4,
            "expanded thinking should add body lines"
        );
    }

    #[test]
    fn live_thinking_header_uses_diamond_and_sweep_not_braille() {
        let lines = render_thinking_block("", false, true, false, 0, 60, None);
        assert_eq!(lines.len(), 1, "collapsed live header is one row");
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(
            text.contains("Thinking..."),
            "live header matches reference copy, got: {text}"
        );
        assert!(
            text.contains('◆'),
            "dim diamond marker expected, got: {text}"
        );
        for frame in crate::widgets::SPINNER {
            assert!(
                !text.contains(frame),
                "braille frame {frame} must not appear in the thinking header"
            );
        }
        // Collapsed live preview tracks the newest reasoning chunk; empty
        // reasoning stays a bare header.
        let with_body = render_thinking_block(
            "first thought\nGreat, ffmpeg is installed (homebrew).",
            false,
            true,
            true,
            0,
            60,
            None,
        );
        assert_eq!(with_body.len(), 2, "header + one preview line");
        let preview: String = with_body[1]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(
            preview.contains("ffmpeg is installed"),
            "preview shows newest chunk, got: {preview}"
        );
        assert!(
            preview.starts_with("  │ "),
            "thread rail sits under the ◆ header, got: {preview:?}"
        );
        // The rail breathes with the sweep instead of sitting static.
        let rail_a = with_body[1].spans[1].style.fg;
        let with_body_b = render_thinking_block(
            "first thought\nGreat, ffmpeg is installed (homebrew).",
            false,
            true,
            true,
            30,
            60,
            None,
        );
        let rail_b = with_body_b[1].spans[1].style.fg;
        assert_ne!(rail_a, rail_b, "rail must shimmer across frames");
        // The sweep actually moves across frames.
        let other = render_thinking_block("", false, true, false, 30, 60, None);
        let colors: Vec<_> = lines[0].spans.iter().map(|s| s.style.fg).collect();
        let other_colors: Vec<_> = other[0].spans.iter().map(|s| s.style.fg).collect();
        assert_ne!(
            colors, other_colors,
            "shimmer sweep must advance with anim_frame"
        );
    }
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
        assert_debug_snapshot!("chat_60x16", terminal.backend().buffer().clone());
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
        assert_debug_snapshot!("input_60x8", terminal.backend().buffer().clone());
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
        assert_debug_snapshot!("input_command_60x8", terminal.backend().buffer().clone());
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
                let input_h =
                    crate::widgets::input::desired_height(&state.input.input_text, size.width, 0)
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
        assert_debug_snapshot!("shell_welcome_80x24", buf);
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
        assert_debug_snapshot!("help_60x24", terminal.backend().buffer().clone());
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
        assert_debug_snapshot!("approval_60x12", terminal.backend().buffer().clone());
    }
}

/// Tests for the checkpoint-based streaming markdown renderer
/// (`StreamMarkdownCache` + `render_streaming`): incremental frames must
/// match a one-shot rebuild, completed blocks get real markdown styling, the
/// live tail hides unclosed markers, and rewrite/resize fallbacks stay clean.
#[cfg(test)]
mod stream_wrap_tests {
    use super::*;

    fn plain_of(lines: &[Line<'static>]) -> Vec<String> {
        lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn incremental_streaming_matches_full_rebuild() {
        let width = 60usize;
        let deltas = [
            "# Title line\n",
            "Intro paragraph with **bold** text long enough to wrap across\n",
            "more than one terminal row in this test corpus.
",
            "```rust\nfn a() -> u32 { 1 }\n```\n",
            "- item one\n- item two\n",
            "tail without newline",
        ];
        let mut cache = StreamMarkdownCache::default();
        let mut text = String::new();
        for delta in deltas {
            text.push_str(delta);
            let incremental = render_streaming(&text, width, Style::default(), 0, &mut cache);
            let fresh = render_streaming(
                &text,
                width,
                Style::default(),
                0,
                &mut StreamMarkdownCache::default(),
            );
            assert_eq!(
                plain_of(&incremental),
                plain_of(&fresh),
                "mismatch after pushing {delta:?}"
            );
        }
    }

    #[test]
    fn completed_blocks_render_markdown_while_streaming() {
        let width = 60usize;
        let mut cache = StreamMarkdownCache::default();
        let text = "# Heading marker\n\npara with **bold** span\n";
        let out = render_streaming(text, width, Style::default(), 0, &mut cache);
        let joined = plain_of(&out).join("\n");
        assert!(joined.contains("Heading marker"), "got: {joined}");
        assert!(
            !joined.contains("# Heading"),
            "raw heading marker must not render: {joined}"
        );
        assert!(joined.contains("bold"), "got: {joined}");
        assert!(
            !joined.contains("**"),
            "raw bold markers must not render once the block closes: {joined}"
        );
    }

    /// Compare actual live rows to the final renderer, not to another call to
    /// the streaming renderer (which used to duplicate the same cached blocks).
    #[test]
    fn every_stream_prefix_matches_final_markdown_layout() {
        let corpora = [
            "| Area | Detail |\n|---|---|\n| **Explore** | List files<br>Inspect symbols |\n| **Plan** | Review changes<br/>Accept plan |\n\n**What I *can* do** in ~/.config",
            "# Title\n\nA **bold** paragraph followed by a second line.\nNext line\n\nDone",
            "- first item\n- second item\n\n1. numbered item\n> a quote\n",
            "A URL https://example.com/very/long/path/with/many/segments",
            "文字が折り返されます and more text\n\nFinal",
            "```rust\nfn main() {\n    println!(\"hello\");\n}\n```\nAfter code",
            "```text\n| this is code | not a table |\n\nlast code line\n```\n",
            "| step | status |\n| --- | --- |\n| read | done |\n| wrap | waiting |\n\nEnd",
            "First\n\n\nSecond\n\n",
        ];
        for text in corpora {
            for width in [4, 8, 20, 40, 80] {
                let mut cache = StreamMarkdownCache::default();
                for end in text.char_indices().map(|(i, c)| i + c.len_utf8()) {
                    let prefix = &text[..end];
                    let mut actual =
                        render_streaming(prefix, width, Style::default(), 0, &mut cache);
                    let expected = crate::widgets::markdown::markdown_display_lines(prefix, width);
                    let cursor_row = actual.last_mut().expect("live cursor row");
                    assert_eq!(cursor_row.spans.last().unwrap().content, "▊");
                    cursor_row.spans.pop();
                    if actual.len() > expected.len()
                        && actual
                            .last()
                            .unwrap()
                            .spans
                            .iter()
                            .all(|s| s.content.trim().is_empty())
                    {
                        actual.pop();
                    }
                    assert_eq!(actual, expected, "width {width}, prefix {prefix:?}");
                }
            }
        }
    }

    #[test]
    fn stream_checkpoints_preserve_long_tables_and_paragraphs() {
        for text in [
            (0..100).map(|i| format!("line {i}\n")).collect::<String>(),
            format!(
                "| id | description |\n| -- | -- |\n{}",
                (0..70)
                    .map(|i| format!("| {i} | row {} |\n", "x".repeat(i)))
                    .collect::<String>()
            ),
        ] {
            let mut cache = StreamMarkdownCache::default();
            let mut prefix = String::new();
            for line in text.split_inclusive('\n') {
                prefix.push_str(line);
                let mut actual = render_streaming(&prefix, 40, Style::default(), 0, &mut cache);
                actual.pop(); // standalone cursor after the source newline
                assert_eq!(
                    actual,
                    crate::widgets::markdown::markdown_display_lines(&prefix, 40)
                );
            }
        }
    }

    #[test]
    fn open_tail_hides_unclosed_markers() {
        let width = 60usize;
        let mut cache = StreamMarkdownCache::default();
        // A paragraph still streaming: the ** is unclosed mid-word.
        let text = "Hello **wor";
        let out = render_streaming(text, width, Style::default(), 0, &mut cache);
        let joined = plain_of(&out).join("\n");
        assert!(joined.contains("Hello"), "got: {joined}");
        assert!(joined.contains("wor"), "got: {joined}");
        assert!(
            !joined.contains("**"),
            "unclosed markers must not render raw: {joined}"
        );
    }

    #[test]
    fn closed_fence_renders_code_chrome_while_streaming() {
        let width = 60usize;
        let mut cache = StreamMarkdownCache::default();
        let text = "```rust\nfn a() -> u32 { 1 }\n```\n";
        let _ = render_streaming(text, width, Style::default(), 0, &mut cache);
        let all: String = cache.plain.join("\n");
        assert!(all.contains("│"), "code block chrome expected: {all}");
        assert!(all.contains("fn a"), "code content expected: {all}");
    }

    #[test]
    fn rewrite_falls_back_and_rebuilds() {
        let width = 60usize;
        let mut cache = StreamMarkdownCache::default();
        let long = "word ".repeat(40);
        let _ = render_streaming(&long, width, Style::default(), 0, &mut cache);
        // A retry/rewrite breaks the append-only prefix; the guard must
        // invalidate and produce identical output to a fresh rebuild.
        let rewritten = "# Brand new text";
        let incremental = render_streaming(rewritten, width, Style::default(), 0, &mut cache);
        let fresh = render_streaming(
            rewritten,
            width,
            Style::default(),
            0,
            &mut StreamMarkdownCache::default(),
        );
        assert_eq!(plain_of(&incremental), plain_of(&fresh));
    }

    #[test]
    fn width_change_rebuilds_cleanly() {
        let style = Style::default();
        let mut cache = StreamMarkdownCache::default();
        let text = "# heading\n\nsome paragraph lines here\n";
        let _ = render_streaming(text, 40, style, 0, &mut cache);
        let incremental = render_streaming(text, 30, style, 0, &mut cache);
        let fresh = render_streaming(text, 30, style, 0, &mut StreamMarkdownCache::default());
        assert_eq!(plain_of(&incremental), plain_of(&fresh));
    }
}
