//! Live streaming markdown renderer and in-flight tool cards.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::state::StreamMarkdownCache;
use crate::style::*;
use crate::widgets::markdown::{render_markdown_at_width, wrap_line};
use crate::widgets::{shimmer_text, sp, tool_icon_for, truncate_cells};

use super::blocks::tool_header_parts;

/// Render the live streaming section: frozen-prefix model.
///
/// Closed blocks (blank-line / fence boundaries) are markdown-rendered ONCE
/// into `cache.rows`; the open block plus the partial line re-renders
/// through the markdown pipeline every frame (unclosed markers styled,
/// not shown raw). The ingest-side auto-checkpoint bounds the per-frame
/// cost.
pub(super) fn render_streaming(
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

/// Stable per-call id for a running row, so hover lights up only that row
/// (the live rows have no chat entry of their own).
pub(super) fn live_tool_entry_id(call_id: &str) -> uuid::Uuid {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    call_id.hash(&mut hasher);
    let high = hasher.finish();
    "live-tool".hash(&mut hasher);
    uuid::Uuid::from_u64_pair(high, hasher.finish())
}

pub(super) fn render_live_tool(
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

/// Thread rail joining the `◆` thinking header to its body lines.
///
/// Same 4-cell width as the old blank indent, so wrap budgets are untouched;
/// the rail sits exactly under the header diamond. The `│` rides the same
/// shimmer wave as the live header (single-char `shimmer_text` at the given
/// frame), so the thread visibly breathes with the sweep instead of sitting
/// static beside it. History entries pass frame `0`, freezing the rail at a
/// muted tone.
pub(super) fn think_rail(frame: usize) -> Vec<Span<'static>> {
    let mut rail = shimmer_text("│", frame);
    let mut row = vec![sp("  ")];
    row.append(&mut rail);
    row.push(sp(" "));
    row
}
