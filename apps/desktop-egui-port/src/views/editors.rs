//! Editors: the artifact studio, the bot editor, routines, Telegram pairing,
//! the character editor, the lorebook, the prompt inspector and the local
//! runtime panel. Ports the Electron modal editors and the `LLMDrawer`.

use egui::{RichText, ScrollArea, Ui};

use crate::app::DesktopApp;
use crate::widgets;

/// The artifact studio: file rail, source editor and preview toggle.
pub fn studio(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(studio) = app.overlays.studio.as_ref() else {
        return;
    };
    let files: Vec<(String, String)> = studio
        .files
        .iter()
        .map(|file| (file.name.clone(), file.language.clone()))
        .collect();
    let selected = studio.selected;
    let mut draft = studio.draft.clone();
    let preview = studio.preview;
    let mut select: Option<usize> = None;
    let mut save = false;
    let mut add = false;
    let mut remove = false;
    let mut toggle_preview = false;
    let mut close = false;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new("Artifact studio")
                .size(15.0)
                .strong()
                .color(tokens.text),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                close = true;
            }
        });
    });
    ui.separator();
    ui.horizontal_top(|ui| {
        ui.vertical(|ui| {
            ui.set_width(200.0);
            widgets::section_header(ui, tokens, "Files");
            for (index, (name, language)) in files.iter().enumerate() {
                let label = format!("{name} · {language}");
                if widgets::row(
                    ui,
                    tokens,
                    widgets::Row::new(crate::icons::ICON_FILE, &label).current(index == selected),
                )
                .clicked()
                {
                    select = Some(index);
                }
            }
            ui.add_space(6.0);
            if ui.small_button("New file").clicked() {
                add = true;
            }
            if ui.small_button("Remove").clicked() {
                remove = true;
            }
        });
        ui.separator();
        ui.vertical(|ui| {
            ui.horizontal(|ui| {
                let mark = if preview { "Source" } else { "Preview" };
                if ui.button(mark).clicked() {
                    toggle_preview = true;
                }
                if ui.button("Save").clicked() {
                    save = true;
                }
                if preview {
                    ui.label(
                        RichText::new("Preview renders the markdown as the thread would")
                            .size(11.0)
                            .color(tokens.muted),
                    );
                }
            });
            ui.add_space(6.0);
            ScrollArea::vertical()
                .max_height(360.0)
                .auto_shrink([false, true])
                .show(ui, |ui| {
                    if preview {
                        crate::views::markdown::show_markdown(
                            ui,
                            tokens,
                            1.0,
                            &draft,
                            "studio-preview",
                        );
                    } else {
                        ui.add(
                            egui::TextEdit::multiline(&mut draft)
                                .desired_rows(18)
                                .desired_width(f32::INFINITY)
                                .code_editor(),
                        );
                    }
                });
        });
    });

    if let Some(studio) = app.overlays.studio.as_mut() {
        if studio.draft != draft {
            studio.dirty = true;
        }
        studio.draft = draft;
    }
    if close {
        app.overlays.studio = None;
        return;
    }
    if toggle_preview {
        if let Some(studio) = app.overlays.studio.as_mut() {
            studio.preview = !studio.preview;
        }
    }
    if let Some(index) = select {
        if let Some(studio) = app.overlays.studio.as_mut() {
            studio.select(index);
        }
    }
    if save {
        if let Some(studio) = app.overlays.studio.as_mut() {
            studio.save();
        }
        app.toast("Artifact saved to the studio draft");
        app.dirty = true;
    }
    if add {
        if let Some(studio) = app.overlays.studio.as_mut() {
            let name = format!("file-{}.md", studio.files.len() + 1);
            studio.add_file(&name);
        }
        app.dirty = true;
    }
    if remove {
        if let Some(studio) = app.overlays.studio.as_mut() {
            studio.remove_selected();
        }
        app.dirty = true;
    }
}

/// The bot editor: identity, model, Telegram and the sandbox box.
pub fn bot_editor(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(editor) = app.overlays.bot_editor.as_ref() else {
        return;
    };
    let mut name = editor.name.clone();
    let mut handle = editor.handle.clone();
    let mut model = editor.model.clone();
    let mut instructions = editor.instructions.clone();
    let mut telegram_token = editor.telegram_token.clone();
    let mut telegram_chat = editor.telegram_chat.clone();
    let mut sandbox_network = editor.sandbox_network;
    let mut sandbox_write = editor.sandbox_write.clone();
    let mut daily_budget = editor.daily_budget.clone();
    let index = editor.index;
    let mut save = false;
    let mut close = false;
    let mut routines = false;
    let mut telegram = false;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new(if index.is_some() { "Edit bot" } else { "New bot" })
                .size(15.0)
                .strong()
                .color(tokens.text),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                close = true;
            }
        });
    });
    ui.separator();
    ScrollArea::vertical()
        .max_height(420.0)
        .auto_shrink([false, true])
        .show(ui, |ui| {
            widgets::section_header(ui, tokens, "Identity");
            ui.horizontal(|ui| {
                ui.label("Name");
                widgets::search_row(ui, &mut name, "Colina");
            });
            ui.horizontal(|ui| {
                ui.label("Handle");
                widgets::search_row(ui, &mut handle, "colina");
            });
            widgets::section_header(ui, tokens, "Model");
            let choices = app.model_choices();
            egui::ComboBox::from_label("Model").show_ui(ui, |ui| {
                ui.selectable_value(&mut model, String::new(), "inherit the session model");
                for choice in &choices {
                    ui.selectable_value(&mut model, choice.clone(), choice);
                }
            });
            widgets::section_header(ui, tokens, "Instructions");
            ui.add(
                egui::TextEdit::multiline(&mut instructions)
                    .hint_text("How this bot should behave…")
                    .desired_rows(4)
                    .desired_width(f32::INFINITY),
            );
            widgets::section_header(ui, tokens, "Telegram");
            ui.horizontal(|ui| {
                ui.label("Bot token");
                ui.add(
                    egui::TextEdit::singleline(&mut telegram_token)
                        .password(true)
                        .hint_text("123456:ABC…")
                        .desired_width(f32::INFINITY),
                );
            });
            ui.horizontal(|ui| {
                ui.label("Chat id");
                widgets::search_row(ui, &mut telegram_chat, "optional");
            });
            widgets::section_header(ui, tokens, "Sandbox");
            ui.checkbox(&mut sandbox_network, "Allow outgoing network");
            ui.horizontal(|ui| {
                ui.label("Extra write folder");
                widgets::search_row(ui, &mut sandbox_write, "~/Documents/Drafts");
            });
            ui.horizontal(|ui| {
                ui.label("Daily budget");
                widgets::search_row(ui, &mut daily_budget, "5.00");
            });
            ui.label(
                RichText::new(
                    "Bots run boxed on Linux (Landlock + seccomp) when the kernel supports it.",
                )
                .size(11.0)
                .color(tokens.muted),
            );
        });
    ui.add_space(6.0);
    ui.horizontal(|ui| {
        if ui.button("Save bot").clicked() {
            save = true;
        }
        if ui.button("Routines").clicked() {
            routines = true;
        }
        if ui.button("Telegram pairing").clicked() {
            telegram = true;
        }
    });

    if let Some(editor) = app.overlays.bot_editor.as_mut() {
        editor.name = name.clone();
        editor.handle = handle.clone();
        editor.model = model.clone();
        editor.instructions = instructions.clone();
        editor.telegram_token = telegram_token;
        editor.telegram_chat = telegram_chat;
        editor.sandbox_network = sandbox_network;
        editor.sandbox_write = sandbox_write;
        editor.daily_budget = daily_budget;
    }
    if close {
        app.overlays.bot_editor = None;
        return;
    }
    if routines {
        app.overlays.routines = Some(Default::default());
    }
    if telegram {
        app.overlays.telegram = Some(Default::default());
    }
    if save {
        let model_label = if model.is_empty() {
            "inherit".to_owned()
        } else {
            model.clone()
        };
        match index {
            Some(index) => {
                if let Some(bot) = app.bots.bots.get_mut(index) {
                    bot.name = name.clone();
                    bot.model = model_label;
                }
            }
            None => {
                app.bots.bots.push(crate::state::BotItem {
                    name: name.clone(),
                    model: model_label,
                    status: "idle".to_owned(),
                });
                app.bots.selected = Some(app.bots.bots.len() - 1);
            }
        }
        app.overlays.bot_editor = None;
        app.toast(format!("Saved {name}"));
        app.dirty = true;
    }
}

/// Routines: cron lines with the prompt each run.
pub fn routines(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(editor) = app.overlays.routines.as_ref() else {
        return;
    };
    let rows: Vec<(String, String, bool)> = editor
        .routines
        .iter()
        .map(|routine| (routine.schedule.clone(), routine.prompt.clone(), routine.enabled))
        .collect();
    let mut schedule = editor.draft_schedule.clone();
    let mut prompt = editor.draft_prompt.clone();
    let mut add = false;
    let mut remove: Option<usize> = None;
    let mut toggle: Option<usize> = None;
    let mut close = false;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new("Routines")
                .size(15.0)
                .strong()
                .color(tokens.text),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                close = true;
            }
        });
    });
    ui.separator();
    if rows.is_empty() {
        widgets::empty_state(ui, tokens, "No routines yet. A routine is a cron line plus a prompt.");
    }
    for (index, (line, text, enabled)) in rows.iter().enumerate() {
        ui.horizontal(|ui| {
            let mark = if *enabled { "●" } else { "○" };
            ui.label(
                RichText::new(format!("{mark} {line}"))
                    .size(12.0)
                    .monospace()
                    .color(tokens.text),
            );
            ui.label(RichText::new(text).size(12.0).color(tokens.secondary));
            if ui.small_button(if *enabled { "Pause" } else { "Resume" }).clicked() {
                toggle = Some(index);
            }
            if ui.small_button("Remove").clicked() {
                remove = Some(index);
            }
        });
    }
    ui.add_space(8.0);
    widgets::section_header(ui, tokens, "New routine");
    ui.horizontal(|ui| {
        ui.label("Schedule");
        widgets::search_row(ui, &mut schedule, "0 9 * * 1-5");
    });
    ui.add(
        egui::TextEdit::multiline(&mut prompt)
            .hint_text("What should the bot do?")
            .desired_rows(2)
            .desired_width(f32::INFINITY),
    );
    if ui.button("Add routine").clicked() {
        add = true;
    }

    if let Some(editor) = app.overlays.routines.as_mut() {
        editor.draft_schedule = schedule;
        editor.draft_prompt = prompt;
    }
    if close {
        app.overlays.routines = None;
        return;
    }
    if add {
        if let Some(editor) = app.overlays.routines.as_mut() {
            editor.add();
        }
        app.dirty = true;
    }
    if let Some(index) = toggle {
        if let Some(editor) = app.overlays.routines.as_mut() {
            if let Some(routine) = editor.routines.get_mut(index) {
                routine.enabled = !routine.enabled;
            }
        }
        app.dirty = true;
    }
    if let Some(index) = remove {
        if let Some(editor) = app.overlays.routines.as_mut() {
            if index < editor.routines.len() {
                editor.routines.remove(index);
            }
        }
        app.dirty = true;
    }
}

/// Telegram pairing: the code the user sends to the bot, plus paired people.
pub fn telegram(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(state) = app.overlays.telegram.as_ref() else {
        return;
    };
    let paired = state.paired.clone();
    let status = state.status.clone();
    let mut close = false;
    let mut pair = false;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new("Telegram")
                .size(15.0)
                .strong()
                .color(tokens.text),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                close = true;
            }
        });
    });
    ui.separator();
    if ui.button("Create a pairing code").clicked() {
        pair = true;
    }
    if let Some(state) = app.overlays.telegram.as_ref() {
        if !state.pair_code.is_empty() {
            ui.label(
                RichText::new(format!("/pair {}", state.pair_code))
                    .size(14.0)
                    .monospace()
                    .color(tokens.text),
            );
            ui.label(
                RichText::new("Send that to the bot in a private chat. It works once, for ten minutes.")
                    .size(11.0)
                    .color(tokens.muted),
            );
        }
    }
    widgets::section_header(ui, tokens, &format!("Paired people · {}", paired.len()));
    if paired.is_empty() {
        widgets::empty_state(ui, tokens, "Nobody paired yet.");
    }
    for person in &paired {
        ui.label(RichText::new(person).size(12.0).color(tokens.secondary));
    }
    if !status.is_empty() {
        ui.label(RichText::new(status).size(11.0).color(tokens.muted));
    }
    if close {
        app.overlays.telegram = None;
    }
    if pair {
        let code: String = (0..6)
            .map(|_| {
                let value = (chrono::Utc::now().timestamp_subsec_nanos() % 36) as u8;
                char::from_digit(value as u32 % 10, 10).unwrap_or('0')
            })
            .collect();
        if let Some(state) = app.overlays.telegram.as_mut() {
            state.pair_code = code;
            state.status =
                "Pairing needs `agente telegram pair` on the server; the code is a local stand-in."
                    .to_owned();
        }
    }
}

/// The character editor: card fields and the opening greeting.
pub fn character_editor(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(editor) = app.overlays.character_editor.as_ref() else {
        return;
    };
    let mut name = editor.name.clone();
    let mut nickname = editor.nickname.clone();
    let mut persona = editor.persona.clone();
    let mut greeting = editor.greeting.clone();
    let mut scenario = editor.scenario.clone();
    let mut example = editor.example_dialogue.clone();
    let index = editor.index;
    let mut save = false;
    let mut close = false;
    let mut lorebook = false;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new(if index.is_some() { "Edit character" } else { "New character" })
                .size(15.0)
                .strong()
                .color(tokens.text),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                close = true;
            }
        });
    });
    ui.separator();
    ScrollArea::vertical()
        .max_height(380.0)
        .auto_shrink([false, true])
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label("Name");
                widgets::search_row(ui, &mut name, "Ada");
            });
            ui.horizontal(|ui| {
                ui.label("Nickname");
                widgets::search_row(ui, &mut nickname, "optional");
            });
            widgets::section_header(ui, tokens, "Persona");
            ui.add(
                egui::TextEdit::multiline(&mut persona)
                    .desired_rows(4)
                    .desired_width(f32::INFINITY),
            );
            widgets::section_header(ui, tokens, "Greeting");
            ui.add(
                egui::TextEdit::multiline(&mut greeting)
                    .desired_rows(3)
                    .desired_width(f32::INFINITY),
            );
            widgets::section_header(ui, tokens, "Scenario");
            ui.add(
                egui::TextEdit::multiline(&mut scenario)
                    .desired_rows(2)
                    .desired_width(f32::INFINITY),
            );
            widgets::section_header(ui, tokens, "Example dialogue");
            ui.add(
                egui::TextEdit::multiline(&mut example)
                    .desired_rows(3)
                    .desired_width(f32::INFINITY),
            );
        });
    ui.add_space(6.0);
    ui.horizontal(|ui| {
        if ui.button("Save").clicked() {
            save = true;
        }
        if ui.button("Lorebook").clicked() {
            lorebook = true;
        }
    });

    if let Some(editor) = app.overlays.character_editor.as_mut() {
        editor.name = name.clone();
        editor.nickname = nickname;
        editor.persona = persona.clone();
        editor.greeting = greeting;
        editor.scenario = scenario;
        editor.example_dialogue = example;
    }
    if close {
        app.overlays.character_editor = None;
        return;
    }
    if lorebook {
        app.overlays.lorebook = Some(Default::default());
    }
    if save {
        match index {
            Some(index) => {
                if let Some(character) = app.roleplay.characters.get_mut(index) {
                    character.name = name.clone();
                    character.persona = persona.clone();
                }
            }
            None => app.roleplay.characters.push(crate::state::CharacterItem {
                name: name.clone(),
                persona: persona.clone(),
            }),
        }
        app.overlays.character_editor = None;
        app.toast(format!("Saved {name}"));
        app.dirty = true;
    }
}

/// The lorebook: keyword-triggered entries injected into the scene.
pub fn lorebook(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(state) = app.overlays.lorebook.as_ref() else {
        return;
    };
    let entries: Vec<(String, String, bool)> = state
        .entries
        .iter()
        .map(|entry| (entry.keys.clone(), entry.content.clone(), entry.enabled))
        .collect();
    let mut keys = state.draft_keys.clone();
    let mut content = state.draft_content.clone();
    let mut add = false;
    let mut remove: Option<usize> = None;
    let mut toggle: Option<usize> = None;
    let mut close = false;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new("Lorebook")
                .size(15.0)
                .strong()
                .color(tokens.text),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                close = true;
            }
        });
    });
    ui.separator();
    if entries.is_empty() {
        widgets::empty_state(
            ui,
            tokens,
            "No entries. An entry fires when one of its keys appears in the scene.",
        );
    }
    for (index, (entry_keys, text, enabled)) in entries.iter().enumerate() {
        ui.horizontal(|ui| {
            let mark = if *enabled { "●" } else { "○" };
            ui.label(
                RichText::new(format!("{mark} {entry_keys}"))
                    .size(12.0)
                    .monospace()
                    .color(tokens.text),
            );
            if ui.small_button("Remove").clicked() {
                remove = Some(index);
            }
            if ui.small_button(if *enabled { "Disable" } else { "Enable" }).clicked() {
                toggle = Some(index);
            }
        });
        ui.label(RichText::new(text).size(11.0).color(tokens.muted));
    }
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        ui.label("Keys");
        widgets::search_row(ui, &mut keys, "comma separated");
    });
    ui.add(
        egui::TextEdit::multiline(&mut content)
            .hint_text("What the model should know…")
            .desired_rows(2)
            .desired_width(f32::INFINITY),
    );
    if ui.button("Add entry").clicked() {
        add = true;
    }

    if let Some(state) = app.overlays.lorebook.as_mut() {
        state.draft_keys = keys;
        state.draft_content = content;
    }
    if close {
        app.overlays.lorebook = None;
        return;
    }
    if add {
        if let Some(state) = app.overlays.lorebook.as_mut() {
            state.add();
        }
        app.dirty = true;
    }
    if let Some(index) = toggle {
        if let Some(state) = app.overlays.lorebook.as_mut() {
            if let Some(entry) = state.entries.get_mut(index) {
                entry.enabled = !entry.enabled;
            }
        }
        app.dirty = true;
    }
    if let Some(index) = remove {
        if let Some(state) = app.overlays.lorebook.as_mut() {
            if index < state.entries.len() {
                state.entries.remove(index);
            }
        }
        app.dirty = true;
    }
}

/// The prompt inspector: the exact system prompt and messages for this session.
pub fn prompt_inspector(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(state) = app.overlays.prompt_inspector.as_ref() else {
        return;
    };
    let system = state.system.clone();
    let messages = state.messages.clone();
    let tokens_estimate = state.tokens;
    let mut close = false;
    let mut refresh = false;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new("Prompt")
                .size(15.0)
                .strong()
                .color(tokens.text),
        );
        ui.label(
            RichText::new(format!("~{tokens_estimate} tokens"))
                .size(12.0)
                .color(tokens.muted),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                close = true;
            }
        });
    });
    ui.separator();
    ui.horizontal(|ui| {
        if ui.button("Refresh").clicked() {
            refresh = true;
        }
    });
    ScrollArea::vertical()
        .max_height(400.0)
        .auto_shrink([false, true])
        .show(ui, |ui| {
            widgets::section_header(ui, tokens, "System");
            ui.label(
                RichText::new(if system.is_empty() {
                    "The system prompt is built by the engine on the first turn."
                } else {
                    &system
                })
                .size(11.0)
                .monospace()
                .color(tokens.secondary),
            );
            widgets::section_header(ui, tokens, "Messages");
            ui.label(
                RichText::new(if messages.is_empty() {
                    "No turns yet."
                } else {
                    &messages
                })
                .size(11.0)
                .monospace()
                .color(tokens.secondary),
            );
        });
    if close {
        app.overlays.prompt_inspector = None;
    }
    if refresh {
        app.open_prompt_inspector();
    }
}

/// The local runtime panel: hardware, model files and what is loaded.
pub fn runtime(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(state) = app.overlays.runtime.as_ref() else {
        return;
    };
    let hardware = state.hardware.clone();
    let note = state.note.clone();
    let models: Vec<(String, String, String)> = state
        .models
        .iter()
        .map(|model| (model.name.clone(), model.path.clone(), model.size.clone()))
        .collect();
    let loaded = state.loaded.clone();
    let mut close = false;
    let mut refresh = false;
    let mut load: Option<String> = None;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new("Local runtime")
                .size(15.0)
                .strong()
                .color(tokens.text),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                close = true;
            }
        });
    });
    ui.separator();
    ui.label(RichText::new(&hardware).size(12.0).color(tokens.secondary));
    ui.label(RichText::new(&note).size(11.0).color(tokens.muted));
    ui.add_space(6.0);
    widgets::section_header(ui, tokens, &format!("Models · {}", models.len()));
    for (name, path, size) in &models {
        ui.horizontal(|ui| {
            ui.label(RichText::new(name).size(12.0).color(tokens.text));
            ui.label(RichText::new(size).size(11.0).color(tokens.muted));
            if ui.small_button("Load").clicked() {
                load = Some(path.clone());
            }
        });
    }
    if let Some(loaded) = loaded {
        ui.label(
            RichText::new(format!("Loaded: {loaded}"))
                .size(12.0)
                .color(tokens.success),
        );
    }
    ui.horizontal(|ui| {
        if ui.button("Refresh").clicked() {
            refresh = true;
        }
    });
    if close {
        app.overlays.runtime = None;
    }
    if refresh {
        app.refresh_runtime();
    }
    if let Some(path) = load {
        let provider = "llamacpp".to_owned();
        let model = std::path::Path::new(&path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        app.set_provider(&provider);
        app.set_model(&model);
        if let Some(state) = app.overlays.runtime.as_mut() {
            state.loaded = Some(model.clone());
        }
        app.toast(format!(
            "Pointed the session at {provider}/{model}. Start llama-server with that file."
        ));
    }
}

/// Every editor window that is open, painted over the space.
pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let ctx = ui.ctx().clone();
    if app.overlays.studio.is_some() {
        egui::Window::new("Artifact studio")
            .collapsible(false)
            .resizable(true)
            .default_width(760.0)
            .show(&ctx, |ui| studio(ui, app));
    }
    if app.overlays.bot_editor.is_some() {
        egui::Window::new("Bot")
            .collapsible(false)
            .resizable(true)
            .default_width(560.0)
            .show(&ctx, |ui| bot_editor(ui, app));
    }
    if app.overlays.routines.is_some() {
        egui::Window::new("Routines")
            .collapsible(false)
            .resizable(true)
            .default_width(540.0)
            .show(&ctx, |ui| routines(ui, app));
    }
    if app.overlays.telegram.is_some() {
        egui::Window::new("Telegram")
            .collapsible(false)
            .resizable(true)
            .default_width(440.0)
            .show(&ctx, |ui| telegram(ui, app));
    }
    if app.overlays.character_editor.is_some() {
        egui::Window::new("Character")
            .collapsible(false)
            .resizable(true)
            .default_width(560.0)
            .show(&ctx, |ui| character_editor(ui, app));
    }
    if app.overlays.lorebook.is_some() {
        egui::Window::new("Lorebook")
            .collapsible(false)
            .resizable(true)
            .default_width(520.0)
            .show(&ctx, |ui| lorebook(ui, app));
    }
    if app.overlays.prompt_inspector.is_some() {
        egui::Window::new("Prompt")
            .collapsible(false)
            .resizable(true)
            .default_width(620.0)
            .show(&ctx, |ui| prompt_inspector(ui, app));
    }
    if app.overlays.runtime.is_some() {
        egui::Window::new("Local runtime")
            .collapsible(false)
            .resizable(true)
            .default_width(520.0)
            .show(&ctx, |ui| runtime(ui, app));
    }
}
