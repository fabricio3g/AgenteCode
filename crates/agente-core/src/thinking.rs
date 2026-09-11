//! Thinking / reasoning levels derived **only** from model catalog metadata.
//!
//! Levels come from models.dev or live provider metadata on the resolved model.
//! Provider-specific adapters map those controls to the outgoing API.

use crate::catalog::ReasoningOption;
use crate::providers::{ApiFormat, ModelInfo};

/// Level meaning “thinking disabled” in the cycle / UI.
pub const THINKING_OFF: &str = "off";

const OPENROUTER_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

/// Levels the user may cycle for this model (catalog-only).
///
/// - `reasoning: false` → empty (no Ctrl+T)
/// - `toggle` → includes `"off"`
/// - `effort.values` → each non-null string as-is (`"high"`, `"max"`, …)
/// - `budget_tokens` only (no effort) → `"off"` + `"on"` (wire uses catalog min/max)
/// - effort value `"none"` is treated as off-equivalent and not duplicated
pub fn supported_thinking_levels(model: &ModelInfo) -> Vec<String> {
    if !model.capabilities.reasoning {
        return Vec::new();
    }

    let opts = &model.reasoning_options;
    if opts.is_empty() {
        // Reasoning support alone does not establish configurable controls.
        // Do not invent an off switch for mandatory-reasoning models.
        return Vec::new();
    }

    let has_toggle = opts.iter().any(|o| {
        matches!(
            o,
            ReasoningOption::Toggle
                | ReasoningOption::OpenRouter {
                    mandatory: false,
                    default_enabled: Some(_),
                    ..
                }
        )
    });
    let mut effort_values: Vec<String> = Vec::new();
    let mut has_budget = false;
    let mut openrouter_all_efforts = false;
    let mut openrouter_efforts: Vec<String> = Vec::new();
    let mut openrouter_mandatory = false;

    for o in opts {
        match o {
            ReasoningOption::Toggle => {}
            ReasoningOption::Effort { values } => {
                for v in values {
                    if v.is_empty() {
                        continue;
                    }
                    if v.eq_ignore_ascii_case("none") || v.eq_ignore_ascii_case("default") {
                        continue;
                    }
                    if !effort_values.iter().any(|e| e == v) {
                        effort_values.push(v.clone());
                    }
                }
            }
            ReasoningOption::BudgetTokens { .. } => {
                has_budget = true;
            }
            ReasoningOption::OpenRouter {
                supported_efforts,
                effort_selectable,
                mandatory,
                supports_max_tokens,
                ..
            } => {
                openrouter_mandatory |= *mandatory;
                if *effort_selectable {
                    if let Some(values) = supported_efforts {
                        openrouter_efforts.extend(values.iter().filter(|v| !v.is_empty()).cloned());
                    } else {
                        openrouter_all_efforts = true;
                    }
                } else if *supports_max_tokens {
                    has_budget = true;
                }
            }
        }
    }

    if openrouter_all_efforts {
        openrouter_efforts = OPENROUTER_EFFORTS
            .iter()
            .map(|v| (*v).to_string())
            .collect();
    }

    let mut levels = Vec::new();

    // Off when toggle present, or when effort includes none (skipped above), or budget-only.
    if (has_toggle || !openrouter_efforts.is_empty()) && !openrouter_mandatory
        || opts.iter().any(|o| match o {
            ReasoningOption::Effort { values } => values.iter().any(|v| v == "none"),
            ReasoningOption::BudgetTokens { min, .. } => *min == Some(0),
            _ => false,
        })
    {
        levels.push(THINKING_OFF.to_string());
    }

    let has_router_efforts = !openrouter_efforts.is_empty();
    levels.extend(openrouter_efforts.into_iter().filter(|v| v != "none"));
    if !effort_values.is_empty() {
        levels.extend(effort_values);
    } else if !has_router_efforts && (has_budget || has_toggle) {
        // No effort ladder — binary on (wire uses budget bounds if any).
        levels.push("on".to_string());
    }

    // Dedupe while preserving order
    let mut out = Vec::new();
    for l in levels {
        if openrouter_mandatory && (l == THINKING_OFF || l == "none") {
            continue;
        }
        if !out.iter().any(|x: &String| x == &l) {
            out.push(l);
        }
    }
    out
}

/// Whether the status bar / Ctrl+T should expose thinking for this model.
pub fn model_supports_thinking(model: &ModelInfo) -> bool {
    !supported_thinking_levels(model).is_empty()
}

/// Cycle to the next catalog level. Returns the new level (unchanged if none supported).
pub fn cycle_thinking_level(model: &ModelInfo, current: &str) -> String {
    let levels = supported_thinking_levels(model);
    if levels.is_empty() {
        return if model.capabilities.reasoning {
            "auto"
        } else {
            THINKING_OFF
        }
        .to_string();
    }
    let cur = if current.is_empty() {
        THINKING_OFF
    } else {
        current
    };
    // A stale setting must recover to the first valid choice. Advancing from
    // index zero would silently skip that choice after a model switch.
    let Some(idx) = levels.iter().position(|l| l == cur) else {
        return levels[0].clone();
    };
    let next = (idx + 1) % levels.len();
    levels[next].clone()
}

/// Clamp session level after model switch to something this model supports.
pub fn clamp_thinking_level(model: &ModelInfo, current: &str) -> String {
    let levels = supported_thinking_levels(model);
    if levels.is_empty() {
        return if model.capabilities.reasoning {
            "auto"
        } else {
            THINKING_OFF
        }
        .to_string();
    }
    if levels.iter().any(|l| l == current) {
        return current.to_string();
    }
    for option in &model.reasoning_options {
        if let ReasoningOption::OpenRouter {
            default_effort: Some(effort),
            ..
        } = option
        {
            let effort = if effort == "none" {
                THINKING_OFF
            } else {
                effort.as_str()
            };
            if levels.iter().any(|level| level == effort) {
                return effort.to_string();
            }
        }
    }
    // Prefer off when available, else first catalog level.
    if levels.iter().any(|l| l == THINKING_OFF) {
        THINKING_OFF.to_string()
    } else {
        levels[0].clone()
    }
}

/// Provider-specific request shaping for reasoning (pi `detectCompat` parity).
///
/// Different OpenAI-compatible gateways accept different thinking params:
/// DeepSeek/Z.AI use `thinking:{type}` + `reasoning_effort`, Qwen uses
/// `enable_thinking`, OpenRouter/Ant-Ling use `reasoning:{effort}`, Together
/// uses `reasoning:{enabled}` + `reasoning_effort`, most others accept a bare
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
    /// OpenRouter: `reasoning:{effort}`.
    OpenRouter,
    /// Together: `reasoning:{enabled}` + `reasoning_effort`.
    Together,
    /// Ant-Ling: `reasoning:{effort}`.
    AntLing,
}

/// Infer the request thinking format from provider id / base URL.
/// Mirrors pi's `detectCompat` thinkingFormat branches — no model-id allowlists.
pub fn detect_thinking_format(provider_id: &str, base_url: &str) -> ThinkingFormat {
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

/// Apply selected thinking level onto `model.options` for the outgoing request.
///
/// Branches on **API format** + **this model’s reasoning_options** +
/// `model.compat` only. Sends catalog effort strings verbatim (e.g. `"max"`).
pub fn apply_thinking_level(model: &mut ModelInfo, api_format: ApiFormat, level: &str) {
    model.options = crate::providers::model_options(&model.options);
    let api_format = model.api.format.unwrap_or(api_format);
    if !supported_thinking_levels(model)
        .iter()
        .any(|value| value == level)
    {
        // Preserve explicitly configured defaults and always-on reasoning.
        // Absence of a control is not a request to disable reasoning.
        return;
    }
    if api_format == ApiFormat::Google {
        model.options.retain(|key, _| !is_thinking_option(key));
        let config = if level == THINKING_OFF {
            serde_json::json!({"thinkingBudget": 0, "includeThoughts": true})
        } else if level == "on" {
            let budget = model.reasoning_options.iter().find_map(|o| match o {
                ReasoningOption::BudgetTokens { min, max } => min
                    .filter(|value| *value > 0)
                    .or(max.filter(|value| *value > 0)),
                _ => None,
            });
            match budget {
                Some(budget) => {
                    serde_json::json!({"thinkingBudget": budget, "includeThoughts": true})
                }
                None => serde_json::json!({"includeThoughts": true}),
            }
        } else {
            serde_json::json!({"thinkingLevel": level.to_ascii_uppercase(), "includeThoughts": true})
        };
        model.options.insert("thinkingConfig".into(), config);
        return;
    }
    if api_format == ApiFormat::Responses {
        let compat = model.compat;
        model.compat = ThinkingFormat::Default;
        apply_compatible_thinking(model, ApiFormat::OpenAI, level);
        model.compat = compat;
        if let Some(effort) = model.options.remove("reasoning_effort") {
            model
                .options
                .insert("reasoning".into(), serde_json::json!({"effort": effort}));
        }
        return;
    }
    apply_compatible_thinking(model, api_format, level);
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
    )
}

fn apply_compatible_thinking(model: &mut ModelInfo, api_format: ApiFormat, level: &str) {
    model.options.remove("thinking");
    model.options.remove("reasoning_effort");
    model.options.remove("reasoning");
    model.options.remove("output_config");
    model.options.remove("enable_thinking");
    model.options.remove("thinkingConfig");

    if !model.capabilities.reasoning {
        return;
    }

    let level = if level.is_empty() {
        THINKING_OFF
    } else {
        level
    };
    let opts = model.reasoning_options.clone();
    if opts.is_empty()
        || !supported_thinking_levels(model)
            .iter()
            .any(|value| value == level)
    {
        return;
    }
    let has_toggle = opts.iter().any(|o| {
        matches!(
            o,
            ReasoningOption::Toggle
                | ReasoningOption::OpenRouter {
                    mandatory: false,
                    ..
                }
        )
    });
    let has_effort = opts.iter().any(|o| {
        matches!(
            o,
            ReasoningOption::Effort { .. } | ReasoningOption::OpenRouter { .. }
        )
    });
    let effort_match = opts.iter().find_map(|o| match o {
        ReasoningOption::Effort { values } if values.iter().any(|v| v == level) => {
            Some(level.to_string())
        }
        ReasoningOption::OpenRouter {
            effort_selectable: true,
            supported_efforts: Some(values),
            ..
        } if values.iter().any(|v| v == level) => Some(level.to_string()),
        ReasoningOption::OpenRouter {
            effort_selectable: true,
            supported_efforts: None,
            ..
        } if OPENROUTER_EFFORTS.contains(&level) => Some(level.to_string()),
        _ => None,
    });
    let budget = opts.iter().find_map(|o| match o {
        ReasoningOption::BudgetTokens { min, max } => Some((*min, *max)),
        _ => None,
    });
    let format = model.compat;
    let anthropic_adaptive = is_anthropic_adaptive_model(model);
    let enableable = has_toggle || has_effort || opts.is_empty();

    if level == THINKING_OFF {
        if !enableable {
            return;
        }
        match api_format {
            ApiFormat::Anthropic => {
                if budget.is_some() || has_toggle || anthropic_adaptive {
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "disabled" }),
                    );
                }
            }
            ApiFormat::OpenAI | ApiFormat::Responses | ApiFormat::Google => match format {
                ThinkingFormat::DeepSeek => {
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "disabled" }),
                    );
                }
                ThinkingFormat::Qwen => {
                    model
                        .options
                        .insert("enable_thinking".to_string(), serde_json::json!(false));
                }
                ThinkingFormat::Together => {
                    model.options.insert(
                        "reasoning".to_string(),
                        serde_json::json!({ "enabled": false }),
                    );
                }
                ThinkingFormat::OpenRouter => {
                    model.options.insert(
                        "reasoning".to_string(),
                        serde_json::json!({ "enabled": false }),
                    );
                }
                // OpenAI's `none` is a valid off wire value only when the
                // model metadata advertised it.
                _ => {
                    if has_toggle {
                        model
                            .options
                            .insert("thinking".into(), serde_json::json!({"type": "disabled"}));
                    }
                    if opts.iter().any(|o| matches!(o, ReasoningOption::Effort { values } if values.iter().any(|v| v.eq_ignore_ascii_case("none")))) {
                        model.options.insert("reasoning_effort".to_string(), serde_json::json!("none"));
                    }
                }
            },
        }
        return;
    }

    if let Some(effort) = effort_match {
        match api_format {
            ApiFormat::OpenAI | ApiFormat::Responses | ApiFormat::Google => match format {
                ThinkingFormat::DeepSeek => {
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "enabled" }),
                    );
                    model
                        .options
                        .insert("reasoning_effort".to_string(), serde_json::json!(effort));
                }
                ThinkingFormat::Qwen => {
                    model
                        .options
                        .insert("enable_thinking".to_string(), serde_json::json!(true));
                }
                ThinkingFormat::OpenRouter | ThinkingFormat::AntLing => {
                    model.options.insert(
                        "reasoning".to_string(),
                        serde_json::json!({ "effort": effort }),
                    );
                }
                ThinkingFormat::Together => {
                    model.options.insert(
                        "reasoning".to_string(),
                        serde_json::json!({ "enabled": true }),
                    );
                    model
                        .options
                        .insert("reasoning_effort".to_string(), serde_json::json!(effort));
                }
                ThinkingFormat::Default => {
                    if has_toggle {
                        model
                            .options
                            .insert("thinking".into(), serde_json::json!({"type": "enabled"}));
                    }
                    model
                        .options
                        .insert("reasoning_effort".to_string(), serde_json::json!(effort));
                }
            },
            ApiFormat::Anthropic => {
                model.options.remove("temperature");
                if anthropic_adaptive {
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "adaptive", "display": "summarized" }),
                    );
                    model.options.insert(
                        "output_config".to_string(),
                        serde_json::json!({ "effort": effort }),
                    );
                } else if let Some((min, max)) = budget {
                    let n = min
                        .or(max)
                        .unwrap_or(1024)
                        .max(1)
                        .min(max.unwrap_or(u32::MAX));
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "enabled", "budget_tokens": n }),
                    );
                    if has_effort {
                        model.options.insert(
                            "output_config".to_string(),
                            serde_json::json!({ "effort": effort }),
                        );
                    }
                } else {
                    // Anthropic-format gateways such as DeepSeek still need
                    // enabled thinking plus their effort option; do not leak
                    // Claude's adaptive mode across hosts.
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "enabled" }),
                    );
                    model.options.insert(
                        "output_config".to_string(),
                        serde_json::json!({ "effort": effort }),
                    );
                }
            }
        }
        return;
    }

    // Binary "on" (toggle/budget only) — enable thinking without inventing effort.
    if level == "on" {
        match api_format {
            ApiFormat::Anthropic => {
                model.options.remove("temperature");
                if let Some((min, max)) = budget {
                    let n = min
                        .or(max)
                        .unwrap_or(1024)
                        .max(1)
                        .min(max.unwrap_or(u32::MAX));
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "enabled", "budget_tokens": n }),
                    );
                } else if anthropic_adaptive {
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "adaptive" }),
                    );
                } else {
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "enabled" }),
                    );
                }
            }
            ApiFormat::OpenAI | ApiFormat::Responses | ApiFormat::Google => match format {
                ThinkingFormat::DeepSeek => {
                    model.options.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "enabled" }),
                    );
                }
                ThinkingFormat::Qwen => {
                    model
                        .options
                        .insert("enable_thinking".to_string(), serde_json::json!(true));
                }
                ThinkingFormat::Together => {
                    model.options.insert(
                        "reasoning".to_string(),
                        serde_json::json!({ "enabled": true }),
                    );
                }
                ThinkingFormat::OpenRouter => {
                    model.options.insert(
                        "reasoning".to_string(),
                        serde_json::json!({ "enabled": true }),
                    );
                }
                ThinkingFormat::AntLing => {
                    model.options.insert(
                        "reasoning".to_string(),
                        serde_json::json!({ "effort": "medium" }),
                    );
                }
                ThinkingFormat::Default => {
                    if has_toggle {
                        model.options.insert(
                            "thinking".to_string(),
                            serde_json::json!({ "type": "enabled" }),
                        );
                    }
                }
            },
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
        assert_eq!(cycle_thinking_level(&m, "off"), "high");
        assert_eq!(cycle_thinking_level(&m, "high"), "max");
        assert_eq!(cycle_thinking_level(&m, "max"), "off");
    }

    #[test]
    fn no_reasoning_no_levels() {
        let m = model_with(false, vec![]);
        assert!(supported_thinking_levels(&m).is_empty());
        assert_eq!(cycle_thinking_level(&m, "high"), "off");
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
        assert_eq!(supported_thinking_levels(&model), vec!["high", "low"]);
        assert_eq!(clamp_thinking_level(&model, "stale"), "low");
        for unsupported in ["none", "off", "on", "max"] {
            apply_thinking_level(&mut model, ApiFormat::OpenAI, unsupported);
            assert!(model.options.is_empty(), "{unsupported}");
        }
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
