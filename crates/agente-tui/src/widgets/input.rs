//! Composer input — a rounded box with a `❯` prompt and the
//! model · mode readout riding the bottom border (the default `ask` label is
//! gone; `always-approve` shows only when it is on).
//!
//! Layout:
//! ```text
//! ╭─────────────────────────────────────────────────╮
//! │ ❯  Ask anything…                                │
//! ╰──────────────────── model (xhigh) · plan ───────╯
//! ```

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};
use ratatui::Frame;

use crate::state::AppState;
use crate::style::{self, *};
use crate::widgets::{display_width, truncate_cells};
use agente_core::types::{AgentMode, AgentState};

const MIN_BODY_ROWS: u16 = 1;
const MAX_BODY_ROWS: u16 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
struct WrappedInputLine {
    text: String,
    start_char: usize,
    end_char: usize,
}

fn available_text_width(width: u16) -> usize {
    // Outer border (2), row padding (1), prompt (2), cursor (1).
    width.saturating_sub(6).max(1) as usize
}

/// Height the composer needs for the given text.
/// `queued` follow-up messages render as up to two preview rows; attached
/// media takes one header row above them.
pub fn desired_height(text: &str, width: u16, queued: usize, has_attachments: bool) -> u16 {
    let preview_rows = queued_preview_rows(queued);
    let attachment_rows = usize::from(has_attachments);
    let header_rows = preview_rows + attachment_rows;
    let content_rows = (wrap_input_text(text, available_text_width(width)).len() + header_rows)
        .clamp(MIN_BODY_ROWS as usize, MAX_BODY_ROWS as usize + header_rows)
        as u16;
    // borders (2) + body. Approval prompts live on the floating card only.
    2 + content_rows
}

/// Rows reserved for the queued-message preview (max two; overflow is noted
/// inside the second row rather than taking more space).
fn queued_preview_rows(queued: usize) -> usize {
    queued.min(2)
}

/// Minimum height always reserved for an empty idle composer.
pub fn min_height() -> u16 {
    2 + MIN_BODY_ROWS // borders + body only
}

fn panel_bg() -> ratatui::style::Color {
    BG_PANEL()
}

/// Border tone for the composer box: warning while an approval is pending,
/// secondary while a turn runs, otherwise the mode accent (plan = gold,
/// build = blue).
fn border_color(state: &AppState) -> ratatui::style::Color {
    if state.agent.has_pending_approval() {
        return WARNING();
    }
    let running = !matches!(state.agent.state, AgentState::Idle | AgentState::Error(_));
    if running {
        return SECONDARY();
    }
    match state.agent.mode {
        AgentMode::Plan => WARNING(),
        AgentMode::Build => PRIMARY(),
    }
}

/// Mode readout for the top header: `plan` or `build`, in the mode accent.
pub fn mode_spans(state: &AppState) -> Vec<Span<'static>> {
    let mode = state.agent.work_mode();
    let mut spans = vec![Span::styled(
        mode.label(),
        Style::default().fg(mode.color()).bg(BG()),
    )];
    // Swarm rides on top of the mode: say so where the mode is said.
    if state
        .agent
        .board
        .as_ref()
        .is_some_and(|board| board.enabled)
    {
        spans.push(Span::styled(
            " + swarm",
            Style::default().fg(PRIMARY()).bg(BG()),
        ));
    }
    spans
}

/// Bottom-border readout `model (thinking)`, degraded to fit `width` cells:
/// the thinking level drops first, then the model truncates. The mode lives
/// on the status row below, not here — showing it twice was noise. An
/// always-approve override on Plan/Build is still flagged (`auto` mode says
/// it on the status row).
pub fn composer_title(state: &AppState, width: usize) -> Vec<Span<'static>> {
    if width < 8 {
        return Vec::new();
    }
    let approval = (state.agent.auto_approve_all()
        && state.agent.work_mode() != crate::state::WorkMode::Auto)
        .then_some(" · always-approve");
    let bg = panel_bg();

    let model = if !state.config.current_model.is_empty() {
        state.get_model_display_name(&state.config.current_provider, &state.config.current_model)
    } else if !state.config.current_provider.is_empty() {
        state.get_provider_display_name(&state.config.current_provider)
    } else {
        String::new()
    };
    let thinking = state
        .resolve_model(&state.config.current_provider, &state.config.current_model)
        .filter(agente_core::thinking::model_supports_thinking)
        .map(|_| state.agent.thinking_level.trim().to_string())
        .filter(|level| {
            !level.is_empty()
                && level != agente_core::thinking::THINKING_OFF
                && level != agente_core::thinking::THINKING_AUTO
        });

    // Padding (` name · level `) and one border dash before the corner.
    let room = width.saturating_sub(3);
    let fits = |text: &str| crate::widgets::display_width(text) <= room;
    // Degrade gracefully: drop the thinking level, then truncate the model.
    let level = thinking
        .as_ref()
        .map(|level| format!(" · {level}"))
        .filter(|level| fits(&format!("{model}{level}")));
    let model_text = if fits(&model) {
        model
    } else {
        truncate_cells(&model, room)
    };
    let used = format!("{model_text}{}", level.as_deref().unwrap_or(""));
    let show_approval = approval.is_some_and(|label| fits(&format!("{used}{label}")));

    let mut spans: Vec<Span<'static>> = Vec::new();
    if model_text.is_empty() {
        return spans;
    }
    spans.push(Span::styled(" ", Style::default().bg(bg)));
    spans.push(Span::styled(
        model_text,
        Style::default().fg(FG_MUTED()).bg(bg),
    ));
    if let Some(level) = level {
        spans.push(Span::styled(level, Style::default().fg(FG_DIM()).bg(bg)));
    }
    if show_approval {
        spans.push(Span::styled(
            approval.unwrap_or_default(),
            Style::default().fg(FG_DIM()).bg(bg),
        ));
    }
    spans.push(Span::styled(" ", Style::default().bg(bg)));
    spans.push(Span::styled(
        "─",
        Style::default().fg(border_color(state)).bg(bg),
    ));
    spans
}

/// The glyph for an attachment kind (single-width).
pub fn attachment_glyph(kind: agente_core::media::AttachmentKind) -> &'static str {
    use agente_core::media::AttachmentKind;
    match kind {
        AttachmentKind::Image => "◰",
        AttachmentKind::Audio => "♪",
        AttachmentKind::Video => "▶",
        AttachmentKind::Pdf => "▤",
    }
}

/// ` ◰ shot.png 240 KB  ♪ talk.mp3 1.2 MB` — shared by the composer and the
/// sent bubble.
pub fn attachment_chips(
    attachments: &[agente_core::media::Attachment],
    bg: ratatui::style::Color,
) -> Vec<Span<'static>> {
    let mut spans = vec![Span::styled(" ", Style::default().bg(bg))];
    for (i, attachment) in attachments.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled("  ", Style::default().bg(bg)));
        }
        spans.push(Span::styled(
            format!("{} ", attachment_glyph(attachment.kind)),
            Style::default().fg(PRIMARY()).bg(bg),
        ));
        spans.push(Span::styled(
            truncate_cells(&attachment.name, 28),
            Style::default().fg(FG_MUTED()).bg(bg),
        ));
        spans.push(Span::styled(
            format!(" {}", agente_core::media::human_bytes(attachment.bytes)),
            Style::default().fg(FG_DIM()).bg(bg),
        ));
    }
    spans
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if area.height < 3 || area.width < 8 {
        return;
    }

    let bg = panel_bg();
    let border = border_color(state);

    // Reference composer: a quiet rounded box; the model readout rides the
    // bottom border.
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(border).bg(bg))
        .style(Style::default().bg(bg))
        .title_bottom(
            Line::from(composer_title(state, area.width.saturating_sub(2) as usize))
                .right_aligned(),
        );

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    // Approval prompts are owned exclusively by the floating approval card;
    // a second Y/A/N footer here duplicated it (and stole two body rows).
    render_body(frame, inner, state);
}

/// Byte length of the slash-command token at the start of `line`, when the
/// line begins with a command (e.g. `/model gpt-4o` → 6). `None` for plain
/// text, a bare `/`, or an empty token — so the picker-only state isn't tinted.
fn slash_command_token_len(line: &str) -> Option<usize> {
    if !line.starts_with('/') {
        return None;
    }
    let rest = &line[1..];
    let end = rest
        .find(|c: char| c.is_whitespace())
        .map(|i| i + 1)
        .unwrap_or(line.len());
    if end >= 2 {
        Some(end)
    } else {
        None
    }
}

/// Style one input line: a leading `/command` token renders in the accent
/// color, the trailing text (the "full text" after the command) in the normal
/// foreground. Plain lines render exactly as before — one `FG` span.
fn style_input_line(line_text: &str, bg: ratatui::style::Color) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    if let Some(cmd_len) = slash_command_token_len(line_text) {
        spans.push(Span::styled(
            line_text[..cmd_len].to_string(),
            Style::default().fg(PRIMARY()).bg(bg),
        ));
        if cmd_len < line_text.len() {
            spans.extend(style_paste_chips(&line_text[cmd_len..], bg));
        }
    } else {
        spans.extend(style_paste_chips(line_text, bg));
    }
    spans
}

/// Split a run of composer text so paste placeholders render as chips.
///
/// A stashed paste appears in the draft as `[#1 +142 lines]`; drawing it in the
/// body colour would read as text the user typed. It gets the accent colour and
/// a dim background instead, so it is obviously a stand-in for content.
fn style_paste_chips(text: &str, bg: ratatui::style::Color) -> Vec<Span<'static>> {
    let plain = Style::default().fg(FG()).bg(bg);
    let chip = Style::default()
        .fg(crate::style::SECONDARY())
        .bg(crate::style::BG_ACTIVE())
        .add_modifier(Modifier::BOLD);

    let mut spans = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("[#") {
        // A chip is `[#<digits> +<digits> lines]`; anything else is literal.
        let Some(close_rel) = rest[open..].find(']') else {
            break;
        };
        let close = open + close_rel + 1;
        let candidate = &rest[open..close];
        if is_paste_placeholder(candidate) {
            if open > 0 {
                spans.push(Span::styled(rest[..open].to_string(), plain));
            }
            spans.push(Span::styled(candidate.to_string(), chip));
            rest = &rest[close..];
        } else {
            spans.push(Span::styled(rest[..close].to_string(), plain));
            rest = &rest[close..];
        }
    }
    if !rest.is_empty() {
        spans.push(Span::styled(rest.to_string(), plain));
    }
    if spans.is_empty() {
        spans.push(Span::styled(String::new(), plain));
    }
    spans
}

/// Shape check for `[#<id> +<n> lines]` / `[#<id> +<n> chars]`.
fn is_paste_placeholder(token: &str) -> bool {
    let Some(inner) = token.strip_prefix("[#").and_then(|t| t.strip_suffix(']')) else {
        return false;
    };
    let Some((id, rest)) = inner.split_once(' ') else {
        return false;
    };
    let Some(count) = rest.strip_prefix('+').and_then(|r| {
        r.strip_suffix(" lines")
            .or_else(|| r.strip_suffix(" chars"))
    }) else {
        return false;
    };
    !id.is_empty()
        && id.chars().all(|c| c.is_ascii_digit())
        && !count.is_empty()
        && count.chars().all(|c| c.is_ascii_digit())
}

/// Split styled spans at a character position, returning (before, after).
/// Used so the blinking cursor lands exactly between the styled halves of a
/// command line.
fn split_spans_at(
    spans: Vec<Span<'static>>,
    char_pos: usize,
) -> (Vec<Span<'static>>, Vec<Span<'static>>) {
    let mut before = Vec::new();
    let mut after = Vec::new();
    let mut seen = 0usize;
    for span in spans {
        let len = span.content.chars().count();
        if seen + len <= char_pos {
            before.push(span);
        } else if seen >= char_pos {
            after.push(span);
        } else {
            // The cursor falls inside this span — split it.
            let take = char_pos - seen;
            let byte = super::char_to_byte(&span.content, take);
            let content = span.content.as_ref();
            before.push(Span::styled(content[..byte].to_string(), span.style));
            after.push(Span::styled(content[byte..].to_string(), span.style));
        }
        seen += len;
    }
    (before, after)
}

fn render_body(frame: &mut Frame, area: Rect, state: &AppState) {
    if area.width < 3 || area.height == 0 {
        return;
    }

    let bg = panel_bg();
    let is_running = !matches!(state.agent.state, AgentState::Idle | AgentState::Error(_));
    let text = &state.input.input_text;
    let focused = crate::state::modal_owner(state).allows_composer_input();
    let caret = || {
        Span::styled(
            "▌",
            Style::default()
                .fg(PRIMARY())
                .bg(bg)
                .add_modifier(Modifier::SLOW_BLINK),
        )
    };

    // Padding (1), prompt (2), and the cursor (1) use the side columns.
    let available_width = area.width.saturating_sub(4).max(1) as usize;

    let mut lines: Vec<Line> = Vec::new();

    // Queued messages: dim rows above the prompt. `»` waits for the turn
    // to end; `↗ … sending…` was handed to the running turn and joins at
    // its next step. The last row says how to act on the queue.
    // Attached media: one row of chips above everything else.
    if !state.input.attachments.is_empty() {
        let row_width = area.width.saturating_sub(2) as usize;
        let hint = if text.is_empty() {
            vec![Span::styled(
                "⌫ remove ",
                Style::default().fg(FG_DIM()).bg(bg),
            )]
        } else {
            Vec::new()
        };
        lines.push(Line::from(crate::widgets::justify(
            attachment_chips(&state.input.attachments, bg),
            hint,
            row_width,
            bg,
        )));
    }

    let queue = &state.agent.message_queue;
    let preview_rows = queued_preview_rows(queue.len());
    if preview_rows > 0 {
        let shown = preview_rows;
        let row_width = area.width.saturating_sub(2) as usize;
        let hint = (is_running && state.agent.has_unsent_queue() && text.is_empty())
            .then_some("↵ send now · ↑ edit");
        for (i, queued) in queue.iter().take(shown).enumerate() {
            let last = i + 1 == shown;
            let overflow = queue.len().saturating_sub(shown);
            let mut label = queued.display.lines().next().unwrap_or("").to_string();
            if last && overflow > 0 {
                label = format!("{label} … +{overflow} more");
            }
            let (mark, mark_color) = if queued.sending {
                ("↗", PRIMARY())
            } else {
                ("»", SECONDARY())
            };
            let mut lead = vec![
                Span::styled(" ", Style::default().bg(bg)),
                Span::styled(mark, Style::default().fg(mark_color).bg(bg)),
                Span::styled(" ", Style::default().bg(bg)),
                Span::styled(label, Style::default().fg(FG_DIM()).bg(bg)),
            ];
            if queued.sending {
                lead.push(Span::styled(
                    " · sending…",
                    Style::default().fg(FG_DIM()).bg(bg),
                ));
            }
            let trail = match hint {
                Some(hint) if last => vec![Span::styled(
                    format!("{hint} "),
                    Style::default().fg(FG_DIM()).bg(bg),
                )],
                _ => Vec::new(),
            };
            lines.push(Line::from(crate::widgets::justify(
                lead, trail, row_width, bg,
            )));
        }
    }

    if text.is_empty() {
        let prompt = if is_running {
            // The composer keeps its prompt glyph while a turn runs. It used
            // to swap in a spinner, which put a second animated indicator
            // directly under the activity strip's -- two spinners and two
            // "Thinking…" labels stacked on adjacent rows.
            Span::styled("❯ ", Style::default().fg(FG_DIM()).bg(bg))
        } else {
            Span::styled("❯ ", style::accent().bg(bg))
        };
        let placeholder = if is_running {
            "Queue a message…"
        } else if state.config.current_provider.is_empty() {
            "Connect a provider to get started"
        } else {
            "Ask anything…"
        };

        let mut spans = vec![Span::styled(" ", Style::default().bg(bg)), prompt];
        if focused {
            spans.push(caret());
        }
        // Show a placeholder in the empty composer. Keep the
        // queueing hint while running and the connect prompt before any
        // provider, plus the idle hint.
        if available_width > 4 {
            spans.push(Span::styled(
                format!(" {placeholder}"),
                Style::default().fg(FG_DIM()).bg(bg),
            ));
        }
        lines.push(Line::from(spans));
        // Fill remaining body rows so the card feels tall
        while lines.len() < area.height as usize {
            lines.push(Line::from(Span::styled(
                " ".repeat(area.width as usize),
                Style::default().bg(bg),
            )));
        }
    } else {
        let wrapped = wrap_input_layout(text, available_width);
        let cursor_char = state.input.input_cursor;
        let cursor_line = wrapped
            .iter()
            .position(|line| cursor_char >= line.start_char && cursor_char <= line.end_char)
            .unwrap_or_else(|| wrapped.len().saturating_sub(1));

        let header_rows = lines.len();
        let max_visible = (area.height as usize).saturating_sub(header_rows);
        let scroll = if max_visible > 0 && cursor_line >= max_visible {
            cursor_line - max_visible + 1
        } else {
            0
        };

        for (i, wrapped_line) in wrapped.iter().enumerate().skip(scroll).take(max_visible) {
            let line_text = &wrapped_line.text;
            // The activity strip already spins while running, so
            // the composer keeps its static ❯ — two stacked spinners read as
            // noise, not progress.
            let prompt = if i == 0 {
                Span::styled("❯ ", style::accent().bg(bg))
            } else {
                Span::styled("  ", Style::default().bg(bg))
            };

            let pad = Span::styled(" ", Style::default().bg(bg));
            if focused && i == cursor_line {
                let before_chars = cursor_char.saturating_sub(wrapped_line.start_char);
                // Split the styled line at the cursor so `/command` keeps its
                // accent color on both sides of the blinking ▌.
                let (before_spans, after_spans) =
                    split_spans_at(style_input_line(line_text, bg), before_chars);
                let mut row = vec![pad, prompt];
                row.extend(before_spans);
                row.push(caret());
                row.extend(after_spans);
                lines.push(Line::from(row));
            } else {
                let mut row = vec![pad, prompt];
                row.extend(style_input_line(line_text, bg));
                lines.push(Line::from(row));
            }
        }

        while lines.len() < area.height as usize {
            lines.push(Line::from(Span::styled(
                " ".repeat(area.width as usize),
                Style::default().bg(bg),
            )));
        }
    }

    frame.render_widget(Paragraph::new(lines).style(Style::default().bg(bg)), area);
}

/// Wrap input text by terminal cells while retaining source character offsets.
fn wrap_input_layout(text: &str, max_width: usize) -> Vec<WrappedInputLine> {
    let max_width = max_width.max(1);
    if text.is_empty() {
        return vec![WrappedInputLine {
            text: String::new(),
            start_char: 0,
            end_char: 0,
        }];
    }

    let mut lines = Vec::new();
    let mut line = String::new();
    let mut line_width = 0usize;
    let mut line_start = 0usize;
    let mut char_index = 0usize;

    for c in text.chars() {
        if c == '\n' {
            lines.push(WrappedInputLine {
                text: std::mem::take(&mut line),
                start_char: line_start,
                end_char: char_index,
            });
            char_index += 1;
            line_start = char_index;
            line_width = 0;
            continue;
        }

        let char_width = display_width(&c.to_string());
        if !line.is_empty() && line_width + char_width > max_width {
            lines.push(WrappedInputLine {
                text: std::mem::take(&mut line),
                start_char: line_start,
                end_char: char_index,
            });
            line_start = char_index;
            line_width = 0;
        }

        line.push(c);
        line_width += char_width;
        char_index += 1;
    }

    lines.push(WrappedInputLine {
        text: line,
        start_char: line_start,
        end_char: char_index,
    });
    lines
}

fn wrap_input_text(text: &str, max_width: usize) -> Vec<String> {
    wrap_input_layout(text, max_width)
        .into_iter()
        .map(|line| line.text)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_composer_is_compact() {
        let h = desired_height("", 80, 0, false);
        assert_eq!(h, min_height());
        assert_eq!(h, 3);
    }

    #[test]
    fn composer_caret_tracks_modal_focus() {
        use ratatui::{backend::TestBackend, Terminal};

        let mut state = AppState::new(Default::default(), "/tmp/agente".into());
        let mut terminal = Terminal::new(TestBackend::new(40, 3)).unwrap();
        for draft in ["", "draft"] {
            state.input.input_text = draft.into();
            for modal_open in [false, true] {
                state.input.show_command_palette = modal_open;
                terminal
                    .draw(|frame| render_body(frame, frame.area(), &state))
                    .unwrap();
                let cells = terminal.backend().buffer().content();
                assert_eq!(cells.iter().any(|cell| cell.symbol() == "▌"), !modal_open);
            }
        }
    }

    #[test]
    fn desired_height_grows_with_content() {
        let short = desired_height("hi", 80, 0, false);
        let multi = desired_height("one\ntwo\nthree\nfour", 80, 0, false);
        assert!(multi >= short);
        assert!(multi <= 2 + MAX_BODY_ROWS + 3);
    }

    #[test]
    fn approval_no_longer_adds_a_duplicate_footer() {
        // The floating approval card is the single Y/A/N surface.
        assert_eq!(desired_height("x", 80, 0, false), 3);
    }

    #[test]
    fn queued_messages_reserve_preview_rows() {
        assert_eq!(
            desired_height("", 80, 2, false),
            desired_height("", 80, 0, false) + 2
        );
        // Overflow beyond two collapses into the second preview row.
        assert_eq!(
            desired_height("", 80, 5, false),
            desired_height("", 80, 2, false)
        );
        assert_eq!(
            desired_height("", 80, 1, true),
            desired_height("", 80, 1, false) + 1
        );
    }

    #[test]
    fn desired_height_handles_narrow() {
        let h = desired_height("long input", 0, 0, false);
        assert!(h >= min_height());
    }

    #[test]
    fn typed_text_renders_with_queued_messages_and_survives_tight_heights() {
        use crate::state::QueuedMessage;
        use agente_core::media::{Attachment, AttachmentKind};
        use ratatui::{backend::TestBackend, Terminal};

        let mut state = AppState::new(Default::default(), "/tmp/agente".into());
        state.agent.state = AgentState::Executing;
        state.input.input_text = "visible draft".into();
        state.input.input_cursor = state.input.input_text.chars().count();

        for count in [1usize, 2] {
            state.agent.message_queue = (0..count)
                .map(|i| QueuedMessage::new(format!("queued-{i}")))
                .collect();
            let h = desired_height(&state.input.input_text, 60, count, false);
            let mut terminal = Terminal::new(TestBackend::new(60, h)).unwrap();
            terminal
                .draw(|frame| render(frame, frame.area(), &state))
                .unwrap();
            let text: String = terminal
                .backend()
                .buffer()
                .content()
                .iter()
                .map(|c| c.symbol())
                .collect();
            assert!(
                text.contains("visible draft"),
                "typed text must render with {count} queued message(s): {text}"
            );
            assert!(text.contains("queued-0"), "{text}");
        }

        // Tight heights smaller than header rows (queue + attachment) must never underflow.
        state.input.attachments.push(Attachment {
            kind: AttachmentKind::Image,
            name: "shot.png".into(),
            mime: "image/png".into(),
            path: "/tmp/shot.png".into(),
            bytes: 128,
        });
        for tight_h in [1u16, 2, 3, 4] {
            let mut terminal = Terminal::new(TestBackend::new(40, tight_h)).unwrap();
            terminal
                .draw(|frame| render_body(frame, frame.area(), &state))
                .unwrap();
        }
    }

    #[test]
    fn wrapping_uses_terminal_cell_width_and_tracks_newlines() {
        let wrapped = wrap_input_layout("ab界c\nd", 4);
        assert_eq!(wrapped[0].text, "ab界");
        assert_eq!((wrapped[0].start_char, wrapped[0].end_char), (0, 3));
        assert_eq!(wrapped[1].text, "c");
        assert_eq!((wrapped[1].start_char, wrapped[1].end_char), (3, 4));
        assert_eq!(wrapped[2].text, "d");
        assert_eq!((wrapped[2].start_char, wrapped[2].end_char), (5, 6));
        assert!(wrapped.iter().all(|line| display_width(&line.text) <= 4));
    }

    #[test]
    fn slash_token_len_detects_commands() {
        assert_eq!(slash_command_token_len("/compact"), Some(8));
        assert_eq!(slash_command_token_len("/model gpt-4o"), Some(6));
        assert_eq!(slash_command_token_len("/x"), Some(2));
        // Plain text, a bare slash, and empty input are not commands.
        assert_eq!(slash_command_token_len("hello"), None);
        assert_eq!(slash_command_token_len("/"), None);
        assert_eq!(slash_command_token_len(""), None);
        // Multi-byte commands keep a char-safe boundary.
        let len = slash_command_token_len("/réparer now").unwrap();
        assert_eq!(&"/réparer now"[..len], "/réparer");
    }

    #[test]
    fn style_input_line_highlights_only_the_command_token() {
        use ratatui::style::Color;

        let spans = style_input_line("/model gpt-4o", Color::Rgb(1, 2, 3));
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].content.as_ref(), "/model");
        assert_eq!(spans[0].style.fg, Some(PRIMARY()));
        assert_eq!(spans[1].content.as_ref(), " gpt-4o");
        assert_eq!(spans[1].style.fg, Some(FG()));

        // Plain lines keep the single-span rendering.
        let plain = style_input_line("just text", Color::Rgb(1, 2, 3));
        assert_eq!(plain.len(), 1);
        assert_eq!(plain[0].content.as_ref(), "just text");
        assert_eq!(plain[0].style.fg, Some(FG()));
    }

    #[test]
    fn split_spans_at_keeps_styles_on_both_sides() {
        use ratatui::style::Color;

        let spans = style_input_line("/model gpt-4o", Color::Rgb(1, 2, 3));
        // Cursor inside the command token (after "/mod").
        let (before, after) = split_spans_at(spans.clone(), 4);
        assert_eq!(before[0].content.as_ref(), "/mod");
        assert_eq!(before[0].style.fg, Some(PRIMARY()));
        assert_eq!(after[0].content.as_ref(), "el");
        assert_eq!(after[0].style.fg, Some(PRIMARY()));

        // Cursor exactly at the split boundary.
        let (before, after) = split_spans_at(spans.clone(), 6);
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].content.as_ref(), "/model");
        assert_eq!(after[0].content.as_ref(), " gpt-4o");
        assert_eq!(after[0].style.fg, Some(FG()));

        // Cursor at the end — everything before, nothing after.
        let (before, after) = split_spans_at(spans, 13);
        let joined: String = before.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(joined, "/model gpt-4o");
        assert!(after.is_empty());
    }
}
