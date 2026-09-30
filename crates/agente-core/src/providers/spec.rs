//! Provider specs — one TOML file per provider in `crates/agente-core/providers/`.
//!
//! A spec is everything the core needs to talk to a provider without code:
//! endpoint, wire format, key variables, where its model list comes from and
//! which thinking request shape it speaks. The TUI reads the specs directly;
//! Agente Desktop reads them through the daemon (`providers.list`). Adding a
//! provider is adding a file here and to [`SOURCES`].

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::{ApiFormat, ModelInfo};
use crate::catalog::ReasoningOption;
use crate::thinking::ThinkingFormat;

/// Embedded spec files. Order is irrelevant; ids must be unique.
const SOURCES: &[(&str, &str)] = &[
    ("custom", include_str!("../../providers/custom.toml")),
    ("deepseek", include_str!("../../providers/deepseek.toml")),
    ("glm", include_str!("../../providers/glm.toml")),
    ("llamacpp", include_str!("../../providers/llamacpp.toml")),
    ("lmstudio", include_str!("../../providers/lmstudio.toml")),
    ("minimax", include_str!("../../providers/minimax.toml")),
    ("ollama", include_str!("../../providers/ollama.toml")),
    (
        "opencode-go",
        include_str!("../../providers/opencode-go.toml"),
    ),
    (
        "openrouter",
        include_str!("../../providers/openrouter.toml"),
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderGroup {
    Cloud,
    Local,
}

/// Where a provider's model list (and its live metadata) comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource {
    /// models.dev only.
    Catalog,
    /// OpenRouter's `/api/v1/models` — per-model `reasoning`, pricing, modalities.
    Openrouter,
    /// A plain OpenAI-style `/models` (ids); models.dev fills the metadata.
    OpenaiModels,
    /// llama-server: `/v1/models` plus `/props` for the chat template.
    Llamacpp,
}

/// The thinking request shape a spec declares. `auto` guesses from the base
/// URL (custom endpoints only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecThinking {
    Auto,
    Default,
    Deepseek,
    Qwen,
    Openrouter,
    Together,
    Antling,
    Llamacpp,
}

/// A model the spec knows about before discovery or models.dev answers.
/// Everything but `name` and `context` is optional fallback metadata, used
/// only where the provider and models.dev say nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedModel {
    pub name: String,
    pub context: u32,
    #[serde(default)]
    pub output: Option<u32>,
    /// Same shape as models.dev `reasoning_options`
    /// (`{ type = "effort", values = ["high", "max"] }`, `{ type = "toggle" }`, …).
    #[serde(default)]
    pub reasoning: Vec<ReasoningOption>,
    /// `text`, `image`, `audio`, `video`, `pdf`.
    #[serde(default)]
    pub input: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderSpec {
    pub id: String,
    pub name: String,
    pub group: ProviderGroup,
    pub base_url: String,
    pub api_format: String,
    #[serde(default)]
    pub env: Vec<String>,
    /// Other ids clients use for the same provider (`local` → `llamacpp`).
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Hosts that identify this provider from a pasted base URL.
    #[serde(default)]
    pub match_hosts: Vec<String>,
    #[serde(default)]
    pub key_check_path: Option<String>,
    /// Where a person creates an API key (shown as "Get a key").
    #[serde(default)]
    pub key_url: Option<String>,
    /// The provider's API docs.
    #[serde(default)]
    pub docs_url: Option<String>,
    /// An OpenAI chat-completions endpoint for clients that only speak that
    /// dialect (Agente Desktop's chat), when `base_url` is another format.
    #[serde(default)]
    pub openai_compatible_url: Option<String>,
    /// Position in provider lists (lower first); ties sort by id.
    #[serde(default = "default_order")]
    pub order: u32,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// models.dev provider key when it differs from `id`.
    #[serde(default)]
    pub catalog_id: Option<String>,
    pub models: ModelSource,
    pub thinking: SpecThinking,
    #[serde(default)]
    pub stream_usage: bool,
    /// Listed in connect dialogs and trusted by Agente Code on its own.
    #[serde(default)]
    pub offered: bool,
    /// Thinking controls for any model on this provider that neither the
    /// provider nor models.dev describes (models.dev `reasoning_options` shape).
    #[serde(default)]
    pub default_reasoning: Vec<ReasoningOption>,
    /// Offline fallback list until discovery or models.dev answers.
    #[serde(default)]
    pub models_seed: BTreeMap<String, SeedModel>,
}

impl ProviderSpec {
    pub fn api_format(&self) -> ApiFormat {
        ApiFormat::from_name(&self.api_format).unwrap_or_default()
    }

    /// models.dev key for this provider.
    pub fn catalog_id(&self) -> &str {
        self.catalog_id.as_deref().unwrap_or(&self.id)
    }

    /// The compat format this spec sends, `None` for `auto` (guess from URL).
    pub fn thinking_format(&self) -> Option<ThinkingFormat> {
        Some(match self.thinking {
            SpecThinking::Auto => return None,
            SpecThinking::Default => ThinkingFormat::Default,
            SpecThinking::Deepseek => ThinkingFormat::DeepSeek,
            SpecThinking::Qwen => ThinkingFormat::Qwen,
            SpecThinking::Openrouter => ThinkingFormat::OpenRouter,
            SpecThinking::Together => ThinkingFormat::Together,
            SpecThinking::Antling => ThinkingFormat::AntLing,
            SpecThinking::Llamacpp => ThinkingFormat::LlamaCpp,
        })
    }

    /// The built-in `ProviderConfig` this spec seeds `AppConfig` with.
    pub fn provider_config(&self) -> crate::config::ProviderConfig {
        use crate::catalog::ModelLimits;
        use crate::config::{ModelConfig, ProviderConfig, ProviderOptions};
        let mut extra = HashMap::new();
        if !self.headers.is_empty() {
            extra.insert("headers".to_string(), serde_json::json!(self.headers));
        }
        ProviderConfig {
            api: Some(self.base_url.clone()),
            name: Some(self.name.clone()),
            env: self.env.clone(),
            api_format: Some(self.api_format.clone()),
            options: ProviderOptions {
                base_url: Some(self.base_url.clone()),
                extra,
                ..Default::default()
            },
            models: self
                .models_seed
                .iter()
                .map(|(id, seed)| {
                    (
                        id.clone(),
                        ModelConfig {
                            name: Some(seed.name.clone()),
                            limit: Some(ModelLimits {
                                context: seed.context,
                                input: None,
                                output: seed.output.unwrap_or(8192),
                            }),
                            capabilities: seed.capabilities(id),
                            reasoning_options: seed.reasoning.clone(),
                            ..Default::default()
                        },
                    )
                })
                .collect(),
            ..Default::default()
        }
    }
}

impl SeedModel {
    /// Capabilities when the seed says anything beyond name and context;
    /// `None` keeps the usual inference from the model id.
    fn capabilities(&self, id: &str) -> Option<crate::catalog::ModelCapabilities> {
        if self.reasoning.is_empty() && self.input.is_empty() {
            return None;
        }
        let mut caps = super::inferred_service_model_capabilities(id);
        caps.reasoning |= !self.reasoning.is_empty();
        if !self.input.is_empty() {
            caps.vision = self.input.iter().any(|m| m == "image");
            caps.input_modalities = self.input.clone();
        }
        Some(caps)
    }
}

/// Fill a model's thinking controls from its provider spec when neither the
/// provider nor models.dev gave any: the seed entry for this model first, then
/// the spec's `default_reasoning`.
pub fn apply_fallback_reasoning(model: &mut ModelInfo) {
    if !model.reasoning_options.is_empty() {
        return;
    }
    let Some(spec) = get(&model.provider_id) else {
        return;
    };
    let seeded = [model.id.as_str(), model.api_id.as_str()]
        .iter()
        .find_map(|id| spec.models_seed.get(*id))
        .map(|seed| &seed.reasoning)
        .filter(|options| !options.is_empty());
    let options = seeded.unwrap_or(&spec.default_reasoning);
    if options.is_empty() {
        return;
    }
    model.reasoning_options = options.clone();
    model.capabilities.reasoning = true;
}

fn default_order() -> u32 {
    100
}

fn parse_all() -> Result<Vec<ProviderSpec>, String> {
    let mut specs = Vec::with_capacity(SOURCES.len());
    for (file, source) in SOURCES {
        let spec: ProviderSpec =
            toml::from_str(source).map_err(|e| format!("providers/{file}.toml: {e}"))?;
        if spec.id != *file {
            return Err(format!("providers/{file}.toml: id is `{}`", spec.id));
        }
        if ApiFormat::from_name(&spec.api_format).is_none() {
            return Err(format!(
                "providers/{file}.toml: unknown api_format `{}`",
                spec.api_format
            ));
        }
        specs.push(spec);
    }
    specs.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    Ok(specs)
}

/// Every provider spec, in list order (`order`, then id).
pub fn all() -> &'static [ProviderSpec] {
    static SPECS: OnceLock<Vec<ProviderSpec>> = OnceLock::new();
    SPECS.get_or_init(|| parse_all().unwrap_or_else(|e| panic!("invalid provider spec: {e}")))
}

/// The spec for a provider id, its alias, or its `desktop-` client id.
pub fn get(id: &str) -> Option<&'static ProviderSpec> {
    let id = super::canonical_provider_id(id);
    all()
        .iter()
        .find(|s| s.id == id || s.aliases.iter().any(|a| a == id))
}

/// The spec whose `match_hosts` covers this base URL's host.
pub fn for_base_url(base_url: &str) -> Option<&'static ProviderSpec> {
    let host = host_of(base_url)?;
    all().iter().find(|s| {
        s.match_hosts
            .iter()
            .any(|h| host == *h || host.ends_with(&format!(".{h}")))
    })
}

/// Whether Agente Code offers this provider by itself (connect dialogs, the
/// strict request path). Client-brought providers take the generic path.
pub fn offered(id: &str) -> bool {
    all().iter().any(|s| s.offered && s.id == id)
}

/// models.dev key for a provider id (the id itself when no spec renames it).
pub fn catalog_id(id: &str) -> &str {
    match get(id) {
        Some(spec) => spec.catalog_id(),
        None => id,
    }
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if host.starts_with('[') {
        host.split_once(']').map(|(h, _)| &h[1..])?
    } else {
        host.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spec_parses_with_unique_ids_and_aliases() {
        let specs = parse_all().unwrap();
        assert_eq!(specs.len(), SOURCES.len());
        let mut names: Vec<&str> = specs
            .iter()
            .flat_map(|s| {
                std::iter::once(s.id.as_str()).chain(s.aliases.iter().map(String::as_str))
            })
            .collect();
        let before = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), before, "duplicate provider id or alias");
    }

    #[test]
    fn cloud_specs_say_where_to_get_a_key_and_speak_openai_somewhere() {
        for spec in all().iter().filter(|s| s.group == ProviderGroup::Cloud) {
            assert!(spec.key_url.is_some(), "{} has no key_url", spec.id);
            assert!(
                spec.api_format == "openai" || spec.openai_compatible_url.is_some(),
                "{} has no endpoint an OpenAI-only client can use",
                spec.id
            );
        }
    }

    #[test]
    fn match_hosts_never_collide() {
        let mut hosts: Vec<&str> = all()
            .iter()
            .flat_map(|s| s.match_hosts.iter().map(String::as_str))
            .collect();
        let before = hosts.len();
        hosts.sort_unstable();
        hosts.dedup();
        assert_eq!(hosts.len(), before);
    }

    #[test]
    fn lookups_follow_ids_aliases_and_hosts() {
        assert_eq!(get("desktop-openrouter").unwrap().id, "openrouter");
        assert_eq!(get("local").unwrap().id, "llamacpp");
        assert_eq!(
            for_base_url("https://openrouter.ai/api/v1").unwrap().id,
            "openrouter"
        );
        assert_eq!(
            for_base_url("https://api.deepseek.com").unwrap().id,
            "deepseek"
        );
        assert!(for_base_url("http://127.0.0.1:8080/v1").is_none());
        assert_eq!(catalog_id("glm"), "zai");
        assert_eq!(catalog_id("unknown-gateway"), "unknown-gateway");
    }

    #[test]
    fn offered_set_matches_the_curated_providers() {
        let offered: Vec<&str> = all()
            .iter()
            .filter(|s| s.offered)
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(
            offered,
            ["opencode-go", "openrouter", "deepseek", "minimax", "glm"]
        );
    }

    #[test]
    fn toml_fallback_reasoning_fills_only_what_providers_leave_empty() {
        let spec: ProviderSpec = toml::from_str(
            r#"
            id = "x"
            name = "X"
            group = "cloud"
            base_url = "https://x.test/v1"
            api_format = "openai"
            models = "catalog"
            thinking = "default"
            default_reasoning = [{ type = "toggle" }]

            [models_seed."x-pro"]
            name = "X Pro"
            context = 200000
            output = 32000
            input = ["text", "image"]
            reasoning = [{ type = "effort", values = ["high", "max"] }]
            "#,
        )
        .unwrap();
        let seed = &spec.models_seed["x-pro"];
        assert_eq!(
            seed.reasoning,
            vec![ReasoningOption::Effort {
                values: vec!["high".into(), "max".into()]
            }]
        );
        let config = spec.provider_config();
        let model = &config.models["x-pro"];
        assert_eq!(model.limit.as_ref().unwrap().output, 32000);
        let caps = model.capabilities.as_ref().unwrap();
        assert!(caps.reasoning && caps.vision);
        assert_eq!(spec.default_reasoning, vec![ReasoningOption::Toggle]);
    }

    #[test]
    fn fallback_reasoning_never_overrides_provider_data() {
        let mut model = super::super::fallback_model_info("deepseek", "unknown-model");
        model.reasoning_options = vec![ReasoningOption::Toggle];
        apply_fallback_reasoning(&mut model);
        assert_eq!(model.reasoning_options, vec![ReasoningOption::Toggle]);

        // DeepSeek's spec documents its controls for models nobody describes.
        let mut unknown = super::super::fallback_model_info("deepseek", "unknown-model");
        apply_fallback_reasoning(&mut unknown);
        assert!(unknown.capabilities.reasoning);
        assert_eq!(
            crate::thinking::supported_thinking_levels(&unknown),
            vec!["off", "high", "max"]
        );

        // No spec data at all: stays empty, reasoning is not invented.
        let mut bare = super::super::fallback_model_info("minimax", "unknown-model");
        let before = bare.capabilities.reasoning;
        apply_fallback_reasoning(&mut bare);
        assert!(bare.reasoning_options.is_empty());
        assert_eq!(bare.capabilities.reasoning, before);
    }

    #[test]
    fn host_parsing_handles_ports_userinfo_and_ipv6() {
        assert_eq!(
            host_of("http://user@Example.com:8080/x").as_deref(),
            Some("example.com")
        );
        assert_eq!(host_of("http://[::1]:8080").as_deref(), Some("::1"));
        assert_eq!(
            host_of("api.deepseek.com").as_deref(),
            Some("api.deepseek.com")
        );
    }
}
