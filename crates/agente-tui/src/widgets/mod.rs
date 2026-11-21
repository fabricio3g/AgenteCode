pub mod action_bar;
pub mod activity;
pub mod approval;
pub mod chat;
pub mod diff_view;
pub mod hints;
pub mod input;
pub mod markdown;
pub mod modal;
pub mod pick;
pub mod plan_ask;
pub mod plan_review;
pub mod process_view;
pub mod scroll_view;
pub mod scrollbar;
pub mod subagent_detail;
pub mod tabs;
pub mod text;
pub mod text_field;
pub mod tool_meta;
pub mod welcome;

pub use modal::{
    centered_panel, dim_backdrop, footer_hints, modal_card, modal_card_tinted, panel_bg,
    panel_block, panel_footer, panel_header, panel_row, ModalChrome,
};
pub use scroll_view::ScrollState;
pub(crate) use text::{
    char_to_byte, display_width, format_duration_ms, format_elapsed_secs, format_elapsed_secs_f64,
    format_worked_for_ms, is_wide_char, s, sf, short_path, shorten_path, sp, themed_blank_row,
};
pub use text::{fill_row, justify, truncate_cells};
pub(crate) use tool_meta::{tool_icon_for, tool_presentation, FamilyKind, SubjectStyle};

use ratatui::text::Span;

/// Shared braille spinner frames used by chat streaming and the welcome screen.
pub const SPINNER: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Animation tick divisor: work spins at tick/4 (~7.5fps @30fps). All
/// spinners/pulses derive from `anim_frame` so cues never drift apart under load.
pub const SPINNER_DIVISOR: u64 = 4;
/// Waiting-on-you diamond pulse speed: sin²(tick·speed), period π,
/// ≈1.3s per cycle at ~30fps. Shared by approval/drain/plan waits.
pub const WAITING_PULSE_SPEED: f32 = 0.08;

/// Returns the spinner frame for the given animation frame index.
pub fn spinner_frame(frame: u32) -> &'static str {
    SPINNER[frame as usize % SPINNER.len()]
}

/// Working-spinner frame for a raw `anim_frame` tick (applies `SPINNER_DIVISOR`).
pub fn spinner_frame_for_tick(tick: u64) -> &'static str {
    spinner_frame((tick / SPINNER_DIVISOR) as u32)
}

/// Waiting-on-you diamond color: blends `bg → accent` with a sin² pulse
/// floored at 0.3 so the diamond stays visible at the trough.
/// Always route diamond waits through here so call sites never drift.
pub fn waiting_diamond_color(
    bg: ratatui::style::Color,
    accent: ratatui::style::Color,
    tick: u64,
) -> ratatui::style::Color {
    let t = tick as f32 * WAITING_PULSE_SPEED;
    let brightness = t.sin() * t.sin(); // sin², period π
    crate::style::blend_colors(bg, accent, 0.3 + brightness * 0.7)
}

/// One semantic status for every subagent surface (card, popup, detail modal).
/// Single source of truth for glyph and color so the three views never drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatusKind {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl SubagentStatusKind {
    /// Parse the live UI status string (`pending`, `running`, ...).
    pub fn from_status(status: &str) -> Self {
        match status {
            "pending" | "queued" => Self::Queued,
            "completed" | "done" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Running,
        }
    }

    /// Parse the core registry status.
    pub fn from_core(status: agente_core::subagent::SubagentStatus) -> Self {
        use agente_core::subagent::SubagentStatus as Core;
        match status {
            Core::Pending => Self::Queued,
            Core::Running => Self::Running,
            Core::Completed => Self::Completed,
            Core::Failed => Self::Failed,
            Core::Cancelled => Self::Cancelled,
        }
    }

    /// Single-width marker. Subagent card: `✓ Explore  desc ··· completed`,
    /// running on a spinner-ish glyph, queued on an ellipsis.
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Queued => "⋯",
            Self::Running => "⧗",
            Self::Completed => "✓",
            Self::Failed | Self::Cancelled => "✗",
        }
    }

    pub fn color(self) -> ratatui::style::Color {
        match self {
            Self::Queued => crate::style::DETAIL(),
            Self::Running => crate::style::SECONDARY(),
            Self::Completed => crate::style::FG_MUTED(),
            Self::Failed => crate::style::ERROR(),
            Self::Cancelled => crate::style::FG_DIM(),
        }
    }

    /// Edge color for cards about this subagent (detail modal border).
    pub fn border_color(self) -> ratatui::style::Color {
        let tint = match self {
            Self::Running => crate::style::SECONDARY(),
            Self::Completed => crate::style::SUCCESS(),
            Self::Failed => crate::style::ERROR(),
            Self::Queued | Self::Cancelled => crate::style::FG_DIM(),
        };
        crate::style::blend_colors(tint, crate::style::BORDER_RULE(), 0.3)
    }

    /// Word used by the popup and detail header.
    pub fn label(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// True while the child still occupies a concurrency slot or queue slot.
    pub fn is_live(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

/// Sweep a bright band across `text` for a soft shimmer (continuous sine wave).
///
/// Shared by the live thinking header (`widgets::chat`) and the activity-strip
/// `Thinking...` phase label so both animate with the same speed, direction
/// and palette. All glyphs stay single-width; colors route through `style.rs`.
pub(crate) fn shimmer_text(text: &str, frame: usize) -> Vec<Span<'static>> {
    use ratatui::style::{Modifier, Style};
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let speed = 0.35f32;
    let hi = crate::style::PRIMARY();
    let mid = crate::style::SECONDARY();
    let lo = crate::style::FG_DIM();

    chars
        .into_iter()
        .enumerate()
        .map(|(i, ch)| {
            let offset = (i as f32) * 0.6;
            let angle = (frame as f32) * speed - offset;
            let wave = (angle.sin() * 0.5 + 0.5).clamp(0.0, 1.0);
            let fg = if wave > 0.7 {
                crate::style::blend_colors(mid, hi, (wave - 0.7) / 0.3)
            } else {
                crate::style::blend_colors(lo, mid, wave / 0.7)
            };
            let mods = if wave > 0.75 {
                Modifier::BOLD
            } else if wave > 0.4 {
                Modifier::ITALIC
            } else {
                Modifier::empty()
            };
            Span::styled(ch.to_string(), Style::default().fg(fg).add_modifier(mods))
        })
        .collect()
}
