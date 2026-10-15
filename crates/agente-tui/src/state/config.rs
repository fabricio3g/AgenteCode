//! Configuration-related state management
//!
//! This module contains state related to provider and model configuration:
//! - Current provider and model selection
//! - Provider registry
//! - Discovered models
//! - Connection state

use std::collections::HashMap;
use std::sync::Arc;

use agente_core::config::{AppConfig, ProviderEntry};
use agente_core::mcp::client::McpManager;
use agente_core::providers::{resolve_model_info, ModelInfo, ProviderRegistry};

/// Turn raw model ids into short readable labels (e.g. `deepseek-v4-flash` → `DeepSeek V4 Flash`).
fn humanize_model_id(model_id: &str) -> String {
    // Prefer the last path segment for router ids like `deepseek/deepseek-chat`.
    let leaf = model_id
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(model_id)
        .trim();
    if leaf.is_empty() {
        return model_id.to_string();
    }
    leaf.split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            match lower.as_str() {
                "gpt" => "GPT".into(),
                "llm" => "LLM".into(),
                "r1" => "R1".into(),
                "v3" | "v4" | "v2" | "v1" => lower.to_ascii_uppercase(),
                "deepseek" => "DeepSeek".into(),
                "openai" => "OpenAI".into(),
                "minimax" => "MiniMax".into(),
                "claude" => "Claude".into(),
                "gemini" => "Gemini".into(),
                "llama" => "Llama".into(),
                "mistral" => "Mistral".into(),
                "qwen" => "Qwen".into(),
                "groq" => "Groq".into(),
                "flash" => "Flash".into(),
                "chat" => "Chat".into(),
                "reasoner" => "Reasoner".into(),
                _ if part.chars().all(|c| c.is_ascii_digit()) => part.to_string(),
                _ => {
                    let mut chars = part.chars();
                    match chars.next() {
                        Some(c) => format!("{}{}", c.to_ascii_uppercase(), chars.as_str()),
                        None => String::new(),
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Connection screen state
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectScreen {
    Closed,
    SelectProvider {
        query: String,
        selected: usize,
    },
    EnterKey {
        provider: String,
        error: String,
        query: String,
        /// True when updating an existing key rather than first-time connect.
        replace: bool,
    },
}

/// Discovery status for a provider
#[derive(Debug, Clone, PartialEq)]
pub enum DiscoveryStatus {
    NotStarted,
    InProgress,
    Done,
    Failed(String),
}

/// Configuration state
#[derive(Clone)]
pub struct ConfigState {
    /// Application configuration
    pub config: AppConfig,
    /// Provider registry
    pub provider_registry: Arc<ProviderRegistry>,
    /// MCP manager for external tool servers
    pub mcp_manager: Arc<McpManager>,
    /// Currently selected provider ID
    pub current_provider: String,
    /// Currently selected model ID
    pub current_model: String,
    /// Connected provider IDs
    pub connected_providers: Vec<String>,
    /// Discovered models per provider
    pub discovered_models: HashMap<String, Vec<ModelInfo>>,
    raw_discovered_models: HashMap<String, Vec<ModelInfo>>,
    /// Discovery status per provider
    pub discovery_status: HashMap<String, DiscoveryStatus>,
    pub catalog_refresh_status: DiscoveryStatus,
    /// Connection screen state
    pub connect_screen: ConnectScreen,
    /// API key input for connection
    pub connect_key_input: String,
    /// Provider awaiting model discovery after an explicit connect/activate.
    /// Used to open the model picker only when models arrive (not on an empty list).
    pub pending_after_connect: Option<String>,
}

impl ConfigState {
    /// Create new config state from config
    pub fn new(config: AppConfig) -> Self {
        Self::for_project(config, "")
    }

    /// [`Self::new`] that also offers the project's `.mcp.json` servers.
    pub fn for_project(config: AppConfig, project_dir: &str) -> Self {
        let registry = Arc::new(ProviderRegistry::from_config(&config));

        // Build connected list from registry providers.
        // Only providers with a resolved API key are considered connected.
        // Local providers (ollama, lmstudio) with empty env_keys are NOT auto-connected.
        let mut connected = Vec::new();
        for provider_id in registry.provider_ids() {
            if let Some(info) = registry.get(&provider_id).map(|p| p.info().clone()) {
                if info.resolve_api_key().is_some() {
                    connected.push(provider_id);
                }
            }
        }

        // Also check config providers that might not be in registry
        for entry in config.provider_entries() {
            if !connected.contains(&entry.id) && config.has_api_key(&entry.id) {
                connected.push(entry.id);
            }
        }

        // Restore last-used provider/model from the saved defaults if that provider is connected.
        let current_provider = config
            .default_provider
            .clone()
            .filter(|p| connected.iter().any(|c| c == p))
            .unwrap_or_default();
        let current_model = if current_provider.is_empty() {
            String::new()
        } else {
            config.default_model.clone().unwrap_or_default()
        };

        // Servers connect in the background once the app runs (`/mcp`).
        let mcp_arc = Arc::new(if project_dir.is_empty() {
            let mut manager = McpManager::new();
            for (name, mcp_config) in &config.mcp {
                manager.add_client(name.clone(), mcp_config.clone());
            }
            manager
        } else {
            McpManager::from_sources(&config.mcp, project_dir, &config.approved_mcp_servers)
        });

        Self {
            config,
            provider_registry: registry,
            mcp_manager: mcp_arc,
            current_provider,
            current_model,
            connected_providers: connected,
            discovered_models: HashMap::new(),
            raw_discovered_models: HashMap::new(),
            discovery_status: HashMap::new(),
            catalog_refresh_status: DiscoveryStatus::NotStarted,
            connect_screen: ConnectScreen::Closed,
            connect_key_input: String::new(),
            pending_after_connect: None,
        }
    }

    /// Sync TUI state into the `AppConfig` and persist both global and workspace.
    /// Called from the TUI whenever the user picks a model, toggles mode, etc.
    pub fn persist(&mut self, project_dir: &str) {
        self.config.set_defaults(
            Some(self.current_provider.clone()),
            Some(self.current_model.clone()),
        );

        // Mirror discovered model IDs into the AppConfig cache.
        let cache: HashMap<String, Vec<String>> = self
            .discovered_models
            .iter()
            .map(|(k, v)| (k.clone(), v.iter().map(|m| m.id.clone()).collect()))
            .collect();
        if !cache.is_empty() {
            for (k, v) in cache {
                self.config.discovered_models.insert(k, v);
            }
        }

        if let Err(e) = self.config.save_to_workspace(project_dir) {
            tracing::warn!(error = %e, "Failed to persist config to workspace");
        }
    }

    pub fn update_model_catalog(&mut self, catalog: &agente_core::catalog::ModelCatalog) {
        self.config.refresh_catalog(catalog);
        let mut discovered = self.raw_discovered_models.clone();
        let status = self.discovery_status.clone();
        self.discovered_models.clear();
        self.rebuild_provider_registry();
        for (provider, models) in &mut discovered {
            for model in models.iter_mut() {
                // Only OpenRouter's and llama-server's variants originate in a
                // live response. Other reasoning controls came from the old catalog.
                model.reasoning_options.retain(|option| {
                    matches!(
                        option,
                        agente_core::catalog::ReasoningOption::OpenRouter { .. }
                            | agente_core::catalog::ReasoningOption::LlamaCpp { .. }
                    )
                });
            }
            self.set_discovered_models(provider, std::mem::take(models));
        }
        self.catalog_refresh_status = DiscoveryStatus::Done;
        self.discovery_status = status;
    }

    /// Check if any provider is connected
    pub fn is_connected(&self) -> bool {
        !self.connected_providers.is_empty()
    }

    /// Check if specific provider is connected
    pub fn is_provider_connected(&self, provider: &str) -> bool {
        self.connected_providers.iter().any(|p| p == provider)
    }

    /// Connect a provider with an optional API key.
    ///
    /// Empty key is allowed when re-selecting a provider that already has auth
    /// (auth store / env) or a local provider that needs no key.
    pub fn connect_provider(&mut self, provider: &str, api_key: &str) {
        let provider_changed = self.current_provider != provider;
        let base_url = self.config.resolve_base_url(provider).unwrap_or_default();

        if !api_key.is_empty() {
            if !base_url.is_empty() {
                self.config
                    .add_provider_with_key(provider, base_url, api_key.to_string());
            } else {
                self.config
                    .auth_store
                    .set_key(provider, api_key.to_string());
                if let Err(e) = self.config.auth_store.save() {
                    tracing::warn!(error = %e, "Failed to save auth store");
                }
            }
        }

        if !self.connected_providers.iter().any(|p| p == provider) {
            self.connected_providers.push(provider.to_string());
        }

        // Rebuild the registry so auth/base URL changes take effect.
        self.rebuild_provider_registry();

        tracing::info!(
            provider = %provider,
            registry_size = self.provider_registry.provider_ids().len(),
            "Provider connected"
        );

        self.current_provider = provider.to_string();
        if provider_changed {
            self.current_model.clear();
        }
        self.pending_after_connect = Some(provider.to_string());
    }

    /// Disconnect a provider. When `forget_key` is true, remove stored auth.
    pub fn disconnect_provider(&mut self, provider: &str, forget_key: bool) {
        self.connected_providers.retain(|p| p != provider);
        self.discovered_models.remove(provider);
        self.raw_discovered_models.remove(provider);
        self.provider_registry
            .replace_runtime_models(provider, Vec::new());
        self.discovery_status.remove(provider);
        if self.pending_after_connect.as_deref() == Some(provider) {
            self.pending_after_connect = None;
        }

        if forget_key {
            self.config.auth_store.remove(provider);
            if let Err(e) = self.config.auth_store.save() {
                tracing::warn!(error = %e, "Failed to save auth store after disconnect");
            }
            // Rebuild so the provider no longer resolves the old key.
            self.rebuild_provider_registry();
        }

        if self.current_provider == provider {
            if let Some(next) = self.connected_providers.first().cloned() {
                self.current_provider = next;
                self.current_model.clear();
            } else {
                self.current_provider.clear();
                self.current_model.clear();
            }
        }

        tracing::info!(provider = %provider, forget_key, "Provider disconnected");
    }

    /// Whether this provider can be used without typing a new key.
    pub fn can_activate_without_key(&self, provider: &str) -> bool {
        if self.is_provider_connected(provider) {
            return true;
        }
        // Local / no-env providers
        if let Some(pc) = self.config.provider.get(provider) {
            if pc.env.is_empty() {
                return true;
            }
        }
        self.config.has_api_key(provider)
    }

    /// Open the connect screen
    pub fn open_connect_screen(&mut self) {
        self.connect_screen = ConnectScreen::SelectProvider {
            query: String::new(),
            selected: 0,
        };
    }

    /// Close the connect screen
    pub fn close_connect_screen(&mut self) {
        self.connect_screen = ConnectScreen::Closed;
        self.connect_key_input.clear();
    }

    /// Open API key entry for a provider.
    pub fn open_enter_key(&mut self, provider: &str, query: String, replace: bool, error: String) {
        self.connect_key_input.clear();
        self.connect_screen = ConnectScreen::EnterKey {
            provider: provider.to_string(),
            error,
            query,
            replace,
        };
    }

    /// Get all provider entries from registry and config
    pub fn all_provider_entries(&self) -> Vec<ProviderEntry> {
        let mut entries = Vec::new();
        let mut seen_ids = std::collections::HashSet::new();

        // First add providers from registry
        for provider_id in self.provider_registry.provider_ids() {
            if let Some(provider) = self.provider_registry.get(&provider_id) {
                let info = provider.info();

                entries.push(ProviderEntry {
                    id: provider_id.clone(),
                    name: info.name.clone(),
                    env_key: info.env_keys.first().cloned().unwrap_or_default(),
                });
                seen_ids.insert(provider_id);
            }
        }

        // Then add any config providers not in registry
        for entry in self.config.provider_entries() {
            if !seen_ids.contains(&entry.id) {
                entries.push(entry);
            }
        }

        entries
    }

    /// Get resolved API key for current provider
    pub fn get_resolved_api_key(&self) -> Option<String> {
        self.config.resolve_api_key(&self.current_provider)
    }

    /// Get resolved base URL for current provider
    pub fn get_resolved_base_url(&self) -> Option<String> {
        self.config.resolve_base_url(&self.current_provider)
    }

    /// Get API key for specific provider
    pub fn get_api_key_for(&self, provider: &str) -> Option<String> {
        self.config.resolve_api_key(provider)
    }

    /// Get base URL for specific provider
    pub fn get_base_url_for(&self, provider: &str) -> Option<String> {
        self.config.resolve_base_url(provider)
    }

    /// Check if provider has API key
    pub fn provider_has_key(&self, provider: &str) -> bool {
        self.config.has_api_key(provider)
    }

    /// Get display name for provider
    pub fn get_provider_display_name(&self, provider: &str) -> String {
        self.config.get_provider_name(provider)
    }

    /// Resolve full model metadata for UI and tooling.
    ///
    /// Order: registry/catalog → enriched discovered live models → last-resort
    /// default context window. Catalog (`models.dev`) is authoritative for
    /// context windows and reasoning flags when the model is known.
    pub fn resolve_model(&self, provider: &str, model_id: &str) -> Option<ModelInfo> {
        if provider.is_empty() || model_id.is_empty() {
            return None;
        }

        let catalog = self.config.catalog.as_ref();

        // Prefer already-enriched discovery entries (live list + catalog merge).
        if let Some(discovered) = self.discovered_models.get(provider) {
            if let Some(m) = discovered
                .iter()
                .find(|m| m.id == model_id || m.api_id == model_id)
            {
                // Discovery already published this enriched snapshot to the
                // registry shared with turns. Do not enrich it a second time.
                let mut m = m.clone();
                if m.name.trim().is_empty() || m.name == m.id {
                    m.name = humanize_model_id(&m.id);
                }
                return Some(m);
            }
        }

        let mut m = resolve_model_info(&self.provider_registry, catalog, provider, model_id);
        if m.name.trim().is_empty() || m.name == m.id {
            m.name = humanize_model_id(&m.id);
        }
        Some(m)
    }

    /// Get a polished display name for a provider+model pair.
    ///
    /// Prefers the catalog/config/discovered model name over the raw id, then
    /// strips a redundant provider prefix (e.g. "MiniMax MiniMax-M1" -> "MiniMax M1").
    pub fn get_model_display_name(&self, provider: &str, model_id: &str) -> String {
        if model_id.is_empty() {
            return if provider.is_empty() {
                "no provider".to_string()
            } else {
                self.get_provider_display_name(provider)
            };
        }

        let provider_name = self.get_provider_display_name(provider);
        let model_name = self
            .resolve_model(provider, model_id)
            .map(|m| {
                if m.name.trim().is_empty() || m.name == m.id {
                    humanize_model_id(&m.id)
                } else {
                    m.name
                }
            })
            .unwrap_or_else(|| humanize_model_id(model_id));

        if provider_name.is_empty() {
            return model_name;
        }

        // If the friendly name already contains the provider brand, don't double it.
        let name_lower = model_name.to_lowercase();
        let provider_lower = provider_name.to_lowercase();
        if name_lower.starts_with(&provider_lower)
            || name_lower.contains(&provider_lower)
            || model_name
                .to_lowercase()
                .starts_with(&provider.to_lowercase())
        {
            return model_name;
        }

        let stripped = model_name
            .strip_prefix(&provider_name)
            .or_else(|| model_name.strip_prefix(&provider_name.to_lowercase()))
            .or_else(|| model_name.strip_prefix(&provider_name.replace(' ', "-")))
            .or_else(|| model_name.strip_prefix(&provider_name.replace(' ', "")))
            .unwrap_or(&model_name)
            .trim_start_matches(['-', '_', '/', ' '])
            .trim();

        if stripped.is_empty() {
            provider_name
        } else {
            format!("{provider_name} {stripped}")
        }
    }

    /// Set discovered models for a provider (enriched with catalog context/caps).
    pub fn set_discovered_models(&mut self, provider: &str, models: Vec<ModelInfo>) {
        self.raw_discovered_models
            .insert(provider.to_string(), models.clone());
        let catalog = self.config.catalog.as_ref();
        // Never enrich against the previous runtime snapshot: metadata omitted
        // by a fresh response must not inherit stale live reasoning controls.
        let baseline = ProviderRegistry::from_config(&self.config);
        let enriched = agente_core::models::enrich_discovered(&models, &baseline, catalog);
        self.provider_registry
            .replace_runtime_models(provider, enriched.clone());
        self.discovered_models
            .insert(provider.to_string(), enriched);
        self.discovery_status
            .insert(provider.to_string(), DiscoveryStatus::Done);
    }

    /// Restore live model snapshots when authentication changes rebuild providers.
    fn rebuild_provider_registry(&mut self) {
        let registry = Arc::new(ProviderRegistry::from_config(&self.config));
        for (provider, models) in &self.discovered_models {
            registry.replace_runtime_models(provider, models.clone());
        }
        self.provider_registry = registry;
    }

    /// Set discovery failed status
    pub fn set_discovery_failed(&mut self, provider: &str, error: String) {
        self.discovery_status
            .insert(provider.to_string(), DiscoveryStatus::Failed(error));
    }

    /// Get model entries for a specific provider
    pub fn get_models_for_provider(&self, provider: &str) -> Vec<ModelEntry> {
        let is_conn = self.is_provider_connected(provider);
        let has_config = self.config.provider.get(provider);
        let has_discovered = self.discovered_models.get(provider);

        tracing::info!(
            provider = %provider,
            connected = ?self.connected_providers,
            is_connected = is_conn,
            config_models = has_config.map(|p| p.models.len()).unwrap_or(0),
            discovered_models = has_discovered.map(|m| m.len()).unwrap_or(0),
            "get_models_for_provider"
        );

        if !is_conn {
            return Vec::new();
        }

        let mut entries = Vec::new();

        if matches!(
            self.discovery_status.get(provider),
            Some(DiscoveryStatus::Done)
        ) {
            if let Some(discovered) = has_discovered {
                for m in discovered {
                    entries.push(ModelEntry {
                        provider: provider.to_string(),
                        model_id: m.id.clone(),
                        display_name: m.name.clone(),
                        discovered: true,
                        context_window: (m.limits.context > 0).then_some(m.limits.context),
                    });
                }
            }
            return entries;
        }

        if let Some(discovered) = has_discovered {
            for m in discovered {
                entries.push(ModelEntry {
                    provider: provider.to_string(),
                    model_id: m.id.clone(),
                    display_name: m.name.clone(),
                    discovered: true,
                    context_window: (m.limits.context > 0).then_some(m.limits.context),
                });
            }
        }

        // Until this session's list arrives, a provider whose own list decides
        // membership shows its last saved answer — what it retired since
        // models.dev or the seeds recorded stays out.
        if has_discovered.is_none() && agente_core::models::live_membership(provider) {
            let saved = self.config.discovered_models.get(provider);
            if let Some(saved) = saved.filter(|ids| !ids.is_empty()) {
                for id in saved {
                    let resolved = self.resolve_model(provider, id);
                    entries.push(ModelEntry {
                        provider: provider.to_string(),
                        model_id: id.clone(),
                        display_name: resolved
                            .as_ref()
                            .map_or_else(|| humanize_model_id(id), |m| m.name.clone()),
                        discovered: true,
                        context_window: resolved
                            .and_then(|m| (m.limits.context > 0).then_some(m.limits.context)),
                    });
                }
                return entries;
            }
        }

        if let Some(provider_config) = has_config {
            for (id, model) in &provider_config.models {
                let retired = model.status == Some(agente_core::catalog::ModelStatus::Deprecated);
                if !retired && !entries.iter().any(|e| e.model_id == *id) {
                    let context_window = self
                        .resolve_model(provider, id)
                        .and_then(|m| (m.limits.context > 0).then_some(m.limits.context));
                    entries.push(ModelEntry {
                        provider: provider.to_string(),
                        model_id: id.clone(),
                        display_name: model.name.clone().unwrap_or_else(|| id.clone()),
                        discovered: false,
                        context_window,
                    });
                }
            }
        }

        tracing::info!(
            provider = %provider,
            returned = entries.len(),
            "get_models_for_provider returning"
        );
        entries
    }

    /// Get all model entries across providers
    pub fn get_all_model_entries(&self) -> Vec<ModelEntry> {
        let mut entries = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in &self.connected_providers {
            let models = self.get_models_for_provider(id);
            for m in &models {
                seen.insert((m.provider.clone(), m.model_id.clone()));
            }
            entries.extend(models);
        }
        // Also include config providers that may have static model definitions
        for id in self.config.provider.keys() {
            if !self.connected_providers.contains(id) {
                let models = self.get_models_for_provider(id);
                for m in models {
                    if !seen.contains(&(m.provider.clone(), m.model_id.clone())) {
                        entries.push(m);
                    }
                }
            }
        }
        entries
    }
}

/// Model entry for selector UI
#[derive(Debug, Clone)]
pub struct ModelEntry {
    pub provider: String,
    pub model_id: String,
    pub display_name: String,
    pub discovered: bool,
    /// Model context window in tokens (None when unknown).
    pub context_window: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;

    #[test]
    fn catalog_refresh_updates_discovered_protocol_and_effort_without_stale_controls() {
        use agente_core::catalog::ModelCatalog;
        use agente_core::providers::{fallback_model_info, ApiFormat};
        use agente_core::thinking::supported_thinking_levels;
        let catalog = |npm: &str, effort: &str| {
            ModelCatalog::parse_json(
                &serde_json::json!({
                    "test-provider": {"id":"test-provider","name":"Zen","models":{
                        "fixture": {"id":"fixture","name":"Fixture","reasoning":true,
                            "provider":{"npm":npm},
                            "reasoning_options":[{"type":"effort","values":[effort]}],
                            "limit":{"context":100000,"output":8192}}
                    }}
                })
                .to_string(),
            )
            .unwrap()
        };
        let mut state = ConfigState::new(AppConfig::default());
        state.update_model_catalog(&catalog("@ai-sdk/anthropic", "low"));
        let mut raw = fallback_model_info("test-provider", "fixture");
        raw.limits.context = 0;
        raw.limits.output = 0;
        state.set_discovered_models("test-provider", vec![raw]);
        assert_eq!(
            state
                .resolve_model("test-provider", "fixture")
                .unwrap()
                .api
                .format,
            Some(ApiFormat::Anthropic)
        );
        state
            .discovery_status
            .insert("test-provider".into(), DiscoveryStatus::InProgress);
        state.update_model_catalog(&catalog("@ai-sdk/openai", "high"));
        let model = state.resolve_model("test-provider", "fixture").unwrap();
        assert_eq!(model.api.format, Some(ApiFormat::Responses));
        assert_eq!(supported_thinking_levels(&model), vec!["high"]);
        assert_eq!(
            state.discovery_status["test-provider"],
            DiscoveryStatus::InProgress
        );
        let turn = resolve_model_info(&state.provider_registry, None, "test-provider", "fixture");
        assert_eq!(turn.api.format, model.api.format);
        assert_eq!(supported_thinking_levels(&turn), vec!["high"]);
    }

    #[test]
    fn discovery_reaches_turn_registry_and_outgoing_reasoning_options() {
        use agente_core::catalog::ReasoningOption;
        use agente_core::providers::ApiFormat;
        use agente_core::thinking::{apply_thinking_level, ThinkingFormat};

        let mut config = ConfigState::new(AppConfig::default());
        let turn_registry = config.provider_registry.clone();
        let id = "test/live-reasoner";
        let mut live = resolve_model_info(&turn_registry, None, "openrouter", id);
        live.capabilities.reasoning = true;
        live.compat = ThinkingFormat::OpenRouter;
        live.reasoning_options = vec![ReasoningOption::OpenRouter {
            effort_selectable: true,
            supported_efforts: Some(vec!["high".into(), "low".into()]),
            default_effort: Some("low".into()),
            default_enabled: Some(true),
            mandatory: true,
            supports_max_tokens: false,
        }];
        config.set_discovered_models("openrouter", vec![live.clone()]);

        let mut resolved = resolve_model_info(&turn_registry, None, "openrouter", id);
        assert_eq!(
            agente_core::thinking::supported_thinking_levels(&resolved),
            vec!["low", "high"]
        );
        apply_thinking_level(&mut resolved, ApiFormat::OpenAI, "low");
        assert_eq!(
            resolved.options.get("reasoning"),
            Some(&serde_json::json!({"effort": "low"}))
        );

        config.rebuild_provider_registry();
        let mut rebuilt = resolve_model_info(&config.provider_registry, None, "openrouter", id);
        apply_thinking_level(&mut rebuilt, ApiFormat::OpenAI, "high");
        assert_eq!(
            rebuilt.options.get("reasoning"),
            Some(&serde_json::json!({"effort": "high"}))
        );

        // An omitted live control must not resurrect the previous snapshot.
        live.reasoning_options.clear();
        live.capabilities.reasoning = false;
        config.set_discovered_models("openrouter", vec![live]);
        let mut refreshed = resolve_model_info(&config.provider_registry, None, "openrouter", id);
        apply_thinking_level(&mut refreshed, ApiFormat::OpenAI, "high");
        assert!(!refreshed.options.contains_key("reasoning"));
        assert!(agente_core::thinking::supported_thinking_levels(&refreshed).is_empty());

        let disconnect_registry = config.provider_registry.clone();
        config.disconnect_provider("openrouter", false);
        assert!(disconnect_registry
            .runtime_model("openrouter", id)
            .is_none());
    }

    #[test]
    fn model_display_name_uses_catalog_names() {
        let config = ConfigState::new(AppConfig::default());
        assert_eq!(
            config.get_model_display_name("openrouter", "openai/gpt-4o"),
            "OpenRouter GPT-4o (Router)"
        );
        assert_eq!(
            config.get_model_display_name("minimax", "MiniMax-M2.7"),
            "MiniMax M2.7"
        );
    }

    #[test]
    fn model_display_name_falls_back_to_humanized_id() {
        let config = ConfigState::new(AppConfig::default());
        // Unknown provider keeps id prefix; model id is humanized.
        assert_eq!(
            config.get_model_display_name("acme", "my-model"),
            "acme My Model"
        );
        assert_eq!(
            config.get_model_display_name("deepseek", "deepseek-v4-flash"),
            "DeepSeek V4 Flash"
        );
    }

    #[test]
    fn provider_display_name_is_human_readable() {
        let config = ConfigState::new(AppConfig::default());
        assert_eq!(config.get_provider_display_name("openrouter"), "OpenRouter");
        assert_eq!(config.get_provider_display_name("minimax"), "MiniMax");
        // Retired providers no longer receive built-in display metadata.
        assert_eq!(config.get_provider_display_name("google"), "google");
        assert_eq!(
            config.get_provider_display_name("missing_provider"),
            "missing_provider"
        );
    }
}
