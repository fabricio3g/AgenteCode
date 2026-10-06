//! Workspace panels: changed files, the project tree, subagent detail, the
//! plan review card, processes and the embedded terminal. Ports the Electron
//! `WorkspaceHost` dock panels plus `PlanPanel`, `ProcessesView` and
//! `TerminalView`.

use egui::{RichText, ScrollArea, Ui};

use crate::app::{DesktopApp, commands};
use crate::state::overlays::subagent_mark;
use crate::widgets;

/// The right dock: changed files and the project tree.
pub fn dock(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    if !app.dock_changes && !app.dock_files {
        return;
    }
    ScrollArea::vertical()
        .auto_shrink([false; 2])
        .show(ui, |ui| {
            if app.dock_changes {
                changed_files(ui, app);
            }
            if app.dock_files {
                files(ui, app);
            }
        });
    let _ = tokens;
}

fn changed_files(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(target) = app.current_target() else {
        return;
    };
    let files: Vec<(String, String, String, Option<String>)> =
        app.with_target(&target, |session| {
            session
                .files
                .iter()
                .map(|file| {
                    (
                        file.path.clone(),
                        file.status.label().to_owned(),
                        format!("+{} −{}", file.additions, file.deletions),
                        file.diff.clone(),
                    )
                })
                .collect()
        });
    widgets::section_header(ui, tokens, &format!("Changed files · {}", files.len()));
    if files.is_empty() {
        widgets::empty_state(ui, tokens, "No file changes in this session yet.");
        return;
    }
    for (path, status, counts, diff) in files {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(&path)
                    .size(12.0)
                    .monospace()
                    .color(tokens.text),
            );
            ui.label(RichText::new(counts).size(11.0).color(tokens.muted));
        });
        ui.label(
            RichText::new(status)
                .size(11.0)
                .color(tokens.secondary),
        );
        if let Some(diff) = diff {
            ui.label(
                RichText::new(tail(&diff, 12))
                    .size(11.0)
                    .monospace()
                    .color(tokens.muted),
            );
        }
        ui.add_space(4.0);
    }
    if ui.small_button("Revert all").clicked() {
        app.overlays.confirm = Some(crate::state::overlays::ConfirmState {
            title: "Revert every changed file?".to_owned(),
            body: "The rows are cleared from this session; files on disk stay as they are."
                .to_owned(),
            confirm_label: "Revert all".to_owned(),
            danger: true,
            action: crate::state::overlays::ConfirmAction::RevertAll,
        });
    }
}

fn files(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    if app.project_files.is_empty() {
        app.refresh_project_files();
    }
    let count = app.project_files.len();
    widgets::section_header(ui, tokens, &format!("Project files · {count}"));
    let mut open: Option<String> = None;
    for path in &app.project_files {
        if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_FILE, path)).clicked() {
            open = Some(path.clone());
        }
    }
    if let Some(path) = open {
        let full = std::path::Path::new(&app.code.effective_dir()).join(&path);
        match std::fs::read_to_string(&full) {
            Ok(text) => {
                if let Some(target) = app.current_target() {
                    app.with_target(&target, |session| {
                        session.entries.push(crate::state::Entry::new(
                            crate::state::EntryKind::Notice,
                            format!("{path}\n{}", tail(&text, 40)),
                        ));
                    });
                }
            }
            Err(error) => app.toast(format!("Could not read {path}: {error}")),
        }
    }
}

/// Subagent detail: the card list plus the live transcript of one child.
pub fn subagents(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let cards: Vec<(String, String, String, String, String, bool, bool)> = app
        .active_run()
        .map(|session| {
            session
                .subagents
                .iter()
                .map(|card| {
                    (
                        card.id.clone(),
                        card.subagent_type.clone(),
                        card.description.clone(),
                        card.model.clone(),
                        card.live_text.clone(),
                        card.done,
                        card.is_error,
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if cards.is_empty() {
        widgets::empty_state(ui, tokens, "No subagents in this session.");
        return;
    }
    let selected = app.overlays.subagent_detail.unwrap_or(0).min(cards.len() - 1);
    for (index, (_, kind, description, model, _, done, is_error)) in cards.iter().enumerate() {
        let mark = if *is_error {
            "!"
        } else if *done {
            "✓"
        } else {
            "…"
        };
        let meta = if *done { "done" } else { "running" };
        let label = format!("{mark} {kind} · {description} · {model}");
        if widgets::row(
            ui,
            tokens,
            widgets::Row::new("", &label).current(index == selected).meta(meta),
        )
        .clicked()
        {
            app.overlays.subagent_detail = Some(index);
        }
    }
    ui.separator();
    if let Some((id, kind, _, model, text, done, is_error)) = cards.get(selected) {
        ui.label(
            RichText::new(format!("{kind} · {model}"))
                .size(13.0)
                .strong()
                .color(if *is_error { tokens.error } else { tokens.text }),
        );
        if !*done {
            ui.label(RichText::new("still running").size(12.0).color(tokens.muted));
        }
        ui.label(
            RichText::new(if text.is_empty() {
                "No text streamed yet."
            } else {
                text
            })
            .size(12.0)
            .monospace()
            .color(tokens.secondary),
        );
        let _ = id;
        let _ = subagent_mark;
    }
}

/// The plan review card: Accept / Redo / Comment over the plan's markdown.
pub fn plan_review(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(plan) = app.overlays.plan_review.as_ref() else {
        return;
    };
    let title = plan.title.clone();
    let path = plan.path.clone();
    let markdown = plan.markdown.clone();
    let mut comment = plan.comment.clone();
    let mut accept = false;
    let mut redo = false;
    let mut send = false;
    let mut close = false;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new(format!("Plan · {title}"))
                .size(14.0)
                .strong()
                .color(tokens.text),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked() {
                close = true;
            }
        });
    });
    ui.label(
        RichText::new(&path)
            .size(11.0)
            .monospace()
            .color(tokens.muted),
    );
    ui.add_space(6.0);
    ScrollArea::vertical()
        .max_height(320.0)
        .auto_shrink([false, true])
        .show(ui, |ui| {
            crate::views::markdown::show_markdown(ui, tokens, 1.0, &markdown, "plan");
        });
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        if ui.button("Accept").clicked() {
            accept = true;
        }
        if ui.button("Redo").clicked() {
            redo = true;
        }
    });
    ui.add(
        egui::TextEdit::multiline(&mut comment)
            .hint_text("Comment on the plan…")
            .desired_rows(2)
            .desired_width(f32::INFINITY),
    );
    if ui.button("Send comment").clicked() {
        send = true;
    }

    if let Some(plan) = app.overlays.plan_review.as_mut() {
        plan.comment = comment.clone();
    }
    if close {
        app.overlays.plan_review = None;
        return;
    }
    if accept {
        app.overlays.plan_review = None;
        app.send_plan_feedback("The plan is accepted — implement it now.");
        return;
    }
    if redo {
        app.overlays.plan_review = None;
        app.send_plan_feedback("Rewrite the plan from scratch, then call present_plan again.");
        return;
    }
    if send && !comment.trim().is_empty() {
        let feedback = format!(
            "User wants the plan revised:\n{}\n\nCall present_plan with the updated plan.",
            comment.trim()
        );
        app.send_plan_feedback(&feedback);
    }
}

/// Background processes: the list plus the live output view.
pub fn processes(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    ui.horizontal(|ui| {
        widgets::section_header(ui, tokens, "Processes");
        if ui.small_button("Refresh").clicked() {
            app.refresh_processes();
        }
    });
    if app.processes.is_empty() {
        widgets::empty_state(ui, tokens, "No background processes. `shell` with `&` starts one.");
        return;
    }
    let rows = app.processes.clone();
    let mut open: Option<String> = None;
    for row in &rows {
        let id = row.split_whitespace().next().unwrap_or("").to_owned();
        if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_PLAY, row)).clicked() {
            open = Some(id);
        }
    }
    if let Some(id) = open {
        app.open_process(&id);
    }
    let view: Option<(String, String)> = app
        .overlays
        .process_view
        .as_ref()
        .map(|view| (view.id.clone(), view.content.clone()));
    if let Some((id, content)) = view {
        ui.separator();
        let mut stop = false;
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(format!("{id} · live output"))
                    .size(13.0)
                    .strong()
                    .color(tokens.text),
            );
            if ui.small_button("Stop").clicked() {
                stop = true;
            }
        });
        ScrollArea::vertical()
            .max_height(260.0)
            .auto_shrink([false, true])
            .show(ui, |ui| {
                ui.label(
                    RichText::new(tail(&content, 40))
                        .size(11.0)
                        .monospace()
                        .color(tokens.secondary),
                );
            });
        if stop {
            app.stop_process(&id);
        }
    }
}

/// The embedded terminal: a line runner over the core `shell` tool.
pub fn terminal(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(terminal) = app.overlays.terminal.as_ref() else {
        return;
    };
    let cwd = terminal.cwd.clone();
    let lines = terminal.lines.clone();
    let mut input = terminal.input.clone();
    let running = terminal.running;

    ui.horizontal(|ui| {
        ui.label(
            RichText::new(crate::icons::ICON_TERMINAL)
                .size(14.0)
                .color(tokens.secondary),
        );
        ui.label(
            RichText::new(&cwd)
                .size(11.0)
                .monospace()
                .color(tokens.muted),
        );
        if running {
            ui.label(RichText::new("running…").size(11.0).color(tokens.warning));
        }
    });
    ScrollArea::vertical()
        .max_height(280.0)
        .auto_shrink([false, true])
        .stick_to_bottom(true)
        .show(ui, |ui| {
            for line in &lines {
                let (prefix, color) = if line.command {
                    ("$ ", tokens.text)
                } else if line.is_error {
                    ("! ", tokens.error)
                } else {
                    ("  ", tokens.secondary)
                };
                ui.label(
                    RichText::new(format!("{prefix}{}", line.text))
                        .size(11.0)
                        .monospace()
                        .color(color),
                );
            }
        });
    ui.horizontal(|ui| {
        let response = ui.add(
            egui::TextEdit::singleline(&mut input)
                .hint_text("command…")
                .desired_width(f32::INFINITY),
        );
        let submitted = response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
        if ui.button("Run").clicked() || submitted {
            if let Some(terminal) = app.overlays.terminal.as_mut() {
                terminal.input = input.clone();
            }
            app.run_terminal_command();
            if let Some(terminal) = app.overlays.terminal.as_mut() {
                terminal.input.clear();
            }
        }
    });
    if let Some(terminal) = app.overlays.terminal.as_mut() {
        terminal.input = input;
    }
    if ui.small_button("Clear").clicked() {
        if let Some(terminal) = app.overlays.terminal.as_mut() {
            terminal.lines.clear();
        }
    }
    let _ = commands::COMMANDS.len();
}

fn tail(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= count {
        return text.to_owned();
    }
    let skipped = lines.len() - count;
    format!("… {skipped} earlier lines\n{}", lines[skipped..].join("\n"))
}
