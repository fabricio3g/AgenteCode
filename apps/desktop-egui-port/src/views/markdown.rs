//! Markdown rendering for assistant messages. Ports the thread markdown body
//! (headings, bold/italic, code, lists, quotes, rules, tables, task lists) to
//! egui paint: one `LayoutJob` per block, prose sizing, real bold from the
//! bundled Inter Bold, code in Plex Mono on the card fill.

use egui::text::{LayoutJob, TextFormat};
use egui::{Color32, FontFamily, FontId, Grid, Stroke, Ui};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::style::{ThemeTokens, prose_size};

#[derive(Clone, Default)]
struct Inline {
    strong: bool,
    emphasis: bool,
    strike: bool,
    code: bool,
    link: bool,
}

struct Block {
    job: LayoutJob,
}

impl Block {
    fn text(&mut self, text: &str, format: TextFormat) {
        self.job.append(text, 0.0, format);
    }
}

/// Renders markdown into the current Ui. `salt` scopes table grids per message.
pub fn show_markdown(ui: &mut Ui, tokens: ThemeTokens, scale: f32, text: &str, salt: &str) {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    let mut inline = Inline::default();
    let mut heading_size: Option<f32> = None;
    let mut block: Option<Block> = None;
    let mut list_stack: Vec<Option<u64>> = Vec::new();
    let mut code_fence: Option<(String, String)> = None;
    let mut table: Option<Table> = None;
    let mut quote_depth = 0u32;

    let format = |inline: &Inline, heading: Option<f32>| {
        let size = heading.unwrap_or_else(|| prose_size(scale));
        let family = if inline.code {
            FontFamily::Monospace
        } else if inline.strong {
            FontFamily::Name("bold".into())
        } else {
            FontFamily::Proportional
        };
        TextFormat {
            font_id: FontId::new(size, family),
            color: if inline.link { tokens.focus } else { tokens.text },
            background: if inline.code {
                tokens.hover_fill
            } else {
                Color32::TRANSPARENT
            },
            italics: inline.emphasis,
            underline: if inline.link {
                Stroke::new(1.0, tokens.focus)
            } else {
                Stroke::NONE
            },
            strikethrough: if inline.strike {
                Stroke::new(1.0, tokens.secondary)
            } else {
                Stroke::NONE
            },
            ..Default::default()
        }
    };
    let ensure_block = |block: &mut Option<Block>| {
        if block.is_none() {
            *block = Some(Block {
                job: LayoutJob::default(),
            });
        }
    };

    for event in Parser::new_ext(text, options) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {
                    block = Some(Block {
                        job: LayoutJob::default(),
                    });
                }
                Tag::Heading { level, .. } => {
                    ui.add_space(6.0);
                    heading_size = Some(match level {
                        HeadingLevel::H1 => 19.0 * scale,
                        HeadingLevel::H2 => 17.0 * scale,
                        HeadingLevel::H3 => 16.0 * scale,
                        _ => 15.0 * scale,
                    });
                    inline.strong = true;
                    block = Some(Block {
                        job: LayoutJob::default(),
                    });
                }
                Tag::BlockQuote(_) => {
                    quote_depth += 1;
                    block = Some(Block {
                        job: LayoutJob::default(),
                    });
                }
                Tag::CodeBlock(kind) => {
                    let language = match kind {
                        CodeBlockKind::Fenced(name) => name.into_string(),
                        CodeBlockKind::Indented => String::new(),
                    };
                    code_fence = Some((language, String::new()));
                }
                Tag::List(first) => list_stack.push(first),
                Tag::Item => {
                    ui.add_space(2.0);
                    block = Some(Block {
                        job: LayoutJob::default(),
                    });
                    let prefix = match list_stack.last().copied().flatten() {
                        Some(number) => {
                            if let Some(slot) = list_stack.last_mut() {
                                *slot = Some(number + 1);
                            }
                            format!("{number}.  ")
                        }
                        None => "•  ".to_owned(),
                    };
                    let indent = "    ".repeat(list_stack.len().saturating_sub(1));
                    block.as_mut().expect("item block").text(
                        &format!("{indent}{prefix}"),
                        TextFormat {
                            font_id: FontId::new(prose_size(scale), FontFamily::Proportional),
                            color: tokens.secondary,
                            ..Default::default()
                        },
                    );
                }
                Tag::Table(_) => table = Some(Table::default()),
                Tag::TableHead | Tag::TableRow => {
                    if let Some(table) = table.as_mut() {
                        table.rows.push(Vec::new());
                    }
                }
                Tag::TableCell => {
                    if let Some(table) = table.as_mut() {
                        table.cells.push(String::new());
                    }
                }
                Tag::Emphasis => inline.emphasis = true,
                Tag::Strong => inline.strong = true,
                Tag::Strikethrough => inline.strike = true,
                Tag::Link { .. } => inline.link = true,
                Tag::Image { .. } => {
                    ensure_block(&mut block);
                    let format = format(&inline, heading_size);
                    block.as_mut().expect("image block").text(
                        "[image] ",
                        TextFormat {
                            color: tokens.muted,
                            ..format
                        },
                    );
                }
                _ => {}
            },
            Event::End(end) => match end {
                TagEnd::Paragraph => flush_block(ui, tokens, &mut block, quote_depth),
                TagEnd::Heading(_) => {
                    inline.strong = false;
                    heading_size = None;
                    flush_block(ui, tokens, &mut block, quote_depth);
                    ui.add_space(2.0);
                }
                TagEnd::BlockQuote(_) => {
                    quote_depth = quote_depth.saturating_sub(1);
                    flush_block(ui, tokens, &mut block, quote_depth);
                }
                TagEnd::CodeBlock => {
                    if let Some((language, code)) = code_fence.take() {
                        if !language.is_empty() {
                            ui.label(
                                egui::RichText::new(language)
                                    .size(12.0)
                                    .monospace()
                                    .color(tokens.muted),
                            );
                        }
                        egui::Frame {
                            fill: tokens.card,
                            stroke: Stroke::new(1.0, tokens.border),
                            corner_radius: 8u8.into(),
                            inner_margin: 8.0.into(),
                            ..Default::default()
                        }
                        .show(ui, |ui| {
                            egui::ScrollArea::horizontal()
                                .auto_shrink([false, true])
                                .max_height(360.0)
                                .show(ui, |ui| {
                                    ui.label(
                                        egui::RichText::new(code.trim_end())
                                            .size(13.0 * scale)
                                            .monospace()
                                            .color(tokens.text),
                                    );
                                });
                        });
                        ui.add_space(4.0);
                    }
                }
                TagEnd::List(_) => {
                    list_stack.pop();
                    ui.add_space(2.0);
                }
                TagEnd::Item => flush_block(ui, tokens, &mut block, quote_depth),
                TagEnd::Table => {
                    if let Some(table) = table.take() {
                        show_table(ui, tokens, scale, &table, salt);
                    }
                }
                TagEnd::TableHead | TagEnd::TableRow => {
                    if let Some(table) = table.as_mut() {
                        let cells = std::mem::take(&mut table.cells);
                        if let Some(row) = table.rows.last_mut() {
                            *row = cells;
                        }
                    }
                }
                TagEnd::Emphasis => inline.emphasis = false,
                TagEnd::Strong => inline.strong = false,
                TagEnd::Strikethrough => inline.strike = false,
                TagEnd::Link => inline.link = false,
                _ => flush_block(ui, tokens, &mut block, quote_depth),
            },
            Event::Text(text) => {
                if let Some((_, code)) = code_fence.as_mut() {
                    code.push_str(&text);
                } else if table.is_some() {
                    if let Some(current) = table.as_mut().and_then(|t| t.cells.last_mut()) {
                        current.push_str(&text);
                    }
                } else {
                    ensure_block(&mut block);
                    let format = format(&inline, heading_size);
                    block.as_mut().expect("text block").text(&text, format);
                }
            }
            Event::Code(code) => {
                ensure_block(&mut block);
                let saved = inline.code;
                inline.code = true;
                let format = format(&inline, heading_size);
                block.as_mut().expect("code span").text(&code, format);
                inline.code = saved;
            }
            Event::SoftBreak => {
                ensure_block(&mut block);
                let format = format(&inline, heading_size);
                block.as_mut().expect("soft break").text(" ", format);
            }
            Event::HardBreak => {
                ensure_block(&mut block);
                let format = format(&inline, heading_size);
                block.as_mut().expect("hard break").text("\n", format);
            }
            Event::Rule => {
                ui.add_space(4.0);
                ui.separator();
                ui.add_space(4.0);
            }
            Event::TaskListMarker(done) => {
                ensure_block(&mut block);
                let format = format(&inline, heading_size);
                block
                    .as_mut()
                    .expect("task marker")
                    .text(if done { "[x] " } else { "[ ] " }, format);
            }
            Event::InlineMath(math) | Event::DisplayMath(math) => {
                ensure_block(&mut block);
                let saved = inline.code;
                inline.code = true;
                let format = format(&inline, heading_size);
                block.as_mut().expect("math span").text(&math, format);
                inline.code = saved;
            }
            Event::Html(_) | Event::InlineHtml(_) | Event::FootnoteReference(_) => {}
        }
    }
    flush_block(ui, tokens, &mut block, quote_depth);
}

#[derive(Default)]
struct Table {
    rows: Vec<Vec<String>>,
    cells: Vec<String>,
}

fn show_table(ui: &mut Ui, tokens: ThemeTokens, scale: f32, table: &Table, salt: &str) {
    Grid::new(format!("md-table-{salt}"))
        .striped(true)
        .spacing([12.0, 4.0])
        .show(ui, |ui| {
            for (row_index, row) in table.rows.iter().enumerate() {
                for cell in row {
                    let text = if row_index == 0 {
                        egui::RichText::new(cell)
                            .size(13.0 * scale)
                            .strong()
                            .color(tokens.text)
                    } else {
                        egui::RichText::new(cell)
                            .size(13.0 * scale)
                            .color(tokens.text)
                    };
                    ui.label(text);
                }
                ui.end_row();
            }
        });
    ui.add_space(4.0);
}

fn flush_block(ui: &mut Ui, tokens: ThemeTokens, block: &mut Option<Block>, quote: u32) {
    let Some(mut finished) = block.take() else {
        return;
    };
    if finished.job.sections.is_empty() {
        return;
    }
    finished.job.wrap.max_width = ui.available_width();
    if quote > 0 {
        egui::Frame {
            fill: tokens.hover_fill,
            corner_radius: 6u8.into(),
            inner_margin: egui::Margin {
                left: 12,
                right: 8,
                top: 6,
                bottom: 6,
            },
            ..Default::default()
        }
        .show(ui, |ui| {
            ui.label(finished.job);
        });
    } else {
        ui.label(finished.job);
    }
    ui.add_space(6.0);
}
