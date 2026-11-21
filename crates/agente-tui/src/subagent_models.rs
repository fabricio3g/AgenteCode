//! `/subagent-models`: the models subagents may run on.
//!
//! The agent creates each subagent for its task and picks one of these
//! models by reading the note beside it. Laid out like Desktop's dialog, by
//! the Laws of UX: each row starts with a radio (`◉` the default, `○` the
//! rest) and reads `name  note … model`; the conversation's own model is the
//! last radio; then `+ Add model` and the switch that lets the agent pick.
//! Space makes a row the default; Enter re-picks its model; `u` edits the
//! note, `n` renames (whatever is typed is folded into a valid name, never
//! refused); Del removes. Everything lives in `AppConfig::subagents` and is
//! read by `subagent::routing` at spawn.

use agente_core::config::{SubagentModelEntry, SubagentSettings, MAIN_MODEL};
use ratatui::layout::Rect;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style;
use crate::widgets::pick::{pick_list, row_label, search_field, PickItem};
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, panel_row, s};

/// One selectable row of the dialog, in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Row {
    Entry(usize),
    /// The conversation's own model: the last default option.
    Main,
    Add,
    Picks,
}

/// What the model picker is choosing for when it opens from this dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelTarget {
    Entry(usize),
    New,
}

/// Which text an open edit changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditField {
    Name,
    Note,
}

/// A name or note being typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub index: usize,
    pub field: EditField,
    pub text: String,
}

pub fn rows(settings: &SubagentSettings) -> Vec<Row> {
    (0..settings.models.len())
        .map(Row::Entry)
        .chain([Row::Main, Row::Add, Row::Picks])
        .collect()
}

/// The model picker's title when it picks for this dialog.
pub fn target_title(state: &AppState, target: ModelTarget) -> String {
    match target {
        ModelTarget::New => "Add a subagent model".to_string(),
        ModelTarget::Entry(index) => state
            .config
            .config
            .subagents
            .models
            .get(index)
            .map(|entry| format!("Model for {}", entry.name))
            .unwrap_or_else(|| "Subagent model".to_string()),
    }
}

/// The `(provider, model)` the picker marks as in effect for `target`.
pub fn target_model(state: &AppState, target: ModelTarget) -> Option<(&str, &str)> {
    match target {
        ModelTarget::New => None,
        ModelTarget::Entry(index) => state
            .config
            .config
            .subagents
            .models
            .get(index)
            .map(|entry| (entry.provider.as_str(), entry.model.as_str())),
    }
}

/// Store a model the picker chose. A new entry is named after the model and
/// opens its note for typing, since the note is how the agent chooses.
pub fn apply_pick(state: &mut AppState, target: ModelTarget, provider: &str, model: &str) {
    let settings = &mut state.config.config.subagents;
    match target {
        ModelTarget::Entry(index) => {
            if let Some(entry) = settings.models.get_mut(index) {
                entry.provider = provider.to_string();
                entry.model = model.to_string();
                entry.thinking = None;
            }
        }
        ModelTarget::New => {
            let name = settings.unique_name(model);
            settings.models.push(SubagentModelEntry {
                name,
                provider: provider.to_string(),
                model: model.to_string(),
                thinking: None,
                use_for: String::new(),
            });
            let index = settings.models.len() - 1;
            state.input.subagent_models_selected = index;
            state.input.subagent_model_edit = Some(Edit {
                index,
                field: EditField::Note,
                text: String::new(),
            });
        }
    }
}

/// Commit an edit. A typed name is settled into a valid, unique one rather
/// than refused, and the default follows a renamed model.
pub fn commit_edit(settings: &mut SubagentSettings, edit: &Edit) {
    let text = edit.text.trim();
    match edit.field {
        EditField::Note => {
            if let Some(entry) = settings.models.get_mut(edit.index) {
                entry.use_for = text.to_string();
            }
        }
        EditField::Name => {
            if edit.index >= settings.models.len() {
                return;
            }
            let name = settings.settled_name(text, edit.index);
            let old = std::mem::replace(&mut settings.models[edit.index].name, name.clone());
            if settings.default_model.as_deref() == Some(old.as_str()) {
                settings.default_model = Some(name);
            }
        }
    }
}

/// Take a model off the list; a default that named it goes back to the
/// conversation's model.
pub fn remove(settings: &mut SubagentSettings, index: usize) {
    if index >= settings.models.len() {
        return;
    }
    let removed = settings.models.remove(index);
    if settings.default_model.as_deref() == Some(removed.name.as_str()) {
        settings.default_model = None;
    }
}

/// Make `row` the default: a model on the list, or the conversation's own
/// (saved as unset).
pub fn set_default(settings: &mut SubagentSettings, row: Row) {
    match row {
        Row::Entry(index) => {
            if let Some(entry) = settings.models.get(index) {
                settings.default_model = Some(entry.name.clone());
            }
        }
        Row::Main => settings.default_model = None,
        Row::Add | Row::Picks => {}
    }
}

/// Which row holds the default: a listed model, else the conversation's.
fn is_default(settings: &SubagentSettings, row: Row) -> bool {
    match (settings.default_name(), row) {
        (Some(name), Row::Entry(index)) if name != MAIN_MODEL => {
            settings.models.get(index).is_some_and(|e| e.name == name)
        }
        (None, Row::Main) => true,
        (Some(MAIN_MODEL), Row::Main) => true,
        _ => false,
    }
}

fn radio(on: bool) -> ratatui::text::Span<'static> {
    if on {
        s("◉ ", style::accent())
    } else {
        s("○ ", style::dim())
    }
}

fn short_model(model: &str) -> String {
    model.rsplit('/').next().unwrap_or(model).to_string()
}

fn item(state: &AppState, row: Row, selected: bool, width: usize) -> PickItem {
    let settings = &state.config.config.subagents;
    match row {
        Row::Entry(index) => {
            let entry = &settings.models[index];
            let mut lead = vec![
                radio(is_default(settings, row)),
                s(entry.name.clone(), row_label(selected)),
            ];
            let note = entry.use_for.trim();
            let budget = width.saturating_sub(crate::widgets::display_width(&entry.name) + 30);
            if note.is_empty() {
                lead.push(s("  no note yet", style::dim()));
            } else if budget > 8 {
                let shown = crate::widgets::truncate_cells(note, budget);
                lead.push(s(format!("  {shown}"), style::muted()));
            }
            PickItem::row_with_trail(lead, vec![s(short_model(&entry.model), style::dim())])
        }
        Row::Main => PickItem::row_with_trail(
            vec![
                radio(is_default(settings, row)),
                s("Conversation's model", row_label(selected)),
            ],
            vec![s("whatever the chat runs on", style::dim())],
        ),
        Row::Add => PickItem::row(vec![s("+ Add model", style::accent())]),
        Row::Picks => {
            let on = settings.picks();
            PickItem::row_with_trail(
                vec![s("Let the agent choose", row_label(selected))],
                // On is the default: grey. Off is the change that should show.
                vec![s(
                    if on { "on" } else { "off" },
                    if on { style::dim() } else { style::accent() },
                )],
            )
        }
    }
}

fn hints(row: Option<Row>, editing: bool) -> &'static [(&'static str, &'static str)] {
    if editing {
        return &[("Enter", "save"), ("Esc", "cancel")];
    }
    match row {
        Some(Row::Entry(_)) => &[
            ("Space", "default"),
            ("Enter", "model"),
            ("u", "use for"),
            ("n", "rename"),
            ("Del", "remove"),
            ("Esc", "close"),
        ],
        Some(Row::Main) => &[("Space", "default"), ("Esc", "close")],
        Some(Row::Add) => &[("Enter", "add model"), ("Esc", "close")],
        _ => &[("Enter", "toggle"), ("Esc", "close")],
    }
}

/// The line under the list: the field being typed, or what the selected
/// row means in full.
fn detail_line(settings: &SubagentSettings, row: Option<Row>) -> String {
    match row {
        Some(Row::Entry(index)) => {
            let entry = &settings.models[index];
            format!("{} · {}", entry.provider, entry.model)
        }
        Some(Row::Picks) if settings.picks() => {
            "The agent picks from this list by your notes; the default is used when it doesn't."
                .into()
        }
        Some(Row::Picks) => "Every subagent runs on the default.".into(),
        _ => String::new(),
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_subagent_models || area.width < 12 || area.height < 8 {
        return;
    }
    let settings = &state.config.config.subagents;
    let rows = rows(settings);
    let selected = state
        .input
        .subagent_models_selected
        .min(rows.len().saturating_sub(1));
    let edit = state.input.subagent_model_edit.as_ref();
    // Title, then rows, gap, detail line, gap, footer.
    let list_rows = rows.len().clamp(4, 16) as u16;
    let panel = centered_panel(area, area.width.saturating_sub(4).min(76), list_rows + 7);
    let body = modal_card(frame, panel, vec![s("Subagent models", style::bold())]);
    let width = body.width.saturating_sub(4) as usize;

    if let Some(top) = panel_row(body, 1, 1) {
        let list_area = Rect {
            height: body.height.saturating_sub(5),
            ..top
        };
        let items = rows
            .iter()
            .enumerate()
            .map(|(i, row)| item(state, *row, i == selected, width))
            .collect();
        pick_list(
            frame,
            list_area,
            &state.ui.hits,
            ListId::SubagentModels,
            items,
            selected,
        );

        let detail = Rect {
            y: list_area.bottom() + 1,
            height: 1,
            ..top
        };
        if detail.bottom() <= body.bottom().saturating_sub(1) {
            if let Some(edit) = edit {
                let placeholder = match edit.field {
                    EditField::Name => "a name the agent picks it by",
                    EditField::Note => "what is it good at? the agent reads this to choose",
                };
                search_field(frame, detail, &edit.text, placeholder);
            } else {
                let line = detail_line(settings, rows.get(selected).copied());
                frame.render_widget(
                    ratatui::widgets::Paragraph::new(s(line, style::dim())),
                    detail,
                );
            }
        }
    }
    modal_footer(
        frame,
        body,
        footer_hints(
            hints(rows.get(selected).copied(), edit.is_some()),
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

    fn entry(name: &str, model: &str, note: &str) -> SubagentModelEntry {
        SubagentModelEntry {
            name: name.into(),
            provider: "openrouter".into(),
            model: model.into(),
            thinking: None,
            use_for: note.into(),
        }
    }

    fn settings() -> SubagentSettings {
        SubagentSettings {
            models: vec![
                entry(
                    "scout",
                    "qwen/qwen3-coder:free",
                    "Fast searches. Never edits.",
                ),
                entry("builder", "z-ai/glm-5", ""),
            ],
            default_model: Some("scout".into()),
            ..SubagentSettings::default()
        }
    }

    fn draw(state: &AppState) -> String {
        let mut terminal = Terminal::new(TestBackend::new(90, 24)).unwrap();
        terminal.draw(|f| render(f, f.area(), state)).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    #[test]
    fn rows_read_radio_name_note_and_model() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/subagent-models".into());
        state.config.config.subagents = settings();
        state.input.open_subagent_models();
        let text = draw(&state);
        assert!(text.contains("◉ scout"), "{text}");
        assert!(text.contains("○ builder"), "{text}");
        assert!(text.contains("Fast searches. Never edits."), "{text}");
        assert!(text.contains("qwen3-coder:free"), "{text}");
        assert!(text.contains("no note yet"), "{text}");
        assert!(text.contains("○ Conversation's model"), "{text}");
        assert!(text.contains("+ Add model"), "{text}");
        assert!(text.contains("Let the agent choose"), "{text}");
        assert!(text.contains("Space default"), "{text}");
    }

    #[test]
    fn with_no_list_the_conversations_model_is_the_default() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/subagent-models".into());
        state.input.open_subagent_models();
        let text = draw(&state);
        assert!(text.contains("◉ Conversation's model"), "{text}");
        assert!(text.contains("+ Add model"), "{text}");
    }

    #[test]
    fn a_typed_name_is_settled_and_carries_the_default() {
        let mut s = settings();
        commit_edit(
            &mut s,
            &Edit {
                index: 0,
                field: EditField::Name,
                text: "Fast Reader".into(),
            },
        );
        assert_eq!(s.models[0].name, "fast-reader");
        assert_eq!(s.default_model.as_deref(), Some("fast-reader"));
        commit_edit(
            &mut s,
            &Edit {
                index: 1,
                field: EditField::Name,
                text: "fast-reader".into(),
            },
        );
        assert_eq!(s.models[1].name, "fast-reader-2");
        commit_edit(
            &mut s,
            &Edit {
                index: 1,
                field: EditField::Note,
                text: "  Edits across files. ".into(),
            },
        );
        assert_eq!(s.models[1].use_for, "Edits across files.");
        assert!(s.validate().is_ok());
    }

    #[test]
    fn the_default_is_one_radio_and_removing_it_falls_back() {
        let mut s = settings();
        set_default(&mut s, Row::Entry(1));
        assert_eq!(s.default_model.as_deref(), Some("builder"));
        assert!(is_default(&s, Row::Entry(1)) && !is_default(&s, Row::Main));
        set_default(&mut s, Row::Main);
        assert_eq!(s.default_model, None);
        assert!(is_default(&s, Row::Main));
        set_default(&mut s, Row::Entry(0));
        remove(&mut s, 0);
        assert_eq!(s.default_model, None);
        assert_eq!(s.models.len(), 1);
    }
}
