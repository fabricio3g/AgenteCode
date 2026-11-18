//! Thinking / reasoning levels — one profile per model, shared by every UI.
//!
//! Levels come **only** from provider metadata on the resolved model:
//! models.dev `reasoning_options`, OpenRouter's live `reasoning` object, or a
//! llama-server's chat template. [`profile`] turns that metadata into an
//! ordered list of choices (low → high) with their token budgets; the
//! request body for a choice is built from the same profile, so a UI can
//! never offer a level the wire would drop.
//!
//! `auto` is always a valid choice and sends nothing: the provider's own
//! default applies.

use serde::Serialize;

use crate::catalog::ReasoningOption;
use crate::providers::{ApiFormat, ModelInfo};

/// Level meaning “thinking disabled”.
pub const THINKING_OFF: &str = "off";
/// Level meaning “send no thinking fields” — the provider default applies.
pub const THINKING_AUTO: &str = "auto";

const OPENROUTER_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

/// Display and cycle order. Unknown catalog values sort after these, in the
/// order the provider listed them.
const LEVEL_ORDER: &[&str] = &[
    "off", "on", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// Token budgets for models that take a budget instead of named efforts
/// (Anthropic / Gemini `budget_tokens`, OpenRouter `reasoning.max_tokens`),
/// clamped to what the model allows.
const BUDGET_LADDER: &[(&str, u32)] = &[("low", 2048), ("medium", 8192), ("high", 24576)];

/// llama.cpp WebUI's ladder: `max` is unbounded.
const LLAMACPP_LADDER: &[(&str, Option<u32>)] = &[
    ("low", Some(512)),
    ("medium", Some(2048)),
    ("high", Some(8192)),
    ("max", None),
];

/// One choice on the thinking scale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThinkingLevel {
    pub id: String,
    /// Tokens the model may spend thinking at this level; `None` when the
    /// provider decides (named effort) or the level is unbounded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileSource {
    /// models.dev.
    Catalog,
    /// The provider's own live model list (OpenRouter).
    Live,
    /// A llama-server chat template.
    Template,
    /// No configurable thinking.
    None,
}

/// Everything a thinking selector needs for one model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThinkingProfile {
    /// Concrete choices, low → high. `auto` is implied and never listed.
    pub levels: Vec<ThinkingLevel>,
    /// What `auto` resolves to when the provider says (`default_effort`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// The model always thinks: there is no `off`.
    pub mandatory: bool,
    pub source: ProfileSource,
}

impl ThinkingProfile {
    fn none() -> Self {
        Self {
            levels: Vec::new(),
            default: None,
            mandatory: false,
            source: ProfileSource::None,
        }
    }

    pub fn ids(&self) -> Vec<String> {
        self.levels.iter().map(|l| l.id.clone()).collect()
    }

    pub fn level(&self, id: &str) -> Option<&ThinkingLevel> {
        self.levels.iter().find(|l| l.id == id)
    }

    /// `auto` or one of the listed levels.
    pub fn accepts(&self, id: &str) -> bool {
        id == THINKING_AUTO || self.level(id).is_some()
    }
}

/// The wire format a model is sent in when the caller does not say:
/// the shared resolver's result, or the same provider policy before resolution.
fn effective_format(model: &ModelInfo) -> ApiFormat {
    model
        .api
        .resolved_format
        .or_else(|| {
            let spec = crate::providers::spec::get(crate::providers::canonical_provider_id(
                &model.provider_id,
            ))?;
            crate::providers::ProviderInfo {
                id: model.provider_id.clone(),
                name: spec.name.clone(),
                api_format: spec.api_format(),
                ..Default::default()
            }
            .resolve_format(model)
            .ok()
        })
        .or(model.api.format)
        .unwrap_or(ApiFormat::OpenAI)
}

/// The thinking profile for a model, in its effective wire format.
pub fn profile(model: &ModelInfo) -> ThinkingProfile {
    profile_for(model, effective_format(model))
}

/// What the model's metadata says it accepts, gathered from every option.
#[derive(Default)]
struct Controls {
    toggle: bool,
    none_effort: bool,
    efforts: Vec<String>,
    budget: Option<(Option<u32>, Option<u32>)>,
    router: bool,
    router_mandatory: bool,
    router_max_tokens: bool,
    router_default: Option<String>,
    router_default_off: bool,
    llama: Option<(bool, bool)>,
}

impl Controls {
    fn read(options: &[ReasoningOption]) -> Self {
        let mut c = Self::default();
        for option in options {
            match option {
                ReasoningOption::Toggle => c.toggle = true,
                ReasoningOption::Effort { values } => {
                    for v in values {
                        if v.eq_ignore_ascii_case("none") {
                            c.none_effort = true;
                        } else if !v.is_empty() && !v.eq_ignore_ascii_case("default") {
                            c.push_effort(v);
                        }
                    }
                }
                ReasoningOption::BudgetTokens { min, max } => c.budget = Some((*min, *max)),
                ReasoningOption::OpenRouter {
                    effort_selectable,
                    supported_efforts,
                    default_effort,
                    default_enabled,
                    mandatory,
                    supports_max_tokens,
                } => {
                    c.router = true;
                    c.router_mandatory |= *mandatory;
                    c.router_max_tokens |= *supports_max_tokens;
                    if *effort_selectable {
                        match supported_efforts {
                            Some(values) => {
                                for v in values {
                                    if v == "none" {
                                        c.none_effort = true;
                                    } else if !v.is_empty() {
                                        c.push_effort(v);
                                    }
                                }
                            }
                            None => OPENROUTER_EFFORTS.iter().for_each(|v| c.push_effort(v)),
                        }
                    }
                    c.router_default = default_effort
                        .as_deref()
                        .map(|e| if e == "none" { THINKING_OFF } else { e })
                        .map(str::to_string);
                    c.router_default_off = *default_enabled == Some(false);
                }
                ReasoningOption::LlamaCpp {
                    per_request,
                    effort_kwarg,
                } => c.llama = Some((*per_request, *effort_kwarg)),
            }
        }
        c
    }

    fn push_effort(&mut self, value: &str) {
        if !self.efforts.iter().any(|e| e == value) {
            self.efforts.push(value.to_string());
        }
    }
}

fn level(id: &str, budget_tokens: Option<u32>) -> ThinkingLevel {
    ThinkingLevel {
        id: id.to_string(),
        budget_tokens,
    }
}

/// The budget ladder, clamped to the model's `[min, max]` and kept below its
/// output limit (Anthropic rejects a budget ≥ `max_tokens`). Levels that clamp
/// to the same budget collapse; one left over becomes a plain `on`.
fn budget_levels(
    model: &ModelInfo,
    min: Option<u32>,
    max: Option<u32>,
    floor: u32,
) -> Vec<ThinkingLevel> {
    let output = match model.limits.output {
        0 => crate::catalog::DEFAULT_OUTPUT_TOKENS,
        n => n,
    };
    let low = min.unwrap_or(floor).max(floor).max(1);
    let high = max
        .unwrap_or(u32::MAX)
        .min(output.saturating_mul(3) / 4)
        .max(low);
    let mut levels: Vec<ThinkingLevel> = Vec::new();
    for (id, budget) in BUDGET_LADDER {
        let budget = (*budget).clamp(low, high);
        if levels.last().and_then(|l| l.budget_tokens) != Some(budget) {
            levels.push(level(id, Some(budget)));
        }
    }
    if levels.len() == 1 {
        levels[0].id = "on".into();
    }
    levels
}

/// The thinking profile for a model sent in `api_format`.
pub fn profile_for(model: &ModelInfo, api_format: ApiFormat) -> ThinkingProfile {
    if !model.capabilities.reasoning || model.reasoning_options.is_empty() {
        // Reasoning support alone does not establish configurable controls,
        // and must never invent an off switch for mandatory reasoning.
        return ThinkingProfile::none();
    }
    let c = Controls::read(&model.reasoning_options);
    let source = if c.llama.is_some() {
        ProfileSource::Template
    } else if c.router {
        ProfileSource::Live
    } else {
        ProfileSource::Catalog
    };

    let mut levels: Vec<ThinkingLevel> = Vec::new();
    let mut off = c.llama.is_some();
    if let Some((per_request, _)) = c.llama {
        if per_request {
            levels.extend(LLAMACPP_LADDER.iter().map(|(id, b)| level(id, *b)));
        } else {
            levels.push(level("on", None));
        }
    } else {
        let native_budget = matches!(api_format, ApiFormat::Anthropic | ApiFormat::Google);
        off = c.toggle
            || c.none_effort
            || (c.router && !c.router_mandatory)
            || c.budget.is_some_and(|(min, _)| min == Some(0))
            // Anthropic thinking is opt-in: a budget model can always turn it off.
            || (api_format == ApiFormat::Anthropic && c.budget.is_some());
        if !c.efforts.is_empty() {
            levels.extend(c.efforts.iter().map(|e| level(e, None)));
        } else if let Some((min, max)) = c.budget.filter(|_| native_budget) {
            let floor = if api_format == ApiFormat::Anthropic {
                1024
            } else {
                1
            };
            levels.extend(budget_levels(model, min, max, floor));
        } else if c.router_max_tokens {
            levels.extend(budget_levels(model, None, None, 1024));
        } else if c.budget.is_some() || c.toggle || (c.router && !c.router_mandatory) {
            levels.push(level("on", None));
        }
    }
    if c.router_mandatory {
        off = false;
    }
    if levels.is_empty() && !off {
        return ThinkingProfile::none();
    }
    if off {
        levels.push(level(THINKING_OFF, None));
    }
    let rank = |id: &str| {
        LEVEL_ORDER
            .iter()
            .position(|l| *l == id)
            .unwrap_or(LEVEL_ORDER.len())
    };
    levels.sort_by_key(|l| rank(&l.id));
    let mut seen = Vec::new();
    levels.retain(|l| {
        let fresh = !seen.contains(&l.id);
        seen.push(l.id.clone());
        fresh
    });

    let default = c
        .router_default
        .filter(|d| levels.iter().any(|l| &l.id == d))
        .or_else(|| (c.router_default_off && off).then(|| THINKING_OFF.to_string()));
    ThinkingProfile {
        mandatory: !off,
        levels,
        default,
        source,
    }
}

/// Levels the user may pick for this model (without the implied `auto`).
pub fn supported_thinking_levels(model: &ModelInfo) -> Vec<String> {
    profile(model).ids()
}

/// Whether the status bar / Ctrl+T should expose thinking for this model.
pub fn model_supports_thinking(model: &ModelInfo) -> bool {
    !profile(model).levels.is_empty()
}

/// Keep a session level after a model switch when the new model accepts it;
/// otherwise fall back to `auto` (the provider's default).
pub fn clamp_thinking_level(model: &ModelInfo, current: &str) -> String {
    if profile(model).accepts(current) {
        current.to_string()
    } else {
        THINKING_AUTO.to_string()
    }
}

/// Provider-specific request shaping for reasoning (pi `detectCompat` parity).
///
/// Different OpenAI-compatible gateways accept different thinking params:
/// DeepSeek/Z.AI use `thinking:{type}` + `reasoning_effort`, Qwen uses
/// `enable_thinking`, OpenRouter/Ant-Ling use `reasoning:{effort}`, Together
/// uses `reasoning:{enabled}` + `reasoning_effort`, llama-server takes
/// `chat_template_kwargs` + `thinking_budget_tokens`, most others accept a bare
/// `reasoning_effort`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingFormat {
    /// Plain `reasoning_effort` (OpenAI o-series, most compatible gateways).
    #[default]
    Default,
    /// DeepSeek / Z.AI style: `thinking:{type}` + `reasoning_effort`.
    DeepSeek,
    /// Qwen / Alibaba: `enable_thinking: bool`.
    Qwen,
    /// OpenRouter: `reasoning:{effort|max_tokens|enabled}`.
    OpenRouter,
    /// Together: `reasoning:{enabled}` + `reasoning_effort`.
    Together,
    /// Ant-Ling: `reasoning:{effort}`.
    AntLing,
    /// llama-server: `chat_template_kwargs.enable_thinking` +
    /// `thinking_budget_tokens` (+ `reasoning_effort` when the template takes it).
    LlamaCpp,
}

/// The request thinking format for a provider: its spec's declared shape,
/// else the spec matching the base URL's host, else a guess from the id / URL
/// (custom endpoints). No model-id allowlists.
pub fn detect_thinking_format(provider_id: &str, base_url: &str) -> ThinkingFormat {
    let spec = crate::providers::spec::get(provider_id)
        .and_then(|spec| spec.thinking_format())
        .or_else(|| {
            crate::providers::spec::for_base_url(base_url).and_then(|spec| spec.thinking_format())
        });
    spec.unwrap_or_else(|| guess_thinking_format(provider_id, base_url))
}

/// pi's `detectCompat` thinkingFormat branches, for endpoints no spec covers.
fn guess_thinking_format(provider_id: &str, base_url: &str) -> ThinkingFormat {
    let hay = format!("{} {}", provider_id.to_lowercase(), base_url.to_lowercase());
    // zai / bigmodel / glm speak the same `reasoning_content` shape DeepSeek does.
    if hay.contains("deepseek")
        || hay.contains("zai")
        || hay.contains("bigmodel")
        || hay.contains("glm")
    {
        ThinkingFormat::DeepSeek
    } else if hay.contains("qwen") || hay.contains("dashscope") || hay.contains("alibaba") {
        ThinkingFormat::Qwen
    } else if hay.contains("openrouter") {
        ThinkingFormat::OpenRouter
    } else if hay.contains("together") {
        ThinkingFormat::Together
    } else if hay.contains("ant-ling") {
        ThinkingFormat::AntLing
    } else {
        ThinkingFormat::Default
    }
}

/// The thinking fields a request for `level` carries — what
/// [`apply_thinking_level`] merges into `model.options`. Empty for `auto` and
/// for levels the model does not offer.
pub fn request_patch(
    model: &ModelInfo,
    api_format: ApiFormat,
    level: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let mut bare = model.clone();
    bare.options.clear();
    apply_thinking_level(&mut bare, api_format, level);
    bare.options.into_iter().collect()
}

/// Apply the selected thinking level onto `model.options` for the outgoing
/// request. Branches on **API format** + the model's profile + `model.compat`
/// only; effort strings go out verbatim (e.g. `"max"`).
pub fn apply_thinking_level(model: &mut ModelInfo, api_format: ApiFormat, level: &str) {
    model.options = crate::providers::model_options(&model.options);
    let api_format = model.api.format.unwrap_or(api_format);
    let profile = profile_for(model, api_format);
    let Some(choice) = profile.level(level).cloned() else {
        // `auto`, or a level this model does not offer: keep explicitly
        // configured defaults and always-on reasoning untouched.
        return;
    };
    clear_thinking_options(model);
    let budget = choice.budget_tokens;
    let off = choice.id == THINKING_OFF;
    let on = choice.id == "on";

    if model.compat == ThinkingFormat::LlamaCpp && api_format != ApiFormat::Anthropic {
        apply_llamacpp(model, &choice);
        return;
    }
    match api_format {
        ApiFormat::Google => {
            let config = if off {
                serde_json::json!({"thinkingBudget": 0, "includeThoughts": true})
            } else if let Some(budget) = budget {
                serde_json::json!({"thinkingBudget": budget, "includeThoughts": true})
            } else if on {
                serde_json::json!({"includeThoughts": true})
            } else {
                serde_json::json!({"thinkingLevel": level.to_ascii_uppercase(), "includeThoughts": true})
            };
            model.options.insert("thinkingConfig".into(), config);
        }
        ApiFormat::Anthropic => apply_anthropic(model, &choice),
        ApiFormat::Responses => {
            let compat = model.compat;
            model.compat = ThinkingFormat::Default;
            apply_compatible(model, &choice);
            model.compat = compat;
            if let Some(effort) = model.options.remove("reasoning_effort") {
                model
                    .options
                    .insert("reasoning".into(), serde_json::json!({"effort": effort}));
            }
        }
        ApiFormat::OpenAI => apply_compatible(model, &choice),
    }
}

pub(crate) fn is_thinking_option(key: &str) -> bool {
    matches!(
        key,
        "thinking"
            | "reasoning_effort"
            | "reasoning"
            | "output_config"
            | "enable_thinking"
            | "thinkingConfig"
            | "reasoning_format"
            | "thinking_budget_tokens"
    )
}

fn clear_thinking_options(model: &mut ModelInfo) {
    model.options.retain(|key, _| !is_thinking_option(key));
    // Other template kwargs a user configured stay; only ours goes.
    if let Some(kwargs) = model
        .options
        .get_mut("chat_template_kwargs")
        .and_then(serde_json::Value::as_object_mut)
    {
        kwargs.remove("enable_thinking");
        if kwargs.is_empty() {
            model.options.remove("chat_template_kwargs");
        }
    }
}

fn set(model: &mut ModelInfo, key: &str, value: serde_json::Value) {
    model.options.insert(key.to_string(), value);
}

/// llama-server: thinking goes through the chat template kwargs; a budget is
/// enforced by the server's sampler for any thinking model.
fn apply_llamacpp(model: &mut ModelInfo, choice: &ThinkingLevel) {
    let off = choice.id == THINKING_OFF;
    set(model, "reasoning_format", serde_json::json!("auto"));
    let kwargs = model
        .options
        .entry("chat_template_kwargs".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(kwargs) = kwargs.as_object_mut() {
        kwargs.insert("enable_thinking".into(), serde_json::json!(!off));
    }
    if off || choice.id == "on" {
        return;
    }
    if let Some(budget) = choice.budget_tokens {
        set(model, "thinking_budget_tokens", serde_json::json!(budget));
    }
    let effort_kwarg = model.reasoning_options.iter().any(|o| {
        matches!(
            o,
            ReasoningOption::LlamaCpp {
                effort_kwarg: true,
                ..
            }
        )
    });
    if effort_kwarg {
        set(model, "reasoning_effort", serde_json::json!(choice.id));
    }
}

fn apply_anthropic(model: &mut ModelInfo, choice: &ThinkingLevel) {
    let adaptive = is_anthropic_adaptive_model(model);
    if choice.id == THINKING_OFF {
        set(model, "thinking", serde_json::json!({"type": "disabled"}));
        return;
    }
    model.options.remove("temperature");
    if let Some(budget) = choice.budget_tokens {
        set(
            model,
            "thinking",
            serde_json::json!({"type": "enabled", "budget_tokens": budget}),
        );
        return;
    }
    let catalog_budget = model.reasoning_options.iter().find_map(|o| match o {
        ReasoningOption::BudgetTokens { min, max } => Some(
            min.or(*max)
                .unwrap_or(1024)
                .max(1)
                .min(max.unwrap_or(u32::MAX)),
        ),
        _ => None,
    });
    if choice.id == "on" {
        let thinking = match catalog_budget {
            Some(n) => serde_json::json!({"type": "enabled", "budget_tokens": n}),
            None if adaptive => serde_json::json!({"type": "adaptive"}),
            None => serde_json::json!({"type": "enabled"}),
        };
        set(model, "thinking", thinking);
        return;
    }
    // A named effort.
    let effort = serde_json::json!({"effort": choice.id});
    if adaptive {
        set(
            model,
            "thinking",
            serde_json::json!({"type": "adaptive", "display": "summarized"}),
        );
    } else if let Some(n) = catalog_budget {
        set(
            model,
            "thinking",
            serde_json::json!({"type": "enabled", "budget_tokens": n}),
        );
    } else {
        // Anthropic-format gateways such as DeepSeek still need enabled
        // thinking plus their effort option; do not leak Claude's adaptive
        // mode across hosts.
        set(model, "thinking", serde_json::json!({"type": "enabled"}));
    }
    set(model, "output_config", effort);
}

/// OpenAI-compatible chat completions, by gateway dialect.
fn apply_compatible(model: &mut ModelInfo, choice: &ThinkingLevel) {
    let toggle = model.reasoning_options.iter().any(|o| {
        matches!(
            o,
            ReasoningOption::Toggle
                | ReasoningOption::OpenRouter {
                    mandatory: false,
                    ..
                }
        )
    });
    let none_effort = model.reasoning_options.iter().any(|o| {
        matches!(o, ReasoningOption::Effort { values } if values.iter().any(|v| v.eq_ignore_ascii_case("none")))
    });
    let enabled = |on: bool| serde_json::json!({"type": if on { "enabled" } else { "disabled" }});
    let id = choice.id.as_str();

    if id == THINKING_OFF {
        match model.compat {
            ThinkingFormat::DeepSeek => set(model, "thinking", enabled(false)),
            ThinkingFormat::Qwen => set(model, "enable_thinking", serde_json::json!(false)),
            ThinkingFormat::Together | ThinkingFormat::OpenRouter => {
                set(model, "reasoning", serde_json::json!({"enabled": false}))
            }
            ThinkingFormat::Default | ThinkingFormat::AntLing | ThinkingFormat::LlamaCpp => {
                if toggle {
                    set(model, "thinking", enabled(false));
                }
                // OpenAI's `none` is a valid off value only when advertised.
                if none_effort {
                    set(model, "reasoning_effort", serde_json::json!("none"));
                }
            }
        }
        return;
    }

    if id == "on" || choice.budget_tokens.is_some() {
        match model.compat {
            ThinkingFormat::DeepSeek => set(model, "thinking", enabled(true)),
            ThinkingFormat::Qwen => set(model, "enable_thinking", serde_json::json!(true)),
            ThinkingFormat::Together => {
                set(model, "reasoning", serde_json::json!({"enabled": true}))
            }
            ThinkingFormat::OpenRouter => {
                let reasoning = match choice.budget_tokens {
                    Some(budget) => serde_json::json!({"max_tokens": budget}),
                    None => serde_json::json!({"enabled": true}),
                };
                set(model, "reasoning", reasoning);
            }
            ThinkingFormat::AntLing => {
                set(model, "reasoning", serde_json::json!({"effort": "medium"}))
            }
            ThinkingFormat::Default | ThinkingFormat::LlamaCpp => {
                if toggle {
                    set(model, "thinking", enabled(true));
                }
            }
        }
        return;
    }

    // A named effort, sent verbatim.
    let effort = serde_json::json!(id);
    match model.compat {
        ThinkingFormat::DeepSeek => {
            set(model, "thinking", enabled(true));
            set(model, "reasoning_effort", effort);
        }
        ThinkingFormat::Qwen => set(model, "enable_thinking", serde_json::json!(true)),
        ThinkingFormat::OpenRouter | ThinkingFormat::AntLing => {
            set(model, "reasoning", serde_json::json!({"effort": effort}))
        }
        ThinkingFormat::Together => {
            set(model, "reasoning", serde_json::json!({"enabled": true}));
            set(model, "reasoning_effort", effort);
        }
        ThinkingFormat::Default | ThinkingFormat::LlamaCpp => {
            if toggle {
                set(model, "thinking", enabled(true));
            }
            set(model, "reasoning_effort", effort);
        }
    }
}

/// Claude adaptive thinking is a model/host capability, not a consequence of
/// selecting the Anthropic HTTP format. Keep custom Anthropic-compatible
/// gateways on their documented enabled+effort shape unless their model is
/// explicitly identifiable as Anthropic Claude.
fn is_anthropic_adaptive_model(model: &ModelInfo) -> bool {
    let provider = model.provider_id.to_ascii_lowercase();
    let model_id = model.api_id.to_ascii_lowercase();
    if model
        .options
        .get("anthropic_thinking_mode")
        .and_then(|value| value.as_str())
        .is_some_and(|mode| mode.eq_ignore_ascii_case("adaptive"))
    {
        return true;
    }
    if !provider.contains("anthropic") && !model_id.contains("claude") {
        return false;
    }

    // Official adaptive-thinking generations. Unknown and older Claude IDs
    // deliberately fall back to manual enabled/budget behavior.
    [
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-fable-5-1",
        "claude-mythos-5",
        "claude-mythos-5-1",
        "claude-mythos-preview",
    ]
    .iter()
    .any(|supported| model_id == *supported || model_id.starts_with(&format!("{supported}:")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{ModelCapabilities, ModelCost, ModelLimits, ModelStatus, ReasoningOption};
    use std::collections::HashMap;

    fn model_with(reasoning: bool, options: Vec<ReasoningOption>) -> ModelInfo {
        ModelInfo {
            api: Default::default(),
            id: "m".into(),
            name: "m".into(),
            api_id: "m".into(),
            provider_id: "p".into(),
            capabilities: ModelCapabilities {
                reasoning,
                toolcall: true,
                streaming: true,
                ..Default::default()
            },
            cost: ModelCost::default(),
            limits: ModelLimits {
                context: 128_000,
                input: None,
                output: 8192,
            },
            status: ModelStatus::Active,
            headers: HashMap::new(),
            options: HashMap::new(),
            reasoning_options: options,
            reasoning_stream_field: None,
            compat: ThinkingFormat::Default,
        }
    }

    #[test]
    fn deepseek_v4_style_levels() {
        let m = model_with(
            true,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into(), "max".into()],
                },
            ],
        );
        assert_eq!(supported_thinking_levels(&m), vec!["off", "high", "max"]);
    }

    #[test]
    fn no_reasoning_no_levels() {
        let m = model_with(false, vec![]);
        assert!(supported_thinking_levels(&m).is_empty());
    }

    #[test]
    fn unknown_controls_and_mandatory_reasoning_never_send_disable() {
        let mut unknown = model_with(true, vec![]);
        assert!(supported_thinking_levels(&unknown).is_empty());
        apply_thinking_level(&mut unknown, ApiFormat::OpenAI, THINKING_OFF);
        assert!(unknown.options.is_empty());

        let mut mandatory = model_with(
            true,
            vec![ReasoningOption::Effort {
                values: vec!["high".into()],
            }],
        );
        assert_eq!(supported_thinking_levels(&mandatory), vec!["high"]);
        apply_thinking_level(&mut mandatory, ApiFormat::Anthropic, THINKING_OFF);
        assert!(mandatory.options.is_empty());
    }

    #[test]
    fn apply_sends_max_verbatim() {
        let mut m = model_with(
            true,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into(), "max".into()],
                },
            ],
        );
        m.compat = ThinkingFormat::DeepSeek;
        apply_thinking_level(&mut m, ApiFormat::OpenAI, "max");
        assert_eq!(
            m.options.get("reasoning_effort"),
            Some(&serde_json::json!("max"))
        );
        // DeepSeek-style: thinking enabled alongside effort
        assert_eq!(
            m.options.get("thinking"),
            Some(&serde_json::json!({ "type": "enabled" }))
        );
    }

    #[test]
    fn apply_default_compat_preserves_advertised_toggle_with_effort() {
        let mut m = model_with(
            true,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into(), "max".into()],
                },
            ],
        );
        apply_thinking_level(&mut m, ApiFormat::OpenAI, "max");
        assert_eq!(
            m.options.get("reasoning_effort"),
            Some(&serde_json::json!("max"))
        );
        assert_eq!(m.options["thinking"], serde_json::json!({"type":"enabled"}));
        apply_thinking_level(&mut m, ApiFormat::OpenAI, THINKING_OFF);
        assert_eq!(
            m.options["thinking"],
            serde_json::json!({"type":"disabled"})
        );
    }

    #[test]
    fn apply_off_disables_thinking_when_toggle() {
        let mut m = model_with(
            true,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into()],
                },
            ],
        );
        m.compat = ThinkingFormat::DeepSeek;
        apply_thinking_level(&mut m, ApiFormat::OpenAI, "high");
        apply_thinking_level(&mut m, ApiFormat::OpenAI, "off");
        assert!(!m.options.contains_key("reasoning_effort"));
        assert_eq!(
            m.options.get("thinking"),
            Some(&serde_json::json!({ "type": "disabled" }))
        );
    }

    #[test]
    fn qwen_compat_uses_enable_thinking() {
        let mut m = model_with(
            true,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into()],
                },
            ],
        );
        m.compat = ThinkingFormat::Qwen;
        apply_thinking_level(&mut m, ApiFormat::OpenAI, "high");
        assert_eq!(
            m.options.get("enable_thinking"),
            Some(&serde_json::json!(true))
        );
        assert!(!m.options.contains_key("reasoning_effort"));
        apply_thinking_level(&mut m, ApiFormat::OpenAI, THINKING_OFF);
        assert_eq!(
            m.options.get("enable_thinking"),
            Some(&serde_json::json!(false))
        );
    }

    #[test]
    fn openrouter_compat_uses_reasoning_effort_object() {
        let mut m = model_with(
            true,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into()],
                },
            ],
        );
        m.compat = ThinkingFormat::OpenRouter;
        apply_thinking_level(&mut m, ApiFormat::OpenAI, "high");
        assert_eq!(
            m.options.get("reasoning"),
            Some(&serde_json::json!({ "effort": "high" }))
        );
        apply_thinking_level(&mut m, ApiFormat::OpenAI, THINKING_OFF);
        assert_eq!(
            m.options.get("reasoning"),
            Some(&serde_json::json!({ "enabled": false }))
        );
    }

    #[test]
    fn together_compat_uses_reasoning_enabled() {
        let mut m = model_with(
            true,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into()],
                },
            ],
        );
        m.compat = ThinkingFormat::Together;
        apply_thinking_level(&mut m, ApiFormat::OpenAI, "high");
        assert_eq!(
            m.options.get("reasoning"),
            Some(&serde_json::json!({ "enabled": true }))
        );
        assert_eq!(
            m.options.get("reasoning_effort"),
            Some(&serde_json::json!("high"))
        );
        apply_thinking_level(&mut m, ApiFormat::OpenAI, THINKING_OFF);
        assert_eq!(
            m.options.get("reasoning"),
            Some(&serde_json::json!({ "enabled": false }))
        );
    }

    #[test]
    fn anthropic_effort_uses_adaptive_output_config() {
        let mut m = model_with(
            true,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into(), "max".into()],
                },
            ],
        );
        m.provider_id = "anthropic".into();
        m.api_id = "claude-sonnet-4-6".into();
        apply_thinking_level(&mut m, ApiFormat::Anthropic, "max");
        let thinking = m.options.get("thinking").unwrap();
        assert_eq!(thinking["type"], "adaptive");
        assert!(thinking.get("budget_tokens").is_none());
        assert_eq!(
            m.options.get("output_config"),
            Some(&serde_json::json!({ "effort": "max" }))
        );
        apply_thinking_level(&mut m, ApiFormat::Anthropic, THINKING_OFF);
        assert_eq!(
            m.options["thinking"],
            serde_json::json!({"type": "disabled"})
        );
        assert!(!m.options.contains_key("output_config"));
    }

    #[test]
    fn anthropic_compatible_gateway_does_not_receive_claude_adaptive_mode() {
        let mut m = model_with(
            true,
            vec![ReasoningOption::Effort {
                values: vec!["high".into()],
            }],
        );
        m.provider_id = "deepseek".into();
        m.api_id = "deepseek-reasoner".into();
        apply_thinking_level(&mut m, ApiFormat::Anthropic, "high");
        assert_eq!(
            m.options["thinking"],
            serde_json::json!({ "type": "enabled" })
        );
        assert_eq!(
            m.options["output_config"],
            serde_json::json!({ "effort": "high" })
        );
    }

    #[test]
    fn legacy_claude_effort_keeps_exact_budget_and_adds_effort() {
        let mut m = model_with(
            true,
            vec![
                ReasoningOption::Toggle,
                ReasoningOption::Effort {
                    values: vec!["high".into()],
                },
                ReasoningOption::BudgetTokens {
                    min: Some(1024),
                    max: Some(8192),
                },
            ],
        );
        m.provider_id = "anthropic".into();
        m.api_id = "claude-opus-4-5".into();
        apply_thinking_level(&mut m, ApiFormat::Anthropic, "high");
        assert_eq!(
            m.options["thinking"],
            serde_json::json!({ "type": "enabled", "budget_tokens": 1024 })
        );
        assert_eq!(
            m.options["output_config"],
            serde_json::json!({ "effort": "high" })
        );
    }

    #[test]
    fn openrouter_effort_requires_explicit_selector_capability() {
        let mut model = model_with(
            true,
            vec![ReasoningOption::OpenRouter {
                effort_selectable: false,
                supported_efforts: None,
                default_effort: Some("high".into()),
                default_enabled: Some(true),
                mandatory: false,
                supports_max_tokens: false,
            }],
        );
        model.provider_id = "openrouter".into();
        model.id = "vendor/unknown-effort".into();
        model.api_id = model.id.clone();
        model.compat = ThinkingFormat::OpenRouter;

        apply_thinking_level(&mut model, ApiFormat::OpenAI, "high");

        assert!(!model.options.contains_key("reasoning"));
        assert_eq!(supported_thinking_levels(&model), vec!["off", "on"]);
        apply_thinking_level(&mut model, ApiFormat::OpenAI, "on");
        assert_eq!(
            model.options["reasoning"],
            serde_json::json!({"enabled":true})
        );
    }

    #[test]
    fn mandatory_openrouter_never_sends_none_even_if_advertised() {
        let mut model = model_with(
            true,
            vec![ReasoningOption::OpenRouter {
                effort_selectable: true,
                supported_efforts: Some(vec!["none".into(), "high".into(), "low".into()]),
                default_effort: Some("low".into()),
                default_enabled: Some(true),
                mandatory: true,
                supports_max_tokens: false,
            }],
        );
        model.compat = ThinkingFormat::OpenRouter;
        // OpenRouter lists efforts highest-first; the profile runs low → high.
        assert_eq!(supported_thinking_levels(&model), vec!["low", "high"]);
        let profile = profile(&model);
        assert!(profile.mandatory);
        assert_eq!(profile.default.as_deref(), Some("low"));
        assert_eq!(profile.source, ProfileSource::Live);
        assert_eq!(clamp_thinking_level(&model, "stale"), THINKING_AUTO);
        assert_eq!(clamp_thinking_level(&model, "high"), "high");
        for unsupported in ["none", "off", "on", "max"] {
            apply_thinking_level(&mut model, ApiFormat::OpenAI, unsupported);
            assert!(model.options.is_empty(), "{unsupported}");
        }
    }

    #[test]
    fn openrouter_descending_efforts_sort_low_to_high_with_off_when_optional() {
        let mut model = model_with(
            true,
            vec![ReasoningOption::OpenRouter {
                effort_selectable: true,
                supported_efforts: Some(
                    ["max", "xhigh", "high", "medium", "low", "none"]
                        .map(String::from)
                        .to_vec(),
                ),
                default_effort: Some("medium".into()),
                default_enabled: Some(true),
                mandatory: false,
                supports_max_tokens: false,
            }],
        );
        model.compat = ThinkingFormat::OpenRouter;
        assert_eq!(
            supported_thinking_levels(&model),
            vec!["off", "low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(profile(&model).default.as_deref(), Some("medium"));
        let patch = request_patch(&model, ApiFormat::OpenAI, "xhigh");
        assert_eq!(patch["reasoning"], serde_json::json!({"effort": "xhigh"}));
        assert!(request_patch(&model, ApiFormat::OpenAI, THINKING_AUTO).is_empty());
    }

    #[test]
    fn openrouter_budget_models_send_max_tokens() {
        let mut model = model_with(
            true,
            vec![ReasoningOption::OpenRouter {
                effort_selectable: false,
                supported_efforts: None,
                default_effort: None,
                default_enabled: Some(true),
                mandatory: false,
                supports_max_tokens: true,
            }],
        );
        model.limits.output = 64_000;
        model.compat = ThinkingFormat::OpenRouter;
        assert_eq!(
            supported_thinking_levels(&model),
            vec!["off", "low", "medium", "high"]
        );
        let patch = request_patch(&model, ApiFormat::OpenAI, "medium");
        assert_eq!(patch["reasoning"], serde_json::json!({"max_tokens": 8192}));
    }

    #[test]
    fn anthropic_budget_models_can_turn_off_and_pick_a_budget() {
        let mut model = model_with(
            true,
            vec![ReasoningOption::BudgetTokens {
                min: Some(1024),
                max: None,
            }],
        );
        model.provider_id = "anthropic".into();
        model.api_id = "claude-sonnet-4-5".into();
        model.limits.output = 64_000;
        let profile = profile_for(&model, ApiFormat::Anthropic);
        assert_eq!(profile.ids(), vec!["off", "low", "medium", "high"]);
        assert_eq!(profile.level("high").unwrap().budget_tokens, Some(24576));
        apply_thinking_level(&mut model, ApiFormat::Anthropic, "low");
        assert_eq!(
            model.options["thinking"],
            serde_json::json!({"type": "enabled", "budget_tokens": 2048})
        );
        apply_thinking_level(&mut model, ApiFormat::Anthropic, THINKING_OFF);
        assert_eq!(
            model.options["thinking"],
            serde_json::json!({"type": "disabled"})
        );

        // A small output limit keeps every budget below max_tokens.
        model.limits.output = 4096;
        let small = profile_for(&model, ApiFormat::Anthropic);
        assert!(small
            .levels
            .iter()
            .filter_map(|l| l.budget_tokens)
            .all(|b| b < 4096));
    }

    #[test]
    fn llamacpp_per_request_ladder_matches_the_webui() {
        let mut model = model_with(
            true,
            vec![ReasoningOption::LlamaCpp {
                per_request: true,
                effort_kwarg: false,
            }],
        );
        model.compat = ThinkingFormat::LlamaCpp;
        let profile = profile(&model);
        assert_eq!(profile.ids(), vec!["off", "low", "medium", "high", "max"]);
        assert_eq!(profile.source, ProfileSource::Template);
        assert_eq!(profile.level("medium").unwrap().budget_tokens, Some(2048));
        assert_eq!(profile.level("max").unwrap().budget_tokens, None);

        model.options.insert(
            "chat_template_kwargs".into(),
            serde_json::json!({"custom": 1}),
        );
        apply_thinking_level(&mut model, ApiFormat::OpenAI, "medium");
        assert_eq!(model.options["reasoning_format"], "auto");
        assert_eq!(
            model.options["chat_template_kwargs"],
            serde_json::json!({"custom": 1, "enable_thinking": true})
        );
        assert_eq!(model.options["thinking_budget_tokens"], 2048);
        assert!(!model.options.contains_key("reasoning_effort"));

        apply_thinking_level(&mut model, ApiFormat::OpenAI, THINKING_OFF);
        assert_eq!(
            model.options["chat_template_kwargs"],
            serde_json::json!({"custom": 1, "enable_thinking": false})
        );
        assert!(!model.options.contains_key("thinking_budget_tokens"));
    }

    #[test]
    fn llamacpp_effort_templates_and_old_servers() {
        let mut model = model_with(
            true,
            vec![ReasoningOption::LlamaCpp {
                per_request: true,
                effort_kwarg: true,
            }],
        );
        model.compat = ThinkingFormat::LlamaCpp;
        let patch = request_patch(&model, ApiFormat::OpenAI, "max");
        assert_eq!(patch["reasoning_effort"], "max");
        assert!(!patch.contains_key("thinking_budget_tokens"));

        model.reasoning_options = vec![ReasoningOption::LlamaCpp {
            per_request: false,
            effort_kwarg: false,
        }];
        assert_eq!(supported_thinking_levels(&model), vec!["off", "on"]);
    }

    #[test]
    fn detect_thinking_format_from_provider_id() {
        use ThinkingFormat as F;
        assert_eq!(detect_thinking_format("deepseek", ""), F::DeepSeek);
        assert_eq!(detect_thinking_format("zai", ""), F::DeepSeek);
        assert_eq!(detect_thinking_format("qwen-token-plan", ""), F::Qwen);
        assert_eq!(detect_thinking_format("alibaba", ""), F::Qwen);
        assert_eq!(detect_thinking_format("openrouter", ""), F::OpenRouter);
        assert_eq!(detect_thinking_format("togetherai", ""), F::Together);
        assert_eq!(detect_thinking_format("ant-ling", ""), F::AntLing);
        assert_eq!(detect_thinking_format("openai", ""), F::Default);
        assert_eq!(detect_thinking_format("cerebras", ""), F::Default);
    }

    #[test]
    fn catalog_fixture_deepseek_flash_has_high_max() {
        use crate::catalog::ModelCatalog;
        let cat = ModelCatalog::parse_json(
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
                    "reasoning_options": [
                      { "type": "toggle" },
                      { "type": "effort", "values": ["high", "max"] }
                    ],
                    "tool_call": true,
                    "limit": { "context": 1000000, "output": 384000 }
                  }
                }
              }
            }"#,
        )
        .unwrap();
        let cm = cat.find_model("deepseek", "deepseek-v4-flash").unwrap();
        let m = crate::providers::model_info_from_catalog(cm, "deepseek");
        assert_eq!(supported_thinking_levels(&m), vec!["off", "high", "max"]);
    }
}
