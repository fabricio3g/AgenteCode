//! Code workspace view. Ports `CodeSurface` plus the workspace panes: the
//! project header lives in the PanelTabs strip; this owns approvals, changed
//! files, the transcript, todos and the prompt composer.

use egui::{CentralPanel, Panel, RichText, ScrollArea, Ui};

use crate::app::{DesktopApp, TurnTarget};
use crate::backend::AgentMode;
use crate::state::{Entry, RunState};
use crate::style::geom;
use crate::views::{composer, thread};
use crate::widgets;

/// Shows the code surface.
pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let scale = app.prefs.reading_scale;

    Panel::bottom("code-composer")
        .frame(egui::Frame {
            fill: tokens.bg,
            ..Default::default()
        })
        .show(ui, |ui| {
            widgets::centered_column(ui, geom::THREAD_W, |ui| {
                if !app.toasts.is_empty() {
                    widgets::toast_bar(ui, tokens, &mut app.toasts);
                }
                let (provider, model) = app.active_model();
                let model_label = if model.is_empty() {
                    "Pick a model".to_owned()
                } else {
                    format!("{provider} / {model}")
                };
                let thinking = app.prefs.thinking_level.clone();
                let mode_label = app.code.mode.label();
                let mut draft = std::mem::take(&mut app.code.composer);
                let out = {
                    let session = &mut app.code.run;
                    composer::show_composer(
                        ui,
                        tokens,
                        session,
                        &mut draft,
                        "Ask for a change in this project…",
                        &model_label,
                        &thinking,
                        &[],
                        &[],
                        None,
                        false,
                        mode_label,
                    )
                };
                app.code.composer = draft;
                if out.open_settings {
                    app.nav.settings_open = true;
                }
                if let Some(note) = out.note {
                    app.toast(note);
                }
                if let Some(level) = out.thinking {
                    app.prefs.thinking_level = level.clone();
                    app.engine.update_thinking(&level);
                }
                if let Some(line) = out.slash {
                    if let Some((id, arg)) = crate::app::commands::parse_slash(&line) {
                        crate::app::commands::run(app, id, arg);
                    }
                    return;
                }
                if out.stopped {
                    app.stop_turn();
                }
                if out.sent {
                    send_code_prompt(app);
                }
            });
        });

    CentralPanel::default().show(ui, |ui| {
        ScrollArea::vertical()
            .auto_shrink([false; 2])
            .show(ui, |ui| {
                widgets::centered_column(ui, geom::THREAD_W, |ui| {
                    pane_doors(ui, app);
                    ui.add_space(6.0);
                    approvals(ui, app);
                    changed_files(ui, app);
                    subagents(ui, app);

                    let entries = app.code.run.entries.clone();
                    if entries.is_empty() {
                        widgets::empty_state(
                            ui,
                            tokens,
                            "No turns yet. Ask for a change to start the loop.",
                        );
                    } else {
                        let jump = app.scroll_to_bottom;
            let out = thread::show_thread(ui, tokens, scale, &entries, jump);
                        apply_thread_out(app, out);
                    }

                    ui.separator();
                    todos(ui, app);
                });
            });
    });
}

fn send_code_prompt(app: &mut DesktopApp) {
    let text = std::mem::take(&mut app.code.composer);
    let prompt = text.trim().to_owned();
    if prompt.is_empty() {
        return;
    }
    let live = app.code.run.state != RunState::Idle;
    if live {
        if app.engine.steer(&prompt, None) {
            app.code.run.entries.push(Entry::user(&prompt));
        } else {
            app.toast("The turn already finished — send again.");
            app.code.composer = text;
        }
        return;
    }
    app.code.run.push_user(&prompt, &prompt);
    let mode = app.code.mode;
    app.order_turn(TurnTarget::Code, mode);
}

fn apply_thread_out(app: &mut DesktopApp, out: thread::ThreadOut) {
    if let Some(text) = out.copy_text {
        if let Some(clipboard) = app.clipboard.as_mut() {
            let _ = clipboard.set_text(text);
        }
        app.toast("Copied");
    }
    if let Some(index) = out.edit_index {
        if let Some(entry) = app.code.run.entries.get(index) {
            app.overlays.edit_message = Some(crate::state::overlays::EditMessageState {
                session_id: "code".to_owned(),
                index,
                text: entry.text.clone(),
            });
        }
    }
    if let Some(index) = out.delete_index {
        if index < app.code.run.entries.len() {
            let entry = app.code.run.entries.remove(index);
            if entry.kind == crate::state::EntryKind::User {
                if let Some(position) = app
                    .code
                    .run
                    .conversation
                    .iter()
                    .position(|message| {
                        message.role == agente_core::types::Role::User
                            && message.content == entry.text
                    })
                {
                    app.code.run.conversation.truncate(position);
                }
            }
            app.dirty = true;
        }
        if out.retry {
            app.order_turn(TurnTarget::Code, AgentMode::Build);
        }
    }
}

fn approvals(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    if app.code.run.approvals.is_empty() {
        return;
    }
    let pending: Vec<(String, String, String, bool, Option<String>)> = app
        .code
        .run
        .approvals
        .iter()
        .map(|request| {
            (
                request.request_id.clone(),
                request.tool_name.clone(),
                request.description.clone(),
                request.is_dangerous,
                request.file_path.clone(),
            )
        })
        .collect();

    widgets::card_frame(tokens, 12.0, egui::Margin::symmetric(14, 12)).show(ui, |ui| {
        ui.label(
            RichText::new("Approval needed")
                .size(13.0)
                .strong()
                .color(tokens.warning),
        );
        for (_, tool, description, dangerous, path) in &pending {
            ui.add_space(4.0);
            ui.label(
                RichText::new(format!("{tool} · {description}"))
                    .size(13.0)
                    .color(tokens.text),
            );
            if let Some(path) = path {
                ui.label(
                    RichText::new(path)
                        .size(12.0)
                        .monospace()
                        .color(tokens.secondary),
                );
            }
            if *dangerous {
                ui.label(RichText::new("dangerous").size(12.0).color(tokens.error));
            }
        }
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            let mut action = None;
            if ui.button("Approve once").clicked() {
                action = Some(agente_core::types::ApprovalAction::ApproveOnce);
            }
            if ui.button("Approve all").clicked() {
                action = Some(agente_core::types::ApprovalAction::ApproveAll);
            }
            if ui.button("Deny").clicked() {
                action = Some(agente_core::types::ApprovalAction::Deny);
            }
            if let Some(action) = action {
                if let Some((request_id, _, _, _, _)) = pending.first() {
                    app.resolve_approval(request_id, action);
                }
            }
        });
    });
    ui.add_space(10.0);
}

fn changed_files(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    if app.code.run.files.is_empty() {
        return;
    }
    widgets::section_header(ui, tokens, "Changed files");
    let mut revert: Option<usize> = None;
    for (index, file) in app.code.run.files.iter().enumerate() {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(format!(
                    "{} · {} · +{} −{}",
                    file.path,
                    file.status.label(),
                    file.additions,
                    file.deletions
                ))
                .size(13.0)
                .color(tokens.secondary),
            );
            if ui.small_button("Diff").clicked() {
                app.code.run.entries.push(Entry::new(
                    crate::state::EntryKind::Notice,
                    file.diff.clone().unwrap_or_else(|| file.path.clone()),
                ));
            }
            if ui.small_button("Revert").clicked() {
                revert = Some(index);
            }
        });
    }
    if let Some(index) = revert {
        if let Some(path) = app.code.forget_file(index) {
            app.toast(format!("Reverted {path}"));
            app.dirty = true;
        }
    }
    if ui.small_button("Revert all").clicked() {
        let count = app.code.forget_all_files().len();
        app.toast(format!("Reverted {count} files"));
        app.dirty = true;
    }
    ui.separator();
}

fn subagents(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    if app.code.run.subagents.is_empty() {
        return;
    }
    widgets::section_header(ui, tokens, "Subagents");
    for card in &app.code.run.subagents {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(crate::icons::ICON_BOTS)
                    .size(13.0)
                    .color(if card.is_error {
                        tokens.error
                    } else if card.done {
                        tokens.success
                    } else {
                        tokens.focus
                    }),
            );
            ui.label(
                RichText::new(format!(
                    "{} · {} · {}",
                    card.subagent_type, card.description, card.model
                ))
                .size(13.0)
                .color(tokens.text),
            );
            if !card.summary.is_empty() {
                ui.label(RichText::new(&card.summary).size(12.0).color(tokens.muted));
            }
        });
    }
    ui.separator();
}

/// Doors for the workspace panes, like the Electron `PanelTabs` actions.
fn pane_doors(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let changes = app.dock_changes;
    let files = app.dock_files;
    ui.horizontal(|ui| {
        if widgets::chip(ui, tokens, "Changes", changes).clicked() {
            app.dock_changes = !changes;
            if app.dock_changes && app.project_files.is_empty() {
                app.refresh_project_files();
            }
        }
        if widgets::chip(ui, tokens, "Files", files).clicked() {
            app.dock_files = !files;
            if app.dock_files {
                app.refresh_project_files();
            }
        }
        if widgets::chip(ui, tokens, "Plan", app.overlays.plan_review.is_some()).clicked() {
            if app.overlays.plan_review.is_some() {
                app.overlays.plan_review = None;
            } else {
                app.open_plan_review();
            }
        }
        if widgets::chip(ui, tokens, "Processes", !app.processes.is_empty()).clicked() {
            if app.processes.is_empty() {
                app.refresh_processes();
            } else {
                app.processes.clear();
                app.overlays.process_view = None;
            }
        }
        if widgets::chip(ui, tokens, "Terminal", app.overlays.terminal.is_some()).clicked() {
            if app.overlays.terminal.is_some() {
                app.overlays.terminal = None;
            } else {
                let cwd = app.code.effective_dir();
                app.overlays.terminal = Some(crate::state::overlays::TerminalState::new(cwd));
            }
        }
        if widgets::chip(ui, tokens, "Prompt", app.overlays.prompt_inspector.is_some()).clicked() {
            if app.overlays.prompt_inspector.is_some() {
                app.overlays.prompt_inspector = None;
            } else {
                app.open_prompt_inspector();
            }
        }
    });
}

fn todos(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let done = app.code.run.todos.iter().filter(|todo| todo.done).count();
    widgets::section_header(
        ui,
        tokens,
        &format!("Todos · {done}/{}", app.code.run.todos.len()),
    );
    for todo in &app.code.run.todos {
        ui.label(
            RichText::new(format!(
                "{} {}",
                if todo.done {
                    crate::icons::ICON_CHECK
                } else {
                    "○"
                },
                todo.text
            ))
            .size(13.0)
            .color(if todo.done { tokens.muted } else { tokens.secondary }),
        );
    }
    ui.horizontal(|ui| {
        widgets::search_row(ui, &mut app.code.new_todo, "New todo…");
        if ui.small_button("Add").clicked() {
            app.code.add_todo();
        }
    });
}
