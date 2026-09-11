pub mod app;
pub mod at_file_picker;
pub mod command_palette;
pub mod connect;
pub mod doctor;
pub mod editor;
#[cfg(test)]
mod freeze_harness;
pub mod git_status;
pub mod help;
pub mod mentions;
pub mod model_selector;
pub mod session_picker;
pub mod slash_command;
pub mod state;
pub mod style;
pub mod syntax_highlight;
pub mod thinking_selector;
#[cfg(test)]
mod ui_harness;
pub mod web_export;
pub mod web_inspector;
pub mod widgets;

// The crate root exposes only what a consumer actually binds to. The three
// globs this replaces dumped `escape_html`, `unicode_width`, `fill`, every
// theme accessor and the inspector's internals into the root namespace, where
// they collided with same-named helpers and hid what the public surface is.
// Everything else stays reachable through its own module (`agente_tui::style`,
// `agente_tui::web_inspector`, …).
pub use app::App;
pub use state::AppState;
pub use style::{set_theme, Theme};
pub use syntax_highlight::{detect_language, highlight_code};
