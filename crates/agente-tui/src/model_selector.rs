//! Model selector - minimal floating select dialog
//! - Clean floating panel
//! - Simple provider grouping
//! - Minimal UI, keyboard-first

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::{AppState, DiscoveryStatus, ListId, ModelEntry};
use crate::style::{self, *};
use crate::widgets::hints::format_token_count;
use crate::widgets::pick::{current_mark, pick_list, row_label, search_field, PickItem};
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
    let title = match state.input.model_selector_target.as_deref() {
        Some(target) => format!("Model for {}", crate::subagent_models::type_label(target)),
        None => "Switch model".to_string(),
    };
    let mut title_spans = vec![s(title, style::bold())];
    let badge = if refreshing { "  ◌ refreshing" } else { "" };
    let suffix_budget = (panel.width.saturating_sub(4) as usize)
        .saturating_sub(12 + crate::widgets::display_width(badge) + 5);
    if let Some((provider, model)) = model_in_effect(state).filter(|_| suffix_budget > 0) {
        let display = state.get_model_display_name(provider, model);
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
                        "Ctrl+P",
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
                Line::from(s(
                    "  /provider  then  Ctrl+K  to update key",
                    style::muted(),
                )),
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
                ("↑↓", "move"),
                ("Tab", "provider"),
                ("Ctrl+R", "refresh"),
                ("Esc", "close"),
            ],
            body.width.saturating_sub(2),
        ),
    );
}

fn render_input(frame: &mut Frame, area: Rect, state: &AppState) {
    search_field(
        frame,
        area,
        &state.input.model_selector_query,
        "Filter models",
    );

    // Provider scope chip, right-aligned on the field. Typing never changes it
    // and cycling it never changes the query -- they are separate state.
    let chip = match state.input.model_selector_provider.as_deref() {
        Some(id) => format!("⌥ {} ", state.provider_display_name(id)),
        None => "⌥ all providers ".to_string(),
    };
    let chip_w = crate::widgets::display_width(&chip) as u16;
    let query_w = crate::widgets::display_width(&state.input.model_selector_query) as u16;
    if query_w + chip_w + 6 <= area.width {
        frame.render_widget(
            Paragraph::new(s(chip, style::muted().bg(BG_ELEMENT()))),
            Rect::new(area.right() - chip_w, area.y, chip_w, 1),
        );
    }
}

/// The `(provider, model)` the picker marks with `◈`: the main model, or
/// the chosen subagent type's override when picking for one.
fn model_in_effect(state: &AppState) -> Option<(&str, &str)> {
    match state.input.model_selector_target.as_deref() {
        Some(target) => state
            .config
            .config
            .subagent_models
            .get(target)
            .map(|m| (m.provider.as_str(), m.model.as_str())),
        None => (!state.config.current_model.is_empty()).then_some((
            state.config.current_provider.as_str(),
            state.config.current_model.as_str(),
        )),
    }
}

fn render_models(frame: &mut Frame, area: Rect, state: &AppState, models: &[&ModelEntry]) {
    let in_effect = model_in_effect(state);
    let selected = state.input.model_selector_selected;
    let mut items = Vec::new();
    let mut current_provider = "";
    for (index, entry) in models.iter().enumerate() {
        if entry.provider != current_provider {
            current_provider = &entry.provider;
            items.push(PickItem::Header(
                state.get_provider_display_name(&entry.provider),
            ));
        }
        let is_current = in_effect == Some((entry.provider.as_str(), entry.model_id.as_str()));
        let window = entry
            .context_window
            .map(|w| vec![s(format_token_count(w as usize), style::dim())])
            .unwrap_or_default();
        items.push(PickItem::row_with_trail(
            vec![
                current_mark(is_current),
                s(entry.display_name.clone(), row_label(index == selected)),
            ],
            window,
        ));
    }
    pick_list(
        frame,
        area,
        &state.ui.hits,
        ListId::ModelSelector,
        items,
        selected,
    );
}
