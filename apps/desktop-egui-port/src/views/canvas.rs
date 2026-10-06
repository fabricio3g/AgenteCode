//! Canvas dock content. Ports the canvas doc plus the handoff state.

use egui::{ScrollArea, Ui};

use crate::app::DesktopApp;
use crate::widgets;

pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let session_id = app
        .chat
        .active_id
        .clone()
        .unwrap_or_else(|| "code".to_owned());
    app.canvas.load_for(&session_id);
    widgets::search_row(ui, &mut app.canvas.title, "Board title…");
    ui.separator();
    ScrollArea::vertical()
        .auto_shrink([false; 2])
        .show(ui, |ui| {
            widgets::composer_box(ui, &mut app.canvas.notes, "Board notes…");
        });
    ui.horizontal(|ui| {
        if ui.small_button("Save").clicked() {
            app.canvas.save_for(&session_id);
            app.toast_ok("Canvas saved");
        }
        if ui.small_button("Clear").clicked() {
            app.canvas.clear();
            app.dirty = true;
        }
    });
    let _ = tokens;
}
