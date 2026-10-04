//! Welcome screen — the Agente Code hero.
//!
//! A rounded card with the pixel-art tilde-A mark, the wordmark and the
//! quick actions, floating on the landing page's tile field: a mosaic of
//! dim amber squares that drifts, rolls rings out of a horizon glow and
//! twinkles on a few embers. The field is ambient (repainted ~15 fps only
//! while the hero is up) and freezes under `reduce_motion`.

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

    paint_tile_field(frame.buffer_mut(), area, panel, state);

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

// ── Tile field ──────────────────────────────────────────────────────────────

/// Repaint interval for the ambient field while the hero is visible.
pub const TILE_FRAME_MS: u64 = 66;

/// Brightness steps a tile can take. Quantizing the field is what turns a
/// smooth glow into pixel art instead of a wash.
const TILE_LEVELS: f32 = 6.0;
/// Contrast exponent: most of the canvas stays empty so the lit core, the
/// rings and the single stray tiles carry the composition.
const TILE_GAMMA: f32 = 1.9;
/// Secondary light bleeding in from above the top-right corner.
const CORNER_LIGHT: f32 = 0.5;
/// Strength of the rings rolling out of the glow.
const WAVE_RINGS: f32 = 0.22;
/// Strength of the rare single-tile twinkles.
const EMBERS: f32 = 0.55;

/// 4×4 Bayer matrix: ordered dithering between the six levels, so neighbouring
/// tiles at the same brightness still read as a gradient.
const BAYER: [[f32; 4]; 4] = [
    [0.0, 8.0, 2.0, 10.0],
    [12.0, 4.0, 14.0, 6.0],
    [3.0, 11.0, 1.0, 9.0],
    [15.0, 7.0, 13.0, 5.0],
];

/// The hero's tile grid for one frame.
///
/// Field space is normalized to the canvas height, the way the landing page
/// normalizes to its 720 px unit, so the composition reads the same in a
/// 40-column and a 200-column terminal. One field unit is one cell wide and
/// half a cell tall, which makes a tile — and its gap — square on screen.
struct TileField {
    /// Tile columns across the canvas: every other cell holds a square.
    cols: f32,
    /// Tile rows, one per cell row.
    rows: f32,
    /// Canvas size in field units: `[cols / rows, 1]`.
    size: [f32; 2],
    /// Glow center, as a fraction of the canvas.
    focus: [f32; 2],
    /// Field phase in seconds.
    time: f32,
}

impl TileField {
    fn new(cols: u16, rows: u16, focus: [f32; 2], time: f32) -> Self {
        Self {
            cols: f32::from(cols.max(1)),
            rows: f32::from(rows.max(1)),
            size: [f32::from(cols.max(1)) / f32::from(rows.max(1)), 1.0],
            focus,
            time,
        }
    }

    /// Tile center as a fraction of the canvas — the space the noise lives in.
    fn uv(&self, col: u16, row: u16) -> [f32; 2] {
        [
            (f32::from(col) + 0.5) / self.cols,
            (f32::from(row) + 0.5) / self.rows,
        ]
    }

    /// Quantized level `0..=TILE_LEVELS` for a tile; `0` leaves the cell empty.
    fn level(&self, col: u16, row: u16) -> u8 {
        let dithered = self.brightness(col, row) * TILE_LEVELS + bayer(col, row);
        dithered.floor().clamp(0.0, TILE_LEVELS) as u8
    }

    /// Tile color: the brand ramp, dim accent at the low end and highlight at
    /// the top end, exactly like the landing page's field.
    fn color(&self, level: u8) -> Color {
        let light = self.share(level);
        style::blend_colors(style::TILE_ACCENT(), style::TILE_HI(), light.powf(1.6))
    }

    /// Opacity for a level: the faintest squares are a whisper, the core reads.
    fn alpha(&self, level: u8) -> f32 {
        style::TILE_ALPHA() * self.share(level).powf(1.2)
    }

    /// How far up the ramp a level sits, in `0.0..=1.0`.
    fn share(&self, level: u8) -> f32 {
        f32::from(level) / TILE_LEVELS
    }

    /// Field brightness at a tile, before quantization: horizon glow, corner
    /// light, drifting swell, wave rings, a chop along the horizon, embers,
    /// then the gamma that keeps the canvas mostly empty.
    fn brightness(&self, col: u16, row: u16) -> f32 {
        let [ux, uy] = self.uv(col, row);
        let t = self.time;
        let p = [ux * self.size[0], uy * self.size[1]];

        // A slow domain warp, so the tide breathes instead of sitting still.
        let warp = [
            noise2(ux * 1.3 + t * 0.05, uy * 1.3 - t * 0.03) - 0.5,
            noise2(ux * 1.3 + 7.3 - t * 0.04, uy * 1.3 + t * 0.02) - 0.5,
        ];
        let q = [p[0] + warp[0] * 0.10, p[1] + warp[1] * 0.10];

        // The horizon glow, swaying a little.
        let hc = [
            self.focus[0] * self.size[0] + (t * 0.11).sin() * 0.12,
            self.focus[1] * self.size[1] + (t * 0.07).sin() * 0.03,
        ];
        let hd = [(q[0] - hc[0]) * 0.62, (q[1] - hc[1]) * 1.9];
        let horizon = (-(hd[0] * hd[0] + hd[1] * hd[1]) * 2.4).exp();

        let cd = [(q[0] - self.size[0] * 0.92) * 0.9, (q[1] + 0.08) * 1.3];
        let corner = (-(cd[0] * cd[0] + cd[1] * cd[1]) * 3.2).exp() * CORNER_LIGHT;

        // Low frequency swells only — no busy texture.
        let swell = noise2(ux * 1.6 + t * 0.05, uy * 1.6 - t * 0.03) * 0.6
            + noise2(ux * 3.1 - t * 0.04, uy * 3.1 + t * 0.02) * 0.4;

        // Rings rolling out of the glow, with a finer chop along the horizon.
        let dd = [(q[0] - hc[0]) * 0.82, q[1] - hc[1]];
        let d = (dd[0] * dd[0] + dd[1] * dd[1]).sqrt();
        let rings = (0.5 + 0.5 * (d * 11.0 - t * 0.7).sin()).powi(4) * WAVE_RINGS;
        let chop = (0.5 + 0.5 * (ux * 22.0 + t * 0.5).sin()) * 0.07;

        let mut g = (horizon + corner) * (0.70 + 0.36 * swell) * (1.0 - chop);
        g += rings * (0.25 + 0.75 * horizon);

        // Embers: rare tiles flaring on their own phase, and only where the
        // field is already lit.
        let id = hash2(f32::from(col) * 1.37, f32::from(row) * 1.37);
        if id >= 0.975 {
            let phase = hash2(f32::from(col) * 2.11 + 3.7, f32::from(row) * 2.11 + 3.7)
                * std::f32::consts::TAU;
            let pulse = (0.5 + 0.5 * (t * 1.6 + phase).sin()).powi(14);
            g += pulse * smoothstep(0.12, 0.42, g) * EMBERS;
        }

        g.clamp(0.0, 1.0).powf(TILE_GAMMA)
    }
}

/// The landing page's tile field, in the terminal.
///
/// Every other cell holds one half-block square: two columns per tile leaves a
/// gap between neighbours, and the square fills half the cell height, so each
/// lit tile is a square with air around it — the mosaic, dithered into six
/// levels. The field wakes over its first second and is frozen at t=0 under
/// `reduce_motion` and in tests, so snapshots stay deterministic.
fn paint_tile_field(buf: &mut Buffer, area: Rect, card: Rect, state: &AppState) {
    if area.width < 4 || area.height < 2 {
        return;
    }
    let still = state.ui.reduce_motion || cfg!(test);
    let (time, fade) = if still {
        (0.0, 1.0)
    } else {
        field_clock(state.ui.anim_time_secs())
    };
    let cols = area.width / 2;
    let rows = area.height;
    // The glow sits behind the card's lower half, so the mosaic frames the
    // wordmark the way the landing page's glow frames the headline.
    let focus_y = f32::from(card.bottom().saturating_sub(area.y)) / f32::from(area.height) + 0.05;
    let field = TileField::new(cols, rows, [0.5, focus_y.clamp(0.25, 1.0)], time);
    let canvas = style::BG();
    for row in 0..rows {
        for col in 0..cols {
            let level = field.level(col, row);
            if level == 0 {
                continue;
            }
            let (x, y) = (area.x + col * 2, area.y + row);
            if card.contains(ratatui::layout::Position::new(x, y)) {
                continue;
            }
            let Some(cell) = buf.cell_mut((x, y)) else {
                continue;
            };
            cell.set_symbol("▀")
                .set_fg(style::blend_colors(
                    canvas,
                    field.color(level),
                    field.alpha(level) * fade,
                ))
                .set_bg(canvas);
        }
    }
}

/// Phase and fade for the field at `elapsed` seconds: the mosaic eases in over
/// its first second, and the phase starts at rest so the first frames don't
/// jolt into motion.
fn field_clock(elapsed: f32) -> (f32, f32) {
    const RAMP: f32 = 1.2;
    if elapsed >= RAMP {
        // Past the ramp the phase runs in real time, continuing from ∫ease_out.
        return (elapsed - RAMP * 0.25, 1.0);
    }
    let u = (elapsed / RAMP).max(0.0);
    (
        RAMP * (u + (1.0 - u).powi(4) / 4.0 - 0.25),
        crate::state::anim::ease_out(u),
    )
}

/// Ordered-dither offset for a tile, in `0.0..1.0`.
fn bayer(col: u16, row: u16) -> f32 {
    (BAYER[usize::from(row) % 4][usize::from(col) % 4] + 0.5) / 16.0
}

/// Hash to `0.0..1.0`, the shader's `fract(sin(dot(p, k)) * m)`.
fn hash2(x: f32, y: f32) -> f32 {
    ((x * 127.1 + y * 311.7).sin() * 43_758.547).fract().abs()
}

/// Value noise with a smoothstep fade, the shader's `noise`.
fn noise2(x: f32, y: f32) -> f32 {
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (ux, uy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let bottom = hash2(ix, iy) + (hash2(ix + 1.0, iy) - hash2(ix, iy)) * ux;
    let top = hash2(ix, iy + 1.0) + (hash2(ix + 1.0, iy + 1.0) - hash2(ix, iy + 1.0)) * ux;
    bottom + (top - bottom) * uy
}

/// GLSL `smoothstep`: `0.0` below `edge0`, `1.0` above `edge1`, eased between.
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
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
        assert!(
            !text.contains('~'),
            "the hero field is squares, not drifting glyphs"
        );
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

    /// Cells the hero field painted: a half-block square on the canvas.
    fn field_tiles(buf: &Buffer) -> Vec<(u16, u16)> {
        let mut tiles = Vec::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                let cell = &buf[(x, y)];
                if cell.symbol() == "▀" && cell.bg == style::BG() {
                    tiles.push((x, y));
                }
            }
        }
        tiles
    }

    fn frame_buffer(state: &mut AppState, w: u16, h: u16) -> Buffer {
        let backend = TestBackend::new(w, h);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, f.area(), state)).unwrap();
        terminal.backend().buffer().clone()
    }

    #[test]
    fn hero_field_is_a_mosaic_of_separated_squares() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/agente".into());
        state.ui.show_welcome_screen = true;
        let buf = frame_buffer(&mut state, 100, 30);
        let tiles = field_tiles(&buf);
        assert!(
            tiles.len() > 40,
            "the field lights a mosaic, got {} tiles",
            tiles.len()
        );

        let lit: std::collections::HashSet<(u16, u16)> = tiles.iter().copied().collect();
        let mut shades = std::collections::HashSet::new();
        for &(x, y) in &tiles {
            // One cell of gap between neighbours: the square sits on even
            // columns, and the cell below a square is canvas (the gap under it).
            assert_eq!(x % 2, 0, "tiles land on the even columns");
            assert!(!lit.contains(&(x + 1, y)), "a gap column between squares");
            // The square is a half block: the other half of its cell stays
            // canvas, which is the gap between tile rows.
            assert_eq!(buf[(x, y)].bg, style::BG(), "a square never fills its cell");
            shades.insert(buf[(x, y)].fg);
        }
        assert!(
            shades.len() >= 3,
            "the field is dithered into several levels, got {}",
            shades.len()
        );
    }

    #[test]
    fn hero_field_stays_off_the_card() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/agente".into());
        state.ui.show_welcome_screen = true;
        let buf = frame_buffer(&mut state, 100, 30);

        // The card is the only panel surface on this screen.
        let mut card = (u16::MAX, u16::MAX, 0u16, 0u16);
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                if buf[(x, y)].bg == style::BG_PANEL() {
                    card = (card.0.min(x), card.1.min(y), card.2.max(x), card.3.max(y));
                }
            }
        }
        assert!(card.2 > card.0, "the card is on screen");
        for (x, y) in field_tiles(&buf) {
            assert!(
                x < card.0 || x > card.2 || y < card.1 || y > card.3,
                "tile ({x}, {y}) paints over the card"
            );
        }
    }

    #[test]
    fn tile_field_glows_at_the_focus_and_empties_at_the_corner() {
        let field = TileField::new(40, 24, [0.5, 0.67], 0.0);
        assert_eq!(field.level(0, 0), 0, "the far corner stays empty");
        assert!(
            field.level(20, 14) >= 4,
            "the glow core is bright, got {}",
            field.level(20, 14)
        );
        for col in 0..40 {
            for row in 0..24 {
                assert!(field.level(col, row) <= TILE_LEVELS as u8);
            }
        }
    }

    #[test]
    fn tile_field_wakes_up_without_a_jolt() {
        assert_eq!(field_clock(0.0), (0.0, 0.0), "the field starts at rest");
        assert_eq!(field_clock(1.2).1, 1.0, "fully faded in after the ramp");
        let (before, _) = field_clock(1.199);
        let (after, _) = field_clock(1.201);
        assert!(
            (after - before).abs() < 0.01,
            "the phase carries over the end of the ramp"
        );
        assert!(
            field_clock(9.0).0 > field_clock(3.0).0,
            "time keeps running"
        );
    }
}
