//! Scroll management for the main transcript and scrollable modals.

use ratatui::layout::Rect;

use super::UiState;
use crate::state::LiveToolCall;
use crate::widgets::ScrollState;

/// The live output view of one tool call (click a running tool row).
#[derive(Debug, Clone)]
pub struct ProcessView {
    /// Provider call id of the tool being watched.
    pub call_id: String,
    /// The call as it ended, kept so the view survives completion.
    pub finished: Option<LiveToolCall>,
    /// Unified vertical scroll + follow state.
    pub scroll: ScrollState,
    /// Body rect from the last paint (wheel hit-testing).
    pub area: Option<Rect>,
}

impl ProcessView {
    pub fn open(call_id: String) -> Self {
        Self {
            call_id,
            finished: None,
            scroll: ScrollState::new(true),
            area: None,
        }
    }

    pub fn scroll_by(&mut self, delta: isize) {
        self.scroll.scroll_by_tail(delta);
    }
}

impl UiState {
    pub fn scroll_diff_peek(&mut self, delta: isize) {
        self.diff_peek_scroll.scroll_by(delta);
    }

    pub fn scroll_subagent_detail(&mut self, delta: i32) {
        self.subagent_detail_scroll.scroll_by(delta as isize);
        self.needs_render = true;
    }

    /// Scroll the help overlay, keeping the last page reachable.
    pub fn scroll_help(&mut self, delta: i32) {
        self.help_scroll.total = crate::help::shortcut_count();
        self.help_scroll.visible = self.help_scroll.visible.max(1);
        self.help_scroll.scroll_by(delta as isize);
        self.needs_render = true;
    }

    /// Scroll chat up by amount (immediate)
    pub fn scroll_up(&mut self, amount: usize) {
        self.scroll_target = None;
        self.chat_auto_scroll = false;
        let max = self.max_scroll();
        self.chat_scroll = self.chat_scroll.saturating_sub(amount).min(max);
    }

    /// Scroll chat down by amount (immediate)
    pub fn scroll_down(&mut self, amount: usize) {
        self.scroll_target = None;
        let max = self.max_scroll();
        self.chat_scroll = self.chat_scroll.saturating_add(amount).min(max);
        if self.chat_scroll >= max {
            self.chat_auto_scroll = true;
        }
    }

    /// Scroll to bottom of chat
    pub fn scroll_to_bottom(&mut self) {
        self.scroll_target = None;
        self.chat_auto_scroll = true;
        self.chat_scroll = self.max_scroll();
    }

    /// Scroll to the first line of the chat.
    pub fn scroll_to_top(&mut self) {
        self.scroll_target = None;
        self.chat_auto_scroll = false;
        self.chat_scroll = 0;
    }

    /// Glide to the bottom of the transcript, then re-pin.
    pub fn glide_to_bottom(&mut self) {
        if self.reduce_motion {
            self.scroll_to_bottom();
            return;
        }
        self.chat_auto_scroll = false;
        self.scroll_target = Some(usize::MAX);
        self.needs_render = true;
    }

    /// Eased scroll by `delta` rows (negative = up).
    pub fn glide_by(&mut self, delta: isize) {
        let max = self.max_scroll();
        let base = self.scroll_target.map_or(self.chat_scroll, |t| t.min(max));
        let target = base.saturating_add_signed(delta).min(max);
        if delta < 0 {
            self.chat_auto_scroll = false;
        }
        self.scroll_target = Some(target);
        if self.reduce_motion {
            self.chat_scroll = target;
        }
        self.step_scroll();
    }

    /// Advance an eased scroll by one frame: cover 45% of the remaining
    /// distance (at least one row). Returns `true` while moving.
    pub fn step_scroll(&mut self) -> bool {
        let Some(target) = self.scroll_target else {
            return false;
        };
        let max = self.max_scroll();
        let target = target.min(max);
        let dist = target.abs_diff(self.chat_scroll);
        let step = ((dist as f32 * 0.45).ceil() as usize).min(dist);
        if target > self.chat_scroll {
            self.chat_scroll += step;
        } else {
            self.chat_scroll -= step;
        }
        if self.chat_scroll != target {
            return true;
        }
        self.scroll_target = None;
        if target >= max {
            self.chat_auto_scroll = true;
        }
        false
    }

    /// True when the jump-to-bottom control should be shown.
    pub fn show_jump_to_bottom(&self) -> bool {
        !self.chat_auto_scroll && self.max_scroll() > 0
    }

    /// Get maximum scroll position
    pub fn max_scroll(&self) -> usize {
        self.chat_content_height
            .saturating_sub(self.chat_visible_height)
    }

    /// Set chat content and visible dimensions
    #[cfg(test)]
    pub fn set_chat_dimensions(&mut self, content_height: usize, visible_height: usize) {
        self.chat_content_height = content_height;
        self.chat_visible_height = visible_height;
        if self.chat_auto_scroll {
            self.chat_scroll = self.max_scroll();
        } else {
            self.chat_scroll = self.chat_scroll.min(self.max_scroll());
        }
    }
}

#[cfg(test)]
mod scroll_follow_tests {
    use super::*;

    #[test]
    fn scrolling_works_past_the_old_u16_ceiling() {
        let tall = 200_000usize;
        let mut ui = UiState {
            chat_visible_height: 20,
            chat_auto_scroll: true,
            ..UiState::default()
        };
        ui.set_chat_dimensions(tall, 20);

        assert_eq!(ui.max_scroll(), tall - 20);
        assert_eq!(
            ui.chat_scroll,
            tall - 20,
            "auto-scroll must reach the real bottom, not a u16-clamped one"
        );

        ui.scroll_up(100);
        assert_eq!(ui.chat_scroll, tall - 120);
        assert!(!ui.chat_auto_scroll);

        ui.scroll_to_bottom();
        assert_eq!(ui.chat_scroll, tall - 20);
    }

    #[test]
    fn glide_eases_out_and_repins_at_the_bottom() {
        let mut ui = UiState {
            chat_content_height: 120,
            chat_visible_height: 20,
            chat_scroll: 100,
            ..UiState::default()
        };
        ui.glide_by(-20);
        assert!(!ui.chat_auto_scroll);
        assert_eq!(ui.chat_scroll, 91, "first frame moves immediately");
        let mut frames = 1;
        while ui.step_scroll() {
            frames += 1;
        }
        assert_eq!(ui.chat_scroll, 80);
        assert!(
            (3..=8).contains(&frames),
            "eased over a few frames: {frames}"
        );
        assert!(!ui.has_active_animation());

        ui.glide_by(10);
        ui.glide_by(10);
        while ui.step_scroll() {}
        assert_eq!(ui.chat_scroll, 100);
        assert!(ui.chat_auto_scroll, "arriving at the bottom re-pins");
    }

    #[test]
    fn reduce_motion_snaps_glides() {
        let mut ui = UiState {
            chat_content_height: 120,
            chat_visible_height: 20,
            chat_scroll: 100,
            reduce_motion: true,
            ..UiState::default()
        };
        ui.glide_by(-30);
        assert_eq!(ui.chat_scroll, 70);
        assert!(!ui.has_active_animation());
    }

    #[test]
    fn growing_content_while_unpinned_keeps_scroll_top_anchored() {
        let mut ui = UiState {
            chat_content_height: 50,
            chat_visible_height: 20,
            chat_scroll: 5,
            chat_auto_scroll: false,
            ..UiState::default()
        };
        ui.set_chat_dimensions(80, 20);
        assert!(!ui.chat_auto_scroll);
        assert_eq!(ui.chat_scroll, 5);
    }
}
