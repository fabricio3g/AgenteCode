//! Feature views. One module per Electron surface; the shell routes the rail
//! and sidebar to them. Every view borrows the app and stays stateless.

pub mod artifacts;
pub mod bots;
pub mod browser;
pub mod canvas;
pub mod code;
pub mod composer;
pub mod dialogs;
pub mod downloads;
pub mod editors;
pub mod panels;
pub mod home;
pub mod markdown;
pub mod onboarding;
pub mod roleplay;
pub mod search;
pub mod settings;
pub mod shell;
pub mod sidebar;
pub mod thread;
