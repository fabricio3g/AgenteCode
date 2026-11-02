use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;

use crate::catalog::{
    effective_limits, CatalogModel, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
    ModelStatus, ReasoningOption, DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS,
};
use crate::llm::{LlmError, StreamEvent, Usage};
use crate::types::{Message, ToolDefinition};

mod billing;
mod cache;
pub mod google;
pub mod llamacpp;
pub mod messages;
pub mod openai;
pub mod policy;
pub mod responses;
mod routed;
pub mod spec;
pub mod text_tools;
mod wire;
pub(crate) use wire::{model_options, wire_options};
use wire::{replay_blocks, send_request, send_with_cache_fallback, stream_error};
mod sse;
pub mod summarizer;
pub mod title;
#[cfg(test)]
mod transport_tests;

pub use summarizer::ProviderSummarizer;
pub use title::generate_session_title;

/// Desktop wraps built-in providers in runtime-scoped configuration entries.
/// Their transport contracts still belong to the underlying provider.
pub(crate) fn canonical_provider_id(id: &str) -> &str {
    id.strip_prefix("desktop-").unwrap_or(id)
}

/// Stable per-conversation identity, shared by turns and auxiliary completions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestContext {
    pub session_id: uuid::Uuid,
}

impl RequestContext {
    pub fn new(session_id: uuid::Uuid) -> Self {
        Self { session_id }
    }
}

/// API format types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiFormat {
    #[default]
    OpenAI,
    Anthropic,
    Responses,
    Google,
}

impl ApiFormat {
    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "openai" | "chat" | "chat/completions" | "openai-compatible" => Some(Self::OpenAI),
            "anthropic" | "messages" => Some(Self::Anthropic),
            "responses" | "openai-responses" => Some(Self::Responses),
            "google" | "gemini" => Some(Self::Google),
            _ => None,
        }
    }

    pub fn from_npm(npm: &str) -> Option<Self> {
        match npm {
            "@ai-sdk/anthropic" | "@ai-sdk/google-vertex/anthropic" => Some(Self::Anthropic),
            "@ai-sdk/openai" => Some(Self::Responses),
            "@ai-sdk/google" => Some(Self::Google),
            "@ai-sdk/openai-compatible" | "@openrouter/ai-sdk-provider" => Some(Self::OpenAI),
            _ => None,
        }
    }
}

/// Per-model transport metadata. Gateways can mix API formats at one URL.
#[derive(Debug, Clone, Default)]
pub struct ModelApi {
    pub format: Option<ApiFormat>,
    pub base_url: Option<String>,
    pub format_source: policy::MetadataSource,
    pub live_format: Option<ApiFormat>,
    pub live_cache_control: Option<bool>,
    pub cache_source: policy::MetadataSource,
    pub resolved_format: Option<ApiFormat>,
    pub resolved_base_url: Option<String>,
    pub resolved_cache_control: Option<bool>,
    pub resolved_policy: Option<policy::TransportPolicy>,
    pub route_error: Option<String>,
}

impl ModelApi {
    fn from_provider(provider: Option<&crate::catalog::ModelProvider>) -> Self {
        let Some(provider) = provider else {
            return Self::default();
        };
        Self {
            format: provider
                .api_format
                .as_deref()
                .and_then(ApiFormat::from_name)
                .or_else(|| provider.npm.as_deref().and_then(ApiFormat::from_npm)),
            base_url: provider.api.clone().filter(|url| !url.is_empty()),
            ..Default::default()
        }
    }
}

/// Provider capabilities
#[derive(Debug, Clone, Default)]
pub struct ProviderCapabilities {
    pub streaming: bool,
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
    pub temperature: bool,
    pub max_tokens: bool,
}

/// Provider info
#[derive(Debug, Clone, Default)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub api_format: ApiFormat,
    pub capabilities: ProviderCapabilities,
    pub base_url: String,
    pub env_keys: Vec<String>,
    pub headers: HashMap<String, String>,
    pub models: Vec<ModelInfo>,
    /// Resolved API key from auth store (takes priority over env vars).
    pub api_key: Option<String>,
    pub transport: policy::TransportPolicy,
}

/// Model info
#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub api: ModelApi,
    pub id: String,
    pub name: String,
    pub api_id: String,
    pub provider_id: String,
    pub capabilities: ModelCapabilities,
    pub cost: ModelCost,
    pub limits: ModelLimits,
    pub status: ModelStatus,
    pub headers: HashMap<String, String>,
    pub options: HashMap<String, serde_json::Value>,
    /// From models.dev — only source of thinking levels (never invent).
    pub reasoning_options: Vec<ReasoningOption>,
    /// Interleaved stream field from catalog (e.g. `reasoning_content`).
    pub reasoning_stream_field: Option<String>,
    /// Provider-specific reasoning request shape (pi `detectCompat` parity).
    pub compat: crate::thinking::ThinkingFormat,
}

/// Best-effort capabilities for models returned only by a provider's live
/// `/models` endpoint when catalog has no entry.
///
/// **Reasoning is never inferred from the model id.** Only catalog/config
/// may set `capabilities.reasoning` and `reasoning_options`.
pub fn inferred_service_model_capabilities(model_id: &str) -> ModelCapabilities {
    let id = model_id.to_ascii_lowercase();
    let non_chat = [
        "embedding",
        "embed",
        "moderation",
        "whisper",
        "tts",
        "audio",
        "image",
        "vision-preview",
    ];

    ModelCapabilities {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: !non_chat.iter().any(|marker| id.contains(marker)),
        vision: id.contains("vision") || id.contains("vl") || id.contains("multimodal"),
        streaming: true,
        input_modalities: Vec::new(),
    }
}

impl ProviderInfo {
    pub fn resolve_api_key(&self) -> Option<String> {
        // 1. Auth store key (injected at registry build time)
        if let Some(key) = &self.api_key {
            if !key.is_empty() {
                return Some(key.clone());
            }
        }

        // 2. Env vars in order
        for env_key in &self.env_keys {
            if let Ok(val) = std::env::var(env_key) {
                if !val.is_empty() {
                    return Some(val);
                }
            }
        }

        // 3. Fallback convention
        let fallback = format!("{}_API_KEY", self.id.to_uppercase().replace('-', "_"));
        if let Ok(val) = std::env::var(&fallback) {
            if !val.is_empty() {
                return Some(val);
            }
        }

        None
    }

    pub fn resolve_base_url(&self) -> String {
        let env_key = format!("{}_BASE_URL", self.id.to_uppercase().replace('-', "_"));
        if let Ok(val) = std::env::var(&env_key) {
            if !val.is_empty() {
                return crate::util::expand_env_templates(&val);
            }
        }
        crate::util::expand_env_templates(&self.base_url)
    }
}

/// Provider trait
#[async_trait]
pub trait Provider: Send + Sync {
    fn info(&self) -> &ProviderInfo;

    /// Stream completion request
    async fn stream_completion(
        &self,
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        model: &ModelInfo,
        sender: Sender<StreamEvent>,
        context: RequestContext,
    ) -> Result<Usage, LlmError>;

    /// List available models
    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError>;

    /// Get model by ID (matches `id` or `api_id`, plus bare/prefixed variants).
    fn get_model(&self, model_id: &str) -> Option<&ModelInfo> {
        let models = &self.info().models;
        if let Some(m) = models
            .iter()
            .find(|m| m.id == model_id || m.api_id == model_id)
        {
            return Some(m);
        }
        if let Some((prefix, bare)) = model_id.split_once('/') {
            if prefix != self.info().id {
                return None;
            }
            if let Some(m) = models.iter().find(|m| m.id == bare || m.api_id == bare) {
                return Some(m);
            }
        }
        None
    }

    /// Transform messages for this provider's API format
    fn transform_messages(&self, messages: &[Message]) -> Vec<Message> {
        // Default: no transformation
        messages.to_vec()
    }

    /// Get provider-specific request options
    fn get_request_options(&self, model: &ModelInfo) -> HashMap<String, serde_json::Value> {
        model_options(&model.options)
    }

    /// The wire format can be selected per model for gateway providers.
    fn request_api_format(&self, model: &ModelInfo) -> ApiFormat {
        self.resolve_request_api_format(model)
            .unwrap_or(self.info().api_format)
    }
    fn resolve_request_api_format(&self, model: &ModelInfo) -> Result<ApiFormat, LlmError> {
        self.info().resolve_format(model)
    }
}

pub struct ProviderRegistry {
    providers: RwLock<HashMap<String, Arc<dyn Provider>>>,
    /// Live model snapshots keyed by provider. These stay separate from
    /// static provider/catalog models so discovery can replace metadata
    /// without mutating either source.
    runtime_models: RwLock<HashMap<String, Vec<ModelInfo>>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: RwLock::new(HashMap::new()),
            runtime_models: RwLock::new(HashMap::new()),
        }
    }

    /// Build a registry from connectable providers in `AppConfig`.
    ///
    /// Catalog (models.dev) is **not** registered wholesale — it only enriches
    /// model metadata via `AppConfig::merge_catalog` and `resolve_model_info`.
    /// Registering every catalog gateway made the connect UI unusable.
    pub fn from_config(config: &crate::config::AppConfig) -> Self {
        let registry = Self::new();

        tracing::info!(
            provider_count = config.provider.len(),
            "Building provider registry from config"
        );

        for (id, provider_config) in &config.provider {
            if !crate::config::provider_is_supported(id, provider_config) {
                continue;
            }
            registry.register_from_config(id, provider_config, config);
        }

        tracing::info!(
            registered = registry.providers.read().len(),
            "Provider registry built"
        );

        registry
    }

    /// Register a provider a client handed over at runtime (Agente Desktop's
    /// own endpoints and keys, local llama.cpp servers). The curated
    /// allowlist gates what Agente Code offers by itself; it does not apply to
    /// providers a client brings, which take the generic path.
    pub fn register_client_provider(
        &self,
        id: &str,
        provider_config: &crate::config::ProviderConfig,
        app_config: &crate::config::AppConfig,
    ) {
        self.register_from_config(id, provider_config, app_config);
    }

    fn register_from_config(
        &self,
        id: &str,
        provider_config: &crate::config::ProviderConfig,
        app_config: &crate::config::AppConfig,
    ) {
        let base_url = app_config
            .resolve_base_url(id)
            .unwrap_or_else(|| provider_config.api.clone().unwrap_or_default());

        let api_format = provider_config
            .api_format
            .as_deref()
            .map(parse_api_format)
            .or_else(|| provider_config.npm.as_deref().and_then(ApiFormat::from_npm))
            .unwrap_or(ApiFormat::OpenAI);

        // Build static models from config if defined.
        // Capabilities come from config/catalog when set; otherwise infer from
        // model id (conservative), same role as pi's model.reasoning field.
        let models: Vec<ModelInfo> = provider_config
            .models
            .iter()
            .map(|(model_id, model)| {
                let capabilities = model
                    .capabilities
                    .clone()
                    .unwrap_or_else(|| inferred_service_model_capabilities(model_id));
                // Overlay catalog reasoning metadata when available (not from name).
                let (reasoning_options, reasoning_stream_field, capabilities) =
                    if let Some(cat) = app_config.catalog.as_ref() {
                        if let Some(cm) = cat.find_model(id, model_id) {
                            let mut caps = capabilities;
                            if cm.capabilities.reasoning {
                                caps.reasoning = true;
                            }
                            (
                                cm.reasoning_options.clone(),
                                cm.reasoning_stream_field.clone(),
                                caps,
                            )
                        } else {
                            (
                                model.reasoning_options.clone(),
                                model.reasoning_stream_field.clone(),
                                capabilities,
                            )
                        }
                    } else {
                        (
                            model.reasoning_options.clone(),
                            model.reasoning_stream_field.clone(),
                            capabilities,
                        )
                    };
                ModelInfo {
                    api: ModelApi {
                        format_source: if model.api_from_catalog {
                            policy::MetadataSource::Catalog
                        } else {
                            policy::MetadataSource::Configured
                        },
                        cache_source: if model.api_from_catalog {
                            policy::MetadataSource::Catalog
                        } else {
                            policy::MetadataSource::Configured
                        },
                        ..ModelApi::from_provider(model.provider.as_ref())
                    },
                    id: model_id.clone(),
                    name: model.name.clone().unwrap_or_else(|| model_id.clone()),
                    api_id: model_id.clone(),
                    provider_id: id.to_string(),
                    capabilities,
                    cost: model.cost.clone().unwrap_or_default(),
                    limits: effective_limits(&model.limit.clone().unwrap_or(ModelLimits {
                        context: DEFAULT_CONTEXT_WINDOW,
                        input: None,
                        output: DEFAULT_OUTPUT_TOKENS,
                    })),
                    status: model.status.clone().unwrap_or(ModelStatus::Active),
                    headers: model.headers.clone(),
                    options: model.options.clone(),
                    reasoning_options,
                    reasoning_stream_field,
                    compat: crate::thinking::detect_thinking_format(id, &base_url),
                }
            })
            .collect();

        tracing::info!(
            provider = %id,
            model_count = models.len(),
            api_format = ?api_format,
            "Registering provider from config"
        );

        let info = ProviderInfo {
            transport: provider_config.transport.clone().unwrap_or_default(),
            id: id.to_string(),
            name: provider_config
                .name
                .clone()
                .unwrap_or_else(|| id.to_string()),
            api_format,
            capabilities: ProviderCapabilities {
                streaming: true,
                tools: true,
                vision: models.iter().any(|m| m.capabilities.vision),
                reasoning: models.iter().any(|m| m.capabilities.reasoning),
                temperature: true,
                max_tokens: true,
            },
            base_url,
            env_keys: provider_config.env.clone(),
            headers: provider_config
                .options
                .extra
                .get("headers")
                .and_then(serde_json::Value::as_object)
                .map(|headers| {
                    headers
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|v| (key.clone(), v.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            models,
            api_key: app_config.resolve_api_key(id),
        };

        self.register(
            id,
            Arc::new(routed::RoutedProvider::new(
                info,
                provider_config.options.extra.clone(),
            )),
        );
    }

    pub fn register(&self, id: &str, provider: Arc<dyn Provider>) {
        self.providers.write().insert(id.to_string(), provider);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.providers.read().get(id).cloned()
    }

    pub fn providers(&self) -> Vec<Arc<dyn Provider>> {
        self.providers.read().values().cloned().collect()
    }

    pub fn provider_ids(&self) -> Vec<String> {
        self.providers.read().keys().cloned().collect()
    }

    pub fn has_api_key(&self, provider_id: &str) -> bool {
        self.providers
            .read()
            .get(provider_id)
            .map(|p| p.info().resolve_api_key().is_some())
            .unwrap_or(false)
    }

    /// Replace the live discovery snapshot for one provider.
    ///
    /// An empty snapshot clears that provider's runtime overrides.
    pub fn replace_runtime_models(&self, provider: &str, models: Vec<ModelInfo>) {
        self.runtime_models
            .write()
            .insert(provider.to_string(), models);
    }

    /// Every provider's live snapshot, to carry across a registry rebuild.
    pub fn runtime_snapshot(&self) -> HashMap<String, Vec<ModelInfo>> {
        self.runtime_models.read().clone()
    }

    /// Resolve a model from the live discovery snapshot, if present.
    pub fn runtime_model(&self, provider: &str, model_id: &str) -> Option<ModelInfo> {
        self.runtime_models
            .read()
            .get(provider)
            .and_then(|models| find_model(models, provider, model_id))
    }

    pub fn get_model(&self, provider_id: &str, model_id: &str) -> Option<ModelInfo> {
        if let Some(model) = self.runtime_model(provider_id, model_id) {
            return Some(model);
        }
        self.providers
            .read()
            .get(provider_id)
            .and_then(|p| find_model(&p.info().models, provider_id, model_id))
    }
}

fn find_model(models: &[ModelInfo], provider_id: &str, model_id: &str) -> Option<ModelInfo> {
    models
        .iter()
        .find(|m| m.id == model_id || m.api_id == model_id)
        .cloned()
        .or_else(|| {
            // Accept provider/model IDs only when the prefix names this
            // provider. Never strip a vendor prefix from a gateway model ID
            // and accidentally match another model.
            if let Some((prefix, bare)) = model_id.split_once('/') {
                if prefix != provider_id {
                    return None;
                }
                models
                    .iter()
                    .find(|m| m.id == bare || m.api_id == bare)
                    .cloned()
            } else {
                let prefixed = format!("{provider_id}/{model_id}");
                models
                    .iter()
                    .find(|m| m.id == prefixed || m.api_id == prefixed)
                    .cloned()
            }
        })
}

/// Convert a catalog entry into runtime `ModelInfo`.
pub fn model_info_from_catalog(model: &CatalogModel, provider_id: &str) -> ModelInfo {
    ModelInfo {
        api: ModelApi {
            format_source: policy::MetadataSource::Catalog,
            cache_source: policy::MetadataSource::Catalog,
            ..ModelApi::from_provider(model.provider.as_ref())
        },
        id: model.id.clone(),
        name: if model.name.is_empty() {
            model.id.clone()
        } else {
            model.name.clone()
        },
        api_id: if model.api_id.is_empty() {
            model.id.clone()
        } else {
            model.api_id.clone()
        },
        provider_id: provider_id.to_string(),
        capabilities: model.capabilities.clone(),
        cost: model.cost.clone(),
        limits: effective_limits(&model.limit),
        status: model.status.clone(),
        headers: model.headers.clone(),
        options: model.options.clone(),
        reasoning_options: model.reasoning_options.clone(),
        reasoning_stream_field: model.reasoning_stream_field.clone(),
        compat: crate::thinking::detect_thinking_format(provider_id, ""),
    }
}
/// Last-resort model metadata when catalog and registry both miss.
pub fn fallback_model_info(provider_id: &str, model_id: &str) -> ModelInfo {
    ModelInfo {
        api: ModelApi::default(),
        id: model_id.to_string(),
        name: model_id.to_string(),
        api_id: model_id.to_string(),
        provider_id: provider_id.to_string(),
        capabilities: inferred_service_model_capabilities(model_id),
        cost: ModelCost::default(),
        limits: ModelLimits {
            context: DEFAULT_CONTEXT_WINDOW,
            input: None,
            output: DEFAULT_OUTPUT_TOKENS,
        },
        status: ModelStatus::Active,
        headers: HashMap::new(),
        options: HashMap::new(),
        reasoning_options: Vec::new(),
        reasoning_stream_field: None,
        compat: crate::thinking::detect_thinking_format(provider_id, ""),
    }
}

/// Single resolution path for UI + agent (pi-style: metadata on the model record).
///
/// Priority:
/// 1. Registry (config + models.dev merge)
/// 2. Catalog lookup (covers models not yet registered on the provider)
/// 3. Optional live/discovered stub fields (context from API when > 0)
/// 4. Inferred fallback with default context window
pub fn resolve_model_info(
    registry: &ProviderRegistry,
    catalog: Option<&ModelCatalog>,
    provider_id: &str,
    model_id: &str,
) -> ModelInfo {
    let mut model = resolve_known_model_info(registry, catalog, provider_id, model_id);
    adopt_served_thinking(registry, provider_id, &mut model);
    spec::apply_fallback_reasoning(&mut model);
    // Reconfiguration wins over stale live snapshots.
    if let Some(provider) = registry.get(provider_id) {
        if let Some(configured) = find_model(&provider.info().models, provider_id, model_id) {
            overlay_transport(&mut model, &configured);
        }
        resolve_registered_transport(&mut model, provider.as_ref());
    } else if let Some(spec) = spec::get(canonical_provider_id(provider_id)) {
        resolve_transport(
            &mut model,
            &ProviderInfo {
                id: provider_id.into(),
                name: spec.name.clone(),
                api_format: spec.api_format(),
                base_url: spec.base_url.clone(),
                ..Default::default()
            },
        );
    }
    model
}

/// A llama-server serves one model, under whatever id it chose. Whatever the
/// client calls it, it gets the thinking controls discovery read from `/props`.
fn adopt_served_thinking(registry: &ProviderRegistry, provider_id: &str, model: &mut ModelInfo) {
    if !model.reasoning_options.is_empty()
        || !spec::get(provider_id).is_some_and(|s| s.models == spec::ModelSource::Llamacpp)
    {
        return;
    }
    let served = registry
        .runtime_models
        .read()
        .get(provider_id)
        .and_then(|models| models.first().cloned());
    if let Some(served) = served {
        model.compat = served.compat;
        if !served.reasoning_options.is_empty() {
            model.reasoning_options = served.reasoning_options;
            model.capabilities.reasoning = true;
        }
    }
}

fn resolve_known_model_info(
    registry: &ProviderRegistry,
    catalog: Option<&ModelCatalog>,
    provider_id: &str,
    model_id: &str,
) -> ModelInfo {
    if provider_id.is_empty() || model_id.is_empty() {
        return fallback_model_info(provider_id, model_id);
    }

    if let Some(mut m) = registry.runtime_model(provider_id, model_id) {
        let refresh_catalog = catalog.is_some()
            || registry.get(provider_id).is_some_and(|provider| {
                find_model(&provider.info().models, provider_id, model_id)
                    .is_some_and(|model| model.api.format_source == policy::MetadataSource::Catalog)
            });
        reset_derived_transport(&mut m, refresh_catalog);
        if let Some(cm) = catalog.and_then(|catalog| catalog.find_model(provider_id, model_id)) {
            overlay_transport(&mut m, &model_info_from_catalog(cm, provider_id));
        }
        m.limits = effective_limits(&m.limits);
        apply_catalog_thinking(&mut m, catalog, provider_id, model_id);
        apply_catalog_inputs(&mut m, catalog, provider_id, model_id);
        apply_catalog_cost(&mut m, catalog, provider_id, model_id);
        return m;
    }

    if let Some(mut m) = registry.get_model(provider_id, model_id) {
        m.limits = effective_limits(&m.limits);
        apply_catalog_thinking(&mut m, catalog, provider_id, model_id);
        apply_catalog_inputs(&mut m, catalog, provider_id, model_id);
        apply_catalog_cost(&mut m, catalog, provider_id, model_id);
        return m;
    }

    if let Some(cat) = catalog {
        if let Some(cm) = cat.find_model(provider_id, model_id) {
            return model_info_from_catalog(cm, provider_id);
        }
    }

    let mut m = fallback_model_info(provider_id, model_id);
    if let Some(limits) = catalog.and_then(|cat| cat.find_family_limits(provider_id, model_id)) {
        m.limits = effective_limits(&limits);
    }
    apply_catalog_thinking(&mut m, catalog, provider_id, model_id);
    apply_catalog_cost(&mut m, catalog, provider_id, model_id);
    m
}

/// Give a model the price models.dev knows, when nothing else priced it.
///
/// A model added by id — the common way to add a new or self-hosted one —
/// carries `ModelConfig.cost: None`, which the registry turns into
/// `ModelCost::default()`: unpriced. models.dev usually knows the rate, and
/// without this overlay every surface had to show `+` (TUI) or nothing
/// (desktop) for a model that is in fact priced, while the model picker read
/// the price through its own path. An explicit configured price always wins,
/// and a price a live `/models` reported is kept as it is.
fn apply_catalog_cost(
    m: &mut ModelInfo,
    catalog: Option<&ModelCatalog>,
    provider_id: &str,
    model_id: &str,
) {
    if m.cost.is_priced() {
        return;
    }
    let Some(cm) = catalog.and_then(|cat| {
        cat.find_model(provider_id, model_id)
            .or_else(|| cat.find_model(provider_id, &m.id))
            .or_else(|| cat.find_model(provider_id, &m.api_id))
    }) else {
        return;
    };
    if cm.cost.is_priced() {
        m.cost = cm.cost.clone();
    }
}

/// Add the input kinds models.dev lists to a model the provider described
/// without them. A live `/models` that lists ids only (OpenCode Go) is
/// snapshotted with whatever catalog existed then, so a model models.dev
/// learned about later would otherwise stay text-only until rediscovery.
/// Only adds: a llama-server's own answer (vision projector or not) stands.
fn apply_catalog_inputs(
    m: &mut ModelInfo,
    catalog: Option<&ModelCatalog>,
    provider_id: &str,
    model_id: &str,
) {
    if spec::get(provider_id).is_some_and(|s| s.models == spec::ModelSource::Llamacpp) {
        return;
    }
    let Some(cm) = catalog.and_then(|cat| {
        cat.find_model(provider_id, model_id)
            .or_else(|| cat.find_model(provider_id, &m.api_id))
    }) else {
        return;
    };
    let caps = &mut m.capabilities;
    caps.vision |= cm.capabilities.vision;
    caps.attachment |= cm.capabilities.attachment;
    for kind in &cm.capabilities.input_modalities {
        if !caps
            .input_modalities
            .iter()
            .any(|k| k.eq_ignore_ascii_case(kind))
        {
            caps.input_modalities.push(kind.clone());
        }
    }
    // Non-empty modalities are what `media::model_accepts` trusts over `vision`.
    if caps.vision
        && !caps.input_modalities.is_empty()
        && !caps.input_modalities.iter().any(|k| k == "image")
    {
        caps.input_modalities.push("image".into());
    }
}

/// Overlay models.dev thinking metadata onto a ModelInfo (authoritative).
fn apply_catalog_thinking(
    m: &mut ModelInfo,
    catalog: Option<&ModelCatalog>,
    provider_id: &str,
    model_id: &str,
) {
    let Some(cat) = catalog else {
        return;
    };
    let Some(cm) = cat
        .find_model(provider_id, model_id)
        .or_else(|| cat.find_model(provider_id, &m.id))
        .or_else(|| cat.find_model(provider_id, &m.api_id))
    else {
        return;
    };
    if cm.capabilities.reasoning {
        m.capabilities.reasoning = true;
    }
    let catalog_api = ModelApi::from_provider(cm.provider.as_ref());
    if m.api.format.is_none() {
        m.api.format = catalog_api.format;
        m.api.format_source = policy::MetadataSource::Catalog;
    }
    if m.api.base_url.is_none() {
        m.api.base_url = catalog_api.base_url;
    }
    let has_live_openrouter_metadata = m.reasoning_options.iter().any(|option| {
        matches!(
            option,
            ReasoningOption::OpenRouter { .. } | ReasoningOption::LlamaCpp { .. }
        )
    });
    if !cm.reasoning_options.is_empty() && !has_live_openrouter_metadata {
        m.reasoning_options = cm.reasoning_options.clone();
    }
    if cm.reasoning_stream_field.is_some() {
        m.reasoning_stream_field = cm.reasoning_stream_field.clone();
    }
    // Prefer catalog display name when we only have a raw id.
    if (m.name.is_empty() || m.name == m.id) && !cm.name.is_empty() {
        m.name = cm.name.clone();
    }
    if (m.limits.context == 0 || m.limits.context == DEFAULT_CONTEXT_WINDOW) && cm.limit.context > 0
    {
        m.limits = effective_limits(&cm.limit);
    }
}

/// Enrich a live `/models` entry with catalog/registry metadata.
///
/// Live list decides **membership**; catalog decides **context / reasoning / cost**
/// unless the API itself returned a positive context window.
pub fn enrich_discovered_model(
    discovered: &ModelInfo,
    registry: &ProviderRegistry,
    catalog: Option<&ModelCatalog>,
) -> ModelInfo {
    let mut resolved =
        resolve_model_info(registry, catalog, &discovered.provider_id, &discovered.id);

    // Prefer non-empty live display name when catalog only had the raw id.
    if !discovered.name.is_empty()
        && discovered.name != discovered.id
        && (resolved.name == resolved.id || resolved.name.is_empty())
    {
        resolved.name = discovered.name.clone();
    }

    overlay_transport(&mut resolved, discovered);

    // Live API context/output wins when providers actually send them.
    if discovered.limits.context > 0 {
        resolved.limits.context = discovered.limits.context;
    }
    if discovered.limits.output > 0 {
        resolved.limits.output = discovered.limits.output;
    }
    if let Some(input) = discovered.limits.input {
        resolved.limits.input = Some(input);
    }

    // Live provider metadata is authoritative for the selected model's
    // reasoning contract. Preserve it through catalog enrichment so the
    // exact controls reach the agent request path.
    if !discovered.reasoning_options.is_empty() {
        resolved.capabilities.reasoning = discovered.capabilities.reasoning;
        resolved.reasoning_options = discovered.reasoning_options.clone();
        resolved.compat = discovered.compat;
    }

    // If we only have the fallback (no catalog/registry hit), keep discovery
    // capability heuristics — they are better than empty flags.
    let catalog_hit = registry
        .get_model(&discovered.provider_id, &discovered.id)
        .is_some()
        || catalog
            .and_then(|c| c.find_model(&discovered.provider_id, &discovered.id))
            .is_some();
    if !catalog_hit {
        // Live-only stubs: keep discovery tool/vision flags; never invent reasoning.
        resolved.capabilities.toolcall = discovered.capabilities.toolcall;
        resolved.capabilities.vision = discovered.capabilities.vision;
        resolved.capabilities.streaming = discovered.capabilities.streaming;
        // reasoning + reasoning_options stay false/empty without catalog.
    }

    // Always re-apply catalog thinking (covers id variants / late-loaded catalog).
    apply_catalog_thinking(
        &mut resolved,
        catalog,
        &discovered.provider_id,
        &discovered.id,
    );
    // A live list that carried no `pricing` (most gateways) is not a free
    // model: take models.dev's rate rather than reporting no price at all.
    apply_catalog_cost(
        &mut resolved,
        catalog,
        &discovered.provider_id,
        &discovered.id,
    );

    resolved.limits = effective_limits(&resolved.limits);
    if let Some(provider) = registry.get(&discovered.provider_id) {
        resolve_registered_transport(&mut resolved, provider.as_ref());
    }
    resolved
}

fn reset_derived_transport(model: &mut ModelInfo, refresh_catalog: bool) {
    let reset = |source| {
        source == policy::MetadataSource::Configured
            || (refresh_catalog && source == policy::MetadataSource::Catalog)
    };
    if reset(model.api.format_source) {
        model.api.format = model.api.live_format;
        model.api.format_source = if model.api.format.is_some() {
            policy::MetadataSource::Live
        } else {
            policy::MetadataSource::Fallback
        };
    }
    if reset(model.api.cache_source) {
        model.options.remove("cache_control");
        if let Some(nested) = model
            .options
            .get_mut("options")
            .and_then(serde_json::Value::as_object_mut)
        {
            nested.remove("cache_control");
        }
        model.api.cache_source = policy::MetadataSource::Fallback;
        if let Some(cache) = model.api.live_cache_control {
            model
                .options
                .insert("cache_control".into(), serde_json::json!(cache));
            model.api.cache_source = policy::MetadataSource::Live;
        }
    }
}

pub(crate) fn overlay_transport(target: &mut ModelInfo, source: &ModelInfo) {
    if source.api.live_format.is_some() {
        target.api.live_format = source.api.live_format;
    } else if source.api.format_source == policy::MetadataSource::Live {
        target.api.live_format = source.api.format;
    }
    if source.api.live_cache_control.is_some() {
        target.api.live_cache_control = source.api.live_cache_control;
    } else if source.api.cache_source == policy::MetadataSource::Live {
        target.api.live_cache_control = model_options(&source.options)
            .get("cache_control")
            .and_then(serde_json::Value::as_bool);
    }
    if source.api.format.is_some()
        && (target.api.format.is_none() || source.api.format_source >= target.api.format_source)
    {
        target.api.format = source.api.format;
        target.api.format_source = source.api.format_source;
    }
    if let Some(cache) = model_options(&source.options)
        .get("cache_control")
        .and_then(serde_json::Value::as_bool)
    {
        if !model_options(&target.options).contains_key("cache_control")
            || source.api.cache_source >= target.api.cache_source
        {
            target
                .options
                .insert("cache_control".into(), serde_json::json!(cache));
            target.api.cache_source = source.api.cache_source;
        }
    }
}

pub(crate) fn resolve_registered_transport(model: &mut ModelInfo, provider: &dyn Provider) {
    resolve_transport(model, provider.info());
    if let Some(format) = model.api.resolved_format {
        let mut request_model = model.clone();
        request_model.options = provider.get_request_options(model);
        model.api.resolved_cache_control = Some(
            provider
                .info()
                .transport_policy()
                .breakpoints(format, &request_model),
        );
    }
}

pub(crate) fn resolve_transport(model: &mut ModelInfo, info: &ProviderInfo) {
    model.api.resolved_policy = Some(info.transport_policy());
    model.api.resolved_base_url = Some(info.resolve_base_url());
    match info.resolve_format(model) {
        Ok(format) => {
            model.api.resolved_format = Some(format);
            model.api.resolved_cache_control =
                Some(info.transport_policy().breakpoints(format, model));
            model.api.route_error = None;
        }
        Err(error) => {
            model.api.resolved_format = None;
            model.api.resolved_cache_control = None;
            model.api.route_error = Some(error.to_string());
        }
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// URL helper
pub fn join_url(base: &str, path: &str) -> String {
    let base_trimmed = base.trim_end_matches('/');
    if path.starts_with('/') {
        format!("{base_trimmed}{path}")
    } else {
        format!("{base_trimmed}/{path}")
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

fn parse_api_format(s: &str) -> ApiFormat {
    ApiFormat::from_name(s).unwrap_or_default()
}

#[cfg(test)]
mod resolve_tests {
    use super::*;
    use crate::catalog::ModelCatalog;

    #[test]
    fn resolve_uses_catalog_context_window() {
        let catalog = ModelCatalog::parse_json(
            r#"{
              "deepseek": {
                "id": "deepseek",
                "name": "DeepSeek",
                "api": "https://api.deepseek.com",
                "models": {
                  "deepseek-v4-flash": {
                    "id": "deepseek-v4-flash",
                    "name": "DeepSeek V4 Flash",
                    "reasoning": true,
                    "tool_call": true,
                    "limit": { "context": 1000000, "output": 384000 }
                  }
                }
              }
            }"#,
        )
        .unwrap();

        let registry = ProviderRegistry::new();
        let info = resolve_model_info(&registry, Some(&catalog), "deepseek", "deepseek-v4-flash");
        assert_eq!(info.limits.context, 1_000_000);
        assert_eq!(info.limits.output, 384_000);
        assert!(info.capabilities.reasoning);
        assert_eq!(info.name, "DeepSeek V4 Flash");
    }

    #[test]
    fn enrich_prefers_live_context_when_present() {
        let catalog = ModelCatalog::parse_json(
            r#"{
              "openai": {
                "id": "openai",
                "name": "OpenAI",
                "api": "https://api.openai.com/v1",
                "models": {
                  "gpt-4o": {
                    "id": "gpt-4o",
                    "name": "GPT-4o",
                    "reasoning": false,
                    "tool_call": true,
                    "limit": { "context": 128000, "output": 16384 }
                  }
                }
              }
            }"#,
        )
        .unwrap();
        let registry = ProviderRegistry::new();
        let discovered = ModelInfo {
            api: Default::default(),
            id: "gpt-4o".into(),
            name: "gpt-4o".into(),
            api_id: "gpt-4o".into(),
            provider_id: "openai".into(),
            capabilities: inferred_service_model_capabilities("gpt-4o"),
            cost: ModelCost::default(),
            limits: ModelLimits {
                context: 200_000,
                input: None,
                output: 0,
            },
            status: ModelStatus::Active,
            headers: HashMap::new(),
            options: HashMap::new(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            compat: crate::thinking::ThinkingFormat::Default,
        };
        let enriched = enrich_discovered_model(&discovered, &registry, Some(&catalog));
        assert_eq!(enriched.limits.context, 200_000);
        assert_eq!(enriched.limits.output, 16_384);
        assert!(!enriched.capabilities.reasoning);
    }

    #[test]
    fn a_live_stub_listed_before_the_catalog_knew_the_model_still_takes_images() {
        // Discovered while models.dev had no entry: a text-only stub.
        let registry = ProviderRegistry::new();
        let mut stub = fallback_model_info("opencode-go", "space-bunny-free");
        stub.capabilities.vision = false;
        stub.capabilities.input_modalities = vec!["text".into()];
        registry.replace_runtime_models("opencode-go", vec![stub]);

        let catalog = ModelCatalog::parse_json(
            r#"{
              "opencode-go": {
                "id": "opencode-go",
                "name": "OpenCode Go",
                "models": {
                  "space-bunny-free": {
                    "id": "space-bunny-free",
                    "name": "Space Bunny Free",
                    "tool_call": true,
                    "attachment": true,
                    "modalities": { "input": ["text", "image", "video"], "output": ["text"] },
                    "limit": { "context": 1048576, "output": 524288 }
                  }
                }
              }
            }"#,
        )
        .unwrap();

        let info = resolve_model_info(&registry, Some(&catalog), "opencode-go", "space-bunny-free");
        use crate::media::{model_accepts, AttachmentKind};
        assert!(info.capabilities.vision);
        assert!(model_accepts(&info, AttachmentKind::Image));
        assert!(model_accepts(&info, AttachmentKind::Video));
        assert!(!model_accepts(&info, AttachmentKind::Audio));
    }
}
