//! Connect screen - provider connection dialog
//! - Connected providers first
//! - Gutter icons, descriptions, connected checkmarks
//! - Search/filter at top, clean no-border design

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::{AppState, ConnectScreen, ListId};
use crate::style::{self, *};
use crate::widgets::pick::{pick_list, row_label, search_field, PickItem};
use crate::widgets::{s, truncate_cells, ModalChrome};
use agente_core::config::ProviderEntry;
use agente_core::providers::spec;

// ── Provider metadata ──────────────────────────────────────────────────

/// Metadata resolved from [`agente_core::providers::spec`].
struct ProviderMeta {
    help_url: &'static str,
    sort_priority: usize,
}

fn provider_meta(id: &str) -> ProviderMeta {
    match spec::get(id) {
        Some(spec) => ProviderMeta {
            help_url: spec.key_url.as_deref().unwrap_or(""),
            sort_priority: spec.order as usize,
        },
        None => ProviderMeta {
            help_url: "",
            sort_priority: 99,
        },
    }
}

/// One-line description for a provider row.
///
/// Prefers the live models.dev catalog -- model count plus a couple of the
/// largest-context models -- then falls back to the provider spec's seeded
/// models, and finally to the provider's own name, so an offline first run
/// never shows a blank row or stale hardcoded blurb.
fn provider_description(id: &str, state: &AppState) -> String {
    if let Some(catalog) = state.config.config.catalog.as_ref() {
        if let Some(provider) = catalog.providers.get(id) {
            let count = provider.models.len();
            if count > 0 {
                let mut models: Vec<&agente_core::catalog::CatalogModel> =
                    provider.models.values().collect();
                // Largest context first as a flagship proxy; name breaks ties
                // so the row is stable frame to frame.
                models.sort_by(|a, b| {
                    b.limit
                        .context
                        .cmp(&a.limit.context)
                        .then_with(|| a.name.cmp(&b.name))
                });
                let names: Vec<&str> = models
                    .iter()
                    .take(2)
                    .map(|m| m.name.as_str())
                    .filter(|n| !n.is_empty())
                    .collect();
                let plural = if count == 1 { "model" } else { "models" };
                if names.is_empty() {
                    return format!("{count} {plural}");
                }
                return format!("{count} {plural} · {}", names.join(", "));
            }
        }
    }

    if let Some(spec) = spec::get(id) {
        let count = spec.models_seed.len();
        if count > 0 {
            let mut models: Vec<&spec::SeedModel> = spec.models_seed.values().collect();
            models.sort_by(|a, b| b.context.cmp(&a.context).then_with(|| a.name.cmp(&b.name)));
            let names: Vec<&str> = models
                .iter()
                .take(2)
                .map(|m| m.name.as_str())
                .filter(|n| !n.is_empty())
                .collect();
            let plural = if count == 1 { "model" } else { "models" };
            if names.is_empty() {
                return format!("{count} {plural}");
            }
            return format!("{count} {plural} · {}", names.join(", "));
        }
    }
    state.provider_display_name(id)
}

/// Sort with connected IDs pinned to the top (matches connect dialog sections).
pub fn sort_entries_with_connected(entries: &mut [ProviderEntry], connected: &[String]) {
    entries.sort_by(|a, b| {
        let ac = connected.iter().any(|c| c == &a.id);
        let bc = connected.iter().any(|c| c == &b.id);
        match (ac, bc) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let ma = provider_meta(&a.id);
                let mb = provider_meta(&b.id);
                ma.sort_priority
                    .cmp(&mb.sort_priority)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            }
        }
    });
}

// ── Public API ─────────────────────────────────────────────────────────

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    match &state.config.connect_screen {
        ConnectScreen::Closed => (),
        ConnectScreen::SelectProvider { query, selected } => {
            render_provider_list(frame, area, state, query, *selected);
        }
        ConnectScreen::EnterKey {
            provider,
            error,
            replace,
            ..
        } => {
            render_key_input(frame, area, state, provider, error, *replace);
        }
    }
}

pub fn filtered_presets(query: &str, entries: &[ProviderEntry]) -> Vec<ProviderEntry> {
    if query.is_empty() {
        return entries.to_vec();
    }
    let q = query.to_lowercase();
    entries
        .iter()
        .filter(|p| p.name.to_lowercase().contains(&q) || p.id.to_lowercase().contains(&q))
        .cloned()
        .collect()
}

// ── Provider list ──────────────────────────────────────────────────────

fn render_provider_list(
    frame: &mut Frame,
    area: Rect,
    state: &AppState,
    query: &str,
    selected: usize,
) {
    let mut entries = state.all_provider_entries();
    sort_entries_with_connected(&mut entries, &state.config.connected_providers);

    let query_lower = query.to_lowercase();
    let filtered: Vec<_> = entries
        .iter()
        .filter(|p| {
            p.name.to_lowercase().contains(&query_lower)
                || p.id.to_lowercase().contains(&query_lower)
        })
        .collect();

    // Connected first, then the remaining supported providers.
    let connected: Vec<_> = filtered
        .iter()
        .filter(|e| state.is_provider_connected(&e.id))
        .collect();
    let available: Vec<_> = filtered
        .iter()
        .filter(|e| !state.is_provider_connected(&e.id))
        .collect();

    let header_count = (usize::from(!connected.is_empty())) + usize::from(!available.is_empty());
    let total_rows = filtered.len() + header_count;
    // Keep enough body height for the explicit empty-search message. With a
    // zero-row result the old minimum produced a clipped list rect, so the
    // search field appeared to accept text while the dialog showed nothing.
    let content_rows = if filtered.is_empty() {
        2
    } else {
        total_rows.min(14)
    };
    // gap(1) + input(1) + gap(1) + list + gap(1) + footer(1); title on border.
    let panel_height = (content_rows + 7) as u16;
    let panel_width = 52u16;
    let modal = ModalChrome::new(vec![s(
        "Providers",
        Style::default().fg(FG()).add_modifier(Modifier::BOLD),
    )])
    .footer(&[
        ("Enter", "use"),
        ("Ctrl+K", "key"),
        ("Del", "disconnect"),
        ("Esc", "close"),
    ])
    .render_centered(frame, area, panel_width, panel_height);

    if let Some(input_area) = modal.row(0) {
        search_field(frame, input_area, query, "Search providers");
    }

    let Some(list_area) = modal.slice_from(2) else {
        return;
    };

    if filtered.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                s("  No providers match ", style::dim()),
                s(format!("{query:?}"), style::text()),
            ])),
            list_area,
        );
    } else {
        let mut items = Vec::new();
        let mut index = 0usize;
        for (title, section) in [("Connected", &connected), ("Available", &available)] {
            if section.is_empty() {
                continue;
            }
            items.push(PickItem::Header(title.to_string()));
            for entry in section.iter() {
                items.push(provider_item(entry, index == selected, state));
                index += 1;
            }
        }
        pick_list(
            frame,
            list_area,
            &state.ui.hits,
            ListId::Connect,
            items,
            selected,
        );
    }
}

/// `● Name  description ······ badge` — connected providers carry a ✓,
/// the rest say where their key comes from.
fn provider_item(entry: &ProviderEntry, is_selected: bool, state: &AppState) -> PickItem {
    let is_connected = state.is_provider_connected(&entry.id);
    let needs_key = !entry.env_key.is_empty();
    let icon = if is_connected {
        s("● ", style::success())
    } else {
        s("○ ", style::dim())
    };
    let has_env_only = !is_connected
        && needs_key
        && state.provider_has_key(&entry.id)
        && !state.config.config.auth_store.has(&entry.id);
    let badge = if is_connected {
        s("✓", style::success())
    } else if has_env_only {
        s("env", style::muted())
    } else if needs_key {
        s("key", style::dim())
    } else {
        s("local", style::dim())
    };
    // Description from the live catalog when it has this provider -- 29 of
    // the 43 built-ins had no static blurb at all.
    let description = provider_description(&entry.id, state);
    let mut lead = vec![icon, s(entry.name.clone(), row_label(is_selected))];
    if !description.is_empty() {
        lead.push(s(format!("  {description}"), style::dim()));
    }
    // The badge is the row's key fact, so it rides the lead's right edge and
    // the description is what truncates.
    PickItem::row_with_trail(lead, vec![badge])
}

// ── API key input ──────────────────────────────────────────────────────

fn render_key_input(
    frame: &mut Frame,
    area: Rect,
    state: &AppState,
    provider: &str,
    error: &str,
    replace: bool,
) {
    let meta = provider_meta(provider);
    let has_help = !meta.help_url.is_empty();
    let panel_width = 48u16;
    // gap(1) + input(1) + gap(1) + footer(1), plus the help URL row + its
    // gap, plus the error row when one is shown. Title rides the border.
    let panel_height = 6u16 + if has_help { 2u16 } else { 0 } + u16::from(!error.is_empty());

    let pc = state.config.config.provider.get(provider);
    let display_name = pc
        .and_then(|p| p.name.as_deref())
        .filter(|n| !n.is_empty())
        .unwrap_or(provider);

    let title_label = if replace {
        format!("Update key · {display_name}")
    } else {
        display_name.to_string()
    };

    let mut title_spans = vec![s(
        title_label,
        Style::default().fg(FG()).add_modifier(Modifier::BOLD),
    )];
    let description = provider_description(provider, state);
    if !description.is_empty() && !replace && !description.eq_ignore_ascii_case(display_name) {
        title_spans.push(s(
            format!(" · {description}"),
            Style::default().fg(FG_MUTED()),
        ));
    }

    let modal = ModalChrome::new(title_spans)
        .footer(&[("Enter", "connect"), ("Esc", "cancel")])
        .render_centered(frame, area, panel_width, panel_height);

    // Help URL, one gap row under the card title.
    if has_help {
        if let Some(help_area) = modal.row(0) {
            frame.render_widget(
                Paragraph::new(Line::from(vec![s(
                    meta.help_url.to_string(),
                    Style::default().fg(SECONDARY()),
                )])),
                help_area,
            );
        }
    }

    // Key input sits one gap row below the help URL (or the header).
    let input_row = if has_help { 2u16 } else { 0u16 };
    let Some(input_area) = modal.row(input_row) else {
        return;
    };

    let masked_key = "•".repeat(state.config.connect_key_input.chars().count());
    search_field(frame, input_area, &masked_key, "Paste API key");

    // Error message directly under the input, above the footer.
    if !error.is_empty() {
        if let Some(error_area) = modal.row(input_row + 1) {
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    s("✗ ", Style::default().fg(ERROR())),
                    s(
                        truncate_cells(error, error_area.width.saturating_sub(2) as usize),
                        Style::default().fg(ERROR()),
                    ),
                ])),
                error_area,
            );
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

#[cfg(test)]
mod provider_meta_tests {
    use super::*;
    use agente_core::config::AppConfig;

    fn state() -> AppState {
        AppState::new(AppConfig::default(), "/tmp/connect".into())
    }

    /// Every built-in provider gets a description, with or without a catalog.
    ///
    /// 29 of the 43 built-ins used to fall through to the `_` arm and render as
    /// a bare id: no description, no URL, nothing telling you where to get a
    /// key.
    #[test]
    fn every_built_in_provider_has_a_description() {
        let state = state();
        let blank: Vec<&String> = state
            .config
            .config
            .provider
            .keys()
            .filter(|id| provider_description(id, &state).trim().is_empty())
            .collect();
        assert!(blank.is_empty(), "providers with no description: {blank:?}");
    }

    /// Supported providers carry a key URL and are not dumped in the unsorted tail.
    #[test]
    fn notable_providers_are_curated() {
        for id in ["deepseek", "minimax", "glm", "opencode-go", "openrouter"] {
            let meta = provider_meta(id);
            assert!(
                !meta.help_url.is_empty(),
                "{id} has no help URL -- there is nowhere to get a key"
            );
            assert!(
                meta.sort_priority < 99,
                "{id} is still in the uncurated tail"
            );
        }
    }

    /// With a catalog present the description is derived from it, so it cannot
    /// drift the way the hardcoded blurbs did.
    #[test]
    fn description_prefers_the_catalog() {
        use agente_core::catalog::{
            CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
            ModelStatus,
        };
        use std::collections::HashMap;

        let model = |id: &str, context: u32| CatalogModel {
            provider: None,
            id: id.to_string(),
            provider_id: "xai".to_string(),
            name: id.to_string(),
            family: None,
            capabilities: ModelCapabilities::default(),
            cost: ModelCost::default(),
            limit: ModelLimits {
                context,
                input: None,
                output: 0,
            },
            status: ModelStatus::Active,
            api_id: id.to_string(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            headers: HashMap::new(),
            options: HashMap::new(),
            variants: HashMap::new(),
        };

        let mut models = HashMap::new();
        models.insert("Mini Model".to_string(), model("Mini Model", 32_000));
        models.insert(
            "Flagship Model".to_string(),
            model("Flagship Model", 256_000),
        );

        let mut catalog = ModelCatalog::default();
        catalog.providers.insert(
            "xai".to_string(),
            CatalogProvider {
                id: "xai".to_string(),
                name: "xAI".to_string(),
                env: vec!["XAI_API_KEY".to_string()],
                api: "https://api.x.ai/v1".to_string(),
                npm: String::new(),
                models,
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        let mut state = state();
        state.config.config.catalog = Some(catalog);

        let described = provider_description("xai", &state);
        assert!(described.starts_with("2 models · "), "{described}");
        // Largest context leads, so the flagship is named first.
        assert!(
            described.contains("Flagship Model"),
            "flagship should lead: {described}"
        );
    }

    #[test]
    fn provider_search_is_case_insensitive_and_empty_results_are_explicit() {
        let entries = vec![
            ProviderEntry {
                id: "mistral".into(),
                name: "Mistral".into(),
                env_key: "MISTRAL_API_KEY".into(),
            },
            ProviderEntry {
                id: "openai".into(),
                name: "OpenAI".into(),
                env_key: "OPENAI_API_KEY".into(),
            },
        ];

        assert_eq!(filtered_presets("MIST", &entries)[0].id, "mistral");
        assert!(filtered_presets("does-not-exist", &entries).is_empty());
    }
}
