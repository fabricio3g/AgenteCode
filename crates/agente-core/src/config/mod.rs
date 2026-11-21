//! Application configuration: loading, merging, saving, and defaults.

mod providers;
mod subagents;
#[cfg(test)]
mod tests;

pub use providers::{
    provider_is_supported, ModelConfig, ProviderConfig, ProviderEntry, ProviderOptions,
};
pub use subagents::{
    SubagentModel, SubagentModelEntry, SubagentModels, SubagentSettings, ALL_SUBAGENTS, MAIN_MODEL,
};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::auth::AuthStore;
use crate::mcp::McpConfig;
use subagents::is_default_subagents;

pub const DEFAULT_MAX_CONCURRENT_SUBAGENTS: usize = 8;

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
    /// Internal provenance: true when explicitly present during deserialization
    /// so an absent project `auto_approve` never clobbers global settings.
    #[doc(hidden)]
    #[serde(skip)]
    pub explicit: bool,
}

impl PartialEq for AutoApproveConfig {
    fn eq(&self, other: &Self) -> bool {
        self.read_operations == other.read_operations
            && self.write_new_files == other.write_new_files
            && self.safe_commands == other.safe_commands
            && self.max_auto_edit_lines == other.max_auto_edit_lines
            && self.confirm_destructive == other.confirm_destructive
    }
}

impl Eq for AutoApproveConfig {}

fn deserialize_auto_approve_present<'de, D>(deserializer: D) -> Result<AutoApproveConfig, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let mut cfg = AutoApproveConfig::deserialize(deserializer)?;
    cfg.explicit = true;
    Ok(cfg)
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
            explicit: false,
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
    #[serde(default, deserialize_with = "deserialize_auto_approve_present")]
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
        config.merge_disk_layers(project_dir)
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

        config.merge_disk_layers(project_dir)
    }

    fn merge_disk_layers(mut self, project_dir: &str) -> Self {
        if let Some(home_config) = Self::global_config_path() {
            if let Ok(content) = std::fs::read_to_string(home_config) {
                if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                    self = self.merge(loaded);
                }
            }
        }
        let project_config = PathBuf::from(project_dir).join("agente.json");
        if let Ok(content) = std::fs::read_to_string(project_config) {
            if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                self = self.merge(loaded);
            }
        }
        self
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
            write_config_atomic(&global_path, &content)?;
        }

        // Mirror to workspace if given.
        if let Some(dir) = project_dir {
            let workspace_path = PathBuf::from(dir).join("agente.json");
            write_config_atomic(&workspace_path, &content)?;
        }

        Ok(())
    }

    pub fn merge(mut self, other: AppConfig) -> Self {
        self.merge_providers(other.provider);
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
        if other.max_iterations.is_some() {
            self.max_iterations = other.max_iterations;
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
        if other.auto_approve.explicit || other.auto_approve != AutoApproveConfig::default() {
            self.auto_approve = other.auto_approve;
        }
        self
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

    /// Return a copy of this config with secrets stripped for serialization.
    fn strip_secrets(&self) -> Self {
        let mut copy = self.clone();
        for pc in copy.provider.values_mut() {
            pc.options.api_key = None;
        }
        copy.catalog = None;
        copy.auth_store = AuthStore::default();
        copy
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

fn write_config_atomic(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    if path.parent().is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "config path has no parent directory",
        ));
    }
    crate::fs_atomic::write_atomic(path, content.as_bytes())
}
