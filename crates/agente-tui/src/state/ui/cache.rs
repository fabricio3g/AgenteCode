//! Chat render caches, fold state, and incremental streaming markdown cache.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use agente_core::types::{ClickKind, ClickRegion};
use uuid::Uuid;

use super::UiState;

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
}

/// A chat entry's fully-parsed render block, cached so the markdown parser and
/// word-wrapping don't re-run for every entry on every frame. Invalidated when
/// any of the render inputs (`width`, expand flags) change. Hover is painted
/// as an overlay at frame time and never invalidates a block.
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

/// Everything a cached block's rendering depends on.
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
pub struct ChatFrameSnapshot {
    /// Chat content width the snapshot was laid out for.
    pub width: usize,
    /// `chat_history.len()` when the snapshot was built.
    pub history_len: usize,
    /// Id of the final history entry (nil when history is empty).
    pub last_entry_id: Uuid,
    /// Fingerprint of the expand sets (see `UiState::chat_expand_fingerprint`).
    pub expand_fingerprint: u64,
    /// `AgentRuntimeState::live_tools_epoch` when the snapshot was built.
    pub live_tools_epoch: u64,
    /// Fingerprint of the live subagent UI state (their cards read live state).
    pub subagent_fingerprint: u64,
    /// Plain-line count belonging to the history portion of `UiState::chat_plain_lines`.
    pub history_plain_len: usize,
    /// Styled line count of the history portion.
    pub history_line_count: usize,
    /// Rendered blocks in history order: (entry index, absolute start line, block).
    pub blocks: Vec<(usize, usize, Arc<RenderedChatBlock>)>,
    /// Click regions in absolute (unscrolled) content lines: (region, start line, end line exclusive).
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
    /// Bytes of the source already rendered into `rows`.
    pub consumed: usize,
    /// Bytes of the source ingested into `block_lines`.
    pub settled: usize,
    /// Syntax generation at render time: a `/theme` toggle invalidates the styled rows.
    pub generation: u64,
    /// Styled rows of completed blocks (markdown-rendered + wrapped).
    pub rows: Vec<ratatui::text::Line<'static>>,
    /// Plain-text mirror of `rows` (1:1) for selection/copy.
    pub plain: Vec<String>,
    /// Source lines of the block under construction.
    pub block_lines: Vec<String>,
    /// Language of the fence currently open (`""` = bare fence).
    pub fence_lang: Option<String>,
    /// Number of opening backticks for the active fence (at least 3).
    pub fence_ticks: usize,
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

    /// Close the open block: render it through the markdown pipeline, cache the
    /// styled rows, and clear the open-buffer state.
    fn flush_block(&mut self, width: usize) {
        if self.block_lines.is_empty() {
            self.fence_lang = None;
            self.fence_ticks = 0;
            return;
        }
        let source = self.block_lines.join("\n") + "\n";
        let rendered = crate::widgets::markdown::markdown_display_lines(&source, width.max(1));
        for line in rendered {
            let plain: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
            self.rows.push(line);
            self.plain.push(plain);
        }
        self.block_lines.clear();
        self.fence_lang = None;
        self.fence_ticks = 0;
    }

    /// Ingest one newline-terminated source line into the checkpoint model.
    pub fn ingest_line(&mut self, line: &str, width: usize) {
        let raw_len = line.len();
        let line = line.trim_end_matches('\r');
        if self.fence_lang.is_some() {
            let ticks = line.bytes().take_while(|&b| b == b'`').count();
            let closing = ticks >= self.fence_ticks.max(3) && line[ticks..].trim().is_empty();
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
            let ticks = line.bytes().take_while(|&b| b == b'`').count();
            self.flush_block(width);
            self.consumed = self.settled.saturating_sub(raw_len + 1);
            self.fence_lang = Some(line[ticks..].trim().to_string());
            self.fence_ticks = ticks;
            self.block_lines.push(line.to_string());
            return;
        }
        self.block_lines.push(line.to_string());
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

impl UiState {
    /// Look up a cached parsed block that still matches the given inputs.
    pub fn chat_cache_get(&self, id: &Uuid, key: ChatCacheKey) -> Option<Arc<RenderedChatBlock>> {
        self.chat_render_cache
            .get(id)
            .filter(|b| b.matches(key))
            .cloned()
    }

    /// Store a parsed block. When the cache reaches its cap, evict the oldest
    /// quarter (insertion order) instead of dropping everything.
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
    pub fn clear_chat_render_cache(&mut self) {
        self.chat_render_cache.clear();
        self.chat_cache_order.clear();
        self.chat_frame_snapshot = None;
        self.stream_markdown_cache.reset(0);
    }

    /// One cached block became stale (entry edited in place).
    pub fn invalidate_chat_entry(&mut self, id: &Uuid) {
        if self.chat_render_cache.remove(id).is_some() {
            self.chat_cache_order.retain(|x| x != id);
        }
        self.chat_frame_snapshot = None;
    }

    /// Order-independent fingerprint of the expand/hover inputs that shape history blocks.
    pub fn chat_expand_fingerprint(&self) -> u64 {
        fn fold_set(mut acc: u64, ids: &HashSet<Uuid>) -> u64 {
            acc = acc.wrapping_add(ids.len() as u64).rotate_left(7);
            for id in ids {
                acc ^= (id.as_u128() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
            }
            acc
        }
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
        fp ^= crate::style::syntax_generation().wrapping_mul(0xD6E8_FEB8_6659_FD93);
        fp
    }

    /// Effective fold of a tool card: the user override when present, else collapsed.
    pub fn tool_fold_of(&self, id: Uuid) -> Fold {
        self.tool_fold.get(&id).copied().unwrap_or(Fold::Collapsed)
    }

    /// Cycle a tool card Collapsed → Truncated → Expanded → Collapsed.
    pub fn cycle_tool_entry(&mut self, id: Uuid) {
        let next = match self.tool_fold_of(id) {
            Fold::Collapsed => Fold::Truncated,
            Fold::Truncated => Fold::Expanded,
            Fold::Expanded => Fold::Collapsed,
        };
        self.tool_fold.insert(id, next);
        self.needs_render = true;
    }

    /// Collapse every tool card at once.
    pub fn collapse_all_tools(&mut self) {
        self.tool_fold.clear();
        self.expanded_groups.clear();
        self.needs_render = true;
    }

    /// Expand/collapse a tool verb-group header.
    pub fn toggle_tool_group(&mut self, head_id: Uuid) {
        if !self.expanded_groups.remove(&head_id) {
            self.expanded_groups.insert(head_id);
        }
        self.needs_render = true;
    }
}
