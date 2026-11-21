//! Post-paint chat overlays: hover tint, prompt-card hover, message fade,
//! jump-to-bottom chip, transient toast, text selection highlight, and scrollbar.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use agente_core::types::ClickKind;

use crate::state::AppState;
use crate::style::*;
use crate::widgets::{display_width, truncate_cells};

/// Background lift under the hovered card's rows, plus an accent rail on
/// subagent cards (they open a modal, so they should read as buttons).
/// Painted over the finished frame so hover never touches the render caches;
/// only bare canvas cells change, so prompt cards and diff rows keep their
/// own backgrounds, and blank spacer rows stay untouched.
pub(super) fn paint_hover_tint(frame: &mut Frame, area: Rect, state: &AppState) {
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
pub(super) fn paint_prompt_hover(
    buf: &mut ratatui::buffer::Buffer,
    area: Rect,
    top: u16,
    bottom: u16,
    ease: f32,
) {
    const HINT: &str = "revert · fork · copy ";
    let band = super::blocks::USER_BUBBLE_BG();
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
                    cell.set_fg(super::blocks::user_rail_color(true));
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
pub(super) fn paint_message_fade(frame: &mut Frame, area: Rect, state: &AppState) {
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

/// Bottom-right ↓ control: click re-pins auto-scroll to the live tail.
pub(super) fn render_jump_to_bottom(frame: &mut Frame, chat_area: Rect, state: &mut AppState) {
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

pub(super) fn apply_selection_style(
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

pub(super) fn render_scrollbar(frame: &mut Frame, area: Rect, state: &mut AppState) {
    // A modal owns the screen: the chat paints before the overlay, so a bar
    // drawn here would run down the edge across the open card (and grab its
    // clicks). The shared bar also blanks the gutter when everything fits.
    let (total, visible) = if crate::state::modal_owner(state).is_modal() {
        (0, 0)
    } else {
        (state.ui.chat_content_height, state.ui.chat_visible_height)
    };
    crate::widgets::scrollbar::render(
        frame,
        area,
        crate::widgets::scrollbar::ScrollSurface::Chat,
        crate::widgets::scrollbar::Viewport {
            offset: state.ui.chat_scroll,
            visible,
            total,
        },
        BG(),
        &state.ui,
    );
}
