//! Composer card. Ports `Composer.svelte`: the pill card with its ring, two
//! rows (message full width, controls beneath), add menu, model slot,
//! thinking selector, mic and the round send/stop button.

use egui::{RichText, Ui};

use crate::state::{Completion, CompletionKind, RunState, Session};
use crate::style::{ThemeTokens, geom};
use crate::widgets;

const THINKING_LEVELS: &[&str] = &["auto", "low", "medium", "high", "max"];

/// The `@word` being typed at the end of the draft, if any.
fn trailing_mention(draft: &str) -> Option<String> {
    let start = draft.rfind('@')?;
    let tail = &draft[start + 1..];
    if tail.contains(char::is_whitespace) {
        return None;
    }
    Some(tail.to_owned())
}

/// What the composer card produced this frame.
#[derive(Debug, Default)]
pub struct ComposerOut {
    pub sent: bool,
    pub stopped: bool,
    pub open_settings: bool,
    pub note: Option<String>,
    pub thinking: Option<String>,
    /// A slash line typed into the composer, resolved by the caller.
    pub slash: Option<String>,
    /// Queue rows the user asked to drop or send now.
    pub drop_queued: Option<usize>,
    pub send_queue_now: bool,
    pub remove_attachment: Option<usize>,
    /// The completion the draft asks for, if any.
    pub completion: Option<Completion>,
    /// A completion row the user picked.
    pub completion_pick: Option<String>,
    /// The mic was pressed: the caller flips the voice state.
    pub toggle_voice: bool,
    /// The mode chip was pressed; the value is the next mode.
    pub mode: Option<String>,
}

/// Shows the composer card. While a turn runs the round button stops it.
#[allow(clippy::too_many_arguments)]
pub fn show_composer(
    ui: &mut Ui,
    tokens: ThemeTokens,
    session: &mut Session,
    draft: &mut String,
    placeholder: &str,
    model_label: &str,
    thinking: &str,
    queue: &[String],
    attachments: &[agente_protocol::Attachment],
    completion: Option<&Completion>,
    voice_listening: bool,
    mode_label: &str,
) -> ComposerOut {
    let mut out = ComposerOut::default();
    let streaming = session.state != RunState::Idle;

    // Queued messages: preview rows above the card, like the TUI's queue.
    if !queue.is_empty() {
        for (index, item) in queue.iter().enumerate() {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(crate::icons::ICON_CLIPBOARD)
                        .size(12.0)
                        .color(tokens.muted),
                );
                ui.label(RichText::new(item).size(12.0).color(tokens.secondary));
                if ui.small_button("drop").clicked() {
                    out.drop_queued = Some(index);
                }
            });
        }
        if ui
            .small_button("Send the queue now")
            .on_hover_text("The running turn takes it at its next step")
            .clicked()
        {
            out.send_queue_now = true;
        }
        ui.add_space(4.0);
    }

    // Completions float above the input.
    if let Some(completion) = completion {
        if !completion.items.is_empty() {
            widgets::card_frame(tokens, 10.0, egui::Margin::symmetric(10, 6)).show(ui, |ui| {
                for (index, item) in completion.items.iter().enumerate() {
                    let selected = index == completion.index;
                    let label = match completion.kind {
                        CompletionKind::Slash => item.as_str(),
                        CompletionKind::Mention => item.as_str(),
                    };
                    if widgets::row(
                        ui,
                        tokens,
                        widgets::Row::new(
                            match completion.kind {
                                CompletionKind::Slash => crate::icons::ICON_TERMINAL,
                                CompletionKind::Mention => crate::icons::ICON_FILE,
                            },
                            label,
                        )
                        .current(selected)
                        .height(24.0),
                    )
                    .clicked()
                    {
                        out.completion_pick = Some(item.clone());
                    }
                }
            });
            ui.add_space(4.0);
        }
    }
    widgets::card_frame(
        tokens,
        geom::COMPOSER_RADIUS,
        egui::Margin::symmetric(16, 14),
    )
    .show(ui, |ui| {
        // Attachment chips sit above the text, like the Electron cards.
        if !attachments.is_empty() {
            ui.horizontal_wrapped(|ui| {
                for (index, attachment) in attachments.iter().enumerate() {
                    let label = format!(
                        "{} {} · {}",
                        crate::icons::ICON_ATTACH,
                        attachment.name,
                        agente_core::media::human_bytes(attachment.bytes)
                    );
                    if widgets::chip(ui, tokens, &label, true).clicked() {
                        out.remove_attachment = Some(index);
                    }
                }
            });
            ui.add_space(4.0);
        }
        let response = widgets::composer_box(ui, draft, placeholder);
        if response {
            let trimmed = draft.trim_start();
            if trimmed.starts_with('/') && !trimmed.contains(' ') {
                out.completion = Some(Completion::slash(trimmed.trim_start_matches('/')));
            } else if let Some(mention) = trailing_mention(draft) {
                out.completion = Some(Completion::mention(&mention, &[]));
            } else {
                out.completion = None;
            }
        }
        let submitted = ui.input(|input| {
            input.key_pressed(egui::Key::Enter) && !input.modifiers.shift
        });
        if submitted && !streaming {
            let trimmed = draft.trim().to_owned();
            if trimmed.starts_with('/') {
                out.slash = Some(trimmed);
                draft.clear();
            } else if !trimmed.is_empty() {
                out.sent = true;
            }
        } else if submitted && streaming && !draft.trim().is_empty() {
            out.sent = true;
        }
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            if widgets::icon_button(ui, tokens, crate::icons::ICON_PLUS, 26.0).clicked() {
                draft.push_str(" @");
                out.note = Some("Type a path after @ to mention a file".to_owned());
            }
            if widgets::ghost_chip(ui, tokens, model_label)
                .on_hover_text("Model — opens Settings")
                .clicked()
            {
                out.open_settings = true;
            }
            let next = THINKING_LEVELS
                .iter()
                .position(|level| *level == thinking)
                .map(|index| THINKING_LEVELS[(index + 1) % THINKING_LEVELS.len()])
                .unwrap_or("auto");
            if widgets::ghost_chip(
                ui,
                tokens,
                &format!("{thinking} {}", crate::icons::ICON_CARET),
            )
            .on_hover_text("Thinking level")
            .clicked()
            {
                out.thinking = Some(next.to_owned());
            }
            if streaming {
                let retry = session.retry;
                ui.label(
                    RichText::new(match retry {
                        Some((attempt, max)) => format!("{} retry {attempt}/{max}", session.state.label()),
                        None => session.state.label().to_owned(),
                    })
                    .size(12.0)
                    .color(tokens.muted),
                );
            }
            // The mode chip: Plan / Build / Auto, like the Electron selector.
            let next_mode = match mode_label {
                "Plan" => "Build",
                "Build" => "Auto",
                _ => "Plan",
            };
            if widgets::ghost_chip(
                ui,
                tokens,
                &format!("{mode_label} {}", crate::icons::ICON_CARET),
            )
            .on_hover_text("Agent mode")
            .clicked()
            {
                out.mode = Some(next_mode.to_owned());
            }
            let rest = ui.available_width();
            if rest > 40.0 {
                ui.add_space(rest - 92.0);
            }
            let mic_active = voice_listening;
            let mic = widgets::icon_button(ui, tokens, crate::icons::ICON_MIC, 26.0);
            if mic.clicked() {
                out.toggle_voice = true;
            }
            if mic_active {
                ui.label(
                    RichText::new("listening")
                        .size(11.0)
                        .color(tokens.error),
                );
            }
            let mark = if streaming {
                crate::icons::ICON_STOP
            } else {
                crate::icons::ICON_SEND
            };
            if widgets::icon_button(ui, tokens, crate::icons::ICON_MORE, 26.0).clicked() {
                out.note = Some("More: slash commands, prompts and queue".to_owned());
            }
            if widgets::send_disc(ui, tokens, mark, streaming, 30.0).clicked() {
                if streaming {
                    out.stopped = true;
                } else {
                    out.sent = true;
                }
            }
        });
    });
    ui.add_space(4.0);
    ui.vertical_centered(|ui| {
        ui.label(
            RichText::new("Enter to send · Shift+Enter for a new line")
                .size(11.0)
                .color(tokens.muted),
        );
    });
    out
}
