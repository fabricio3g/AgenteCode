//! Short, subtle UI transitions.
//!
//! Every animation is a [`Tween`]: a start instant plus a duration, eased
//! out so motion lands softly. Tweens never own frames themselves — the run
//! loop keeps ticking while `UiState::has_active_animation` sees one
//! running, and each paint reads its eased progress. `reduce_motion` skips
//! them entirely (no tween is started).

use std::time::{Duration, Instant};

/// A sent prompt fading into its bubble.
pub const MESSAGE_MS: u64 = 240;
/// A dialog easing in over its backdrop.
pub const MODAL_MS: u64 = 140;
/// A hover band easing in under the pointer.
pub const HOVER_MS: u64 = 110;

#[derive(Debug, Clone, Copy)]
pub struct Tween {
    started: Instant,
    duration: Duration,
}

impl Tween {
    pub fn start(ms: u64) -> Self {
        Self {
            started: Instant::now(),
            duration: Duration::from_millis(ms),
        }
    }

    /// Eased progress in `0.0..1.0` while running; `None` once finished.
    pub fn progress(&self) -> Option<f32> {
        let t = self.started.elapsed().as_secs_f32() / self.duration.as_secs_f32();
        (t < 1.0).then(|| ease_out(t.max(0.0)))
    }

    pub fn running(&self) -> bool {
        self.progress().is_some()
    }
}

/// Cubic ease-out: quick start, gentle landing.
pub fn ease_out(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

/// Blend every cell of `area` toward `target` by `amount` (0 = untouched).
/// The single fade primitive shared by message, modal and hover transitions.
pub fn fade_toward(
    buf: &mut ratatui::buffer::Buffer,
    area: ratatui::layout::Rect,
    target: ratatui::style::Color,
    amount: f32,
) {
    if amount <= 0.0 {
        return;
    }
    let canvas_fg = crate::style::FG();
    let canvas_bg = crate::style::BG();
    for y in area.top()..area.bottom() {
        for x in area.left()..area.right() {
            let Some(cell) = buf.cell_mut((x, y)) else {
                continue;
            };
            let fg = match cell.fg {
                ratatui::style::Color::Reset => canvas_fg,
                c => c,
            };
            let bg = match cell.bg {
                ratatui::style::Color::Reset => canvas_bg,
                c => c,
            };
            cell.set_fg(crate::style::blend_colors(fg, target, amount));
            cell.set_bg(crate::style::blend_colors(bg, target, amount));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ease_out_lands_softly() {
        assert_eq!(ease_out(0.0), 0.0);
        assert_eq!(ease_out(1.0), 1.0);
        assert!(ease_out(0.5) > 0.8, "most of the motion happens early");
    }

    #[test]
    fn finished_tweens_report_none() {
        let tween = Tween::start(0);
        assert!(tween.progress().is_none());
        assert!(Tween::start(60_000).running());
    }
}
