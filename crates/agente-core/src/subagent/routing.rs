//! Which model a child runs on.
//!
//! The user keeps a list of models subagents may use (any provider, each
//! with a note on what it is for), one default model, and decides whether
//! the orchestrator may pick from the list (`config::SubagentSettings`).
//! One function decides for the TUI and Desktop alike:
//!
//! 1. the parent's `model` argument, when picking is on (a list name or
//!    `main`; anything else fails the `task` call);
//! 2. a preset agent file's `model:` (a list name, `main`, or
//!    `provider/model` on a connected provider);
//! 3. the default model;
//! 4. the parent's model.

use crate::config::{SubagentModelEntry, SubagentSettings, MAIN_MODEL};

/// Where a routing decision came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteSource {
    /// The orchestrator's `model` argument.
    Picked,
    /// The preset agent file's `model:`.
    AgentFile,
    /// The user's default model.
    Default,
    /// Nothing chose: the parent's model.
    Inherited,
}

/// A routed model. `provider`/`model`/`thinking` are `None` when the child
/// runs on the parent's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutedModel {
    /// The list name, when the model came from the list.
    pub seat: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub source: RouteSource,
}

impl RoutedModel {
    fn main(source: RouteSource) -> Self {
        Self {
            seat: None,
            provider: None,
            model: None,
            thinking: None,
            source,
        }
    }

    fn seat(entry: &SubagentModelEntry, source: RouteSource) -> Self {
        Self {
            seat: Some(entry.name.clone()),
            provider: Some(entry.provider.clone()),
            model: Some(entry.model.clone()),
            thinking: entry.thinking.clone(),
            source,
        }
    }
}

/// Route one spawn. `provider_known` says whether a provider id can run a
/// request (an agent file's `provider/model` is skipped otherwise).
pub fn resolve_model(
    settings: &SubagentSettings,
    requested: Option<&str>,
    agent_model: Option<&str>,
    provider_known: impl Fn(&str) -> bool,
) -> Result<RoutedModel, String> {
    let named = |name: &str, source| {
        if name == MAIN_MODEL {
            Some(RoutedModel::main(source))
        } else {
            settings
                .entry(name)
                .map(|entry| RoutedModel::seat(entry, source))
        }
    };

    if let Some(name) = requested.map(str::trim).filter(|n| !n.is_empty()) {
        if settings.picks() {
            return named(name, RouteSource::Picked).ok_or_else(|| unknown_model(settings, name));
        }
        tracing::info!(
            model = name,
            "subagent model picks are off; ignoring the requested model"
        );
    }

    if let Some(preference) = agent_model.map(str::trim).filter(|m| !m.is_empty()) {
        if let Some(routed) = named(preference, RouteSource::AgentFile) {
            return Ok(routed);
        }
        match preference.split_once('/') {
            Some((provider, model)) if !model.is_empty() && provider_known(provider) => {
                return Ok(RoutedModel {
                    seat: None,
                    provider: Some(provider.to_string()),
                    model: Some(model.to_string()),
                    thinking: None,
                    source: RouteSource::AgentFile,
                });
            }
            _ => tracing::warn!(
                model = preference,
                "agent file names a model that is neither on the subagent model list nor on a connected provider; ignoring it"
            ),
        }
    }

    if let Some(routed) = settings
        .default_name()
        .and_then(|name| named(name, RouteSource::Default))
    {
        return Ok(routed);
    }

    Ok(RoutedModel::main(RouteSource::Inherited))
}

fn unknown_model(settings: &SubagentSettings, name: &str) -> String {
    if settings.models.is_empty() {
        return format!(
            "Unknown model '{name}': no subagent models are configured. Omit `model` to use the default."
        );
    }
    let names: Vec<&str> = settings
        .models
        .iter()
        .map(|entry| entry.name.as_str())
        .chain(std::iter::once(MAIN_MODEL))
        .collect();
    format!(
        "Unknown model '{name}'. Choose one of: {}, or omit `model` to use the default.",
        names.join(", ")
    )
}

/// One line per pickable model for the `task` description: name, price and
/// window when known, and the user's note.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelMenuEntry {
    pub name: String,
    /// `free`, `$0.60/M`, or empty when unpriced.
    pub price: String,
    /// Context window in tokens, 0 when unknown.
    pub context: u32,
    pub use_for: String,
}

/// The menu the orchestrator reads, in list order, priced from the model
/// metadata the turn already resolves (registry, live data, catalog).
pub fn model_menu(
    settings: &SubagentSettings,
    lookup: impl Fn(&str, &str) -> (crate::catalog::ModelCost, u32),
) -> Vec<ModelMenuEntry> {
    settings
        .pickable()
        .iter()
        .map(|entry| {
            let (cost, context) = lookup(&entry.provider, &entry.model);
            ModelMenuEntry {
                name: entry.name.clone(),
                price: price_label(&entry.model, &cost),
                context,
                use_for: entry.use_for.trim().to_string(),
            }
        })
        .collect()
}

/// Input price per million tokens, or `free` for a `:free` model.
pub fn price_label(model: &str, cost: &crate::catalog::ModelCost) -> String {
    if cost.input > 0.0 || cost.output > 0.0 {
        let input = cost.input;
        if input >= 0.01 {
            format!("${input:.2}/M")
        } else {
            format!("${input:.3}/M")
        }
    } else if model.ends_with(":free") {
        "free".into()
    } else {
        String::new()
    }
}

/// The `task` description block. Byte-stable for the same list, so the
/// cached prompt prefix only changes when the user edits the list.
pub fn menu_text(menu: &[ModelMenuEntry]) -> String {
    if menu.is_empty() {
        return String::new();
    }
    let mut out = String::from("\nModels you can assign (pass `model`):");
    for entry in menu {
        let mut facts: Vec<String> = Vec::new();
        if !entry.price.is_empty() {
            facts.push(entry.price.clone());
        }
        if entry.context > 0 {
            facts.push(format!("{}k", entry.context / 1000));
        }
        out.push_str(&format!("\n- {}", entry.name));
        if !facts.is_empty() {
            out.push_str(&format!(" \u{2014} {}", facts.join(" \u{b7} ")));
        }
        if !entry.use_for.is_empty() {
            out.push_str(&format!(" \u{2014} {}", entry.use_for.replace('\n', " ")));
        }
    }
    out.push_str("\n- main \u{2014} your own model.");
    out.push_str(
        "\nPick the model whose note fits the task; omit `model` to use the user's default.",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, provider: &str, model: &str) -> SubagentModelEntry {
        SubagentModelEntry {
            name: name.into(),
            provider: provider.into(),
            model: model.into(),
            thinking: Some("low".into()),
            use_for: format!("{name} work"),
        }
    }

    fn settings(picks: Option<bool>) -> SubagentSettings {
        SubagentSettings {
            orchestrator_picks: picks,
            models: vec![
                entry("scout", "openrouter", "qwen/qwen3-coder:free"),
                entry("builder", "glm", "glm-5"),
            ],
            default_model: Some("scout".into()),
        }
    }

    fn route(
        settings: &SubagentSettings,
        requested: Option<&str>,
        file: Option<&str>,
    ) -> Result<RoutedModel, String> {
        resolve_model(settings, requested, file, |p| p == "deepseek")
    }

    #[test]
    fn the_orchestrators_pick_wins_when_picking_is_on() {
        let s = settings(None);
        let r = route(&s, Some("builder"), Some("scout")).unwrap();
        assert_eq!(r.seat.as_deref(), Some("builder"));
        assert_eq!(r.provider.as_deref(), Some("glm"));
        assert_eq!(r.model.as_deref(), Some("glm-5"));
        assert_eq!(r.thinking.as_deref(), Some("low"));
        assert_eq!(r.source, RouteSource::Picked);
        let main = route(&s, Some("main"), None).unwrap();
        assert_eq!(
            (main.seat, main.model, main.source),
            (None, None, RouteSource::Picked)
        );
    }

    #[test]
    fn an_unknown_pick_fails_and_lists_the_names() {
        let err = route(&settings(None), Some("gpt-9"), None).unwrap_err();
        assert!(err.contains("scout, builder, main"), "{err}");
        let err = route(&SubagentSettings::default(), Some("scout"), None).unwrap_err();
        assert!(err.contains("no subagent models"), "{err}");
    }

    #[test]
    fn with_picking_off_the_default_decides() {
        let s = settings(Some(false));
        let r = route(&s, Some("builder"), None).unwrap();
        assert_eq!(
            (r.seat.as_deref(), r.source),
            (Some("scout"), RouteSource::Default)
        );
        // Even an unknown name is ignored rather than failing.
        assert!(route(&s, Some("gpt-9"), None).is_ok());
    }

    #[test]
    fn precedence_agent_file_then_default_then_main() {
        let s = settings(None);
        // A preset's `model:` beats the default: a list name, main, or provider/model.
        let r = route(&s, None, Some("builder")).unwrap();
        assert_eq!(
            (r.seat.as_deref(), r.source),
            (Some("builder"), RouteSource::AgentFile)
        );
        let r = route(&s, None, Some("main")).unwrap();
        assert_eq!((r.model, r.source), (None, RouteSource::AgentFile));
        let r = route(&s, None, Some("deepseek/deepseek-pro")).unwrap();
        assert_eq!(r.provider.as_deref(), Some("deepseek"));
        assert_eq!(r.model.as_deref(), Some("deepseek-pro"));
        assert_eq!(r.seat, None);
        // An unconnected provider is skipped, falling to the default.
        let r = route(&s, None, Some("nowhere/x")).unwrap();
        assert_eq!(
            (r.seat.as_deref(), r.source),
            (Some("scout"), RouteSource::Default)
        );
        // Nothing set: the parent's model.
        let r = route(&SubagentSettings::default(), None, None).unwrap();
        assert_eq!(r, RoutedModel::main(RouteSource::Inherited));
    }

    #[test]
    fn a_default_naming_a_removed_model_is_skipped() {
        let mut s = settings(None);
        s.default_model = Some("gone".into());
        let r = route(&s, None, None).unwrap();
        assert_eq!(r.source, RouteSource::Inherited);
    }

    #[test]
    fn the_menu_reads_price_window_and_note_and_is_stable() {
        let s = settings(None);
        let lookup = |_: &str, model: &str| {
            let mut cost = crate::catalog::ModelCost::default();
            if model == "glm-5" {
                cost.input = 0.6;
                cost.output = 2.2;
            }
            (cost, if model == "glm-5" { 200_000 } else { 262_144 })
        };
        let menu = model_menu(&s, lookup);
        let text = menu_text(&menu);
        assert_eq!(
            text,
            "\nModels you can assign (pass `model`):\
             \n- scout \u{2014} free \u{b7} 262k \u{2014} scout work\
             \n- builder \u{2014} $0.60/M \u{b7} 200k \u{2014} builder work\
             \n- main \u{2014} your own model.\
             \nPick the model whose note fits the task; omit `model` to use the user's default."
        );
        assert_eq!(menu_text(&model_menu(&s, lookup)), text);
        assert!(model_menu(&settings(Some(false)), lookup).is_empty());
        assert_eq!(menu_text(&[]), "");
    }
}
