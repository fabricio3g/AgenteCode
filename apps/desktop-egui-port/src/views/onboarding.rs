//! Onboarding wizard. Ports the onboarding steps.

use egui::Ui;

use crate::app::DesktopApp;
use crate::widgets;

pub fn show(ui: &mut Ui, app: &mut DesktopApp) -> bool {
    let step = crate::state::OnboardingState::STEPS
        .get(app.onboarding.step)
        .copied()
        .unwrap_or("Ready");
    ui.label(
        egui::RichText::new(format!(
            "Step {} of {} · {step}",
            app.onboarding.step + 1,
            crate::state::OnboardingState::STEPS.len()
        ))
        .size(14.0),
    );
    ui.label(match step {
        "Welcome" => {
            "Agente Code is a local AI workspace. Chat, Code, Artifacts, Bots and Roleplay live in the left rail."
        }
        "Model" => {
            "Add a provider key in Settings, then pick a model. Keys are shared with the terminal agent."
        }
        "Runtime" => {
            "Point the Code space at a project folder. Plan mode reads; Build mode edits with approval."
        }
        _ => "You are ready. Open the Code space and ask for a change.",
    });
    ui.separator();

    // Step 2 asks for the model, step 3 for the project folder.
    if step == "Model" {
        let providers = app.engine.registry().provider_ids();
        let current = app
            .engine
            .config()
            .default_provider
            .clone()
            .unwrap_or_default();
        let mut selected = current.clone();
        egui::ComboBox::from_label("Provider").show_ui(ui, |ui| {
            for id in &providers {
                ui.selectable_value(&mut selected, id.clone(), id);
            }
        });
        if selected != current && !selected.is_empty() {
            app.set_provider(&selected);
        }
        ui.horizontal(|ui| {
            ui.label("API key");
            ui.add(
                egui::TextEdit::singleline(&mut app.settings_ui.key_draft)
                    .password(true)
                    .hint_text("paste the key")
                    .desired_width(f32::INFINITY),
            );
        });
        if ui.small_button("Store key").clicked() {
            let key = app.settings_ui.key_draft.trim().to_owned();
            if !key.is_empty() {
                let provider = app
                    .engine
                    .config()
                    .default_provider
                    .clone()
                    .unwrap_or_else(|| "openrouter".to_owned());
                let config = app.engine.config_mut();
                config
                    .provider
                    .entry(provider)
                    .or_default()
                    .options
                    .api_key = Some(key);
                app.engine.reload_providers();
                match app.engine.save_config() {
                    Ok(()) => app.toast_ok("Key stored"),
                    Err(error) => app.toast_err(format!("Could not save: {error}")),
                }
                app.settings_ui.key_draft.clear();
            }
        }
        ui.horizontal(|ui| {
            ui.label("Model");
            let mut model = app
                .engine
                .config()
                .default_model
                .clone()
                .unwrap_or_default();
            if widgets::search_row(ui, &mut model, "provider/model-id…") {
                app.set_model(&model);
            }
        });
    }
    if step == "Runtime" {
        ui.horizontal(|ui| {
            ui.label("Project folder");
            if widgets::search_row(ui, &mut app.code.project_dir, "/path/to/project…") {
                app.dirty = true;
            }
        });
        ui.horizontal(|ui| {
            let mut plan = app.code.mode == crate::backend::AgentMode::Plan;
            ui.checkbox(&mut plan, "Start in Plan mode");
            app.code.mode = if plan {
                crate::backend::AgentMode::Plan
            } else {
                crate::backend::AgentMode::Build
            };
        });
    }

    let mut finished = false;
    ui.horizontal(|ui| {
        if app.onboarding.step > 0 && ui.small_button("Back").clicked() {
            app.onboarding.back();
        }
        if ui
            .small_button(
                if app.onboarding.step + 1 >= crate::state::OnboardingState::STEPS.len() {
                    "Finish"
                } else {
                    "Next"
                },
            )
            .clicked()
        {
            app.onboarding.next();
            if app.onboarding.done {
                finished = true;
            }
        }
        if ui.small_button("Skip").clicked() {
            app.onboarding.finish();
            finished = true;
        }
    });
    finished
}
