//! Scrolling conversation viewport. Ports `thread/Thread.svelte`: one
//! centered 48rem column, hidden scrollbars, right-aligned user bubbles,
//! markdown assistant prose, `◆ Run` tool rows, `◇` thoughts, `⟲` compaction
//! dividers, `┃` error rails and the `Worked for Ns` footer.

use egui::containers::scroll_area::ScrollBarVisibility;
use egui::{Frame, RichText, ScrollArea, Ui};

use crate::icons;
use crate::state::{Entry, EntryKind};
use crate::style::{ThemeTokens, geom};
use crate::views::markdown;
use crate::widgets;

/// What the message list produced this frame.
#[derive(Debug, Default)]
pub struct ThreadOut {
    pub copy_text: Option<String>,
    pub delete_index: Option<usize>,
    pub retry: bool,
    pub edit_index: Option<usize>,
    pub fork_index: Option<usize>,
    pub speak_index: Option<usize>,
    pub inspect: bool,
}

/// Renders the transcript rows.
pub fn show_thread(
    ui: &mut Ui,
    tokens: ThemeTokens,
    scale: f32,
    entries: &[Entry],
    jump_to_bottom: bool,
) -> ThreadOut {
    let mut out = ThreadOut::default();
    let mut area = ScrollArea::vertical().auto_shrink([false; 2]);
    area = if jump_to_bottom {
        area.vertical_scroll_offset(f32::INFINITY)
    } else {
        area.stick_to_bottom(true)
    };
    area.scroll_bar_visibility(ScrollBarVisibility::AlwaysHidden)
        .show(ui, |ui| {
            widgets::centered_column(ui, geom::THREAD_W, |ui| {
                for (index, entry) in entries.iter().enumerate() {
                    if index > 0 {
                        ui.add_space(geom::THREAD_GAP);
                    }
                    let response = Frame {
                        fill: egui::Color32::TRANSPARENT,
                        ..Default::default()
                    }
                    .show(ui, |ui| {
                        ui.set_min_size([ui.available_width(), 0.0].into());
                        paint_entry(ui, tokens, scale, entry, index);
                    })
                    .response;
                    if response.hovered() && !entry.text.is_empty() {
                        ui.horizontal(|ui| {
                            if widgets::icon_button(ui, tokens, icons::ICON_COPY, 26.0).clicked() {
                                out.copy_text = Some(entry.text.clone());
                            }
                            if matches!(entry.kind, EntryKind::User | EntryKind::Assistant)
                                && widgets::icon_button(ui, tokens, icons::ICON_DELETE, 26.0).clicked()
                            {
                                out.delete_index = Some(index);
                            }
                            if entry.kind == EntryKind::Assistant {
                                if ui.small_button("Retry").clicked() {
                                    out.delete_index = Some(index);
                                    out.retry = true;
                                }
                                if ui.small_button("Listen").clicked() {
                                    out.speak_index = Some(index);
                                }
                                if ui.small_button("Prompt").clicked() {
                                    out.inspect = true;
                                }
                            }
                        });
                    }
                }
            });
        });
    out
}

fn paint_entry(ui: &mut Ui, tokens: ThemeTokens, scale: f32, entry: &Entry, index: usize) {
    match entry.kind {
        EntryKind::User => {
            widgets::user_bubble(ui, tokens, scale, &entry.text);
            if !entry.attachments.is_empty() {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::TOP), |ui| {
                    ui.horizontal(|ui| {
                        for attachment in &entry.attachments {
                            ui.label(
                                RichText::new(format!(
                                    "{} {} · {}",
                                    icons::ICON_ATTACH,
                                    attachment.name,
                                    agente_core::media::human_bytes(attachment.bytes)
                                ))
                                .size(11.0)
                                .color(tokens.muted),
                            );
                        }
                    });
                });
            }
        }
        EntryKind::Assistant => {
            if entry.text.trim().is_empty() {
                ui.label(RichText::new("…").size(13.0).color(tokens.muted));
            } else {
                markdown::show_markdown(
                    ui,
                    tokens,
                    scale,
                    &entry.text,
                    &format!("entry-{index}"),
                );
            }
        }
        EntryKind::Thinking => {
            let preview: String = entry.text.split_whitespace().collect::<Vec<_>>().join(" ");
            let preview = if preview.len() > 100 {
                format!("{}…", preview.chars().take(100).collect::<String>())
            } else {
                preview
            };
            ui.label(
                RichText::new(format!("{} {preview}", icons::ICON_SPARKLE))
                    .size(13.0)
                    .italics()
                    .color(tokens.muted),
            );
        }
        EntryKind::Tool => {
            let name = entry.tool_name.clone().unwrap_or_else(|| "tool".to_owned());
            let running = entry.text.is_empty();
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(if running {
                        icons::ICON_PLAY
                    } else {
                        icons::ICON_WRENCH
                    })
                    .size(13.0)
                    .color(if entry.is_error {
                        tokens.error
                    } else {
                        tokens.secondary
                    }),
                );
                ui.label(
                    RichText::new(format!("Run {name}"))
                        .size(13.0)
                        .monospace()
                        .strong()
                        .color(tokens.text),
                );
                if running {
                    ui.label(RichText::new("running…").size(12.0).color(tokens.muted));
                }
            });
            if !entry.text.trim().is_empty() {
                let body = tail(&entry.text, 10);
                egui::Frame {
                    fill: tokens.card,
                    corner_radius: 6u8.into(),
                    inner_margin: egui::Margin::symmetric(10, 6),
                    ..Default::default()
                }
                .show(ui, |ui| {
                    ui.label(
                        RichText::new(body)
                            .size(12.0)
                            .monospace()
                            .color(if entry.is_error {
                                tokens.error
                            } else {
                                tokens.secondary
                            }),
                    );
                });
            }
        }
        EntryKind::Notice => {
            ui.label(
                RichText::new(format!("{} {}", icons::ICON_INFO, entry.text))
                    .size(12.0)
                    .color(tokens.muted),
            );
        }
        EntryKind::Compaction => {
            ui.label(
                RichText::new(format!("{} {}", icons::ICON_SYNC, entry.text))
                    .size(12.0)
                    .color(tokens.muted),
            );
        }
        EntryKind::Error => {
            ui.horizontal(|ui| {
                ui.label(RichText::new("┃").size(14.0).color(tokens.error));
                ui.label(
                    RichText::new(entry.text.clone())
                        .size(13.0)
                        .color(tokens.error),
                );
            });
        }
        EntryKind::Footer => {
            ui.label(
                RichText::new(entry.text.clone())
                    .size(12.0)
                    .color(tokens.muted),
            );
        }
        EntryKind::TurnHeader => {
            // `⌄ N steps` with the elapsed time on the right, like the
            // Electron turn header.
            let steps = entry.depth;
            let seconds = entry.seconds;
            egui::containers::Sides::new().height(22.0).show(
                ui,
                |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(crate::icons::ICON_CARET)
                                .size(12.0)
                                .color(tokens.muted),
                        );
                        ui.label(
                            RichText::new(if steps == 0 {
                                "Working…".to_owned()
                            } else if steps == 1 {
                                "1 step".to_owned()
                            } else {
                                format!("{steps} steps")
                            })
                            .size(13.0)
                            .color(tokens.secondary),
                        );
                    });
                },
                |ui| {
                    if seconds > 0 {
                        ui.label(
                            RichText::new(format_elapsed(seconds))
                                .size(12.0)
                                .color(tokens.muted),
                        );
                    }
                },
            );
        }
        EntryKind::Step => {
            let indent = 8.0 + entry.depth as f32 * 20.0;
            let name = entry.tool_name.clone().unwrap_or_default();
            ui.horizontal(|ui| {
                ui.add_space(indent);
                ui.label(
                    RichText::new(if entry.is_error {
                        crate::icons::ICON_WARN
                    } else {
                        crate::icons::ICON_CARET
                    })
                    .size(11.0)
                    .color(if entry.is_error { tokens.error } else { tokens.muted }),
                );
                let label = if name.is_empty() {
                    entry.text.clone()
                } else {
                    format!("{name} · {}", tail_line(&entry.text))
                };
                ui.label(
                    RichText::new(label)
                        .size(13.0)
                        .color(if entry.is_error { tokens.error } else { tokens.text }),
                );
                if !entry.meta.is_empty() {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            RichText::new(entry.meta.clone())
                                .size(11.0)
                                .color(tokens.muted),
                        );
                    });
                }
            });
            if !entry.text.is_empty() && !name.is_empty() {
                ui.horizontal(|ui| {
                    ui.add_space(indent + 16.0);
                    ui.label(
                        RichText::new(tail(&entry.text, 3))
                            .size(11.0)
                            .monospace()
                            .color(tokens.secondary),
                    );
                });
            }
        }
    }
}

/// `2m 14s` style elapsed time for the turn header.
fn format_elapsed(seconds: u64) -> String {
    if seconds >= 60 {
        format!("{}m {}s", seconds / 60, seconds % 60)
    } else {
        format!("{seconds}s")
    }
}

/// First line of a tool result, for the step row's label.
fn tail_line(text: &str) -> String {
    let line = text.lines().find(|line| !line.trim().is_empty()).unwrap_or("");
    if line.len() > 80 {
        format!("{}…", line.chars().take(80).collect::<String>())
    } else {
        line.to_owned()
    }
}

/// Last `count` lines of a tool result, so a long output stays a preview.
fn tail(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= count {
        return text.to_owned();
    }
    let skipped = lines.len() - count;
    let mut body = format!("… {skipped} earlier lines\n");
    body.push_str(&lines[skipped..].join("\n"));
    body
}
