//! `/subagent-models`: pick the model each subagent type runs on.
//!
//! One row per type — "All subagents" (the `*` default) first, then the
//! built-ins and any `.agente/agents/*.md` custom types. Enter opens the
//! regular model picker aimed at that row; Del resets the row to inherit.
//! Overrides live in `AppConfig::subagent_models` and are read by the
//! subagent host when a child spawns.

use agente_core::config::{SubagentModel, ALL_SUBAGENTS};
use ratatui::layout::Rect;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style;
use crate::widgets::pick::{pick_list, row_label, PickItem};
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, panel_row, s};

/// Override keys shown in the dialog, in display order.
pub fn subagent_types(project_dir: &str) -> Vec<String> {
    use agente_core::subagent::definition::{custom_subagents, BUILTIN_SUBAGENTS};
    std::iter::once(ALL_SUBAGENTS.to_string())
        .chain(BUILTIN_SUBAGENTS.iter().map(|b| b.name.to_string()))
        .chain(custom_subagents(project_dir).into_iter().map(|c| c.name))
        .collect()
}

/// Row label for an override key.
pub fn type_label(key: &str) -> &str {
    if key == ALL_SUBAGENTS {
        "All subagents"
    } else {
        key
    }
}

/// What a row currently runs on: its own override, or what it inherits.
fn model_summary(state: &AppState, key: &str) -> (String, bool) {
    let models = &state.config.config.subagent_models;
    match models.get(key) {
        Some(SubagentModel { provider, model }) => {
            (state.get_model_display_name(provider, model), true)
        }
        None if key != ALL_SUBAGENTS && models.contains_key(ALL_SUBAGENTS) => {
            ("same as All subagents".to_string(), false)
        }
        None => ("main model".to_string(), false),
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    let types = &state.input.subagent_model_types;
    if !state.input.show_subagent_models || area.width < 12 || area.height < 7 {
        return;
    }
    let list_rows = types.len().clamp(1, 12) as u16;
    // gap + list + gap + footer inside the border.
    let panel = centered_panel(area, area.width.saturating_sub(4).min(64), list_rows + 5);
    let body = modal_card(
        frame,
        panel,
        vec![
            s("Subagent models", style::bold()),
            s(" · children run on the main model unless set", style::dim()),
        ],
    );
    if let Some(top) = panel_row(body, 1, 1) {
        let list_area = Rect {
            height: body.height.saturating_sub(3),
            ..top
        };
        let selected = state.input.subagent_models_selected;
        let items = types
            .iter()
            .enumerate()
            .map(|(i, key)| {
                let (summary, overridden) = model_summary(state, key);
                PickItem::row_with_trail(
                    vec![s(type_label(key).to_string(), row_label(i == selected))],
                    vec![s(
                        summary,
                        if overridden {
                            style::accent()
                        } else {
                            style::dim()
                        },
                    )],
                )
            })
            .collect();
        pick_list(
            frame,
            list_area,
            &state.ui.hits,
            ListId::SubagentModels,
            items,
            selected,
        );
    }
    modal_footer(
        frame,
        body,
        footer_hints(
            &[
                ("↑↓", "move"),
                ("Enter", "choose model"),
                ("Del", "inherit"),
                ("Esc", "close"),
            ],
            body.width.saturating_sub(2),
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn rows_show_overrides_and_inheritance() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/subagent-models".into());
        state
            .input
            .open_subagent_models(subagent_types("/tmp/subagent-models"));
        state.config.config.subagent_models.insert(
            "explore".into(),
            SubagentModel {
                provider: "deepseek".into(),
                model: "deepseek-flash".into(),
            },
        );
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(text.contains("All subagents"), "{text}");
        assert!(text.contains("main model"), "{text}");
        assert!(text.contains("explore"), "{text}");
        assert!(text.contains("Del inherit"), "{text}");
    }
}
