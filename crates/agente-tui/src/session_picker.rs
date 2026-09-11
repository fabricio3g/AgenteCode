use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{List, ListItem, ListState, Paragraph};
use ratatui::Frame;

use crate::state::AppState;
use crate::style::{self, *};
use crate::widgets::{centered_panel, modal_card, modal_footer, panel_row, truncate_cells};
use agente_core::session;

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.picker.show_session_picker {
        return;
    }

    if area.width == 0 || area.height == 0 {
        return;
    }

    // Centered bordered card column. The
    // overlay backdrop already hides the chat behind the side margins.
    let panel = centered_panel(area, area.width.saturating_sub(6).min(100), area.height);
    if panel.width < 10 || panel.height < 6 {
        return;
    }

    let title_text = if state.picker.session_picker_project_select {
        "Open Project"
    } else {
        "Sessions"
    };
    let body = modal_card(
        frame,
        panel,
        vec![Span::styled(
            title_text,
            Style::default()
                .fg(FG())
                .add_modifier(Modifier::BOLD)
                .bg(BG_PANEL()),
        )],
    );

    // Folder/search input at the top of the card, list below it, and the
    // navigation hints in the footer row.
    let Some(folder_area) = panel_row(body, 0, 1) else {
        return;
    };
    let Some(list_top) = panel_row(body, 1, 1) else {
        return;
    };
    let list_area = Rect {
        height: body.height.saturating_sub(2),
        ..list_top
    };

    let footer_text = if state.picker.session_picker_browsing {
        if state.picker.session_picker_project_select {
            "↑↓ navigate · ↵ open dir · Backspace up · Tab select project · Esc close"
        } else {
            "↑↓ navigate · ↵ open dir · Backspace up · Tab/Esc select folder"
        }
    } else if state.picker.session_picker_project_select {
        "↑↓ navigate · ↵ use folder/session · Tab edit folder · Esc close"
    } else {
        "↑↓ navigate · ↵ select · Del delete · Tab switch focus · Esc close"
    };

    if state.picker.session_picker_browsing {
        render_folder_browser(frame, folder_area, list_area, state);
    } else {
        render_session_list(frame, folder_area, list_area, state);
    }

    modal_footer(
        frame,
        body,
        vec![Span::styled(
            truncate_cells(footer_text, (body.width as usize).saturating_sub(2)),
            style::dim(),
        )],
    );
}

fn render_folder_browser(frame: &mut Frame, folder_area: Rect, list_area: Rect, state: &AppState) {
    let folder_line = Line::from(vec![
        Span::styled("▸ ", style::input_prompt()),
        Span::styled(
            state.picker.session_picker_browse_path.clone(),
            style::highlight(),
        ),
        Span::styled(
            "▌",
            Style::default()
                .fg(PRIMARY())
                .add_modifier(Modifier::SLOW_BLINK),
        ),
    ]);
    frame.render_widget(Paragraph::new(folder_line), folder_area);

    let entries = list_directory(&state.picker.session_picker_browse_path);
    let mut items: Vec<ListItem> = Vec::new();

    for (i, entry) in entries.iter().enumerate() {
        let is_selected = i == state.picker.session_picker_browse_selected;
        let s = if is_selected {
            style::selected()
        } else {
            Style::default().fg(FG())
        };

        let (icon, icon_style) = if entry.is_dir {
            ("/ ", Style::default().fg(PRIMARY()))
        } else {
            ("· ", Style::default().fg(FG_DIM()))
        };

        items.push(ListItem::new(Line::from(vec![
            Span::styled(
                if is_selected { "▸ " } else { "  " }.to_string(),
                Style::default().fg(PRIMARY()),
            ),
            Span::styled(icon, icon_style),
            Span::styled(entry.name.clone(), s),
        ])));
    }

    if entries.is_empty() {
        items.push(ListItem::new(Line::from(Span::styled(
            "  (empty directory)",
            style::dim(),
        ))));
    }

    let mut list_state = ListState::default();
    if !entries.is_empty() {
        list_state.select(Some(
            state
                .picker
                .session_picker_browse_selected
                .min(entries.len() - 1),
        ));
    }

    let list = List::new(items).style(Style::default().bg(BG_PANEL()));
    frame.render_stateful_widget(list, list_area, &mut list_state);
}

fn render_session_list(frame: &mut Frame, folder_area: Rect, list_area: Rect, state: &AppState) {
    let folder_line = if state.picker.session_picker_folder_active {
        Line::from(vec![
            Span::styled("▸ ", style::input_prompt()),
            Span::styled(
                state.picker.session_picker_folder_input.clone(),
                style::highlight(),
            ),
            Span::styled(
                "▌",
                Style::default()
                    .fg(PRIMARY())
                    .add_modifier(Modifier::SLOW_BLINK),
            ),
        ])
    } else {
        let query = &state.picker.session_picker_query;
        let text = if query.is_empty() {
            "Search sessions"
        } else {
            query
        };
        let text_style = if query.is_empty() {
            style::dim()
        } else {
            style::text()
        };
        Line::from(vec![
            Span::styled("⌕ ", style::input_prompt()),
            Span::styled(text.to_string(), text_style),
            Span::styled(
                "▌",
                Style::default()
                    .fg(PRIMARY())
                    .add_modifier(Modifier::SLOW_BLINK),
            ),
        ])
    };
    frame.render_widget(Paragraph::new(folder_line), folder_area);

    // Read from state, not the filesystem: this runs on every paint while the
    // picker is open, and re-parsing the whole session index per frame also
    // made the harness scenario render whatever sessions happened to exist on
    // the machine running the tests. `refresh_recent_sessions` keeps it current.
    let sessions = &state.ui.recent_sessions;
    let folder = state.picker.session_picker_folder_input.trim();
    let query = state.picker.session_picker_query.to_lowercase();

    let mut items: Vec<ListItem> = Vec::new();

    if state.picker.session_picker_confirm_delete && state.picker.session_picker_selected > 0 {
        items.push(ListItem::new(Line::from(vec![
            Span::styled("  ", Style::default()),
            Span::styled(
                "Delete this session? Del=confirm  Esc/Up/Down=cancel",
                Style::default().fg(ERROR()).add_modifier(Modifier::BOLD),
            ),
        ])));
    } else {
        items.push(ListItem::new(Line::from(Span::styled(
            if state.picker.session_picker_project_select {
                "  + Use This Folder"
            } else {
                "  + New Session"
            },
            Style::default().fg(SUCCESS()).add_modifier(Modifier::BOLD),
        ))));
    }

    let mut filtered_sessions: Vec<&session::SessionMeta> = Vec::new();
    for s in sessions {
        if session_matches(s, folder, &query) {
            filtered_sessions.push(s);
        }
    }

    if filtered_sessions.is_empty() && (!folder.is_empty() || !query.is_empty()) {
        items.push(ListItem::new(Line::from(Span::styled(
            "  No matching sessions",
            style::dim(),
        ))));
    }

    for (i, s) in filtered_sessions.iter().enumerate() {
        let idx = i + 1;
        let is_selected = idx == state.picker.session_picker_selected;

        let time_ago = session::format_time_ago(&s.last_active);
        let msg_count = if s.message_count == 1 {
            "1 msg".to_string()
        } else {
            format!("{} msgs", s.message_count)
        };

        let title = s.label();
        let path_short = shorten_path(&s.project_dir);
        let available = (list_area.width as usize).saturating_sub(2);
        let title = crate::widgets::truncate_cells(&title, available.min(32));
        let metadata = format!(" · {path_short} · {msg_count} · {time_ago}");
        let metadata = crate::widgets::truncate_cells(
            &metadata,
            available.saturating_sub(title.chars().count()),
        );
        let row_bg = if is_selected { BG_ACTIVE() } else { BG_PANEL() };
        let rail = if is_selected { "│ " } else { "  " };
        let rail_style = Style::default()
            .fg(if is_selected { BORDER_ACTIVE() } else { row_bg })
            .bg(row_bg);
        let title_style = Style::default()
            .fg(FG())
            .bg(row_bg)
            .add_modifier(if is_selected {
                Modifier::BOLD
            } else {
                Modifier::empty()
            });
        let meta_style = Style::default().fg(FG_DIM()).bg(row_bg);

        items.push(ListItem::new(Line::from(vec![
            Span::styled(rail, rail_style),
            Span::styled(title, title_style),
            Span::styled(metadata, meta_style),
        ])));
    }

    let mut list_state = ListState::default();
    let total = items.len();
    if total > 0 {
        list_state.select(Some(state.picker.session_picker_selected.min(total - 1)));
    }

    let list = List::new(items).style(Style::default().bg(BG_PANEL()));
    frame.render_stateful_widget(list, list_area, &mut list_state);
}

fn session_matches(meta: &session::SessionMeta, folder: &str, query: &str) -> bool {
    let matches_folder = folder.is_empty() || meta.project_dir.contains(folder);
    let matches_query = query.is_empty()
        || meta.title.to_lowercase().contains(query)
        || meta.project_dir.to_lowercase().contains(query)
        || meta.provider.to_lowercase().contains(query)
        || meta.model.to_lowercase().contains(query);
    matches_folder && matches_query
}

pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

pub fn list_directory(path: &str) -> Vec<DirEntry> {
    let mut entries = Vec::new();

    if path.is_empty() {
        if cfg!(target_os = "windows") {
            for drive in b'C'..=b'Z' {
                let drive_path = format!("{}:\\", drive as char);
                if std::path::Path::new(&drive_path).exists() {
                    entries.push(DirEntry {
                        name: format!("{}:", drive as char),
                        is_dir: true,
                    });
                }
            }
        } else {
            entries.push(DirEntry {
                name: "/".to_string(),
                is_dir: true,
            });
        }
        return entries;
    }

    if let Ok(read_dir) = std::fs::read_dir(path) {
        let mut dirs: Vec<_> = Vec::new();
        let mut files: Vec<_> = Vec::new();

        for entry in read_dir.flatten() {
            if let Ok(file_type) = entry.file_type() {
                let name = entry.file_name().to_string_lossy().to_string();
                let is_dir = file_type.is_dir();
                if is_dir {
                    dirs.push(DirEntry { name, is_dir });
                } else {
                    files.push(DirEntry { name, is_dir });
                }
            }
        }

        dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        entries.extend(dirs);
        entries.extend(files);
    }

    entries
}

fn shorten_path(path: &str) -> String {
    let clean = agente_core::util::normalize_project_dir(path);
    if let Some(home) = dirs::home_dir() {
        let home_s = agente_core::util::normalize_project_dir(home);
        if let Some(rest) = clean.strip_prefix(&home_s) {
            return format!("~{rest}");
        }
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_search_matches_generated_title() {
        let mut meta = session::create_session_meta("/tmp/agente");
        meta.title = "Improve Session Navigation".into();
        meta.provider = "openai".into();
        meta.model = "gpt-test".into();

        assert!(session_matches(&meta, "", "session navigation"));
        assert!(session_matches(&meta, "/tmp", "improve"));
        assert!(!session_matches(&meta, "/other", "improve"));
    }
}
