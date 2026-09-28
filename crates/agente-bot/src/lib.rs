//! Agente Bot: named bots with a persona, a memory and a model of their own.
//!
//! Each bot is a folder under the bots root (`~/.agente/bots/<handle>/`):
//!
//! ```text
//! bot.toml    title, role, avatar, model, toolsets, skills, daily budget
//! SOUL.md     who the bot is and how it works
//! USER.md     what it knows about the person it works for
//! MEMORY.md   notes it keeps for itself (see [`MemoryEdit`])
//! state.json  the bot's one permanent chat session
//! workspace/  the folder its tools work in
//! ```
//!
//! Colina is the default bot: created on first run and never deleted.

mod memory;
mod prompt;
mod routines;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use memory::MemoryEdit;
pub use prompt::persona_prompt;
pub use routines::{NewRoutine, Routine, RoutineRun, Schedule};

/// The bot every install starts with.
pub const DEFAULT_BOT: &str = "colina";
/// Longest SOUL.md, USER.md or MEMORY.md, in characters.
pub const DOC_CAP_CHARS: usize = 4_000;
const MAX_HANDLE_LEN: usize = 32;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Avatar {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initials: Option<String>,
    /// Image file inside the bot's folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// A named accent (the Desktop theme maps it to its accent tokens).
    pub tint: String,
}

/// A bot may pin its model; otherwise the client's current model is used.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelPin {
    pub provider: String,
    pub model: String,
}

/// What `bot.toml` holds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BotConfig {
    pub title: String,
    pub role: String,
    pub avatar: Avatar,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelPin>,
    pub toolsets: Vec<String>,
    pub skills: Vec<String>,
    /// Most it may spend in a day, in US dollars.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily_budget: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bot {
    pub handle: String,
    #[serde(flatten)]
    pub config: BotConfig,
    /// Built-in bots (Colina) can be edited but not deleted.
    pub builtin: bool,
}

/// A new bot. Without a handle, one is made from the title.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct NewBot {
    pub handle: Option<String>,
    #[serde(flatten)]
    pub config: BotConfig,
    pub soul: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Doc {
    Soul,
    User,
    Memory,
}

impl Doc {
    fn file(self) -> &'static str {
        match self {
            Doc::Soul => "SOUL.md",
            Doc::User => "USER.md",
            Doc::Memory => "MEMORY.md",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BotError {
    #[error("there is no bot @{0}")]
    NotFound(String),
    #[error("@{0} already exists")]
    Exists(String),
    #[error("invalid handle {0:?}: use up to 32 lowercase letters, digits or hyphens, starting with a letter")]
    InvalidHandle(String),
    #[error("@{0} is built in and can't be deleted")]
    Protected(String),
    #[error("{doc} would be {len} characters; the limit is {cap}")]
    TooLong {
        doc: &'static str,
        len: usize,
        cap: usize,
    },
    #[error("{0}")]
    Memory(String),
    #[error("{0}")]
    Routine(String),
    #[error("bot.toml of @{handle}: {message}")]
    Config { handle: String, message: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct BotState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    /// When each routine last ran, by routine id.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    routines: std::collections::BTreeMap<String, RoutineRun>,
}

pub struct BotStore {
    root: PathBuf,
}

impl BotStore {
    /// Open (and create) the bots folder; Colina is seeded when missing.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, BotError> {
        let store = Self { root: root.into() };
        std::fs::create_dir_all(&store.root)?;
        if !store.dir(DEFAULT_BOT).join("bot.toml").exists() {
            store.write_bot(DEFAULT_BOT, &colina(), Some(COLINA_SOUL))?;
        }
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn dir(&self, handle: &str) -> PathBuf {
        self.root.join(handle)
    }

    /// Every bot, Colina first, then by title.
    pub fn list(&self) -> Result<Vec<Bot>, BotError> {
        let mut bots = Vec::new();
        for entry in std::fs::read_dir(&self.root)? {
            let handle = entry?.file_name().to_string_lossy().to_string();
            // A folder that isn't a bot (or a broken bot.toml) is left alone.
            if valid_handle(&handle) {
                if let Ok(bot) = self.get(&handle) {
                    bots.push(bot);
                }
            }
        }
        bots.sort_by(|a, b| {
            (!a.builtin, a.config.title.to_lowercase())
                .cmp(&(!b.builtin, b.config.title.to_lowercase()))
        });
        Ok(bots)
    }

    pub fn get(&self, handle: &str) -> Result<Bot, BotError> {
        if !valid_handle(handle) {
            return Err(BotError::NotFound(handle.to_string()));
        }
        let path = self.dir(handle).join("bot.toml");
        let text = std::fs::read_to_string(&path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => BotError::NotFound(handle.to_string()),
            _ => BotError::Io(error),
        })?;
        let config = toml::from_str(&text).map_err(|error| BotError::Config {
            handle: handle.to_string(),
            message: error.to_string(),
        })?;
        Ok(Bot {
            handle: handle.to_string(),
            config,
            builtin: handle == DEFAULT_BOT,
        })
    }

    /// Find a bot by handle (`@scout` or `scout`), then by title.
    pub fn resolve(&self, name: &str) -> Result<Bot, BotError> {
        let name = name.trim().trim_start_matches('@');
        if let Ok(bot) = self.get(&name.to_lowercase()) {
            return Ok(bot);
        }
        self.list()?
            .into_iter()
            .find(|bot| bot.config.title.eq_ignore_ascii_case(name))
            .ok_or_else(|| BotError::NotFound(name.to_string()))
    }

    pub fn create(&self, new: NewBot) -> Result<Bot, BotError> {
        let handle = match new.handle {
            Some(handle) => handle.trim().trim_start_matches('@').to_string(),
            None => slug(&new.config.title),
        };
        if !valid_handle(&handle) {
            return Err(BotError::InvalidHandle(handle));
        }
        if self.dir(&handle).exists() {
            return Err(BotError::Exists(handle));
        }
        let mut config = new.config;
        if config.title.trim().is_empty() {
            config.title = handle.clone();
        }
        if config.avatar.initials.is_none() && config.avatar.image.is_none() {
            config.avatar.initials = Some(initials(&config.title));
        }
        let soul = new.soul.unwrap_or_default();
        check_len(Doc::Soul, &soul)?;
        self.write_bot(&handle, &config, Some(&soul))?;
        self.get(&handle)
    }

    /// Replace a bot's settings (`bot.toml`).
    pub fn update(&self, handle: &str, config: BotConfig) -> Result<Bot, BotError> {
        self.get(handle)?;
        self.write_bot(handle, &config, None)?;
        self.get(handle)
    }

    pub fn delete(&self, handle: &str) -> Result<(), BotError> {
        let bot = self.get(handle)?;
        if bot.builtin {
            return Err(BotError::Protected(bot.handle));
        }
        std::fs::remove_dir_all(self.dir(handle))?;
        Ok(())
    }

    pub fn read_doc(&self, handle: &str, doc: Doc) -> Result<String, BotError> {
        self.get(handle)?;
        match std::fs::read_to_string(self.dir(handle).join(doc.file())) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn write_doc(&self, handle: &str, doc: Doc, text: &str) -> Result<(), BotError> {
        self.get(handle)?;
        check_len(doc, text)?;
        std::fs::write(self.dir(handle).join(doc.file()), text)?;
        Ok(())
    }

    /// Apply one edit to the bot's MEMORY.md; returns the new memory.
    pub fn update_memory(&self, handle: &str, edit: &MemoryEdit) -> Result<String, BotError> {
        let current = self.read_doc(handle, Doc::Memory)?;
        let next = edit.apply(&current).map_err(BotError::Memory)?;
        self.write_doc(handle, Doc::Memory, &next)?;
        Ok(next)
    }

    /// The bot's permanent chat session, once it has one.
    pub fn session_id(&self, handle: &str) -> Result<Option<String>, BotError> {
        Ok(self.read_state(handle)?.session_id)
    }

    pub fn set_session_id(&self, handle: &str, session_id: &str) -> Result<(), BotError> {
        let mut state = self.read_state(handle)?;
        state.session_id = Some(session_id.to_string());
        self.write_state(handle, &state)
    }

    /// The folder the bot's tools work in (created on first use).
    pub fn workspace(&self, handle: &str) -> Result<PathBuf, BotError> {
        self.get(handle)?;
        let dir = self.dir(handle).join("workspace");
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// Who the bot is, what it remembers and who its teammates are.
    pub fn persona(&self, handle: &str) -> Result<String, BotError> {
        let bot = self.get(handle)?;
        let teammates: Vec<Bot> = self
            .list()?
            .into_iter()
            .filter(|other| other.handle != bot.handle)
            .collect();
        Ok(persona_prompt(
            &bot,
            &self.read_doc(handle, Doc::Soul)?,
            &self.read_doc(handle, Doc::User)?,
            &self.read_doc(handle, Doc::Memory)?,
            &teammates,
        ))
    }

    fn write_state(&self, handle: &str, state: &BotState) -> Result<(), BotError> {
        let text = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
        std::fs::write(self.dir(handle).join("state.json"), text)?;
        Ok(())
    }

    fn read_state(&self, handle: &str) -> Result<BotState, BotError> {
        self.get(handle)?;
        match std::fs::read_to_string(self.dir(handle).join("state.json")) {
            Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BotState::default()),
            Err(error) => Err(error.into()),
        }
    }

    fn write_bot(
        &self,
        handle: &str,
        config: &BotConfig,
        soul: Option<&str>,
    ) -> Result<(), BotError> {
        let dir = self.dir(handle);
        std::fs::create_dir_all(&dir)?;
        let text = toml::to_string_pretty(config).map_err(|error| BotError::Config {
            handle: handle.to_string(),
            message: error.to_string(),
        })?;
        std::fs::write(dir.join("bot.toml"), text)?;
        if let Some(soul) = soul {
            std::fs::write(dir.join(Doc::Soul.file()), soul)?;
            for doc in [Doc::User, Doc::Memory] {
                let path = dir.join(doc.file());
                if !path.exists() {
                    std::fs::write(path, "")?;
                }
            }
        }
        Ok(())
    }
}

fn check_len(doc: Doc, text: &str) -> Result<(), BotError> {
    let len = text.chars().count();
    if len > DOC_CAP_CHARS {
        return Err(BotError::TooLong {
            doc: doc.file(),
            len,
            cap: DOC_CAP_CHARS,
        });
    }
    Ok(())
}

pub fn valid_handle(handle: &str) -> bool {
    let mut chars = handle.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && handle.len() <= MAX_HANDLE_LEN
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A handle from a title: "Code Reviewer" → "code-reviewer".
pub(crate) fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let mut out: String = out
        .trim_end_matches('-')
        .chars()
        .take(MAX_HANDLE_LEN)
        .collect();
    out = out.trim_end_matches('-').to_string();
    if !out.starts_with(|c: char| c.is_ascii_lowercase()) {
        out = format!("bot-{out}").chars().take(MAX_HANDLE_LEN).collect();
    }
    out.trim_end_matches('-').to_string()
}

/// Up to two initials: "Code Reviewer" → "CR", "Scout" → "S".
fn initials(title: &str) -> String {
    title
        .split_whitespace()
        .filter_map(|word| word.chars().next())
        .take(2)
        .flat_map(char::to_uppercase)
        .collect()
}

fn colina() -> BotConfig {
    BotConfig {
        title: "Colina".into(),
        role: "your everyday assistant".into(),
        avatar: Avatar {
            initials: Some("C".into()),
            image: None,
            tint: "green".into(),
        },
        ..BotConfig::default()
    }
}

const COLINA_SOUL: &str = "\
Colina is warm, direct and practical: plain answers first, detail when asked.
- Ask when a request is unclear instead of guessing.
- Say so when you don't know something, then find out with your tools.
- Before changing files or anything outside this conversation, say what you'll do.
- When another bot is better suited to a task, hand it over and follow up.
- Keep what matters about the person you work for in your memory; never store secrets.
";

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, BotStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path().join("bots")).unwrap();
        (dir, store)
    }

    #[test]
    fn colina_is_seeded_and_protected() {
        let (_dir, store) = store();
        let bots = store.list().unwrap();
        assert_eq!(bots.len(), 1);
        assert_eq!(bots[0].handle, DEFAULT_BOT);
        assert!(bots[0].builtin);
        assert!(store
            .read_doc(DEFAULT_BOT, Doc::Soul)
            .unwrap()
            .contains("Colina"));
        assert!(matches!(
            store.delete(DEFAULT_BOT),
            Err(BotError::Protected(_))
        ));
    }

    #[test]
    fn reopening_keeps_edits_to_colina() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        let mut config = store.get(DEFAULT_BOT).unwrap().config;
        config.role = "my planner".into();
        store.update(DEFAULT_BOT, config).unwrap();
        let reopened = BotStore::open(dir.path()).unwrap();
        assert_eq!(reopened.get(DEFAULT_BOT).unwrap().config.role, "my planner");
    }

    #[test]
    fn create_list_resolve_and_delete() {
        let (_dir, store) = store();
        let scout = store
            .create(NewBot {
                config: BotConfig {
                    title: "Code Scout".into(),
                    role: "research".into(),
                    ..BotConfig::default()
                },
                soul: Some("Curious.".into()),
                ..NewBot::default()
            })
            .unwrap();
        assert_eq!(scout.handle, "code-scout");
        assert_eq!(scout.config.avatar.initials.as_deref(), Some("CS"));
        assert!(matches!(
            store.create(NewBot {
                handle: Some("code-scout".into()),
                ..NewBot::default()
            }),
            Err(BotError::Exists(_))
        ));

        let handles: Vec<String> = store
            .list()
            .unwrap()
            .into_iter()
            .map(|b| b.handle)
            .collect();
        assert_eq!(handles, ["colina", "code-scout"]);
        assert_eq!(store.resolve("@code-scout").unwrap().handle, "code-scout");
        assert_eq!(store.resolve("code scout").unwrap().handle, "code-scout");
        assert!(store.resolve("nobody").is_err());

        store.delete("code-scout").unwrap();
        assert!(matches!(
            store.get("code-scout"),
            Err(BotError::NotFound(_))
        ));
    }

    #[test]
    fn handles_are_checked() {
        let (_dir, store) = store();
        for bad in [
            "",
            "Upper",
            "9lives",
            "has space",
            "../escape",
            &"a".repeat(33),
        ] {
            assert!(
                matches!(
                    store.create(NewBot {
                        handle: Some(bad.to_string()),
                        ..NewBot::default()
                    }),
                    Err(BotError::InvalidHandle(_))
                ),
                "{bad:?} should be refused"
            );
        }
        assert!(store.get("../etc").is_err());
        assert_eq!(slug("  Hello, World! "), "hello-world");
        assert_eq!(slug("42 things"), "bot-42-things");
    }

    #[test]
    fn documents_are_capped() {
        let (_dir, store) = store();
        let long = "x".repeat(DOC_CAP_CHARS + 1);
        assert!(matches!(
            store.write_doc(DEFAULT_BOT, Doc::User, &long),
            Err(BotError::TooLong { .. })
        ));
        store
            .write_doc(DEFAULT_BOT, Doc::User, "Likes short answers.")
            .unwrap();
        assert_eq!(
            store.read_doc(DEFAULT_BOT, Doc::User).unwrap(),
            "Likes short answers."
        );
    }

    #[test]
    fn session_and_workspace_are_kept() {
        let (_dir, store) = store();
        assert_eq!(store.session_id(DEFAULT_BOT).unwrap(), None);
        store.set_session_id(DEFAULT_BOT, "abc").unwrap();
        assert_eq!(
            store.session_id(DEFAULT_BOT).unwrap().as_deref(),
            Some("abc")
        );
        assert!(store.workspace(DEFAULT_BOT).unwrap().is_dir());
    }

    #[test]
    fn persona_names_the_bot_its_memory_and_teammates() {
        let (_dir, store) = store();
        store
            .create(NewBot {
                handle: Some("scout".into()),
                config: BotConfig {
                    title: "Scout".into(),
                    role: "finds things out".into(),
                    ..BotConfig::default()
                },
                ..NewBot::default()
            })
            .unwrap();
        store
            .update_memory(
                DEFAULT_BOT,
                &MemoryEdit::Add {
                    line: "The user's project is called Agente.".into(),
                },
            )
            .unwrap();
        let persona = store.persona(DEFAULT_BOT).unwrap();
        assert!(persona.starts_with("You are Colina (@colina), your everyday assistant."));
        assert!(persona.contains("The user's project is called Agente."));
        assert!(persona.contains("@scout — Scout: finds things out"));
        assert!(!store.persona("scout").unwrap().contains("@scout —"));
    }
}
