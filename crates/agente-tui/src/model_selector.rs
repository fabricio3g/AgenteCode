//! Model selector - minimal floating select dialog
//! - Clean floating panel
//! - Simple provider grouping
//! - Minimal UI, keyboard-first

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{List, ListItem, ListState, Paragraph};
use ratatui::Frame;

use crate::state::{AppState, DiscoveryStatus, ModelEntry};
use crate::style::{self, *};
use crate::widgets::hints::format_token_count;
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, panel_row, s};

/// Models matching the free-text query, optionally scoped to one provider.
///
/// `provider: None` means "every connected provider" -- a state the old design
/// could not express, because the provider *was* the query string.
pub fn filter_models<'a>(
    query: &str,
    provider: Option<&str>,
    models: &'a [ModelEntry],
) -> Vec<&'a ModelEntry> {
    let query_lower = query.to_lowercase();
    models
        .iter()
        .filter(|m| match provider {
            Some(id) => m.provider.eq_ignore_ascii_case(id),
            None => true,
        })
        .filter(|m| {
            query_lower.is_empty()
                || m.display_name.to_lowercase().contains(&query_lower)
                || m.provider.to_lowercase().contains(&query_lower)
                || m.model_id.to_lowercase().contains(&query_lower)
        })
        .collect()
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_model_selector {
        return;
    }

    let all_entries: Vec<ModelEntry> = state
        .get_all_model_entries()
        .into_iter()
        .filter(|e| state.is_provider_connected(&e.provider))
        .collect();
    let scope = state.input.model_selector_provider.as_deref();
    let filtered = filter_models(&state.input.model_selector_query, scope, &all_entries);

    // `debug!`, not `info!`: this runs on every frame the selector is open.
    tracing::debug!(
        connected = ?state.config.connected_providers,
        query = %state.input.model_selector_query,
        all_entries = all_entries.len(),
        filtered = filtered.len(),
        current_provider = %state.config.current_provider,
        current_model = %state.config.current_model,
        "model_selector render"
    );

    // Query edits change the rows, not the panel's position or dimensions.
    // Count provider headings as well as models when sizing the list.
    let provider_rows = all_entries
        .iter()
        .enumerate()
        .filter(|(i, entry)| *i == 0 || all_entries[*i - 1].provider != entry.provider)
        .count();
    let content_rows = (all_entries.len() + provider_rows).clamp(3, 12);

    // gap(1) + input(1) + gap(1) + list + gap(1) + footer(1); title on border.
    let panel_height = (content_rows + 7) as u16;
    // Wide enough for the longest visible entry (router ids like
    // `nvidia/nemotron-3.5-lightning:free` overflowed the old fixed 48) and for
    // every footer segment, but never wider than the area.
    let widest = all_entries
        .iter()
        .map(|entry| crate::widgets::display_width(&entry.display_name) + 12)
        .max()
        .unwrap_or(0);
    let panel_width = (widest.clamp(48, 78) as u16).min(area.width);
    let panel = centered_panel(area, panel_width, panel_height);

    let visible_statuses: Vec<_> = state
        .config
        .connected_providers
        .iter()
        .filter(|provider| scope.is_none_or(|scope| scope == provider.as_str()))
        .filter_map(|provider| state.config.discovery_status.get(provider))
        .collect();
    let refreshing = state.config.catalog_refresh_status == DiscoveryStatus::InProgress
        || visible_statuses
            .iter()
            .any(|status| matches!(status, DiscoveryStatus::InProgress));
    let refresh_error = visible_statuses
        .iter()
        .find_map(|status| match status {
            DiscoveryStatus::Failed(error) => Some(error.as_str()),
            _ => None,
        })
        .or(match &state.config.catalog_refresh_status {
            DiscoveryStatus::Failed(error) => Some(error.as_str()),
            _ => None,
        });
    let mut title_spans = vec![s("Switch model", style::bold())];
    let badge = if refreshing { "  ◌ refreshing" } else { "" };
    let suffix_budget = (panel.width.saturating_sub(4) as usize)
        .saturating_sub(12 + crate::widgets::display_width(badge) + 5);
    if !state.config.current_model.is_empty() && suffix_budget > 0 {
        let display = state
            .get_model_display_name(&state.config.current_provider, &state.config.current_model);
        title_spans.push(s(
            format!(
                " · ◈ {}",
                crate::widgets::truncate_cells(&display, suffix_budget)
            ),
            style::dim(),
        ));
    }
    if refreshing {
        title_spans.push(s(badge, style::accent()));
    }

    let body = modal_card(frame, panel, title_spans);
    if let Some(error) = refresh_error {
        if let Some(row) = panel_row(body, 2, 1) {
            frame.render_widget(
                Paragraph::new(s(
                    crate::widgets::truncate_cells(
                        &format!("Refresh failed: {error}"),
                        row.width as usize,
                    ),
                    style::error(),
                )),
                row,
            );
        }
    }

    // Row 0 of the body is the gap under the card title.

    // Input line
    if let Some(input_area) = panel_row(body, 1, 1) {
        render_input(frame, input_area, state);
    }

    // Model list or empty message. Body row 2 is a gap; the last body row is
    // the gap above the footer.
    let Some(list_top) = panel_row(body, 3, 1) else {
        return;
    };
    let list_area = Rect {
        height: body.height.saturating_sub(5),
        ..list_top
    };

    if !state.is_connected() {
        // No providers connected at all - guide user to connect
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(vec![s(
                    "  No providers connected",
                    Style::default().fg(FG_DIM()),
                )]),
                Line::from(vec![]),
                Line::from(vec![
                    s("  Press ", Style::default().fg(FG_MUTED())),
                    s(
                        "^P",
                        Style::default().fg(PRIMARY()).add_modifier(Modifier::BOLD),
                    ),
                    s(" to open menu → ", Style::default().fg(FG_MUTED())),
                    s("Connect a provider", Style::default().fg(PRIMARY())),
                ]),
            ]),
            list_area,
        );
    } else if filtered.is_empty() {
        let in_progress = state.config.connected_providers.iter().any(|provider| {
            matches!(
                state.config.discovery_status.get(provider),
                Some(DiscoveryStatus::InProgress)
            )
        });
        let failure = state
            .config
            .connected_providers
            .iter()
            .find_map(
                |provider| match state.config.discovery_status.get(provider) {
                    Some(DiscoveryStatus::Failed(error)) => Some(error.as_str()),
                    _ => None,
                },
            );
        let lines = if in_progress {
            vec![
                Line::from(vec![
                    s("  ◌ ", style::accent()),
                    s("Discovering models…", style::text()),
                ]),
                Line::from(""),
                Line::from(s("  This closes when models load", style::dim())),
            ]
        } else if let Some(error) = failure {
            vec![
                Line::from(vec![
                    s("  ✕ ", style::error()),
                    s("Could not list models", style::text()),
                ]),
                Line::from(s(format!("  {error}"), style::dim())),
                Line::from(s("  /provider  then  ^k  to update key", style::muted())),
            ]
        } else {
            vec![
                Line::from(s("  No models yet", style::dim())),
                Line::from(""),
                Line::from(s("  /provider to switch or reconnect", style::muted())),
            ]
        };
        frame.render_widget(Paragraph::new(lines), list_area);
    } else {
        render_models(frame, list_area, state, &filtered);
    }

    // Footer
    modal_footer(
        frame,
        body,
        footer_hints(
            &[
                ("↑↓", "nav"),
                ("Tab", "provider"),
                ("^R", "refresh"),
                ("Esc", "close"),
            ],
            body.width.saturating_sub(2),
        ),
    );
}

fn render_input(frame: &mut Frame, area: Rect, state: &AppState) {
    let query = &state.input.model_selector_query;

    let query_text = if query.is_empty() {
        "Filter models"
    } else {
        query
    };
    let query_style = if query.is_empty() {
        style::dim()
    } else {
        style::text()
    };
    let mut spans = vec![
        s("▸ ".to_string(), style::accent()),
        s(query_text.to_string(), query_style),
        s(
            "▌".to_string(),
            Style::default()
                .fg(PRIMARY())
                .add_modifier(Modifier::SLOW_BLINK),
        ),
    ];

    // Provider scope chip, right-aligned. Typing never changes it and cycling
    // it never changes the query -- they are separate state now.
    let chip = match state.input.model_selector_provider.as_deref() {
        Some(id) => format!("⌥ {}", state.provider_display_name(id)),
        None => "⌥ all providers".to_string(),
    };
    let used: usize = spans
        .iter()
        .map(|sp| crate::widgets::display_width(sp.content.as_ref()))
        .sum();
    let chip_w = crate::widgets::display_width(&chip);
    let width = area.width as usize;
    if used + chip_w + 2 <= width {
        spans.push(s(" ".repeat(width - used - chip_w), Style::default()));
        spans.push(s(chip, style::muted()));
    }

    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_models(frame: &mut Frame, area: Rect, state: &AppState, models: &[&ModelEntry]) {
    let mut current_provider = String::new();
    let mut items: Vec<ListItem> = Vec::new();
    let mut model_to_visual: Vec<usize> = Vec::new();

    for (actual_index, entry) in models.iter().enumerate() {
        // Provider header
        if entry.provider != current_provider {
            current_provider = entry.provider.clone();
            let provider_name = state.get_provider_display_name(&entry.provider);
            items.push(ListItem::new(Line::from(vec![
                s("  ".to_string(), Style::default()),
                s(
                    provider_name,
                    Style::default().fg(FG_MUTED()).add_modifier(Modifier::BOLD),
                ),
            ])));
        }

        // Track visual index for this model
        model_to_visual.push(items.len());

        let is_selected = actual_index == state.input.model_selector_selected;
        let is_current = entry.model_id == state.config.current_model
            && entry.provider == state.config.current_provider;

        let (prefix_style, text_style) = if is_selected {
            (
                Style::default().fg(PRIMARY()),
                Style::default().fg(FG()).add_modifier(Modifier::BOLD),
            )
        } else if is_current {
            (
                Style::default().fg(SUCCESS()),
                Style::default().fg(SUCCESS()),
            )
        } else {
            (Style::default().fg(FG_DIM()), Style::default().fg(FG()))
        };

        let prefix = if is_selected {
            "▸ "
        } else if is_current {
            "◈ "
        } else {
            "  "
        };

        let mut row = vec![s(prefix.to_string(), prefix_style)];
        row.push(s(entry.display_name.clone(), text_style));

        // Right-aligned context window (e.g. "200k"), when known.
        if let Some(window) = entry.context_window {
            let window_str = format_token_count(window as usize);
            let name_len = entry.display_name.chars().count();
            let available = area.width.saturating_sub(2) as usize;
            let padding = available.saturating_sub(2 + name_len + 1 + window_str.len());
            if padding > 1 {
                row.push(s(" ".repeat(padding), Style::default()));
                row.push(s(
                    window_str,
                    Style::default().fg(if is_selected { PRIMARY() } else { FG_DIM() }),
                ));
            }
        }

        items.push(ListItem::new(Line::from(row)));
    }

    let mut list_state = ListState::default();
    if !models.is_empty() && !model_to_visual.is_empty() {
        let sel = state
            .input
            .model_selector_selected
            .min(model_to_visual.len() - 1);
        list_state.select(Some(model_to_visual[sel]));
    }

    let list = List::new(items);
    frame.render_stateful_widget(list, area, &mut list_state);
}
