//! Session tabs: open, switch, close, and route agent events to the tab
//! that owns them (see `state::tabs` for the swap model).

use agente_core::agent::{AgentEvent, AgentTaskEvent};

use super::App;
use crate::state::{tab_label, TabLabel, TabState, TabStrip};

/// Task ids remembered per tab (a background subagent reports under the id
/// of the turn that spawned it, possibly several turns ago).
const OWNED_TASK_IDS: usize = 64;

/// A tab that is not on screen.
pub(crate) struct BackgroundTab {
    pub(crate) state: TabState,
    current_task_id: u64,
    task_ids: Vec<u64>,
    /// Finished (or failed) while in the background; cleared on view.
    unseen: bool,
}

/// All open tabs; the active one's data lives in `App::state`.
pub(crate) struct Tabs {
    /// `None` marks the active tab's slot.
    slots: Vec<Option<BackgroundTab>>,
    active: usize,
    /// Task ids issued to the active tab.
    active_task_ids: Vec<u64>,
    /// Source of unique task ids across tabs.
    counter: u64,
    /// Set while a background tab is swapped in to apply an event.
    in_background: bool,
}

impl Default for Tabs {
    fn default() -> Self {
        Self {
            slots: vec![None],
            active: 0,
            active_task_ids: Vec::new(),
            counter: 0,
            in_background: false,
        }
    }
}

impl Tabs {
    pub(crate) fn len(&self) -> usize {
        self.slots.len()
    }

    pub(crate) fn active(&self) -> usize {
        self.active
    }

    fn owner_of(&self, task_id: u64) -> Option<usize> {
        self.slots.iter().position(|slot| {
            slot.as_ref()
                .is_some_and(|tab| tab.task_ids.contains(&task_id))
        })
    }

    /// True when `task_id` belongs to the currently swapped-in tab (or is a
    /// synthetic single-tab unit test where `next_task_id` has not run yet).
    pub(crate) fn active_owns(&self, task_id: u64, current_task_id: u64) -> bool {
        task_id == 0
            || task_id == current_task_id
            || self.active_task_ids.contains(&task_id)
            || (self.counter == 0 && self.slots.len() == 1)
    }

    fn background_indices(&self) -> Vec<usize> {
        (0..self.slots.len())
            .filter(|&i| i != self.active)
            .collect()
    }
}

fn remember(ids: &mut Vec<u64>, id: u64) {
    ids.push(id);
    if ids.len() > OWNED_TASK_IDS {
        ids.remove(0);
    }
}

/// Discovery results update the model lists every tab's config carries.
fn is_discovery(event: &AgentEvent) -> bool {
    matches!(
        event,
        AgentEvent::ModelsDiscovered { .. }
            | AgentEvent::ModelDiscoveryFailed { .. }
            | AgentEvent::ModelCatalogUpdated { .. }
    )
}

impl App {
    /// A fresh task id, unique across tabs, owned by the tab in `self.state`.
    pub(super) fn next_task_id(&mut self) -> u64 {
        let id = self.tabs.counter.max(self.current_task_id) + 1;
        self.tabs.counter = id;
        remember(&mut self.tabs.active_task_ids, id);
        id
    }

    /// Drop the active tab's remembered task ids when its session is replaced.
    pub(super) fn clear_active_task_ids(&mut self) {
        self.tabs.active_task_ids.clear();
    }

    /// Run `f` with background tab `index` swapped into `self.state`.
    fn with_background_tab<R>(&mut self, index: usize, f: impl FnOnce(&mut App) -> R) -> R {
        let Some(mut tab) = self.tabs.slots.get_mut(index).and_then(Option::take) else {
            return f(self);
        };
        tab.state.swap_with(&mut self.state);
        std::mem::swap(&mut tab.current_task_id, &mut self.current_task_id);
        std::mem::swap(&mut tab.task_ids, &mut self.tabs.active_task_ids);
        let was_busy = !self.state.agent.is_idle();
        let had_approval = self.state.agent.has_pending_approval();
        let nested = std::mem::replace(&mut self.tabs.in_background, true);

        let result = f(self);

        self.tabs.in_background = nested;
        let title = tab_label(&self.state.session, &self.state.agent, false).title;
        if was_busy && self.state.agent.is_idle() {
            tab.unseen = true;
            self.state
                .ui
                .show_toast(format!("✓ Tab {} finished · {}", index + 1, short(&title)));
        } else if !had_approval && self.state.agent.has_pending_approval() {
            self.state.ui.show_toast(format!(
                "◆ Tab {} needs approval · {}",
                index + 1,
                short(&title)
            ));
        }
        std::mem::swap(&mut tab.task_ids, &mut self.tabs.active_task_ids);
        std::mem::swap(&mut tab.current_task_id, &mut self.current_task_id);
        tab.state.swap_with(&mut self.state);
        self.tabs.slots[index] = Some(tab);
        self.state.ui.needs_render = true;
        result
    }

    /// Send an event to the tab that owns it: background tabs are swapped
    /// in for the duration; anything unowned goes to the active tab, whose
    /// own stale-event guard decides.
    pub(super) fn route_agent_event(&mut self, task_event: AgentTaskEvent) {
        if task_event.task_id == 0 && is_discovery(&task_event.event) {
            self.apply_agent_event(task_event);
            self.share_discovery_with_background_tabs();
            return;
        }
        match self.tabs.owner_of(task_event.task_id) {
            Some(index) if task_event.task_id != 0 => {
                self.with_background_tab(index, |app| app.apply_agent_event(task_event));
            }
            _ => self.apply_agent_event(task_event),
        }
    }

    /// Copy the active config's discovered models into background tabs,
    /// keeping each tab's own provider, model and MCP servers.
    fn share_discovery_with_background_tabs(&mut self) {
        for slot in self.tabs.slots.iter_mut().flatten() {
            let config = &mut slot.state.config;
            let provider = std::mem::take(&mut config.current_provider);
            let model = std::mem::take(&mut config.current_model);
            let mcp = std::sync::Arc::clone(&config.mcp_manager);
            *config = self.state.config.clone();
            config.current_provider = provider;
            config.current_model = model;
            config.mcp_manager = mcp;
        }
    }

    /// Save every tab's session (the active one and each background one).
    pub(super) fn queue_background_snapshots(&mut self) {
        if self.tabs.in_background {
            return;
        }
        for index in self.tabs.background_indices() {
            self.with_background_tab(index, |app| app.queue_session_snapshot());
        }
    }

    /// Open a new tab with a fresh session (same project, model and mode)
    /// and switch to it.
    pub(super) fn open_new_tab(&mut self) {
        let tab = BackgroundTab {
            state: TabState::fresh_like(&self.state),
            current_task_id: 0,
            task_ids: Vec::new(),
            unseen: false,
        };
        let index = self.tabs.active + 1;
        self.tabs.slots.insert(index, Some(tab));
        self.switch_tab(index);
        self.state
            .ui
            .show_toast(format!("New tab · {} open", self.tabs.len()));
    }

    /// Bring tab `index` to the front.
    pub(super) fn switch_tab(&mut self, index: usize) {
        if index == self.tabs.active || index >= self.tabs.len() {
            return;
        }
        let Some(mut tab) = self.tabs.slots[index].take() else {
            return;
        };
        tab.state.swap_with(&mut self.state);
        std::mem::swap(&mut tab.current_task_id, &mut self.current_task_id);
        std::mem::swap(&mut tab.task_ids, &mut self.tabs.active_task_ids);
        tab.unseen = false;
        self.tabs.slots[self.tabs.active] = Some(tab);
        self.tabs.active = index;
        self.after_tab_change();
    }

    /// Next (`+1`) or previous (`-1`) tab, wrapping.
    pub(super) fn cycle_tab(&mut self, step: isize) {
        let len = self.tabs.len() as isize;
        if len < 2 {
            return;
        }
        let next = (self.tabs.active as isize + step).rem_euclid(len);
        self.switch_tab(next as usize);
    }

    /// Close tab `index` after saving its session. A tab whose agent is
    /// still working stays open (stop it first); the last tab never closes.
    pub(super) fn close_tab(&mut self, index: usize) {
        if index >= self.tabs.len() {
            return;
        }
        if self.tabs.len() == 1 {
            self.state
                .ui
                .show_toast("Last tab · Ctrl+C quits".to_string());
            return;
        }
        let busy = if index == self.tabs.active {
            !self.state.can_replace_session()
        } else {
            self.with_background_tab(index, |app| !app.state.can_replace_session())
        };
        if busy {
            self.state
                .ui
                .show_toast("That tab is still working · stop it first".to_string());
            return;
        }
        if index == self.tabs.active {
            self.queue_session_snapshot();
            let neighbor = if index + 1 < self.tabs.len() {
                index + 1
            } else {
                index - 1
            };
            self.switch_tab(neighbor);
        } else {
            self.with_background_tab(index, |app| app.queue_session_snapshot());
        }
        self.tabs.slots.remove(index);
        if index < self.tabs.active {
            self.tabs.active -= 1;
        }
        self.state.ui.needs_render = true;
    }

    /// Transient UI belongs to the tab that was on screen.
    fn after_tab_change(&mut self) {
        self.state.input.close_at_picker();
        self.state.input.show_slash_picker = false;
        self.state.input.show_subagent_models = false;
        self.state.input.subagent_model_edit = None;
        self.state.input.show_model_selector = false;
        self.state.input.model_selector_target = None;
        self.state.input.show_board = false;
        self.state.input.board_scroll.scroll_to_top();
        self.state.input.show_settings = false;
        self.state.input.show_skills = false;
        self.state.input.show_mcp = false;
        self.state.input.show_command_palette = false;
        self.state.input.close_subagents();
        self.state.input.close_thinking_selector();
        self.state.input.show_doctor = false;
        self.state.input.doctor_checks.clear();
        self.state.config.close_connect_screen();
        self.state.picker.close();
        let ui = &mut self.state.ui;
        ui.media_consent = None;
        ui.message_actions = None;
        ui.process_view = None;
        ui.subagent_detail_id = None;
        ui.diff_peek = None;
        ui.show_help = false;
        if ui.scroll_drag.take().is_some() {
            ui.suppress_click_on_up = true;
        }
        ui.hits.begin_frame();
        ui.mouse_down = None;
        ui.mouse_down_owner = None;
        ui.selection = None;
        ui.hovered_entry_id = None;
        ui.clear_chat_render_cache();
        ui.stream_markdown_cache.reset(0);
        if !ui.reduce_motion {
            ui.surface_fade = Some(crate::state::anim::Tween::start(
                crate::state::anim::MODAL_MS,
            ));
        }
        ui.needs_render = true;
    }

    /// Refresh the strip the renderer draws.
    pub(super) fn refresh_tab_strip(&mut self) {
        let tabs: Vec<TabLabel> = self
            .tabs
            .slots
            .iter()
            .map(|slot| match slot {
                Some(tab) => tab.state.label(tab.unseen),
                None => tab_label(&self.state.session, &self.state.agent, false),
            })
            .collect();
        self.state.ui.tab_strip = TabStrip {
            tabs,
            active: self.tabs.active,
        };
    }

    /// `Resume with: …` lines for every background tab with a conversation.
    pub(super) fn background_resume_hints(&self) -> Vec<String> {
        self.tabs
            .slots
            .iter()
            .flatten()
            .filter(|tab| !tab.state.session.chat_history.is_empty())
            .map(|tab| {
                let label = tab_label(&tab.state.session, &tab.state.agent, false);
                format!(
                    "  {} · agente --resume {}",
                    short(&label.title),
                    tab.state.session.session_id
                )
            })
            .collect()
    }

    /// Whether any background tab is waiting on the user or working.
    #[cfg(test)]
    pub(super) fn background_status(&self, index: usize) -> Option<crate::state::TabStatus> {
        self.tabs
            .slots
            .get(index)?
            .as_ref()
            .map(|tab| tab.state.label(tab.unseen).status)
    }

    /// Apply a session title to whichever tab holds `session_id`.
    pub(super) fn apply_title_to_background_tab(
        &mut self,
        session_id: uuid::Uuid,
        title: &str,
    ) -> bool {
        let Some(index) = self.tabs.slots.iter().position(|slot| {
            slot.as_ref()
                .is_some_and(|tab| tab.state.session.session_id == session_id)
        }) else {
            return false;
        };
        let title = title.to_string();
        self.with_background_tab(index, move |app| {
            if app.state.apply_session_title(session_id, title) {
                app.queue_session_snapshot();
            }
        });
        true
    }
}

fn short(title: &str) -> String {
    crate::widgets::truncate_cells(title, 32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::TabStatus;
    use agente_core::config::AppConfig;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn test_app() -> App {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        App::new_for_test(AppConfig::default(), "/tmp/tabs-test".into(), runtime).unwrap()
    }

    #[test]
    fn each_tab_keeps_its_own_session_and_draft() {
        let mut app = test_app();
        let first = app.state.session.session_id;
        app.state.add_user_message("first tab prompt".into());
        app.state.input.input_text = "draft one".into();
        app.state.ui.set_chat_dimensions(100, 20);
        app.state.ui.scroll_to_bottom();
        app.state.ui.scroll_up(10);

        app.handle_key(KeyEvent::new(KeyCode::F(2), KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.tabs.len(), 2);
        assert_eq!(app.tabs.active(), 1);
        assert_ne!(app.state.session.session_id, first, "a fresh session");
        assert!(app.state.session.chat_history.is_empty());
        assert!(app.state.input.input_text.is_empty());
        app.state.input.input_text = "draft two".into();
        app.state.ui.set_chat_dimensions(30, 20);

        app.with_background_tab(0, |app| {
            assert_eq!(app.state.ui.max_scroll(), 80);
            assert_eq!(app.state.ui.chat_scroll, 70);
            assert!(!app.state.ui.chat_auto_scroll);
        });
        assert_eq!(app.state.ui.max_scroll(), 10);

        app.handle_key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::CONTROL))
            .unwrap();
        assert_eq!(app.state.session.session_id, first);
        assert_eq!(app.state.input.input_text, "draft one");
        assert_eq!(app.state.ui.chat_scroll, 70);
        app.refresh_tab_strip();
        let titles: Vec<&str> = app
            .state
            .ui
            .tab_strip
            .tabs
            .iter()
            .map(|t| t.title.as_str())
            .collect();
        assert_eq!(titles, ["first tab prompt", "New session"]);

        app.cycle_tab(1);
        assert_eq!(app.state.input.input_text, "draft two");
    }

    #[test]
    fn a_background_turn_keeps_running_and_lands_in_its_own_tab() {
        let mut app = test_app();
        // Tab 1 starts a turn…
        let task = app.next_task_id();
        app.current_task_id = task;
        app.state.agent.state = agente_core::types::AgentState::Executing;
        app.state.add_user_message("long job".into());
        // …and the user opens tab 2 while it runs.
        app.open_new_tab();
        let _ = app.agent_tx.send(AgentTaskEvent {
            task_id: task,
            event: AgentEvent::AssistantText("job output".into()),
        });
        app.process_agent_events();
        assert!(
            app.state.session.chat_history.is_empty(),
            "the visible tab is untouched"
        );
        assert_eq!(app.background_status(0), Some(TabStatus::Working));

        let _ = app.agent_tx.send(AgentTaskEvent {
            task_id: task,
            event: AgentEvent::Done {
                conversation: Vec::new(),
                tokens: 0,
            },
        });
        app.process_agent_events();
        assert_eq!(
            app.background_status(0),
            Some(TabStatus::Unseen),
            "finished while away"
        );

        app.switch_tab(0);
        assert!(app
            .state
            .session
            .chat_history
            .iter()
            .any(|e| e.content == "job output"));
        app.refresh_tab_strip();
        assert_eq!(app.state.ui.tab_strip.tabs[0].status, TabStatus::Idle);
    }

    #[test]
    fn closing_saves_and_keeps_at_least_one_tab() {
        let mut app = test_app();
        app.close_tab(0);
        assert_eq!(app.tabs.len(), 1, "the last tab stays");
        app.open_new_tab();
        app.state.agent.state = agente_core::types::AgentState::Executing;
        app.close_tab(1);
        assert_eq!(app.tabs.len(), 2, "a working tab is not closed");
        app.state.agent.state = agente_core::types::AgentState::Idle;
        app.close_tab(1);
        assert_eq!(app.tabs.len(), 1);
        assert_eq!(app.tabs.active(), 0);
    }

    #[test]
    fn switching_tabs_swaps_pastes_and_attachments_and_clears_global_modals() {
        use agente_core::media::{Attachment, AttachmentKind};

        let mut app = test_app();
        let placeholder = app.state.input.stash_paste("line 1\nline 2\nline 3");
        app.state.input.input_text = placeholder;
        app.state.input.attachments.push(Attachment {
            kind: AttachmentKind::Image,
            name: "tab0.png".into(),
            mime: "image/png".into(),
            path: "/tmp/tab0.png".into(),
            bytes: 64,
        });
        app.state.input.show_settings = true;
        app.state.input.show_board = true;
        app.state.input.show_command_palette = true;
        app.state.picker.show_session_picker = true;
        app.state.ui.stream_markdown_cache.settled = 12;

        app.open_new_tab();
        assert!(app.state.input.pasted_blocks.is_empty());
        assert!(app.state.input.attachments.is_empty());
        assert!(!app.state.input.show_settings);
        assert!(!app.state.input.show_board);
        assert!(!app.state.input.show_command_palette);
        assert!(!app.state.picker.show_session_picker);
        assert_eq!(app.state.ui.stream_markdown_cache.settled, 0);

        app.switch_tab(0);
        assert_eq!(app.state.input.pasted_blocks.len(), 1);
        assert_eq!(app.state.input.attachments.len(), 1);
        assert_eq!(app.state.input.attachments[0].name, "tab0.png");
    }
}
