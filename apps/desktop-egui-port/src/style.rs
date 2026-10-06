//! Exact Electron design tokens plus the egui `Style` install.
//!
//! Ports `apps/desktop/renderer/src/app.css` 1:1: monochrome surfaces, one
//! brand orange reserved for focus/active, dark-first. Spacing, widgets and
//! scroll bars follow egui's documented model (`Style { visuals, spacing,
//! text_styles }`, `ScrollStyle::thin`), tuned to the Electron geometry.

use egui::style::ScrollStyle;
use egui::{
    Color32, Context, CornerRadius, FontFamily, FontId, Margin, Stroke, TextStyle, Vec2, Visuals,
};

/// App theme. Electron boots dark; light only when stored.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

impl Theme {
    pub fn toggle(self) -> Self {
        match self {
            Self::Dark => Self::Light,
            Self::Light => Self::Dark,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Dark => "Dark",
            Self::Light => "Light",
        }
    }
}

/// One surface per plane, like the CSS: page < sidebar < rail < card < popover.
#[derive(Clone, Copy, Debug)]
pub struct ThemeTokens {
    pub bg: Color32,
    pub card: Color32,
    pub popover: Color32,
    pub sidebar: Color32,
    pub rail: Color32,
    pub text: Color32,
    pub secondary: Color32,
    pub muted: Color32,
    pub border: Color32,
    pub border_hover: Color32,
    /// Panel separators. Electron draws them as `rgb(255 255 255 / 0.08)`,
    /// which composites per surface; this is the value over the rail.
    pub separator: Color32,
    pub hover_fill: Color32,
    pub active_fill: Color32,
    pub bubble: Color32,
    pub focus: Color32,
    pub brand: Color32,
    pub success: Color32,
    pub warning: Color32,
    pub error: Color32,
}

impl ThemeTokens {
    pub fn of(theme: Theme) -> Self {
        match theme {
            Theme::Dark => Self {
                bg: Color32::from_rgb(0x16, 0x16, 0x16),
                card: Color32::from_rgb(0x1e, 0x1e, 0x1e),
                popover: Color32::from_rgb(0x26, 0x26, 0x26),
                sidebar: Color32::from_rgb(0x0f, 0x0f, 0x10),
                rail: Color32::from_rgb(0x25, 0x25, 0x25),
                text: Color32::from_rgb(0xec, 0xec, 0xec),
                secondary: Color32::from_rgb(0xb8, 0xb8, 0xb8),
                muted: Color32::from_rgb(0xa1, 0xa1, 0xa1),
                border: Color32::from_rgb(0x29, 0x29, 0x29),
                border_hover: Color32::from_rgb(0x37, 0x37, 0x37),
                separator: Color32::from_rgb(0x36, 0x36, 0x37),
                hover_fill: Color32::from_rgb(0x22, 0x22, 0x22),
                active_fill: Color32::from_rgb(0x25, 0x25, 0x26),
                bubble: Color32::from_rgb(0x22, 0x22, 0x22),
                focus: Color32::from_rgb(0xe8, 0x79, 0x3a),
                brand: Color32::from_rgb(0xe8, 0x79, 0x3a),
                success: Color32::from_rgb(0x6c, 0xc5, 0x8a),
                warning: Color32::from_rgb(0xe5, 0xb4, 0x54),
                error: Color32::from_rgb(0xf0, 0x7b, 0x72),
            },
            Theme::Light => Self {
                bg: Color32::from_rgb(0xff, 0xff, 0xff),
                card: Color32::from_rgb(0xff, 0xff, 0xff),
                popover: Color32::from_rgb(0xff, 0xff, 0xff),
                sidebar: Color32::from_rgb(0xf5, 0xf5, 0xf6),
                rail: Color32::from_rgb(0xe5, 0xe5, 0xe6),
                text: Color32::from_rgb(0x0d, 0x0d, 0x0d),
                secondary: Color32::from_rgb(0x52, 0x52, 0x52),
                muted: Color32::from_rgb(0x5f, 0x5f, 0x5f),
                border: Color32::from_rgb(0xed, 0xed, 0xed),
                border_hover: Color32::from_rgb(0xdb, 0xdb, 0xdb),
                separator: Color32::from_rgb(0xe5, 0xe5, 0xe6),
                hover_fill: Color32::from_rgb(0xf2, 0xf2, 0xf2),
                active_fill: Color32::from_rgb(0xeb, 0xeb, 0xec),
                bubble: Color32::from_rgb(0xf2, 0xf2, 0xf2),
                focus: Color32::from_rgb(0xe7, 0x6d, 0x1f),
                brand: Color32::from_rgb(0xe7, 0x6d, 0x1f),
                success: Color32::from_rgb(0x16, 0xa3, 0x4a),
                warning: Color32::from_rgb(0xca, 0x8a, 0x04),
                error: Color32::from_rgb(0xdc, 0x26, 0x26),
            },
        }
    }
}

/// Installs the whole style for both egui themes and pins the app's own
/// choice, so the OS preference never overrides the in-app theme.
/// Call this on every theme or text-size change.
pub fn apply_style(ctx: &Context, theme: Theme, scale: f32) {
    let tokens = ThemeTokens::of(theme);
    let mut style = (*ctx.style_of(to_egui_theme(theme))).clone();
    style.visuals = visuals(tokens, theme);
    style.spacing = spacing();
    style.text_styles = text_styles(scale);
    style.animation_time = 0.12;
    ctx.set_style_of(egui::Theme::Dark, style.clone());
    ctx.set_style_of(egui::Theme::Light, style);
    ctx.set_theme(match theme {
        Theme::Dark => egui::ThemePreference::Dark,
        Theme::Light => egui::ThemePreference::Light,
    });
}

/// The egui theme an app theme maps onto.
fn to_egui_theme(theme: Theme) -> egui::Theme {
    match theme {
        Theme::Dark => egui::Theme::Dark,
        Theme::Light => egui::Theme::Light,
    }
}

/// Colors. Dialogs are floating panels; nothing here draws a harsh border.
fn visuals(tokens: ThemeTokens, theme: Theme) -> Visuals {
    let mut visuals = match theme {
        Theme::Dark => Visuals::dark(),
        Theme::Light => Visuals::light(),
    };
    visuals.panel_fill = tokens.bg;
    visuals.window_fill = tokens.popover;
    visuals.window_stroke = Stroke::new(1.0, tokens.border_hover);
    visuals.window_corner_radius = CornerRadius::from(12u8);
    visuals.menu_corner_radius = CornerRadius::from(10u8);
    visuals.extreme_bg_color = tokens.card;
    visuals.text_edit_bg_color = Some(Color32::TRANSPARENT);
    visuals.code_bg_color = tokens.card;
    visuals.faint_bg_color = tokens.hover_fill;
    visuals.selection.bg_fill = tokens.active_fill;
    visuals.selection.stroke = Stroke::new(1.0, tokens.text);
    visuals.hyperlink_color = tokens.focus;
    visuals.warn_fg_color = tokens.warning;
    visuals.error_fg_color = tokens.error;
    visuals.weak_text_alpha = 0.72;
    visuals.button_frame = true;
    visuals.striped = true;
    visuals.indent_has_left_vline = false;
    visuals.slider_trailing_fill = true;
    visuals.interact_cursor = Some(egui::CursorIcon::PointingHand);

    // Non-interactive: page text.
    visuals.widgets.noninteractive.bg_fill = tokens.bg;
    visuals.widgets.noninteractive.weak_bg_fill = tokens.bg;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, tokens.separator);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, tokens.text);
    visuals.widgets.noninteractive.corner_radius = CornerRadius::from(8u8);
    visuals.widgets.noninteractive.expansion = 0.0;

    // Inactive: quiet chips and buttons on a card.
    visuals.widgets.inactive.bg_fill = tokens.card;
    visuals.widgets.inactive.weak_bg_fill = Color32::TRANSPARENT;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, tokens.border);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, tokens.secondary);
    visuals.widgets.inactive.corner_radius = CornerRadius::from(8u8);
    visuals.widgets.inactive.expansion = 0.0;

    // Hover: one step lighter, never bright.
    visuals.widgets.hovered.bg_fill = tokens.hover_fill;
    visuals.widgets.hovered.weak_bg_fill = tokens.hover_fill;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, tokens.border_hover);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, tokens.text);
    visuals.widgets.hovered.corner_radius = CornerRadius::from(8u8);
    visuals.widgets.hovered.expansion = 0.0;

    // Active: the selected row's band.
    visuals.widgets.active.bg_fill = tokens.active_fill;
    visuals.widgets.active.weak_bg_fill = tokens.active_fill;
    visuals.widgets.active.bg_stroke = Stroke::new(1.0, tokens.border_hover);
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, tokens.text);
    visuals.widgets.active.corner_radius = CornerRadius::from(8u8);
    visuals.widgets.active.expansion = 0.0;

    visuals.widgets.open.bg_fill = tokens.card;
    visuals.widgets.open.weak_bg_fill = tokens.card;
    visuals.widgets.open.bg_stroke = Stroke::new(1.0, tokens.border_hover);
    visuals.widgets.open.fg_stroke = Stroke::new(1.0, tokens.text);
    visuals.widgets.open.corner_radius = CornerRadius::from(8u8);
    visuals
}

/// Geometry: 8px rhythm, 32px rows, 26px controls, thin floating scroll bars.
fn spacing() -> egui::Spacing {
    let mut spacing = egui::Spacing {
        item_spacing: Vec2::new(8.0, 6.0),
        window_margin: Margin::same(14),
        menu_margin: Margin::same(6),
        button_padding: Vec2::new(10.0, 5.0),
        indent: 16.0,
        interact_size: Vec2::new(0.0, 26.0),
        slider_width: 140.0,
        combo_width: 180.0,
        text_edit_width: 240.0,
        icon_width: 16.0,
        icon_width_inner: 9.0,
        icon_spacing: 8.0,
        tooltip_width: 320.0,
        menu_width: 220.0,
        combo_height: 320.0,
        ..Default::default()
    };
    spacing.scroll = ScrollStyle {
        floating: true,
        bar_width: 10.0,
        floating_width: 6.0,
        bar_inner_margin: 4.0,
        bar_outer_margin: 0.0,
        handle_min_length: 24.0,
        content_margin: Margin::ZERO,
        foreground_color: true,
        dormant_handle_opacity: 0.0,
        active_handle_opacity: 0.45,
        interact_handle_opacity: 0.7,
        ..ScrollStyle::thin()
    };
    spacing
}

/// Electron's type ladder: prose 15, chrome 14, small 13, floor 12, code 13.
fn text_styles(scale: f32) -> std::collections::BTreeMap<TextStyle, FontId> {
    let mut styles = std::collections::BTreeMap::new();
    styles.insert(
        TextStyle::Heading,
        FontId::new(16.0 * scale, FontFamily::Proportional),
    );
    styles.insert(
        TextStyle::Body,
        FontId::new(14.0 * scale, FontFamily::Proportional),
    );
    styles.insert(
        TextStyle::Button,
        FontId::new(13.0 * scale, FontFamily::Proportional),
    );
    styles.insert(
        TextStyle::Small,
        FontId::new(12.0 * scale, FontFamily::Proportional),
    );
    styles.insert(
        TextStyle::Monospace,
        FontId::new(13.0 * scale, FontFamily::Monospace),
    );
    styles
}

/// Message-body size: one step above the chrome, like `--text-prose`.
pub fn prose_size(scale: f32) -> f32 {
    15.0 * scale
}

/// Layout constants from the CSS geometry tokens.
pub mod geom {
    /// 52px activity rail.
    pub const RAIL_W: f32 = 52.0;
    /// 36px rail buttons.
    pub const RAIL_BTN: f32 = 36.0;
    pub const RAIL_RADIUS: f32 = 8.0;
    /// 36px titlebar.
    pub const TITLEBAR_H: f32 = 36.0;
    /// 240px sidebar.
    pub const SIDEBAR_W: f32 = 240.0;
    /// 32px sidebar rows.
    pub const SIDEBAR_ROW_H: f32 = 32.0;
    pub const SIDEBAR_RADIUS: f32 = 8.0;
    /// 48rem centered thread/composer column.
    pub const THREAD_W: f32 = 768.0;
    /// 28px comfortable message gap.
    pub const THREAD_GAP: f32 = 28.0;
    /// 24px composer pill, 8px bubble tail.
    pub const COMPOSER_RADIUS: f32 = 24.0;
    pub const BUBBLE_RADIUS: f32 = 14.0;
    pub const BUBBLE_TAIL: f32 = 14.0;
    /// 26px controls inside the composer.
    pub const CONTROL_H: f32 = 26.0;
    /// 30px panel-tabs strip.
    pub const STRIP_H: f32 = 30.0;
}
