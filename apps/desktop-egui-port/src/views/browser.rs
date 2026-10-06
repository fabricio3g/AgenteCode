//! Browser dock content. Ports the browser panel: URL and research notes
//! live here while page embedding follows the engine work.

use egui::Ui;

use crate::app::DesktopApp;
use crate::widgets;

pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    ui.horizontal(|ui| {
        widgets::search_row(ui, &mut app.browser.url, "https://…");
        if ui.small_button("Fetch").clicked() {
            app.fetch_browser_page();
        }
    });
    widgets::composer_box(ui, &mut app.browser.notes, "Page text and notes…");
    if ui.small_button("Clear").clicked() {
        app.browser.clear();
        app.dirty = true;
    }
    let _ = tokens;
}
