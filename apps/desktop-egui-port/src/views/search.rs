//! Search drawer content. Ports the search sidebar plus the deep-research
//! widget state. Results come from the core web tools once a search turn runs.

use egui::{RichText, Ui};

use crate::app::DesktopApp;
use crate::widgets;

pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    ui.horizontal(|ui| {
        widgets::search_row(ui, &mut app.search.query, "Search the web and docs…");
        if ui.small_button("Search").clicked() {
            app.search.submit();
        }
        if ui.small_button("Run as turn").clicked() {
            let query = app.search.query.trim().to_owned();
            if !query.is_empty() {
                let prompt = if app.search.deep_research {
                    format!("Research this deeply and cite sources with the web tools: {query}")
                } else {
                    format!("Search the web for: {query}")
                };
                app.chat.ensure_session(crate::backend::SessionSpace::Home);
                if let Some(session) = app.chat.active_mut() {
                    let id = session.id.clone();
                    session.push_user(&query, &prompt);
                    app.search.open = false;
                    app.order_turn(
                        crate::app::TurnTarget::Session(id),
                        crate::backend::AgentMode::Build,
                    );
                }
            }
        }
    });
    let mut deep = app.search.deep_research;
    ui.checkbox(&mut deep, "Deep research");
    if deep != app.search.deep_research {
        app.search.toggle_deep_research();
    }
    ui.separator();

    if app.search.searched {
        ui.label(
            RichText::new(format!("Query queued: {}", app.search.query))
                .size(13.0)
                .color(tokens.text),
        );
        widgets::empty_state(
            ui,
            tokens,
            "Run it as an agent turn and the web tools fill this in.",
        );
    } else {
        widgets::empty_state(ui, tokens, "Type a query to start.");
    }
}
