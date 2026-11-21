//! Drag selection, coordinate mapping, and click-region hit-testing in chat.

use agente_core::types::{ClickKind, ClickRegion};
use ratatui::layout::Rect;

use super::UiState;

/// In-progress drag selection in chat content coordinates.
#[derive(Debug, Clone, Copy)]
pub struct ChatSelection {
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
}

/// Click regions that react to hover: cards whose click does something
/// visible (fold, expand, open). Plain assistant prose and thinking headers
/// stay quiet — tinting every paragraph under the pointer is just noise.
pub fn is_hover_target(region: &ClickRegion) -> bool {
    match region.kind {
        ClickKind::Tool | ClickKind::ToolGroup | ClickKind::Subagent | ClickKind::OpenAsset => {
            !region.is_reasoning
        }
        // Your own messages open the message actions, and running tools open
        // their live output: both hover.
        ClickKind::Prompt | ClickKind::LiveTool => true,
        ClickKind::Message => region.user_truncated,
        ClickKind::Thinking => false,
    }
}

fn ordered_selection(sel: ChatSelection) -> (usize, usize, usize, usize) {
    if (sel.start_line, sel.start_col) <= (sel.end_line, sel.end_col) {
        (sel.start_line, sel.start_col, sel.end_line, sel.end_col)
    } else {
        (sel.end_line, sel.end_col, sel.start_line, sel.start_col)
    }
}

impl UiState {
    /// True when the last known pointer position lies inside `rect`.
    pub fn pointer_in(&self, rect: Rect) -> bool {
        self.mouse_pos
            .is_some_and(|(x, y)| rect.contains(ratatui::layout::Position::new(x, y)))
    }

    /// Update clickable regions
    pub fn update_click_regions(&mut self, regions: Vec<ClickRegion>) {
        self.click_regions = regions;
    }

    /// Find click region at screen Y position.
    /// Prefer Thinking over Tool over Message when rows would otherwise collide.
    pub fn find_click_region(&self, y: u16) -> Option<&ClickRegion> {
        let matches: Vec<&ClickRegion> = self
            .click_regions
            .iter()
            .filter(|region| y >= region.y_start && y <= region.y_end)
            .collect();
        if matches.is_empty() {
            return None;
        }
        matches.into_iter().min_by_key(|r| match r.kind {
            ClickKind::OpenAsset => 0u8,
            ClickKind::Thinking => 0u8,
            ClickKind::Subagent => 0u8,
            ClickKind::Tool | ClickKind::ToolGroup => 1,
            ClickKind::LiveTool => 1,
            ClickKind::Message | ClickKind::Prompt => 2,
        })
    }

    /// Map screen coordinates to content line/col
    pub fn screen_to_content(&self, x: u16, y: u16) -> Option<(usize, usize)> {
        if y < self.chat_area_y {
            return None;
        }
        let row = y.saturating_sub(self.chat_area_y) as usize;
        if row >= self.chat_visible_height {
            return None;
        }
        let line = self.chat_scroll + row;
        if line >= self.chat_plain_lines.len() {
            return None;
        }
        let col = x.saturating_sub(self.chat_area_x) as usize;
        Some((line, col))
    }

    /// Extract selected text for the clipboard.
    pub fn selected_text(&self, entries: &[agente_core::types::ChatEntry]) -> Option<String> {
        let sel = self.selection?;
        let (sl, sc, el, ec) = ordered_selection(sel);
        if sl >= self.chat_plain_lines.len() {
            return None;
        }
        let el = el.min(self.chat_plain_lines.len().saturating_sub(1));

        let mut out = String::new();
        let mut idx = sl;
        while idx <= el {
            match self.chat_plain_lines[idx].entry_id {
                Some(id) => {
                    let mut end = idx;
                    while end < el && self.chat_plain_lines[end + 1].entry_id == Some(id) {
                        end += 1;
                    }
                    let row_width = self.chat_plain_lines[end].plain.chars().count();
                    let fully_covered = match (idx == sl, end == el) {
                        (true, true) => sc == 0 && ec >= row_width,
                        (true, false) => sc == 0,
                        (false, true) => ec >= row_width,
                        (false, false) => true,
                    };
                    let mut emitted = false;
                    if fully_covered {
                        if let Some(entry) = entries.iter().find(|e| e.id == id) {
                            if !entry.content.trim().is_empty() {
                                out.push_str(&entry.content);
                                emitted = true;
                            }
                        }
                    }
                    if !emitted {
                        let text = self.cleaned_screen_text(idx, end, sc, ec);
                        if !text.is_empty() {
                            out.push_str(&text);
                        }
                    }
                    idx = end + 1;
                }
                None => {
                    let text = self.cleaned_screen_text(idx, idx, sc, ec);
                    if !text.is_empty() {
                        out.push_str(&text);
                    }
                    idx += 1;
                }
            }
            if idx <= el {
                out.push('\n');
            }
        }
        let trimmed = out.trim_matches('\n');
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    /// Screen text for rows [first..=last] with the selection's column bounds
    /// applied on the edge rows, then cleaned.
    pub(super) fn cleaned_screen_text(
        &self,
        first: usize,
        last: usize,
        sc: usize,
        ec: usize,
    ) -> String {
        let mut lines: Vec<String> = Vec::new();
        for (i, row) in self
            .chat_plain_lines
            .iter()
            .enumerate()
            .take(last + 1)
            .skip(first)
        {
            let line = &row.plain;
            let chars: Vec<char> = line.chars().collect();
            let a = if i == first { sc.min(chars.len()) } else { 0 };
            let b = if i == last {
                ec.min(chars.len()).max(a)
            } else {
                chars.len()
            };
            lines.push(chars[a..b].iter().collect());
        }
        while lines.first().is_some_and(|l| l.trim().is_empty()) {
            lines.remove(0);
        }
        while lines.last().is_some_and(|l| l.trim().is_empty()) {
            lines.pop();
        }
        let indent = lines
            .iter()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.chars().take_while(|c| c.is_whitespace()).count())
            .min()
            .unwrap_or(0);
        lines
            .iter()
            .map(|l| l.trim_end().chars().skip(indent).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Whether a content cell is inside the active selection
    pub fn cell_selected(&self, line: usize, col: usize) -> bool {
        let Some(sel) = self.selection else {
            return false;
        };
        let (sl, sc, el, ec) = ordered_selection(sel);
        if line < sl || line > el {
            return false;
        }
        if sl == el {
            return col >= sc && col < ec;
        }
        if line == sl {
            return col >= sc;
        }
        if line == el {
            return col < ec;
        }
        true
    }
}
