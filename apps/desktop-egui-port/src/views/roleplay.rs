//! Roleplay surface. Ports the character surface: cast strip on top, the
//! thread, and the composer docked at the bottom. Streams directly.

use egui::{CentralPanel, Panel, RichText, Ui};

use crate::app::DesktopApp;
use crate::backend::AgentMode;
use crate::backend::SessionSpace;
use crate::state::RunState;
use crate::style::geom;
use crate::views::{composer, thread};
use crate::widgets;

/// Shows the roleplay space.
pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let scale = app.prefs.reading_scale;
    let space = SessionSpace::Roleplay;
    app.chat.ensure_session(space);
    let has_messages = app
        .chat
        .active()
        .is_some_and(|session| !session.entries.is_empty());

    Panel::bottom("roleplay-composer")
        .frame(egui::Frame {
            fill: tokens.bg,
            ..Default::default()
        })
        .show(ui, |ui| {
            widgets::centered_column(ui, geom::THREAD_W, |ui| {
                if !app.toasts.is_empty() {
                    widgets::toast_bar(ui, tokens, &mut app.toasts);
                }
                if !app.roleplay.characters.is_empty() {
                    let names: Vec<String> = app
                        .roleplay
                        .characters
                        .iter()
                        .map(|character| character.name.clone())
                        .collect();
                    let current = app.roleplay.active.unwrap_or(usize::MAX);
                    let labels: Vec<&str> = names.iter().map(String::as_str).collect();
                    if let Some(picked) = widgets::segmented(ui, tokens, &labels, current) {
                        app.roleplay.set_active(picked);
                        app.dirty = true;
                    }
                    ui.horizontal(|ui| {
                        if widgets::chip(ui, tokens, "Edit character", false).clicked() {
                            let index = app.roleplay.active.unwrap_or(0);
                            if let Some(character) = app.roleplay.characters.get(index) {
                                app.overlays.character_editor = Some(
                                    crate::state::overlays::CharacterEditorState::from_item(
                                        index,
                                        &character.name,
                                        &character.persona,
                                    ),
                                );
                            }
                        }
                        if widgets::chip(ui, tokens, "New character", false).clicked() {
                            app.overlays.character_editor = Some(
                                crate::state::overlays::CharacterEditorState::new_character(),
                            );
                        }
                        if widgets::chip(ui, tokens, "Lorebook", false).clicked() {
                            app.overlays.lorebook = Some(Default::default());
                        }
                        if widgets::chip(ui, tokens, "Prompt", false).clicked() {
                            app.open_prompt_inspector();
                        }
                    });
                    ui.add_space(4.0);
                }
                let (provider, model) = app.active_model();
                let model_label = if model.is_empty() {
                    "Pick a model".to_owned()
                } else {
                    format!("{provider} / {model}")
                };
                let thinking = app.prefs.thinking_level.clone();
                let mode_label = app.code.mode.label();
                let mut draft = std::mem::take(&mut app.chat.draft);
                let out = {
                    let Some(session) = app.chat.active_mut() else {
                        app.chat.draft = draft;
                        return;
                    };
                    composer::show_composer(
                        ui,
                        tokens,
                        session,
                        &mut draft,
                        "Write the next beat…",
                        &model_label,
                        &thinking,
                        &[],
                        &[],
                        None,
                        false,
                        mode_label,
                    )
                };
                app.chat.draft = draft;
                let stop = out.stopped;
                let send = out.sent;
                let note = out.note;
                let open_settings = out.open_settings;
                if open_settings {
                    app.nav.settings_open = true;
                }
                if let Some(note) = note {
                    app.toast(note);
                }
                if stop {
                    app.stop_turn();
                }
                if send {
                    let live = app
                        .chat
                        .active()
                        .is_some_and(|session| session.state != RunState::Idle);
                    if live {
                        let text = std::mem::take(&mut app.chat.draft);
                        let prompt = text.trim().to_owned();
                        if !prompt.is_empty() && app.engine.steer(&prompt, None) {
                            if let Some(session) = app.chat.active_mut() {
                                session.entries.push(crate::state::Entry::user(&prompt));
                            }
                        }
                    } else {
                        app.send_draft(space, AgentMode::Plan);
                    }
                }
            });
        });

    CentralPanel::default().show(ui, |ui| {
        if has_messages {
            let entries = app
                .chat
                .active()
                .map(|session| session.entries.clone())
                .unwrap_or_default();
            let session_id = app.chat.active_id.clone().unwrap_or_default();
            let jump = app.scroll_to_bottom;
            let out = thread::show_thread(ui, tokens, scale, &entries, jump);
            crate::views::home::apply_thread_out(app, &session_id, out);
        } else {
            widgets::centered_column(ui, geom::THREAD_W, |ui| {
                ui.add_space(24.0);
                widgets::empty_state(ui, tokens, "Set the scene to begin.");
                if app.roleplay.characters.is_empty() {
                    ui.horizontal(|ui| {
                        widgets::search_row(ui, &mut app.roleplay.new_name, "New character…");
                        if ui.small_button("Add").clicked() {
                            app.roleplay.add();
                            app.dirty = true;
                        }
                    });
                } else {
                    ui.label(
                        RichText::new("Cast ready. Write the opening beat below.")
                            .size(13.0)
                            .color(tokens.muted),
                    );
                }
            });
        }
    });
}
