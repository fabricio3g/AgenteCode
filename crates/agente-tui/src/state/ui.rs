//! UI-related state management
//!
//! This module contains state related to the terminal UI:
//! - Transcript geometry and interaction
//! - Chat scrolling and dimensions
//! - Click regions for interaction
//! - FPS tracking
//! - Visual effects

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;

use agente_core::types::{ClickKind, ClickRegion};
use ratatui::layout::Rect;
use uuid::Uuid;

/// How long a toast chip stays visible (display-only feedback).
const TOAST_LIFETIME_MS: u128 = 2_000;

/// In-progress drag selection in chat content coordinates.
#[derive(Debug, Clone, Copy)]
pub struct ChatSelection {
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
}

/// Three-state fold of a finished tool card.
///
/// - `Collapsed`: header row only (the default for most tools).
/// - `Truncated`: header + a short preview of the result.
/// - `Expanded`: header + the full head/tail window of the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Fold {
    #[default]
    Collapsed,
    Truncated,
    Expanded,
}

/// Plain-text line metadata built during chat render (for copy/select).
///
/// The text is `Arc<str>` so assembling `chat_plain_lines` from cached per-entry
/// blocks on every frame is a reference-count bump per line, never a deep
/// string copy (the hot path must not re-materialize styled offscreen rows).
#[derive(Debug, Clone)]
pub struct ChatPlainLine {
    pub entry_id: Option<Uuid>,
    pub plain: Arc<str>,
    pub is_thinking: bool,
}

/// A chat entry's fully-parsed render block, cached so the markdown parser and
/// word-wrapping don't re-run for every entry on every frame. Invalidated when
/// any of the render inputs (`width`, expand flags) change. Hover is painted
/// as an overlay at frame time and never invalidates a block.
///
/// The cache stores `Arc<RenderedChatBlock>`: a cache hit hands out the same
/// allocation instead of a deep clone. The render loop then uses each block's
/// `lines.len()` as a row count for cumulative layout and only clones the
/// *visible* window of styled lines for painting.
#[derive(Debug, Clone)]
pub struct RenderedChatBlock {
    pub width: usize,
    pub user_expanded: bool,
    pub thinking_expanded: bool,
    pub tool_fold: Fold,
    /// Gap rhythm input: the next rendered block is a dense (collapsed)
    /// tool card, so this block omits its trailing blank row.
    pub dense_next: bool,
    /// Parsed display lines for this entry (may wrap to multiple terminal rows).
    pub lines: Vec<ratatui::text::Line<'static>>,
    /// Plain-text mirror of `lines` (for selection/copy).
    pub plain: Vec<ChatPlainLine>,
    /// Click regions relative to this block: (start, end, kind, user_truncated).
    pub regions: Vec<(usize, usize, ClickKind, bool)>,
}

/// Everything a cached block's rendering depends on. Named rather than passed
/// positionally: the raw form was four adjacent `bool`s, which no call site
/// could be read against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatCacheKey {
    pub width: usize,
    pub user_expanded: bool,
    pub thinking_expanded: bool,
    pub tool_fold: Fold,
    pub dense_next: bool,
}

impl RenderedChatBlock {
    pub fn key(&self) -> ChatCacheKey {
        ChatCacheKey {
            width: self.width,
            user_expanded: self.user_expanded,
            thinking_expanded: self.thinking_expanded,
            tool_fold: self.tool_fold,
            dense_next: self.dense_next,
        }
    }

    pub fn matches(&self, key: ChatCacheKey) -> bool {
        self.key() == key
    }
}

/// Upper bound on cached chat blocks (sessions are immutable per-entry; the cap
/// prevents unbounded growth across tabs / reloads).
const MAX_CHAT_CACHE_BLOCKS: usize = 4096;

/// Frame-level snapshot of the rendered **history** portion of the transcript.
///
/// Building the chat frame used to walk every history entry each paint: cache
/// lookups per entry, an `Arc` bump per plain line, and a full `content_regions`
/// rebuild — all O(total transcript) work even when nothing but the streaming
/// tail changed. This snapshot caches the assembled result so a paint with an
/// unchanged history reuses the flat plain-line list (already stored in
/// `UiState::chat_plain_lines`), the block list and the click regions as-is.
///
/// Keyed by (chat width, history watermark = len + final entry id, expand-set
/// fingerprint, live-tool epoch, subagent fingerprint). Append-only growth
/// reuses the cached prefix and processes only the new entries (see
/// `widgets::chat`).
pub struct ChatFrameSnapshot {
    /// Chat content width the snapshot was laid out for.
    pub width: usize,
    /// `chat_history.len()` when the snapshot was built.
    pub history_len: usize,
    /// Id of the final history entry (nil when history is empty).
    pub last_entry_id: Uuid,
    /// Fingerprint of the expand sets (see
    /// `UiState::chat_expand_fingerprint`).
    pub expand_fingerprint: u64,
    /// `AgentRuntimeState::live_tools_epoch` when the snapshot was built.
    pub live_tools_epoch: u64,
    /// Fingerprint of the live subagent UI state (their cards read live state).
    pub subagent_fingerprint: u64,
    /// Plain-line count belonging to the history portion of
    /// `UiState::chat_plain_lines` (the rest is the streaming section).
    pub history_plain_len: usize,
    /// Styled line count of the history portion.
    pub history_line_count: usize,
    /// Rendered blocks in history order: (entry index, absolute start line, block).
    pub blocks: Vec<(usize, usize, Arc<RenderedChatBlock>)>,
    /// Click regions in absolute (unscrolled) content lines:
    /// (region, start line, end line exclusive).
    pub regions: Vec<(ClickRegion, usize, usize)>,
}

impl ChatFrameSnapshot {
    /// Cheap per-frame key comparison. History length / final entry id are
    /// compared by the caller (the append path needs them separately).
    pub(crate) fn matches(
        &self,
        width: usize,
        expand_fingerprint: u64,
        live_tools_epoch: u64,
        subagent_fingerprint: u64,
    ) -> bool {
        self.width == width
            && self.expand_fingerprint == expand_fingerprint
            && self.live_tools_epoch == live_tools_epoch
            && self.subagent_fingerprint == subagent_fingerprint
    }
}

/// Open-block line budget before the streaming renderer force-flushes a
/// checkpoint (see `StreamMarkdownCache::ingest_line`).
const MAX_OPEN_STREAM_LINES: usize = 48;

#[derive(Debug, Default)]
pub struct StreamMarkdownCache {
    /// Wrap width the cached rows were produced for.
    pub width: usize,
    /// Bytes of the source already rendered into `rows` (points just past the
    /// newline that closed a block boundary, or 0).
    pub consumed: usize,
    /// Bytes of the source ingested into `block_lines` (points just past the
    /// last newline seen — the append-only "settled" boundary). Everything
    /// between `consumed` and `settled` is the open block; after `settled`
    /// is the live partial line re-wrapped every frame.
    pub settled: usize,
    /// Syntax generation at render time: a `/theme` toggle invalidates the
    /// styled rows (syntect colors changed underneath them).
    pub generation: u64,
    /// Styled rows of completed blocks (markdown-rendered + wrapped).
    pub rows: Vec<ratatui::text::Line<'static>>,
    /// Plain-text mirror of `rows` (1:1) for selection/copy.
    pub plain: Vec<String>,
    /// Source lines of the block under construction: newline-terminated but
    /// the block has not closed yet (paragraph until blank, fence until ```).
    pub block_lines: Vec<String>,
    /// Language of the fence currently open (`""` = bare fence).
    pub fence_lang: Option<String>,
    /// First bytes of the settled prefix (corruption guard).
    pub head: [u8; 8],
    /// Last bytes of the settled prefix (corruption guard).
    pub tail: [u8; 8],
}

impl StreamMarkdownCache {
    /// Drop everything (width/theme change or append-only violation).
    pub fn reset(&mut self, width: usize) {
        let generation = self.generation;
        *self = Self {
            width,
            generation,
            ..Self::default()
        };
    }

    /// Close the open block: render it through the markdown pipeline (syntax
    /// highlighting, lists, tables all included), cache the styled rows, and
    /// clear the open-buffer state.
    fn flush_block(&mut self, width: usize) {
        if self.block_lines.is_empty() {
            self.fence_lang = None;
            return;
        }
        // Preserve source newlines exactly: a blank source line is a blank
        // rendered row, not an artificial gap inserted between checkpoints.
        let source = self.block_lines.join("\n") + "\n";
        let rendered = crate::widgets::markdown::markdown_display_lines(&source, width.max(1));
        for line in rendered {
            let plain: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
            self.rows.push(line);
            self.plain.push(plain);
        }
        self.block_lines.clear();
        self.fence_lang = None;
    }

    /// Ingest one newline-terminated source line into the checkpoint model.
    ///
    /// Boundaries are deliberately coarse: a blank line or a fence close
    /// flushes the open block (headings, lists, tables and rules render
    /// correctly INSIDE a block via the markdown pipeline), a fence opening
    /// flushes whatever preceded it. Everything else accumulates.
    pub fn ingest_line(&mut self, line: &str, width: usize) {
        if self.fence_lang.is_some() {
            let closing = line.starts_with("```");
            self.block_lines.push(line.to_string());
            if closing {
                self.flush_block(width);
                self.consumed = self.settled;
            }
            return;
        }
        if line.is_empty() {
            self.block_lines.push(String::new());
            self.flush_block(width);
            self.consumed = self.settled;
            return;
        }
        if line.starts_with("```") {
            self.flush_block(width);
            self.consumed = self.settled.saturating_sub(line.len() + 1);
            self.fence_lang = Some(line.trim_start_matches('`').trim().to_string());
            self.block_lines.push(line.to_string());
            return;
        }
        self.block_lines.push(line.to_string());
        // Auto-checkpoint: a very long open paragraph (no blank lines) would
        // otherwise be re-rendered by the markdown pipeline every frame. 48
        // source lines bounds that cost with no visible jump — the flush
        // renders the same markdown the live path would.
        // A table's column widths depend on its later rows. Keep the whole
        // table open until its boundary, even past the paragraph checkpoint.
        if self.block_lines.len() >= MAX_OPEN_STREAM_LINES && !line.trim_start().starts_with('|') {
            self.flush_block(width);
            self.consumed = self.settled;
        }
    }

    /// Refresh the O(1) prefix guards for the next frame's validation.
    pub fn refresh_guards(&mut self, text: &str) {
        if self.settled > 0 {
            let head_n = self.settled.min(8);
            self.head[..head_n].copy_from_slice(&text.as_bytes()[..head_n]);
            let tail_n = self.settled.min(8);
            self.tail[..tail_n]
                .copy_from_slice(&text.as_bytes()[self.settled - tail_n..self.settled]);
        }
    }
}

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

/// The live output view of one tool call (click a running tool row).
#[derive(Debug, Clone)]
pub struct ProcessView {
    /// Provider call id of the tool being watched.
    pub call_id: String,
    /// The call as it ended, kept so the view survives completion.
    pub finished: Option<super::LiveToolCall>,
    /// First visible output line.
    pub scroll: usize,
    /// Stick to the newest output (cleared by scrolling up).
    pub follow: bool,
    /// Scroll ceiling from the last paint.
    pub max_scroll: usize,
    /// Body rect from the last paint (wheel hit-testing).
    pub area: Option<Rect>,
}

impl ProcessView {
    pub fn open(call_id: String) -> Self {
        Self {
            call_id,
            finished: None,
            scroll: 0,
            follow: true,
            max_scroll: 0,
            area: None,
        }
    }

    pub fn scroll_by(&mut self, delta: isize) {
        self.follow = false;
        self.scroll = self
            .scroll
            .saturating_add_signed(delta)
            .min(self.max_scroll);
        if self.scroll >= self.max_scroll {
            self.follow = true;
        }
    }
}

/// UI state for layout and rendering
pub struct UiState {
    /// When set, show a full-width diff peek for this modified file (Esc closes).
    pub diff_peek: Option<String>,
    /// Screen rect of the plan review modal from the last render (for wheel scroll).
    pub plan_review_area: Option<Rect>,
    /// Screen rect of the subagent detail modal body (for wheel scroll).
    pub subagent_detail_area: Option<Rect>,
    /// Focused subagent for the detail modal (`SubagentDetail` owner).
    /// `Some(id)` opens the live view; `None` closes it.
    pub subagent_detail_id: Option<String>,
    /// Scroll offset inside the subagent detail modal body.
    pub subagent_detail_scroll: usize,
    pub subagent_detail_tab: SubagentDetailTab,
    pub subagent_detail_follow: bool,
    pub subagent_detail_show_output: bool,
    pub subagent_detail_max_scroll: usize,
    /// Worktree review loaded by `d` in the subagent detail modal. The outer
    /// `Some` means the diff view is toggled on; the inner `None` means the
    /// child's checkout has no changes (or no worktree at all).
    pub subagent_diff: Option<Option<String>>,
    // Chat state
    /// Chat scroll offset
    pub chat_scroll: usize,
    /// Auto-scroll chat to bottom
    pub chat_auto_scroll: bool,
    /// Where an eased scroll is heading; `chat_scroll` walks toward it one
    /// frame at a time (see `glide_by` / `step_scroll`).
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
    /// Last known mouse position (screen coords) — drives hover highlights
    /// on interactive chips like `[stop]` and the jump-to-bottom control.
    pub mouse_pos: Option<(u16, u16)>,
    /// Sent message whose action dialog (revert / fork / copy) is open.
    pub message_actions: Option<Uuid>,
    /// Live output view of a running (or just finished) tool call.
    pub process_view: Option<ProcessView>,
    /// Hit target for the jump-to-bottom control (set each paint when visible).
    pub jump_bottom_area: Option<Rect>,
    /// Hit target for the `[stop]` button in the activity strip (set each
    /// paint while the strip is visible).
    pub stop_hitbox: Option<Rect>,

    /// Interactive regions painted last frame (list rows, dialog buttons).
    pub hits: super::hits::HitMap,
    /// Hit target under the pointer, for hover highlights on buttons.
    pub hovered_hit: Option<super::hits::HitTarget>,

    // Interaction
    /// Clickable regions for mouse interaction
    pub click_regions: Vec<ClickRegion>,
    /// Expanded user message ids (long paste / multi-line)
    pub expanded_message_ids: HashSet<Uuid>,
    /// Expanded thinking cards (finished turns), keyed by assistant entry id
    pub expanded_thinking_ids: HashSet<Uuid>,
    /// Per-tool-card fold overrides (default comes from `default_tool_fold`).
    pub tool_fold: HashMap<Uuid, Fold>,
    /// Verb-group headers the user expanded, keyed by the group's first
    /// member's entry id (see `widgets::chat::derive_tool_groups`).
    pub expanded_groups: HashSet<Uuid>,
    /// Transient confirmation chip: (text, shown-at). Display-only — never
    /// persisted, auto-expires (see `active_toast`).
    pub toast: Option<(String, std::time::Instant)>,
    /// Help overlay scroll offset (first visible shortcut row).
    pub help_scroll: u16,
    /// Visible shortcut rows from the last help render (for scroll clamping).
    pub help_visible: u16,
    /// Entry currently under the mouse (message hover border)
    pub hovered_entry_id: Option<Uuid>,
    /// After toggling thinking, ignore hover until the pointer moves so the
    /// layout shift under the cursor does not paint borders on a neighbor.
    pub suppress_hover_until_move: bool,
    /// Last time we painted while streaming (throttle full-frame redraws so
    /// the main loop can still poll keys — prevents "UI freezes all").
    pub last_stream_paint_at: Option<std::time::Instant>,
    /// Mouse down origin for drag threshold
    pub mouse_down: Option<(u16, u16)>,
    /// True once drag exceeds click threshold
    pub drag_selecting: bool,
    /// A Down-arm chrome claim (jump-to-bottom chip) consumed the press: skip
    /// the Up-arm click dispatch so the release can't toggle whatever row the
    /// pointer drifted onto.
    pub suppress_click_on_up: bool,
    /// Active text selection in content-line coords
    pub selection: Option<ChatSelection>,
    /// Plain lines for the full chat document. The history portion is built
    /// once per history change (see `chat_frame_snapshot`) and extended in
    /// place with the streaming section each frame, so the common streaming
    /// paint never re-assembles the transcript.
    pub chat_plain_lines: Vec<ChatPlainLine>,
    /// Per-entry parsed render cache keyed by chat entry id. `Arc` so a cache
    /// hit never deep-clones the styled lines; the render loop materializes
    /// only the visible window.
    pub chat_render_cache: HashMap<Uuid, Arc<RenderedChatBlock>>,
    /// Insertion order for `chat_render_cache` so eviction can drop the oldest
    /// quarter instead of clearing everything.
    pub chat_cache_order: VecDeque<Uuid>,
    /// Frame-level snapshot of the rendered history (see `ChatFrameSnapshot`).
    pub chat_frame_snapshot: Option<ChatFrameSnapshot>,
    /// Diagnostics: how many full history rebuilds the frame snapshot needed.
    pub chat_frame_rebuilds: u64,
    /// Incremental wrap state for the live streaming text.
    pub stream_markdown_cache: StreamMarkdownCache,

    // Performance & Animation
    /// Current FPS
    pub fps: f64,
    /// FPS frame counter (for sampling calculations)
    pub fps_frame_count: u32,
    /// Monotonic animation frame counter that never resets
    pub anim_frame: u64,
    /// Timestamp when animation clock began
    pub anim_start: std::time::Instant,
    /// Last FPS update time
    pub fps_last_time: std::time::Instant,
    /// Last frame time for effects
    pub last_frame_time: std::time::Instant,
    /// Effect manager
    /// When the current message fade-in began, if one is running.
    pub message_fade: Option<super::anim::Tween>,
    /// Ease-in for a surface that just appeared (a dialog, or the empty chat
    /// after the hero is dismissed).
    pub surface_fade: Option<super::anim::Tween>,
    /// Modal owner painted last frame (to detect a dialog opening).
    pub last_modal_owner: Option<super::ModalOwner>,
    /// Hover band ease-in for the hovered chat card.
    pub hover_fade: Option<super::anim::Tween>,

    // Flags
    /// Needs re-render
    pub needs_render: bool,
    /// Should quit application
    pub should_quit: bool,

    // Screen states
    /// Show welcome screen
    pub show_welcome_screen: bool,
    /// Selected welcome action button index
    pub welcome_selected: usize,
    /// Recent sessions for the session picker (capped, newest first).
    pub recent_sessions: Vec<agente_core::session::SessionMeta>,
    /// Show keyboard help overlay
    pub show_help: bool,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            diff_peek: None,
            plan_review_area: None,
            subagent_detail_area: None,
            subagent_detail_id: None,
            subagent_detail_scroll: 0,
            subagent_detail_tab: SubagentDetailTab::Activity,
            subagent_detail_follow: false,
            subagent_detail_show_output: false,
            subagent_detail_max_scroll: 0,
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
            help_scroll: 0,
            help_visible: 10,
            hovered_entry_id: None,
            suppress_hover_until_move: false,
            last_stream_paint_at: None,
            mouse_down: None,
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
            last_frame_time: std::time::Instant::now(),
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

impl UiState {
    /// True when the last known pointer position lies inside `rect`.
    pub fn pointer_in(&self, rect: Rect) -> bool {
        self.mouse_pos
            .is_some_and(|(x, y)| rect.contains(ratatui::layout::Position::new(x, y)))
    }

    pub fn open_subagent_detail(&mut self, id: String) {
        self.subagent_detail_id = Some(id);
        self.subagent_detail_show_output = false;
        self.subagent_detail_area = None;
        self.subagent_detail_max_scroll = 0;
        self.select_subagent_tab(SubagentDetailTab::Activity);
    }

    pub fn close_subagent_detail(&mut self) {
        self.subagent_detail_id = None;
        self.subagent_detail_area = None;
        self.subagent_diff = None;
        self.subagent_detail_scroll = 0;
        self.subagent_detail_max_scroll = 0;
        self.subagent_detail_follow = false;
        self.needs_render = true;
    }

    pub fn select_subagent_tab(&mut self, tab: SubagentDetailTab) {
        self.subagent_detail_tab = tab;
        self.subagent_detail_scroll = 0;
        self.subagent_detail_follow = false;
        self.subagent_diff = None;
        self.needs_render = true;
    }

    pub fn scroll_subagent_detail(&mut self, delta: i32) {
        self.subagent_detail_follow = false;
        self.subagent_detail_scroll = if delta < 0 {
            self.subagent_detail_scroll
                .saturating_sub(delta.unsigned_abs() as usize)
        } else {
            self.subagent_detail_scroll
                .saturating_add(delta as usize)
                .min(self.subagent_detail_max_scroll)
        };
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

    /// Glide to the bottom of the transcript, then re-pin. The target is
    /// resolved against the *current* content height each frame, so content
    /// that grows while gliding (a new message) is still where it lands.
    pub fn glide_to_bottom(&mut self) {
        if self.reduce_motion {
            self.chat_auto_scroll = true;
            return;
        }
        self.chat_auto_scroll = false;
        self.scroll_target = Some(usize::MAX);
        self.needs_render = true;
    }

    /// Eased scroll by `delta` rows (negative = up). The viewport walks toward
    /// the target over the next frames (see [`Self::step_scroll`]). Repeated
    /// input stacks onto the pending target, so a fast wheel spin travels
    /// further than the same notches spread out.
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
    /// distance (at least one row), an ease-out that settles a wheel notch in
    /// two frames and a full page in about five. Returns `true` while moving.
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

    /// True when the viewport is at (or within one row of) the bottom.
    pub fn is_near_bottom(&self) -> bool {
        let max = self.max_scroll();
        self.chat_scroll >= max.saturating_sub(1)
    }

    /// Re-enable auto-follow only if the user is already pinned to the bottom.
    /// Used after stream/subagent events so mid-history reading is never yanked.
    pub fn follow_bottom_if_pinned(&mut self) {
        if self.is_near_bottom() {
            self.chat_auto_scroll = true;
            self.chat_scroll = self.max_scroll();
        }
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
    pub fn set_chat_dimensions(&mut self, content_height: usize, visible_height: usize) {
        self.chat_content_height = content_height;
        self.chat_visible_height = visible_height;
        if self.chat_auto_scroll {
            self.chat_scroll = self.max_scroll();
        } else {
            self.chat_scroll = self.chat_scroll.min(self.max_scroll());
        }
    }

    /// Update clickable regions
    pub fn update_click_regions(&mut self, regions: Vec<ClickRegion>) {
        self.click_regions = regions;
    }

    /// Look up a cached parsed block that still matches the given inputs.
    pub fn chat_cache_get(&self, id: &Uuid, key: ChatCacheKey) -> Option<Arc<RenderedChatBlock>> {
        self.chat_render_cache
            .get(id)
            .filter(|b| b.matches(key))
            .cloned()
    }

    /// Store a parsed block. When the cache reaches its cap, evict the oldest
    /// quarter (insertion order) instead of dropping everything — a clear-all
    /// made every history block re-run markdown + syntect on the next frame.
    pub fn chat_cache_put(&mut self, id: Uuid, block: RenderedChatBlock) -> Arc<RenderedChatBlock> {
        if !self.chat_render_cache.contains_key(&id) {
            if self.chat_render_cache.len() >= MAX_CHAT_CACHE_BLOCKS {
                let evict = MAX_CHAT_CACHE_BLOCKS / 4;
                for _ in 0..evict {
                    let Some(oldest) = self.chat_cache_order.pop_front() else {
                        break;
                    };
                    self.chat_render_cache.remove(&oldest);
                }
            }
            self.chat_cache_order.push_back(id);
        }
        let block = Arc::new(block);
        self.chat_render_cache.insert(id, Arc::clone(&block));
        block
    }

    /// Drop all cached chat blocks (session cleared / reloaded / switched).
    /// Also drops the frame snapshot and the eviction order, which both
    /// reference block identities.
    pub fn clear_chat_render_cache(&mut self) {
        self.chat_render_cache.clear();
        self.chat_cache_order.clear();
        self.chat_frame_snapshot = None;
    }

    /// One cached block became stale (entry edited in place). The block must
    /// re-render and the frame snapshot cannot be trusted for the layout.
    pub fn invalidate_chat_entry(&mut self, id: &Uuid) {
        if self.chat_render_cache.remove(id).is_some() {
            self.chat_cache_order.retain(|x| x != id);
        }
        self.chat_frame_snapshot = None;
    }

    /// Order-independent fingerprint of the expand/hover inputs that shape
    /// history blocks. Cheap: the sets only hold user-toggled entries.
    pub fn chat_expand_fingerprint(&self) -> u64 {
        fn fold_set(mut acc: u64, ids: &HashSet<Uuid>) -> u64 {
            acc = acc.wrapping_add(ids.len() as u64).rotate_left(7);
            for id in ids {
                acc ^= (id.as_u128() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
            }
            acc
        }
        // Fold overrides mix the state into the rotation so the same id in a
        // different fold state hashes differently.
        fn fold_map(mut acc: u64, map: &HashMap<Uuid, Fold>) -> u64 {
            acc = acc.wrapping_add(map.len() as u64).rotate_left(7);
            for (id, fold) in map {
                acc ^= (id.as_u128() as u64)
                    .wrapping_mul(0x9E37_79B9_7F4A_7C15)
                    .rotate_left(1 + *fold as u32)
                    ^ (*fold as u64);
            }
            acc
        }
        let mut fp = 0x517C_C1B7_2722_0A95;
        fp = fold_set(fp, &self.expanded_message_ids);
        fp = fold_set(fp, &self.expanded_thinking_ids);
        fp = fold_map(fp, &self.tool_fold);
        fp = fold_set(fp, &self.expanded_groups);
        // A `/theme` toggle swaps the syntect highlight theme: every cached
        // code block must re-render, so the generation mixes in here.
        fp ^= crate::style::syntax_generation().wrapping_mul(0xD6E8_FEB8_6659_FD93);
        fp
    }

    /// Clear geometry and data tied to one project/session while preserving
    /// user-level display preferences.
    pub fn reset_for_workspace(&mut self) {
        self.diff_peek = None;
        self.plan_review_area = None;
        self.chat_scroll = 0;
        self.chat_auto_scroll = true;
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
        self.help_scroll = 0;
        self.hovered_entry_id = None;
        self.suppress_hover_until_move = false;
        self.last_stream_paint_at = None;
        self.mouse_down = None;
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

    /// Find click region at screen Y position.
    /// Prefer Thinking over Tool over Message when rows would otherwise collide.
    pub fn find_click_region(&self, y: u16) -> Option<&ClickRegion> {
        use agente_core::types::ClickKind;
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

    /// Find clicked entry at Y position
    pub fn find_clicked_entry(&self, y: u16) -> Option<uuid::Uuid> {
        self.find_click_region(y).map(|r| r.entry_id)
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
    ///
    /// Quality rules (concise user-facing copy):
    /// - A contiguous run of rows that fully covers one chat entry copies the
    ///   entry's SOURCE text (markdown, unwrapped) instead of the wrapped
    ///   screen projection with indent spaces, icons and timestamps.
    /// - Partial selections copy the on-screen substring, cleaned: edge
    ///   blank rows dropped, trailing spaces stripped, and the common
    ///   leading indent removed so pasted code and quotes keep their shape.
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
                    // Extend the run over consecutive rows of the same entry.
                    let mut end = idx;
                    while end < el && self.chat_plain_lines[end + 1].entry_id == Some(id) {
                        end += 1;
                    }
                    let row_width = self.chat_plain_lines[end].plain.chars().count();
                    // Full coverage: the run starts at the selection's first
                    // row with column 0, ends at its last row through the row
                    // width, and interior runs are bounded by other entries.
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
    /// applied on the edge rows, then cleaned: trailing spaces stripped,
    /// edge blank rows dropped, common leading indent removed.
    fn cleaned_screen_text(&self, first: usize, last: usize, sc: usize, ec: usize) -> String {
        let mut lines: Vec<String> = Vec::new();
        for i in first..=last {
            let line = &self.chat_plain_lines[i].plain;
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
            .map(|l| l.len() - l.trim_start().len())
            .min()
            .unwrap_or(0);
        lines
            .iter()
            .map(|l| l.trim_end().chars().skip(indent).collect::<String>())
            .collect::<Vec<_>>()
            .join(
                "
",
            )
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

fn ordered_selection(sel: ChatSelection) -> (usize, usize, usize, usize) {
    if (sel.start_line, sel.start_col) <= (sel.end_line, sel.end_col) {
        (sel.start_line, sel.start_col, sel.end_line, sel.end_col)
    } else {
        (sel.end_line, sel.end_col, sel.start_line, sel.start_col)
    }
}

impl UiState {
    /// Completed tools start compact; click/Enter reveals preview and output.
    pub fn default_tool_fold(_tool_name: Option<&str>) -> Fold {
        Fold::Collapsed
    }

    /// Effective fold of a tool card: the user override when present, else the
    /// tool's default.
    pub fn tool_fold_of(&self, id: Uuid, tool_name: Option<&str>) -> Fold {
        self.tool_fold
            .get(&id)
            .copied()
            .unwrap_or_else(|| Self::default_tool_fold(tool_name))
    }

    /// Cycle a tool card Collapsed → Truncated → Expanded → Collapsed,
    /// starting from its *effective* state (override or default).
    pub fn cycle_tool_entry(&mut self, id: Uuid, tool_name: Option<&str>) {
        let next = match self.tool_fold_of(id, tool_name) {
            Fold::Collapsed => Fold::Truncated,
            Fold::Truncated => Fold::Expanded,
            Fold::Expanded => Fold::Collapsed,
        };
        self.tool_fold.insert(id, next);
        self.needs_render = true;
    }

    /// Collapse every tool card at once (drops all overrides; defaults are
    /// implicit and need no entries).
    pub fn collapse_all_tools(&mut self) {
        self.tool_fold.clear();
        self.expanded_groups.clear();
        self.needs_render = true;
    }

    /// Expand/collapse a tool verb-group header (keyed by the first member's
    /// entry id).
    pub fn toggle_tool_group(&mut self, head_id: Uuid) {
        if !self.expanded_groups.remove(&head_id) {
            self.expanded_groups.insert(head_id);
        }
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

    /// Scroll the help overlay, keeping the last page reachable.
    pub fn scroll_help(&mut self, delta: i32) {
        let visible = self.help_visible.max(1) as usize;
        let total = crate::help::shortcut_count();
        let max = total.saturating_sub(visible);
        let current = self.help_scroll as isize + delta as isize;
        self.help_scroll = current.clamp(0, max as isize) as u16;
        self.needs_render = true;
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

    /// Whether any continuous UI animation needs the Fast tick (message fade,
    /// toast). The welcome starfield runs on its own Slow path and approval
    /// pulses gate on agent state — neither belongs here, or idle welcome
    /// would pin the loop at 16ms forever.
    pub fn has_active_animation(&self) -> bool {
        let running = |t: &Option<super::anim::Tween>| t.is_some_and(|t| t.running());
        running(&self.message_fade)
            || running(&self.surface_fade)
            || running(&self.hover_fade)
            || self.toast.is_some()
            || self.scroll_target.is_some()
    }

    /// Tick effects and return delta time
    pub fn tick_effects(&mut self) -> std::time::Duration {
        let now = std::time::Instant::now();
        let dt = now.duration_since(self.last_frame_time);
        self.last_frame_time = now;
        dt
    }

    /// Fade a newly-appended message in.
    ///
    /// This was inert in three separate ways: `fade_from(bg, bg, …)`
    /// interpolates from the background *to the background*, nothing ever
    /// pumped the effect queue, and `tachyonfx` 0.25 is built against
    /// `ratatui-core` -- a different major line from the `ratatui` 0.29 this
    /// crate uses -- so its `process_effects` could not even be called. The
    /// fade is a few lines of blending we own instead of a dependency that
    /// cannot compile against our buffer type.
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

    /// Request re-render
    pub fn request_render(&mut self) {
        self.needs_render = true;
    }
}

#[cfg(test)]
mod scroll_follow_tests {
    use super::*;

    /// A transcript longer than 65,535 rendered rows must still scroll to its
    /// own end. The row count used to be clamped into a `u16`, so past that
    /// ceiling `chat_scroll` stopped tracking the content: auto-scroll pinned
    /// to row 65,515 and the tail of the conversation was unreachable.
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

        // Stacked input extends the pending target.
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
    fn follow_bottom_if_pinned_leaves_mid_history_alone() {
        let mut ui = UiState {
            chat_content_height: 100,
            chat_visible_height: 20,
            chat_scroll: 10,
            chat_auto_scroll: false,
            ..UiState::default()
        };
        ui.follow_bottom_if_pinned();
        assert!(!ui.chat_auto_scroll);
        assert_eq!(ui.chat_scroll, 10);
        assert!(ui.show_jump_to_bottom());
    }

    #[test]
    fn follow_bottom_if_pinned_re_enables_at_bottom() {
        let mut ui = UiState::default();
        ui.chat_content_height = 100;
        ui.chat_visible_height = 20;
        ui.chat_scroll = ui.max_scroll();
        ui.chat_auto_scroll = false;
        ui.follow_bottom_if_pinned();
        assert!(ui.chat_auto_scroll);
        assert_eq!(ui.chat_scroll, ui.max_scroll());
        assert!(!ui.show_jump_to_bottom());
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
        // Simulate paint: content grows (streaming) while unpinned.
        ui.set_chat_dimensions(80, 20);
        assert!(!ui.chat_auto_scroll);
        assert_eq!(ui.chat_scroll, 5);
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

        // Every finished tool starts compact.
        assert_eq!(ui.tool_fold_of(shell, Some("shell")), Fold::Collapsed);
        assert_eq!(ui.tool_fold_of(read, Some("read_file")), Fold::Collapsed);
        assert_eq!(ui.tool_fold_of(grep, Some("grep")), Fold::Collapsed);
        assert_eq!(ui.tool_fold_of(grep, None), Fold::Collapsed);
        assert_eq!(UiState::default_tool_fold(None), Fold::Collapsed);

        // Cycle through preview and expanded output, then back to the header.
        ui.cycle_tool_entry(shell, Some("shell"));
        assert_eq!(ui.tool_fold_of(shell, Some("shell")), Fold::Truncated);
        ui.cycle_tool_entry(shell, Some("shell"));
        assert_eq!(ui.tool_fold_of(shell, Some("shell")), Fold::Expanded);
        ui.cycle_tool_entry(shell, Some("shell"));
        assert_eq!(ui.tool_fold_of(shell, Some("shell")), Fold::Collapsed);
        ui.cycle_tool_entry(shell, Some("shell"));
        assert_eq!(ui.tool_fold_of(shell, Some("shell")), Fold::Truncated);

        // Collapsed default cycles Collapsed → Truncated.
        ui.cycle_tool_entry(grep, Some("grep"));
        assert_eq!(ui.tool_fold_of(grep, Some("grep")), Fold::Truncated);

        // collapse_all_tools drops every override.
        ui.collapse_all_tools();
        assert!(ui.tool_fold.is_empty());
        assert_eq!(ui.tool_fold_of(shell, Some("shell")), Fold::Collapsed);
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

        // Order independence: a second id hashes to the same value either way.
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let mut one = UiState::default();
        one.tool_fold.insert(a, Fold::Truncated);
        one.tool_fold.insert(b, Fold::Expanded);
        let mut two = UiState::default();
        two.tool_fold.insert(b, Fold::Expanded);
        two.tool_fold.insert(a, Fold::Truncated);
        assert_eq!(one.chat_expand_fingerprint(), two.chat_expand_fingerprint());

        // Groups are part of the key too.
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

        // Age past the lifetime, then clear.
        ui.toast = Some(("stale".into(), std::time::Instant::now()));
        ui.toast.as_mut().unwrap().1 = std::time::Instant::now()
            - std::time::Duration::from_millis(TOAST_LIFETIME_MS as u64 + 1);
        assert!(ui.active_toast().is_none());
        ui.clear_expired_toast();
        assert!(ui.toast.is_none());
    }

    #[test]
    fn help_scroll_clamps_to_last_page() {
        let mut ui = UiState {
            help_visible: 14,
            ..UiState::default()
        };

        ui.scroll_help(i32::MAX / 2);
        let max = crate::help::shortcut_count() as u16 - ui.help_visible;
        assert_eq!(ui.help_scroll, max);

        ui.scroll_help(-(i32::MAX / 2));
        assert_eq!(ui.help_scroll, 0);

        ui.scroll_help(3);
        assert_eq!(ui.help_scroll, 3);
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
}
