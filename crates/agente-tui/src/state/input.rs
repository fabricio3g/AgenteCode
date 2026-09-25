//! Input-related state management
//!
//! This module contains state related to user input:
//! - Input text buffer
//! - Cursor position
//! - Command history
//! - Slash commands and command palette
//! - Model selector
//!
//! Input state for user interaction

#[derive(Debug, Clone, Default)]
pub struct InputState {
    /// Current input text
    pub input_text: String,
    /// Cursor position in input
    pub input_cursor: usize,
    /// Input command history
    pub input_history: Vec<String>,
    /// Current history index
    pub input_history_index: usize,

    // Slash command picker
    /// Show slash command picker
    pub show_slash_picker: bool,
    /// Selected slash command index
    pub slash_picker_selected: usize,

    // @ file picker
    /// Show @ file mention picker
    pub show_at_picker: bool,
    /// Selected @ file index
    pub at_picker_selected: usize,
    /// Query after the active `@`
    pub at_picker_query: String,
    /// Char index of the active `@` in `input_text`
    pub at_picker_anchor: usize,
    /// Cached relative paths for the current project (filled on open)
    pub at_file_cache: Vec<String>,

    // Command palette
    /// Show command palette
    pub show_command_palette: bool,
    /// Command palette search query
    pub command_palette_query: String,
    /// Selected command palette entry
    pub command_palette_selected: usize,

    // Model selector
    /// Show model selector
    pub show_model_selector: bool,
    /// Model selector search query
    pub model_selector_query: String,
    /// Provider the model list is scoped to, cycled with Tab / arrow keys.
    ///
    /// `None` searches every connected provider at once. This used to live
    /// *inside* `model_selector_query`, so cycling the provider erased what you
    /// had typed and typing erased the provider.
    pub model_selector_provider: Option<String>,
    /// Selected model index
    pub model_selector_selected: usize,

    // Subagents popup (/subagents)
    /// Show the running/completed subagents list
    pub show_subagents: bool,
    /// Selected subagent index in the popup
    pub subagents_selected: usize,

    /// Large pastes held out of `input_text`, keyed by their placeholder.
    pub pasted_blocks: Vec<PastedBlock>,

    // Thinking-level selector (Ctrl+T / /thinking)
    /// Show the reasoning-effort picker for the current model.
    pub show_thinking_selector: bool,
    /// Selected row in the thinking picker.
    pub thinking_selector_selected: usize,
    /// Levels captured when the picker opened, so the list cannot shift under
    /// the cursor while the dialog is up and the widget never depends on a
    /// live catalog fetch mid-render.
    pub thinking_selector_levels: Vec<String>,

    // Terminal Doctor (/doctor)
    /// Show the /doctor environment diagnostics modal
    pub show_doctor: bool,
    /// Scroll offset in doctor dialog
    pub doctor_scroll: u16,
}

/// A large paste held out of the composer, referenced by a short placeholder.
///
/// Pasting a file or a stack trace used to splice the whole thing into
/// `input_text`, which the composer then tried to draw inside its 8-row cap:
/// unreadable and impossible to edit around. The payload lives here instead and
/// the composer shows a one-line chip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastedBlock {
    /// 1-based, stable for the lifetime of the draft; appears in the chip.
    pub id: usize,
    pub text: String,
    pub lines: usize,
}

impl PastedBlock {
    /// The token that stands in for this block inside `input_text`.
    pub fn placeholder(&self) -> String {
        format!("[#{} +{} lines]", self.id, self.lines)
    }
}

/// A paste at or above either bound collapses into a chip. Below both, it is
/// spliced inline where the user can still see and edit it.
pub const PASTE_CHIP_MIN_LINES: usize = 4;
pub const PASTE_CHIP_MIN_CHARS: usize = 400;

/// Whether a paste is large enough to be held out of the composer.
pub fn paste_wants_chip(text: &str) -> bool {
    text.lines().count() >= PASTE_CHIP_MIN_LINES || text.chars().count() >= PASTE_CHIP_MIN_CHARS
}

impl InputState {
    /// Submit current input and add to history.
    ///
    /// Paste placeholders are expanded here -- the single choke point every
    /// submission passes through -- so nothing downstream needs to know chips
    /// exist. History stores the compact form, which is what the user typed.
    pub fn submit_input(&mut self) -> Option<String> {
        if self.input_text.trim().is_empty() {
            return None;
        }
        let compact = self.input_text.trim().to_string();
        if !self.input_history.contains(&compact) {
            self.input_history.push(compact.clone());
        }
        self.input_history_index = self.input_history.len();

        let expanded = self.expand_pasted(&compact);
        self.input_text.clear();
        self.input_cursor = 0;
        self.pasted_blocks.clear();
        Some(expanded)
    }

    /// Replace every paste placeholder in `text` with its stored payload.
    pub fn expand_pasted(&self, text: &str) -> String {
        let mut out = text.to_string();
        for block in &self.pasted_blocks {
            out = out.replace(&block.placeholder(), &block.text);
        }
        out
    }

    /// Register a large paste and return the placeholder to insert in its place.
    pub fn stash_paste(&mut self, text: &str) -> String {
        let block = PastedBlock {
            id: self.pasted_blocks.len() + 1,
            lines: text.lines().count().max(1),
            text: text.to_string(),
        };
        let placeholder = block.placeholder();
        self.pasted_blocks.push(block);
        placeholder
    }

    /// The paste placeholder ending exactly at `cursor`, if any.
    ///
    /// Backspace uses this to delete a chip whole: erasing it one character at
    /// a time would leave `[#1 +142 line` behind, which no longer resolves to
    /// anything and would be sent to the model literally.
    pub fn placeholder_ending_at(&self, cursor: usize) -> Option<(usize, String)> {
        let chars: Vec<char> = self.input_text.chars().collect();
        self.pasted_blocks.iter().find_map(|block| {
            let token: Vec<char> = block.placeholder().chars().collect();
            let start = cursor.checked_sub(token.len())?;
            (chars.get(start..cursor)? == token.as_slice()).then(|| (start, block.placeholder()))
        })
    }

    /// Navigate up through history
    pub fn history_up(&mut self) {
        if self.input_history_index > 0 {
            self.input_history_index -= 1;
            if let Some(entry) = self.input_history.get(self.input_history_index) {
                self.input_text = entry.clone();
                self.input_cursor = self.input_text.chars().count();
            }
        }
    }

    /// Navigate down through history
    pub fn history_down(&mut self) {
        if self.input_history_index < self.input_history.len() {
            self.input_history_index += 1;
            if self.input_history_index < self.input_history.len() {
                if let Some(entry) = self.input_history.get(self.input_history_index) {
                    self.input_text = entry.clone();
                    self.input_cursor = self.input_text.chars().count();
                }
            } else {
                self.input_text.clear();
                self.input_cursor = 0;
            }
        }
    }

    /// Clear current input
    pub fn clear(&mut self) {
        self.input_text.clear();
        self.input_cursor = 0;
        self.pasted_blocks.clear();
    }

    /// Open the thinking-level picker, parked on the active level.
    pub fn open_thinking_selector(&mut self, levels: &[String], current: &str) {
        self.show_thinking_selector = true;
        self.thinking_selector_selected = levels.iter().position(|l| l == current).unwrap_or(0);
        self.thinking_selector_levels = levels.to_vec();
    }

    /// Close the thinking-level picker.
    pub fn close_thinking_selector(&mut self) {
        self.show_thinking_selector = false;
        self.thinking_selector_selected = 0;
        self.thinking_selector_levels.clear();
    }

    /// Close @ file picker
    pub fn close_at_picker(&mut self) {
        self.show_at_picker = false;
        self.at_picker_selected = 0;
        self.at_picker_query.clear();
        self.at_picker_anchor = 0;
    }

    /// Open the `/subagents` popup
    pub fn open_subagents(&mut self) {
        self.show_subagents = true;
        self.subagents_selected = 0;
    }

    /// Close the `/subagents` popup
    pub fn close_subagents(&mut self) {
        self.show_subagents = false;
        self.subagents_selected = 0;
    }
}

#[cfg(test)]
mod paste_tests {
    use super::*;

    fn big_paste(lines: usize) -> String {
        (0..lines)
            .map(|i| format!("line {i} of pasted content"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// A large paste is held out of the composer behind a one-line chip, and
    /// comes back in full at submit. Pasting a file used to splice the whole
    /// thing into an 8-row input box.
    #[test]
    fn a_large_paste_collapses_to_a_chip_and_expands_on_submit() {
        let payload = big_paste(200);
        let mut input = InputState::default();

        input.input_text.push_str("explain this ");
        input.input_cursor = input.input_text.chars().count();
        let placeholder = input.stash_paste(&payload);
        input.input_text.push_str(&placeholder);
        input.input_cursor = input.input_text.chars().count();

        assert_eq!(input.input_text, "explain this [#1 +200 lines]");
        assert!(
            input.input_text.chars().count() < 40,
            "composer should stay short: {:?}",
            input.input_text
        );

        let sent = input.submit_input().expect("submits");
        assert!(sent.starts_with("explain this "));
        assert!(sent.contains("line 0 of pasted content"));
        assert!(sent.contains("line 199 of pasted content"));
        assert!(
            input.pasted_blocks.is_empty(),
            "stash must not leak into the next message"
        );
    }

    /// Small pastes stay inline where they can be read and edited.
    #[test]
    fn a_small_paste_is_not_collapsed() {
        assert!(!paste_wants_chip("one\ntwo"));
        assert!(!paste_wants_chip(
            "a single long-ish line but under the cap"
        ));
        assert!(paste_wants_chip("a\nb\nc\nd"));
        assert!(paste_wants_chip(&"x".repeat(PASTE_CHIP_MIN_CHARS)));
    }

    /// Backspace removes a chip whole; a partially-chewed placeholder would be
    /// sent to the model as literal text.
    #[test]
    fn a_chip_is_matched_as_one_unit_at_the_cursor() {
        let mut input = InputState::default();
        let placeholder = input.stash_paste(&big_paste(12));
        input.input_text = format!("look at {placeholder}");
        input.input_cursor = input.input_text.chars().count();

        let (start, token) = input
            .placeholder_ending_at(input.input_cursor)
            .expect("chip ends at the cursor");
        assert_eq!(token, "[#1 +12 lines]");
        assert_eq!(start, "look at ".chars().count());

        // One char to the left, the cursor is inside the chip, not after it.
        assert!(input
            .placeholder_ending_at(input.input_cursor - 1)
            .is_none());
    }

    /// Two pastes keep distinct ids and both expand.
    #[test]
    fn multiple_chips_expand_independently() {
        let mut input = InputState::default();
        let first = input.stash_paste("a\na\na\na");
        let second = input.stash_paste("b\nb\nb\nb");
        assert_ne!(first, second);

        input.input_text = format!("{first} then {second}");
        let sent = input.submit_input().expect("submits");
        assert!(sent.starts_with("a\na\na\na"));
        assert!(sent.ends_with("b\nb\nb\nb"));
        assert!(sent.contains(" then "));
    }
}
