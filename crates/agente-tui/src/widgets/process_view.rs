//! Live output of a running tool call — click a running row to watch it.
//!
//! Follows the newest output by default (like `tail -f`); scrolling up
//! pauses following, End resumes. The view outlives the call: when it
//! finishes, the final output stays until you close it.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::scrollbar::{self, ScrollSurface, Viewport};
use super::{footer_hints, modal_card_tinted, modal_footer, s, truncate_cells};
use crate::state::{AppState, LiveToolCall};
use crate::style::{self, *};

/// Why a running call shows nothing yet — a piped command prints only when
/// the pipe's tail end finishes.
pub fn empty_output_hint(call: &LiveToolCall) -> &'static str {
    let piped = call
        .command()
        .is_some_and(|cmd| cmd.contains("| tail") || cmd.contains("| head"));
    if piped {
        "no output yet · piped output appears when the command finishes"
    } else {
        "no output yet"
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    let Some(view) = state.ui.process_view.as_ref() else {
        return;
    };
    let live = state.agent.live_tool_calls.get(&view.call_id);
    let running = live.is_some();
    let Some(call) = live.or(view.finished.as_ref()).cloned() else {
        return;
    };
    if area.width < 20 || area.height < 8 {
        return;
    }
    let panel = super::centered_panel(
        area,
        area.width.saturating_sub(6).clamp(1, 110),
        area.height.saturating_sub(2).clamp(1, 36),
    );
    let (verb, subject) = super::chat::tool_header_parts(&call.name, Some(&call.args), 200);
    let label = match verb {
        Some(verb) if subject.is_empty() => verb,
        Some(verb) => format!("{verb} {subject}"),
        None => subject,
    };
    let status = if running {
        format!(" · running {}", call.elapsed_label())
    } else {
        " · finished".to_string()
    };
    let border = if running { PRIMARY() } else { FG_DIM() };
    let body = modal_card_tinted(
        frame,
        panel,
        vec![
            s("◆ ", Style::default().fg(border)),
            s(
                truncate_cells(&label, panel.width.saturating_sub(24) as usize),
                style::bold(),
            ),
            s(status, style::dim()),
        ],
        blend_colors(border, BORDER_RULE(), 0.35),
    );

    // Output rows between the top gap and the footer gap; one column on the
    // right for the scrollbar.
    let rows = body.height.saturating_sub(3);
    let text = Rect::new(body.x + 1, body.y + 1, body.width.saturating_sub(3), rows);
    let lines: Vec<&str> = call.output.lines().collect();
    let visible = rows as usize;
    let max_scroll = lines.len().saturating_sub(visible);
    let view = state.ui.process_view.as_mut().expect("checked above");
    view.max_scroll = max_scroll;
    if view.follow {
        view.scroll = max_scroll;
    }
    view.scroll = view.scroll.min(max_scroll);
    view.area = Some(text);
    let scroll = view.scroll;

    if lines.is_empty() {
        let hint = if running {
            empty_output_hint(&call)
        } else {
            "no output"
        };
        frame.render_widget(Paragraph::new(s(hint, style::dim())), text);
    } else {
        let shown: Vec<Line<'static>> = lines
            .iter()
            .skip(scroll)
            .take(visible)
            .map(|line| Line::from(s(truncate_cells(line, text.width as usize), style::muted())))
            .collect();
        frame.render_widget(Paragraph::new(shown), text);
    }
    scrollbar::render(
        frame,
        Rect::new(body.right().saturating_sub(1), text.y, 1, rows),
        ScrollSurface::Process,
        Viewport {
            offset: scroll,
            visible,
            total: lines.len(),
        },
        BG_PANEL(),
        &state.ui,
    );

    let mut hints = vec![("↑↓", "scroll"), ("End", "follow")];
    if running {
        hints.push(("s", "stop"));
    }
    hints.push(("Esc", "close"));
    modal_footer(
        frame,
        body,
        footer_hints(&hints, body.width.saturating_sub(2)),
    );
}
