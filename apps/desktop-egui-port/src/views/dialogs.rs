//! Modal dialogs: the command palette, confirms, chat search, the session
//! picker, inline message editing and the shortcuts sheet. Ports the Electron
//! `Dialog`, `ConfirmDialog`, `ChatSearchModal` and the TUI's pickers.

use egui::{Key, Modal, RichText, Ui};

use crate::app::{DesktopApp, commands};
use crate::state::overlays::{PaletteMode, SearchHit};
use crate::widgets;

/// Paints every modal that is open, topmost last.
pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let ctx = ui.ctx().clone();
    if app.overlays.palette.is_some() {
        palette(&ctx, app);
    }
    if app.overlays.session_picker.is_some() {
        session_picker(&ctx, app);
    }
    if app.overlays.chat_search.is_some() {
        chat_search(&ctx, app);
    }
    if app.overlays.confirm.is_some() {
        confirm(&ctx, app);
    }
    if app.overlays.edit_message.is_some() {
        edit_message(&ctx, app);
    }
    if app.overlays.help {
        help(&ctx, app);
    }
}

fn modal_card(title: &str) -> Modal {
    Modal::new(egui::Id::new(("modal", title)))
}

fn palette(ctx: &egui::Context, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(palette) = app.overlays.palette.as_ref() else {
        return;
    };
    let mode = palette.mode;
    let title = palette.title.clone();
    let mut query = palette.query.clone();
    let mut index = palette.index;
    let mut close = false;
    let mut run: Option<String> = None;

    modal_card(&title).show(ctx, |ui| {
        ui.set_width(560.0);
        ui.horizontal(|ui| {
            widgets::section_header(ui, tokens, &title);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                    close = true;
                }
            });
        });
        let changed = ui
            .add(
                egui::TextEdit::singleline(&mut query)
                    .hint_text(if mode == PaletteMode::Commands {
                        "Type a command…"
                    } else {
                        "Filter models…"
                    })
                    .desired_width(f32::INFINITY),
            )
            .changed();
        if changed {
            index = 0;
        }
        ui.add_space(6.0);
        egui::ScrollArea::vertical()
            .max_height(360.0)
            .auto_shrink([false, true])
            .show(ui, |ui| match mode {
                PaletteMode::Commands => {
                    for (row, command) in commands::filtered(&query).iter().enumerate() {
                        let label = format!("/{}", command.slash);
                        let selected = row == index;
                        let response = widgets::row(
                            ui,
                            tokens,
                            widgets::Row::new("", command.title)
                                .current(selected)
                                .meta(command.hint),
                        );
                        if response.hovered() {
                            index = row;
                        }
                        if response.clicked() {
                            run = Some(command.id.to_owned());
                        }
                        let _ = label;
                    }
                }
                PaletteMode::Models => {
                    for (row, model) in app.model_choices().iter().enumerate() {
                        let selected = row == index;
                        let response = widgets::row(
                            ui,
                            tokens,
                            widgets::Row::new("", model).current(selected),
                        );
                        if response.hovered() {
                            index = row;
                        }
                        if response.clicked() {
                            run = Some(model.clone());
                        }
                    }
                }
            });
        ui.add_space(6.0);
        widgets::section_header(ui, tokens, "Enter run · Esc close · ↑↓ move");
    });

    if let Some(palette) = app.overlays.palette.as_mut() {
        palette.query = query;
        palette.index = index;
    }
    if close {
        app.overlays.palette = None;
        return;
    }
    if let Some(chosen) = run {
        match mode {
            PaletteMode::Commands => {
                app.overlays.palette = None;
                commands::run(app, &chosen, "");
            }
            PaletteMode::Models => {
                app.overlays.palette = None;
                app.set_model(&chosen);
            }
        }
    }
}

fn confirm(ctx: &egui::Context, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(state) = app.overlays.confirm.clone() else {
        return;
    };
    let mut decision: Option<bool> = None;
    modal_card(&state.title).show(ctx, |ui| {
        ui.set_width(420.0);
        ui.label(
            RichText::new(&state.title)
                .size(15.0)
                .strong()
                .color(if state.danger {
                    tokens.error
                } else {
                    tokens.text
                }),
        );
        ui.add_space(6.0);
        ui.label(RichText::new(&state.body).size(13.0).color(tokens.secondary));
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            if ui.button(&state.confirm_label).clicked() {
                decision = Some(true);
            }
            if ui.button("Cancel").clicked() {
                decision = Some(false);
            }
        });
    });
    if let Some(accepted) = decision {
        app.apply_confirm(accepted);
    }
}

fn session_picker(ctx: &egui::Context, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(picker) = app.overlays.session_picker.as_ref() else {
        return;
    };
    let mut query = picker.query.clone();
    let mut index = picker.index;
    let mut open: Option<String> = None;
    let mut close = false;

    let rows: Vec<(String, String, String, bool)> = app
        .chat
        .sessions
        .iter()
        .filter(|session| {
            query.is_empty() || session.title.to_lowercase().contains(&query.to_lowercase())
        })
        .map(|session| {
            (
                session.id.clone(),
                session.title.clone(),
                format!("{} · {} rows", session.space.label(), session.entries.len()),
                session.state.working(),
            )
        })
        .collect();

    modal_card("Sessions").show(ctx, |ui| {
        ui.set_width(520.0);
        ui.horizontal(|ui| {
            widgets::section_header(ui, tokens, "Sessions");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                    close = true;
                }
            });
        });
        ui.add(
            egui::TextEdit::singleline(&mut query)
                .hint_text("Filter by title…")
                .desired_width(f32::INFINITY),
        );
        ui.add_space(6.0);
        egui::ScrollArea::vertical()
            .max_height(320.0)
            .auto_shrink([false, true])
            .show(ui, |ui| {
                for (row, (id, title, meta, working)) in rows.iter().enumerate() {
                    let meta = if *working {
                        format!("{meta} · working")
                    } else {
                        meta.clone()
                    };
                    let response = widgets::row(
                        ui,
                        tokens,
                        widgets::Row::new("", title).current(row == index).meta(&meta),
                    );
                    if response.hovered() {
                        index = row;
                    }
                    if response.clicked() {
                        open = Some(id.clone());
                    }
                }
            });
    });

    if let Some(picker) = app.overlays.session_picker.as_mut() {
        picker.query = query;
        picker.index = index;
    }
    if close {
        app.overlays.session_picker = None;
    }
    if let Some(id) = open {
        app.chat.select(&id);
        app.overlays.session_picker = None;
        app.dirty = true;
    }
}

fn chat_search(ctx: &egui::Context, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(search) = app.overlays.chat_search.as_ref() else {
        return;
    };
    let mut query = search.query.clone();
    let mut index = search.index;
    let mut run_search = false;
    let mut jump: Option<SearchHit> = None;
    let mut close = false;
    let hits: Vec<SearchHit> = search.hits.clone();

    modal_card("Search").show(ctx, |ui| {
        ui.set_width(620.0);
        ui.horizontal(|ui| {
            widgets::section_header(ui, tokens, "Search every conversation");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                    close = true;
                }
            });
        });
        ui.horizontal(|ui| {
            let response = ui.add(
                egui::TextEdit::singleline(&mut query)
                    .hint_text("Words to find…")
                    .desired_width(f32::INFINITY),
            );
            if response.changed() || ui.input(|input| input.key_pressed(Key::Enter)) {
                run_search = true;
            }
            if ui.button("Search").clicked() {
                run_search = true;
            }
        });
        ui.add_space(6.0);
        if hits.is_empty() {
            widgets::empty_state(
                ui,
                tokens,
                "No hits yet. Search runs over every transcript row.",
            );
        }
        egui::ScrollArea::vertical()
            .max_height(340.0)
            .auto_shrink([false, true])
            .show(ui, |ui| {
                for (row, hit) in hits.iter().enumerate() {
                    let response = widgets::row(
                        ui,
                        tokens,
                        widgets::Row::new("", &hit.snippet)
                            .current(row == index)
                            .meta(&hit.session_title),
                    );
                    if response.hovered() {
                        index = row;
                    }
                    if response.clicked() {
                        jump = Some(hit.clone());
                    }
                }
            });
    });

    if let Some(search) = app.overlays.chat_search.as_mut() {
        search.query = query;
        search.index = index;
    }
    if close {
        app.overlays.chat_search = None;
        return;
    }
    if run_search {
        app.run_chat_search();
    }
    if let Some(hit) = jump {
        app.open_search_hit(&hit);
    }
}

fn edit_message(ctx: &egui::Context, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(edit) = app.overlays.edit_message.as_ref() else {
        return;
    };
    let session_id = edit.session_id.clone();
    let index = edit.index;
    let mut text = edit.text.clone();
    let mut save = false;
    let mut cancel = false;

    modal_card("Edit message").show(ctx, |ui| {
        ui.set_width(560.0);
        widgets::section_header(ui, tokens, "Edit the prompt");
        ui.add(
            egui::TextEdit::multiline(&mut text)
                .desired_rows(6)
                .desired_width(f32::INFINITY),
        );
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            if ui.button("Save and rerun").clicked() {
                save = true;
            }
            if ui.button("Cancel").clicked() {
                cancel = true;
            }
        });
    });

    if cancel {
        app.overlays.edit_message = None;
        return;
    }
    if !save {
        if let Some(edit) = app.overlays.edit_message.as_mut() {
            edit.text = text;
        }
        return;
    }
    if let Some(session) = app.chat.by_id_mut(&session_id) {
        if index < session.entries.len() {
            session.entries[index].text = text.clone();
        }
        // The conversation follows: everything after this prompt is dropped so
        // the rerun happens against the edited text.
        if let Some(position) = session
            .conversation
            .iter()
            .position(|message| message.role == agente_core::types::Role::User)
        {
            session.conversation.truncate(position);
        }
        session.conversation.push(agente_core::types::Message::user(&text));
        session.entries.truncate(index + 1);
    }
    app.overlays.edit_message = None;
    app.order_turn(
        crate::app::TurnTarget::Session(session_id),
        crate::backend::AgentMode::Build,
    );
}

fn help(ctx: &egui::Context, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let mut close = false;
    modal_card("Shortcuts").show(ctx, |ui| {
        ui.set_width(460.0);
        ui.horizontal(|ui| {
            widgets::section_header(ui, tokens, "Keyboard");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                    close = true;
                }
            });
        });
        for command in commands::COMMANDS {
            if command.hint.is_empty() {
                continue;
            }
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(command.title)
                        .size(13.0)
                        .color(tokens.secondary),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        RichText::new(command.hint)
                            .size(12.0)
                            .monospace()
                            .color(tokens.muted),
                    );
                });
            });
        }
        ui.add_space(8.0);
        widgets::section_header(ui, tokens, "Enter to send · Shift+Enter newline · Esc stop");
    });
    if close {
        app.overlays.help = false;
    }
}
