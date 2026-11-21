//! Shared single-line text editing and picker list navigation helpers.
//!
//! Centralizes the keyboard text-input rules (`is_text_char_modifiers` +
//! `resolve_text_char`), list-selection stepping (`step_list_selection`), and
//! filter-query editing (`edit_filter_query`) shared across modals.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// Whether this modifier combo should insert a printable character into free text.
///
/// Allows bare keys, Shift, Alt, and AltGr (Ctrl+Alt). Pure Ctrl is reserved for
/// shortcuts (Ctrl+A/E/K/…); those arms match first via exact CONTROL checks.
pub(crate) fn is_text_char_modifiers(m: KeyModifiers) -> bool {
    let ctrl = m.contains(KeyModifiers::CONTROL);
    let alt = m.contains(KeyModifiers::ALT);
    // Pure Control → shortcut, not text
    !(ctrl && !alt)
}

/// Map OS key to the character we insert (layout / Alt helpers).
///
/// On many Spanish/Latin layouts users expect Alt+Q for `@`. The terminal may
/// report either `Char('@')` with Alt/AltGr, or `Char('q')` with Alt — both work.
pub(crate) fn resolve_text_char(c: char, m: KeyModifiers) -> char {
    let alt = m.contains(KeyModifiers::ALT);
    let ctrl = m.contains(KeyModifiers::CONTROL);
    // Alt+Q → @ when the OS still reports 'q' (not already '@')
    if alt && !ctrl && matches!(c, 'q' | 'Q') {
        return '@';
    }
    c
}

/// Step a list selection index on `Up` / `Down` (clamped to `0..len`).
/// Returns `true` when `code` was handled.
pub(crate) fn step_list_selection(selected: &mut usize, len: usize, code: KeyCode) -> bool {
    match code {
        KeyCode::Up => {
            *selected = selected.saturating_sub(1);
            true
        }
        KeyCode::Down => {
            if len > 0 {
                *selected = (*selected + 1).min(len - 1);
            }
            true
        }
        _ => false,
    }
}

/// Step a list selection index with wrapping on `Up` / `Down`.
/// Returns `true` when `code` was handled.
pub(crate) fn step_list_selection_wrap(selected: &mut usize, len: usize, code: KeyCode) -> bool {
    match code {
        KeyCode::Up => {
            if len > 0 {
                *selected = if *selected == 0 {
                    len - 1
                } else {
                    *selected - 1
                };
            }
            true
        }
        KeyCode::Down => {
            if len > 0 {
                *selected = (*selected + 1) % len;
            }
            true
        }
        _ => false,
    }
}

/// Apply Backspace / printable text input to a single-line field.
/// Returns `true` when `key` was consumed.
pub(crate) fn edit_single_line(text: &mut String, key: KeyEvent) -> bool {
    match key.code {
        KeyCode::Backspace => {
            text.pop();
            true
        }
        KeyCode::Char(c) if is_text_char_modifiers(key.modifiers) => {
            text.push(resolve_text_char(c, key.modifiers));
            true
        }
        _ => false,
    }
}

/// Apply Backspace / printable text input to a picker's filter query, resetting
/// `selected` to `0` on any edit. Returns `true` when `key` was consumed.
pub(crate) fn edit_filter_query(query: &mut String, selected: &mut usize, key: KeyEvent) -> bool {
    if edit_single_line(query, key) {
        *selected = 0;
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_char_modifiers_reject_pure_ctrl_and_allow_altgr() {
        assert!(is_text_char_modifiers(KeyModifiers::NONE));
        assert!(is_text_char_modifiers(KeyModifiers::SHIFT));
        assert!(is_text_char_modifiers(KeyModifiers::ALT));
        assert!(is_text_char_modifiers(
            KeyModifiers::CONTROL | KeyModifiers::ALT
        ));
        assert!(!is_text_char_modifiers(KeyModifiers::CONTROL));
        assert_eq!(resolve_text_char('q', KeyModifiers::ALT), '@');
        assert_eq!(resolve_text_char('a', KeyModifiers::NONE), 'a');
    }

    #[test]
    fn step_list_selection_clamps_and_wraps() {
        let mut idx = 0;
        assert!(step_list_selection(&mut idx, 3, KeyCode::Up));
        assert_eq!(idx, 0);
        assert!(step_list_selection(&mut idx, 3, KeyCode::Down));
        assert_eq!(idx, 1);
        assert!(step_list_selection(&mut idx, 3, KeyCode::Down));
        assert!(step_list_selection(&mut idx, 3, KeyCode::Down));
        assert_eq!(idx, 2);

        let mut wrap = 0;
        assert!(step_list_selection_wrap(&mut wrap, 3, KeyCode::Up));
        assert_eq!(wrap, 2);
        assert!(step_list_selection_wrap(&mut wrap, 3, KeyCode::Down));
        assert_eq!(wrap, 0);
    }

    #[test]
    fn edit_filter_query_updates_text_and_resets_selection() {
        let mut q = String::new();
        let mut sel = 4;
        assert!(edit_filter_query(
            &mut q,
            &mut sel,
            KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE)
        ));
        assert_eq!(q, "a");
        assert_eq!(sel, 0);
        sel = 2;
        assert!(edit_filter_query(
            &mut q,
            &mut sel,
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)
        ));
        assert!(q.is_empty());
        assert_eq!(sel, 0);
        assert!(!edit_filter_query(
            &mut q,
            &mut sel,
            KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL)
        ));
    }
}
