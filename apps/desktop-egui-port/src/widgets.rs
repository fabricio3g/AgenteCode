//! Shared widgets. Ports `components/ui/*` plus the CSS row/bubble/composer
//! classes onto egui's layout model: full-width left-aligned rows with a
//! hover band, 26px chips and discs, the composer pill card and segmented
//! tabs. Rows are painted by hand because egui buttons center their label and
//! Electron's chrome is left-aligned.

use egui::{
    Align, Color32, CornerRadius, Frame, Layout, Margin, Response, RichText, Sense, Stroke, Ui,
    UiBuilder, Vec2,
};

use crate::style::{ThemeTokens, geom, prose_size};

/// Options for one chrome row (sidebar entry, list item, menu line).
pub struct Row<'a> {
    pub icon: &'a str,
    pub label: &'a str,
    /// Right-aligned meta text, dim (counts, shortcuts, statuses).
    pub meta: &'a str,
    pub current: bool,
    pub height: f32,
    pub icon_color: Option<Color32>,
}

impl<'a> Row<'a> {
    pub fn new(icon: &'a str, label: &'a str) -> Self {
        Self {
            icon,
            label,
            meta: "",
            current: false,
            height: geom::SIDEBAR_ROW_H,
            icon_color: None,
        }
    }

    pub fn current(mut self, current: bool) -> Self {
        self.current = current;
        self
    }

    pub fn meta(mut self, meta: &'a str) -> Self {
        self.meta = meta;
        self
    }

    pub fn height(mut self, height: f32) -> Self {
        self.height = height;
        self
    }

    pub fn icon_color(mut self, color: Color32) -> Self {
        self.icon_color = Some(color);
        self
    }
}

/// One full-width row: hover band, icon, label, optional meta. Returns the
/// response so callers can react to clicks and hovers.
pub fn row(ui: &mut Ui, tokens: ThemeTokens, row: Row<'_>) -> Response {
    let width = ui.available_width();
    let (rect, response) = ui.allocate_exact_size(
        Vec2::new(width, row.height),
        Sense::click(),
    );
    // The band is inset 4px on each side, like the Electron sidebar rows.
    let band = egui::Rect::from_min_max(
        egui::pos2(rect.left() + 4.0, rect.top()),
        egui::pos2(rect.right() - 4.0, rect.bottom()),
    );
    let fill = if row.current {
        tokens.active_fill
    } else if response.hovered() {
        tokens.hover_fill
    } else {
        Color32::TRANSPARENT
    };
    ui.painter()
        .rect_filled(band, CornerRadius::from(geom::SIDEBAR_RADIUS as u8), fill);

    let content_rect = band.shrink2(Vec2::new(14.0, 0.0));
    let mut content = ui.new_child(
        UiBuilder::new()
            .max_rect(content_rect)
            .layout(Layout::left_to_right(Align::Center)),
    );
    let label_color = if row.current {
        tokens.text
    } else {
        tokens.secondary
    };
    if !row.icon.is_empty() {
        content.label(
            RichText::new(row.icon)
                .size(16.0)
                .color(row.icon_color.unwrap_or(if row.current {
                    tokens.text
                } else {
                    tokens.muted
                })),
        );
    }
    content.label(RichText::new(row.label).size(13.0).color(label_color));
    if !row.meta.is_empty() {
        content.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(RichText::new(row.meta).size(12.0).color(tokens.muted));
        });
    }
    response
}

/// 36px square rail button on the 52px activity strip: icon only, a soft
/// squircle when it is the current space.
pub fn rail_button(ui: &mut Ui, tokens: ThemeTokens, active: bool, icon: &str) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(geom::RAIL_BTN), Sense::click());
    let fill = if active {
        tokens.active_fill
    } else if response.hovered() {
        tokens.hover_fill
    } else {
        Color32::TRANSPARENT
    };
    ui.painter()
        .rect_filled(rect, CornerRadius::from(geom::RAIL_RADIUS as u8), fill);
    if active {
        ui.painter().rect_stroke(
            rect,
            CornerRadius::from(geom::RAIL_RADIUS as u8),
            Stroke::new(1.0, tokens.border_hover),
            egui::StrokeKind::Inside,
        );
    }
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        icon,
        egui::FontId::new(18.0, egui::FontFamily::Proportional),
        if active { tokens.text } else { tokens.muted },
    );
    response
}

/// The switch Electron uses in settings rows: a pill track with a knob.
pub fn switch(ui: &mut Ui, tokens: ThemeTokens, on: bool) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(36.0, 20.0), Sense::click());
    let track = if on { tokens.focus } else { tokens.hover_fill };
    ui.painter()
        .rect_filled(rect, CornerRadius::from(99u8), track);
    let center = rect.center() + Vec2::new(if on { 8.0 } else { -8.0 }, 0.0);
    ui.painter().circle_filled(
        center,
        8.0,
        if on { tokens.bg } else { tokens.muted },
    );
    response
}

/// A settings field: rounded, subtle fill, hairline ring.
pub fn field(ui: &mut Ui, tokens: ThemeTokens, value: &mut String, hint: &str) -> bool {
    let width = ui.available_width().min(260.0);
    ui.add(
        egui::TextEdit::singleline(value)
            .hint_text(RichText::new(hint).size(13.0).color(tokens.muted))
            .desired_width(width)
            .frame(Frame {
                fill: tokens.bg,
                stroke: Stroke::new(1.0, tokens.border_hover),
                corner_radius: CornerRadius::from(8u8),
                inner_margin: Margin::symmetric(10, 6),
                ..Default::default()
            }),
    )
    .changed()
}

/// Quiet chip: 26px pill on a hairline, brighter when it is the active one.
pub fn chip(ui: &mut Ui, tokens: ThemeTokens, label: &str, active: bool) -> Response {
    let color = if active { tokens.text } else { tokens.secondary };
    let mut button = egui::Button::new(RichText::new(label).size(12.0).color(color))
        .corner_radius(CornerRadius::from(geom::CONTROL_H as u8 / 2 + 4));
    if active {
        button = button
            .fill(tokens.active_fill)
            .stroke(Stroke::new(1.0, tokens.border_hover));
    } else {
        button = button
            .fill(Color32::TRANSPARENT)
            .stroke(Stroke::new(1.0, tokens.border));
    }
    ui.add_sized(Vec2::new(0.0, geom::CONTROL_H), button)
}

/// Borderless chip: no ring, used inside cards (model, thinking, dock doors).
pub fn ghost_chip(ui: &mut Ui, tokens: ThemeTokens, label: &str) -> Response {
    ui.add(
        egui::Button::new(RichText::new(label).size(12.0).color(tokens.secondary))
            .frame(false)
            .corner_radius(CornerRadius::from(geom::CONTROL_H as u8 / 2 + 4)),
    )
}

/// Circular icon disc, like `.ui-icon-button`: quiet until hovered.
pub fn icon_button(ui: &mut Ui, tokens: ThemeTokens, glyph: &str, size: f32) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size), Sense::click());
    let fill = if response.hovered() {
        tokens.hover_fill
    } else {
        Color32::TRANSPARENT
    };
    ui.painter()
        .rect_filled(rect, CornerRadius::from((size / 2.0) as u8), fill);
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        glyph,
        egui::FontId::new(size * 0.62, egui::FontFamily::Proportional),
        if response.hovered() {
            tokens.text
        } else {
            tokens.muted
        },
    );
    response
}

/// The composer's send disc: a dark circle with a hairline ring, brighter when
/// the draft can be sent. Stops the turn while one runs.
pub fn send_disc(
    ui: &mut Ui,
    tokens: ThemeTokens,
    glyph: &str,
    danger: bool,
    size: f32,
) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size), Sense::click());
    let fill = if danger {
        tokens.error
    } else {
        tokens.active_fill
    };
    ui.painter()
        .rect_filled(rect, CornerRadius::from(99u8), fill);
    ui.painter().rect_stroke(
        rect,
        CornerRadius::from(99u8),
        Stroke::new(1.0, tokens.border_hover),
        egui::StrokeKind::Inside,
    );
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        glyph,
        egui::FontId::new(size * 0.5, egui::FontFamily::Proportional),
        if danger { tokens.bg } else { tokens.text },
    );
    response
}

/// Primary round action: dark disc with the send arrow, error disc to stop.
pub fn round_action(
    ui: &mut Ui,
    tokens: ThemeTokens,
    glyph: &str,
    danger: bool,
    size: f32,
) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size), Sense::click());
    let fill = if danger {
        tokens.error
    } else if response.hovered() {
        tokens.text.gamma_multiply(0.86)
    } else {
        tokens.text
    };
    ui.painter()
        .rect_filled(rect, CornerRadius::from(99u8), fill);
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        glyph,
        egui::FontId::new(size * 0.5, egui::FontFamily::Proportional),
        tokens.bg,
    );
    response
}

/// Card frame: fill, 1px ring, radius and padding, like `.ui-composer`.
pub fn card_frame(tokens: ThemeTokens, radius: f32, margin: Margin) -> Frame {
    Frame {
        fill: tokens.card,
        stroke: Stroke::new(1.0, tokens.border_hover),
        corner_radius: CornerRadius::from(radius as u8),
        inner_margin: margin,
        ..Default::default()
    }
}

/// Centers content in a max-width column, like the 48rem thread column.
pub fn centered_column<R>(ui: &mut Ui, width: f32, add_contents: impl FnOnce(&mut Ui) -> R) -> R {
    ui.vertical_centered(|ui| {
        ui.set_max_width(width);
        add_contents(ui)
    })
    .inner
}

/// Dim 12px section header, like `.sidebar-section`.
pub fn section_header(ui: &mut Ui, tokens: ThemeTokens, text: &str) {
    ui.label(RichText::new(text).size(12.0).color(tokens.muted));
}

/// Placeholder body for an empty list.
pub fn empty_state(ui: &mut Ui, tokens: ThemeTokens, text: &str) {
    ui.label(RichText::new(text).size(13.0).color(tokens.muted));
}

/// Right-aligned user bubble: fill, 24px corners, tucked bottom-right.
pub fn user_bubble(ui: &mut Ui, tokens: ThemeTokens, scale: f32, text: &str) {
    ui.with_layout(Layout::right_to_left(Align::TOP), |ui| {
        let frame = Frame {
            fill: tokens.bubble,
            corner_radius: CornerRadius::from(geom::BUBBLE_RADIUS as u8),
            inner_margin: Margin::symmetric(16, 11),
            ..Default::default()
        };
        frame.show(ui, |ui| {
            ui.set_max_width(geom::THREAD_W * 0.72);
            ui.label(
                RichText::new(text)
                    .size(prose_size(scale))
                    .color(tokens.text),
            );
        });
    });
}

/// Segmented tabs: quiet track, raised pill on the current one.
pub fn segmented(
    ui: &mut Ui,
    tokens: ThemeTokens,
    options: &[&str],
    current: usize,
) -> Option<usize> {
    let mut picked: Option<usize> = None;
    ui.horizontal(|ui| {
        for (index, option) in options.iter().enumerate() {
            if chip(ui, tokens, option, index == current).clicked() {
                picked = Some(index);
            }
        }
    });
    picked
}

/// Dismissible toast stack with per-kind marks, like `Toaster.svelte`.
pub fn toast_bar(ui: &mut Ui, tokens: ThemeTokens, toasts: &mut Vec<crate::state::Toast>) -> bool {
    use crate::state::ToastKind;
    let mut dismiss: Option<usize> = None;
    for (index, toast) in toasts.iter().enumerate() {
        let (mark, color) = match toast.kind {
            ToastKind::Info => (crate::icons::ICON_INFO, tokens.secondary),
            ToastKind::Success => (crate::icons::ICON_CHECK, tokens.success),
            ToastKind::Error => (crate::icons::ICON_WARN, tokens.error),
        };
        ui.horizontal(|ui| {
            ui.label(RichText::new(mark).size(12.0).color(color));
            ui.label(RichText::new(toast.text.as_str()).size(12.0).color(color));
            if ui.small_button("dismiss").clicked() {
                dismiss = Some(index);
            }
        });
    }
    if let Some(index) = dismiss {
        toasts.remove(index);
    }
    !toasts.is_empty()
}

/// Single-line field with a leading hint. Returns true when it changed.
pub fn search_row(ui: &mut Ui, current: &mut String, hint: &str) -> bool {
    ui.add(
        egui::TextEdit::singleline(current)
            .hint_text(RichText::new(hint).size(13.0).color(ui.visuals().weak_text_color()))
            .desired_width(f32::INFINITY)
            .frame(Frame {
                fill: Color32::TRANSPARENT,
                stroke: Stroke::NONE,
                ..Default::default()
            }),
    )
    .changed()
}

/// Borderless multi-line composer box. Returns true when it changed.
pub fn composer_box(ui: &mut Ui, current: &mut String, hint: &str) -> bool {
    ui.add(
        egui::TextEdit::multiline(current)
            .hint_text(RichText::new(hint).size(prose_size(1.0)).color(ui.visuals().weak_text_color()))
            .desired_width(f32::INFINITY)
            .desired_rows(1)
            .frame(Frame {
                fill: Color32::TRANSPARENT,
                stroke: Stroke::NONE,
                ..Default::default()
            }),
    )
    .changed()
}
