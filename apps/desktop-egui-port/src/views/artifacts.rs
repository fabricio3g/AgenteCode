//! Artifact library view. Ports the artifact library plus the studio state.

use egui::{RichText, Ui};

use crate::app::DesktopApp;
use crate::widgets;

pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    widgets::section_header(ui, tokens, "Artifact library");
    widgets::search_row(ui, &mut app.artifacts.filter, "Filter artifacts…");
    ui.separator();

    let visible = app.artifacts.visible();
    if visible.is_empty() {
        widgets::empty_state(ui, tokens, "No artifacts yet. Name one below to start a draft.");
    }
    let mut select: Option<usize> = None;
    for (index, item) in &visible {
        let label = format!("{} · {}", item.name, item.kind);
        if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_ARTIFACT, &label).current(app.artifacts.selected == Some(*index))).clicked() {
            select = Some(*index);
        }
    }
    if let Some(index) = select {
        app.artifacts.select(index);
    }
    ui.separator();

    if let Some(index) = app.artifacts.selected {
        if let Some(item) = app.artifacts.items.get(index) {
            widgets::section_header(ui, tokens, "Preview");
            ui.label(RichText::new(&item.name).size(16.0).color(tokens.text));
            ui.label(RichText::new(&item.summary).size(13.0).color(tokens.secondary));
            ui.horizontal(|ui| {
                if ui.button("Open studio").clicked() {
                    app.open_studio();
                }
                if ui.button("Remove").clicked() {
                    app.artifacts.remove_selected();
                    app.dirty = true;
                }
            });
            ui.separator();
        }
    }

    ui.horizontal(|ui| {
        widgets::search_row(ui, &mut app.artifacts.new_name, "New artifact name…");
        if ui.small_button("Add").clicked() {
            app.artifacts.add();
            app.dirty = true;
        }
    });
}
