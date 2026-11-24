//! Per-entry block renderers: user prompt cards, assistant markdown + footer,
//! thinking disclosures, tool cards, system notices, and subagent cards.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use agente_core::types::ClickKind;

use crate::state::{ChatPlainLine, Fold, RenderedChatBlock, SubagentUiState};
use crate::style::*;
use crate::widgets::markdown::{render_markdown, render_markdown_at_width, wrap_line};
use crate::widgets::{
    display_width, fill_row, s, sf, shimmer_text, short_path, sp, themed_blank_row, tool_icon_for,
    truncate_cells,
};

use super::streaming::think_rail;
use super::USER_PREVIEW_LINES;

pub(super) fn push_wrapped(
    lines: &mut Vec<Line<'static>>,
    plain: &mut Vec<ChatPlainLine>,
    line: Line<'_>,
    width: usize,
    entry_id: Option<uuid::Uuid>,
) {
    let wrapped = wrap_line(&line, width);
    for w in wrapped {
        let text: String = w.spans.iter().map(|s| s.content.as_ref()).collect();
        plain.push(ChatPlainLine {
            entry_id,
            plain: text.into(),
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
    });
    lines.push(owned);
}

pub(super) fn entry_is_truncatable(entry: &agente_core::types::ChatEntry) -> bool {
    entry.content.lines().count() > USER_PREVIEW_LINES
}

/// Render one chat entry into a cacheable block: finished thinking card (if
/// any) + the role body, plus its click regions. Finished cards take no
/// animation frame (shimmer only applies to the live panel), so this is
/// deterministic given its arguments.
#[allow(clippy::too_many_arguments)]
pub(super) fn render_entry_block(
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
            push_wrapped(&mut lines, &mut plain, line, chat_width, Some(entry.id));
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
        push_wrapped(&mut lines, &mut plain, line, chat_width, Some(entry.id));
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

pub(super) fn render_thinking_block(
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
            Some(d) => format!("Thought for {}", crate::widgets::format_duration_ms(d)),
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

// ── Helpers ──────────────────────────────────────────────────────────────
// Span constructors (`s`/`sp`/`sf`), `themed_blank_row`, and the single wrap
// engine (`wrap_line`) live in `widgets/mod.rs` and `widgets/markdown.rs`.

// ── User message: shaded prompt box with `>` ──────────────────────────

pub(super) fn render_user(
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
pub(super) fn USER_BUBBLE_BG() -> ratatui::style::Color {
    BG_PANEL()
}

/// Rail colour: a muted accent at rest, full accent under the pointer.
pub(super) fn user_rail_color(hovered: bool) -> ratatui::style::Color {
    if hovered {
        PRIMARY()
    } else {
        blend_colors(PRIMARY(), USER_BUBBLE_BG(), 0.45)
    }
}

// ── Assistant message: content + footer ──────────────────────────────────

pub(super) fn render_assistant(
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
                format!("Worked for {}", crate::widgets::format_worked_for_ms(ms)),
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

/// `8:19 AM` in the terminal's local timezone (UTC under test, so rendered
/// snapshots are the same on every machine).
pub(super) fn format_time_am_pm(ts: chrono::DateTime<chrono::Utc>) -> String {
    #[cfg(not(test))]
    let s = ts
        .with_timezone(&chrono::Local)
        .format("%I:%M %p")
        .to_string();
    #[cfg(test)]
    let s = ts.format("%I:%M %p").to_string();
    match s.strip_prefix('0') {
        Some(trimmed) => trimmed.to_string(),
        None => s,
    }
}

pub(super) fn render_system(entry: &agente_core::types::ChatEntry, width: usize) -> Vec<Line<'_>> {
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
    let p = crate::widgets::tool_presentation(tool_name);
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

    let p = crate::widgets::tool_presentation(tool_name);
    let subject = if p.shell_style {
        str_at("command").map_or_else(
            || tool_name.to_string(),
            |cmd| format!("$ {}", truncate_cells(cmd, max_target_w)),
        )
    } else {
        match p.subject {
            Some((key, style)) => str_at(key)
                .map(|value| match style {
                    crate::widgets::SubjectStyle::Path => {
                        truncate_cells(short_path(value), max_target_w)
                    }
                    crate::widgets::SubjectStyle::Quoted => {
                        format!("\"{}\"", truncate_cells(value, max_target_w))
                    }
                    crate::widgets::SubjectStyle::Pattern => truncate_cells(value, max_target_w),
                })
                .unwrap_or_default(),
            None => String::new(),
        }
    };
    (tool_verb(tool_name), subject)
}

pub(super) fn render_tool<'a>(
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
            crate::widgets::format_duration_ms(d),
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
pub(super) fn shell_display(content: &str) -> (Vec<String>, Option<i32>) {
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
pub(super) fn render_subagent(
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
    // A swarm member is its card: `c2 Parse lexer` then the role, so the
    // members of one swarm read as one team instead of unrelated spawns.
    let lane = ui.and_then(|u| u.swarm.as_ref());
    let (type_label, description) = match lane {
        Some(lane) => (
            format!("{} {}", lane.card_id, lane.title),
            lane.role.as_str(),
        ),
        None => (
            capitalize_label(entry.subagent_type.as_deref().unwrap_or("subagent")),
            ui.map(|u| u.description.as_str()).unwrap_or(&entry.content),
        ),
    };

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
        status_text.push_str(&format!(" · {}", crate::widgets::format_duration_ms(ms)));
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
        if let Some(lane) = lane.filter(|lane| !lane.feeds.is_empty()) {
            detail.push(Span::styled(
                format!(" · feeds {}", lane.feeds.join(", ")),
                on(Style::default().fg(FG_DIM())),
            ));
        }
    }

    let mut lines = vec![Line::from(header), Line::from(fill_row(detail, width, bg))];
    // The newest finding this member posted or was sent: `✎ c1 → c2  text`.
    if let Some(latest) = lane.and_then(|lane| lane.latest.as_deref()) {
        let finding = vec![
            Span::styled("   \u{270e} ", on(Style::default().fg(FG_DIM()))),
            Span::styled(
                truncate_cells(latest, width.saturating_sub(6)),
                on(Style::default().fg(FG_MUTED())),
            ),
        ];
        lines.push(Line::from(fill_row(finding, width, bg)));
    }
    lines.push(themed_blank_row(width));
    lines
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
pub(super) fn subagent_activity(
    ui: Option<&crate::state::SubagentUiState>,
    width: usize,
) -> String {
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

/// Whole-turn wall clock for the assistant reply at `index`: the gap between
/// the nearest preceding user message and this entry's commit timestamp.
/// `None` for tool stubs, errors, subagent cards, and sub-second turns.
pub(super) fn worked_for_duration(
    history: &[agente_core::types::ChatEntry],
    index: usize,
) -> Option<f64> {
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
