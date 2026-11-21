//! Subagent model list and legacy per-type pin configuration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Provider + model a subagent type runs on instead of the parent's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentModel {
    pub provider: String,
    pub model: String,
    /// Thinking level this override runs at; `None` inherits the parent's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

/// Subagent type → model override. The pre-list setting, still read from
/// old configs and folded into [`SubagentSettings`] by
/// [`super::AppConfig::subagent_settings`]; never written by current clients.
pub type SubagentModels = HashMap<String, SubagentModel>;

/// Legacy pin key that applied to every subagent type.
pub const ALL_SUBAGENTS: &str = "*";

/// `default_model` / `task` `model` value meaning "the parent's model".
pub const MAIN_MODEL: &str = "main";

/// One model the user offers to subagents: from any provider, under a name
/// the orchestrator picks it by, with the user's note on what it is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentModelEntry {
    pub name: String,
    pub provider: String,
    pub model: String,
    /// Thinking level this model runs at; `None` inherits the parent's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// The user's own words on when to use it; shown to the orchestrator.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub use_for: String,
}

/// The `subagents` setting: the models subagents may run on, the one they
/// run on when nothing else chooses, and whether the orchestrator may pick
/// from the list per spawn.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentSettings {
    /// `None` means on: the parent may pass `model` to `task`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_picks: Option<bool>,
    /// In display order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<SubagentModelEntry>,
    /// A list name or [`MAIN_MODEL`]; `None` runs on the parent's model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

/// Fold text into the list-name shape: lowercase ASCII letters and digits,
/// `.`, `_`, `-`; accents dropped, anything else one `-`, no `-` at the ends.
fn fold_name(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        let c = match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            other => other,
        };
        if c.is_ascii_lowercase() || c.is_ascii_digit() || "._".contains(c) {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

pub(super) fn is_default_subagents(settings: &SubagentSettings) -> bool {
    *settings == SubagentSettings::default()
}

impl SubagentSettings {
    pub fn picks(&self) -> bool {
        self.orchestrator_picks.unwrap_or(true)
    }

    pub fn entry(&self, name: &str) -> Option<&SubagentModelEntry> {
        self.models.iter().find(|entry| entry.name == name)
    }

    /// Names the orchestrator may pass: the list, when picking is on.
    pub fn pickable(&self) -> &[SubagentModelEntry] {
        if self.picks() {
            &self.models
        } else {
            &[]
        }
    }

    /// The default model's name, when it is still on the list (or `main`).
    pub fn default_name(&self) -> Option<&str> {
        self.default_model
            .as_deref()
            .filter(|name| *name == MAIN_MODEL || self.entry(name).is_some())
    }

    /// Check names before a client saves: non-empty, `[a-z0-9._-]`, unique,
    /// not reserved, and a provider and model on every entry.
    pub fn validate(&self) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for entry in &self.models {
            let name = entry.name.as_str();
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
            {
                return Err(format!(
                    "Subagent model name '{name}' must use lowercase letters, digits, '.', '_' or '-'."
                ));
            }
            if name == MAIN_MODEL {
                return Err(format!("'{name}' is reserved; choose another name."));
            }
            if !seen.insert(name) {
                return Err(format!("Two subagent models are named '{name}'."));
            }
            if entry.provider.trim().is_empty() || entry.model.trim().is_empty() {
                return Err(format!(
                    "Subagent model '{name}' needs a provider and a model."
                ));
            }
        }
        Ok(())
    }

    /// A free list name built from `model`: its last path segment, lowercased,
    /// other characters folded to `-`, suffixed `-2`, `-3` and so on when taken.
    pub fn unique_name(&self, model: &str) -> String {
        let tail = model.rsplit('/').next().unwrap_or(model);
        let mut base = fold_name(tail);
        if base.is_empty() || base == MAIN_MODEL {
            base = "model".into();
        }
        self.free_name(&base, None)
    }

    /// What a typed name becomes for the model at `index` — never refused
    /// (Postel's law): folded to the name rule, named after its model when
    /// emptied, `main` turned into `main-model`, and made unique.
    pub fn settled_name(&self, raw: &str, index: usize) -> String {
        let base = fold_name(raw);
        if base.is_empty() {
            return match self.models.get(index) {
                Some(entry) => {
                    let mut others = self.clone();
                    others.models.remove(index);
                    others.unique_name(&entry.model)
                }
                None => "model".into(),
            };
        }
        let base = if base == MAIN_MODEL {
            "main-model".to_string()
        } else {
            base
        };
        self.free_name(&base, Some(index))
    }

    fn free_name(&self, base: &str, except: Option<usize>) -> String {
        let taken = |name: &str| {
            self.models
                .iter()
                .enumerate()
                .any(|(i, entry)| Some(i) != except && entry.name == name)
        };
        let mut name = base.to_string();
        let mut n = 2;
        while taken(&name) {
            name = format!("{base}-{n}");
            n += 1;
        }
        name
    }

    /// Fold pre-list per-type pins in: each becomes a list entry (reusing
    /// one with the same provider, model and thinking), so no chosen model
    /// is lost, and the pin for every type (`*`) becomes the default model
    /// unless one is set.
    pub fn with_legacy(mut self, legacy: &SubagentModels) -> Self {
        let mut pins: Vec<(&String, &SubagentModel)> = legacy.iter().collect();
        pins.sort_by(|a, b| a.0.cmp(b.0));
        for (subagent_type, pin) in pins {
            let existing = self.models.iter().find(|entry| {
                entry.provider == pin.provider
                    && entry.model == pin.model
                    && entry.thinking == pin.thinking
            });
            let name = match existing {
                Some(entry) => entry.name.clone(),
                None => {
                    let name = self.unique_name(&pin.model);
                    self.models.push(SubagentModelEntry {
                        name: name.clone(),
                        provider: pin.provider.clone(),
                        model: pin.model.clone(),
                        thinking: pin.thinking.clone(),
                        use_for: String::new(),
                    });
                    name
                }
            };
            if subagent_type == ALL_SUBAGENTS && self.default_model.is_none() {
                self.default_model = Some(name);
            }
        }
        self
    }

    /// Project config on top of the user's: entries replace by name, new
    /// ones append, an explicit switch or default wins.
    pub(super) fn merge(&mut self, other: SubagentSettings) {
        if other.orchestrator_picks.is_some() {
            self.orchestrator_picks = other.orchestrator_picks;
        }
        if other.default_model.is_some() {
            self.default_model = other.default_model;
        }
        for entry in other.models {
            match self.models.iter_mut().find(|e| e.name == entry.name) {
                Some(existing) => *existing = entry,
                None => self.models.push(entry),
            }
        }
    }
}
