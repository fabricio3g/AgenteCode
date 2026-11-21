//! Provider and model catalog configuration types and resolution helpers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::AppConfig;
use crate::catalog::{ModelCapabilities, ModelCost, ModelLimits, ModelStatus};

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

impl AppConfig {
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
    pub(super) fn strip_catalog_derived(&mut self, catalog: Option<&crate::catalog::ModelCatalog>) {
        let Some(catalog) = catalog else {
            return;
        };
        for (id, provider) in self.provider.iter_mut() {
            let Some(catalog_provider) = catalog
                .providers
                .get(crate::providers::spec::catalog_id(id))
            else {
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
        // Provider level: drop whole shells that carry no user authorship.
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
    pub(super) fn merge_catalog(&mut self, catalog: &crate::catalog::ModelCatalog) {
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

    pub(super) fn merge_providers(&mut self, other: HashMap<String, ProviderConfig>) {
        for (k, v) in other {
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
            let mut updated = existing.clone();
            updated.name = existing.name.clone().or_else(|| Some(provider_name.into()));
            updated.api = Some(base_url.clone());
            if updated.env.is_empty() {
                updated.env = vec![env_key];
            }
            updated.options.base_url = Some(base_url);
            updated.options.api_key = None; // never store in config
            updated
        } else {
            ProviderConfig {
                name: Some(provider_name.into()),
                api: Some(base_url.clone()),
                env: vec![env_key],
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

    pub fn get_provider_name(&self, provider_id: &str) -> String {
        self.provider
            .get(provider_id)
            .and_then(|p| p.name.clone())
            .unwrap_or_else(|| provider_id.to_string())
    }
}

pub(super) fn model_config_from_catalog(model: &crate::catalog::CatalogModel) -> ModelConfig {
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
