//! Frame-level history snapshot builder and consecutive tool-group derivation.

use std::sync::Arc;

use ratatui::style::{Modifier, Style};
use ratatui::text::Line;

use agente_core::types::{ClickKind, ClickRegion};

use crate::state::{
    ChatPlainLine, Fold, LiveToolCall, RenderedChatBlock, SubagentUiState, UiState,
};
use crate::style::*;
use crate::widgets::{s, sf, sp, themed_blank_row};

use super::blocks::{
    extract_media_path, render_entry_block, subagent_activity, worked_for_duration,
};

/// Agent-derived inputs for [`render_history_range`], kept separate from the
/// `&mut UiState` parameter so the history slice, UI state and agent state
/// borrow disjoint fields.
pub(super) struct HistoryRenderCtx<'a> {
    pub(super) live_tools: &'a std::collections::HashMap<String, LiveToolCall>,
    pub(super) subagents: &'a std::collections::HashMap<String, SubagentUiState>,
}

/// Entries that render no block of their own: pending tool-call stubs whose
/// result (or live card) follows. Runs of grouped tool cards skip over these.
pub(super) fn skipped_entries(
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
pub(super) struct HistoryFrame<'a> {
    pub(super) ctx: &'a HistoryRenderCtx<'a>,
    pub(super) skipped: &'a [bool],
    pub(super) groups: &'a [(usize, usize, GroupInfo)],
}

pub(super) struct HistorySink<'a> {
    pub(super) blocks: &'a mut Vec<(usize, usize, Arc<RenderedChatBlock>)>,
    pub(super) regions: &'a mut Vec<(ClickRegion, usize, usize)>,
    pub(super) height: &'a mut usize,
}

pub(super) fn render_history_range(
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
    let folds: Vec<Fold> = history.iter().map(|e| ui.tool_fold_of(e.id)).collect();
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
        let tool_fold = ui.tool_fold_of(entry.id);
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
pub(super) fn subagent_fingerprint(
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

pub(super) fn tool_family(tool_name: &str) -> Option<ToolFamily> {
    match crate::widgets::tool_presentation(tool_name).family {
        Some(crate::widgets::FamilyKind::Read) => Some(ToolFamily::Read),
        Some(crate::widgets::FamilyKind::Run) => Some(ToolFamily::Run),
        Some(crate::widgets::FamilyKind::Edit) => Some(ToolFamily::Edit),
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
    fold_of: &dyn Fn(uuid::Uuid) -> Fold,
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
            let collapsed = fold_of(entry.id) == Fold::Collapsed
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
    let p = crate::widgets::tool_presentation(tool_name);
    (p.group_verb, p.group_noun)
}

/// The single summary row that replaces a collapsed run of tool cards:
/// ` ◆ Read 3 files · Search 1 pattern` (+ ` · N failed` when a member errored).
/// The reference has no fold chevrons; the member stack below signals expand.
pub(super) fn render_group_header_block(
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
