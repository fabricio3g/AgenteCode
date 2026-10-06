//! Downloads popover. Ports the titlebar downloads button plus the store:
//! model, runtime and document downloads surface here.

use egui::{RichText, Ui};

use crate::app::DesktopApp;
use crate::widgets;

pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    ui.horizontal(|ui| {
        widgets::section_header(ui, tokens, "Downloads");
        if ui.small_button("Refresh").clicked() {
            app.refresh_downloads();
        }
    });
    if app.downloads.items.is_empty() {
        widgets::empty_state(
            ui,
            tokens,
            "No downloads yet. Model and runtime downloads appear here.",
        );
    }
    for item in &app.downloads.items {
        ui.label(
            RichText::new(format!("{} · {}", item.name, item.detail))
                .size(13.0)
                .color(tokens.text),
        );
    }
}
