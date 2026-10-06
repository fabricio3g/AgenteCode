//! Sidebar. Ports `Sidebar.svelte`: the New row, the artifacts toggle, the
//! search row, the per-space list (date-grouped sessions, projects, roster)
//! and the running-model footer.

use egui::{RichText, Ui};

use crate::app::DesktopApp;
use crate::backend::SessionSpace;
use crate::state::{HomeView, Space};
use crate::widgets;

/// Shows the sidebar for the active space.
pub fn show_sidebar(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let active = app.nav.active;
    ui.add_space(8.0);

    let new_label = match active {
        Space::Home => "New chat",
        Space::Code => "Add project",
        Space::Roleplay => "New roleplay",
        Space::Bots => "New bot",
    };
    if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_PLUS, new_label).current(false)).clicked() {
        match active {
            Space::Home => {
                app.chat.new_session(SessionSpace::Home);
            }
            Space::Roleplay => {
                app.chat.new_session(SessionSpace::Roleplay);
            }
            Space::Code => {
                app.code.add_project();
                app.code.run = crate::state::Session::new(SessionSpace::Code);
            }
            Space::Bots => {
                app.bots.new_name = "New bot".to_owned();
                app.bots.add();
            }
        }
        app.dirty = true;
    }

    if matches!(active, Space::Home | Space::Roleplay) {
        let current = app.home.view == HomeView::Artifacts;
        if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_ARTIFACT, "Artifacts").current(current)).clicked() {
            if current {
                app.home.show_chat();
            } else {
                app.home.show_artifacts();
            }
            app.dirty = true;
        }
    }

    if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_SEARCH, "Search chats").current(false)).clicked() {
        app.search.open = true;
    }
    ui.add_space(4.0);

    match active {
        Space::Home => session_list(ui, app, SessionSpace::Home),
        Space::Roleplay => session_list(ui, app, SessionSpace::Roleplay),
        Space::Code => projects(ui, app),
        Space::Bots => bots(ui, app),
    }

    ui.with_layout(egui::Layout::bottom_up(egui::Align::LEFT), |ui| {
        widgets::section_header(ui, tokens, "Engine");
        let providers = app.engine.configured_providers();
        let label = if providers.is_empty() {
            "No provider key yet".to_owned()
        } else {
            format!("{} ready · {}", providers.len(), providers.join(", "))
        };
        ui.label(RichText::new(label).size(12.0).color(tokens.muted));
        let (provider, model) = app.active_model();
        ui.label(
            RichText::new(format!(
                "{provider}/{}",
                if model.is_empty() { "—" } else { model.as_str() }
            ))
            .size(12.0)
            .color(tokens.muted),
        );
    });
}

/// Date-grouped session list shared by home and roleplay.
fn session_list(ui: &mut Ui, app: &mut DesktopApp, space: SessionSpace) {
    let tokens = app.tokens();
    let groups = app.chat.grouped(space);
    if groups.is_empty() {
        widgets::empty_state(
            ui,
            tokens,
            if space == SessionSpace::Roleplay {
                "No roleplays yet."
            } else {
                "No conversations yet."
            },
        );
        return;
    }
    let mut select: Option<String> = None;
    let mut rename: Option<String> = None;
    let mut fork: Option<String> = None;
    let mut delete: Option<String> = None;
    for group in &groups {
        widgets::section_header(ui, tokens, &group.label);
        for id in &group.ids {
            let current = app.chat.active_id.as_deref() == Some(id.as_str());
            let working = app
                .chat
                .sessions
                .iter()
                .find(|session| &session.id == id)
                .is_some_and(|session| session.state.working());
            let title = app.chat.title_of(id);
            let label = if working {
                format!("{title} · working")
            } else {
                title.clone()
            };
            let response = widgets::row(
                ui,
                tokens,
                widgets::Row::new("", &label).current(current).meta("⋯"),
            );
            if response.clicked() {
                select = Some(id.clone());
            }
            response.context_menu(|ui| {
                if ui.button("Open").clicked() {
                    select = Some(id.clone());
                    ui.close();
                }
                if ui.button("Rename").clicked() {
                    rename = Some(id.clone());
                    ui.close();
                }
                if ui.button("Fork").clicked() {
                    fork = Some(id.clone());
                    ui.close();
                }
                if ui.button("Delete").clicked() {
                    delete = Some(id.clone());
                    ui.close();
                }
            });
            if app.renaming.as_ref().is_some_and(|(rid, _)| rid == id) {
                let mut draft = app
                    .renaming
                    .as_ref()
                    .map(|(_, draft)| draft.clone())
                    .unwrap_or_default();
                let response = ui.add(
                    egui::TextEdit::singleline(&mut draft)
                        .hint_text("Title")
                        .desired_width(f32::INFINITY),
                );
                if response.changed() {
                    app.renaming = Some((id.clone(), draft.clone()));
                }
                let commit = response.lost_focus()
                    && ui.input(|input| input.key_pressed(egui::Key::Enter));
                if commit {
                    app.renaming = Some((id.clone(), draft));
                    app.commit_rename();
                }
            }
        }
    }
    if let Some(id) = select {
        app.chat.select(&id);
        app.dirty = true;
    }
    if let Some(id) = rename {
        app.chat.select(&id);
        app.start_rename();
    }
    if let Some(id) = fork {
        app.chat.select(&id);
        app.fork_active_session();
    }
    if let Some(id) = delete {
        let title = app.chat.title_of(&id);
        app.overlays.confirm = Some(crate::state::overlays::ConfirmState::delete_session(
            &title, &id,
        ));
    }
}

/// The Code sidebar is a tree: each project folder holds its conversations,
/// like the Electron `CodeSidebar`.
fn projects(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    widgets::section_header(ui, tokens, "Projects");
    if app.code.projects.is_empty() {
        widgets::empty_state(ui, tokens, "No projects yet. Add one above.");
    }
    let mut select: Option<usize> = None;
    let mut open_conversation: Option<String> = None;
    let mut new_conversation = false;
    for (index, project) in app.code.projects.iter().enumerate() {
        let active = app.code.active_project == Some(index);
        if widgets::row(
            ui,
            tokens,
            widgets::Row::new(crate::icons::ICON_FOLDER, &project.title)
                .current(active)
                .meta("⋯"),
        )
        .clicked()
        {
            select = Some(index);
        }
        if !active {
            continue;
        }
        // Conversations of this project: the code workspace keeps one session
        // today, so the tree shows it plus the new-conversation row.
        let session = &app.code.run;
        if !session.entries.is_empty() {
            let label = if session.title.is_empty() {
                "Untitled".to_owned()
            } else {
                session.title.clone()
            };
            ui.horizontal(|ui| {
                ui.add_space(14.0);
                if widgets::row(
                    ui,
                    tokens,
                    widgets::Row::new(crate::icons::ICON_CHAT, &label)
                        .current(true)
                        .meta(if session.state.working() { "working" } else { "" }),
                )
                .clicked()
                {
                    open_conversation = Some(session.id.clone());
                }
            });
        }
        ui.horizontal(|ui| {
            ui.add_space(14.0);
            if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_PLUS, "New conversation"))
                .clicked()
            {
                new_conversation = true;
            }
        });
    }
    if let Some(index) = select {
        app.code.select_project(index);
        if let Some(project) = app.code.projects.get(index) {
            app.code.project_dir = project.root.clone();
        }
        app.dirty = true;
    }
    if new_conversation {
        app.code.run = crate::state::Session::new(SessionSpace::Code);
        app.dirty = true;
    }
    let _ = open_conversation;
    ui.add_space(6.0);
    widgets::section_header(ui, tokens, "Project folder");
    if widgets::search_row(ui, &mut app.code.project_dir, "/path/to/project…") {
        app.dirty = true;
    }
}

fn bots(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    widgets::search_row(ui, &mut app.bots.query, "Filter bots…");
    let visible = app.bots.visible();
    if visible.is_empty() {
        widgets::empty_state(ui, tokens, "No bots yet.");
    }
    let mut select: Option<usize> = None;
    for (index, bot) in &visible {
        let label = format!("{} · {}", bot.name, bot.status);
        if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_BOTS, &label).current(app.bots.selected == Some(*index))).clicked() {
            select = Some(*index);
        }
    }
    if let Some(index) = select {
        app.bots.select(index);
        app.dirty = true;
    }
}
