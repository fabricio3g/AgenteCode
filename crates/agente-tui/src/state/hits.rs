//! Per-frame hit map: widgets register what they painted where, the mouse
//! router asks what sits under the pointer.
//!
//! Registration happens during paint, and most widgets only see `&AppState`,
//! so the map uses interior mutability. It is rebuilt every frame (see
//! [`HitMap::begin_frame`]); mouse events resolve against the last painted
//! frame, which is exactly what the user sees.

use std::cell::RefCell;
use std::collections::HashMap;

use agente_core::types::ApprovalAction;
use ratatui::layout::{Position, Rect};

/// Which selectable list a row belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ListId {
    CommandPalette,
    Subagents,
    SlashPicker,
    AtPicker,
    ModelSelector,
    ThinkingSelector,
    SessionList,
    FolderBrowser,
    Connect,
    Welcome,
}

/// Something interactive the pointer can land on.
#[derive(Debug, Clone, PartialEq)]
pub enum HitTarget {
    /// Row `index` (logical, not visual) of a selectable list.
    Row { list: ListId, index: usize },
    /// An approval dialog action button.
    Approval(ApprovalAction),
    /// A tab of the subagent detail modal.
    DetailTab(super::SubagentDetailTab),
}

#[derive(Debug, Default)]
pub struct HitMap {
    regions: RefCell<Vec<(Rect, HitTarget)>>,
    /// Scroll offsets of windowed lists, kept across frames so moving the
    /// selection inside the visible window never shifts the window itself.
    offsets: RefCell<HashMap<ListId, usize>>,
}

impl HitMap {
    /// Forget last frame's regions. Called once at the top of every paint.
    pub fn begin_frame(&self) {
        self.regions.borrow_mut().clear();
    }

    pub fn push(&self, rect: Rect, target: HitTarget) {
        if rect.width > 0 && rect.height > 0 {
            self.regions.borrow_mut().push((rect, target));
        }
    }

    /// Topmost target at `(x, y)`: later registrations paint over earlier ones.
    pub fn at(&self, x: u16, y: u16) -> Option<HitTarget> {
        self.regions
            .borrow()
            .iter()
            .rev()
            .find(|(rect, _)| rect.contains(Position::new(x, y)))
            .map(|(_, target)| target.clone())
    }

    /// First visible row of a `len`-row list showing `visible` rows with
    /// `selected` kept in view. Scrolls only when the selection leaves the
    /// window (like `ListState`), so hovering rows never moves the list.
    pub fn window_start(&self, list: ListId, len: usize, selected: usize, visible: usize) -> usize {
        let visible = visible.max(1);
        let mut offsets = self.offsets.borrow_mut();
        let offset = offsets.entry(list).or_insert(0);
        if selected < *offset {
            *offset = selected;
        } else if selected >= *offset + visible {
            *offset = selected + 1 - visible;
        }
        *offset = (*offset).min(len.saturating_sub(visible));
        *offset
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_registrations_win() {
        let map = HitMap::default();
        let row = HitTarget::Row {
            list: ListId::CommandPalette,
            index: 1,
        };
        map.push(
            Rect::new(0, 0, 10, 10),
            HitTarget::Approval(ApprovalAction::Deny),
        );
        map.push(Rect::new(2, 2, 4, 1), row.clone());
        assert_eq!(map.at(3, 2), Some(row));
        assert_eq!(
            map.at(0, 0),
            Some(HitTarget::Approval(ApprovalAction::Deny))
        );
        assert_eq!(map.at(10, 0), None);
        map.begin_frame();
        assert_eq!(map.at(3, 2), None);
    }

    #[test]
    fn window_holds_still_while_selection_stays_visible() {
        let map = HitMap::default();
        let list = ListId::ModelSelector;
        assert_eq!(map.window_start(list, 20, 9, 5), 5);
        // Moving up inside the window keeps it put.
        assert_eq!(map.window_start(list, 20, 6, 5), 5);
        assert_eq!(map.window_start(list, 20, 4, 5), 4);
        // Shrinking the list clamps the window.
        assert_eq!(map.window_start(list, 3, 2, 5), 0);
    }
}
