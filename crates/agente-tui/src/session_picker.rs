use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style::{self, *};
use crate::widgets::pick::{pick_list, row_label, search_field, PickItem};
use crate::widgets::{centered_panel, shorten_path, ModalChrome};
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
    let footer: &[(&str, &str)] = if state.picker.session_picker_browsing {
        if state.picker.session_picker_project_select {
            &[
                ("↑↓", "move"),
                ("Enter", "open dir"),
                ("Backspace", "up"),
                ("Tab", "select project"),
                ("Esc", "close"),
            ]
        } else {
            &[
                ("↑↓", "move"),
                ("Enter", "open dir"),
                ("Backspace", "up"),
                ("Tab/Esc", "select folder"),
            ]
        }
    } else if state.picker.session_picker_project_select {
        &[
            ("↑↓", "move"),
            ("Enter", "use folder/session"),
            ("Tab", "edit folder"),
            ("Esc", "close"),
        ]
    } else {
        &[
            ("↑↓", "move"),
            ("Enter", "select"),
            ("Del", "delete"),
            ("Tab", "switch focus"),
            ("Esc", "close"),
        ]
    };

    let modal = ModalChrome::new(vec![Span::styled(
        title_text,
        Style::default()
            .fg(FG())
            .add_modifier(Modifier::BOLD)
            .bg(BG_PANEL()),
    )])
    .footer(footer)
    .render_in(frame, panel);

    let Some(folder_area) = modal.row(0) else {
        return;
    };
    let Some(list_area) = modal.slice_from(2) else {
        return;
    };

    if state.picker.session_picker_browsing {
        render_folder_browser(frame, folder_area, list_area, state);
    } else {
        render_session_list(frame, folder_area, list_area, state);
    }
}

fn render_folder_browser(frame: &mut Frame, folder_area: Rect, list_area: Rect, state: &AppState) {
    search_field(
        frame,
        folder_area,
        &state.picker.session_picker_browse_path,
        "Folder path",
    );

    let entries = list_directory(&state.picker.session_picker_browse_path);
    if entries.is_empty() {
        frame.render_widget(
            Paragraph::new(Span::styled("  (empty directory)", style::dim()))
                .style(Style::default().bg(BG_PANEL())),
            list_area,
        );
        return;
    }
    let selected = state.picker.session_picker_browse_selected;
    let items = entries
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let icon = if entry.is_dir {
                Span::styled("/ ", style::accent())
            } else {
                Span::styled("· ", style::dim())
            };
            PickItem::row(vec![
                icon,
                Span::styled(entry.name.clone(), row_label(i == selected)),
            ])
        })
        .collect();
    pick_list(
        frame,
        list_area,
        &state.ui.hits,
        ListId::FolderBrowser,
        items,
        selected,
    );
}

fn render_session_list(frame: &mut Frame, folder_area: Rect, list_area: Rect, state: &AppState) {
    let picker = &state.picker;
    if picker.session_picker_folder_active {
        search_field(
            frame,
            folder_area,
            &picker.session_picker_folder_input,
            "Folder",
        );
    } else {
        search_field(
            frame,
            folder_area,
            &picker.session_picker_query,
            "Search sessions",
        );
    }

    // Read from `state.picker.sessions`, not the filesystem: this runs on
    // every paint while the picker is open, and both the renderer and the key
    // handler must see the exact same unfiltered list (`picker.open()` loads
    // it once, and delete updates it in place).
    let folder = picker.session_picker_folder_input.trim();
    let query = picker.session_picker_query.to_lowercase();
    let filtered: Vec<&session::SessionMeta> = picker
        .sessions
        .iter()
        .filter(|meta| session_matches(meta, folder, &query))
        .collect();
    let selected = picker.session_picker_selected;

    // Row 0 is the "new" action (or the delete confirmation); sessions follow.
    // The action row only takes colour while it is the selected row: at rest it
    // is one more option, so the sessions under it are what the eye finds.
    let action = if selected == 0 {
        style::success().add_modifier(Modifier::BOLD)
    } else {
        style::muted()
    };
    let armed = selected > 0
        && picker.session_picker_confirm_delete.is_some()
        && filtered.get(selected - 1).map(|meta| meta.session_id)
            == picker.session_picker_confirm_delete;
    let first = if armed {
        PickItem::row_with_trail(
            vec![Span::styled("Delete this session?", style::error())],
            vec![Span::styled("Del confirm", style::dim())],
        )
    } else if picker.session_picker_project_select {
        PickItem::row(vec![Span::styled("+ Use This Folder", action)])
    } else {
        PickItem::row(vec![Span::styled("+ New Session", action)])
    };
    let mut items = vec![first];
    if filtered.is_empty() && (!folder.is_empty() || !query.is_empty()) {
        items.push(PickItem::Header("No matching sessions".into()));
    }
    for (i, meta) in filtered.iter().enumerate() {
        let title = crate::widgets::truncate_cells(&meta.label(), 32);
        let msgs = match meta.message_count {
            1 => "1 msg".to_string(),
            n => format!("{n} msgs"),
        };
        // Title and folder on the left edge; count and age on the right edge.
        items.push(PickItem::row_with_trail(
            vec![
                Span::styled(title, row_label(i + 1 == selected)),
                Span::styled(
                    format!("  {}", shorten_path(&meta.project_dir, None)),
                    style::dim(),
                ),
            ],
            vec![Span::styled(
                format!("{msgs} · {}", session::format_time_ago(&meta.last_active)),
                style::dim(),
            )],
        ));
    }
    pick_list(
        frame,
        list_area,
        &state.ui.hits,
        ListId::SessionList,
        items,
        selected,
    );
}

pub(crate) fn session_matches(meta: &session::SessionMeta, folder: &str, query: &str) -> bool {
    let matches_folder = folder.is_empty() || meta.project_dir.contains(folder);
    let matches_query = query.is_empty()
        || meta.title.to_lowercase().contains(query)
        || meta.first_prompt.to_lowercase().contains(query)
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

        dirs.sort_by_key(|a| a.name.to_lowercase());
        files.sort_by_key(|a| a.name.to_lowercase());

        entries.extend(dirs);
        entries.extend(files);
    }

    entries
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
