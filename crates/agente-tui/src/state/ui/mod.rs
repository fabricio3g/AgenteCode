//! UI-related state management:
//! - Transcript geometry and interaction (`selection`)
//! - Chat and overlay scrolling (`scroll`)
//! - Render caches and streaming markdown checkpoints (`cache`)
//! - FPS tracking, animations, and modal state (`mod`)

mod cache;
mod scroll;
mod selection;

pub use cache::{
    ChatCacheKey, ChatFrameSnapshot, ChatPlainLine, Fold, RenderedChatBlock, StreamMarkdownCache,
};
pub use scroll::ProcessView;
pub use selection::{is_hover_target, ChatSelection};

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use agente_core::types::ClickRegion;
use ratatui::layout::Rect;
use uuid::Uuid;

use crate::widgets::ScrollState;

/// How long a toast chip stays visible (display-only feedback).
const TOAST_LIFETIME_MS: u128 = 2_000;

/// Read-only child-session views; the main agent authors the handoff.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SubagentDetailTab {
    #[default]
    Activity,
    Handoff,
    Result,
}

impl SubagentDetailTab {
    pub fn next(self) -> Self {
        match self {
            Self::Activity => Self::Handoff,
            Self::Handoff => Self::Result,
            Self::Result => Self::Activity,
        }
    }
}

/// UI state for layout and rendering
pub struct UiState {
    /// When set, show a full-width diff peek for this modified file (Esc closes).
    pub diff_peek: Option<String>,
    pub diff_peek_scroll: ScrollState,
    /// Screen rect of the plan review modal from the last render (for wheel scroll).
    pub plan_review_area: Option<Rect>,
    /// Screen rect of the subagent detail modal body (for wheel scroll).
    pub subagent_detail_area: Option<Rect>,
    /// Focused subagent for the detail modal (`SubagentDetail` owner).
    pub subagent_detail_id: Option<String>,
    /// Scroll and follow state inside the subagent detail modal body.
    pub subagent_detail_scroll: ScrollState,
    pub subagent_detail_tab: SubagentDetailTab,
    pub subagent_detail_show_output: bool,
    /// Worktree review loaded by `d` in the subagent detail modal.
    pub subagent_diff: Option<Option<String>>,
    // Chat state
    /// Chat scroll offset
    pub chat_scroll: usize,
    /// Auto-scroll chat to bottom
    pub chat_auto_scroll: bool,
    /// Where an eased scroll is heading; `chat_scroll` walks toward it one frame at a time.
    pub scroll_target: Option<usize>,
    /// Snap instead of animating (config `reduce_motion`).
    pub reduce_motion: bool,
    /// Chat content height in lines
    pub chat_content_height: usize,
    /// Chat visible height in lines
    pub chat_visible_height: usize,
    /// Top row of the chat content area (for hit-testing)
    pub chat_area_y: u16,
    /// Left column of the chat content area
    pub chat_area_x: u16,
    /// Scrollbar being dragged (any surface), with its geometry at press.
    pub scroll_drag: Option<crate::widgets::scrollbar::ScrollbarGeom>,
    /// Last known mouse position (screen coords).
    pub mouse_pos: Option<(u16, u16)>,
    /// Sent message whose action dialog (revert / fork / copy) is open.
    pub message_actions: Option<Uuid>,
    /// Live output view of a running (or just finished) tool call.
    pub process_view: Option<ProcessView>,
    /// Hit target for the jump-to-bottom control (set each paint when visible).
    pub jump_bottom_area: Option<Rect>,
    /// Hit target for the `[stop]` button in the activity strip.
    pub stop_hitbox: Option<Rect>,

    /// Interactive regions painted last frame (list rows, dialog buttons).
    pub hits: super::hits::HitMap,
    /// Open session tabs, as the strip draws them (refreshed by the app).
    pub tab_strip: super::TabStrip,
    /// An image/audio/video waiting for the user's permission to open or attach.
    pub media_consent: Option<crate::media_consent::MediaRequest>,
    /// Hit target under the pointer, for hover highlights on buttons.
    pub hovered_hit: Option<super::hits::HitTarget>,

    // Interaction
    /// Clickable regions for mouse interaction
    pub click_regions: Vec<ClickRegion>,
    /// Expanded user message ids (long paste / multi-line)
    pub expanded_message_ids: HashSet<Uuid>,
    /// Expanded thinking cards (finished turns), keyed by assistant entry id
    pub expanded_thinking_ids: HashSet<Uuid>,
    /// Per-tool-card fold overrides (a card without one is `Fold::Collapsed`).
    pub tool_fold: HashMap<Uuid, Fold>,
    /// Verb-group headers the user expanded, keyed by the group's first member's entry id.
    pub expanded_groups: HashSet<Uuid>,
    /// Transient confirmation chip: (text, shown-at).
    pub toast: Option<(String, std::time::Instant)>,
    /// Help overlay scroll state.
    pub help_scroll: ScrollState,
    /// Entry currently under the mouse (message hover border)
    pub hovered_entry_id: Option<Uuid>,
    /// After toggling thinking, ignore hover until the pointer moves.
    pub suppress_hover_until_move: bool,
    /// Last time we painted while streaming.
    pub last_stream_paint_at: Option<std::time::Instant>,
    /// Mouse down origin for drag threshold
    pub mouse_down: Option<(u16, u16)>,
    /// Modal owner when the left mouse button was pressed.
    pub mouse_down_owner: Option<super::ModalOwner>,
    /// True once drag exceeds click threshold
    pub drag_selecting: bool,
    /// A Down-arm chrome claim consumed the press.
    pub suppress_click_on_up: bool,
    /// Active text selection in content-line coords
    pub selection: Option<ChatSelection>,
    /// Plain lines for the full chat document.
    pub chat_plain_lines: Vec<ChatPlainLine>,
    /// Per-entry parsed render cache keyed by chat entry id.
    pub chat_render_cache: HashMap<Uuid, Arc<RenderedChatBlock>>,
    /// Insertion order for `chat_render_cache` eviction.
    pub chat_cache_order: VecDeque<Uuid>,
    /// Frame-level snapshot of the rendered history.
    pub chat_frame_snapshot: Option<ChatFrameSnapshot>,
    /// Diagnostics: how many full history rebuilds the frame snapshot needed.
    pub chat_frame_rebuilds: u64,
    /// Incremental wrap state for the live streaming text.
    pub stream_markdown_cache: StreamMarkdownCache,

    // Performance & Animation
    pub fps: f64,
    pub fps_frame_count: u32,
    pub anim_frame: u64,
    pub anim_start: std::time::Instant,
    pub fps_last_time: std::time::Instant,
    pub message_fade: Option<super::anim::Tween>,
    pub surface_fade: Option<super::anim::Tween>,
    pub last_modal_owner: Option<super::ModalOwner>,
    pub hover_fade: Option<super::anim::Tween>,

    // Flags
    pub needs_render: bool,
    pub should_quit: bool,

    // Screen states
    pub show_welcome_screen: bool,
    pub welcome_selected: usize,
    pub recent_sessions: Vec<agente_core::session::SessionMeta>,
    pub show_help: bool,
}

impl Default for UiState {
    fn default() -> Self {
        let mut help_scroll = ScrollState::new(false);
        help_scroll.visible = 10;
        Self {
            tab_strip: super::TabStrip::default(),
            media_consent: None,
            diff_peek: None,
            diff_peek_scroll: ScrollState::new(false),
            plan_review_area: None,
            subagent_detail_area: None,
            subagent_detail_id: None,
            subagent_detail_scroll: ScrollState::new(false),
            subagent_detail_tab: SubagentDetailTab::Activity,
            subagent_detail_show_output: false,
            subagent_diff: None,
            chat_scroll: 0,
            chat_auto_scroll: true,
            scroll_target: None,
            reduce_motion: false,
            chat_content_height: 0,
            chat_visible_height: 0,
            chat_area_y: 0,
            chat_area_x: 0,
            scroll_drag: None,
            message_actions: None,
            process_view: None,
            jump_bottom_area: None,
            stop_hitbox: None,
            hits: super::hits::HitMap::default(),
            hovered_hit: None,
            click_regions: Vec::new(),
            expanded_message_ids: HashSet::new(),
            expanded_thinking_ids: HashSet::new(),
            tool_fold: HashMap::new(),
            expanded_groups: HashSet::new(),
            toast: None,
            help_scroll,
            hovered_entry_id: None,
            suppress_hover_until_move: false,
            last_stream_paint_at: None,
            mouse_down: None,
            mouse_down_owner: None,
            drag_selecting: false,
            suppress_click_on_up: false,
            mouse_pos: None,
            selection: None,
            chat_plain_lines: Vec::new(),
            chat_render_cache: HashMap::new(),
            chat_cache_order: VecDeque::new(),
            chat_frame_snapshot: None,
            chat_frame_rebuilds: 0,
            stream_markdown_cache: StreamMarkdownCache::default(),
            fps: 0.0,
            fps_frame_count: 0,
            anim_frame: 0,
            anim_start: std::time::Instant::now(),
            fps_last_time: std::time::Instant::now(),
            message_fade: None,
            surface_fade: None,
            last_modal_owner: None,
            hover_fade: None,
            needs_render: true,
            should_quit: false,
            show_welcome_screen: true,
            welcome_selected: 0,
            recent_sessions: Vec::new(),
            show_help: false,
        }
    }
}

impl UiState {
    pub fn open_subagent_detail(&mut self, id: String) {
        self.subagent_detail_id = Some(id);
        self.subagent_detail_show_output = false;
        self.subagent_detail_area = None;
        self.subagent_detail_scroll.reset(false);
        self.select_subagent_tab(SubagentDetailTab::Activity);
    }

    pub fn close_subagent_detail(&mut self) {
        self.subagent_detail_id = None;
        self.subagent_detail_area = None;
        self.subagent_diff = None;
        self.subagent_detail_scroll.reset(false);
        self.needs_render = true;
    }

    pub fn select_subagent_tab(&mut self, tab: SubagentDetailTab) {
        self.subagent_detail_tab = tab;
        self.subagent_detail_scroll.scroll_to_top();
        self.subagent_diff = None;
        self.needs_render = true;
    }

    /// Clear geometry and data tied to one project/session while preserving
    /// user-level display preferences.
    pub fn reset_for_workspace(&mut self) {
        self.diff_peek = None;
        self.diff_peek_scroll.reset(false);
        self.plan_review_area = None;
        self.chat_scroll = 0;
        self.chat_auto_scroll = true;
        self.scroll_target = None;
        self.chat_content_height = 0;
        self.chat_visible_height = 0;
        self.scroll_drag = None;
        self.jump_bottom_area = None;
        self.click_regions.clear();
        self.expanded_message_ids.clear();
        self.expanded_thinking_ids.clear();
        self.tool_fold.clear();
        self.expanded_groups.clear();
        self.toast = None;
        self.help_scroll.offset = 0;
        self.hovered_entry_id = None;
        self.suppress_hover_until_move = false;
        self.last_stream_paint_at = None;
        self.mouse_down = None;
        self.mouse_down_owner = None;
        self.drag_selecting = false;
        self.suppress_click_on_up = false;
        self.selection = None;
        self.chat_plain_lines.clear();
        self.clear_chat_render_cache();
        self.stream_markdown_cache = StreamMarkdownCache::default();
        self.show_welcome_screen = true;
        self.welcome_selected = 0;
        self.hovered_hit = None;
        self.show_help = false;
        self.needs_render = true;
    }

    /// Show a transient confirmation chip (auto-expires; display-only).
    pub fn show_toast(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), std::time::Instant::now()));
        self.needs_render = true;
    }

    /// The toast text while it is still fresh (2 s window).
    pub fn active_toast(&self) -> Option<&str> {
        let (text, at) = self.toast.as_ref()?;
        (at.elapsed().as_millis() < TOAST_LIFETIME_MS).then_some(text.as_str())
    }

    /// Drop an expired toast so its memory does not linger past its paint.
    pub fn clear_expired_toast(&mut self) {
        if self.toast.is_some() && self.active_toast().is_none() {
            self.toast = None;
            self.needs_render = true;
        }
    }

    /// Tick FPS counter and monotonic animation frame
    pub fn tick_fps(&mut self) {
        self.sample_animation_time(std::time::Instant::now());
        self.fps_frame_count += 1;
        let elapsed = self.fps_last_time.elapsed();
        if elapsed >= std::time::Duration::from_secs(1) {
            self.fps = self.fps_frame_count as f64 / elapsed.as_secs_f64();
            self.fps_frame_count = 0;
            self.fps_last_time = std::time::Instant::now();
        }
    }

    /// Paints sample one monotonic clock; faster input redraws never speed
    /// up spinners or breathing effects.
    pub fn sample_animation_time(&mut self, now: std::time::Instant) {
        let millis = now
            .saturating_duration_since(self.anim_start)
            .as_millis()
            .min(u64::MAX as u128) as u64;
        self.anim_frame = millis / 33;
    }

    /// Continuous elapsed time for animations in seconds
    pub fn anim_time_secs(&self) -> f32 {
        self.anim_start.elapsed().as_secs_f32()
    }

    /// Whether any continuous UI animation needs the Fast tick.
    pub fn has_active_animation(&self) -> bool {
        let running = |t: &Option<super::anim::Tween>| t.is_some_and(|t| t.running());
        running(&self.message_fade)
            || running(&self.surface_fade)
            || running(&self.hover_fade)
            || self.toast.is_some()
            || self.scroll_target.is_some()
    }

    /// Fade a newly-appended message in.
    pub fn trigger_message_fade(&mut self) {
        self.needs_render = true;
        if !self.reduce_motion {
            self.message_fade = Some(super::anim::Tween::start(super::anim::MESSAGE_MS));
        }
    }

    /// Point hover at `id`, easing the band in when it lands on a new card.
    pub fn set_hovered_entry(&mut self, id: Option<Uuid>) {
        if id != self.hovered_entry_id && id.is_some() && !self.reduce_motion {
            self.hover_fade = Some(super::anim::Tween::start(super::anim::HOVER_MS));
        }
        self.hovered_entry_id = id;
    }
}

#[cfg(test)]
mod interaction_state_tests {
    use super::*;

    #[test]
    fn tool_group_toggle_flips_membership() {
        let mut ui = UiState::default();
        let head = Uuid::new_v4();
        assert!(ui.expanded_groups.is_empty());

        ui.toggle_tool_group(head);
        assert!(ui.expanded_groups.contains(&head));
        ui.toggle_tool_group(head);
        assert!(!ui.expanded_groups.contains(&head));
    }

    #[test]
    fn tool_fold_cycles_from_the_effective_state() {
        let mut ui = UiState::default();
        let shell = Uuid::new_v4();
        let read = Uuid::new_v4();
        let grep = Uuid::new_v4();
        assert!(ui.tool_fold.is_empty());

        assert_eq!(ui.tool_fold_of(shell), Fold::Collapsed);
        assert_eq!(ui.tool_fold_of(read), Fold::Collapsed);
        assert_eq!(ui.tool_fold_of(grep), Fold::Collapsed);

        ui.cycle_tool_entry(shell);
        assert_eq!(ui.tool_fold_of(shell), Fold::Truncated);
        ui.cycle_tool_entry(shell);
        assert_eq!(ui.tool_fold_of(shell), Fold::Expanded);
        ui.cycle_tool_entry(shell);
        assert_eq!(ui.tool_fold_of(shell), Fold::Collapsed);
        ui.cycle_tool_entry(shell);
        assert_eq!(ui.tool_fold_of(shell), Fold::Truncated);

        ui.cycle_tool_entry(grep);
        assert_eq!(ui.tool_fold_of(grep), Fold::Truncated);

        ui.collapse_all_tools();
        assert!(ui.tool_fold.is_empty());
        assert_eq!(ui.tool_fold_of(shell), Fold::Collapsed);
    }

    #[test]
    fn fold_fingerprint_distinguishes_states_and_ids() {
        let mut ui = UiState::default();
        let base = ui.chat_expand_fingerprint();
        let id = Uuid::new_v4();

        ui.tool_fold.insert(id, Fold::Collapsed);
        let collapsed = ui.chat_expand_fingerprint();
        assert_ne!(collapsed, base, "an override entry must change the key");

        ui.tool_fold.insert(id, Fold::Expanded);
        let expanded = ui.chat_expand_fingerprint();
        assert_ne!(expanded, collapsed, "fold state must be part of the key");

        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let mut one = UiState::default();
        one.tool_fold.insert(a, Fold::Truncated);
        one.tool_fold.insert(b, Fold::Expanded);
        let mut two = UiState::default();
        two.tool_fold.insert(b, Fold::Expanded);
        two.tool_fold.insert(a, Fold::Truncated);
        assert_eq!(one.chat_expand_fingerprint(), two.chat_expand_fingerprint());

        let mut groups = UiState::default();
        groups.expanded_groups.insert(id);
        assert_ne!(groups.chat_expand_fingerprint(), base);
    }

    #[test]
    fn toast_is_fresh_then_expires() {
        let mut ui = UiState::default();
        assert!(ui.active_toast().is_none());

        ui.show_toast("✓ copied 3 lines");
        assert_eq!(ui.active_toast(), Some("✓ copied 3 lines"));
        ui.clear_expired_toast();
        assert!(ui.toast.is_some(), "fresh toast must survive cleanup");

        ui.toast = Some(("stale".into(), std::time::Instant::now()));
        ui.toast.as_mut().unwrap().1 = std::time::Instant::now()
            - std::time::Duration::from_millis(TOAST_LIFETIME_MS as u64 + 1);
        assert!(ui.active_toast().is_none());
        ui.clear_expired_toast();
        assert!(ui.toast.is_none());
    }

    #[test]
    fn help_scroll_clamps_to_last_page() {
        let mut ui = UiState::default();
        ui.help_scroll.visible = 14;

        ui.scroll_help(i32::MAX / 2);
        let max = crate::help::shortcut_count() - ui.help_scroll.visible;
        assert_eq!(ui.help_scroll.offset, max);

        ui.scroll_help(-(i32::MAX / 2));
        assert_eq!(ui.help_scroll.offset, 0);

        ui.scroll_help(3);
        assert_eq!(ui.help_scroll.offset, 3);
    }

    #[test]
    fn animation_phase_is_independent_of_paint_cadence() {
        let origin = std::time::Instant::now();
        for cadence in [16, 50, 83, 100] {
            let mut ui = UiState {
                anim_start: origin,
                ..UiState::default()
            };
            for elapsed in (0..=1600).step_by(cadence) {
                ui.sample_animation_time(origin + std::time::Duration::from_millis(elapsed));
            }
            ui.sample_animation_time(origin + std::time::Duration::from_millis(1600));
            assert_eq!(ui.anim_frame, 1600 / 33);
        }
    }

    #[test]
    fn stream_markdown_cache_handles_crlf_and_four_backtick_fences() {
        let mut cache = StreamMarkdownCache {
            width: 80,
            ..StreamMarkdownCache::default()
        };
        let doc = "intro\r\n````markdown\r\n```rust\r\nfn main() {}\r\n```\r\n````\r\nafter\r\n";
        while doc.len() > cache.settled {
            let rest = &doc[cache.settled..];
            let Some(pos) = rest.find('\n') else {
                break;
            };
            let line = &rest[..pos];
            cache.settled += pos + 1;
            cache.ingest_line(line, 80);
        }
        assert!(
            cache.fence_lang.is_none(),
            "outer 4-backtick fence should close cleanly after CRLF"
        );
        let joined = cache.plain.join("\n");
        assert!(joined.contains("intro"), "{joined}");
        assert!(
            joined.contains("```rust"),
            "inner 3-backtick fence must stay inside the 4-backtick code block: {joined}"
        );
        assert!(joined.contains("fn main() {}"), "{joined}");

        let mut ui = UiState {
            stream_markdown_cache: cache,
            ..Default::default()
        };
        ui.clear_chat_render_cache();
        assert_eq!(ui.stream_markdown_cache.settled, 0);
        assert!(ui.stream_markdown_cache.rows.is_empty());
    }

    #[test]
    fn cleaned_screen_text_strips_multibyte_whitespace_indent_by_chars() {
        let ui = UiState {
            chat_plain_lines: vec![
                ChatPlainLine {
                    entry_id: None,
                    plain: Arc::from("\u{3000}alpha"),
                },
                ChatPlainLine {
                    entry_id: None,
                    plain: Arc::from("\u{3000}\u{3000}beta"),
                },
            ],
            ..Default::default()
        };
        let cleaned = ui.cleaned_screen_text(0, 1, 0, 20);
        assert_eq!(cleaned, "alpha\n\u{3000}beta");
    }
}
