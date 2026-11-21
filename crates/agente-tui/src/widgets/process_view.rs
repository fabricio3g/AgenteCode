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

use super::scrollbar::{self, ScrollSurface};
use super::{s, truncate_cells, ModalChrome};
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
    let want_w = area.width.saturating_sub(6).clamp(1, 110);
    let want_h = area.height.saturating_sub(2).clamp(1, 36);
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
    let mut hints = vec![("↑↓", "scroll"), ("End", "follow")];
    if running {
        hints.push(("s", "stop"));
    }
    hints.push(("Esc", "close"));
    let modal = ModalChrome::new(vec![
        s("◆ ", Style::default().fg(border)),
        s(
            truncate_cells(&label, want_w.saturating_sub(24) as usize),
            style::bold(),
        ),
        s(status, style::dim()),
    ])
    .tinted(blend_colors(border, BORDER_RULE(), 0.35))
    .footer(&hints)
    .render_centered(frame, area, want_w, want_h);

    // Output rows inside modal.body, leaving the rightmost column for the scrollbar.
    let text = Rect::new(
        modal.body.x,
        modal.body.y,
        modal.body.width.saturating_sub(1),
        modal.body.height,
    );
    let lines: Vec<&str> = call.output.lines().collect();
    let visible = text.height as usize;
    let view = state.ui.process_view.as_mut().expect("checked above");
    let scroll = view.scroll.sync(lines.len(), visible);
    let viewport = view.scroll.viewport();
    view.area = Some(text);

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
        Rect::new(
            modal.inner.right().saturating_sub(1),
            text.y,
            1,
            text.height,
        ),
        ScrollSurface::Process,
        viewport,
        BG_PANEL(),
        &state.ui,
    );
}
