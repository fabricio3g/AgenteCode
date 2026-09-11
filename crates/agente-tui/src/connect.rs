//! Connect screen - provider connection dialog
//! - Providers grouped by category (Popular / Local / Other)
//! - Gutter icons, descriptions, connected checkmarks
//! - Search/filter at top, clean no-border design

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{List, ListItem, ListState, Paragraph};
use ratatui::Frame;

use crate::state::{AppState, ConnectScreen};
use crate::style::{self, *};
use crate::widgets::{
    centered_panel, footer_hints, modal_card, modal_footer, panel_row, s, truncate_cells,
};
use agente_core::config::ProviderEntry;

// ── Provider metadata ──────────────────────────────────────────────────

/// Provider categories for grouping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Category {
    Popular,
    Local,
    Other,
}

/// Static metadata for known providers.
struct ProviderMeta {
    description: &'static str,
    help_url: &'static str,
    category: Category,
    sort_priority: usize,
}

fn provider_meta(id: &str) -> ProviderMeta {
    match id {
        "openai" => ProviderMeta {
            description: "GPT-4o, GPT-4.5, o1, o3 and more",
            help_url: "https://platform.openai.com/api-keys",
            category: Category::Popular,
            sort_priority: 1,
        },
        "openrouter" => ProviderMeta {
            description: "100+ models via single API",
            help_url: "https://openrouter.ai/settings/keys",
            category: Category::Popular,
            sort_priority: 4,
        },
        "opencode" => ProviderMeta {
            description: "OpenCode Zen tested coding models",
            help_url: "https://opencode.ai/auth",
            category: Category::Popular,
            sort_priority: 3,
        },
        "deepseek" => ProviderMeta {
            description: "DeepSeek V3, R1 reasoning",
            help_url: "https://platform.deepseek.com/api_keys",
            category: Category::Popular,
            sort_priority: 5,
        },
        "groq" => ProviderMeta {
            description: "Ultra-fast inference",
            help_url: "https://console.groq.com/keys",
            category: Category::Popular,
            sort_priority: 6,
        },
        "github-copilot" => ProviderMeta {
            description: "GitHub Copilot models",
            help_url: "",
            category: Category::Popular,
            sort_priority: 7,
        },
        "ollama" => ProviderMeta {
            description: "Run models locally",
            help_url: "",
            category: Category::Local,
            sort_priority: 50,
        },
        "lmstudio" => ProviderMeta {
            description: "Run models locally",
            help_url: "",
            category: Category::Local,
            sort_priority: 51,
        },
        "minimax" => ProviderMeta {
            description: "MiniMax M2.7, M1, Text-01",
            help_url: "https://platform.minimax.io",
            category: Category::Other,
            sort_priority: 90,
        },
        "together" => ProviderMeta {
            description: "Open-source and licensed models",
            help_url: "https://api.together.ai",
            category: Category::Other,
            sort_priority: 91,
        },
        "fireworks" => ProviderMeta {
            description: "Fast open-weight inference",
            help_url: "https://fireworks.ai",
            category: Category::Other,
            sort_priority: 92,
        },
        "kimi-coding" => ProviderMeta {
            description: "Kimi For Coding",
            help_url: "https://platform.moonshot.cn",
            category: Category::Other,
            sort_priority: 93,
        },
        "xiaomi" => ProviderMeta {
            description: "MiMo models",
            help_url: "https://api.xiaomimimo.com",
            category: Category::Other,
            sort_priority: 94,
        },
        // Everything below had no entry at all and rendered as a bare id with
        // no description and nowhere to get a key. Descriptions are left thin
        // on purpose -- `provider_description` fills them from the live
        // models.dev catalog, so they cannot go stale.
        "xai" => ProviderMeta {
            description: "Grok models",
            help_url: "https://console.x.ai",
            category: Category::Popular,
            sort_priority: 8,
        },
        "mistral" => ProviderMeta {
            description: "Mistral Large, Codestral",
            help_url: "https://console.mistral.ai/api-keys",
            category: Category::Other,
            sort_priority: 80,
        },
        "cerebras" => ProviderMeta {
            description: "Wafer-scale fast inference",
            help_url: "https://cloud.cerebras.ai",
            category: Category::Other,
            sort_priority: 81,
        },
        "perplexity" => ProviderMeta {
            description: "Search-grounded models",
            help_url: "https://www.perplexity.ai/settings/api",
            category: Category::Other,
            sort_priority: 82,
        },
        "azure" => ProviderMeta {
            description: "Azure OpenAI deployments",
            help_url: "https://portal.azure.com",
            category: Category::Other,
            sort_priority: 83,
        },
        "amazon-bedrock" => ProviderMeta {
            description: "Bedrock-hosted models",
            help_url: "https://console.aws.amazon.com/bedrock",
            category: Category::Other,
            sort_priority: 84,
        },
        "nvidia" => ProviderMeta {
            description: "NIM-hosted open models",
            help_url: "https://build.nvidia.com",
            category: Category::Other,
            sort_priority: 85,
        },
        "moonshotai" | "moonshotai-cn" => ProviderMeta {
            description: "Kimi models",
            help_url: "https://platform.moonshot.ai/console/api-keys",
            category: Category::Other,
            sort_priority: 86,
        },
        "zai" | "zai-coding-plan" | "zai-coding-cn" => ProviderMeta {
            description: "GLM models",
            help_url: "https://z.ai",
            category: Category::Other,
            sort_priority: 87,
        },
        "alibaba" | "alibaba-cn" | "alibaba-coding-plan" | "alibaba-coding-plan-cn" => {
            ProviderMeta {
                description: "Qwen models",
                help_url: "https://dashscope.console.aliyun.com",
                category: Category::Other,
                sort_priority: 88,
            }
        }
        "siliconflow" => ProviderMeta {
            description: "Open-model inference",
            help_url: "https://cloud.siliconflow.cn",
            category: Category::Other,
            sort_priority: 95,
        },
        "baseten" => ProviderMeta {
            description: "Dedicated model endpoints",
            help_url: "https://app.baseten.co/settings/api_keys",
            category: Category::Other,
            sort_priority: 96,
        },
        "huggingface" => ProviderMeta {
            description: "Inference providers router",
            help_url: "https://huggingface.co/settings/tokens",
            category: Category::Other,
            sort_priority: 97,
        },
        "vercel-ai-gateway" => ProviderMeta {
            description: "Vercel AI Gateway",
            help_url: "https://vercel.com/dashboard/ai-gateway",
            category: Category::Other,
            sort_priority: 98,
        },
        _ => ProviderMeta {
            description: "",
            help_url: "",
            category: Category::Other,
            sort_priority: 99,
        },
    }
}

/// One-line description for a provider row.
///
/// Prefers the live models.dev catalog -- model count plus a couple of the
/// largest-context models -- so blurbs never go stale ("Claude 4 Sonnet" was
/// still shipping long after Claude 5). Falls back to the curated string, then
/// to the provider's own name, so an offline first run never shows a blank row.
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

    let fallback = provider_meta(id).description;
    if !fallback.is_empty() {
        return fallback.to_string();
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

    // Connected first, then remaining by category (exclude connected from later groups).
    let connected: Vec<_> = filtered
        .iter()
        .filter(|e| state.is_provider_connected(&e.id))
        .collect();
    let popular: Vec<_> = filtered
        .iter()
        .filter(|e| {
            !state.is_provider_connected(&e.id)
                && provider_meta(&e.id).category == Category::Popular
        })
        .collect();
    let local: Vec<_> = filtered
        .iter()
        .filter(|e| {
            !state.is_provider_connected(&e.id) && provider_meta(&e.id).category == Category::Local
        })
        .collect();
    let other: Vec<_> = filtered
        .iter()
        .filter(|e| {
            !state.is_provider_connected(&e.id) && provider_meta(&e.id).category == Category::Other
        })
        .collect();

    let header_count = (usize::from(!connected.is_empty()))
        + usize::from(!popular.is_empty())
        + usize::from(!local.is_empty())
        + usize::from(!other.is_empty());
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
    let panel = centered_panel(area, panel_width, panel_height);

    let body = modal_card(
        frame,
        panel,
        vec![s(
            "Providers",
            Style::default().fg(FG()).add_modifier(Modifier::BOLD),
        )],
    );

    // Body row 0 is the gap under the card title.
    if let Some(input_area) = panel_row(body, 1, 1) {
        render_search_input(frame, input_area, query);
    }

    let Some(list_top) = panel_row(body, 3, 1) else {
        return;
    };
    let list_area = Rect {
        height: body.height.saturating_sub(5),
        ..list_top
    };

    let mut items: Vec<ListItem> = Vec::new();
    let mut logical_idx = 0usize;

    if !connected.is_empty() {
        items.push(ListItem::new(Line::from(vec![
            s(" ", Style::default()),
            s(
                "Connected",
                Style::default().fg(FG_MUTED()).add_modifier(Modifier::BOLD),
            ),
        ])));
        for entry in &connected {
            items.push(provider_row(entry, logical_idx == selected, state));
            logical_idx += 1;
        }
    }
    if !popular.is_empty() {
        items.push(ListItem::new(Line::from(vec![
            s(" ", Style::default()),
            s(
                "Popular",
                Style::default().fg(FG_MUTED()).add_modifier(Modifier::BOLD),
            ),
        ])));
        for entry in &popular {
            items.push(provider_row(entry, logical_idx == selected, state));
            logical_idx += 1;
        }
    }
    if !local.is_empty() {
        items.push(ListItem::new(Line::from(vec![
            s(" ", Style::default()),
            s(
                "Local",
                Style::default().fg(FG_MUTED()).add_modifier(Modifier::BOLD),
            ),
        ])));
        for entry in &local {
            items.push(provider_row(entry, logical_idx == selected, state));
            logical_idx += 1;
        }
    }
    if !other.is_empty() {
        items.push(ListItem::new(Line::from(vec![
            s(" ", Style::default()),
            s(
                "Other",
                Style::default().fg(FG_MUTED()).add_modifier(Modifier::BOLD),
            ),
        ])));
        for entry in &other {
            items.push(provider_row(entry, logical_idx == selected, state));
            logical_idx += 1;
        }
    }

    let mut list_state = ListState::default();
    let visual_selected = logical_index_to_visual(&connected, &popular, &local, &other, selected);
    if !items.is_empty() {
        list_state.select(Some(visual_selected.min(items.len() - 1)));
    }

    let list = List::new(items);
    if filtered.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                s("  No providers match ", style::dim()),
                s(format!("{query:?}"), style::text()),
            ])),
            list_area,
        );
    } else {
        frame.render_stateful_widget(list, list_area, &mut list_state);
    }

    modal_footer(
        frame,
        body,
        footer_hints(
            &[
                ("↵", "use"),
                ("^k", "key"),
                ("del", "disconnect"),
                ("Esc", "close"),
            ],
            body.width.saturating_sub(2),
        ),
    );
}

fn render_search_input(frame: &mut Frame, area: Rect, query: &str) {
    let line = Line::from(vec![
        s("▸ ", style::accent()),
        s(query.to_string(), style::text()),
        s(
            "▌",
            Style::default()
                .fg(PRIMARY())
                .add_modifier(Modifier::SLOW_BLINK),
        ),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

/// Build a single provider row as a ListItem.
fn provider_row(entry: &ProviderEntry, is_selected: bool, state: &AppState) -> ListItem<'static> {
    let is_connected = state.is_provider_connected(&entry.id);
    let needs_key = !entry.env_key.is_empty();

    let (icon_style, name_style, desc_style, check_style) = if is_selected {
        (
            Style::default().fg(PRIMARY()),
            Style::default().fg(FG()).add_modifier(Modifier::BOLD),
            Style::default().fg(FG_MUTED()),
            Style::default().fg(PRIMARY()),
        )
    } else if is_connected {
        (
            Style::default().fg(SUCCESS()),
            Style::default().fg(FG()),
            Style::default().fg(FG_DIM()),
            Style::default().fg(SUCCESS()),
        )
    } else {
        (
            Style::default().fg(FG_DIM()),
            Style::default().fg(FG()),
            Style::default().fg(FG_DIM()),
            Style::default().fg(SUCCESS()),
        )
    };

    let icon = if is_connected { "●" } else { "○" };

    // Checkmark for connected providers.
    let check = if is_connected {
        s(" ✓", check_style)
    } else {
        s("", Style::default())
    };

    // Badges: env (key from environment), key needed, or nothing when connected.
    let has_env_only = !is_connected
        && needs_key
        && state.provider_has_key(&entry.id)
        && !state.config.config.auth_store.has(&entry.id);
    let key_indicator = if is_connected {
        s("", Style::default())
    } else if has_env_only {
        s("  env", Style::default().fg(SUCCESS()))
    } else if needs_key {
        s("  key", Style::default().fg(WARNING()))
    } else {
        s("  local", Style::default().fg(FG_DIM()))
    };

    // Description text (short), from the live catalog when it has this
    // provider -- 29 of the 43 built-ins had no static blurb at all.
    let description = provider_description(&entry.id, state);
    let desc_text = if description.is_empty() {
        String::new()
    } else {
        format!("  {description}")
    };

    let mut spans = vec![
        s("  ", Style::default()),
        s(icon, icon_style),
        s(" ", Style::default()),
        s(entry.name.clone(), name_style),
    ];

    if !desc_text.is_empty() && !is_selected {
        // Keep selected row short so actions stay readable.
        spans.push(s(desc_text, desc_style));
    } else if !desc_text.is_empty() {
        spans.push(s(desc_text, desc_style));
    }

    spans.push(check);
    spans.push(key_indicator);

    ListItem::new(Line::from(spans))
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
    let panel = centered_panel(area, panel_width, panel_height);

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
    if !description.is_empty() && !replace {
        title_spans.push(s(
            format!(" · {description}"),
            Style::default().fg(FG_MUTED()),
        ));
    }

    let body = modal_card(frame, panel, title_spans);

    // Help URL, one gap row under the card title.
    if has_help {
        if let Some(help_area) = panel_row(body, 1, 1) {
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
    let input_row = if has_help { 3u16 } else { 1u16 };
    let Some(input_area) = panel_row(body, input_row, 1) else {
        return;
    };

    let masked_key = "•".repeat(state.config.connect_key_input.chars().count());
    let key_text = if masked_key.is_empty() {
        "API key".to_string()
    } else {
        truncate_cells(&masked_key, input_area.width.saturating_sub(4) as usize)
    };
    let key_style = if state.config.connect_key_input.is_empty() {
        style::dim()
    } else {
        style::text()
    };
    let key_line = Line::from(vec![
        s("▸ ", style::accent()),
        s(key_text, key_style),
        s(
            "▌",
            Style::default()
                .fg(PRIMARY())
                .add_modifier(Modifier::SLOW_BLINK),
        ),
    ]);
    frame.render_widget(Paragraph::new(key_line), input_area);

    // Error message directly under the input, above the footer.
    if !error.is_empty() {
        if let Some(error_area) = panel_row(body, input_row + 1, 1) {
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

    modal_footer(
        frame,
        body,
        footer_hints(
            &[("↵", "connect"), ("Esc", "cancel")],
            body.width.saturating_sub(2),
        ),
    );
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Map a logical provider index (0-based, headers excluded) to the visual
/// row index in the flat items list (headers included).
fn logical_index_to_visual(
    connected: &[&&ProviderEntry],
    popular: &[&&ProviderEntry],
    local: &[&&ProviderEntry],
    other: &[&&ProviderEntry],
    logical: usize,
) -> usize {
    let mut visual = 0usize;
    let mut remaining = logical;

    for section in [connected, popular, local, other] {
        if !section.is_empty() {
            visual += 1; // header
        }
        if remaining < section.len() {
            return visual + remaining;
        }
        visual += section.len();
        remaining -= section.len();
    }

    visual + remaining
}

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

    /// The notable providers are curated: they carry a key URL and are not
    /// dumped in the unsorted tail.
    #[test]
    fn notable_providers_are_curated() {
        for id in [
            "xai",
            "mistral",
            "cerebras",
            "perplexity",
            "azure",
            "amazon-bedrock",
            "nvidia",
            "moonshotai",
            "zai",
            "alibaba",
        ] {
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
