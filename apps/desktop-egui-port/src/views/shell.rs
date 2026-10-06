//! App shell. Ports `AppShell.svelte`: the always-on activity rail, the
//! collapsible sidebar, the 36px titlebar, the PanelTabs strip, the right
//! dock, and the Settings screen over the workspace.

use egui::{CentralPanel, Frame, Panel, RichText, Ui};

use crate::app::DesktopApp;
use crate::state::Space;
use crate::style::{Theme, ThemeTokens, geom};
use crate::widgets;

use super::{
    bots, browser, canvas, code, dialogs, downloads, editors, home, onboarding, panels, roleplay,
    search, settings, sidebar,
};

fn plain_frame(fill: egui::Color32) -> Frame {
    Frame {
        fill,
        ..Default::default()
    }
}

/// Paints the whole window on the root Ui.
pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let settings_open = app.nav.settings_open;

    Panel::left("rail")
        .exact_size(geom::RAIL_W)
        .frame(plain_frame(tokens.rail))
        .show_separator_line(true)
        .resizable(false)
        .show(ui, |ui| {
            ui.add_space(12.0);
            ui.spacing_mut().item_spacing.y = 4.0;
            ui.vertical_centered(|ui| {
                for space in Space::ALL {
                    let active = !settings_open && app.nav.active == *space;
                    if widgets::rail_button(ui, tokens, active, space.icon()).clicked() {
                        app.nav.activate(*space);
                        app.dirty = true;
                    }
                }
            });
            ui.with_layout(egui::Layout::bottom_up(egui::Align::Center), |ui| {
                ui.add_space(12.0);
                if widgets::rail_button(ui, tokens, settings_open, crate::icons::ICON_SETTINGS)
                    .clicked()
                {
                    app.nav.toggle_settings();
                    app.dirty = true;
                }
            });
        });

    if settings_open {
        Panel::left("settings-rail")
            .exact_size(220.0)
            .frame(plain_frame(tokens.sidebar))
            .show_separator_line(true)
            .resizable(false)
            .show(ui, |ui| {
                settings::rail(ui, app);
            });
    }

    if app.nav.sidebar_open && !settings_open {
        Panel::left("sidebar")
            .exact_size(geom::SIDEBAR_W)
            .frame(plain_frame(tokens.sidebar))
            .show_separator_line(true)
            .resizable(false)
            .show(ui, |ui| {
                ui.add_space(4.0);
                sidebar::show_sidebar(ui, app);
            });
    }

    let docked = app.search.open
        || app.browser.open
        || app.canvas.open
        || app.dock_changes
        || app.dock_files;
    if docked && !settings_open {
        Panel::right("dock")
            .default_size(340.0)
            .frame(plain_frame(tokens.card))
            .show_separator_line(true)
            .show(ui, |ui| {
                if app.search.open {
                    dock_header(ui, app, "Search", DockPanel::Search);
                    search::show(ui, app);
                    ui.separator();
                }
                if app.browser.open {
                    dock_header(ui, app, "Browser", DockPanel::Browser);
                    browser::show(ui, app);
                    ui.separator();
                }
                if app.canvas.open {
                    dock_header(ui, app, "Canvas", DockPanel::Canvas);
                    canvas::show(ui, app);
                    ui.separator();
                }
                if app.dock_changes || app.dock_files {
                    panels::dock(ui, app);
                }
            });
    }

    Panel::top("titlebar")
        .exact_size(geom::TITLEBAR_H)
        .frame(plain_frame(tokens.bg))
        .show(ui, |ui| {
            let prefs_dark = app.prefs.theme_dark;
            let code_space = app.nav.active == Space::Code;
            let git_branch = if code_space {
                app.git_branch()
            } else {
                String::new()
            };
            let counts = if code_space { app.change_counts() } else { None };
            let (provider, model) = app.active_model();
            let model_label = format!(
                "{provider}/{}",
                if model.is_empty() { "—" } else { model.as_str() }
            );
            let (left, right) = egui::containers::Sides::new()
                .height(geom::TITLEBAR_H - 2.0)
                .show(
                    ui,
                    |ui| {
                        ui.horizontal(|ui| {
                            if settings_open {
                                let back = widgets::icon_button(
                                    ui,
                                    tokens,
                                    crate::icons::ICON_BACK,
                                    26.0,
                                )
                                .clicked();
                                ui.label(
                                    RichText::new("Settings")
                                        .size(13.0)
                                        .strong()
                                        .color(tokens.text),
                                );
                                return back.then_some(ShellAction::CloseSettings);
                            }
                            let toggle = widgets::icon_button(
                                ui,
                                tokens,
                                crate::icons::ICON_SIDEBAR,
                                26.0,
                            )
                            .clicked();
                            ui.label(
                                RichText::new(model_label).size(12.0).color(tokens.muted),
                            );
                            toggle.then_some(ShellAction::ToggleSidebar)
                        })
                        .inner
                    },
                    |ui| {
                        ui.horizontal(|ui| {
                            if code_space {
                                let branch = git_branch.clone();
                                ui.label(
                                    RichText::new(format!(
                                        "{} {}",
                                        crate::icons::ICON_BRANCH,
                                        branch
                                    ))
                                    .size(12.0)
                                    .color(tokens.secondary),
                                );
                                if let Some((additions, deletions)) = counts {
                                    ui.label(
                                        RichText::new(format!("+{additions}"))
                                            .size(12.0)
                                            .color(tokens.success),
                                    );
                                    ui.label(
                                        RichText::new(format!("−{deletions}"))
                                            .size(12.0)
                                            .color(tokens.error),
                                    );
                                }
                            }
                            let theme_icon = if prefs_dark {
                                crate::icons::ICON_SUN
                            } else {
                                crate::icons::ICON_MOON
                            };
                            if widgets::icon_button(ui, tokens, theme_icon, 26.0).clicked() {
                                return Some(ShellAction::ToggleTheme);
                            }
                            if widgets::ghost_chip(ui, tokens, "Downloads").clicked() {
                                return Some(ShellAction::ToggleDownloads);
                            }
                            if widgets::icon_button(ui, tokens, crate::icons::ICON_HELP, 26.0)
                                .clicked()
                            {
                                return Some(ShellAction::Onboarding);
                            }
                            None
                        })
                        .inner
                    },
                );
            if let Some(action) = left.or(right) {
                apply_action(app, action, ui.ctx());
            }
        });

    if !settings_open {
        Panel::top("strip")
            .exact_size(30.0)
            .frame(plain_frame(tokens.bg))
            .show_separator_line(true)
            .show(ui, |ui| {
                strip(ui, app, tokens);
            });
    }

    if settings_open {
        CentralPanel::default().show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.add_space(88.0);
                ui.vertical(|ui| {
                    ui.set_width(780.0);
                    settings::content(ui, app);
                });
            });
        });
    } else {
        match app.nav.active {
            Space::Home => home::show(ui, app),
            Space::Code => code::show(ui, app),
            Space::Roleplay => roleplay::show(ui, app),
            Space::Bots => {
                CentralPanel::default().show(ui, |ui| {
                    widgets::centered_column(ui, geom::THREAD_W, |ui| bots::show(ui, app));
                });
            }
        }
        workspace_windows(ui, app);
    }
    dialogs::show(ui, app);
    editors::show(ui, app);

    if app.downloads.open {
        let ctx = ui.ctx().clone();
        egui::Window::new("Downloads")
            .collapsible(false)
            .resizable(false)
            .show(&ctx, |ui| {
                downloads::show(ui, app);
                if ui.small_button("Close").clicked() {
                    app.downloads.toggle();
                }
            });
    }

    if app.nav.onboarding_open && !app.onboarding.done {
        let ctx = ui.ctx().clone();
        egui::Window::new("Welcome to Agente Code")
            .collapsible(false)
            .resizable(false)
            .show(&ctx, |ui| {
                if onboarding::show(ui, app) {
                    app.nav.close_onboarding();
                    app.dirty = true;
                }
            });
    }
}

#[derive(Clone, Copy)]
enum DockPanel {
    Search,
    Browser,
    Canvas,
}


fn dock_header(ui: &mut Ui, app: &mut DesktopApp, title: &str, panel: DockPanel) {
    let tokens = app.tokens();
    let mut close = false;
    egui::containers::Sides::new().height(28.0).show(
        ui,
        |ui| {
            widgets::section_header(ui, tokens, title);
        },
        |ui| {
            close = widgets::icon_button(ui, tokens, crate::icons::ICON_CLOSE, 24.0).clicked();
        },
    );
    if close {
        match panel {
            DockPanel::Search => app.search.open = false,
            DockPanel::Browser => app.browser.open = false,
            DockPanel::Canvas => app.canvas.open = false,
        }
    }
}


/// Actions a chrome row can request. The closures only read state; the action
/// is applied after the row is painted, which keeps borrows simple and the
/// paint idempotent.
#[derive(Clone, Copy)]
enum ShellAction {
    ToggleTheme,
    ToggleDownloads,
    Onboarding,
    CloseSettings,
    ToggleSidebar,
    ToggleDock(DockPanel),
    ToggleMode,
    ToggleAutoApprove,
}

fn apply_action(app: &mut DesktopApp, action: ShellAction, ctx: &egui::Context) {
    match action {
        ShellAction::ToggleTheme => {
            app.prefs.theme_dark = !app.prefs.theme_dark;
            app.apply_theme(ctx);
        }
        ShellAction::ToggleDownloads => app.downloads.toggle(),
        ShellAction::Onboarding => app.nav.open_onboarding(),
        ShellAction::CloseSettings => app.nav.close_settings(),
        ShellAction::ToggleSidebar => app.nav.toggle_sidebar(),
        ShellAction::ToggleDock(panel) => match panel {
            DockPanel::Search => app.search.toggle(),
            DockPanel::Browser => app.browser.toggle(),
            DockPanel::Canvas => app.canvas.toggle(),
        },
        ShellAction::ToggleMode => {
            app.code.toggle_mode();
            app.engine.set_mode(app.code.mode);
        }
        ShellAction::ToggleAutoApprove => {
            app.code.toggle_auto_approve();
            app.engine.set_auto_approve(app.code.auto_approve);
        }
    }
    app.dirty = true;
}

/// PanelTabs strip: the space's own controls plus the dock doors on the right.
fn strip(ui: &mut Ui, app: &mut DesktopApp, tokens: ThemeTokens) {
    let mode = app.code.mode == crate::backend::AgentMode::Plan;
    let auto_approve = app.code.auto_approve;
    let run_line = app
        .active_run()
        .map(|session| format!("{} · {}", session.state.label(), session.spend_label()))
        .unwrap_or_default();
    let description = app.nav.active.description();
    let space = app.nav.active;
    let project = app
        .code
        .projects
        .get(app.code.active_project.unwrap_or(usize::MAX))
        .map(|project| project.title.clone())
        .unwrap_or_else(|| app.code.effective_dir());
    let docks = [app.search.open, app.browser.open, app.canvas.open];

    let (left, right) = egui::containers::Sides::new()
        .height(geom::STRIP_H - 2.0)
        .show(
            ui,
            |ui| {
                ui.horizontal(|ui| match space {
                    Space::Code => {
                        ui.label(RichText::new(project).size(12.0).color(tokens.secondary));
                        let mut action = None;
                        let plan = if mode { 0 } else { 1 };
                        if widgets::segmented(ui, tokens, &["Plan", "Build"], plan).is_some() {
                            action = Some(ShellAction::ToggleMode);
                        }
                        let mut approve = auto_approve;
                        ui.checkbox(&mut approve, "Auto");
                        if approve != auto_approve {
                            action = Some(ShellAction::ToggleAutoApprove);
                        }
                        if !run_line.is_empty() {
                            ui.label(RichText::new(run_line).size(12.0).color(tokens.muted));
                        }
                        action
                    }
                    Space::Home => {
                        if let Some(session) = app.active_run() {
                            let cache = session
                                .cache_label()
                                .map(|cache| format!(" · {cache}"))
                                .unwrap_or_default();
                            ui.label(
                                RichText::new(format!(
                                    "{} · {}{cache}",
                                    session.state.label(),
                                    session.spend_label()
                                ))
                                .size(12.0)
                                .color(tokens.muted),
                            );
                        }
                        None
                    }
                    Space::Roleplay | Space::Bots => {
                        ui.label(RichText::new(description).size(12.0).color(tokens.muted));
                        None
                    }
                })
                .inner
            },
            |ui| {
                ui.horizontal(|ui| {
                    for (index, (label, open)) in
                        ["Search", "Browser", "Canvas"].iter().zip(docks).enumerate()
                    {
                        let mark = if open { "●" } else { "○" };
                        if widgets::chip(ui, tokens, &format!("{mark} {label}"), open).clicked() {
                            return Some(ShellAction::ToggleDock(match index {
                                0 => DockPanel::Search,
                                1 => DockPanel::Browser,
                                _ => DockPanel::Canvas,
                            }));
                        }
                    }
                    None
                })
                .inner
            },
        );
    if let Some(action) = left.or(right) {
        apply_action(app, action, ui.ctx());
    }
}

/// The theme tokens the app is painting with.
impl DesktopApp {
    pub fn tokens(&self) -> ThemeTokens {
        let theme = if self.prefs.theme_dark {
            Theme::Dark
        } else {
            Theme::Light
        };
        ThemeTokens::of(theme)
    }
}

/// The workspace windows: plan review, processes, the terminal and subagent
/// detail. They float over the space, like the Electron dock panels.
fn workspace_windows(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let ctx = ui.ctx().clone();

    if app.overlays.plan_review.is_some() {
        egui::Window::new("Plan review")
            .collapsible(false)
            .resizable(true)
            .default_width(620.0)
            .show(&ctx, |ui| panels::plan_review(ui, app));
    }
    if !app.processes.is_empty() || app.overlays.process_view.is_some() {
        egui::Window::new("Processes")
            .collapsible(false)
            .resizable(true)
            .default_width(560.0)
            .show(&ctx, |ui| panels::processes(ui, app));
    }
    if app.overlays.terminal.is_some() {
        egui::Window::new("Terminal")
            .collapsible(false)
            .resizable(true)
            .default_width(620.0)
            .show(&ctx, |ui| panels::terminal(ui, app));
    }
    if app.overlays.subagent_detail.is_some() {
        egui::Window::new("Subagents")
            .collapsible(false)
            .resizable(true)
            .default_width(520.0)
            .show(&ctx, |ui| panels::subagents(ui, app));
    }
    let _ = tokens;
}
