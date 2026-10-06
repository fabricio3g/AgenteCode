//! Home surface. Ports `HomeSurface` plus the thread/composer shell: mode tabs
//! above the input, thread filling the page, starter suggestions on empty.

use egui::{CentralPanel, Panel, RichText, Ui};

use crate::app::{DesktopApp, TurnTarget};
use crate::backend::{AgentMode, SessionSpace};
use crate::state::{ComposerMode, Entry, HomeView, RunState};
use crate::style::geom;
use crate::views::{artifacts, composer, thread};
use crate::widgets;

const SUGGESTIONS: &[&str] = &[
    "Explain a difficult concept simply",
    "Research a topic and cite sources",
    "Draft a design document",
];

/// Shows the home space.
pub fn show(ui: &mut Ui, app: &mut DesktopApp) {
    if app.home.view == HomeView::Artifacts {
        CentralPanel::default().show(ui, |ui| {
            widgets::centered_column(ui, geom::THREAD_W, |ui| {
                artifacts::show(ui, app);
            });
        });
        return;
    }

    let tokens = app.tokens();
    let scale = app.prefs.reading_scale;
    let space = SessionSpace::Home;
    app.chat.ensure_session(space);
    let has_messages = app
        .chat
        .active()
        .is_some_and(|session| !session.entries.is_empty());

    if has_messages {
        Panel::bottom("home-composer")
            .frame(egui::Frame {
                fill: tokens.bg,
                ..Default::default()
            })
            .show(ui, |ui| {
                widgets::centered_column(ui, geom::THREAD_W, |ui| {
                    composer_card(ui, app, space, "Message the agent…");
                });
            });
        CentralPanel::default().show(ui, |ui| {
            let entries = app
                .chat
                .active()
                .map(|session| session.entries.clone())
                .unwrap_or_default();
            let session_id = app.chat.active_id.clone().unwrap_or_default();
            let jump = app.scroll_to_bottom;
            let out = thread::show_thread(ui, tokens, scale, &entries, jump);
            apply_thread_out(app, &session_id, out);
        });
    } else {
        CentralPanel::default().show(ui, |ui| {
            let top = (ui.available_height() * 0.14).min(150.0);
            ui.add_space(top);
            widgets::centered_column(ui, geom::THREAD_W, |ui| {
                if !app.home.hero_dismissed {
                    ui.label(
                        RichText::new("Agente Code")
                            .size(20.0)
                            .color(tokens.text),
                    );
                    ui.label(
                        RichText::new(app.nav.active.description())
                            .size(13.0)
                            .color(tokens.muted),
                    );
                    ui.add_space(10.0);
                }
                mode_tabs(ui, app);
                status_row(ui, app);
                composer_card(ui, app, space, "Message the agent…");
                ui.add_space(16.0);
                for suggestion in SUGGESTIONS {
                    if widgets::row(ui, tokens, widgets::Row::new(crate::icons::ICON_PLUS, suggestion).current(false)).clicked()
                    {
                        app.chat.draft = (*suggestion).to_owned();
                        app.home.dismiss_hero();
                    }
                }
            });
        });
    }
}

/// Mode tabs above the input on Home: Instant answers, or the agent loop.
fn mode_tabs(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let current = match app.home.composer_mode {
        ComposerMode::Instant => 0,
        ComposerMode::Agent => 1,
    };
    if widgets::segmented(ui, tokens, &["Instant", "Agent"], current).is_some() {
        app.home.toggle_composer_mode();
    }
    ui.add_space(6.0);
}

/// The status row under the composer: mode │ spend · cache │ context.
fn status_row(ui: &mut Ui, app: &mut DesktopApp) {
    let tokens = app.tokens();
    let Some(session) = app.active_run() else {
        return;
    };
    let mode = app.mode_label();
    let spend = session.spend_label();
    let cache = session
        .cache_label()
        .map(|cache| format!(" · {cache}"))
        .unwrap_or_default();
    let context = if session.context_tokens > 0 {
        format!(" · {} ctx", session.context_tokens)
    } else {
        String::new()
    };
    ui.horizontal(|ui| {
        ui.label(
            RichText::new(format!("{mode} · {spend}{cache}{context}"))
                .size(12.0)
                .color(tokens.muted),
        );
        if session.context_tokens > 0 {
            // A meter, like the Electron context ring: filled share of 200k.
            let share = (session.context_tokens as f32 / 200_000.0).clamp(0.0, 1.0);
            let (rect, _) = ui.allocate_exact_size(egui::vec2(70.0, 6.0), egui::Sense::hover());
            ui.painter()
                .rect_filled(rect, egui::CornerRadius::from(3u8), tokens.hover_fill);
            let mut filled = rect;
            filled.set_width(rect.width() * share);
            ui.painter().rect_filled(
                filled,
                egui::CornerRadius::from(3u8),
                if share > 0.85 { tokens.warning } else { tokens.focus },
            );
        }
    });
    if !app.toasts.is_empty() {
        widgets::toast_bar(ui, tokens, &mut app.toasts);
    }
}

/// One composer card, wired to the live turn state.
fn composer_card(
    ui: &mut Ui,
    app: &mut DesktopApp,
    space: SessionSpace,
    placeholder: &str,
) {
    let tokens = app.tokens();
    let (provider, model) = app.active_model();
    let model_label = if model.is_empty() {
        "Pick a model".to_owned()
    } else {
        format!("{provider} / {model}")
    };
    let thinking = app.prefs.thinking_level.clone();
    let mode = AgentMode::Plan;
    let mode_label = app.code.mode.label();
    let mut draft = std::mem::take(&mut app.chat.draft);
    let queue = app.chat.queue.clone();
    let attachments = app.chat.attachments.clone();
    let completion = app
        .chat
        .completion
        .clone()
        .map(|mut completion| {
            if completion.kind == crate::state::CompletionKind::Mention {
                if app.project_files.is_empty() {
                    app.refresh_project_files();
                }
                completion =
                    crate::state::Completion::mention(&completion.query, &app.project_files);
            }
            completion
        });
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
            placeholder,
            &model_label,
            &thinking,
            &queue,
            &attachments,
            completion.as_ref(),
            app.overlays.voice.listening,
            mode_label,
        )
    };
    app.chat.draft = draft;
    app.chat.completion = out.completion.clone();
    if let Some(index) = out.drop_queued {
        if index < app.chat.queue.len() {
            app.chat.queue.remove(index);
        }
    }
    if out.send_queue_now {
        let queued = std::mem::take(&mut app.chat.queue);
        for item in queued {
            if app.engine.steer(&item, None) {
                if let Some(session) = app.chat.active_mut() {
                    session.entries.push(Entry::user(&item));
                }
            } else {
                app.chat.queue.push(item);
            }
        }
    }
    if let Some(next) = out.mode {
        app.code.mode = match next.as_str() {
            "Build" => crate::backend::AgentMode::Build,
            "Auto" => crate::backend::AgentMode::Build,
            _ => crate::backend::AgentMode::Plan,
        };
        app.engine.set_mode(app.code.mode);
        if next == "Auto" {
            app.code.auto_approve = true;
            app.engine.set_auto_approve(true);
        }
        app.dirty = true;
    }
    if out.toggle_voice {
        app.overlays.voice.listening = !app.overlays.voice.listening;
        if app.overlays.voice.listening {
            app.toast("Dictation needs the STT engine; the mic state is live for now.");
        }
    }
    if let Some(index) = out.remove_attachment {
        if index < app.chat.attachments.len() {
            app.chat.attachments.remove(index);
        }
    }
    if let Some(pick) = out.completion_pick.clone() {
        let mut draft = app.chat.draft.clone();
        apply_completion(app, &mut draft, &pick);
        app.chat.draft = draft;
        app.chat.completion = None;
    }
    let open_settings = out.open_settings;
    let note = out.note;
    let thinking_next = out.thinking;
    let send = out.sent;
    let stop = out.stopped;
    let slash = out.slash;
    if open_settings {
        app.nav.settings_open = true;
    }
    if let Some(note) = note {
        app.toast(note);
    }
    if let Some(level) = thinking_next {
        app.prefs.thinking_level = level.clone();
        app.engine.update_thinking(&level);
    }
    if stop {
        app.stop_turn();
    }
    if let Some(line) = slash {
        if let Some((id, arg)) = crate::app::commands::parse_slash(&line) {
            crate::app::commands::run(app, id, arg);
        }
        return;
    }
    if send {
        attach_pasted_paths(app);
        let live = app
            .chat
            .active()
            .is_some_and(|session| session.state != RunState::Idle);
        if live {
            send_live_queue(ui, app);
        } else {
            app.send_draft(space, mode);
        }
    }
}

/// Enter on a live turn hands the draft to the running agent; if the turn
/// already finished, it is queued for the next one.
fn send_live_queue(_ui: &mut Ui, app: &mut DesktopApp) {
    let text = std::mem::take(&mut app.chat.draft);
    let prompt = text.trim().to_owned();
    if prompt.is_empty() {
        return;
    }
    if app.engine.steer(&prompt, None) {
        if let Some(session) = app.chat.active_mut() {
            session.entries.push(Entry::user(&prompt));
        }
    } else {
        app.chat.queue.push(prompt);
    }
}

/// A pasted or typed media path in the draft becomes an attachment chip.
pub fn attach_pasted_paths(app: &mut DesktopApp) {
    let draft = app.chat.draft.clone();
    let trimmed = draft.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return;
    }
    let candidate = trimmed
        .trim_matches('"')
        .trim_start_matches("file://")
        .replace("\\ ", " ");
    let path = std::path::Path::new(&candidate);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::path::Path::new(&app.code.effective_dir()).join(path)
    };
    if agente_core::media::kind_for_path(&resolved).is_none() {
        return;
    }
    match agente_core::media::attach_file(&resolved) {
        Ok(Some(attachment)) => {
            let name = attachment.name.clone();
            app.chat.attachments.push(attachment);
            app.chat.draft.clear();
            app.toast_ok(format!("Attached {name}"));
        }
        Ok(None) => {}
        Err(error) => app.toast_err(format!("Could not attach: {error}")),
    }
}

/// Applies a picked completion row to the draft.
pub fn apply_completion(app: &mut DesktopApp, draft: &mut String, pick: &str) {
    match pick.split_whitespace().next() {
        Some(command) if command.starts_with('/') => {
            *draft = format!("{command} ");
        }
        _ => {
            // A mention replaces the trailing `@word`.
            if let Some(start) = draft.rfind('@') {
                draft.truncate(start);
            }
            draft.push('@');
            draft.push_str(pick);
            draft.push(' ');
            // Attach media paths straight away, like the Electron drop.
            let path = std::path::Path::new(&app.code.effective_dir()).join(pick);
            if agente_core::media::kind_for_path(&path).is_some() {
                match agente_core::media::attach_file(&path) {
                    Ok(Some(attachment)) => {
                        app.chat.attachments.push(attachment);
                        app.toast("Attached");
                    }
                    Ok(None) => {}
                    Err(error) => app.toast_err(format!("Could not attach: {error}")),
                }
            }
        }
    }
}

/// Routes the thread's hover actions: copy, delete, retry.
pub fn apply_thread_out(app: &mut DesktopApp, session_id: &str, out: thread::ThreadOut) {
    if let Some(text) = out.copy_text {
        if let Some(clipboard) = app.clipboard.as_mut() {
            let _ = clipboard.set_text(text);
        }
        app.toast("Copied");
    }
    if let Some(index) = out.edit_index {
        if let Some(entry) = app.chat.active().and_then(|session| session.entries.get(index)) {
            app.overlays.edit_message = Some(crate::state::overlays::EditMessageState {
                session_id: session_id.to_owned(),
                index,
                text: entry.text.clone(),
            });
        }
    }
    if out.fork_index.is_some() {
        app.fork_active_session();
    }
    if out.speak_index.is_some() {
        app.overlays.voice.speaking = !app.overlays.voice.speaking;
        app.toast("Playback uses the system voice; the TTS engine is next.");
    }
    if out.inspect {
        app.open_prompt_inspector();
    }
    if let Some(index) = out.delete_index {
        if app.chat.delete_entry(session_id, index) {
            app.dirty = true;
        }
        if out.retry {
            app.order_turn(TurnTarget::Session(session_id.to_owned()), AgentMode::Build);
        }
    }
}
