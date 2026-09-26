//! Inline slash picker attached above the input.
//!
//! Opaque borderless panel with a slim header rule over the same command
//! rows as the palette.

use ratatui::layout::Rect;
use ratatui::Frame;

pub use crate::command_palette::filter_commands;
use crate::state::{AppState, ListId};
use crate::style;
use crate::widgets::{panel_bg, panel_header, s};

pub fn render_above_input(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_slash_picker || area.width < 8 || area.y == 0 {
        return;
    }

    let query = state.input.input_text.trim_start_matches('/');
    let commands = filter_commands(query);
    if commands.is_empty() {
        return;
    }

    // Slim header(1) + list rows; the picker hugs the composer.
    let list_rows = commands
        .len()
        .clamp(1, 8)
        .min(area.y.saturating_sub(1) as usize);
    if list_rows == 0 {
        return;
    }
    let height = (list_rows as u16).saturating_add(1);
    if height > area.y {
        return;
    }

    let picker = Rect::new(area.x, area.y.saturating_sub(height), area.width, height);

    panel_bg(frame, picker);
    let body = panel_header(frame, picker, vec![s("Slash commands", style::bold())]);

    crate::command_palette::render_command_list(
        frame,
        body,
        state,
        ListId::SlashPicker,
        &commands,
        state.input.slash_picker_selected,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::text::Line;
    use ratatui::widgets::Paragraph;
    use ratatui::Terminal;

    #[test]
    fn slash_picker_covers_background() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/project".to_string());
        state.input.show_slash_picker = true;
        state.input.input_text = "/".to_string();
        let backend = TestBackend::new(40, 16);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                let junk = "X".repeat(area.width as usize);
                let lines: Vec<Line> = (0..area.height).map(|_| Line::from(junk.clone())).collect();
                frame.render_widget(Paragraph::new(lines), area);
                // Input strip at bottom; picker renders above it
                let input = Rect::new(0, area.height.saturating_sub(3), area.width, 3);
                render_above_input(frame, input, &state);
            })
            .unwrap();
        let buf = terminal.backend().buffer();
        // Row just above input should not be pure X if picker drew
        let y = buf.area.height.saturating_sub(5);
        let cell = &buf[(2, y)];
        assert_ne!(cell.symbol(), "X");
    }
}
