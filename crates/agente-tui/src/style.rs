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
// DARK THEME (default) - the desktop's graphite: one ladder of neutral
// surfaces, neutral text, and one orange accent for focus and selection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

pub mod dark {
    use super::*;

    // Background colors — the desktop app's graphite ladder (page #1c1c1c,
    // cards #232323, fills a step lighter), so both surfaces read as one product
    pub const BG: Color = Color::Rgb(28, 28, 28); // #1c1c1c
    pub const BG_PANEL: Color = Color::Rgb(35, 35, 35); // #232323
    pub const BG_ELEMENT: Color = Color::Rgb(43, 43, 43); // #2b2b2b
    /// Pointer hover: one step above the panel, one below the selection.
    pub const BG_HOVER: Color = Color::Rgb(43, 43, 43); // #2b2b2b
    pub const BG_ACTIVE: Color = Color::Rgb(48, 48, 48); // #303030

    // Text colors
    pub const FG: Color = Color::Rgb(255, 255, 255); // #ffffff
    pub const FG_MUTED: Color = Color::Rgb(179, 179, 179); // #b3b3b3
    pub const FG_DIM: Color = Color::Rgb(133, 133, 133); // #858585
    /// Shared monochrome gray for all dim chrome in dark mode.
    pub const MONO_GRAY: Color = Color::Rgb(138, 138, 138); // #8a8a8a
    /// Dimmed chrome for collapsed tool headers (Wave 2 renders use this).
    pub const MACHINERY: Color = MONO_GRAY;
    /// Dim suffix text (counts, separators, metadata tails).
    pub const DETAIL: Color = MONO_GRAY;
    /// Settled action markers and meta suffixes (`◆ Run`, `[412ms]`): grey,
    /// as the desktop's settled step rows are. A pass is the default state,
    /// so it stays dim; colour is for what needs the eye.
    pub const META: Color = Color::Rgb(138, 138, 138); // #8a8a8a

    // Primary/Brand — the desktop's single orange accent (--brand-accent);
    // subheadings are neutral, not a second hue
    pub const PRIMARY: Color = Color::Rgb(232, 121, 58); // #e8793a
    pub const SECONDARY: Color = Color::Rgb(200, 200, 200); // #c8c8c8
    pub const ACCENT: Color = Color::Rgb(232, 121, 58); // #e8793a

    // Semantic colors
    pub const SUCCESS: Color = Color::Rgb(108, 197, 138); // #6cc58a
    pub const WARNING: Color = Color::Rgb(229, 180, 84); // #e5b454
    pub const ERROR: Color = Color::Rgb(240, 123, 114); // #f07b72
    pub const INFO: Color = Color::Rgb(75, 180, 214); // #4bb4d6

    // Borders - quiet, barely-there
    pub const BORDER: Color = Color::Rgb(46, 46, 46); // #2e2e2e
    pub const BORDER_SUBTLE: Color = Color::Rgb(41, 41, 41); // #292929
    pub const BORDER_ACTIVE: Color = Color::Rgb(60, 60, 60); // #3c3c3c
    /// Barely-visible full-width rule under popup headers, between SUBTLE and BORDER.
    pub const BORDER_RULE: Color = Color::Rgb(43, 43, 43); // #2b2b2b

    // Diff colors
    pub const DIFF_ADDED: Color = Color::Rgb(108, 197, 138); // #6cc58a
    pub const DIFF_REMOVED: Color = Color::Rgb(240, 123, 114); // #f07b72
    pub const DIFF_ADDED_BG: Color = Color::Rgb(41, 55, 46); // #29372e
    pub const DIFF_REMOVED_BG: Color = Color::Rgb(62, 43, 42); // #3e2b2a

    // Hero tile field — the landing page's mosaic, one brand orange at
    // shifting intensity. Dim end first, highlight last.
    pub const TILE_ACCENT: Color = Color::Rgb(232, 121, 58); // #e8793a
    pub const TILE_HI: Color = Color::Rgb(255, 190, 152); // #ffbe98
    pub const TILE_ALPHA: f32 = 0.4;

    // Markdown colors — headings and bold at full foreground (landmarks by
    // weight, as on desktop), links in the desktop's companion blue
    pub const MD_HEADING: Color = Color::Rgb(255, 255, 255); // #ffffff
    pub const MD_LINK: Color = Color::Rgb(155, 217, 236); // #9bd9ec
    pub const MD_CODE: Color = Color::Rgb(230, 230, 230); // #e6e6e6
    pub const MD_EMPH: Color = Color::Rgb(220, 220, 220); // #dcdcdc
    pub const MD_STRONG: Color = Color::Rgb(255, 255, 255); // #ffffff
    pub const MD_QUOTE: Color = Color::Rgb(200, 200, 200); // #c8c8c8

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
    pub const BG_HOVER: Color = Color::Rgb(240, 240, 240); // #f0f0f0
    pub const BG_ACTIVE: Color = Color::Rgb(232, 232, 232); // #e8e8e8

    // Text colors
    pub const FG: Color = Color::Rgb(17, 17, 17); // #111111
    pub const FG_MUTED: Color = Color::Rgb(82, 82, 82); // #525252
    pub const FG_DIM: Color = Color::Rgb(115, 115, 115); // #737373
    /// Dimmed chrome for collapsed tool headers (Wave 2 renders use this).
    pub const MACHINERY: Color = FG_MUTED;
    /// Dim suffix text (counts, separators, metadata tails).
    pub const DETAIL: Color = FG_DIM;
    /// Settled action markers and meta suffixes: grey, as in dark mode.
    pub const META: Color = Color::Rgb(115, 115, 115); // #737373

    // Primary/Brand
    pub const PRIMARY: Color = Color::Rgb(231, 109, 31); // #e76d1f
    pub const SECONDARY: Color = Color::Rgb(82, 82, 82); // #525252
    pub const ACCENT: Color = Color::Rgb(231, 109, 31); // #e76d1f

    // Semantic colors
    pub const SUCCESS: Color = Color::Rgb(22, 163, 74); // #16a34a
    pub const WARNING: Color = Color::Rgb(202, 138, 4); // #ca8a04
    pub const ERROR: Color = Color::Rgb(217, 48, 37); // #d93025
    pub const INFO: Color = Color::Rgb(3, 88, 140); // #03588c

    // Borders
    pub const BORDER: Color = Color::Rgb(224, 224, 224); // #e0e0e0
    pub const BORDER_SUBTLE: Color = Color::Rgb(235, 235, 235); // #ebebeb
    pub const BORDER_ACTIVE: Color = Color::Rgb(200, 200, 200); // #c8c8c8
    /// Barely-visible full-width rule under popup headers, between SUBTLE and BORDER.
    pub const BORDER_RULE: Color = Color::Rgb(237, 237, 237); // #ededed

    // Diff colors
    pub const DIFF_ADDED: Color = Color::Rgb(21, 128, 61); // #15803d
    pub const DIFF_REMOVED: Color = Color::Rgb(198, 40, 40); // #c62828
    pub const DIFF_ADDED_BG: Color = Color::Rgb(220, 242, 227); // #dcf2e3
    pub const DIFF_REMOVED_BG: Color = Color::Rgb(251, 227, 225); // #fbe3e1

    // On white the ramp runs the other way: the faint tiles are a pale tint and
    // the brightest ones are the saturated brand orange.
    pub const TILE_ACCENT: Color = Color::Rgb(248, 216, 194); // #f8d8c2
    pub const TILE_HI: Color = Color::Rgb(231, 109, 31); // #e76d1f
    pub const TILE_ALPHA: f32 = 0.5;

    // Markdown colors
    pub const MD_HEADING: Color = Color::Rgb(0, 0, 0); // #000000
    pub const MD_LINK: Color = Color::Rgb(3, 88, 140); // #03588c
    pub const MD_CODE: Color = Color::Rgb(31, 31, 31); // #1f1f1f
    pub const MD_EMPH: Color = Color::Rgb(43, 43, 43); // #2b2b2b
    pub const MD_STRONG: Color = Color::Rgb(0, 0, 0); // #000000
    pub const MD_QUOTE: Color = Color::Rgb(82, 82, 82); // #525252

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
