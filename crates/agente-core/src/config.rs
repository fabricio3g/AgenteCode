use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::auth::AuthStore;
use crate::catalog::{ModelCapabilities, ModelCost, ModelLimits, ModelStatus};
use crate::mcp::McpConfig;

pub const DEFAULT_MAX_CONCURRENT_SUBAGENTS: usize = 8;

/// Provider configuration options
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderOptions {
    #[serde(rename = "apiKey", alias = "api_key", default)]
    pub api_key: Option<String>,
    #[serde(rename = "baseURL", alias = "base_url", default)]
    pub base_url: Option<String>,
    #[serde(rename = "enterpriseUrl", default)]
    pub enterprise_url: Option<String>,
    #[serde(default)]
    pub timeout: Option<u32>,
    #[serde(rename = "chunkTimeout", default)]
    pub chunk_timeout: Option<u32>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Provider configuration: endpoint, credentials, and model catalog entries.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<crate::providers::policy::TransportPolicy>,
    #[serde(default)]
    pub api: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub npm: Option<String>,
    /// Wire format: "openai" or "anthropic" (Messages-compatible gateways).
    /// Defaults to "openai" when missing.
    #[serde(default)]
    pub api_format: Option<String>,
    #[serde(default)]
    pub whitelist: Vec<String>,
    #[serde(default)]
    pub blacklist: Vec<String>,
    #[serde(default)]
    pub options: ProviderOptions,
    #[serde(default)]
    pub models: HashMap<String, ModelConfig>,
}

/// Model configuration override
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelConfig {
    /// Internal provenance; never written to configuration files.
    #[doc(hidden)]
    #[serde(skip)]
    pub api_from_catalog: bool,
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<crate::catalog::ModelProvider>,
    #[serde(default)]
    pub capabilities: Option<ModelCapabilities>,
    #[serde(default)]
    pub cost: Option<ModelCost>,
    #[serde(default)]
    pub limit: Option<ModelLimits>,
    #[serde(default)]
    pub status: Option<ModelStatus>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Catalog-sourced thinking options (models.dev).
    #[serde(default)]
    pub reasoning_options: Vec<crate::catalog::ReasoningOption>,
    #[serde(default)]
    pub reasoning_stream_field: Option<String>,
    #[serde(flatten)]
    pub options: HashMap<String, serde_json::Value>,
}

/// Auto-approve configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AutoApproveConfig {
    pub read_operations: bool,
    pub write_new_files: bool,
    pub safe_commands: Vec<String>,
    pub max_auto_edit_lines: usize,
    /// Destructive shell commands (recursive rm, force push, mkfs, DROP
    /// TABLE…) still ask in auto mode.
    pub confirm_destructive: bool,
}

impl Default for AutoApproveConfig {
    fn default() -> Self {
        Self {
            read_operations: true,
            write_new_files: false,
            safe_commands: vec![
                "cargo build".into(),
                "cargo test".into(),
                "cargo check".into(),
                "npm run build".into(),
                "npm test".into(),
                "npm run lint".into(),
                "git status".into(),
                "git diff".into(),
                "ls".into(),
                "dir".into(),
            ],
            max_auto_edit_lines: 10,
            confirm_destructive: true,
        }
    }
}

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
/// [`AppConfig::subagent_settings`]; never written by current clients.
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

fn is_default_subagents(settings: &SubagentSettings) -> bool {
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
    fn merge(&mut self, other: SubagentSettings) {
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

/// Full application configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub provider: HashMap<String, ProviderConfig>,
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub planner_model: Option<String>,
    #[serde(default)]
    pub executor_model: Option<String>,
    #[serde(default)]
    pub editor: Option<String>,
    #[serde(default)]
    pub auto_approve: AutoApproveConfig,
    #[serde(default, deserialize_with = "crate::mcp::lenient_server_map")]
    pub mcp: HashMap<String, McpConfig>,
    /// Project `.mcp.json` servers the user allowed to run, as
    /// [`crate::mcp::approval_key`]s (`<project>::<server>`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approved_mcp_servers: Vec<String>,
    /// Media kinds opened or attached without asking (`image`, `audio`,
    /// `video`). Everything else asks first (`/settings`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow_media: Vec<agente_protocol::AttachmentKind>,
    /// Persistent agent mode (Plan / Build). Used to restore the mode on next launch.
    #[serde(default)]
    pub default_mode: Option<String>,
    /// Persistent default thinking level (`off`, `high`, `max`, …). Restored on launch.
    #[serde(default)]
    pub default_thinking_level: Option<String>,
    /// Persistent UI theme ("dark" or "light"). Restored on next launch.
    #[serde(default)]
    pub theme: Option<String>,
    /// Snap instead of animating (eased scrolling, hover fades).
    #[serde(default)]
    pub reduce_motion: bool,
    /// Compact with an LLM-written checkpoint (goals, decisions, files,
    /// open work) instead of plain trimming. Off by default: trimming is
    /// instant and free; smart compaction costs one extra model call.
    #[serde(default)]
    pub smart_compaction: bool,
    /// Optional model for manual and automatic LLM checkpoints; otherwise use the chat model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_model: Option<SubagentModel>,
    /// Subagents allowed to run at once; the rest queue FIFO. `None` uses
    /// `DEFAULT_MAX_CONCURRENT_SUBAGENTS`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_parallel_subagents: Option<usize>,
    /// Pre-list per-type pins, read from old configs only. Read through
    /// [`AppConfig::subagent_settings`]; clients write `subagents`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub subagent_models: SubagentModels,
    /// Models subagents may run on, the default one, and whether the
    /// orchestrator picks (`/subagent-models`, Desktop Settings → Subagents).
    #[serde(default, skip_serializing_if = "is_default_subagents")]
    pub subagents: SubagentSettings,
    /// Maximum agent tool-loop iterations per turn. Long-horizon tasks can
    /// exceed the old hardcoded cap of 50; default is 500.
    #[serde(default)]
    pub max_iterations: Option<u32>,
    /// Cached discovered model IDs per provider. Avoids rediscovery on launch.
    #[serde(default)]
    pub discovered_models: HashMap<String, Vec<String>>,
    /// External model catalog cache
    #[serde(skip)]
    pub catalog: Option<crate::catalog::ModelCatalog>,
    /// Auth store — separate from config so credentials are never written to config.json.
    #[serde(skip)]
    pub auth_store: AuthStore,
}

/// The same allowlist gates saved configuration, the registry, and the picker.
pub fn provider_is_supported(id: &str) -> bool {
    crate::providers::spec::offered(id)
}

#[derive(Debug, Clone)]
pub struct ProviderEntry {
    pub id: String,
    pub name: String,
    pub env_key: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        // Built-in providers come from the offered specs
        // (`crates/agente-core/providers/*.toml`) — the single source of truth.
        let provider: HashMap<String, ProviderConfig> = crate::providers::spec::all()
            .iter()
            .filter(|spec| spec.offered)
            .map(|spec| (spec.id.clone(), spec.provider_config()))
            .collect();

        Self {
            default_provider: Some("deepseek".into()),
            default_model: Some("deepseek-flash".into()),
            planner_model: Some("deepseek-flash".into()),
            executor_model: Some("deepseek-flash".into()),
            editor: None,
            auto_approve: AutoApproveConfig::default(),
            default_mode: Some("Build".into()),
            theme: None,
            reduce_motion: false,
            smart_compaction: false,
            compaction_model: None,
            max_parallel_subagents: None,
            subagent_models: HashMap::new(),
            subagents: SubagentSettings::default(),
            approved_mcp_servers: Vec::new(),
            allow_media: Vec::new(),
            max_iterations: None,
            default_thinking_level: None,
            discovered_models: HashMap::new(),
            provider,
            mcp: HashMap::new(),
            catalog: None,
            auth_store: AuthStore::default(),
        }
    }
}

impl AppConfig {
    /// Subagents that may run at once (at least one).
    pub fn parallel_subagents(&self) -> usize {
        self.max_parallel_subagents
            .unwrap_or(DEFAULT_MAX_CONCURRENT_SUBAGENTS)
            .max(1)
    }

    /// Resolved tool-loop iteration cap for a single turn.
    /// Defaults to 500 — generous enough for long-horizon tasks while still
    /// acting as a safety valve against pathological tool-calling loops.
    pub fn max_iterations(&self) -> u32 {
        self.max_iterations.unwrap_or(500)
    }
}

impl AppConfig {
    /// Load global and project configuration without refreshing the model
    /// catalog. Project switches use the already-loaded catalog so changing
    /// tabs can never block on network access or inherit the previous
    /// workspace's overrides.
    pub fn load_for_project(
        project_dir: &str,
        catalog: Option<crate::catalog::ModelCatalog>,
    ) -> Self {
        let mut config = Self {
            auth_store: AuthStore::load(),
            ..Self::default()
        };
        if let Some(catalog) = catalog {
            config.merge_catalog(&catalog);
        }
        if let Some(path) = Self::global_config_path() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                    config = config.merge(loaded);
                }
            }
        }
        let path = PathBuf::from(project_dir).join("agente.json");
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                config = config.merge(loaded);
            }
        }
        config
    }

    pub fn load(project_dir: &str) -> Self {
        let mut config = Self {
            auth_store: AuthStore::load(),
            ..Self::default()
        };

        // models.dev catalog: cache first, then network. Authoritative source for
        // context windows / capabilities / **reasoning_options** (thinking levels).
        let cached = crate::catalog::ModelCatalog::load_from_cache().and_then(|catalog| {
            if catalog.is_stale_for_thinking() {
                tracing::warn!(
                    reasoning_models = catalog.reasoning_model_count(),
                    "Cached models.dev catalog lacks reasoning_options; re-fetching"
                );
                crate::catalog::ModelCatalog::invalidate_cache();
                None
            } else {
                Some(catalog)
            }
        });

        if let Some(catalog) = cached {
            crate::catalog::ModelCatalog::refresh_cache_if_stale();
            tracing::info!(
                providers = catalog.providers.len(),
                models = catalog.model_count(),
                reasoning_options = catalog.reasoning_options_count(),
                "Loaded model catalog from cache"
            );
            config.merge_catalog(&catalog);
        } else {
            let try_fetch = std::thread::spawn(|| {
                let rt = match tokio::runtime::Runtime::new() {
                    Ok(rt) => rt,
                    Err(e) => {
                        eprintln!("agente: catalog runtime error: {e}");
                        return None;
                    }
                };
                rt.block_on(async {
                    match crate::catalog::ModelCatalog::fetch().await {
                        Ok(catalog) => {
                            if let Err(e) = catalog.save_to_cache() {
                                eprintln!("agente: failed to cache model catalog: {e}");
                            }
                            eprintln!(
                                "agente: models.dev loaded ({} models, {} with reasoning_options)",
                                catalog.model_count(),
                                catalog.reasoning_options_count()
                            );
                            Some(catalog)
                        }
                        Err(e) => {
                            eprintln!("agente: failed to fetch models.dev catalog: {e}");
                            None
                        }
                    }
                })
            });
            match try_fetch.join() {
                Ok(Some(catalog)) => {
                    tracing::info!(
                        providers = catalog.providers.len(),
                        models = catalog.model_count(),
                        reasoning_options = catalog.reasoning_options_count(),
                        "Fetched and merged models.dev catalog"
                    );
                    config.merge_catalog(&catalog);
                }
                Ok(None) => {
                    tracing::warn!(
                        "No models.dev catalog available; using built-in provider model lists only"
                    );
                }
                Err(_) => {
                    tracing::warn!("Model catalog fetch thread panicked");
                }
            }
        }

        // Load user config from home
        if let Some(home_config) = Self::global_config_path() {
            if home_config.exists() {
                if let Ok(content) = std::fs::read_to_string(&home_config) {
                    if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                        config = config.merge(loaded);
                    }
                }
            }
        }

        // Load project config (overrides global)
        let project_config = PathBuf::from(project_dir).join("agente.json");
        if project_config.exists() {
            if let Ok(content) = std::fs::read_to_string(&project_config) {
                if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                    config = config.merge(loaded);
                }
            }
        }

        config
    }

    /// Save config to `~/.agente/config.json`.
    /// Auth keys are **not** written — they live in `~/.agente/auth.json`.
    pub fn save(&self) -> std::io::Result<()> {
        Self::save_to(self, None)
    }

    /// Apply `edit` to the saved global `config.json` alone — not the defaults,
    /// project overrides or catalog a loaded config carries — and write it
    /// back. A file that exists but does not parse is left untouched.
    pub fn edit_global(edit: impl FnOnce(&mut AppConfig)) -> std::io::Result<()> {
        let path = Self::global_config_path().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no home directory")
        })?;
        let mut saved = match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str::<AppConfig>(&content)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppConfig {
                provider: HashMap::new(),
                ..Self::default()
            },
            Err(error) => return Err(error),
        };
        edit(&mut saved);
        saved.save()
    }

    /// Save config to both the global path and the workspace `<project_dir>/agente.json`.
    /// The workspace copy is a mirror that overrides the global on next load.
    pub fn save_to_workspace(&self, project_dir: &str) -> std::io::Result<()> {
        Self::save_to(self, Some(project_dir))
    }

    fn save_to(&self, project_dir: Option<&str>) -> std::io::Result<()> {
        let mut stripped = self.strip_secrets();
        // `strip_secrets` drops the catalog handle, so pass ours in.
        stripped.strip_catalog_derived(self.catalog.as_ref());
        // Spec transport defaults are re-seeded on every load; a saved copy
        // would freeze them and hide the spec's later route changes.
        let builtin = Self::default();
        for (id, provider) in stripped.provider.iter_mut() {
            let defaults = builtin.provider.get(id).and_then(|p| p.transport.as_ref());
            if let (Some(own), Some(defaults)) = (&provider.transport, defaults) {
                provider.transport = own.beyond(defaults);
            }
        }
        let content = serde_json::to_string_pretty(&stripped)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        // Always write global first.
        if let Some(global_path) = Self::global_config_path() {
            if let Some(parent) = global_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&global_path, &content)?;
        }

        // Mirror to workspace if given.
        if let Some(dir) = project_dir {
            let workspace_path = PathBuf::from(dir).join("agente.json");
            if let Some(parent) = workspace_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&workspace_path, &content)?;
        }

        Ok(())
    }

    /// Drop model entries that a fresh catalog merge would recreate verbatim.
    ///
    /// [`Self::merge_catalog`] copies every models.dev entry for a connectable
    /// provider into `provider[id].models`. Persisting those copies made the
    /// on-disk config **4.4 MB** — rewritten in full, to two locations, on every
    /// `/model`, `/theme` or provider connect — and let stale rows outlive
    /// [`crate::catalog::ModelCatalog::invalidate_cache`], since a reload merged
    /// them back as if the user had authored them.
    ///
    /// The catalog is re-merged from its own cache on every load, so the copies
    /// carry no information. Anything the user authored or overrode differs from
    /// the catalog value and is kept; if either side fails to serialize we cannot
    /// prove the entry is redundant, so it stays.
    fn strip_catalog_derived(&mut self, catalog: Option<&crate::catalog::ModelCatalog>) {
        let Some(catalog) = catalog else {
            return;
        };
        for (id, provider) in self.provider.iter_mut() {
            let Some(catalog_provider) = catalog.providers.get(id) else {
                continue;
            };
            provider.models.retain(|model_id, model| {
                let Some(catalog_model) = catalog_provider.models.get(model_id) else {
                    return true;
                };
                let derived = model_config_from_catalog(catalog_model);
                match (serde_json::to_value(model), serde_json::to_value(&derived)) {
                    (Ok(saved), Ok(derived)) => saved != derived,
                    _ => true,
                }
            });
        }
        // Provider level: `merge` re-inserts every provider row stored in a
        // persisted file, so shells copied by older catalog merges (the live
        // `agente.json` once held 187 providers / 3000+ models) resurrect on
        // every load and the model loop above can never remove them — it only
        // trims *models* inside catalog-known providers. Drop whole shells
        // that carry no user authorship. `api`/`name`/`env`/`npm`/`api_format`
        // are deliberately NOT signals: `merge_catalog` fills those itself.
        // Everything a user action writes survives: connect stores
        // `options.base_url` (`add_provider_with_key`, key lives in auth.json),
        // hand-added models/whitelists/extras keep their provider, and
        // built-ins always stay (the connect dialog lists them).
        let builtin = Self::default();
        self.provider.retain(|id, provider| {
            if builtin.provider.contains_key(id) {
                return true;
            }
            provider.transport.is_some()
                || provider.options.api_key.is_some()
                || provider.options.base_url.is_some()
                || provider.options.enterprise_url.is_some()
                || provider.options.timeout.is_some()
                || provider.options.chunk_timeout.is_some()
                || !provider.options.extra.is_empty()
                || !provider.whitelist.is_empty()
                || !provider.blacklist.is_empty()
                || !provider.models.is_empty()
        });
    }

    /// Replace catalog-derived data while retaining explicitly configured models.
    pub fn refresh_catalog(&mut self, catalog: &crate::catalog::ModelCatalog) {
        let previous = self.catalog.clone();
        self.strip_catalog_derived(previous.as_ref());
        let builtin = Self::default();
        let overrides: HashMap<_, _> = self
            .provider
            .iter()
            .map(|(id, provider)| {
                let mut models = provider.models.clone();
                models.retain(|model_id, model| {
                    let default = builtin
                        .provider
                        .get(id)
                        .and_then(|p| p.models.get(model_id));
                    default.is_none_or(|default| {
                        serde_json::to_value(default).ok() != serde_json::to_value(model).ok()
                    })
                });
                (id.clone(), models)
            })
            .collect();
        self.merge_catalog(catalog);
        for (id, models) in overrides {
            if let Some(provider) = self.provider.get_mut(&id) {
                provider.models.extend(models);
            }
        }
    }

    /// Merge models.dev metadata into **existing** connectable providers only.
    ///
    /// The full catalog is kept on `self.catalog` for context windows / capabilities
    /// lookup. We intentionally do **not** register every models.dev gateway as a
    /// first-class provider — that flooded the connect UI with hundreds of entries.
    fn merge_catalog(&mut self, catalog: &crate::catalog::ModelCatalog) {
        self.catalog = Some(catalog.clone());

        for (id, existing) in self.provider.iter_mut() {
            let Some(provider) = catalog
                .providers
                .get(crate::providers::spec::catalog_id(id))
            else {
                continue;
            };

            // Empty-string `api` in config means "unknown" (many generated configs
            // store an empty placeholder) — let the catalog fill it.
            if existing.api.as_deref().is_none_or(str::is_empty) && !provider.api.is_empty() {
                existing.api = Some(provider.api.clone());
            }
            if existing.name.is_none() {
                existing.name = Some(provider.name.clone());
            }
            if existing.env.is_empty() && !provider.env.is_empty() {
                existing.env = provider.env.clone();
            }
            if existing.npm.is_none() && !provider.npm.is_empty() {
                existing.npm = Some(provider.npm.clone());
            }
            if existing.api_format.is_none() {
                existing.api_format = Some(infer_api_format_from_npm(&provider.npm));
            }
            for (model_id, model) in &provider.models {
                // Catalog data is authoritative over built-in placeholders.
                existing
                    .models
                    .insert(model_id.clone(), model_config_from_catalog(model));
            }
        }
    }

    pub fn merge(mut self, other: AppConfig) -> Self {
        for (k, v) in other.provider {
            if let Some(existing) = self.provider.get_mut(&k) {
                if let Some(policy) = v.transport {
                    existing
                        .transport
                        .get_or_insert_with(Default::default)
                        .overlay(&policy);
                }
                if v.api.is_some() {
                    existing.api = v.api;
                }
                if v.name.is_some() {
                    existing.name = v.name;
                }
                if !v.env.is_empty() {
                    existing.env = v.env;
                }
                if v.id.is_some() {
                    existing.id = v.id;
                }
                if v.npm.is_some() {
                    existing.npm = v.npm;
                }
                if v.api_format.is_some() {
                    existing.api_format = v.api_format;
                }
                if !v.whitelist.is_empty() {
                    existing.whitelist = v.whitelist;
                }
                if !v.blacklist.is_empty() {
                    existing.blacklist = v.blacklist;
                }
                if v.options.api_key.is_some() {
                    existing.options.api_key = v.options.api_key;
                }
                if v.options.base_url.is_some() {
                    existing.options.base_url = v.options.base_url;
                }
                if v.options.enterprise_url.is_some() {
                    existing.options.enterprise_url = v.options.enterprise_url;
                }
                if v.options.timeout.is_some() {
                    existing.options.timeout = v.options.timeout;
                }
                if v.options.chunk_timeout.is_some() {
                    existing.options.chunk_timeout = v.options.chunk_timeout;
                }
                if !v.options.extra.is_empty() {
                    existing.options.extra.extend(v.options.extra);
                }
                if !v.models.is_empty() {
                    existing.models.extend(v.models);
                }
            } else {
                self.provider.insert(k, v);
            }
        }
        for (k, v) in other.mcp {
            self.mcp.insert(k, v);
        }
        if other.default_provider.is_some() {
            self.default_provider = other.default_provider;
        }
        if other.default_model.is_some() {
            self.default_model = other.default_model;
        }
        if other.planner_model.is_some() {
            self.planner_model = other.planner_model;
        }
        if other.executor_model.is_some() {
            self.executor_model = other.executor_model;
        }
        if other.editor.is_some() {
            self.editor = other.editor;
        }
        if other.default_mode.is_some() {
            self.default_mode = other.default_mode;
        }
        if other.default_thinking_level.is_some() {
            self.default_thinking_level = other.default_thinking_level;
        }
        if !other.discovered_models.is_empty() {
            for (k, v) in other.discovered_models {
                self.discovered_models.insert(k, v);
            }
        }
        if other.theme.is_some() {
            self.theme = other.theme;
        }
        self.reduce_motion |= other.reduce_motion;
        self.smart_compaction |= other.smart_compaction;
        if other.compaction_model.is_some() {
            self.compaction_model = other.compaction_model;
        }
        if other.max_parallel_subagents.is_some() {
            self.max_parallel_subagents = other.max_parallel_subagents;
        }
        // Per-type entries: the workspace wins for the types it names.
        self.subagent_models.extend(other.subagent_models);
        self.subagents.merge(other.subagents);
        if !other.allow_media.is_empty() {
            self.allow_media = other.allow_media;
        }
        for key in other.approved_mcp_servers {
            if !self.approved_mcp_servers.contains(&key) {
                self.approved_mcp_servers.push(key);
            }
        }
        self.auto_approve = other.auto_approve;
        self
    }

    /// Resolve API key with full fallback chain:
    /// 1. Auth store (`~/.agente/auth.json`)
    /// 2. Config `options.api_key`
    /// 3. Environment variables declared in config
    /// 4. Fallback `{PROVIDER}_API_KEY` convention
    pub fn resolve_api_key(&self, provider_id: &str) -> Option<String> {
        // 1. Auth store (preferred — separate from config)
        if let Some(key) = self.auth_store.get_key(provider_id) {
            return Some(key);
        }

        if let Some(provider) = self.provider.get(provider_id) {
            // 2. Check options.api_key from config
            if let Some(key) = &provider.options.api_key {
                if !key.is_empty() {
                    return Some(key.clone());
                }
            }

            // 3. Check env vars in order
            for env_key in &provider.env {
                if let Ok(val) = std::env::var(env_key) {
                    if !val.is_empty() {
                        return Some(val);
                    }
                }
            }

            // 4. Fallback to {PROVIDER}_API_KEY convention
            let fallback = format!("{}_API_KEY", provider_id.to_uppercase().replace('-', "_"));
            if let Ok(val) = std::env::var(&fallback) {
                if !val.is_empty() {
                    return Some(val);
                }
            }
        }

        None
    }

    pub fn resolve_base_url(&self, provider_id: &str) -> Option<String> {
        let env_key = format!("{}_BASE_URL", provider_id.to_uppercase().replace('-', "_"));
        if let Ok(val) = std::env::var(&env_key) {
            if !val.is_empty() {
                return Some(crate::util::expand_env_templates(&val));
            }
        }

        if let Some(provider) = self.provider.get(provider_id) {
            if let Some(url) = &provider.options.base_url {
                if !url.is_empty() {
                    return Some(crate::util::expand_env_templates(url));
                }
            }
            if let Some(url) = &provider.api {
                if !url.is_empty() {
                    return Some(crate::util::expand_env_templates(url));
                }
            }
        }

        None
    }

    pub fn has_api_key(&self, provider_id: &str) -> bool {
        self.resolve_api_key(provider_id).is_some()
    }

    pub fn provider_entries(&self) -> Vec<ProviderEntry> {
        let mut entries = Vec::new();

        for (id, provider) in &self.provider {
            if !provider_is_supported(id) {
                continue;
            }
            let name = provider.name.as_ref().unwrap_or(id).clone();
            let env_key = provider.env.first().cloned().unwrap_or_default();

            entries.push(ProviderEntry {
                id: id.clone(),
                name,
                env_key,
            });
        }

        entries
    }

    /// Add or update a provider and persist both config and auth.
    /// The API key is stored in `~/.agente/auth.json`, never in config.
    /// Existing provider metadata (api_format, models, etc.) is preserved.
    pub fn add_provider_with_key(
        &mut self,
        provider_name: &str,
        base_url: String,
        api_key: String,
    ) {
        let env_key = format!("{}_API_KEY", provider_name.to_uppercase().replace('-', "_"));

        // Merge with existing config if present
        let config = if let Some(existing) = self.provider.get(provider_name) {
            ProviderConfig {
                transport: existing.transport.clone(),
                name: existing.name.clone().or_else(|| Some(provider_name.into())),
                api: Some(base_url.clone()),
                env: if existing.env.is_empty() {
                    vec![env_key.clone()]
                } else {
                    existing.env.clone()
                },
                id: existing.id.clone(),
                npm: existing.npm.clone(),
                api_format: existing.api_format.clone(),
                whitelist: existing.whitelist.clone(),
                blacklist: existing.blacklist.clone(),
                options: ProviderOptions {
                    base_url: Some(base_url),
                    api_key: None, // never store in config
                    enterprise_url: existing.options.enterprise_url.clone(),
                    timeout: existing.options.timeout,
                    chunk_timeout: existing.options.chunk_timeout,
                    extra: existing.options.extra.clone(),
                },
                models: existing.models.clone(),
            }
        } else {
            ProviderConfig {
                name: Some(provider_name.into()),
                api: Some(base_url.clone()),
                env: vec![env_key.clone()],
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some(base_url),
                    ..Default::default()
                },
                ..Default::default()
            }
        };

        self.provider.insert(provider_name.to_string(), config);
        self.auth_store.set_key(provider_name, api_key);

        // Persist both files
        if let Err(e) = self.auth_store.save() {
            tracing::warn!(error = %e, "Failed to save auth store");
        }
        if let Err(e) = self.save() {
            tracing::warn!(error = %e, "Failed to save config");
        }
    }

    /// Update the cached default provider/model and persist to the workspace mirror.
    /// Use this for state mutations that originate from TUI interactions.
    pub fn set_defaults(&mut self, provider: Option<String>, model: Option<String>) {
        if let Some(p) = provider {
            if !p.is_empty() {
                self.default_provider = Some(p);
            }
        }
        if let Some(m) = model {
            if !m.is_empty() {
                self.default_model = Some(m);
            }
        }
    }

    pub fn get_provider_name(&self, provider_id: &str) -> String {
        self.provider
            .get(provider_id)
            .and_then(|p| p.name.clone())
            .unwrap_or_else(|| provider_id.to_string())
    }

    /// Return a copy of this config with secrets stripped for serialization.
    fn strip_secrets(&self) -> Self {
        let mut provider = self.provider.clone();
        for pc in provider.values_mut() {
            pc.options.api_key = None;
        }
        Self {
            provider,
            default_provider: self.default_provider.clone(),
            default_model: self.default_model.clone(),
            planner_model: self.planner_model.clone(),
            executor_model: self.executor_model.clone(),
            max_iterations: self.max_iterations,
            editor: self.editor.clone(),
            auto_approve: self.auto_approve.clone(),
            default_mode: self.default_mode.clone(),
            theme: self.theme.clone(),
            reduce_motion: self.reduce_motion,
            smart_compaction: self.smart_compaction,
            compaction_model: self.compaction_model.clone(),
            max_parallel_subagents: self.max_parallel_subagents,
            subagent_models: self.subagent_models.clone(),
            subagents: self.subagents.clone(),
            approved_mcp_servers: self.approved_mcp_servers.clone(),
            allow_media: self.allow_media.clone(),
            default_thinking_level: self.default_thinking_level.clone(),
            discovered_models: self.discovered_models.clone(),
            mcp: self.mcp.clone(),
            catalog: None,
            auth_store: AuthStore::default(),
        }
    }

    /// The subagent settings in effect: `subagents`, with any pre-list
    /// `subagent_models` pins folded in.
    pub fn subagent_settings(&self) -> SubagentSettings {
        self.subagents.clone().with_legacy(&self.subagent_models)
    }

    /// Replace the subagent settings and drop the pre-list pins they absorb.
    pub fn set_subagent_settings(&mut self, settings: SubagentSettings) {
        self.subagents = settings;
        self.subagent_models.clear();
    }

    /// Global config path: `~/.agente/config.json`.
    pub fn global_config_path() -> Option<PathBuf> {
        Some(Self::config_dir()?.join("config.json"))
    }

    /// Root of the global config/auth store.
    ///
    /// `AGENTE_CONFIG_DIR` redirects it so a test run never writes the
    /// developer's own `~/.agente/config.json` — several TUI key-handling tests
    /// reach `persist_config()` and used to rewrite it for real.
    pub fn config_dir() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("AGENTE_CONFIG_DIR") {
            return Some(PathBuf::from(dir));
        }
        dirs::home_dir().map(|h| h.join(".agente"))
    }
}

fn model_config_from_catalog(model: &crate::catalog::CatalogModel) -> ModelConfig {
    ModelConfig {
        api_from_catalog: true,
        name: Some(model.name.clone()),
        provider: model.provider.clone(),
        capabilities: Some(model.capabilities.clone()),
        cost: Some(model.cost.clone()),
        limit: Some(model.limit.clone()),
        status: Some(model.status.clone()),
        headers: model.headers.clone(),
        reasoning_options: model.reasoning_options.clone(),
        reasoning_stream_field: model.reasoning_stream_field.clone(),
        options: model.options.clone(),
    }
}

/// Infer API format from the npm package name used by the provider.
fn infer_api_format_from_npm(npm: &str) -> String {
    use crate::providers::ApiFormat;
    match ApiFormat::from_npm(npm).unwrap_or_default() {
        ApiFormat::Anthropic => "anthropic",
        ApiFormat::Responses => "responses",
        ApiFormat::Google => "google",
        ApiFormat::OpenAI => "openai",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default() {
        let config = AppConfig::default();
        assert!(config.default_provider.is_some());
        assert!(config.default_model.is_some());
        assert!(!config.provider.is_empty());
    }

    #[test]
    fn retired_providers_are_hidden_even_in_saved_config() {
        let mut config = AppConfig::default();
        for id in ["anthropic", "google", "gemini"] {
            assert!(!config.provider.contains_key(id));
            config.provider.insert(id.into(), ProviderConfig::default());
        }
        config.provider.insert(
            "legacy-google".into(),
            ProviderConfig {
                api_format: Some("gemini".into()),
                ..Default::default()
            },
        );
        let entries = config.provider_entries();
        for id in ["anthropic", "google", "gemini", "legacy-google"] {
            assert!(!entries.iter().any(|entry| entry.id == id));
        }
        assert!(entries.iter().any(|entry| entry.id == "minimax"));
        let registry = crate::providers::ProviderRegistry::from_config(&config);
        for id in ["anthropic", "google", "gemini", "legacy-google"] {
            assert!(registry.get(id).is_none());
        }
    }

    #[test]
    fn test_provider_entries() {
        let config = AppConfig::default();
        let entries = config.provider_entries();
        assert!(!entries.is_empty());
        assert!(entries.iter().any(|e| e.id == "openrouter"));
    }

    #[test]
    fn test_resolve_base_url() {
        let config = AppConfig::default();
        let url = config.resolve_base_url("openrouter");
        assert!(url.is_some());
        assert!(url.unwrap().starts_with("http"));
    }

    #[test]
    fn test_get_provider_name() {
        let config = AppConfig::default();
        let name = config.get_provider_name("openrouter");
        assert_eq!(name, "OpenRouter");
    }

    #[test]
    fn test_get_provider_name_unknown() {
        let config = AppConfig::default();
        let name = config.get_provider_name("unknown_provider");
        assert_eq!(name, "unknown_provider");
    }

    #[test]
    fn test_auto_approve_default() {
        let config = AutoApproveConfig::default();
        assert!(config.read_operations);
        assert!(!config.write_new_files);
        assert!(!config.safe_commands.is_empty());
        assert_eq!(config.max_auto_edit_lines, 10);
    }

    #[test]
    fn test_strip_secrets() {
        let mut config = AppConfig::default();
        config
            .provider
            .get_mut("openrouter")
            .unwrap()
            .options
            .api_key = Some("secret".into());
        let stripped = config.strip_secrets();
        assert!(stripped.provider["openrouter"].options.api_key.is_none());
    }

    #[test]
    fn test_set_defaults_ignores_empty_values() {
        let mut config = AppConfig {
            default_provider: Some("openai".into()),
            default_model: Some("gpt-4o".into()),
            ..AppConfig::default()
        };
        config.set_defaults(Some(String::new()), Some(String::new()));
        assert_eq!(config.default_provider.as_deref(), Some("openai"));
        assert_eq!(config.default_model.as_deref(), Some("gpt-4o"));
        config.set_defaults(
            Some("anthropic".into()),
            Some("claude-sonnet-4-20250514".into()),
        );
        assert_eq!(config.default_provider.as_deref(), Some("anthropic"));
        assert_eq!(
            config.default_model.as_deref(),
            Some("claude-sonnet-4-20250514")
        );
    }

    #[test]
    fn test_default_mode_round_trips_via_serde() {
        let mut config = AppConfig {
            default_mode: Some("Build".into()),
            ..AppConfig::default()
        };
        config
            .discovered_models
            .insert("openai".into(), vec!["gpt-4o".into(), "gpt-4o-mini".into()]);
        let json = serde_json::to_string(&config.strip_secrets()).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.default_mode.as_deref(), Some("Build"));
        assert_eq!(
            parsed.discovered_models.get("openai").unwrap(),
            &vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()]
        );
    }

    #[test]
    fn default_providers_include_separate_opencode_plans() {
        let config = AppConfig::default();
        let ids: Vec<String> = config
            .provider_entries()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids.len(), 6);
        for id in [
            "deepseek",
            "minimax",
            "glm",
            "opencode-go",
            "opencode",
            "openrouter",
        ] {
            assert!(ids.iter().any(|p| p == id), "missing provider {id}");
        }
    }

    #[test]
    fn catalog_replaces_placeholder_models() {
        use crate::catalog::{
            CatalogModel, ModelCapabilities, ModelCost, ModelLimits, ModelStatus,
        };

        let mut config = AppConfig::default();
        let mut models = HashMap::new();
        models.insert(
            "gpt-4o".to_string(),
            CatalogModel {
                provider: None,
                id: "gpt-4o".to_string(),
                provider_id: "openrouter".to_string(),
                name: "GPT-4o Real".to_string(),
                family: None,
                capabilities: ModelCapabilities::default(),
                cost: ModelCost::default(),
                limit: ModelLimits::default(),
                status: ModelStatus::Active,
                api_id: "gpt-4o-real".to_string(),
                reasoning_options: Vec::new(),
                reasoning_stream_field: None,
                headers: HashMap::new(),
                options: HashMap::new(),
                variants: HashMap::new(),
            },
        );
        let mut catalog = crate::catalog::ModelCatalog::default();
        catalog.providers.insert(
            "openrouter".to_string(),
            crate::catalog::CatalogProvider {
                id: "openrouter".to_string(),
                name: "OpenAI".to_string(),
                env: vec!["OPENAI_API_KEY".to_string()],
                api: "https://api.openai.com/v1".to_string(),
                npm: "@ai-sdk/openai".to_string(),
                models,
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        config.merge_catalog(&catalog);
        assert_eq!(
            config.provider["openrouter"].models["gpt-4o"]
                .name
                .as_deref(),
            Some("GPT-4o Real")
        );
    }

    fn entry(name: &str, provider: &str, model: &str) -> SubagentModelEntry {
        SubagentModelEntry {
            name: name.into(),
            provider: provider.into(),
            model: model.into(),
            thinking: None,
            use_for: String::new(),
        }
    }

    /// Old per-type pins become list entries (one per distinct model), and
    /// the pin for every type becomes the default model.
    #[test]
    fn legacy_pins_fold_into_the_model_list() {
        let pick = |provider: &str, model: &str| SubagentModel {
            provider: provider.into(),
            model: model.into(),
            thinking: None,
        };
        let legacy = SubagentModels::from([
            (ALL_SUBAGENTS.into(), pick("deepseek", "deepseek-flash")),
            ("explore".into(), pick("deepseek", "deepseek-flash")),
            ("plan".into(), pick("openrouter", "qwen/qwen3-coder:free")),
        ]);
        let settings = SubagentSettings::default().with_legacy(&legacy);
        let names: Vec<&str> = settings.models.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["deepseek-flash", "qwen3-coder-free"]);
        assert_eq!(settings.default_model.as_deref(), Some("deepseek-flash"));
        assert!(settings.validate().is_ok());

        // A default the user already set is kept.
        let mine = SubagentSettings {
            default_model: Some(MAIN_MODEL.into()),
            ..SubagentSettings::default()
        }
        .with_legacy(&legacy);
        assert_eq!(mine.default_model.as_deref(), Some(MAIN_MODEL));

        // Saving the settings drops the pins they absorbed.
        let mut config = AppConfig {
            subagent_models: legacy,
            ..AppConfig::default()
        };
        let effective = config.subagent_settings();
        config.set_subagent_settings(effective.clone());
        assert!(config.subagent_models.is_empty());
        assert_eq!(config.subagent_settings(), effective);
    }

    #[test]
    fn the_default_model_counts_only_while_it_is_on_the_list() {
        let mut settings = SubagentSettings {
            models: vec![entry("scout", "openrouter", "a/scout:free")],
            default_model: Some("scout".into()),
            ..SubagentSettings::default()
        };
        assert_eq!(settings.default_name(), Some("scout"));
        settings.default_model = Some("gone".into());
        assert_eq!(settings.default_name(), None);
        settings.default_model = Some(MAIN_MODEL.into());
        assert_eq!(settings.default_name(), Some(MAIN_MODEL));
        assert_eq!(SubagentSettings::default().default_name(), None);
    }

    #[test]
    fn typed_names_are_settled_not_refused() {
        let settings = SubagentSettings {
            models: vec![
                entry("scout", "openrouter", "a/scout"),
                entry("other", "glm", "z-ai/glm-5"),
            ],
            ..SubagentSettings::default()
        };
        assert_eq!(
            settings.settled_name("Revisor Rápido!", 1),
            "revisor-rapido"
        );
        assert_eq!(settings.settled_name("scout", 1), "scout-2");
        assert_eq!(settings.settled_name("scout", 0), "scout");
        assert_eq!(settings.settled_name("main", 1), "main-model");
        assert_eq!(settings.settled_name("  ", 1), "glm-5");
        let mut renamed = settings.clone();
        renamed.models[1].name = renamed.settled_name("Fast  Reader", 1);
        assert_eq!(renamed.models[1].name, "fast-reader");
        assert!(renamed.validate().is_ok());
    }

    #[test]
    fn model_names_are_checked_and_generated() {
        let mut settings = SubagentSettings {
            models: vec![entry("scout", "openrouter", "a/b")],
            ..SubagentSettings::default()
        };
        assert!(settings.validate().is_ok());
        assert_eq!(settings.unique_name("x/Scout"), "scout-2");
        assert_eq!(settings.unique_name("GLM 5.1"), "glm-5.1");
        assert_eq!(settings.unique_name("main"), "model");
        settings.models.push(entry("scout", "glm", "glm-5"));
        assert!(settings.validate().unwrap_err().contains("Two"));
        settings.models[1].name = "Has Space".into();
        assert!(settings.validate().is_err());
        settings.models[1].name = MAIN_MODEL.into();
        assert!(settings.validate().unwrap_err().contains("reserved"));
        settings.models[1] = entry("builder", "", "glm-5");
        assert!(settings.validate().is_err());
    }

    /// The setting round-trips through the config file, stays out of it
    /// while untouched, and a workspace file replaces entries by name.
    #[test]
    fn subagent_settings_round_trip_and_merge() {
        assert!(!serde_json::to_string(&AppConfig::default())
            .unwrap()
            .contains("\"subagents\""));
        let base = AppConfig {
            subagents: SubagentSettings {
                orchestrator_picks: Some(false),
                models: vec![
                    entry("scout", "openrouter", "a/scout:free"),
                    entry("builder", "glm", "glm-5"),
                ],
                default_model: Some("scout".into()),
            },
            ..AppConfig::default()
        };
        let json = serde_json::to_string(&base).unwrap();
        let loaded: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.subagents, base.subagents);
        assert!(!loaded.subagents.picks());
        assert!(loaded.subagents.pickable().is_empty());

        let workspace = AppConfig {
            subagents: SubagentSettings {
                models: vec![
                    entry("builder", "deepseek", "deepseek-pro"),
                    entry("checker", "deepseek", "deepseek-flash"),
                ],
                default_model: Some("checker".into()),
                ..SubagentSettings::default()
            },
            ..AppConfig::default()
        };
        let merged = base.merge(workspace).subagents;
        let names: Vec<&str> = merged.models.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["scout", "builder", "checker"]);
        assert_eq!(merged.entry("builder").unwrap().model, "deepseek-pro");
        assert_eq!(merged.default_model.as_deref(), Some("checker"));
        // An unset switch in the workspace keeps the user's.
        assert_eq!(merged.orchestrator_picks, Some(false));
    }

    #[test]
    fn merge_catalog_does_not_add_unknown_providers() {
        use crate::catalog::{
            CatalogModel, ModelCapabilities, ModelCost, ModelLimits, ModelStatus,
        };

        let mut config = AppConfig::default();
        let before = config.provider.len();
        let mut models = HashMap::new();
        models.insert(
            "obscure-model".to_string(),
            CatalogModel {
                provider: None,
                id: "obscure-model".to_string(),
                provider_id: "some-random-gateway".to_string(),
                name: "Obscure".to_string(),
                family: None,
                capabilities: ModelCapabilities::default(),
                cost: ModelCost::default(),
                limit: ModelLimits {
                    context: 99_000,
                    input: None,
                    output: 4096,
                },
                status: ModelStatus::Active,
                api_id: "obscure-model".to_string(),
                reasoning_options: Vec::new(),
                reasoning_stream_field: None,
                headers: HashMap::new(),
                options: HashMap::new(),
                variants: HashMap::new(),
            },
        );
        let mut catalog = crate::catalog::ModelCatalog::default();
        catalog.providers.insert(
            "some-random-gateway".to_string(),
            crate::catalog::CatalogProvider {
                id: "some-random-gateway".to_string(),
                name: "Random Gateway".to_string(),
                env: vec!["RANDOM_API_KEY".to_string()],
                api: "https://example.com/v1".to_string(),
                npm: "@ai-sdk/openai".to_string(),
                models,
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        config.merge_catalog(&catalog);
        assert_eq!(config.provider.len(), before);
        assert!(!config.provider.contains_key("some-random-gateway"));
        assert!(config.catalog.is_some());
        assert!(config
            .catalog
            .as_ref()
            .unwrap()
            .find_model("some-random-gateway", "obscure-model")
            .is_some());
    }

    /// A merged catalog must not reach disk. The live `agente.json` in this
    /// repo was 4,488,530 bytes because `merge_catalog` copied every models.dev
    /// entry into `provider[id].models` and `save_to` serialized all of it —
    /// twice, on every `/model`, `/theme` or provider connect.
    #[test]
    fn saved_config_does_not_carry_the_merged_catalog() {
        use crate::catalog::{
            CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
            ModelStatus,
        };

        let catalog_model = |id: &str| CatalogModel {
            provider: None,
            id: id.to_string(),
            provider_id: "openrouter".to_string(),
            name: format!("Model {id}"),
            family: None,
            capabilities: ModelCapabilities::default(),
            cost: ModelCost::default(),
            limit: ModelLimits::default(),
            status: ModelStatus::Active,
            api_id: id.to_string(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            headers: HashMap::new(),
            options: HashMap::new(),
            variants: HashMap::new(),
        };

        let models: HashMap<String, CatalogModel> = (0..2_000)
            .map(|i| {
                let id = format!("model-{i}");
                (id.clone(), catalog_model(&id))
            })
            .collect();

        let mut catalog = ModelCatalog::default();
        catalog.providers.insert(
            "openrouter".to_string(),
            CatalogProvider {
                id: "openrouter".to_string(),
                name: "OpenAI".to_string(),
                env: vec!["OPENAI_API_KEY".to_string()],
                api: "https://api.openai.com/v1".to_string(),
                npm: "@ai-sdk/openai".to_string(),
                models,
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        let mut config = AppConfig::default();
        config.merge_catalog(&catalog);
        let merged = serde_json::to_string(&config.strip_secrets()).unwrap();
        assert!(
            merged.len() > 200_000,
            "fixture should reproduce the blow-up, got {} bytes",
            merged.len()
        );

        // What `save_to` actually writes.
        let mut persisted = config.strip_secrets();
        persisted.strip_catalog_derived(config.catalog.as_ref());
        let written = serde_json::to_string(&persisted).unwrap();
        assert!(
            written.len() < 64 * 1024,
            "persisted config must stay small, got {} bytes",
            written.len()
        );
        // The built-in placeholder models from `AppConfig::default()` are not
        // catalog-derived and legitimately stay; none of the 2,000 catalog
        // rows may.
        let leaked: Vec<_> = persisted.provider["openrouter"]
            .models
            .keys()
            .filter(|id| id.starts_with("model-"))
            .collect();
        assert!(
            leaked.is_empty(),
            "catalog-derived models must not be persisted, leaked {}",
            leaked.len()
        );
    }

    /// Stripping is by value, not by key: an entry the user actually changed
    /// differs from the catalog row and has to survive the save.
    #[test]
    fn user_overrides_survive_catalog_stripping() {
        use crate::catalog::{
            CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
            ModelStatus,
        };

        let mut models = HashMap::new();
        models.insert(
            "gpt-4o".to_string(),
            CatalogModel {
                provider: None,
                id: "gpt-4o".to_string(),
                provider_id: "openrouter".to_string(),
                name: "GPT-4o".to_string(),
                family: None,
                capabilities: ModelCapabilities::default(),
                cost: ModelCost::default(),
                limit: ModelLimits::default(),
                status: ModelStatus::Active,
                api_id: "gpt-4o".to_string(),
                reasoning_options: Vec::new(),
                reasoning_stream_field: None,
                headers: HashMap::new(),
                options: HashMap::new(),
                variants: HashMap::new(),
            },
        );
        let mut catalog = ModelCatalog::default();
        catalog.providers.insert(
            "openrouter".to_string(),
            CatalogProvider {
                id: "openrouter".to_string(),
                name: "OpenAI".to_string(),
                env: vec!["OPENAI_API_KEY".to_string()],
                api: "https://api.openai.com/v1".to_string(),
                npm: "@ai-sdk/openai".to_string(),
                models,
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        let mut config = AppConfig::default();
        config.merge_catalog(&catalog);
        // The user renames the model in their own config.
        config
            .provider
            .get_mut("openrouter")
            .unwrap()
            .models
            .get_mut("gpt-4o")
            .unwrap()
            .name = Some("My GPT".to_string());

        let mut persisted = config.strip_secrets();
        persisted.strip_catalog_derived(config.catalog.as_ref());
        assert_eq!(
            persisted.provider["openrouter"].models["gpt-4o"]
                .name
                .as_deref(),
            Some("My GPT"),
            "a user-edited model entry must not be stripped"
        );
    }

    /// Provider-level strip: stale shells copied by older catalog merges (no
    /// key, no URL, no custom models) are dropped, while user-connected
    /// providers and hand-added models survive. Regression test for the live
    /// `agente.json` that held 187 providers / 3000+ models: `merge`
    /// re-inserts every persisted row on load, so model-level stripping alone
    /// could never shrink it.
    #[test]
    fn stale_provider_shells_are_stripped_connected_ones_survive() {
        use crate::catalog::{
            CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
            ModelStatus,
        };

        let catalog_model = CatalogModel {
            provider: None,
            id: "some-model".to_string(),
            provider_id: "venice".to_string(),
            name: "Some Model".to_string(),
            family: None,
            capabilities: ModelCapabilities::default(),
            cost: ModelCost::default(),
            limit: ModelLimits::default(),
            status: ModelStatus::Active,
            api_id: "some-model".to_string(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            headers: HashMap::new(),
            options: HashMap::new(),
            variants: HashMap::new(),
        };
        let mut catalog = ModelCatalog::default();
        catalog.providers.insert(
            "venice".to_string(),
            CatalogProvider {
                id: "venice".to_string(),
                name: "Venice".to_string(),
                env: vec!["VENICE_API_KEY".to_string()],
                api: String::new(),
                npm: String::new(),
                models: [("some-model".to_string(), catalog_model.clone())]
                    .into_iter()
                    .collect(),
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        let mut config = AppConfig::default();
        for id in ["venice", "my-local", "custom"] {
            assert!(
                !config.provider.contains_key(id),
                "{id} must not be a built-in (else this test proves nothing)"
            );
        }
        config.merge_catalog(&catalog);
        // Stale shell: catalog-identical model plus catalog-fill metadata
        // (`api`/`name`/`env`/`npm`), but no authorship signal.
        config.provider.insert(
            "venice".into(),
            ProviderConfig {
                api: Some(String::new()),
                name: Some("Venice AI".to_string()),
                env: vec!["VENICE_API_KEY".to_string()],
                npm: Some("venice-ai-sdk-provider".to_string()),
                api_format: Some("openai".to_string()),
                models: [(
                    "some-model".to_string(),
                    model_config_from_catalog(&catalog_model),
                )]
                .into_iter()
                .collect(),
                ..Default::default()
            },
        );
        // User-connected custom endpoint: `add_provider_with_key` stores the
        // URL in `options.base_url` (the key itself lives in auth.json).
        config.provider.insert(
            "my-local".into(),
            ProviderConfig {
                options: ProviderOptions {
                    base_url: Some("http://localhost:11434/v1".to_string()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        // Hand-added model unknown to the catalog.
        config.provider.insert(
            "custom".into(),
            ProviderConfig {
                models: [(
                    "my-llama".to_string(),
                    ModelConfig {
                        name: Some("My Llama".to_string()),
                        ..Default::default()
                    },
                )]
                .into_iter()
                .collect(),
                ..Default::default()
            },
        );

        let mut persisted = config.strip_secrets();
        persisted.strip_catalog_derived(config.catalog.as_ref());
        assert!(
            !persisted.provider.contains_key("venice"),
            "stale shell with no authorship signal must be dropped"
        );
        assert!(
            persisted.provider.contains_key("my-local"),
            "connected custom endpoint must survive"
        );
        assert!(
            persisted.provider["custom"].models.contains_key("my-llama"),
            "hand-added model must survive"
        );
        // Built-ins always stay, and the serialized form stays small.
        assert!(persisted.provider.contains_key("openrouter"));
        let written = serde_json::to_string(&persisted).unwrap();
        assert!(
            written.len() < 256 * 1024,
            "persisted config must stay small, got {} bytes",
            written.len()
        );
    }
}
