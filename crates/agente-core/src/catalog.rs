//! Model catalog from [models.dev](https://models.dev/api.json).
//!
//! models.dev uses **flat** model fields (`reasoning`, `tool_call`, `limit.context`).
//! We normalize into nested `CatalogModel` / `ModelCapabilities` for the rest of the app.
//! Same source pi uses at codegen time — we parse at runtime instead.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

/// Model capabilities from external catalog
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ModelCapabilities {
    #[serde(default)]
    pub temperature: bool,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub attachment: bool,
    #[serde(default)]
    pub toolcall: bool,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub streaming: bool,
    /// Input modalities the model accepts (`text`, `image`, `audio`,
    /// `video`, `pdf`; OpenRouter says `file` for PDFs). Empty = unknown.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_modalities: Vec<String>,
}

/// models.dev `reasoning_options` entry — authoritative thinking UI/wire metadata.
/// Never invent levels; only values present here may be cycled or sent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReasoningOption {
    Toggle,
    Effort {
        /// Exact catalog tokens, e.g. `"high"`, `"max"`, `"minimal"`.
        #[serde(default)]
        values: Vec<String>,
    },
    BudgetTokens {
        /// models.dev sometimes sends `-1` as “unbounded” — treat as None.
        #[serde(default, deserialize_with = "deserialize_opt_u32_nonneg")]
        min: Option<u32>,
        #[serde(default, deserialize_with = "deserialize_opt_u32_nonneg")]
        max: Option<u32>,
    },
    /// OpenRouter's live `/models` reasoning object. A present null
    /// `supported_efforts` means all gateway effort values are accepted;
    /// an omitted reasoning object is represented by no option at all.
    OpenRouter {
        /// True when the API included the `supported_efforts` key. This
        /// distinguishes an omitted selector from an explicit JSON null.
        #[serde(default)]
        effort_selectable: bool,
        #[serde(default)]
        supported_efforts: Option<Vec<String>>,
        #[serde(default)]
        default_effort: Option<String>,
        #[serde(default)]
        default_enabled: Option<bool>,
        #[serde(default)]
        mandatory: bool,
        #[serde(default)]
        supports_max_tokens: bool,
    },
    /// A llama-server's chat template, read from `/props`.
    LlamaCpp {
        /// The server takes per-request thinking control
        /// (`chat_template_kwargs.enable_thinking`, `thinking_budget_tokens`);
        /// older servers only switch thinking on or off.
        #[serde(default)]
        per_request: bool,
        /// The template reads `reasoning_effort`
        /// (`chat_template_caps.supports_reasoning_effort`).
        #[serde(default)]
        effort_kwarg: bool,
    },
}

/// Deserialize `Option<u32>`, mapping null / missing / negative → `None`.
/// models.dev uses `-1` as a sentinel for unbounded budget tokens.
fn deserialize_opt_u32_nonneg<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Option::<i64>::deserialize(deserializer)?;
    Ok(match v {
        None => None,
        Some(n) if n < 0 => None,
        Some(n) => Some(n as u32),
    })
}

/// Model cost information
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ModelCost {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(default)]
    pub cache_read: f64,
    #[serde(default)]
    pub cache_write: f64,
    /// Context-size price tiers (models.dev `tiers`): once a request's
    /// prompt exceeds a tier's size, the whole call bills at that tier's
    /// rates (e.g. MiniMax-M3 past 512k, gpt-5.4 past 272k).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiers: Vec<CostTier>,
}

/// One context-size price tier.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CostTier {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(default)]
    pub cache_read: f64,
    #[serde(default)]
    pub cache_write: f64,
    /// `{ "type": "context", "size": 272000 }`.
    #[serde(default)]
    pub tier: TierBound,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct TierBound {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub size: u64,
}

impl ModelCost {
    /// Whether the catalog knows any price for this model. Free and unknown
    /// models report all zeros; callers show no cost rather than `$0.00`.
    pub fn is_priced(&self) -> bool {
        self.input > 0.0 || self.output > 0.0
    }

    /// USD cost of one call. Rates are per million tokens and each count is
    /// its own bucket (uncached input, output, cache reads, cache writes).
    ///
    /// When a catalog omits a cache rate, that token is billed at the base
    /// input rate. That is the neutral assumption, not an Anthropic-ism:
    /// only the Anthropic family sells a cache *write* as a distinct product
    /// (1.25× for 5 minutes, 2× for an hour) and models.dev already publishes
    /// `cache_write` for those models. DeepSeek, GLM, OpenCode Go and OpenAI
    /// cache prefixes automatically with no write charge at all — their
    /// misses are ordinary input — so inventing a multiplier here would
    /// overcharge every one of them.
    ///
    /// The request's whole prompt (input + cache read + cache write) picks
    /// the context tier: past a tier's size every bucket bills at its rates.
    pub fn cost_usd(&self, input: u32, output: u32, cache_read: u32, cache_write: u32) -> f64 {
        let prompt = u64::from(input) + u64::from(cache_read) + u64::from(cache_write);
        let tier = self
            .tiers
            .iter()
            .filter(|t| t.tier.kind.is_empty() || t.tier.kind == "context")
            .filter(|t| t.tier.size > 0 && prompt > t.tier.size)
            .max_by_key(|t| t.tier.size);
        let (rate_in, rate_out, rate_read, rate_write) = match tier {
            Some(t) => (t.input, t.output, t.cache_read, t.cache_write),
            None => (self.input, self.output, self.cache_read, self.cache_write),
        };
        let read_rate = if rate_read > 0.0 { rate_read } else { rate_in };
        let write_rate = if rate_write > 0.0 {
            rate_write
        } else {
            rate_in
        };
        (f64::from(input) * rate_in
            + f64::from(output) * rate_out
            + f64::from(cache_read) * read_rate
            + f64::from(cache_write) * write_rate)
            / 1_000_000.0
    }

    /// What one call cost, and whose number it is.
    ///
    /// The one place the rule lives: a provider that reports its own charge
    /// wins (it is the bill), otherwise the catalog price is our estimate. The
    /// flag is what the UIs print as `~`, so it has to mean exactly "this
    /// number is ours" — `true` with no price when the model is unpriced at
    /// all, which the UIs show as `+`. Subagent calls, compaction checkpoints
    /// and main-loop calls all price through here.
    pub fn call_cost(
        &self,
        reported: Option<f64>,
        input: u32,
        output: u32,
        cache_read: u32,
        cache_write: u32,
    ) -> (Option<f64>, bool) {
        match reported {
            Some(cost) if cost.is_finite() => (Some(cost), false),
            Some(_) => (None, true),
            None => (
                self.is_priced()
                    .then(|| self.cost_usd(input, output, cache_read, cache_write)),
                true,
            ),
        }
    }
}

/// Model limits (context window, max tokens)
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ModelLimits {
    #[serde(default, deserialize_with = "deserialize_u32_nonneg")]
    pub context: u32,
    #[serde(default, deserialize_with = "deserialize_opt_u32_nonneg")]
    pub input: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_u32_nonneg")]
    pub output: u32,
}

/// Deserialize u32, mapping null / missing / negative → 0.
fn deserialize_u32_nonneg<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Option::<i64>::deserialize(deserializer)?;
    Ok(match v {
        None => 0,
        Some(n) if n < 0 => 0,
        Some(n) => n as u32,
    })
}

/// Model status
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelStatus {
    #[default]
    Active,
    Alpha,
    Beta,
    Deprecated,
}

/// External model definition (normalized internal shape)
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ModelProvider {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm: Option<String>,
    /// Optional native transport override for configured models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<String>,
}

/// External model definition (normalized internal shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    #[serde(default, rename = "providerID", alias = "provider_id")]
    pub provider_id: String,
    pub name: String,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub capabilities: ModelCapabilities,
    #[serde(default)]
    pub cost: ModelCost,
    #[serde(default)]
    pub limit: ModelLimits,
    #[serde(default)]
    pub status: ModelStatus,
    #[serde(default)]
    pub api_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ModelProvider>,
    /// From models.dev `reasoning_options` — source of thinking levels.
    #[serde(default)]
    pub reasoning_options: Vec<ReasoningOption>,
    /// Stream field for interleaved reasoning, e.g. `reasoning_content`.
    #[serde(default)]
    pub reasoning_stream_field: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub options: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub variants: HashMap<String, HashMap<String, serde_json::Value>>,
}

/// External provider definition from catalog
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogProvider {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub api: String,
    #[serde(default)]
    pub npm: String,
    #[serde(default)]
    pub models: HashMap<String, CatalogModel>,
    #[serde(default)]
    pub whitelist: Vec<String>,
    #[serde(default)]
    pub blacklist: Vec<String>,
}

/// Full model catalog
#[derive(Debug, Clone, Serialize, Default)]
pub struct ModelCatalog {
    #[serde(flatten)]
    pub providers: HashMap<String, CatalogProvider>,
}

// ── models.dev wire format (flat model fields) ─────────────────────────

#[derive(Debug, Deserialize)]
struct RawCatalog {
    #[serde(flatten)]
    providers: HashMap<String, RawProvider>,
}

#[derive(Debug, Deserialize)]
struct RawProvider {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    api: Option<String>,
    #[serde(default)]
    npm: Option<String>,
    #[serde(default)]
    models: HashMap<String, RawModel>,
    #[serde(default)]
    whitelist: Vec<String>,
    #[serde(default)]
    blacklist: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawModel {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    family: Option<String>,
    /// models.dev flat fields
    #[serde(default)]
    reasoning: Option<bool>,
    #[serde(default)]
    tool_call: Option<bool>,
    #[serde(default)]
    attachment: Option<bool>,
    #[serde(default)]
    temperature: Option<bool>,
    /// Nested shape (our cache / hand-written fixtures)
    #[serde(default)]
    capabilities: Option<ModelCapabilities>,
    #[serde(default)]
    cost: Option<ModelCost>,
    #[serde(default)]
    limit: Option<ModelLimits>,
    #[serde(default)]
    status: Option<FlexibleStatus>,
    #[serde(default)]
    modalities: Option<RawModalities>,
    #[serde(default)]
    reasoning_options: Vec<RawReasoningOption>,
    /// Nested shape when loading our own cache
    #[serde(default)]
    reasoning_stream_field: Option<String>,
    /// models.dev: either `{ "field": "reasoning_content" }` or bare `true`.
    #[serde(default, deserialize_with = "deserialize_interleaved")]
    interleaved: Option<RawInterleaved>,
    #[serde(default, rename = "providerID", alias = "provider_id")]
    provider_id: Option<String>,
    #[serde(default)]
    api_id: Option<String>,
    #[serde(default)]
    provider: Option<ModelProvider>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    options: HashMap<String, serde_json::Value>,
    #[serde(default)]
    variants: HashMap<String, HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize, Default)]
struct RawInterleaved {
    #[serde(default)]
    field: Option<String>,
}

/// Accept `interleaved: true` | `{ "field": "..." }` | null.
fn deserialize_interleaved<'de, D>(deserializer: D) -> Result<Option<RawInterleaved>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match v {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Bool(true)) => Some(RawInterleaved { field: None }),
        Some(serde_json::Value::Bool(false)) => None,
        Some(serde_json::Value::String(field)) => Some(RawInterleaved { field: Some(field) }),
        Some(serde_json::Value::Object(map)) => {
            let field = map
                .get("field")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            Some(RawInterleaved { field })
        }
        Some(_) => Some(RawInterleaved { field: None }),
    })
}

/// Wire form of models.dev reasoning_options (tag on `type`).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RawReasoningOption {
    Toggle,
    Effort {
        #[serde(default)]
        values: Vec<serde_json::Value>,
    },
    BudgetTokens {
        #[serde(default, deserialize_with = "deserialize_opt_u32_nonneg")]
        min: Option<u32>,
        #[serde(default, deserialize_with = "deserialize_opt_u32_nonneg")]
        max: Option<u32>,
    },
    OpenRouter {
        #[serde(default)]
        effort_selectable: bool,
        #[serde(default)]
        supported_efforts: Option<Vec<String>>,
        #[serde(default)]
        default_effort: Option<String>,
        #[serde(default)]
        default_enabled: Option<bool>,
        #[serde(default)]
        mandatory: bool,
        #[serde(default)]
        supports_max_tokens: bool,
    },
}

impl RawReasoningOption {
    fn into_option(self) -> ReasoningOption {
        match self {
            RawReasoningOption::Toggle => ReasoningOption::Toggle,
            RawReasoningOption::Effort { values } => ReasoningOption::Effort {
                values: values
                    .into_iter()
                    .filter_map(|v| match v {
                        serde_json::Value::String(s) if !s.is_empty() => Some(s),
                        serde_json::Value::Null => Some("none".to_string()),
                        other => other.as_str().map(|s| s.to_string()),
                    })
                    .collect(),
            },
            RawReasoningOption::BudgetTokens { min, max } => {
                ReasoningOption::BudgetTokens { min, max }
            }
            RawReasoningOption::OpenRouter {
                effort_selectable,
                supported_efforts,
                default_effort,
                default_enabled,
                mandatory,
                supports_max_tokens,
            } => ReasoningOption::OpenRouter {
                effort_selectable,
                supported_efforts,
                default_effort,
                default_enabled,
                mandatory,
                supports_max_tokens,
            },
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct RawModalities {
    #[serde(default)]
    input: Vec<String>,
}

/// Accept models.dev status strings and our enum forms.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FlexibleStatus {
    Str(String),
    Enum(ModelStatus),
}

impl FlexibleStatus {
    fn into_status(self) -> ModelStatus {
        match self {
            FlexibleStatus::Enum(s) => s,
            FlexibleStatus::Str(s) => match s.to_ascii_lowercase().as_str() {
                "alpha" => ModelStatus::Alpha,
                "beta" => ModelStatus::Beta,
                "deprecated" => ModelStatus::Deprecated,
                _ => ModelStatus::Active,
            },
        }
    }
}

impl RawModel {
    fn into_catalog_model(self, provider_id: &str, model_key: &str) -> CatalogModel {
        let id = self
            .id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| model_key.to_string());
        let name = self
            .name
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| id.clone());
        let api_id = self
            .api_id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| id.clone());
        let provider_id = self
            .provider_id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| provider_id.to_string());

        let reasoning_options: Vec<ReasoningOption> = self
            .reasoning_options
            .into_iter()
            .map(RawReasoningOption::into_option)
            .collect();

        let reasoning_stream_field = self
            .reasoning_stream_field
            .filter(|s| !s.is_empty())
            .or_else(|| {
                self.interleaved
                    .and_then(|i| i.field)
                    .filter(|s| !s.is_empty())
            });

        let capabilities = if let Some(mut caps) = self.capabilities {
            // Nested cache may omit reasoning flag; keep catalog bool if set.
            if let Some(r) = self.reasoning {
                caps.reasoning = r;
            }
            if caps.input_modalities.is_empty() {
                if let Some(modalities) = &self.modalities {
                    caps.input_modalities = modalities
                        .input
                        .iter()
                        .map(|m| m.to_ascii_lowercase())
                        .collect();
                }
            }
            caps
        } else {
            let modalities = self.modalities.unwrap_or_default();
            let vision = modalities.input.iter().any(|m| {
                let m = m.to_ascii_lowercase();
                m == "image" || m == "pdf" || m == "video" || m == "audio"
            });
            ModelCapabilities {
                temperature: self.temperature.unwrap_or(true),
                reasoning: self.reasoning.unwrap_or(false),
                attachment: self.attachment.unwrap_or(false),
                toolcall: self.tool_call.unwrap_or(false),
                vision,
                streaming: true,
                input_modalities: modalities
                    .input
                    .iter()
                    .map(|m| m.to_ascii_lowercase())
                    .collect(),
            }
        };

        let limit = self.limit.unwrap_or_default();
        let status = self
            .status
            .map(FlexibleStatus::into_status)
            .unwrap_or_default();

        CatalogModel {
            id,
            provider_id,
            name,
            family: self.family,
            capabilities,
            cost: self.cost.unwrap_or_default(),
            limit,
            status,
            api_id,
            provider: self.provider,
            reasoning_options,
            reasoning_stream_field,
            headers: self.headers,
            options: self.options,
            variants: self.variants,
        }
    }
}

impl ModelCatalog {
    /// Parse models.dev (or our normalized cache) JSON text.
    pub fn parse_json(text: &str) -> anyhow::Result<Self> {
        let raw: RawCatalog = serde_json::from_str(text)
            .map_err(|e| anyhow::anyhow!("models.dev catalog deserialize failed: {e}"))?;
        Ok(Self::from_raw(raw))
    }

    /// Parse from already-decoded JSON value.
    pub fn from_value(value: serde_json::Value) -> anyhow::Result<Self> {
        let raw: RawCatalog = serde_json::from_value(value)
            .map_err(|e| anyhow::anyhow!("models.dev catalog deserialize failed: {e}"))?;
        Ok(Self::from_raw(raw))
    }

    fn from_raw(raw: RawCatalog) -> Self {
        let mut providers = HashMap::new();
        for (provider_key, raw_provider) in raw.providers {
            let provider_id = raw_provider
                .id
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| provider_key.clone());
            let name = raw_provider
                .name
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| provider_id.clone());
            let models = raw_provider
                .models
                .into_iter()
                .map(|(model_key, raw_model)| {
                    let model = raw_model.into_catalog_model(&provider_id, &model_key);
                    (model_key, model)
                })
                .collect();

            providers.insert(
                provider_key,
                CatalogProvider {
                    id: provider_id,
                    name,
                    env: raw_provider.env,
                    api: raw_provider.api.unwrap_or_default(),
                    npm: raw_provider.npm.unwrap_or_default(),
                    models,
                    whitelist: raw_provider.whitelist,
                    blacklist: raw_provider.blacklist,
                },
            );
        }
        Self { providers }
    }

    pub async fn fetch() -> anyhow::Result<Self> {
        let url = std::env::var("AGENTE_MODELS_URL")
            .unwrap_or_else(|_| "https://models.dev/api.json".to_string());

        // models.dev (and many CDNs) return 403 without a browser-like UA.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .user_agent("agente/0.1 (+https://github.com/agente; models.dev catalog)")
            .build()?;
        let response = client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "Failed to fetch model catalog: {}",
                response.status()
            ));
        }

        let text = response.text().await?;
        let catalog = Self::parse_json(&text)?;
        tracing::info!(
            providers = catalog.providers.len(),
            models = catalog.model_count(),
            reasoning_options = catalog.reasoning_options_count(),
            "Loaded models.dev catalog"
        );
        if catalog.reasoning_options_count() == 0 {
            return Err(anyhow::anyhow!(
                "models.dev catalog parsed but has zero reasoning_options — refusing to cache"
            ));
        }
        Ok(catalog)
    }

    pub fn model_count(&self) -> usize {
        self.providers.values().map(|p| p.models.len()).sum()
    }

    /// Count models that have non-empty `reasoning_options` (thinking catalog).
    pub fn reasoning_options_count(&self) -> usize {
        self.providers
            .values()
            .flat_map(|p| p.models.values())
            .filter(|m| !m.reasoning_options.is_empty())
            .count()
    }

    /// Count models marked `capabilities.reasoning`.
    pub fn reasoning_model_count(&self) -> usize {
        self.providers
            .values()
            .flat_map(|p| p.models.values())
            .filter(|m| m.capabilities.reasoning)
            .count()
    }

    /// True when the cache was written before we stored `reasoning_options`
    /// (many reasoning models, zero option lists) — must re-fetch models.dev.
    pub fn is_stale_for_thinking(&self) -> bool {
        let reasoning = self.reasoning_model_count();
        let with_opts = self.reasoning_options_count();
        // Live models.dev has thousands of reasoning models with options.
        // A cache with reasoning flags but no options is pre-thinking-catalog.
        reasoning >= 20 && with_opts == 0
    }

    /// Delete on-disk catalog so the next load re-fetches.
    pub fn invalidate_cache() {
        if let Some(path) = Self::cache_path() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Look up a model by provider + id (and common id variants).
    pub fn find_model(&self, provider_id: &str, model_id: &str) -> Option<&CatalogModel> {
        let provider_id = crate::providers::spec::catalog_id(provider_id);
        if let Some(provider) = self
            .providers
            .get(provider_id)
            .or_else(|| self.providers.values().find(|p| p.id == provider_id))
        {
            if let Some(m) = Self::find_in_provider(provider, model_id) {
                return Some(m);
            }
        }
        // A shared model name does not imply the same host API or controls.
        None
    }

    /// Every model models.dev records for a provider — retired ones included,
    /// with their status — sorted by id. Pickers go through
    /// [`crate::models::catalog_extras`], which drops the retired ones.
    pub fn provider_models(&self, provider_id: &str) -> Vec<&CatalogModel> {
        let provider_id = crate::providers::spec::catalog_id(provider_id);
        let Some(provider) = self
            .providers
            .get(provider_id)
            .or_else(|| self.providers.values().find(|p| p.id == provider_id))
        else {
            return Vec::new();
        };
        let mut models: Vec<&CatalogModel> = provider.models.values().collect();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        models
    }

    fn find_in_provider<'a>(
        provider: &'a CatalogProvider,
        model_id: &str,
    ) -> Option<&'a CatalogModel> {
        if let Some(m) = provider.models.get(model_id) {
            return Some(m);
        }
        if let Some(m) = provider
            .models
            .values()
            .find(|m| m.id == model_id || m.api_id == model_id)
        {
            return Some(m);
        }
        if let Some((_, bare)) = model_id.split_once('/') {
            if let Some(m) = provider.models.get(bare) {
                return Some(m);
            }
            if let Some(m) = provider
                .models
                .values()
                .find(|m| m.id == bare || m.api_id == bare)
            {
                return Some(m);
            }
        }
        let prefixed = format!("{}/{}", provider.id, model_id);
        provider.models.get(&prefixed)
    }

    /// Limits of the nearest sibling of a model the catalog has not heard of:
    /// the same id once minor versions are dropped (`deepseek-v4.1-flash` →
    /// `deepseek-v4-flash`). A point release keeps its family's window; the
    /// 32k default would otherwise make a 1M-token model look permanently full.
    pub fn find_family_limits(&self, provider_id: &str, model_id: &str) -> Option<ModelLimits> {
        let provider_id = crate::providers::spec::catalog_id(provider_id);
        let provider = self
            .providers
            .get(provider_id)
            .or_else(|| self.providers.values().find(|p| p.id == provider_id))?;
        let wanted = family_key(model_id);
        provider
            .models
            .values()
            .find(|m| family_key(&m.id) == wanted)
            .map(|m| m.limit.clone())
    }

    /// How long the on-disk catalog is trusted before a background refresh.
    pub const CACHE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

    /// Age of the on-disk catalog, `None` when there is none.
    pub fn cache_age() -> Option<std::time::Duration> {
        let modified = std::fs::metadata(Self::cache_path()?)
            .ok()?
            .modified()
            .ok()?;
        Some(modified.elapsed().unwrap_or_default())
    }

    /// Refresh the on-disk catalog in the background when it is older than
    /// [`Self::CACHE_MAX_AGE`]. The running process keeps the copy it loaded;
    /// the next launch (or Ctrl+R) sees the fresh one. At most once per process.
    pub fn refresh_cache_if_stale() {
        static STARTED: std::sync::Once = std::sync::Once::new();
        if cfg!(test) || Self::cache_age().is_some_and(|age| age < Self::CACHE_MAX_AGE) {
            return;
        }
        STARTED.call_once(|| {
            let spawned = std::thread::Builder::new()
                .name("models-dev-refresh".into())
                .spawn(|| {
                    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    else {
                        return;
                    };
                    match runtime.block_on(Self::fetch()) {
                        Ok(catalog) => {
                            if let Err(error) = catalog.save_to_cache() {
                                tracing::warn!(%error, "models.dev refresh not cached");
                            }
                        }
                        Err(error) => tracing::warn!(%error, "models.dev refresh failed"),
                    }
                });
            if let Err(error) = spawned {
                tracing::warn!(%error, "models.dev refresh thread not started");
            }
        });
    }

    pub fn load_from_cache() -> Option<Self> {
        let path = Self::cache_path()?;
        let content = std::fs::read_to_string(&path).ok()?;
        match Self::parse_json(&content) {
            Ok(catalog) => {
                if catalog.providers.is_empty() {
                    tracing::warn!(path = %path.display(), "Cached model catalog is empty");
                    None
                } else {
                    Some(catalog)
                }
            }
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "Failed to parse cached model catalog"
                );
                None
            }
        }
    }

    pub fn save_to_cache(&self) -> anyhow::Result<()> {
        let path = Self::cache_path()
            .ok_or_else(|| anyhow::anyhow!("no cache directory available for model catalog"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Compact JSON — models.dev is multi-MB; pretty doubles size.
        let content = serde_json::to_string(self)?;
        std::fs::write(&path, content)?;
        Ok(())
    }

    fn cache_path() -> Option<std::path::PathBuf> {
        // v2 retains per-model transport overrides and null effort values.
        // Old normalized caches have already discarded that information.
        dirs::cache_dir().map(|d| d.join("agente").join("models-v2.json"))
    }
}

impl<'de> Deserialize<'de> for ModelCatalog {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawCatalog::deserialize(deserializer)?;
        Ok(Self::from_raw(raw))
    }
}

/// Last-resort context when catalog and live API both omit a window.
pub const DEFAULT_CONTEXT_WINDOW: u32 = 128_000;
pub const DEFAULT_OUTPUT_TOKENS: u32 = 8_192;

/// Build runtime model limits, never leaving context at 0 for UI/compaction.
pub fn effective_limits(limit: &ModelLimits) -> ModelLimits {
    ModelLimits {
        context: if limit.context > 0 {
            limit.context
        } else {
            DEFAULT_CONTEXT_WINDOW
        },
        input: limit.input,
        output: if limit.output > 0 {
            limit.output
        } else {
            DEFAULT_OUTPUT_TOKENS
        },
    }
}

/// An id with its minor versions dropped: `deepseek-v4.1-flash` and
/// `deepseek-v4-flash` share one key.
fn family_key(model_id: &str) -> String {
    let bare = model_id
        .rsplit('/')
        .next()
        .unwrap_or(model_id)
        .to_lowercase();
    let mut out = String::with_capacity(bare.len());
    let mut chars = bare.chars().peekable();
    let mut prev_digit = false;
    while let Some(c) = chars.next() {
        if c == '.' && prev_digit && chars.peek().is_some_and(|n| n.is_ascii_digit()) {
            while chars.peek().is_some_and(|n| n.is_ascii_digit()) {
                chars.next();
            }
            prev_digit = false;
            continue;
        }
        prev_digit = c.is_ascii_digit();
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_reported_charge_wins_over_the_catalog_price() {
        let cost = super::ModelCost {
            input: 2.0,
            output: 8.0,
            ..Default::default()
        };
        // The provider's own charge: not an estimate.
        assert_eq!(
            cost.call_cost(Some(0.25), 1_000_000, 0, 0, 0),
            (Some(0.25), false)
        );
        // No charge reported: our catalog price, flagged as an estimate.
        let (estimate, estimated) = cost.call_cost(None, 1_000_000, 0, 0, 0);
        assert!(estimated);
        assert!((estimate.unwrap() - 2.0).abs() < 1e-9);
        // Unpriced model: nothing to show, and the flag says why.
        assert_eq!(
            super::ModelCost::default().call_cost(None, 10, 10, 0, 0),
            (None, true)
        );
        // A provider that reports a non-finite charge is not a price.
        assert_eq!(cost.call_cost(Some(f64::NAN), 10, 10, 0, 0), (None, true));
    }

    #[test]
    fn call_cost_prices_each_token_bucket() {
        let cost = super::ModelCost {
            input: 2.0,
            output: 8.0,
            cache_read: 0.2,
            cache_write: 0.0,
            tiers: Vec::new(),
        };
        // 1M uncached in, 0.5M out, 2M cache reads, 1M writes. With no write
        // rate published, writes bill at base input: 2.0, not a premium.
        let usd = cost.cost_usd(1_000_000, 500_000, 2_000_000, 1_000_000);
        assert!((usd - (2.0 + 4.0 + 0.4 + 2.0)).abs() < 1e-9, "{usd}");
        assert!(!super::ModelCost::default().is_priced());
    }

    #[test]
    fn a_published_write_rate_wins_and_a_missing_one_is_base_input() {
        // Anthropic-family entries publish a premium write rate.
        let priced = super::ModelCost {
            input: 2.0,
            output: 8.0,
            cache_write: 2.5,
            tiers: Vec::new(),
            ..Default::default()
        };
        assert!((priced.cost_usd(0, 0, 0, 1_000_000) - 2.5).abs() < 1e-9);
        // DeepSeek/GLM/Go publish none: a write is an ordinary input token.
        let neutral = super::ModelCost {
            input: 2.0,
            ..Default::default()
        };
        assert!((neutral.cost_usd(0, 0, 0, 1_000_000) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn long_prompts_bill_at_the_models_dev_context_tier() {
        // MiniMax-M3 as models.dev lists it.
        let cost: super::ModelCost = serde_json::from_value(serde_json::json!({
            "input": 0.3, "output": 1.2, "cache_read": 0.06,
            "tiers": [{"input": 0.6, "output": 2.4, "cache_read": 0.12,
                       "tier": {"type": "context", "size": 512000}}],
            "context_over_200k": {"input": 0.6}
        }))
        .unwrap();
        let short = cost.cost_usd(100_000, 1_000_000, 0, 0);
        assert!((short - (0.03 + 1.2)).abs() < 1e-9, "{short}");
        // 600k prompt (cached mostly): past 512k, everything at tier rates.
        let long = cost.cost_usd(100_000, 1_000_000, 500_000, 0);
        assert!((long - (0.06 + 2.4 + 0.06)).abs() < 1e-9, "{long}");
    }

    use super::*;

    const FIXTURE: &str = r#"{
      "deepseek": {
        "id": "deepseek",
        "env": ["DEEPSEEK_API_KEY"],
        "npm": "@ai-sdk/openai-compatible",
        "api": "https://api.deepseek.com",
        "name": "DeepSeek",
        "models": {
          "deepseek-v4-flash": {
            "id": "deepseek-v4-flash",
            "name": "DeepSeek V4 Flash",
            "family": "deepseek-flash",
            "attachment": false,
            "reasoning": true,
            "reasoning_options": [
              { "type": "toggle" },
              { "type": "effort", "values": ["high", "max"] }
            ],
            "interleaved": { "field": "reasoning_content" },
            "tool_call": true,
            "temperature": true,
            "modalities": { "input": ["text"], "output": ["text"] },
            "limit": { "context": 1000000, "output": 384000 },
            "cost": { "input": 0.14, "output": 0.28, "cache_read": 0.028 }
          },
          "deepseek-chat": {
            "id": "deepseek-chat",
            "name": "DeepSeek Chat",
            "reasoning": false,
            "tool_call": true,
            "limit": { "context": 1000000, "output": 8192 }
          }
        }
      },
      "openai": {
        "id": "openai",
        "name": "OpenAI",
        "api": "https://api.openai.com/v1",
        "env": ["OPENAI_API_KEY"],
        "npm": "@ai-sdk/openai",
        "models": {
          "gpt-4o": {
            "id": "gpt-4o",
            "name": "GPT-4o",
            "attachment": true,
            "reasoning": false,
            "tool_call": true,
            "temperature": true,
            "modalities": { "input": ["text", "image"], "output": ["text"] },
            "limit": { "context": 128000, "output": 16384 },
            "cost": { "input": 2.5, "output": 10 }
          },
          "missing-cost": {
            "id": "missing-cost",
            "name": "No Cost Model",
            "reasoning": false,
            "tool_call": true,
            "limit": { "context": 32000, "output": 4096 },
            "status": "deprecated"
          }
        }
      }
    }"#;

    #[test]
    fn point_release_inherits_its_familys_window() {
        let catalog = ModelCatalog::parse_json(FIXTURE).expect("parse fixture");
        let limits = catalog
            .find_family_limits("deepseek", "deepseek-v4.1-flash")
            .expect("sibling");
        assert_eq!(limits.context, 1_000_000);
        assert!(catalog
            .find_family_limits("deepseek", "deepseek-v5-flash")
            .is_none());
        assert_eq!(
            family_key("deepseek/deepseek-v4.1-flash"),
            "deepseek-v4-flash"
        );
        assert_eq!(family_key("gpt-4.1-mini"), "gpt-4-mini");
    }

    #[test]
    fn parses_models_dev_flat_schema() {
        let catalog = ModelCatalog::parse_json(FIXTURE).expect("parse fixture");
        assert_eq!(catalog.providers.len(), 2);
        assert_eq!(catalog.model_count(), 4);

        let flash = catalog
            .find_model("deepseek", "deepseek-v4-flash")
            .expect("deepseek-v4-flash");
        assert_eq!(flash.limit.context, 1_000_000);
        assert_eq!(flash.limit.output, 384_000);
        assert!(flash.capabilities.reasoning);
        assert!(flash.capabilities.toolcall);
        assert!(!flash.capabilities.vision);
        assert_eq!(flash.provider_id, "deepseek");
        assert_eq!(flash.name, "DeepSeek V4 Flash");
        assert_eq!(
            flash.reasoning_options,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into(), "max".into()]
                },
            ]
        );
        assert_eq!(
            flash.reasoning_stream_field.as_deref(),
            Some("reasoning_content")
        );

        let gpt = catalog.find_model("openai", "gpt-4o").expect("gpt-4o");
        assert_eq!(gpt.limit.context, 128_000);
        assert!(gpt.capabilities.vision);
        assert!(!gpt.capabilities.reasoning);

        let bare = catalog
            .find_model("deepseek", "deepseek/deepseek-v4-flash")
            .expect("prefixed lookup");
        assert_eq!(bare.id, "deepseek-v4-flash");

        let no_cost = catalog
            .find_model("openai", "missing-cost")
            .expect("missing-cost");
        assert_eq!(no_cost.cost.input, 0.0);
        assert_eq!(no_cost.status, ModelStatus::Deprecated);
        assert_eq!(no_cost.limit.context, 32_000);
    }

    #[test]
    fn roundtrip_normalized_cache() {
        let catalog = ModelCatalog::parse_json(FIXTURE).unwrap();
        let json = serde_json::to_string(&catalog).unwrap();
        let again = ModelCatalog::parse_json(&json).unwrap();
        let flash = again.find_model("deepseek", "deepseek-v4-flash").unwrap();
        assert_eq!(flash.limit.context, 1_000_000);
        assert!(flash.capabilities.reasoning);
    }

    #[test]
    fn effective_limits_patches_zero() {
        let lim = effective_limits(&ModelLimits {
            context: 0,
            input: None,
            output: 0,
        });
        assert_eq!(lim.context, DEFAULT_CONTEXT_WINDOW);
        assert_eq!(lim.output, DEFAULT_OUTPUT_TOKENS);
    }

    #[test]
    fn accepts_negative_budget_tokens_sentinel() {
        // models.dev uses -1 for unbounded (e.g. nvidia nemotron budget min).
        let json = r#"{
          "nvidia": {
            "id": "nvidia",
            "name": "NVIDIA",
            "api": "https://example.com",
            "models": {
              "test": {
                "id": "test",
                "name": "Test",
                "reasoning": true,
                "reasoning_options": [
                  { "type": "toggle" },
                  { "type": "budget_tokens", "min": -1, "max": 8192 }
                ],
                "limit": { "context": 128000, "output": -1 }
              }
            }
          }
        }"#;
        let catalog = ModelCatalog::parse_json(json).expect("should accept -1 sentinels");
        let m = catalog.find_model("nvidia", "test").unwrap();
        assert_eq!(m.limit.output, 0); // -1 → 0
        match &m.reasoning_options[..] {
            [ReasoningOption::Toggle, ReasoningOption::BudgetTokens { min, max }] => {
                assert_eq!(*min, None); // -1 → None
                assert_eq!(*max, Some(8192));
            }
            other => panic!("unexpected options: {other:?}"),
        }
    }
}
