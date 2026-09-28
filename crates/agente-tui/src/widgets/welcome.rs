//! Welcome screen — the Agente Code hero.
//!
//! A rounded card with the pixel-art tilde-A mark, the wordmark and the
//! quick actions, floating on a slow "tilde sea": dim `~` swells drifting
//! behind the card, warming toward amber as they near it. The sea is ambient
//! (repainted ~15 fps only while the hero is up) and freezes under
//! `reduce_motion`.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::pick::{pick_list, row_label, PickItem};
use crate::command_palette::Command;
use crate::state::{AppState, ListId};
use crate::style;

/// Welcome home actions (label, key hint, command).
pub const WELCOME_ACTIONS: &[(&str, &str, Command)] = &[
    ("New session", "Ctrl+N", Command::NewSession),
    ("Open project", "", Command::OpenProject),
    ("Resume session", "Ctrl+S", Command::OpenSession),
    ("Help", "F1", Command::ShowHelp),
    ("Quit", "Ctrl+C", Command::Quit),
];

/// Number of quick-action buttons.
pub fn action_count() -> usize {
    WELCOME_ACTIONS.len()
}

/// Quick-action command at index.
pub fn action_at(index: usize) -> Option<Command> {
    WELCOME_ACTIONS.get(index).map(|(_, _, cmd)| *cmd)
}

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    if !state.ui.show_welcome_screen {
        return;
    }
    if area.width == 0 || area.height == 0 {
        return;
    }

    // Theme canvas. `render_app` already paints it; the standalone test and
    // harness callers rely on this fill for opaque (non-`Reset`) cells.
    frame.render_widget(
        Paragraph::new("").style(Style::default().bg(style::BG())),
        area,
    );

    // Card geometry — clamped, never a preference: a rect wider than the
    // buffer makes `Clear` index outside it (panic, not a clipped card).
    let connected = !state.config.current_provider.is_empty();
    // A connected session gets one guidance row under the wordmark.
    let detail_rows = if connected && area.height >= 13 { 1 } else { 0 };
    // The mark needs its five rows plus room for the menu; tight terminals
    // fall back to the one-line wordmark.
    let with_icon = area.height >= 18 && area.width >= 40;
    let brand_rows = if with_icon {
        ICON_ROWS
    } else {
        1 + detail_rows
    };
    // Content rows: brand block + gap + menu.
    let content_rows = brand_rows + 1 + action_count() as u16;

    // Hero card: rounded border, narrow side margins, wide cap.
    let card_w = area.width.saturating_sub(6).min(96).min(area.width);
    if card_w < 10 || area.height < 4 {
        return;
    }
    let card_h = (content_rows + 2).min(area.height);
    let card_x = area.x + area.width.saturating_sub(card_w) / 2;

    // Vertical centering with a top bias (top_pad ≈ slack / 3): the card
    // floats just above center, leaving the tip + composer air below.
    let slack = area.height.saturating_sub(card_h);
    let top_pad = (slack / 3).min(slack);
    let box_y = area.y + top_pad;
    let panel = Rect::new(card_x, box_y, card_w, card_h);

    paint_tilde_sea(frame.buffer_mut(), area, panel, state);

    // Same untitled card chrome as every modal.
    let inner = super::modal_card(frame, panel, Vec::new());
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let panel_bg = style::BG_PANEL();
    let brand_y = inner.y;
    // Two-column inset shared by the title, detail and menu rows, so nothing
    // sits flush against the card border.
    let text_x = inner.x + 2.min(inner.width);
    let text_w = inner.width.saturating_sub(2);

    let selected = state
        .ui
        .welcome_selected
        .min(action_count().saturating_sub(1));
    state.ui.welcome_selected = selected;

    // ── Title: theme-foreground wordmark + dim version ──
    let title_spans = vec![
        Span::styled(
            "Agente Code",
            Style::default()
                .fg(style::FG())
                .bg(panel_bg)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  v{}", shown_version()),
            Style::default().fg(style::FG_DIM()).bg(panel_bg),
        ),
    ];
    // With the mark: icon on the left, wordmark + guidance centered beside it.
    let (words_x, words_y) = if with_icon {
        paint_icon(frame.buffer_mut(), text_x, brand_y);
        (text_x + ICON_COLS + 3, brand_y + 1)
    } else {
        (text_x, brand_y)
    };
    let words_w = (inner.x + inner.width).saturating_sub(words_x);
    if words_y < inner.y + inner.height {
        frame.render_widget(
            Paragraph::new(Line::from(title_spans)).style(Style::default().bg(panel_bg)),
            Rect::new(words_x, words_y, words_w, 1),
        );
    }

    if detail_rows > 0 {
        frame.render_widget(
            Paragraph::new(crate::widgets::truncate_cells(
                "Ask anything below · /model to switch",
                words_w as usize,
            ))
            .style(Style::default().fg(style::FG_DIM()).bg(panel_bg)),
            Rect::new(words_x, words_y + 1, words_w, 1),
        );
    }

    // Menu rows share a measured column with the brand.
    let menu_y = brand_y.saturating_add(brand_rows + 1);

    let menu_rows = (inner.y + inner.height).saturating_sub(menu_y);
    let items = WELCOME_ACTIONS
        .iter()
        .enumerate()
        .map(|(i, (label, hint, _))| {
            PickItem::row_with_trail(
                vec![Span::styled(label.to_string(), row_label(i == selected))],
                vec![Span::styled(hint.to_string(), style::dim())],
            )
        })
        .collect();
    pick_list(
        frame,
        Rect::new(text_x, menu_y, text_w, menu_rows.min(action_count() as u16)),
        &state.ui.hits,
        ListId::Welcome,
        items,
        selected,
    );

    // ── Tip line (bottom of the canvas, above the composer) ──
    let tip_y = area.y + area.height.saturating_sub(1);
    if connected && tip_y > panel.bottom() {
        let tip = "Tip: Try /model to switch models · /help for shortcuts";
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                format!(" {tip}"),
                Style::default().fg(style::FG_DIM()).bg(style::BG()),
            ))),
            Rect::new(area.x, tip_y, area.width, 1),
        );
    }
}

// ── Mark ────────────────────────────────────────────────────────────────────

/// The tilde-A mark as 12×10 pixels: `W` the A, `T` the tilde crossbar,
/// `.` the ink tile, ` ` outside its rounded corners. Two pixels stack per
/// cell (half blocks), so it paints as 12×5 cells.
const ICON: [&str; 10] = [
    " .......... ",
    ".....WW.....",
    "....WWWW....",
    "...WW..WW...",
    // Tilde rows share one cell row, so the wave paints as `▄▀▀▄`, not a
    // checkerboard across two rows.
    "...WTT.WTT..",
    "..TT..TTWW..",
    "..WW....WW..",
    ".WW......WW.",
    ".WW......WW.",
    " .......... ",
];
const ICON_COLS: u16 = 12;
const ICON_ROWS: u16 = 5;

/// Brand colors, fixed across themes: the icon is the app icon, not chrome.
const ICON_TILE: Color = Color::Rgb(0x11, 0x13, 0x17);
const ICON_MARK: Color = Color::Rgb(0xf2, 0xf2, 0xf3);
const ICON_TILDE: Color = Color::Rgb(0xe5, 0xa4, 0x45);

fn paint_icon(buf: &mut Buffer, x: u16, y: u16) {
    let pixel = |row: usize, col: usize| match ICON[row].as_bytes()[col] {
        b'W' => ICON_MARK,
        b'T' => ICON_TILDE,
        b'.' => ICON_TILE,
        _ => style::BG_PANEL(),
    };
    for cy in 0..ICON_ROWS as usize {
        for cx in 0..ICON_COLS as usize {
            let (top, bottom) = (pixel(cy * 2, cx), pixel(cy * 2 + 1, cx));
            let Some(cell) = buf.cell_mut((x + cx as u16, y + cy as u16)) else {
                continue;
            };
            if top == bottom {
                cell.set_symbol(" ").set_bg(top);
            } else {
                cell.set_symbol("▀").set_fg(top).set_bg(bottom);
            }
        }
    }
}

// ── Tilde sea ───────────────────────────────────────────────────────────────

/// Repaint interval for the ambient sea while the hero is visible.
pub const SEA_FRAME_MS: u64 = 66;

/// Dim `~` swells drifting behind the card. Crests become tildes; a sparse
/// `·` spray keeps the calm areas from reading as empty. Everything sits a
/// few steps above the canvas and warms from teal to amber near the card, so
/// the sea frames the hero without competing with it. It swells in over the
/// first second.
fn paint_tilde_sea(buf: &mut Buffer, area: Rect, card: Rect, state: &AppState) {
    // Frozen at t=0 under reduce_motion and in tests, so snapshots stay
    // deterministic.
    let still = state.ui.reduce_motion || cfg!(test);
    let elapsed = state.ui.anim_time_secs();
    let t = if still { 0.0 } else { elapsed };
    let swell_in = if still {
        1.0
    } else {
        crate::state::anim::ease_out((elapsed / 1.2).min(1.0))
    };
    let canvas = style::BG();
    for y in area.top()..area.bottom() {
        for x in area.left()..area.right() {
            if card.contains(ratatui::layout::Position::new(x, y)) {
                continue;
            }
            let (fx, fy) = (f32::from(x), f32::from(y) * 2.0);
            // Two crossing swell trains; crests only where both agree, so the
            // sea breaks into scattered strokes instead of even stripes.
            let long = (fx * 0.09 + t * 0.5 + (fy * 0.07 - t * 0.2).sin() * 2.0).sin();
            let cross = (fx * 0.05 - fy * 0.06 + t * 0.3).sin();
            let crest = long * 0.65 + cross * 0.35;
            let grain = (u32::from(x).wrapping_mul(73_856_093)
                ^ u32::from(y).wrapping_mul(19_349_663))
                % 97;
            // Distance to the card in square-ish units (cells are ~1:2).
            let dx = f32::from(
                card.left()
                    .saturating_sub(x)
                    .max(x.saturating_sub(card.right())),
            );
            let dy = f32::from(
                card.top()
                    .saturating_sub(y)
                    .max(y.saturating_sub(card.bottom())),
            ) * 2.0;
            let glow = (1.0 - (dx * dx + dy * dy).sqrt() / 22.0).clamp(0.0, 1.0);
            let tint = style::blend_colors(style::PRIMARY(), ICON_TILDE, glow * 0.8);
            let (symbol, amount) = if crest > 0.8 && grain < 62 {
                ("~", 0.07 + (0.10 + 0.20 * glow) * (crest - 0.8) / 0.2)
            } else if grain < 3 {
                ("·", 0.07 + 0.08 * glow)
            } else {
                continue;
            };
            if let Some(cell) = buf.cell_mut((x, y)) {
                cell.set_symbol(symbol)
                    .set_fg(style::blend_colors(canvas, tint, amount * swell_in))
                    .set_bg(canvas);
            }
        }
    }
}

/// The version on the welcome panel. Tests show a fixed one so a release
/// bump doesn't rewrite every screen snapshot.
fn shown_version() -> &'static str {
    if cfg!(test) {
        "0.0.0"
    } else {
        env!("CARGO_PKG_VERSION")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn shot(state: &mut AppState, w: u16, h: u16) -> String {
        let backend = TestBackend::new(w, h);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), state)).unwrap();
        let buf = terminal.backend().buffer();
        let mut s = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                s.push_str(buf[(x, y)].symbol());
            }
            s.push('\n');
        }
        s
    }

    fn menu_row(text: &str, needle: &str) -> u16 {
        text.lines()
            .position(|l| l.contains(needle))
            .expect("menu row") as u16
    }

    #[test]
    fn agente_welcome_is_normal_font_box_with_buttons() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/agente".into());
        state.ui.show_welcome_screen = true;
        let text = shot(&mut state, 80, 20);

        assert!(text.contains("Agente"), "wordmark");
        assert!(text.contains("Code"), "title-case Code suffix");
        assert!(!text.contains("CODE"), "no all-caps CODE");
        assert!(text.contains("New session"));
        assert!(text.contains("Resume session"));
        assert!(text.contains("Ctrl+C"), "key hints on the menu rows");
        // The only block glyphs are the half-block pixel mark, never block
        // letters spelling the name.
        assert!(!text.contains('█'), "no block letter art");
        assert!(text.contains('▀'), "pixel tilde-A mark beside the wordmark");
        assert!(!text.contains('◆'), "no logo art");
        assert!(
            !text.contains("is ready"),
            "the welcome screen must not name the active model"
        );
        assert!(state.ui.hits.at(10, menu_row(&text, "Quit")).is_some());
    }

    #[test]
    fn first_run_hero_keeps_connection_guidance_in_the_composer() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/agente".into());
        // First run: nothing connected yet (the default config names one).
        state.config.current_provider.clear();
        state.config.current_model.clear();
        state.ui.show_welcome_screen = true;
        let text = shot(&mut state, 80, 24);
        assert!(text.contains("Agente"), "wordmark rendered");
        assert!(!text.to_lowercase().contains("connect a provider"));
        assert!(!text.contains("Tip:"));
        assert!(text.contains("New session") && text.contains("Quit"));
        assert!(state.ui.hits.at(10, menu_row(&text, "Quit")).is_some());
    }
}
