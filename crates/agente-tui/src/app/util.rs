//! Shared helpers for the app layer.

use agente_core::session::SessionMeta;

pub(super) fn shellexpand_folder(path: &str) -> String {
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.to_string_lossy(), &path[1..]);
        }
    }
    path.to_string()
}

pub(super) fn session_matches(session: &SessionMeta, folder: &str, query: &str) -> bool {
    let matches_folder = folder.is_empty() || session.project_dir.contains(folder);
    let matches_query = query.is_empty()
        || session.project_dir.to_lowercase().contains(query)
        || session.provider.to_lowercase().contains(query)
        || session.model.to_lowercase().contains(query);
    matches_folder && matches_query
}

pub(super) fn char_to_byte(s: &str, char_idx: usize) -> usize {
    s.char_indices()
        .nth(char_idx)
        .map(|(byte_idx, _)| byte_idx)
        .unwrap_or(s.len())
}
