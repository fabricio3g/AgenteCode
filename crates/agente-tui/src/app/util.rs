//! Shared helpers for the app layer.

pub(super) use crate::widgets::char_to_byte;

pub(super) fn shellexpand_folder(path: &str) -> String {
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.to_string_lossy(), &path[1..]);
        }
    }
    path.to_string()
}
