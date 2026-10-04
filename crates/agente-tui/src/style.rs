//! Unified style system for TUI
//! - Adaptive colors that blend with terminal
//! - Subtle backgrounds instead of harsh borders
//! - Muted, modern semantic colors
//! - Runtime theme switching (dark/light)

use ratatui::style::{Color, Modifier, Style};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// THEME SWITCHING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
    Dark = 0,
    Light = 1,
}

static CURRENT_THEME: AtomicU8 = AtomicU8::new(0);
/// Bumped on every theme change. Render caches built on theme-colored output
/// (syntax-highlighted code blocks) mix [`syntax_generation`] into their cache
/// key so a `/theme` toggle invalidates them instead of serving stale colors.
static THEME_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn set_theme(theme: Theme) {
    CURRENT_THEME.store(theme as u8, Ordering::Relaxed);
    THEME_GENERATION.fetch_add(1, Ordering::Relaxed);
}

/// Monotonic count of theme changes. Cache keys for theme-colored renders
/// (e.g. `RenderedChatBlock` in `state::ui`) mix this in so a `/theme`
/// toggle re-renders every cached code block with the new syntect theme.
pub fn syntax_generation() -> u64 {
    THEME_GENERATION.load(Ordering::Relaxed)
}

pub fn current_theme() -> Theme {
    match CURRENT_THEME.load(Ordering::Relaxed) {
        1 => Theme::Light,
        _ => Theme::Dark,
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DARK THEME (default) - pure-black monochrome canvas
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

pub mod dark {
    use super::*;

    // Background colors — pure-black monochrome canvas
    pub const BG: Color = Color::Rgb(0, 0, 0); // #000000
    pub const BG_PANEL: Color = Color::Rgb(24, 24, 28); // #18181c
    pub const BG_ELEMENT: Color = Color::Rgb(44, 46, 50); // #2c2e32
    /// Pointer hover: one step above the panel, one below the selection.
    pub const BG_HOVER: Color = Color::Rgb(34, 34, 40); // #222228
    pub const BG_ACTIVE: Color = Color::Rgb(44, 44, 52); // #2c2c34

    // Text colors
    pub const FG: Color = Color::Rgb(255, 255, 255); // #ffffff
    pub const FG_MUTED: Color = Color::Rgb(154, 154, 162); // #9a9aa2
    pub const FG_DIM: Color = Color::Rgb(106, 106, 114); // #6a6a72
    /// Shared monochrome gray for all dim chrome in dark mode.
    pub const MONO_GRAY: Color = Color::Rgb(136, 136, 136); // #888888
    /// Dimmed chrome for collapsed tool headers (Wave 2 renders use this).
    pub const MACHINERY: Color = MONO_GRAY;
    /// Dim suffix text (counts, separators, metadata tails).
    pub const DETAIL: Color = MONO_GRAY;
    /// Bright green for action markers and meta suffixes.
    pub const META: Color = Color::Rgb(158, 206, 106); // #9ece6a

    // Primary/Brand - teal accent
    pub const PRIMARY: Color = Color::Rgb(138, 190, 183); // #8abeb7
    pub const SECONDARY: Color = Color::Rgb(97, 175, 239); // #61afef (blue subheadings)
    pub const ACCENT: Color = Color::Rgb(138, 190, 183); // #8abeb7

    // Semantic colors
    pub const SUCCESS: Color = Color::Rgb(181, 189, 104); // #b5bd68
    pub const WARNING: Color = Color::Rgb(217, 161, 59); // #d9a13b
    pub const ERROR: Color = Color::Rgb(204, 102, 102); // #cc6666
    pub const INFO: Color = Color::Rgb(95, 135, 255); // #5f87ff

    // Borders - quiet, barely-there
    pub const BORDER: Color = Color::Rgb(58, 58, 66); // #3a3a42
    pub const BORDER_SUBTLE: Color = Color::Rgb(42, 42, 50); // #2a2a32
    pub const BORDER_ACTIVE: Color = Color::Rgb(74, 74, 82); // #4a4a52
    /// Barely-visible full-width rule under popup headers, between SUBTLE and BORDER.
    pub const BORDER_RULE: Color = Color::Rgb(48, 48, 58); // #30303a

    // Diff colors
    pub const DIFF_ADDED: Color = Color::Rgb(181, 189, 104); // #b5bd68
    pub const DIFF_REMOVED: Color = Color::Rgb(204, 102, 102); // #cc6666
    pub const DIFF_ADDED_BG: Color = Color::Rgb(14, 61, 19); // #0e3d13
    pub const DIFF_REMOVED_BG: Color = Color::Rgb(61, 14, 19); // #3d0e13

    // Hero tile field — the landing page's mosaic, one brand orange at
    // shifting intensity. Dim end first, highlight last.
    pub const TILE_ACCENT: Color = Color::Rgb(232, 121, 58); // #e8793a
    pub const TILE_HI: Color = Color::Rgb(255, 190, 152); // #ffbe98
    pub const TILE_ALPHA: f32 = 0.4;

    // Markdown colors — teal section headings, blue sub-headings, white bold
    pub const MD_HEADING: Color = Color::Rgb(78, 201, 176); // #4ec9b0
    pub const MD_LINK: Color = Color::Rgb(129, 162, 190); // #81a2be
    pub const MD_CODE: Color = Color::Rgb(138, 190, 183); // #8abeb7
    pub const MD_EMPH: Color = Color::Rgb(212, 212, 212); // #d4d4d4
    pub const MD_STRONG: Color = Color::Rgb(232, 232, 234); // #e8e8ea
    pub const MD_QUOTE: Color = Color::Rgb(128, 128, 128); // #808080

    // Syntax colors (VS Code-ish)
    pub const SYNTAX_COMMENT: Color = Color::Rgb(106, 153, 85); // #6A9955
    pub const SYNTAX_KEYWORD: Color = Color::Rgb(86, 156, 214); // #569CD6
    pub const SYNTAX_FUNCTION: Color = Color::Rgb(220, 220, 170); // #DCDCAA
    pub const SYNTAX_VARIABLE: Color = Color::Rgb(156, 220, 254); // #9CDCFE
    pub const SYNTAX_STRING: Color = Color::Rgb(206, 145, 120); // #CE9178
    pub const SYNTAX_NUMBER: Color = Color::Rgb(181, 206, 168); // #B5CEA8
    pub const SYNTAX_TYPE: Color = Color::Rgb(78, 201, 176); // #4EC9B0
    pub const SYNTAX_OPERATOR: Color = Color::Rgb(212, 212, 212); // #D4D4D4
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LIGHT THEME - adaptive version
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

pub mod light {
    use super::*;

    // Background colors - soft light tones
    pub const BG: Color = Color::Rgb(255, 255, 255); // #ffffff
    pub const BG_PANEL: Color = Color::Rgb(250, 250, 250); // #fafafa
    pub const BG_ELEMENT: Color = Color::Rgb(245, 245, 245); // #f5f5f5
    pub const BG_HOVER: Color = Color::Rgb(235, 235, 235); // #ebebeb
    pub const BG_ACTIVE: Color = Color::Rgb(225, 225, 225); // #e1e1e1

    // Text colors
    pub const FG: Color = Color::Rgb(26, 26, 26); // #1a1a1a
    pub const FG_MUTED: Color = Color::Rgb(92, 92, 100); // #5c5c64
    pub const FG_DIM: Color = Color::Rgb(118, 118, 126); // #76767e
    /// Dimmed chrome for collapsed tool headers (Wave 2 renders use this).
    pub const MACHINERY: Color = FG_MUTED;
    /// Dim suffix text (counts, separators, metadata tails).
    pub const DETAIL: Color = FG_DIM;
    /// Dark green for action markers and meta suffixes on light canvases.
    pub const META: Color = Color::Rgb(47, 125, 79); // #2f7d4f

    // Primary/Brand
    pub const PRIMARY: Color = Color::Rgb(59, 125, 216); // #3b7dd8 (blue)
    pub const SECONDARY: Color = Color::Rgb(123, 91, 182); // #7b5bb6 (purple)
    pub const ACCENT: Color = Color::Rgb(214, 140, 39); // #d68c27 (orange)

    // Semantic colors
    pub const SUCCESS: Color = Color::Rgb(61, 154, 87); // #3d9a57
    pub const WARNING: Color = Color::Rgb(214, 140, 39); // #d68c27
    pub const ERROR: Color = Color::Rgb(209, 56, 61); // #d1383d
    pub const INFO: Color = Color::Rgb(49, 135, 149); // #318795

    // Borders
    pub const BORDER: Color = Color::Rgb(184, 184, 184); // #b8b8b8
    pub const BORDER_SUBTLE: Color = Color::Rgb(212, 212, 212); // #d4d4d4
    pub const BORDER_ACTIVE: Color = Color::Rgb(160, 160, 160); // #a0a0a0
    /// Barely-visible full-width rule under popup headers, between SUBTLE and BORDER.
    pub const BORDER_RULE: Color = Color::Rgb(226, 226, 230); // #e2e2e6

    // Diff colors
    pub const DIFF_ADDED: Color = Color::Rgb(30, 114, 92); // #1e725c
    pub const DIFF_REMOVED: Color = Color::Rgb(197, 59, 83); // #c53b53
    pub const DIFF_ADDED_BG: Color = Color::Rgb(213, 229, 213); // #d5e5d5
    pub const DIFF_REMOVED_BG: Color = Color::Rgb(247, 216, 219); // #f7d8db

    // On white the ramp runs the other way: the faint tiles are a pale tint and
    // the brightest ones are the saturated brand orange.
    pub const TILE_ACCENT: Color = Color::Rgb(248, 216, 194); // #f8d8c2
    pub const TILE_HI: Color = Color::Rgb(231, 109, 31); // #e76d1f
    pub const TILE_ALPHA: f32 = 0.5;

    // Markdown colors
    pub const MD_HEADING: Color = Color::Rgb(214, 140, 39);
    pub const MD_LINK: Color = Color::Rgb(59, 125, 216);
    pub const MD_CODE: Color = Color::Rgb(61, 154, 87);
    pub const MD_EMPH: Color = Color::Rgb(176, 133, 31);
    pub const MD_STRONG: Color = Color::Rgb(214, 140, 39);
    pub const MD_QUOTE: Color = Color::Rgb(112, 134, 181);

    // Syntax colors
    pub const SYNTAX_COMMENT: Color = Color::Rgb(138, 138, 138);
    pub const SYNTAX_KEYWORD: Color = Color::Rgb(123, 91, 182);
    pub const SYNTAX_FUNCTION: Color = Color::Rgb(59, 125, 216);
    pub const SYNTAX_VARIABLE: Color = Color::Rgb(209, 56, 61);
    pub const SYNTAX_STRING: Color = Color::Rgb(61, 154, 87);
    pub const SYNTAX_NUMBER: Color = Color::Rgb(214, 140, 39);
    pub const SYNTAX_TYPE: Color = Color::Rgb(176, 133, 31);
    pub const SYNTAX_OPERATOR: Color = Color::Rgb(49, 135, 149);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DYNAMIC COLOR ACCESSORS - switch between dark/light at runtime
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

macro_rules! theme_color {
    ($name:ident) => {
        #[allow(non_snake_case)]
        pub fn $name() -> Color {
            match current_theme() {
                Theme::Light => light::$name,
                Theme::Dark => dark::$name,
            }
        }
    };
}

theme_color!(BG);
theme_color!(BG_PANEL);
theme_color!(BG_ELEMENT);
theme_color!(BG_HOVER);
theme_color!(BG_ACTIVE);
theme_color!(FG);
theme_color!(FG_MUTED);
theme_color!(FG_DIM);
theme_color!(PRIMARY);
theme_color!(SECONDARY);
theme_color!(ACCENT);
theme_color!(SUCCESS);
theme_color!(WARNING);
theme_color!(ERROR);
theme_color!(INFO);
theme_color!(BORDER);
theme_color!(BORDER_SUBTLE);
theme_color!(BORDER_ACTIVE);
theme_color!(BORDER_RULE);
theme_color!(MACHINERY);
theme_color!(DETAIL);
theme_color!(META);
theme_color!(DIFF_ADDED);
theme_color!(DIFF_REMOVED);
theme_color!(DIFF_ADDED_BG);
theme_color!(DIFF_REMOVED_BG);
theme_color!(TILE_ACCENT);
theme_color!(TILE_HI);

/// Overall strength of the hero's tile field. The mosaic is a background, so
/// even its brightest squares stay a blend toward the canvas.
#[allow(non_snake_case)]
pub fn TILE_ALPHA() -> f32 {
    match current_theme() {
        Theme::Light => light::TILE_ALPHA,
        Theme::Dark => dark::TILE_ALPHA,
    }
}
theme_color!(MD_HEADING);
theme_color!(MD_LINK);
theme_color!(MD_CODE);
theme_color!(MD_EMPH);
theme_color!(MD_STRONG);
theme_color!(MD_QUOTE);
theme_color!(SYNTAX_COMMENT);
theme_color!(SYNTAX_KEYWORD);
theme_color!(SYNTAX_FUNCTION);
theme_color!(SYNTAX_VARIABLE);
theme_color!(SYNTAX_STRING);
theme_color!(SYNTAX_NUMBER);
theme_color!(SYNTAX_TYPE);
theme_color!(SYNTAX_OPERATOR);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STYLES - semantic, composable
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Primary text style
pub fn text() -> Style {
    Style::default().fg(FG())
}

/// Muted/subdued text
pub fn muted() -> Style {
    Style::default().fg(FG_MUTED())
}

/// Dim text (even more subdued)
pub fn dim() -> Style {
    Style::default().fg(FG_DIM())
}

/// Bold primary text
pub fn bold() -> Style {
    Style::default().fg(FG()).add_modifier(Modifier::BOLD)
}

/// Accent/primary colored text
pub fn accent() -> Style {
    Style::default().fg(PRIMARY())
}

/// Success colored text
pub fn success() -> Style {
    Style::default().fg(SUCCESS())
}

/// Action-marker / meta-suffix green.
pub fn meta() -> Style {
    Style::default().fg(META())
}

/// Dim brackets around a meta value.
pub fn meta_bracket() -> Style {
    Style::default().fg(META()).add_modifier(Modifier::DIM)
}

/// Warning colored text
pub fn warning() -> Style {
    Style::default().fg(WARNING())
}

/// Error colored text
pub fn error() -> Style {
    Style::default().fg(ERROR()).add_modifier(Modifier::BOLD)
}

/// Info colored text
pub fn info() -> Style {
    Style::default().fg(INFO())
}

// Mode-specific styles
pub fn mode_plan() -> Style {
    warning()
}
pub fn mode_build() -> Style {
    success()
}

/// Accent color for an agent mode: plan = amber, build = green.
///
/// The composer border deliberately uses its own accent (PRIMARY for build)
/// and does not route through here.
pub fn mode_accent_color(is_plan: bool) -> Color {
    if is_plan {
        WARNING()
    } else {
        SUCCESS()
    }
}

// Input styles
pub fn input_prompt() -> Style {
    accent()
}
pub fn input_text() -> Style {
    text()
}
pub fn input_cursor() -> Style {
    Style::default().fg(PRIMARY())
}

/// Background lift for a hovered card on the bare canvas. The full
/// `BG_HOVER` step: the old half-step tint was invisible on a black canvas.
pub fn hover_tint() -> Color {
    BG_HOVER()
}

// Panel/element styles (background)
pub fn panel() -> Style {
    Style::default().bg(BG_PANEL())
}

// Selection styles
pub fn selected() -> Style {
    Style::default()
        .bg(BG_ACTIVE())
        .fg(FG())
        .add_modifier(Modifier::BOLD)
}

pub fn highlight() -> Style {
    Style::default().bg(BG_ELEMENT()).fg(ACCENT())
}

// Border styles
pub fn border() -> Style {
    Style::default().fg(BORDER())
}
pub fn border_subtle() -> Style {
    Style::default().fg(BORDER_SUBTLE())
}
pub fn border_active() -> Style {
    Style::default().fg(BORDER_ACTIVE())
}

// File status styles were removed: every caller styled file rows through the
// semantic `success()` / `warning()` / `error()` accessors directly.

// Thinking/reasoning style
pub fn thinking() -> Style {
    match current_theme() {
        Theme::Dark => Style::default()
            .fg(MACHINERY())
            .add_modifier(Modifier::ITALIC),
        Theme::Light => Style::default()
            .fg(FG_MUTED())
            .add_modifier(Modifier::ITALIC),
    }
}

/// Transcript step marker (`◆`) color: shared monochrome gray in dark mode,
/// theme secondary in light mode.
/// All transcript steps (thought, tool, subagent, group) share this marker;
/// semantic icons were retired.
pub fn step() -> Style {
    match current_theme() {
        Theme::Dark => Style::default().fg(MACHINERY()),
        Theme::Light => Style::default().fg(SECONDARY()),
    }
}

// Right-aligned message timestamps
pub fn timestamp() -> Style {
    Style::default().fg(FG_DIM())
}

// Bottom hint bar: key bright, action dim
pub fn hint_key() -> Style {
    Style::default().fg(FG_MUTED())
}
pub fn hint_action() -> Style {
    Style::default().fg(FG_DIM())
}

// Button styles
pub fn button_primary() -> Style {
    Style::default()
        .bg(PRIMARY())
        .fg(BG())
        .add_modifier(Modifier::BOLD)
}

pub fn button_secondary() -> Style {
    Style::default().bg(BG_ELEMENT()).fg(FG())
}

pub fn button_danger() -> Style {
    Style::default()
        .bg(ERROR())
        .fg(BG())
        .add_modifier(Modifier::BOLD)
}

// Markdown styles
pub fn md_heading() -> Style {
    Style::default()
        .fg(MD_HEADING())
        .add_modifier(Modifier::BOLD)
}
pub fn md_code() -> Style {
    Style::default().fg(MD_CODE())
}
pub fn md_link() -> Style {
    Style::default().fg(MD_LINK())
}
pub fn md_strong() -> Style {
    Style::default()
        .fg(MD_STRONG())
        .add_modifier(Modifier::BOLD)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UTILITY FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Blend two colors smoothly: `t = 0.0` yields `c1`, `t = 1.0` yields `c2`;
/// values outside `[0.0, 1.0]` are clamped. Per-channel linear interpolation
/// on `Rgb` inputs; non-Rgb colors snap to the nearer endpoint (`t < 0.5`).
pub fn blend_colors(c1: Color, c2: Color, t: f32) -> Color {
    let t = t.clamp(0.0, 1.0);
    match (c1, c2) {
        (Color::Rgb(r1, g1, b1), Color::Rgb(r2, g2, b2)) => {
            let r = (r1 as f32 * (1.0 - t) + r2 as f32 * t).round() as u8;
            let g = (g1 as f32 * (1.0 - t) + g2 as f32 * t).round() as u8;
            let b = (b1 as f32 * (1.0 - t) + b2 as f32 * t).round() as u8;
            Color::Rgb(r, g, b)
        }
        _ => {
            if t < 0.5 {
                c1
            } else {
                c2
            }
        }
    }
}

/// Calculate a breathing/pulsing color using a continuous sine wave.
pub fn breathing_color(base: Color, target: Color, frame: usize, speed: f32) -> Color {
    let angle = (frame as f32) * speed;
    let t = (angle.sin() * 0.5 + 0.5).clamp(0.0, 1.0);
    blend_colors(base, target, t)
}
