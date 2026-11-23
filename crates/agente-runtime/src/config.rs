//! Runtime configuration, live reloadable settings, provider/model discovery,
//! thinking profiles, and MCP server management.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agente_core::catalog::ModelCatalog;
use agente_core::config::{AppConfig, AutoApproveConfig};
use agente_core::mcp::client::McpManager;
use agente_core::permissions::ApprovalBroker;
use agente_core::providers::ProviderRegistry;
use agente_core::subagent::SubagentRegistry;
use agente_core::types::AgentMode;
use agente_protocol::Origin;
use agente_session::{SessionStore, SessionStoreError};

use crate::{RuntimeError, RuntimeHandle};

/// Where a turn's `profile` gets its persona. The daemon backs this with the
/// bot store; without one, a profile is only recorded on the session.
pub trait ProfileSource: Send + Sync {
    /// Who `profile` is (see `agente_core::context::bot_system_prompt`), or
    /// `None` when there is no such profile.
    fn persona(&self, profile: &str) -> Option<String>;

    /// Tools only this profile's turns get (a bot's memory and handoffs).
    fn tools(&self, _profile: &str, _turn: &ProfileTurn) -> Vec<Box<dyn agente_core::tools::Tool>> {
        Vec::new()
    }

    /// The built-in tools this profile may use (a bot's toolsets), `"mcp"`
    /// for MCP tools; `None` for every tool. Its own `tools` are always kept.
    fn tool_names(&self, _profile: &str) -> Option<Vec<String>> {
        None
    }

    /// The box this profile's commands run in, when this machine has one
    /// (see `agente_core::sandbox`); without one they run with a clean
    /// environment instead.
    fn sandbox(&self, _profile: &str) -> agente_core::sandbox::SandboxPolicy {
        agente_core::sandbox::SandboxPolicy::default()
    }
}

/// The turn a profile's tools are made for.
#[derive(Debug, Clone)]
pub struct ProfileTurn {
    /// Who started it (a handoff from another bot says so here).
    pub origin: Origin,
    pub provider: String,
    pub model: String,
    pub thinking_level: String,
}

#[derive(Clone)]
pub struct RuntimeConfig {
    pub project_dir: String,
    /// Resolved agent mode. Unknown config strings fail closed to Plan.
    pub mode: AgentMode,
    pub default_provider: String,
    pub default_model: String,
    pub default_thinking_level: String,
    pub max_iterations: u32,
    pub provider_registry: Arc<ProviderRegistry>,
    pub catalog: Option<ModelCatalog>,
    /// Auto-approve rules, for the engines of sessions in other projects.
    pub auto_approve: AutoApproveConfig,
    pub approval_broker: ApprovalBroker,
    pub subagent_registry: SubagentRegistry,
    /// The user's subagent model list, per-type defaults and picking switch.
    pub subagents: agente_core::config::SubagentSettings,
    /// LLM-summary compaction instead of trimming (user setting).
    pub smart_compaction: bool,
    pub compaction_model: Option<agente_core::config::SubagentModel>,
    /// Subagents allowed to run at once.
    pub max_parallel_subagents: usize,
    /// Optional durable session store. When set, every session commit writes
    /// an atomic snapshot through the store and cache misses recover from it,
    /// so sessions survive process restarts. `None` keeps the runtime purely
    /// in-memory (`from_app_config` leaves it unset — persistence is opt-in).
    pub session_store: Option<SessionStore>,
    /// The config the settings above came from; `configure` updates a copy
    /// of it and rebuilds them.
    pub app_config: AppConfig,
    /// Personas for turns that name a profile (a bot).
    pub profile_source: Option<Arc<dyn ProfileSource>>,
}

impl RuntimeConfig {
    pub fn from_app_config(app_config: &AppConfig, project_dir: impl Into<String>) -> Self {
        let project_dir = project_dir.into();
        // Fail closed: only an explicit "build" grants write access, mirroring
        // agente-core's parse_mode. Unknown strings run in Plan mode.
        let mode = match app_config.default_mode.as_deref() {
            // `auto` = the TUI's build-with-auto-approve; headless runs build.
            Some(value)
                if value.eq_ignore_ascii_case("build") || value.eq_ignore_ascii_case("auto") =>
            {
                AgentMode::Build
            }
            _ => AgentMode::Plan,
        };
        let default_provider = app_config
            .default_provider
            .clone()
            .unwrap_or_else(|| "deepseek".to_string());
        let default_model = app_config
            .default_model
            .clone()
            .or_else(|| app_config.executor_model.clone())
            .unwrap_or_else(|| "deepseek-flash".to_string());
        Self {
            project_dir: project_dir.clone(),
            mode,
            default_provider,
            default_model,
            default_thinking_level: app_config
                .default_thinking_level
                .clone()
                .unwrap_or_else(|| agente_core::thinking::THINKING_AUTO.to_string()),
            max_iterations: app_config.max_iterations(),
            provider_registry: Arc::new(ProviderRegistry::from_config(app_config)),
            catalog: app_config.catalog.clone(),
            auto_approve: app_config.auto_approve.clone(),
            approval_broker: ApprovalBroker::new(),
            subagent_registry: SubagentRegistry::new(),
            subagents: app_config.subagent_settings(),
            smart_compaction: app_config.smart_compaction,
            compaction_model: app_config.compaction_model.clone(),
            max_parallel_subagents: app_config.parallel_subagents(),
            session_store: None,
            app_config: app_config.clone(),
            profile_source: None,
        }
    }

    pub fn with_profile_source(mut self, source: Arc<dyn ProfileSource>) -> Self {
        self.profile_source = Some(source);
        self
    }

    /// Route session persistence through an existing store. `SessionStore` is
    /// cheap to clone and internally locked — clones share the same per-session
    /// log writers — so no further wrapping is needed.
    pub fn with_session_store(mut self, store: SessionStore) -> Self {
        self.session_store = Some(store);
        self
    }

    /// Enable persistence in `dir`, creating the directory if needed.
    ///
    /// Fallible on purpose: a store whose directory cannot be created is a
    /// configuration error the caller should surface, not silently degrade.
    pub fn with_persistence_dir(self, dir: impl Into<PathBuf>) -> Result<Self, SessionStoreError> {
        let store = SessionStore::open(dir)?;
        Ok(self.with_session_store(store))
    }

    /// Persist in the user-wide store (`~/.agente/store`, or under
    /// `AGENTE_CONFIG_DIR`): one place for every project, client and bot.
    pub fn with_user_store(self) -> Result<Self, SessionStoreError> {
        let root = AppConfig::config_dir()
            .unwrap_or_else(|| PathBuf::from(".agente"))
            .join("store");
        self.with_persistence_dir(root)
    }

    /// Enable persistence under `{project_dir}/.agente/sessions` — the
    /// standard location. Opt-in: [`RuntimeConfig::from_app_config`] never
    /// calls this.
    pub fn with_default_persistence(self) -> Result<Self, SessionStoreError> {
        let dir = Path::new(&self.project_dir)
            .join(".agente")
            .join("sessions");
        self.with_persistence_dir(dir)
    }
}

/// Settings a client can change while the runtime runs (`configure`):
/// providers and their keys, defaults, and loop limits. Each turn reads an immutable
/// shared snapshot when it starts; running turns keep theirs.
#[derive(Clone)]
pub(crate) struct LiveSettings {
    pub(crate) app_config: AppConfig,
    /// Providers that arrived through `configure`: registered even when the
    /// curated allowlist does not name them.
    pub(crate) client_providers: BTreeSet<String>,
    pub(crate) provider_registry: Arc<ProviderRegistry>,
    pub(crate) catalog: Option<Arc<ModelCatalog>>,
    pub(crate) default_provider: String,
    pub(crate) default_model: String,
    pub(crate) default_thinking_level: String,
    pub(crate) max_iterations: u32,
    pub(crate) smart_compaction: bool,
    pub(crate) compaction_model: Option<agente_core::config::SubagentModel>,
    pub(crate) max_parallel_subagents: usize,
    pub(crate) subagents: agente_core::config::SubagentSettings,
    /// MCP servers from the config (`mcp`), including tools a client serves
    /// itself (Agente Desktop's browser tools). `None`: the runtime's own.
    pub(crate) mcp_manager: Option<Arc<McpManager>>,
}

impl LiveSettings {
    pub(crate) fn from_config(config: &RuntimeConfig) -> Self {
        Self {
            app_config: config.app_config.clone(),
            client_providers: Default::default(),
            provider_registry: Arc::clone(&config.provider_registry),
            catalog: config.catalog.clone().map(Arc::new),
            default_provider: config.default_provider.clone(),
            default_model: config.default_model.clone(),
            default_thinking_level: config.default_thinking_level.clone(),
            max_iterations: config.max_iterations,
            smart_compaction: config.smart_compaction,
            compaction_model: config.compaction_model.clone(),
            max_parallel_subagents: config.max_parallel_subagents,
            subagents: config.subagents.clone(),
            mcp_manager: None,
        }
    }

    /// Rebuild everything from an updated app config, keeping what the
    /// config cannot carry (keys loaded from auth.json, the model catalog).
    pub(crate) fn from_app_config(
        mut app_config: AppConfig,
        client_providers: BTreeSet<String>,
        previous: &LiveSettings,
    ) -> Self {
        app_config.auth_store = previous.app_config.auth_store.clone();
        app_config.catalog = previous.app_config.catalog.clone();
        let rebuilt = RuntimeConfig::from_app_config(&app_config, "");
        for id in &client_providers {
            if let Some(provider) = app_config.provider.get(id) {
                rebuilt
                    .provider_registry
                    .register_client_provider(id, provider, &app_config);
            }
        }
        // Live model lists outlive a reconfigure; the next discovery replaces them.
        for (provider, models) in previous.provider_registry.runtime_snapshot() {
            if rebuilt.provider_registry.get(&provider).is_some() {
                rebuilt
                    .provider_registry
                    .replace_runtime_models(&provider, models);
            }
        }
        Self {
            provider_registry: Arc::clone(&rebuilt.provider_registry),
            catalog: previous.catalog.clone(),
            default_provider: rebuilt.default_provider,
            default_model: rebuilt.default_model,
            default_thinking_level: rebuilt.default_thinking_level,
            max_iterations: rebuilt.max_iterations,
            smart_compaction: rebuilt.smart_compaction,
            compaction_model: rebuilt.compaction_model,
            max_parallel_subagents: rebuilt.max_parallel_subagents,
            subagents: rebuilt.subagents,
            mcp_manager: previous.mcp_manager.clone(),
            app_config,
            client_providers,
        }
    }
}

/// Settings calls accept only the providers Agente offers itself.
fn known_provider(id: &str) -> Result<(), RuntimeError> {
    if agente_core::providers::spec::offered(id) {
        Ok(())
    } else {
        Err(RuntimeError::Config(format!("unknown provider `{id}`")))
    }
}

/// Save a fresh live list where the TUI's picker reads it, so a model a
/// provider retires leaves both surfaces whichever one refreshed.
fn remember_listing(provider: &str, models: &[agente_core::providers::ModelInfo]) {
    let Some(spec) = agente_core::providers::spec::get(provider) else {
        return;
    };
    if !spec.offered || !agente_core::models::live_membership(&spec.id) {
        return;
    }
    let ids: Vec<String> = models.iter().map(|model| model.id.clone()).collect();
    if let Err(error) = AppConfig::edit_global(|config| {
        config.discovered_models.insert(spec.id.clone(), ids);
    }) {
        tracing::warn!(provider = %spec.id, %error, "Could not save the model list");
    }
}

impl RuntimeHandle {
    /// Change settings for turns that start from now on. `patch` is a partial
    /// app config (`agente.json` shape): `provider` entries are added or
    /// replaced by id, every other key it names replaces the current value.
    /// Keys loaded from `~/.agente/auth.json` are kept.
    pub fn configure(&self, patch: serde_json::Value) -> Result<(), RuntimeError> {
        if let Some(manager) = self.configure_inner(patch)? {
            // Connect in the background when a runtime is around; otherwise
            // the servers connect on the next configure_and_connect.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move { manager.connect_all().await });
            }
        }
        Ok(())
    }

    /// Client-editable settings, without provider credentials.
    pub fn settings(&self) -> serde_json::Value {
        let live = self.inner.live();
        let config = &live.app_config;
        serde_json::json!({
            "smart_compaction": config.smart_compaction,
            "compaction_model": config.compaction_model,
            "max_parallel_subagents": config.max_parallel_subagents.unwrap_or(8),
            "subagents": config.subagent_settings(),
            "allow_media": config.allow_media,
            "approved_mcp_servers": config.approved_mcp_servers,
        })
    }

    /// Each offered provider: whether a key is on hand (auth.json, config or
    /// env — never the key itself) and where its requests go, plus the saved
    /// default provider and model.
    pub fn provider_status(&self) -> serde_json::Value {
        let live = self.inner.live();
        let config = &live.app_config;
        let providers: Vec<_> = agente_core::providers::spec::all()
            .iter()
            .filter(|spec| spec.offered)
            .map(|spec| {
                serde_json::json!({
                    "id": spec.id,
                    "connected": config.has_api_key(&spec.id),
                    "stored_key": config.auth_store.has(&spec.id),
                    "base_url": config.resolve_base_url(&spec.id),
                })
            })
            .collect();
        serde_json::json!({
            "providers": providers,
            "default_provider": live.default_provider,
            "default_model": live.default_model,
        })
    }

    /// Save a provider's key to auth.json and its endpoint override to
    /// config.json — the stores the TUI's `/connect` uses — so every client
    /// and the next turn see it. An empty `base_url` clears the override.
    pub fn connect_provider(
        &self,
        id: &str,
        api_key: Option<String>,
        base_url: Option<String>,
    ) -> Result<(), RuntimeError> {
        known_provider(id)?;
        let key = api_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
        let edit = base_url.map(|url| {
            let url = url.trim().to_string();
            move |config: &mut AppConfig| {
                let entry = config.provider.entry(id.to_string()).or_default();
                entry.options.base_url = (!url.is_empty()).then(|| url.clone());
            }
        });
        self.save_settings(
            |auth| {
                if let Some(key) = &key {
                    auth.set_key(id, key.clone());
                }
            },
            edit,
        )
    }

    /// Forget a provider's saved key (env keys stay in effect).
    pub fn disconnect_provider(&self, id: &str) -> Result<(), RuntimeError> {
        known_provider(id)?;
        self.save_settings(|auth| auth.remove(id), None::<fn(&mut AppConfig)>)
    }

    /// The provider and model turns use when the client names none.
    pub fn set_default_model(&self, provider: &str, model: &str) -> Result<(), RuntimeError> {
        known_provider(provider)?;
        let (provider, model) = (provider.to_string(), model.to_string());
        self.save_settings(
            |_| {},
            Some(move |config: &mut AppConfig| {
                config.default_provider = Some(provider.clone());
                config.default_model = Some(model.clone());
            }),
        )
    }

    /// Write auth.json (when `auth` changed it) and the global config.json
    /// (when there is an `edit`), then apply both to the live settings.
    fn save_settings(
        &self,
        auth: impl FnOnce(&mut agente_core::auth::AuthStore),
        edit: Option<impl Fn(&mut AppConfig)>,
    ) -> Result<(), RuntimeError> {
        let failed = |error: std::io::Error| RuntimeError::Config(error.to_string());
        let mut live = self
            .inner
            .live
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut store = agente_core::auth::AuthStore::load();
        let before = serde_json::to_string(&store).ok();
        auth(&mut store);
        if serde_json::to_string(&store).ok() != before {
            store.save().map_err(failed)?;
        }
        let mut config = live.app_config.clone();
        if let Some(edit) = &edit {
            AppConfig::edit_global(edit).map_err(failed)?;
            edit(&mut config);
        }
        Arc::make_mut(&mut live).app_config.auth_store = store;
        let client_providers = live.client_providers.clone();
        let next = LiveSettings::from_app_config(config, client_providers, &live);
        *live = Arc::new(next);
        Ok(())
    }

    pub fn model_info(&self, provider: &str, model: &str) -> agente_core::providers::ModelInfo {
        let live = self.inner.live();
        agente_core::providers::resolve_model_info(
            &live.provider_registry,
            live.catalog.as_deref(),
            provider,
            model,
        )
    }

    /// The models.dev rows a picker lists beside the provider's live ids
    /// ([`agente_core::models::catalog_extras`]): `(id, name, status)`.
    /// Empty when the catalog has not loaded.
    pub fn catalog_models(
        &self,
        provider: &str,
    ) -> Vec<(String, String, agente_core::catalog::ModelStatus)> {
        let live = self.inner.live();
        live.catalog
            .as_deref()
            .map(|catalog| {
                agente_core::models::catalog_extras(catalog, provider)
                    .into_iter()
                    .map(|model| (model.id.clone(), model.name.clone(), model.status.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// List a provider's models live and keep them as the snapshot turns and
    /// [`Self::model_info`] resolve against.
    pub async fn discover_models(
        &self,
        provider: &str,
    ) -> Result<Vec<agente_core::providers::ModelInfo>, RuntimeError> {
        let live = self.inner.live();
        let baseline = ProviderRegistry::from_config(&live.app_config);
        let models = agente_core::models::discover(
            &live.provider_registry,
            &baseline,
            live.catalog.as_deref(),
            provider,
        )
        .await
        .map_err(RuntimeError::Config)?;
        remember_listing(provider, &models);
        Ok(models)
    }

    /// The thinking choices a model offers (see `agente_core::thinking`).
    pub fn thinking_profile(
        &self,
        provider: &str,
        model: &str,
    ) -> agente_core::thinking::ThinkingProfile {
        let (info, format) = self.request_model(provider, model);
        agente_core::thinking::profile_for(&info, format)
    }

    /// The thinking fields a request for `level` carries on this model —
    /// what a client merges into a request it sends itself.
    pub fn thinking_request(
        &self,
        provider: &str,
        model: &str,
        level: &str,
    ) -> serde_json::Map<String, serde_json::Value> {
        let (info, format) = self.request_model(provider, model);
        agente_core::thinking::request_patch(&info, format, level)
    }

    /// A model as a request resolves it, with the wire format it goes out in.
    fn request_model(
        &self,
        provider: &str,
        model: &str,
    ) -> (
        agente_core::providers::ModelInfo,
        agente_core::providers::ApiFormat,
    ) {
        let live = self.inner.live();
        let mut info = self.model_info(provider, model);
        let format = match live.provider_registry.get(provider) {
            Some(registered) => {
                info.options = registered.get_request_options(&info);
                registered.request_api_format(&info)
            }
            None => info
                .api
                .resolved_format
                .or(info.api.format)
                .unwrap_or_default(),
        };
        (info, format)
    }

    /// Apply a patch; returns the MCP manager built from it, if it named
    /// `mcp`, still to be connected.
    fn configure_inner(
        &self,
        patch: serde_json::Value,
    ) -> Result<Option<Arc<McpManager>>, RuntimeError> {
        let invalid = |message: String| RuntimeError::Config(message);
        let serde_json::Value::Object(patch) = patch else {
            return Err(invalid("configure expects a JSON object".into()));
        };
        let patch_mcp = patch.contains_key("mcp");
        if let Some(subagents) = patch.get("subagents") {
            let settings: agente_core::config::SubagentSettings =
                serde_json::from_value(subagents.clone())
                    .map_err(|error| invalid(format!("subagents: {error}")))?;
            settings.validate().map_err(invalid)?;
        }
        // `subagents` absorbs the pre-list pins; keeping them would bring a
        // removed default back through the migration.
        let replaces_pins = patch.contains_key("subagents");
        let patch_approvals = patch.contains_key("approved_mcp_servers");
        let mut live = self
            .inner
            .live
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut merged =
            serde_json::to_value(&live.app_config).map_err(|error| invalid(error.to_string()))?;
        let mut client_providers = live.client_providers.clone();
        if let Some(serde_json::Value::Object(providers)) = patch.get("provider") {
            client_providers.extend(providers.keys().cloned());
        }
        for (key, value) in patch {
            match (key.as_str(), value, merged.get_mut(&key)) {
                (
                    "provider" | "mcp",
                    serde_json::Value::Object(providers),
                    Some(serde_json::Value::Object(current)),
                ) => {
                    current.extend(providers);
                }
                (_, value, _) => {
                    merged[key.as_str()] = value;
                }
            }
        }
        let mut app_config: AppConfig =
            serde_json::from_value(merged).map_err(|error| invalid(error.to_string()))?;
        if replaces_pins {
            app_config.subagent_models.clear();
        }
        let mut next = LiveSettings::from_app_config(app_config, client_providers, &live);
        let mut added = None;
        let mut old_mcp = None;
        if patch_mcp {
            let mut manager = McpManager::new();
            for (name, server) in &next.app_config.mcp {
                manager.add_client(name.clone(), server.clone());
            }
            let manager = Arc::new(manager);
            old_mcp = next.mcp_manager.replace(Arc::clone(&manager));
            added = Some(manager);
        }
        let prev_live = std::mem::replace(&mut *live, Arc::new(next));
        drop(live);
        let old_projects = if patch_mcp || patch_approvals {
            std::mem::take(
                &mut *self
                    .inner
                    .project_mcps
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()),
            )
        } else {
            HashMap::new()
        };
        drop((prev_live, old_mcp, old_projects));
        Ok(added)
    }

    /// Like [`Self::configure`], and waits until MCP servers the patch named
    /// are connected, so the next turn already has their tools.
    pub async fn configure_and_connect(
        &self,
        patch: serde_json::Value,
    ) -> Result<(), RuntimeError> {
        if let Some(manager) = self.configure_inner(patch)? {
            manager.connect_all().await;
        }
        Ok(())
    }

    /// The MCP servers turns can use, and how each is doing.
    pub fn mcp_snapshots(&self) -> Vec<agente_core::mcp::ServerSnapshot> {
        let live = self.inner.live();
        live.mcp_manager
            .clone()
            .map(|manager| manager.snapshots())
            .unwrap_or_default()
    }

    pub fn project_mcp_snapshots(
        &self,
        project_dir: &str,
    ) -> Vec<agente_core::mcp::ServerSnapshot> {
        self.inner.project_mcp(project_dir).snapshots()
    }

    pub async fn control_mcp(
        &self,
        project_dir: &str,
        name: &str,
        action: &str,
    ) -> Result<(), RuntimeError> {
        let manager = self.inner.project_mcp(project_dir);
        let server = manager
            .snapshots()
            .into_iter()
            .find(|server| server.name == name)
            .ok_or_else(|| RuntimeError::Config(format!("unknown MCP server {name}")))?;
        match action {
            "disable" => manager.disable(name),
            "approve" => {
                if server.source != agente_core::mcp::ServerSource::ProjectFile {
                    return Err(RuntimeError::Config(
                        "only project MCP servers need approval".into(),
                    ));
                }
                let mut approved = self.inner.live().app_config.approved_mcp_servers.clone();
                let key = agente_core::mcp::approval_key(project_dir, name);
                if !approved.contains(&key) {
                    approved.push(key.clone());
                }
                let _ = AppConfig::edit_global(|cfg| {
                    if !cfg.approved_mcp_servers.contains(&key) {
                        cfg.approved_mcp_servers.push(key.clone());
                    }
                });
                self.configure(serde_json::json!({ "approved_mcp_servers": approved }))?;
                self.inner.project_mcp(project_dir).reconnect(name).await;
            }
            "reconnect" if server.status != agente_core::mcp::ServerStatus::NeedsApproval => {
                manager.reconnect(name).await
            }
            _ => {
                return Err(RuntimeError::Config(
                    "choose approve, reconnect or disable".into(),
                ))
            }
        }
        Ok(())
    }

    /// Fetch the latest models.dev catalog, persist it to disk cache, and swap
    /// it into live settings so subsequent `models.info` / `models.discover`
    /// calls see updated limits, modalities, and thinking profiles without
    /// restarting the daemon.
    pub async fn refresh_catalog(&self) -> Result<usize, RuntimeError> {
        let fetched = agente_core::catalog::ModelCatalog::fetch()
            .await
            .map_err(|error| RuntimeError::Config(error.to_string()))?;
        let count = fetched.model_count();
        let _ = fetched.save_to_cache();
        let catalog = Arc::new(fetched);
        let mut live = self
            .inner
            .live
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next = Arc::make_mut(&mut live);
        next.catalog = Some(Arc::clone(&catalog));
        next.app_config.catalog = Some((*catalog).clone());
        Ok(count)
    }

    /// Test connectivity and authentication for `provider_id` using the core
    /// provider registry (honoring `auth.json`, env vars, and TOML specs).
    pub async fn test_provider(
        &self,
        provider_id: &str,
    ) -> Result<serde_json::Value, RuntimeError> {
        let started = std::time::Instant::now();
        let live = self.inner.live();
        if live.provider_registry.get(provider_id).is_none() {
            return Err(RuntimeError::Config(format!(
                "Unknown provider: {provider_id}"
            )));
        }
        if let Some(spec) = agente_core::providers::spec::get(provider_id) {
            if spec.group == agente_core::providers::spec::ProviderGroup::Cloud
                && !live.app_config.has_api_key(provider_id)
            {
                return Err(RuntimeError::Config(format!(
                    "No API key configured for {}",
                    spec.name
                )));
            }
        }
        let models = self.discover_models(provider_id).await?;
        Ok(serde_json::json!({
            "ok": true,
            "provider": provider_id,
            "count": models.len(),
            "latency_ms": started.elapsed().as_millis() as u64,
        }))
    }

    /// Run a stateless, no-tools text completion through the core provider
    /// stack (supports every wire format: OpenAI, Anthropic, Responses, Google).
    pub async fn complete_text(
        &self,
        provider_id: &str,
        model_id: &str,
        messages: Vec<agente_protocol::Message>,
        max_tokens: Option<usize>,
        session_id: Option<agente_protocol::SessionId>,
    ) -> Result<String, RuntimeError> {
        let live = self.inner.live();
        let provider = live
            .provider_registry
            .get(provider_id)
            .ok_or_else(|| RuntimeError::Config(format!("Unknown provider: {provider_id}")))?;
        let mut model = agente_core::providers::resolve_model_info(
            &live.provider_registry,
            live.catalog.as_deref(),
            provider_id,
            model_id,
        );
        model.options = provider.get_request_options(&model);
        if let Some(limit) = max_tokens.filter(|limit| *limit > 0) {
            model.limits.output = model
                .limits
                .output
                .min(limit.try_into().unwrap_or(model.limits.output));
            model.options.remove("max_tokens");
            model.options.remove("max_completion_tokens");
        }
        let ctx = agente_core::providers::RequestContext::new(
            session_id
                .unwrap_or_else(agente_protocol::SessionId::new)
                .as_uuid(),
        );
        agente_core::providers::summarizer::complete_text(provider, model, &messages, ctx)
            .await
            .map_err(|error| RuntimeError::Config(error.to_string()))
    }

    /// Generate a concise session title via the core title helper.
    pub async fn generate_title(
        &self,
        provider_id: &str,
        model_id: &str,
        user_text: &str,
        assistant_text: &str,
        session_id: Option<agente_protocol::SessionId>,
    ) -> Result<String, RuntimeError> {
        let live = self.inner.live();
        let provider = live
            .provider_registry
            .get(provider_id)
            .ok_or_else(|| RuntimeError::Config(format!("Unknown provider: {provider_id}")))?;
        let mut model = agente_core::providers::resolve_model_info(
            &live.provider_registry,
            live.catalog.as_deref(),
            provider_id,
            model_id,
        );
        model.options = provider.get_request_options(&model);
        let ctx = agente_core::providers::RequestContext::new(
            session_id
                .unwrap_or_else(agente_protocol::SessionId::new)
                .as_uuid(),
        );
        agente_core::providers::generate_session_title(
            provider,
            model,
            user_text,
            assistant_text,
            ctx,
        )
        .await
        .map_err(|error| RuntimeError::Config(error.to_string()))
    }

    /// Snapshot every subagent currently tracked by the runtime registry so
    /// clients can resync after `events.lagged` or window reload.
    pub fn list_children(&self) -> Vec<serde_json::Value> {
        let id_map = self.inner.lock_children().clone();
        self.inner
            .config
            .subagent_registry
            .list()
            .into_iter()
            .map(|snap| {
                let run_id = id_map.get(&snap.id).copied();
                serde_json::json!({
                    "id": snap.id,
                    "run_id": run_id,
                    "kind": snap.subagent_type,
                    "description": snap.description,
                    "model": snap.model,
                    "seat": snap.seat,
                    "provider": snap.provider,
                    "status": format!("{:?}", snap.status).to_ascii_lowercase(),
                    "summary": snap.summary,
                    "depth": snap.depth,
                    "background": snap.background,
                    "started_at": snap.started_at,
                    "finished_at": snap.finished_at,
                    "cwd": snap.cwd,
                })
            })
            .collect()
    }
}
