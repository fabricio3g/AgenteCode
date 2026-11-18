pub(crate) mod app;
pub(crate) mod at_file_picker;
pub(crate) mod brand;
pub(crate) mod clipboard;
pub(crate) mod command_palette;
pub(crate) mod connect;
pub(crate) mod doctor;
pub(crate) mod editor;
#[cfg(test)]
mod freeze_harness;
pub(crate) mod git_status;
pub(crate) mod help;
pub(crate) mod mcp_servers;
pub(crate) mod media_consent;
pub(crate) mod mentions;
pub(crate) mod message_actions;
pub(crate) mod model_selector;
pub(crate) mod session_picker;
pub(crate) mod settings;
pub(crate) mod skills;
pub(crate) mod slash_command;
pub(crate) mod state;
pub(crate) mod style;
pub(crate) mod subagent_models;
pub(crate) mod syntax_highlight;
#[cfg(test)]
pub(crate) mod test_support;
pub(crate) mod thinking_selector;
#[cfg(test)]
mod ui_harness;
pub(crate) mod web_export;
pub mod web_inspector;
pub(crate) mod widgets;

// The crate root exposes only what a consumer actually binds to: the `agente`
// binary runs `App` and `agente --inspect` serves `web_inspector`. Everything
// else is crate-private, so the `dead_code` lint sees it.
pub use app::App;
