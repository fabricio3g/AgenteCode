//! Mouse and click handling: hover, expand/collapse, copy, drag-select.

use agente_core::types::ClickKind;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::{Position, Rect};

use super::App;
use crate::state::{modal_owner, ChatSelection, ConnectScreen, HitTarget, ListId, ModalOwner};
use crate::widgets::scrollbar::{ScrollSurface, ScrollbarGeom};
use crate::widgets::welcome;

/// Sentinel for live thinking panel (must match widgets/chat.rs).
const LIVE_THINKING_ID: uuid::Uuid = uuid::Uuid::nil();
/// Drag threshold in cells before a click becomes a selection.
const DRAG_THRESHOLD: u16 = 2;

/// True when `(x, y)` lies inside `rect` (a missing rect never hits).
fn hit(rect: Option<Rect>, x: u16, y: u16) -> bool {
    rect.is_some_and(|r| r.contains(Position::new(x, y)))
}

impl App {
    /// The selectable list that currently owns the keyboard, if any.
    fn active_list(&self) -> Option<ListId> {
        Some(match modal_owner(&self.state) {
            ModalOwner::CommandPalette => ListId::CommandPalette,
            ModalOwner::Subagents => ListId::Subagents,
            ModalOwner::SlashPicker => ListId::SlashPicker,
            ModalOwner::AtPicker => ListId::AtPicker,
            ModalOwner::ModelSelector => ListId::ModelSelector,
            ModalOwner::ThinkingSelector => ListId::ThinkingSelector,
            ModalOwner::SubagentModels => ListId::SubagentModels,
            ModalOwner::Settings => ListId::Settings,
            ModalOwner::Skills => ListId::Skills,
            ModalOwner::Mcp => ListId::Mcp,
            ModalOwner::MessageActions => ListId::MessageActions,
            ModalOwner::SessionPicker if self.state.picker.session_picker_browsing => {
                ListId::FolderBrowser
            }
            ModalOwner::SessionPicker => ListId::SessionList,
            ModalOwner::Connect => ListId::Connect,
            ModalOwner::Welcome => ListId::Welcome,
            _ => return None,
        })
    }

    /// The selection index backing `list` (`None` when that list has no
    /// selection right now, e.g. connect is on its key-entry screen).
    fn list_selection_mut(&mut self, list: ListId) -> Option<&mut usize> {
        let input = &mut self.state.input;
        Some(match list {
            ListId::CommandPalette => &mut input.command_palette_selected,
            ListId::Subagents => &mut input.subagents_selected,
            ListId::SlashPicker => &mut input.slash_picker_selected,
            ListId::AtPicker => &mut input.at_picker_selected,
            ListId::ModelSelector => &mut input.model_selector_selected,
            ListId::ThinkingSelector => &mut input.thinking_selector_selected,
            ListId::SubagentModels => &mut input.subagent_models_selected,
            ListId::Settings => &mut input.settings_selected,
            ListId::Skills => &mut input.skills_selected,
            ListId::Mcp => &mut input.mcp_selected,
            ListId::MessageActions => &mut input.message_actions_selected,
            ListId::SessionList => &mut self.state.picker.session_picker_selected,
            ListId::FolderBrowser => &mut self.state.picker.session_picker_browse_selected,
            ListId::Welcome => &mut self.state.ui.welcome_selected,
            ListId::Connect => match &mut self.state.config.connect_screen {
                ConnectScreen::SelectProvider { selected, .. } => selected,
                _ => return None,
            },
        })
    }

    /// Route a wheel scroll to whichever list is open (moving its selection)
    /// instead of scrolling the chat. Returns `false` when no list is open.
    fn picker_scroll(&mut self, delta: i32) -> bool {
        let Some(list) = self.active_list().filter(|l| *l != ListId::Welcome) else {
            return false;
        };
        let Some(selected) = self.list_selection_mut(list) else {
            return false;
        };
        *selected = if delta < 0 {
            selected.saturating_sub(delta.unsigned_abs() as usize)
        } else {
            selected.saturating_add(delta as usize)
        };
        true
    }

    /// Pointer moved onto `hit`: remember it for hover styling, and move a
    /// list's selection onto the hovered row (hover-to-select).
    fn hover_hit(&mut self, hit: Option<HitTarget>) {
        if let Some(HitTarget::Row { list, index }) = hit {
            if self.active_list() == Some(list) {
                if let Some(selected) = self.list_selection_mut(list) {
                    *selected = index;
                }
            }
        }
        self.state.ui.hovered_hit = hit;
    }

    /// Click on a registered target. Rows select then confirm exactly like
    /// Enter, so mouse and keyboard can never disagree about what a row does.
    fn activate_hit(&mut self, hit: HitTarget) -> anyhow::Result<()> {
        match hit {
            HitTarget::Approval(action) => self.handle_approval_action(action)?,
            HitTarget::Tab(index) => self.switch_tab(index),
            HitTarget::TabClose(index) => self.close_tab(index),
            HitTarget::NewTab => self.open_new_tab(),
            HitTarget::DetailTab(tab) => self.state.ui.select_subagent_tab(tab),
            // Scrollbars act on press (see `route_mouse`), not on release.
            HitTarget::Scrollbar(_) => {}
            HitTarget::Row {
                list: ListId::Welcome,
                index,
            } => {
                self.state.ui.welcome_selected = index;
                if let Some(cmd) = welcome::action_at(index) {
                    self.execute_command(cmd)?;
                }
            }
            HitTarget::Row { list, index } => {
                if self.active_list() != Some(list) {
                    return Ok(());
                }
                if let Some(selected) = self.list_selection_mut(list) {
                    *selected = index;
                }
                self.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))?;
            }
        }
        self.state.ui.needs_render = true;
        Ok(())
    }

    /// Everything the pointer position feeds into paint. A move that leaves
    /// this unchanged needs no repaint.
    fn pointer_fingerprint(&self) -> (Option<HitTarget>, Option<uuid::Uuid>, [bool; 2]) {
        let ui = &self.state.ui;
        (
            ui.hovered_hit.clone(),
            ui.hovered_entry_id,
            [
                ui.stop_hitbox.is_some_and(|r| ui.pointer_in(r)),
                ui.jump_bottom_area.is_some_and(|r| ui.pointer_in(r)),
            ],
        )
    }

    /// Wheel-scroll the plan review modal when it is open and the pointer is
    /// over it. The modal replaces the chat list, so the wheel must drive the
    /// plan body instead of the hidden chat.
    fn plan_review_scroll(&mut self, delta: i32, x: u16, y: u16) -> bool {
        if !self.state.plan_review.takes_chat_area() {
            return false;
        }
        let Some(area) = self.state.ui.plan_review_area else {
            return false;
        };
        if !hit(Some(area), x, y) {
            return false;
        }
        self.state
            .plan_review
            .scroll_by(if delta < 0 { -3 } else { 3 });
        true
    }

    /// Wheel-scroll the subagent detail modal body.
    fn subagent_detail_scroll(&mut self, delta: i32, x: u16, y: u16) -> bool {
        if self.state.ui.subagent_detail_id.is_none() {
            return false;
        }
        let Some(area) = self.state.ui.subagent_detail_area else {
            return false;
        };
        if !hit(Some(area), x, y) {
            return false;
        }
        self.state
            .ui
            .scroll_subagent_detail(if delta < 0 { -3 } else { 3 });
        true
    }

    /// Wheel-scroll the live output view (it owns the screen while open).
    fn process_view_scroll(&mut self, delta: i32) -> bool {
        let Some(view) = self.state.ui.process_view.as_mut() else {
            return false;
        };
        view.scroll_by(if delta < 0 { -3 } else { 3 });
        true
    }
}

impl App {
    pub(super) fn handle_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let before = self.pointer_fingerprint();
        let result = self.route_mouse(mouse);
        if self.pointer_fingerprint() != before {
            self.state.ui.needs_render = true;
        }
        result
    }

    fn route_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let (x, y) = (mouse.column, mouse.row);
        let prev_hover = self.state.ui.hovered_entry_id;
        let moved = self.state.ui.mouse_pos != Some((x, y));
        self.state.ui.mouse_pos = Some((x, y));

        // Registered targets (list rows, dialog buttons) sit above every
        // surface: they hover everywhere and win clicks over the chat.
        match mouse.kind {
            MouseEventKind::Moved if moved => {
                let target = self.state.ui.hits.at(x, y);
                self.hover_hit(target);
            }
            // Scrollbars (any surface, modal or not): press jumps and starts
            // a drag, drags scrub, release ends it.
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some(HitTarget::Scrollbar(geom)) = self.state.ui.hits.at(x, y) {
                    self.state.ui.scroll_drag = Some(geom);
                    self.state.ui.mouse_down = None;
                    self.state.ui.drag_selecting = false;
                    self.state.ui.selection = None;
                    self.scroll_surface_to(geom, y);
                    return Ok(());
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(geom) = self.state.ui.scroll_drag {
                    self.scroll_surface_to(geom, y);
                    return Ok(());
                }
            }
            MouseEventKind::Up(MouseButton::Left) if self.state.ui.scroll_drag.is_some() => {
                self.state.ui.scroll_drag = None;
                self.state.ui.needs_render = true;
                return Ok(());
            }
            MouseEventKind::Up(MouseButton::Left)
                if !self.state.ui.drag_selecting && !self.state.ui.suppress_click_on_up =>
            {
                // Resolve at the press position so release jitter can't
                // retarget the click onto a neighbouring row.
                let (px, py) = self.state.ui.mouse_down.unwrap_or((x, y));
                if let Some(target) = self.state.ui.hits.at(px, py) {
                    self.state.ui.mouse_down = None;
                    self.state.ui.selection = None;
                    return self.activate_hit(target);
                }
            }
            _ => {}
        }

        let owner = modal_owner(&self.state);
        if owner.blocks_chat_mouse() {
            // [stop] in the activity strip must ALWAYS be clickable, even when
            // an approval dialog or modal is open.
            if let MouseEventKind::Up(MouseButton::Left) = mouse.kind {
                if hit(self.state.ui.stop_hitbox, x, y) {
                    self.stop_current_operation();
                    return Ok(());
                }
            }

            match mouse.kind {
                MouseEventKind::ScrollUp => {
                    if self.state.ui.show_help {
                        self.state.ui.scroll_help(-1);
                    }
                    let consumed = self.picker_scroll(-1)
                        || self.plan_review_scroll(-1, mouse.column, mouse.row)
                        || self.subagent_detail_scroll(-1, mouse.column, mouse.row)
                        || self.process_view_scroll(-1);
                    if !consumed && owner.wheel_falls_through_to_chat() {
                        // Floating card with no scrollable body (approval,
                        // plan ask, …): the transcript stays visible behind
                        // it, so the wheel keeps scrolling the chat instead
                        // of dying on the overlay.
                        self.state.glide_by(-3);
                    }
                    self.state.ui.needs_render = true;
                }
                MouseEventKind::ScrollDown => {
                    if self.state.ui.show_help {
                        self.state.ui.scroll_help(1);
                    }
                    let consumed = self.picker_scroll(1)
                        || self.plan_review_scroll(1, mouse.column, mouse.row)
                        || self.subagent_detail_scroll(1, mouse.column, mouse.row)
                        || self.process_view_scroll(1);
                    if !consumed && owner.wheel_falls_through_to_chat() {
                        self.state.glide_by(3);
                    }
                    self.state.ui.needs_render = true;
                }
                _ => {}
            }
            return Ok(());
        }

        match mouse.kind {
            MouseEventKind::ScrollUp => {
                if !self.picker_scroll(-1) && !self.plan_review_scroll(-1, mouse.column, mouse.row)
                {
                    self.state.glide_by(-3);
                }
                self.state.ui.needs_render = true;
            }
            MouseEventKind::ScrollDown => {
                if !self.picker_scroll(1) && !self.plan_review_scroll(1, mouse.column, mouse.row) {
                    self.state.glide_by(3);
                }
                self.state.ui.needs_render = true;
            }
            MouseEventKind::Down(MouseButton::Left) => {
                // Jump-to-bottom chip fires on press (not release) so release
                // jitter can never convert it into a drag or a stray toggle.
                // The matching Up is suppressed below.
                if hit(self.state.ui.jump_bottom_area, x, y) {
                    self.state.ui.scroll_to_bottom();
                    self.state.ui.mouse_down = None;
                    self.state.ui.drag_selecting = false;
                    self.state.ui.selection = None;
                    self.state.ui.suppress_click_on_up = true;
                    self.state.ui.needs_render = true;
                    return Ok(());
                }
                {
                    self.state.ui.mouse_down = Some((mouse.column, mouse.row));
                    self.state.ui.drag_selecting = false;
                    self.state.ui.selection = None;
                    if let Some((line, col)) =
                        self.state.ui.screen_to_content(mouse.column, mouse.row)
                    {
                        self.state.ui.selection = Some(ChatSelection {
                            start_line: line,
                            start_col: col,
                            end_line: line,
                            end_col: col,
                        });
                    }
                    self.state.ui.needs_render = true;
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some((ox, oy)) = self.state.ui.mouse_down {
                    let dx = mouse.column.abs_diff(ox);
                    let dy = mouse.row.abs_diff(oy);
                    if dx >= DRAG_THRESHOLD || dy >= DRAG_THRESHOLD {
                        self.state.ui.drag_selecting = true;
                    }
                    if self.state.ui.drag_selecting {
                        if let Some((line, col)) =
                            self.state.ui.screen_to_content(mouse.column, mouse.row)
                        {
                            if let Some(sel) = self.state.ui.selection.as_mut() {
                                sel.end_line = line;
                                sel.end_col = col;
                            } else if let Some((sl, sc)) = self.state.ui.screen_to_content(ox, oy) {
                                self.state.ui.selection = Some(ChatSelection {
                                    start_line: sl,
                                    start_col: sc,
                                    end_line: line,
                                    end_col: col,
                                });
                            }
                            self.state.ui.needs_render = true;
                        }
                    }
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                if self.state.ui.drag_selecting {
                    // Partial selection → copy selected text
                    if let Some(text) = self
                        .state
                        .ui
                        .selected_text(&self.state.session.chat_history)
                    {
                        let lines = text.lines().count();
                        let _ = self.copy_to_clipboard(&text);
                        self.state.ui.show_toast(format!("✓ copied {lines} lines"));
                    }
                    self.state.ui.drag_selecting = false;
                    // Keep selection visible briefly; clear on next click
                } else if self.state.ui.suppress_click_on_up {
                    // A Down-arm chrome claim (jump-to-bottom chip) already
                    // handled this gesture; the release must not toggle rows.
                    self.state.ui.suppress_click_on_up = false;
                } else {
                    // Click (no meaningful drag). Resolve at the press
                    // position, not the release: sub-threshold jitter must not
                    // retarget single-row affordances (Thought headers, chips).
                    self.state.ui.selection = None;
                    let (cx, cy) = self
                        .state
                        .ui
                        .mouse_down
                        .unwrap_or((mouse.column, mouse.row));
                    let _ = self.handle_click(cx, cy);
                }
                self.state.ui.mouse_down = None;
                self.state.ui.needs_render = true;
            }
            MouseEventKind::Moved => {
                // Thinking toggle suppressed hover until the next real move so
                // a layout shift under the cursor does not border a neighbor.
                // Repaints are decided by `pointer_fingerprint`, not per cell.
                if self.state.ui.suppress_hover_until_move {
                    self.state.ui.suppress_hover_until_move = false;
                    self.state.ui.hovered_entry_id = None;
                    self.state.ui.needs_render = true;
                }
                // Update hover target from click regions (never thinking headers)
                let hover = self
                    .state
                    .ui
                    .find_click_region(mouse.row)
                    .filter(|r| crate::state::is_hover_target(r))
                    .map(|r| r.entry_id);
                if hover != prev_hover {
                    self.state.ui.set_hovered_entry(hover);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Move `geom`'s surface so its thumb sits under pointer `row`.
    fn scroll_surface_to(&mut self, geom: ScrollbarGeom, row: u16) {
        let offset = geom.offset_at(row);
        let ui = &mut self.state.ui;
        match geom.surface {
            ScrollSurface::Chat => {
                // Direct manipulation: drop any eased scroll in flight.
                ui.scroll_target = None;
                ui.chat_scroll = offset;
                ui.chat_auto_scroll = offset >= geom.max_offset;
            }
            ScrollSurface::Plan => {
                self.state.plan_review.scroll = offset.min(usize::from(u16::MAX)) as u16;
            }
            ScrollSurface::Process => {
                if let Some(view) = self.state.ui.process_view.as_mut() {
                    view.follow = offset >= geom.max_offset;
                    view.scroll = offset;
                }
            }
            ScrollSurface::SubagentDetail => {
                ui.subagent_detail_follow = false;
                ui.subagent_detail_scroll = offset;
            }
        }
        self.state.ui.needs_render = true;
    }

    pub(super) fn handle_click(&mut self, x: u16, y: u16) -> anyhow::Result<()> {
        // `[stop]` in the activity strip — cancel the running turn immediately.
        if hit(self.state.ui.stop_hitbox, x, y) {
            self.stop_current_operation();
            return Ok(());
        }

        // Jump-to-bottom chip (shown when scrolled up during/after a stream).
        if hit(self.state.ui.jump_bottom_area, x, y) {
            self.state.ui.scroll_to_bottom();
            self.state.ui.needs_render = true;
            return Ok(());
        }

        let Some(region) = self.state.ui.find_click_region(y).cloned() else {
            return Ok(());
        };

        // Thinking header → toggle expand for that block only (header hit target).
        if region.is_reasoning || region.kind == ClickKind::Thinking {
            if region.entry_id == LIVE_THINKING_ID {
                self.state.agent.thinking_expanded = !self.state.agent.thinking_expanded;
            } else if self
                .state
                .ui
                .expanded_thinking_ids
                .contains(&region.entry_id)
            {
                self.state.ui.expanded_thinking_ids.remove(&region.entry_id);
            } else {
                self.state.ui.expanded_thinking_ids.insert(region.entry_id);
            }
            // Layout will shift under the cursor; do not leave hover on a neighbor.
            self.state.ui.hovered_entry_id = None;
            self.state.ui.suppress_hover_until_move = true;
            self.state.ui.needs_render = true;
            return Ok(());
        }

        // A running tool → watch its live output.
        if region.kind == ClickKind::LiveTool {
            if let Some(call_id) = region.live_call.clone() {
                self.state.ui.process_view = Some(crate::state::ProcessView::open(call_id));
                self.state.ui.hovered_entry_id = None;
                self.state.ui.needs_render = true;
            }
            return Ok(());
        }

        // Your own message → revert / fork / copy (expand lives there too).
        if region.kind == ClickKind::Prompt {
            self.state.ui.message_actions = Some(region.entry_id);
            self.state.input.message_actions_selected = 0;
            self.state.ui.hovered_entry_id = None;
            self.state.ui.needs_render = true;
            return Ok(());
        }

        // Long user message → always toggle expand/collapse on click
        // (copy long pastes via drag-select; short messages still click-to-copy)
        if region.kind == ClickKind::Message {
            if let Some(entry) = self
                .state
                .session
                .chat_history
                .iter()
                .find(|e| e.id == region.entry_id)
            {
                if entry.role == agente_core::types::Role::User && entry.content.lines().count() > 8
                {
                    if self
                        .state
                        .ui
                        .expanded_message_ids
                        .contains(&region.entry_id)
                    {
                        self.state.ui.expanded_message_ids.remove(&region.entry_id);
                    } else {
                        self.state.ui.expanded_message_ids.insert(region.entry_id);
                    }
                    self.state.ui.needs_render = true;
                    return Ok(());
                }
            }
        }

        // Subagent card → open the live detail modal (click the bubble to
        // inspect what the child is doing). Must run before the generic Tool
        // path: the anchor entry is `Role::Tool` with `tool_name="task"`.
        if region.kind == ClickKind::Subagent {
            if let Some(entry) = self
                .state
                .session
                .chat_history
                .iter()
                .find(|e| e.id == region.entry_id)
            {
                if let Some(sub_id) = entry.subagent_id.clone() {
                    self.state.ui.open_subagent_detail(sub_id);
                    self.state.ui.hovered_entry_id = None;
                    self.state.ui.suppress_hover_until_move = true;
                    self.state.ui.needs_render = true;
                    return Ok(());
                }
            }
        }

        // Tool verb-group header → expand/collapse the whole run.
        if region.kind == ClickKind::ToolGroup {
            self.state.ui.toggle_tool_group(region.entry_id);
            // Layout shifts under the cursor; do not leave hover on a neighbor.
            self.state.ui.hovered_entry_id = None;
            self.state.ui.suppress_hover_until_move = true;
            self.state.ui.needs_render = true;
            return Ok(());
        }

        // Tool card → cycle its fold Collapsed → Truncated → Expanded
        // (drag-select still copies). The region carries the tool name so
        // `shell`/`read_file` cycle from their Truncated default.
        if region.kind == ClickKind::Tool {
            self.state
                .ui
                .cycle_tool_entry(region.entry_id, region.tool_name.as_deref());
            return Ok(());
        }

        // Action chip: open media asset in default system viewer (image/HTML/video)
        if region.kind == ClickKind::OpenAsset {
            if let Some(path) = &region.asset_path {
                let display_name = std::path::Path::new(path.as_str())
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone());
                // Images, audio and video ask before they open.
                if let Some(request) =
                    Self::media_request_for_path(std::path::Path::new(path.as_str()), true)
                {
                    self.request_media(request);
                    return Ok(());
                }
                open_asset_in_viewer(path.as_str());
                self.state.ui.show_toast(format!("Opened {display_name}"));
                self.state.ui.needs_render = true;
                return Ok(());
            }
        }

        // Default: copy full entry content (assistant / short user)
        if let Some(entry) = self
            .state
            .session
            .chat_history
            .iter()
            .find(|e| e.id == region.entry_id)
        {
            let content = entry.content.clone();
            if !content.is_empty() {
                let lines = content.lines().count();
                let _ = self.copy_to_clipboard(&content);
                self.state.ui.show_toast(format!("✓ copied {lines} lines"));
            }
        }
        Ok(())
    }

    pub(super) fn copy_to_clipboard(&self, text: &str) -> anyhow::Result<()> {
        crate::clipboard::copy(text)?;
        Ok(())
    }
}

pub(super) fn open_asset_in_viewer(path: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", path])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
}

#[cfg(test)]
mod tests {
    use crate::app::App;
    use agente_core::config::AppConfig;
    use crossterm::event::{KeyModifiers, MouseEvent, MouseEventKind};
    use ratatui::layout::Rect;

    fn moved(x: u16, y: u16) -> MouseEvent {
        wheel(MouseEventKind::Moved, x, y)
    }

    fn open_palette(app: &mut App) -> (ratatui::buffer::Buffer, usize, u16) {
        app.state.ui.show_welcome_screen = false;
        app.state.input.show_command_palette = true;
        let commands = crate::command_palette::filter_commands("");
        let index = commands
            .iter()
            .position(|c| *c == crate::command_palette::Command::ShowHelp)
            .unwrap();
        // The grouped palette puts Help in its last group, below the fold at
        // 80×30: select it so the list scrolls it into view, as keys would.
        app.state.input.command_palette_selected = index;
        let buf = render(app, 80, 30);
        let row = find_row(&buf, commands[index].label()).expect("help row painted");
        (buf, index, row)
    }

    #[test]
    fn hovering_a_palette_row_selects_it_and_click_runs_it() {
        let mut app = test_app();
        let (_, index, row) = open_palette(&mut app);
        app.state.input.command_palette_selected = index + 1;

        app.handle_mouse(moved(20, row)).unwrap();
        assert_eq!(app.state.input.command_palette_selected, index);
        assert!(app.state.ui.needs_render, "hover change repaints");

        app.handle_mouse(down(20, row)).unwrap();
        app.handle_mouse(up(20, row)).unwrap();
        assert!(
            !app.state.input.show_command_palette,
            "click confirms like Enter"
        );
        let last = app.state.session.chat_history.last().expect("help posted");
        assert!(last.content.starts_with("Available commands"));
    }

    #[test]
    fn slash_picker_paints_over_the_activity_strip() {
        let mut app = test_app();
        app.state.ui.show_welcome_screen = false;
        app.state.agent.state = agente_core::types::AgentState::Executing;
        app.state.input.input_text = "/".into();
        app.state.input.show_slash_picker = true;
        let buf = render(&mut app, 80, 30);
        let rows: Vec<String> = (0..30)
            .map(|y| (0..80).map(|x| buf[(x, y)].symbol()).collect())
            .collect();
        let header = rows
            .iter()
            .position(|r| r.contains("Slash commands"))
            .unwrap();
        let composer = rows.iter().position(|r| r.contains('╭')).unwrap();
        for row in &rows[header..composer] {
            assert!(!row.contains("stop"), "strip leaked into the picker: {row}");
        }
    }

    #[test]
    fn pointer_moves_within_one_target_do_not_repaint() {
        let mut app = test_app();
        let (_, _, row) = open_palette(&mut app);
        app.handle_mouse(moved(20, row)).unwrap();
        render(&mut app, 80, 30);
        app.state.ui.needs_render = false;
        app.handle_mouse(moved(24, row)).unwrap();
        assert!(!app.state.ui.needs_render);
    }

    fn test_app() -> App {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        App::new_for_test(AppConfig::default(), "/tmp/mouse-test".to_string(), runtime).unwrap()
    }

    fn wheel(kind: MouseEventKind, x: u16, y: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        }
    }

    fn press(kind: MouseEventKind, x: u16, y: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        }
    }

    fn down(x: u16, y: u16) -> MouseEvent {
        press(
            MouseEventKind::Down(crossterm::event::MouseButton::Left),
            x,
            y,
        )
    }

    fn drag_to(x: u16, y: u16) -> MouseEvent {
        press(
            MouseEventKind::Drag(crossterm::event::MouseButton::Left),
            x,
            y,
        )
    }

    fn up(x: u16, y: u16) -> MouseEvent {
        press(
            MouseEventKind::Up(crossterm::event::MouseButton::Left),
            x,
            y,
        )
    }

    /// Paint the app headlessly and return the frame buffer.
    fn render(app: &mut App, w: u16, h: u16) -> ratatui::buffer::Buffer {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(w, h)).unwrap();
        terminal
            .draw(|frame| crate::app::render::render_app(frame, &mut app.state))
            .unwrap();
        terminal.backend().buffer().clone()
    }

    /// First screen row whose text contains `needle`.
    fn find_row(buf: &ratatui::buffer::Buffer, needle: &str) -> Option<u16> {
        for y in 0..buf.area.height {
            let mut row = String::new();
            for x in 0..buf.area.width {
                row.push_str(buf[(x, y)].symbol());
            }
            if row.contains(needle) {
                return Some(y);
            }
        }
        None
    }

    fn thought_entry(reasoning: &str, content: &str) -> agente_core::types::ChatEntry {
        agente_core::types::ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: agente_core::types::Role::Assistant,
            content: content.to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: Some(9_200.0),
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: Some(reasoning.to_string()),
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        }
    }

    fn text_entry(content: &str) -> agente_core::types::ChatEntry {
        agente_core::types::ChatEntry {
            id: uuid::Uuid::new_v4(),
            role: agente_core::types::Role::Assistant,
            content: content.to_string(),
            tool_name: None,
            tool_args: None,
            is_error: false,
            timestamp: chrono::Utc::now(),
            response_duration: None,
            mode: "Build".to_string(),
            interrupted: false,
            reasoning: None,
            subagent_id: None,
            subagent_type: None,
            diff_stats: None,
            attachments: Vec::new(),
        }
    }

    /// Clicking a Thought header must expand that entry (the core of
    /// "click on Thought does nothing").
    #[test]
    fn thought_click_expands_entry() {
        let mut app = test_app();
        let entry = thought_entry("checking the layout", "layout looks fine");
        let id = entry.id;
        app.state.session.chat_history.push(entry);
        let buf = render(&mut app, 100, 30);
        let y = find_row(&buf, "Thought for").expect("thought header painted");

        app.handle_click(10, y).unwrap();

        assert!(
            app.state.ui.expanded_thinking_ids.contains(&id),
            "click on the Thought row must expand it"
        );
    }

    /// Sub-threshold pointer jitter must not convert a click into a copy.
    /// Regression guard for the press-state rework: 1-cell wobble stays a click.
    #[test]
    fn jittered_click_still_clicks() {
        let mut app = test_app();
        let entry = thought_entry("checking the layout", "layout looks fine");
        let id = entry.id;
        app.state.session.chat_history.push(entry);
        let buf = render(&mut app, 100, 30);
        let y = find_row(&buf, "Thought for").expect("thought header painted");

        app.handle_mouse(down(10, y)).unwrap();
        app.handle_mouse(drag_to(11, y)).unwrap();
        app.handle_mouse(up(11, y)).unwrap();

        assert!(
            app.state.ui.expanded_thinking_ids.contains(&id),
            "1-cell jitter must not eat the Thought click"
        );
    }

    /// Clicks resolve at the press position: releasing one row off after
    /// sub-threshold jitter must still hit the Thought header, not the body
    /// below it.
    #[test]
    fn click_resolves_at_press_position() {
        let mut app = test_app();
        let entry = thought_entry("checking the layout", "layout looks fine");
        let id = entry.id;
        app.state.session.chat_history.push(entry);
        let buf = render(&mut app, 100, 30);
        let y = find_row(&buf, "Thought for").expect("thought header painted");

        app.handle_mouse(down(10, y)).unwrap();
        app.handle_mouse(up(10, y + 1)).unwrap();

        assert!(
            app.state.ui.expanded_thinking_ids.contains(&id),
            "release drift must not retarget the click away from Thought"
        );
    }

    /// Pressing the ↓ chip must re-pin to the bottom immediately (fires on
    /// Down, so release jitter can never swallow it).
    #[test]
    fn jump_chip_press_pins_to_bottom() {
        let mut app = test_app();
        for i in 0..50 {
            app.state
                .session
                .chat_history
                .push(text_entry(&format!("transcript filler line {i}")));
        }
        render(&mut app, 100, 30);
        assert!(
            app.state.ui.max_scroll() > 0,
            "fixture must overflow the viewport"
        );
        app.state.ui.chat_auto_scroll = false;
        app.state.ui.chat_scroll = 0;
        render(&mut app, 100, 30);
        let chip = app
            .state
            .ui
            .jump_bottom_area
            .expect("↓ chip visible while scrolled up");

        app.handle_mouse(down(chip.x + 1, chip.y)).unwrap();

        assert!(
            app.state.ui.chat_auto_scroll,
            "press on the ↓ chip must re-pin auto-scroll"
        );
        assert_eq!(
            app.state.ui.chat_scroll,
            app.state.ui.max_scroll(),
            "press on the ↓ chip must jump to the bottom"
        );
    }

    /// Wheel over the composer rows must scroll the chat (no position gating).
    /// Pins current behavior while the wheel routing is reworked.
    #[test]
    fn wheel_over_composer_scrolls_chat() {
        let mut app = test_app();
        for i in 0..50 {
            app.state
                .session
                .chat_history
                .push(text_entry(&format!("transcript filler line {i}")));
        }
        render(&mut app, 100, 30);
        app.state.ui.chat_auto_scroll = false;
        app.state.ui.chat_scroll = 0;

        // Bottom frame row = composer/hints territory, not the chat list.
        app.handle_mouse(wheel(MouseEventKind::ScrollDown, 50, 29))
            .unwrap();

        assert!(
            app.state.ui.chat_scroll > 0,
            "wheel over the composer must scroll the chat"
        );
    }

    /// With a floating approval card open, an unconsumed wheel must still
    /// scroll the visible transcript behind it instead of dying on the modal.
    #[test]
    fn wheel_falls_through_approval_to_chat() {
        use agente_core::agent::ApprovalSource;
        use agente_core::types::ApprovalRequest;

        let mut app = test_app();
        for i in 0..50 {
            app.state
                .session
                .chat_history
                .push(text_entry(&format!("transcript filler line {i}")));
        }
        render(&mut app, 100, 30);
        app.state.ui.chat_auto_scroll = false;
        app.state.ui.chat_scroll = 0;

        let req = ApprovalRequest {
            request_id: "req-wheel".into(),
            tool_name: "write_file".into(),
            tool_args: "{}".into(),
            description: "test".into(),
            is_dangerous: false,
            old_content: None,
            new_content: None,
            file_path: None,
        };
        app.state
            .agent
            .enqueue_approval(ApprovalSource::Parent, req);
        assert_eq!(
            crate::state::modal_owner(&app.state),
            crate::state::ModalOwner::Approval
        );

        app.handle_mouse(wheel(MouseEventKind::ScrollDown, 50, 10))
            .unwrap();

        assert!(
            app.state.ui.chat_scroll > 0,
            "wheel behind a floating approval must scroll the chat"
        );
    }

    fn open_plan_modal(app: &mut App) {
        let body = "line\n".repeat(200);
        app.state
            .plan_review
            .open_review("/tmp/plan.md".into(), "Test plan".into(), body);
        assert!(app.state.plan_review.takes_chat_area());
        app.state.ui.plan_review_area = Some(Rect::new(0, 0, 80, 20));
        // The widget sets these during render (wrapped body vs visible rows);
        // mirror a rendered modal so max_scroll is non-zero.
        app.state.plan_review.body_line_count = 200;
        app.state.plan_review.body_visible = 20;
    }

    #[test]
    fn plan_scrollbar_jumps_and_drags() {
        let mut app = test_app();
        app.state.ui.show_welcome_screen = false;
        let body: String = (1..=120).map(|i| format!("- step {i}\n")).collect();
        app.state
            .plan_review
            .open_review("/tmp/plan.md".into(), "Plan".into(), body);
        let buf = render(&mut app, 80, 24);
        // The thumb glyph marks the bar's column; its first row is the top.
        let (col, top) = (0..24u16)
            .find_map(|y| {
                (0..80u16)
                    .find(|&x| buf[(x, y)].symbol() == "┃")
                    .map(|x| (x, y))
            })
            .expect("plan scrollbar painted");
        let meta = (0..80u16).map(|x| buf[(x, 2)].symbol()).collect::<String>();
        assert!(meta.contains("of 120"), "position shown: {meta}");

        // Press near the bottom of the track: jump to the end.
        app.handle_mouse(down(col, top + 13)).unwrap();
        let max = app.state.plan_review.max_scroll();
        assert!(app.state.plan_review.scroll + 2 >= max, "jumped to the end");
        // Drag back to the top: scrub to the start; release ends the drag.
        app.handle_mouse(drag_to(col, top)).unwrap();
        assert_eq!(app.state.plan_review.scroll, 0);
        app.handle_mouse(up(col, top)).unwrap();
        assert!(app.state.ui.scroll_drag.is_none());
    }

    #[test]
    fn clicking_a_running_tool_opens_its_live_output() {
        let mut app = test_app();
        app.state.ui.show_welcome_screen = false;
        app.state.agent.state = agente_core::types::AgentState::Executing;
        app.state.agent.start_live_tool(
            "call-1".into(),
            "shell".into(),
            r#"{"command":"npm i -D puppeteer | tail -5"}"#.into(),
            false,
        );
        app.state
            .agent
            .append_live_tool_output("call-1", "added 12 packages\nfound 0 vulnerabilities\n");
        let buf = render(&mut app, 80, 24);
        let row = find_row(&buf, "npm i").expect("running row painted");
        let header: String = (0..80).map(|x| buf[(x, row)].symbol()).collect();
        assert!(
            header.trim_end().ends_with('s'),
            "elapsed on the row: {header}"
        );

        app.handle_mouse(down(20, row)).unwrap();
        app.handle_mouse(up(20, row)).unwrap();
        assert!(app.state.ui.process_view.is_some(), "view opened");
        let buf = render(&mut app, 80, 24);
        assert!(
            find_row(&buf, "found 0 vulnerabilities").is_some(),
            "live output shown"
        );
        assert!(find_row(&buf, "follow").is_some(), "footer hints");

        // The call finishes while watched: the final output stays.
        let finished = app.state.agent.finish_live_tool("call-1");
        app.state.ui.process_view.as_mut().unwrap().finished = finished;
        let buf = render(&mut app, 80, 24);
        assert!(find_row(&buf, "finished").is_some());
        assert!(find_row(&buf, "found 0 vulnerabilities").is_some());
    }

    #[test]
    fn wheel_over_plan_modal_scrolls_the_plan() {
        let mut app = test_app();
        open_plan_modal(&mut app);
        let before = app.state.plan_review.scroll;

        // Wheel down over the modal scrolls the plan body (not the hidden chat).
        app.handle_mouse(wheel(MouseEventKind::ScrollDown, 40, 10))
            .unwrap();
        assert!(
            app.state.plan_review.scroll > before,
            "wheel over the modal must scroll the plan"
        );

        // Wheel up scrolls back.
        app.handle_mouse(wheel(MouseEventKind::ScrollUp, 40, 10))
            .unwrap();
        assert_eq!(app.state.plan_review.scroll, before);
    }

    #[test]
    fn wheel_outside_plan_modal_does_not_scroll_it() {
        let mut app = test_app();
        open_plan_modal(&mut app);
        let before = app.state.plan_review.scroll;

        // Pointer below the modal (composer row): the plan stays put.
        app.handle_mouse(wheel(MouseEventKind::ScrollDown, 40, 25))
            .unwrap();
        assert_eq!(app.state.plan_review.scroll, before);
    }

    #[test]
    fn stop_button_click_stops_running_operation_and_resets_idle() {
        use agente_core::types::AgentState;

        let mut app = test_app();
        app.state.agent.state = AgentState::StreamingResponse;
        app.state.agent.streaming_text = "streaming answer...".to_string();
        app.state.ui.stop_hitbox = Some(Rect::new(70, 20, 7, 1));

        app.handle_click(72, 20).unwrap();

        assert_eq!(app.state.agent.state, AgentState::Idle);
        assert!(app.state.cancel_tx.is_aborted());
        assert!(app.state.agent.streaming_text.is_empty());
        let interrupted = app
            .state
            .session
            .chat_history
            .iter()
            .find(|e| e.interrupted)
            .unwrap();
        assert!(interrupted.content.contains("streaming answer..."));
        let last = app.state.session.chat_history.last().unwrap();
        assert_eq!(last.role, agente_core::types::Role::System);
        assert!(last.content.contains("Stopped by user"));
    }

    #[test]
    fn stop_discards_events_queued_by_the_cancelled_turn() {
        use agente_core::agent::{AgentEvent, AgentTaskEvent};
        use agente_core::types::AgentState;

        let mut app = test_app();
        app.current_task_id = 42;
        app.state.agent.state = AgentState::StreamingResponse;
        for event in [
            AgentEvent::Thinking,
            AgentEvent::TextDelta(String::from("late")),
        ] {
            app.agent_tx
                .send(AgentTaskEvent { task_id: 42, event })
                .unwrap();
        }
        app.stop_current_operation();
        let history_len = app.state.session.chat_history.len();
        app.process_agent_events();
        assert_eq!(app.state.agent.state, AgentState::Idle);
        assert!(app.state.agent.streaming_text.is_empty());
        assert_eq!(app.state.session.chat_history.len(), history_len);
    }

    #[test]
    fn stop_button_click_works_even_when_modal_blocks_chat_mouse() {
        use agente_core::types::AgentState;
        use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

        let mut app = test_app();
        open_plan_modal(&mut app);
        assert!(crate::state::modal_owner(&app.state).blocks_chat_mouse());

        app.state.agent.state = AgentState::WaitingApproval;
        app.state.ui.stop_hitbox = Some(Rect::new(70, 20, 7, 1));

        let click = MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: 72,
            row: 20,
            modifiers: KeyModifiers::empty(),
        };

        app.handle_mouse(click).unwrap();

        assert_eq!(app.state.agent.state, AgentState::Idle);
        assert!(app.state.cancel_tx.is_aborted());
    }

    #[test]
    fn mouse_click_on_approval_button_resolves_approval() {
        use agente_core::agent::ApprovalSource;
        use agente_core::types::{AgentState, ApprovalAction, ApprovalRequest};
        use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

        let mut app = test_app();
        app.state.agent.state = AgentState::WaitingApproval;
        let req = ApprovalRequest {
            request_id: "req-123".into(),
            tool_name: "write_file".into(),
            tool_args: "{}".into(),
            description: "test".into(),
            is_dangerous: false,
            old_content: None,
            new_content: None,
            file_path: None,
        };
        let mut rx = app.approval_broker.request(&req);
        app.state
            .agent
            .enqueue_approval(ApprovalSource::Parent, req);
        app.state.ui.hits.push(
            Rect::new(10, 5, 17, 1),
            crate::state::HitTarget::Approval(ApprovalAction::ApproveOnce),
        );

        let click = MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: 12,
            row: 5,
            modifiers: KeyModifiers::empty(),
        };

        app.handle_mouse(click).unwrap();

        assert_eq!(rx.try_recv().unwrap(), ApprovalAction::ApproveOnce);
        assert!(app.state.agent.current_approval().is_none());
    }
}
