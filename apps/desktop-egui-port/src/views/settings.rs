//! Settings screen. Ports `SettingsScreen.svelte`: its own nav rail on the
//! left (back link, filter, grouped sections, provider list) and a content
//! column of section cards whose rows are label + description on the left and
//! the control on the right.
//!
//! Everything provider-shaped writes into the core `AppConfig`
//! (`~/.agente/config.json`), so the port and the TUI share keys and models.

use egui::{RichText, Ui};

use crate::app::DesktopApp;
use crate::state::SettingsSection;
use crate::widgets;

/// The settings rail: back link, filter, groups and providers.
pub fn rail(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    ui.add_space(8.0);
    if widgets::row(
        ui,
        tokens,
        widgets::Row::new(crate::icons::ICON_BACK, "Back to the conversation"),
    )
    .clicked()
    {
        app.nav.close_settings();
    }
    ui.add_space(2.0);
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        ui.label(
            RichText::new(crate::icons::ICON_SEARCH)
                .size(13.0)
                .color(tokens.muted),
        );
        widgets::search_row(ui, &mut app.settings_ui.filter, "Filter sections");
    });
    ui.add_space(8.0);

    let filter = app.settings_ui.filter.to_lowercase();
    let matches = |label: &str| filter.is_empty() || label.to_lowercase().contains(&filter);

    widgets::section_header(ui, tokens, "Models");
    for (section, label) in [
        (SettingsSection::ThisComputer, "On this computer"),
        (SettingsSection::Artifacts, "Library"),
    ] {
        if matches(label)
            && widgets::row(
                ui,
                tokens,
                widgets::Row::new(crate::icons::ICON_CPU, label)
                    .current(app.settings_ui.section == section),
            )
            .clicked()
        {
            app.settings_ui.section = section;
            app.dirty = true;
        }
    }

    widgets::section_header(ui, tokens, "Preferences");
    for section in SettingsSection::ALL.iter().copied() {
        if !matches(section.label()) {
            continue;
        }
        let icon = match section {
            SettingsSection::General => crate::icons::ICON_SETTINGS,
            SettingsSection::Search => crate::icons::ICON_SEARCH,
            SettingsSection::Artifacts => crate::icons::ICON_ARTIFACT,
            SettingsSection::ThisComputer => crate::icons::ICON_CPU,
            SettingsSection::Voice => crate::icons::ICON_MIC,
            SettingsSection::Accessibility => crate::icons::ICON_SLIDERS,
            SettingsSection::Provider => crate::icons::ICON_GLOBE,
        };
        if widgets::row(
            ui,
            tokens,
            widgets::Row::new(icon, section.label()).current(app.settings_ui.section == section),
        )
        .clicked()
        {
            app.settings_ui.section = section;
            app.dirty = true;
        }
    }

    ui.add_space(6.0);
    let providers = app.engine.registry().provider_ids();
    egui::containers::Sides::new().height(20.0).show(
        ui,
        |ui| widgets::section_header(ui, tokens, "Model providers"),
        |ui| {
            let _ = widgets::icon_button(ui, tokens, crate::icons::ICON_PLUS, 22.0);
        },
    );
    for id in providers {
        if !matches(&id) {
            continue;
        }
        let has_key = app.engine.registry().has_api_key(&id);
        let current = app.settings_ui.section == SettingsSection::Provider
            && app.settings_ui.provider == id;
        let mark = if has_key {
            crate::icons::ICON_CHECK
        } else {
            crate::icons::ICON_GLOBE
        };
        if widgets::row(
            ui,
            tokens,
            widgets::Row::new(mark, &id)
                .current(current)
                .meta(if has_key { "key set" } else { "" }),
        )
        .clicked()
        {
            app.settings_ui.section = SettingsSection::Provider;
            app.settings_ui.provider = id.clone();
            app.dirty = true;
        }
    }
}

/// One section's card: rows on `#1e1e1e` with a hairline between them.
fn section_card<R>(ui: &mut Ui, tokens: crate::style::ThemeTokens, rows: impl FnOnce(&mut Ui) -> R) -> R {
    egui::Frame {
        fill: tokens.card,
        corner_radius: egui::CornerRadius::from(12u8),
        inner_margin: egui::Margin::symmetric(16, 0),
        ..Default::default()
    }
    .show(ui, |ui| {
        ui.set_width(ui.available_width());
        rows(ui)
    })
    .inner
}

/// One settings row: label + description on the left, control on the right.
fn setting_row(
    ui: &mut Ui,
    tokens: crate::style::ThemeTokens,
    label: &str,
    description: &str,
    control: impl FnOnce(&mut Ui) -> bool,
) -> bool {
    let mut changed = false;
    egui::containers::Sides::new()
        .height(52.0)
        .shrink_left()
        .show(
            ui,
            |ui| {
                ui.vertical(|ui| {
                    ui.add_space(8.0);
                    ui.label(RichText::new(label).size(13.0).color(tokens.text));
                    ui.label(RichText::new(description).size(12.0).color(tokens.muted));
                });
            },
            |ui| {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    changed = control(ui);
                });
            },
        );
    ui.separator();
    changed
}

/// The settings content column.
pub fn content(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let section = app.settings_ui.section;
    let mut dirty = false;

    ui.add_space(10.0);
    ui.label(RichText::new(section.label()).size(20.0).color(tokens.text));
    ui.label(RichText::new(section.blurb()).size(13.0).color(tokens.muted));
    ui.add_space(14.0);

    match section {
        SettingsSection::General => {
            widgets::section_header(ui, tokens, "Profile");
            section_card(ui, tokens, |ui| {
            if setting_row(ui, tokens, "Your name", "Shown in the welcome greeting.", |ui| {
                widgets::field(ui, tokens, &mut app.settings_ui.name, "Enter your name")
            }) {
                dirty = true;
            }
            if setting_row(ui, tokens, "Language", "The language of the interface.", |ui| {
                let current = app.settings_ui.language.clone();
                let mut picked = current.clone();
                egui::ComboBox::from_id_salt("settings-language")
                    .selected_text(if current.is_empty() {
                        "English".to_owned()
                    } else {
                        current.clone()
                    })
                    .show_ui(ui, |ui| {
                        for option in ["English", "Español", "Português"] {
                            ui.selectable_value(&mut picked, option.to_owned(), option);
                        }
                    });
                if picked != current {
                    app.settings_ui.language = picked;
                    return true;
                }
                false
            }) {
                dirty = true;
            }

            widgets::section_header(ui, tokens, "Chats");
            if setting_row(
                ui,
                tokens,
                "Show assistant text",
                "Show the reply text as it streams in.",
                |ui| toggle(ui, &mut app.settings_ui.show_assistant_text),
            ) {
                dirty = true;
            }
            if setting_row(
                ui,
                tokens,
                "Thinking",
                "Keep the reasoning stream visible for review.",
                |ui| toggle(ui, &mut app.settings_ui.thinking_enabled),
            ) {
                dirty = true;
            }
            if setting_row(
                ui,
                tokens,
                "Roleplay",
                "Enables the Roleplay space: character cards, personas and scenes.",
                |ui| toggle(ui, &mut app.settings_ui.roleplay_enabled),
            ) {
                dirty = true;
            }
            });

            widgets::section_header(ui, tokens, "Appearance");
            section_card(ui, tokens, |ui| {
            if setting_row(ui, tokens, "Theme", "Choose light or dark.", |ui| {
                let current = if app.prefs.theme_dark { 1 } else { 0 };
                if let Some(picked) = widgets::segmented(ui, tokens, &["Light", "Dark"], current) {
                    app.prefs.theme_dark = picked == 1;
                    app.theme_dirty = true;
                    return true;
                }
                false
            }) {
                dirty = true;
            }
            });
        }

        SettingsSection::Search => {
            widgets::section_header(ui, tokens, "Web search");
            section_card(ui, tokens, |ui| {
            if setting_row(
                ui,
                tokens,
                "Provider",
                "Which engine the agent's web tools use.",
                |ui| {
                    let current = app.settings_ui.search_provider.clone();
                    let mut picked = current.clone();
                    egui::ComboBox::from_id_salt("settings-search-provider")
                        .selected_text(if current.is_empty() {
                            "Aggregator".to_owned()
                        } else {
                            current.clone()
                        })
                        .show_ui(ui, |ui| {
                            for option in ["Aggregator", "Brave", "Searx", "Tavily"] {
                                ui.selectable_value(&mut picked, option.to_owned(), option);
                            }
                        });
                    if picked != current {
                        app.settings_ui.search_provider = picked;
                        return true;
                    }
                    false
                },
            ) {
                dirty = true;
            }
            if setting_row(
                ui,
                tokens,
                "Deep research by default",
                "Start research turns with the deep-research loop.",
                |ui| toggle(ui, &mut app.settings_ui.deep_research_default),
            ) {
                dirty = true;
            }
            });
            ui.add_space(8.0);
            ui.label(
                RichText::new(
                    "Search runs through the core `web_search` and `web_fetch` tools, so the terminal agent and this app share one policy.",
                )
                .size(12.0)
                .color(tokens.muted),
            );
        }

        SettingsSection::Artifacts => {
            widgets::section_header(ui, tokens, "Artifact types");
            section_card(ui, tokens, |ui| {
                for kind in ["Markdown", "HTML", "Slides", "Spreadsheets", "Documents"] {
                    let mut enabled = true;
                    setting_row(ui, tokens, kind, "May be created and previewed.", |ui| {
                        toggle(ui, &mut enabled)
                    });
                }
            });
            ui.add_space(8.0);
            ui.label(
                RichText::new(
                    "The studio edits sources in place; binaries are regenerated from their source.",
                )
                .size(12.0)
                .color(tokens.muted),
            );
        }

        SettingsSection::ThisComputer => {
            widgets::section_header(ui, tokens, "Runtime");
            let models = app
                .overlays
                .runtime
                .as_ref()
                .map(|runtime| runtime.models.len())
                .unwrap_or(0);
            ui.label(
                RichText::new(format!(
                    "{} · {models} model files under ~/.agente/models",
                    std::env::consts::OS
                ))
                .size(13.0)
                .color(tokens.secondary),
            );
            ui.add_space(8.0);
            if ui.button("Open the local runtime panel").clicked() {
                app.refresh_runtime();
            }
            widgets::section_header(ui, tokens, "Providers on this machine");
            section_card(ui, tokens, |ui| {
            for id in app.engine.registry().provider_ids() {
                let local = matches!(id.as_str(), "llamacpp" | "ollama");
                if !local {
                    continue;
                }
                if setting_row(ui, tokens, &id, "Local endpoint, no key needed.", |ui| {
                    if ui.small_button("Use").clicked() {
                        app.set_provider(&id);
                        return true;
                    }
                    false
                }) {
                    dirty = true;
                }
            }
            });
        }

        SettingsSection::Voice => {
            widgets::section_header(ui, tokens, "Dictation");
            section_card(ui, tokens, |ui| {
            if setting_row(
                ui,
                tokens,
                "Hands-free mode",
                "Re-arm the microphone after each reply.",
                |ui| toggle(ui, &mut app.overlays.voice.hands_free),
            ) {
                dirty = true;
            }
            if setting_row(ui, tokens, "Speech to text", "Model used for dictation.", |ui| {
                widgets::field(ui, tokens, &mut app.overlays.voice.voice, "whisper model")
            }) {
                dirty = true;
            }
            });
            widgets::section_header(ui, tokens, "Playback");
            section_card(ui, tokens, |ui| {
            if setting_row(
                ui,
                tokens,
                "Speak replies",
                "Read answers aloud with the system voice.",
                |ui| toggle(ui, &mut app.overlays.voice.speaking),
            ) {
                dirty = true;
            }
            });
        }

        SettingsSection::Accessibility => {
            widgets::section_header(ui, tokens, "Text");
            section_card(ui, tokens, |ui| {
            if setting_row(
                ui,
                tokens,
                "Text size",
                "Moves captions, chrome, prose and code together.",
                |ui| {
                    let mut scale = app.prefs.reading_scale.clamp(0.9, 1.4);
                    let changed = ui
                        .add(egui::Slider::new(&mut scale, 0.9..=1.4).step_by(0.05))
                        .changed();
                    if changed {
                        app.prefs.reading_scale = scale;
                        app.theme_dirty = true;
                    }
                    changed
                },
            ) {
                dirty = true;
            }
            if setting_row(
                ui,
                tokens,
                "Higher contrast",
                "Moves secondary text and hairlines toward the foreground.",
                |ui| toggle(ui, &mut app.settings_ui.contrast),
            ) {
                dirty = true;
            }
            if setting_row(
                ui,
                tokens,
                "Reduce motion",
                "Snap instead of easing, and freeze ambient paint.",
                |ui| toggle(ui, &mut app.prefs.reduce_motion),
            ) {
                dirty = true;
            }
            });
        }

        SettingsSection::Provider => {
            let provider = if app.settings_ui.provider.is_empty() {
                app.engine
                    .config()
                    .default_provider
                    .clone()
                    .unwrap_or_else(|| "openrouter".to_owned())
            } else {
                app.settings_ui.provider.clone()
            };
            widgets::section_header(ui, tokens, "Endpoint");
            ui.horizontal(|ui| {
                ui.label(RichText::new(&provider).size(13.0).color(tokens.text));
                let has_key = app.engine.registry().has_api_key(&provider);
                ui.label(
                    RichText::new(if has_key { "key set" } else { "no key" })
                        .size(12.0)
                        .color(if has_key {
                            tokens.success
                        } else {
                            tokens.warning
                        }),
                );
            });
            if setting_row(
                ui,
                tokens,
                "API key",
                "Stored in the core config, owner-only.",
                |ui| {
                    let changed = ui
                        .add(
                            egui::TextEdit::singleline(&mut app.settings_ui.key_draft)
                                .password(true)
                                .hint_text("paste the key")
                                .desired_width(240.0),
                        )
                        .changed();
                    if ui.small_button("Store").clicked() {
                        let key = app.settings_ui.key_draft.trim().to_owned();
                        if !key.is_empty() {
                            let config = app.engine.config_mut();
                            config
                                .provider
                                .entry(provider.clone())
                                .or_default()
                                .options
                                .api_key = Some(key);
                            app.engine.reload_providers();
                            match app.engine.save_config() {
                                Ok(()) => app.toast_ok("Key stored"),
                                Err(error) => app.toast_err(format!("Could not save: {error}")),
                            }
                            app.settings_ui.key_draft.clear();
                            return true;
                        }
                    }
                    changed
                },
            ) {
                dirty = true;
            }
            if setting_row(ui, tokens, "Base URL", "Optional endpoint override.", |ui| {
                let mut base = app
                    .engine
                    .config()
                    .provider
                    .get(&provider)
                    .and_then(|entry| entry.options.base_url.clone())
                    .unwrap_or_default();
                if widgets::field(ui, tokens, &mut base, "https://…") {
                    let value = base.trim().to_owned();
                    let config = app.engine.config_mut();
                    let entry = config.provider.entry(provider.clone()).or_default();
                    entry.options.base_url = if value.is_empty() { None } else { Some(value) };
                    app.engine.reload_providers();
                    app.engine.save_config().ok();
                    return true;
                }
                false
            }) {
                dirty = true;
            }
            widgets::section_header(ui, tokens, "Model");
            section_card(ui, tokens, |ui| {
            if setting_row(ui, tokens, "Default model", "Used for new turns.", |ui| {
                let mut model = app
                    .engine
                    .config()
                    .default_model
                    .clone()
                    .unwrap_or_default();
                if widgets::field(ui, tokens, &mut model, "provider/model-id…") {
                    app.set_model(&model);
                    return true;
                }
                false
            }) {
                dirty = true;
            }
            if setting_row(ui, tokens, "Thinking level", "`auto` sends nothing.", |ui| {
                let levels = ["auto", "low", "medium", "high", "max"];
                let current = levels
                    .iter()
                    .position(|level| *level == app.prefs.thinking_level)
                    .unwrap_or(0);
                if let Some(picked) = widgets::segmented(ui, tokens, &levels, current) {
                    app.prefs.thinking_level = levels[picked].to_owned();
                    app.engine.update_thinking(&app.prefs.thinking_level);
                    return true;
                }
                false
            }) {
                dirty = true;
            }
            if setting_row(
                ui,
                tokens,
                "Auto-approve tools",
                "Skip the approval card for mutating tools.",
                |ui| toggle(ui, &mut app.code.auto_approve),
            ) {
                app.engine.set_auto_approve(app.code.auto_approve);
                dirty = true;
            }
            if setting_row(
                ui,
                tokens,
                "Project folder",
                "Where the code workspace runs.",
                |ui| widgets::field(ui, tokens, &mut app.code.project_dir, "/path/to/project…"),
            ) {
                dirty = true;
            }
            if setting_row(
                ui,
                tokens,
                "Advanced",
                "Engine facts and the config path.",
                |ui| {
                    let label = if app.settings_ui.show_advanced {
                        "Hide"
                    } else {
                        "Show"
                    };
                    if ui.small_button(label).clicked() {
                        app.settings_ui.toggle_advanced();
                        return true;
                    }
                    false
                },
            ) {
                dirty = true;
            }
            });
            if app.settings_ui.show_advanced {
                let config = app.engine.config();
                ui.label(
                    RichText::new(format!(
                        "max iterations {} · parallel subagents {} · smart compaction {} · MCP servers {} · protocol {}",
                        config.max_iterations(),
                        config.parallel_subagents(),
                        config.smart_compaction,
                        config.mcp.len(),
                        DesktopApp::protocol_version()
                    ))
                    .size(12.0)
                    .color(tokens.muted),
                );
                if let Some(path) = agente_core::config::AppConfig::global_config_path() {
                    ui.label(
                        RichText::new(path.display().to_string())
                            .size(11.0)
                            .monospace()
                            .color(tokens.muted),
                    );
                }
            }
        }
    }

    if dirty {
        app.dirty = true;
    }
}

/// A switch, drawn as Electron's pill.
fn toggle(ui: &mut Ui, value: &mut bool) -> bool {
    let tokens = crate::style::ThemeTokens::of(if ui.visuals().dark_mode {
        crate::style::Theme::Dark
    } else {
        crate::style::Theme::Light
    });
    let before = *value;
    if widgets::switch(ui, tokens, *value).clicked() {
        *value = !*value;
    }
    *value != before
}
