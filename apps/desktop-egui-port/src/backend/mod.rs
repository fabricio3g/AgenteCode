//! Resolved engine paths and UI preferences.
//!
//! The engine reads and writes the *core* config (`~/.agente/config.json`,
//! plus the project's `agente.json`) so the port shares providers, keys and
//! model selection with the TUI and with anything else on this machine. Only
//! window-level preferences (theme, text size, sidebar) live in a small file
//! of our own.

use std::path::PathBuf;

pub mod engine;

use serde::{Deserialize, Serialize};

/// Agent mode. Same vocabulary as the Electron plan/build toggle; the core
/// decides which tools each mode exposes.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub enum AgentMode {
    #[default]
    Plan,
    Build,
}

impl AgentMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Plan => "Plan",
            Self::Build => "Build",
        }
    }

    pub fn toggle(self) -> Self {
        match self {
            Self::Plan => Self::Build,
            Self::Build => Self::Plan,
        }
    }
}

/// Which space a thread belongs to. Ports `SpaceId`: home, code and roleplay
/// each keep their own list; bots has no thread list.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub enum SessionSpace {
    #[default]
    Home,
    Code,
    Roleplay,
}

impl SessionSpace {
    pub fn label(self) -> &'static str {
        match self {
            Self::Home => "Home",
            Self::Code => "Code",
            Self::Roleplay => "Roleplay",
        }
    }
}

/// Window preferences. Never holds provider keys: those live in the core
/// config, which is the file the rest of Agente reads.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Prefs {
    #[serde(default = "yes")]
    pub theme_dark: bool,
    #[serde(default = "one")]
    pub reading_scale: f32,
    #[serde(default = "yes")]
    pub sidebar_open: bool,
    #[serde(default)]
    pub reduce_motion: bool,
    #[serde(default)]
    pub project_dir: String,
    #[serde(default = "auto_level")]
    pub thinking_level: String,
    #[serde(default)]
    pub onboarding_done: bool,
}

fn yes() -> bool {
    true
}

fn one() -> f32 {
    1.0
}

fn auto_level() -> String {
    "auto".to_owned()
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme_dark: true,
            reading_scale: 1.0,
            sidebar_open: true,
            reduce_motion: false,
            project_dir: String::new(),
            thinking_level: "auto".to_owned(),
            onboarding_done: false,
        }
    }
}

impl Prefs {
    fn path() -> Option<PathBuf> {
        dirs::config_dir().map(|dir| dir.join("agente").join("desktop-egui.json"))
    }

    pub fn load() -> Self {
        Self::path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        if let Some(path) = Self::path() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(text) = serde_json::to_string_pretty(self) {
                let _ = std::fs::write(path, text);
            }
        }
    }
}

/// Where the desktop keeps its own session list. The engine's conversations
/// are stored here too, so a restart replays the same transcript the model
/// saw; the shared append-only store stays available for `--resume` parity.
fn state_file() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("agente").join("desktop-egui-state.json"))
}

pub fn read_state<T: for<'de> Deserialize<'de>>() -> Option<T> {
    let path = state_file()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_state<T: Serialize>(value: &T) {
    let Some(path) = state_file() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(value) {
        let _ = std::fs::write(path, text);
    }
}

/// Small text files for the port (canvas notes, drafts).
pub fn data_file(name: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("agente").join("desktop-egui").join(name))
}

pub fn read_text(name: &str) -> String {
    data_file(name)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default()
}

pub fn write_text(name: &str, content: &str) {
    if let Some(path) = data_file(name) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, content);
    }
}

/// True when the shared append-only session store opens next to the TUI
/// sessions, so desktop turns and terminal turns resume each other.
pub fn shared_session_store_linked() -> bool {
    let root = dirs::data_dir().map(|dir| dir.join("agente").join("sessions"));
    root.map(agente_session::SessionStore::open)
        .map(|store| store.is_ok())
        .unwrap_or(false)
}

/// Wire protocol version shared with every Agente client.
pub fn protocol_version() -> u16 {
    agente_protocol::PROTOCOL_VERSION
}
