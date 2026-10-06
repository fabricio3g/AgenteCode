//! Bots screen. Ports the roster, editor entry, routines and Telegram state.
//! The roster is local until the daemon client lands; the shape is the same.

use egui::{RichText, Ui};

use crate::app::DesktopApp;
use crate::widgets;

pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    widgets::section_header(ui, tokens, "Bot roster");
    if app.bots.bots.is_empty() {
        widgets::empty_state(ui, tokens, "No bots yet. Add the first one below.");
    }
    let mut select: Option<usize> = None;
    for (index, bot) in app.bots.bots.iter().enumerate() {
        let label = format!("{} · {} · {}", bot.name, bot.model, bot.status);
        if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_BOTS, &label).current(app.bots.selected == Some(index))).clicked() {
            select = Some(index);
        }
    }
    if let Some(index) = select {
        app.bots.select(index);
    }
    ui.separator();

    if let Some(index) = app.bots.selected {
        let bot = app
            .bots
            .bots
            .get(index)
            .map(|bot| (bot.name.clone(), bot.model.clone(), bot.status.clone()));
        if let Some((name, model, status)) = bot {
            widgets::section_header(ui, tokens, "Bot");
            ui.label(RichText::new(&name).size(16.0).color(tokens.text));
            ui.label(
                RichText::new(format!("Model: {model}"))
                    .size(13.0)
                    .color(tokens.secondary),
            );
            ui.label(
                RichText::new(format!("Status: {status}"))
                    .size(13.0)
                    .color(tokens.secondary),
            );
            ui.horizontal(|ui| {
                if ui.button("Edit").clicked() {
                    app.overlays.bot_editor = Some(
                        crate::state::overlays::BotEditorState::from_item(index, &name, &model),
                    );
                }
                if ui.button("Routines").clicked() {
                    app.overlays.routines = Some(Default::default());
                }
                if ui.button("Telegram").clicked() {
                    app.overlays.telegram = Some(Default::default());
                }
                if ui.button("Remove").clicked() {
                    app.bots.remove_selected();
                    app.dirty = true;
                }
            });
            ui.separator();
            widgets::section_header(ui, tokens, "Sandbox");
            ui.label(
                RichText::new(
                    "On Linux a bot's programs run boxed (Landlock + seccomp): its workspace only, no keys, no network unless allowed.",
                )
                .size(11.0)
                .color(tokens.muted),
            );
            ui.separator();
        }
    }

    ui.horizontal(|ui| {
        widgets::search_row(ui, &mut app.bots.new_name, "New bot name…");
        if ui.small_button("Add").clicked() {
            app.bots.add();
            app.dirty = true;
        }
        if ui.small_button("New bot…").clicked() {
            app.overlays.bot_editor = Some(crate::state::overlays::BotEditorState::new_bot());
        }
    });
}
