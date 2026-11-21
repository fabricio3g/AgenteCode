//! Unified vertical scroll state + clamping/follow logic shared by scrollable
//! overlays (`Help`, `Doctor`, `ProcessView`, `SubagentDetail`, `DiffPeek`,
//! `PlanReview`, `BoardView`).

use super::scrollbar::{position_label, Viewport};

/// One scroll-position model for every scrollable surface.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScrollState {
    pub offset: usize,
    pub visible: usize,
    pub total: usize,
    pub follow: bool,
}

impl ScrollState {
    pub const fn new(follow: bool) -> Self {
        Self {
            offset: 0,
            visible: 0,
            total: 0,
            follow,
        }
    }

    /// Highest valid scroll offset for the current `(total, visible)` pair.
    pub fn max_offset(&self) -> usize {
        self.total.saturating_sub(self.visible)
    }

    /// Highest valid scroll offset treating zero visible rows as at least one
    /// (matches `PlanReviewState::max_scroll`).
    pub fn max_offset_nonempty(&self) -> usize {
        self.total.saturating_sub(self.visible.max(1))
    }

    /// Update viewport bounds from the latest render, clamping `offset` (or
    /// pinning to the bottom when `follow` is active), and return the clamped
    /// offset.
    pub fn sync(&mut self, total: usize, visible: usize) -> usize {
        self.total = total;
        self.visible = visible;
        let max = self.max_offset();
        if self.follow {
            self.offset = max;
        } else {
            self.offset = self.offset.min(max);
        }
        self.offset
    }

    /// Move by `delta` lines (negative = up), disabling `follow`.
    pub fn scroll_by(&mut self, delta: isize) {
        self.follow = false;
        let max = self.max_offset();
        self.offset = self.offset.saturating_add_signed(delta).min(max);
    }

    /// Move by `delta` lines, re-enabling `follow` if the scroll lands at the
    /// bottom (used by live-tailing views such as `ProcessView`).
    pub fn scroll_by_tail(&mut self, delta: isize) {
        self.scroll_by(delta);
        if self.offset >= self.max_offset() {
            self.follow = true;
        }
    }

    /// Jump to an absolute offset (clamped), disabling `follow`.
    pub fn scroll_to(&mut self, offset: usize) {
        self.follow = false;
        self.offset = offset.min(self.max_offset());
    }

    /// Jump to the top and disable `follow`.
    pub fn scroll_to_top(&mut self) {
        self.follow = false;
        self.offset = 0;
    }

    /// Jump to the bottom and optionally enable `follow`.
    pub fn scroll_to_bottom(&mut self, follow: bool) {
        self.follow = follow;
        self.offset = self.max_offset();
    }

    /// Reset to top with the given `follow` flag and cleared bounds.
    pub fn reset(&mut self, follow: bool) {
        *self = Self::new(follow);
    }

    pub fn is_scrollable(&self) -> bool {
        self.max_offset() > 0
    }

    pub fn viewport(&self) -> Viewport {
        Viewport {
            offset: self.offset,
            visible: self.visible,
            total: self.total,
        }
    }

    pub fn position_label(&self) -> Option<String> {
        position_label(self.offset, self.visible, self.total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_clamps_and_follows_bottom() {
        let mut s = ScrollState::new(true);
        assert_eq!(s.sync(100, 20), 80);
        assert_eq!(s.offset, 80);

        s.scroll_by(-10);
        assert!(!s.follow);
        assert_eq!(s.offset, 70);

        // Growing content stays put once follow is off.
        assert_eq!(s.sync(140, 20), 70);

        // Shrinking content clamps.
        assert_eq!(s.sync(50, 20), 30);
    }

    #[test]
    fn tail_scroll_re_enables_follow_at_bottom() {
        let mut s = ScrollState::new(true);
        s.sync(50, 10);
        s.scroll_by_tail(-5);
        assert!(!s.follow);
        assert_eq!(s.offset, 35);
        s.scroll_by_tail(10);
        assert!(s.follow);
        assert_eq!(s.offset, 40);
    }
}
