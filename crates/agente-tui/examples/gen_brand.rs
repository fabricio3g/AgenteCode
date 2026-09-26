//! Generator for the Agente Code brand set in `assets/brand/`.
//!
//! The mark is a solid "A" whose crossbar is a ñ-style tilde — Spanish
//! "agente" meets the `~` of a shell — on an ink app tile. Everything is
//! built from the geometry below, so the set is reproducible:
//!
//! ```sh
//! AGENTE_BRAND_FONT=/path/to/SpaceGrotesk-Medium.ttf \
//!     cargo run -p agente-tui --example gen_brand
//! ```
//!
//! The font is only needed to outline the "Agente Code" wordmark; the
//! committed SVGs contain paths, never text, so they render identically
//! everywhere. Outputs: tile icon SVG, lockups for dark and light
//! backgrounds (SVG + 2x PNG), icon PNGs from 16 to 1024 px, and a
//! multi-size `favicon.ico`.

use std::fs;
use std::sync::Arc;

use resvg::{tiny_skia, usvg};

const OUT: &str = "assets/brand";

// Ink tile palette (matches the TUI's dark canvas).
const TILE: &str = "#111317";
const EDGE: &str = "#23262d";
const MARK: &str = "#f2f2f3";
const TILDE: &str = "#e5a445";

/// Tile + mark on a 120-unit grid. `small` is the optical variant for
/// 16–32 px: a larger mark and a heavier tilde, or the tilde vanishes.
fn icon_body(small: bool) -> String {
    let (scale, tilde_w) = if small { (0.86, 12.0) } else { (0.78, 9.0) };
    format!(
        r##"<rect x="1" y="1" width="118" height="118" rx="27" fill="{TILE}" stroke="{EDGE}" stroke-width="1.5"/>
<g transform="translate(60 60) scale({scale}) translate(-60 -60)">
<path d="M22 98 L50 22 H70 L98 98 H79 L60 44 L41 98 Z" fill="{MARK}"/>
<path d="M36 77 C44 67 52 67 60 73 C68 79 76 79 84 69" fill="none" stroke="{TILDE}" stroke-width="{tilde_w}" stroke-linecap="round"/>
</g>"##
    )
}

fn icon_svg(small: bool) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">{}</svg>"#,
        icon_body(small)
    )
}

/// Icon + "Agente Code" wordmark. `on_dark` picks text colors for dark
/// backgrounds. `width` is filled in after measuring the outlined text.
fn lockup_svg(on_dark: bool, width: f32) -> String {
    let (primary, secondary) = if on_dark {
        ("#f2f2f3", "#8b8f98")
    } else {
        ("#111317", "#6b6f78")
    };
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="120" viewBox="0 0 {width} 120">{}<text x="148" y="82" font-family="Space Grotesk" font-weight="500" font-size="62" letter-spacing="-1.2"><tspan fill="{primary}">Agente</tspan><tspan fill="{secondary}"> Code</tspan></text></svg>"#,
        icon_body(false)
    )
}

fn options() -> usvg::Options<'static> {
    let mut opt = usvg::Options::default();
    let db = Arc::make_mut(&mut opt.fontdb);
    match std::env::var("AGENTE_BRAND_FONT") {
        Ok(path) => db.load_font_file(&path).expect("load AGENTE_BRAND_FONT"),
        Err(_) => db.load_system_fonts(),
    }
    opt
}

fn parse(svg: &str, opt: &usvg::Options) -> usvg::Tree {
    usvg::Tree::from_str(svg, opt).expect("valid svg")
}

fn png(tree: &usvg::Tree, width: u32, height: u32) -> Vec<u8> {
    let size = tree.size();
    let mut pixmap = tiny_skia::Pixmap::new(width, height).expect("pixmap");
    let transform = tiny_skia::Transform::from_scale(
        width as f32 / size.width(),
        height as f32 / size.height(),
    );
    resvg::render(tree, transform, &mut pixmap.as_mut());
    pixmap.encode_png().expect("encode png")
}

/// A Vista+ `.ico`: one PNG-compressed image per size.
fn ico(images: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&[0, 0, 1, 0]);
    out.extend_from_slice(&(images.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * images.len() as u32;
    for (size, data) in images {
        let dim = if *size >= 256 { 0 } else { *size as u8 };
        out.extend_from_slice(&[dim, dim, 0, 0]);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += data.len() as u32;
    }
    for (_, data) in images {
        out.extend_from_slice(data);
    }
    out
}

fn main() {
    fs::create_dir_all(OUT).expect("create assets/brand");
    let opt = options();
    let write = |name: &str, bytes: &[u8]| {
        fs::write(format!("{OUT}/{name}"), bytes).expect("write asset");
        println!("{OUT}/{name}");
    };
    let outline = |svg: &str| parse(svg, &opt).to_string(&usvg::WriteOptions::default());

    // Tile icon: vector + PNG ladder (optical variant at 32 px and below).
    let icon = icon_svg(false);
    write("agente-code-icon.svg", outline(&icon).as_bytes());
    let full = parse(&icon, &opt);
    let small = parse(&icon_svg(true), &opt);
    let mut ico_images = Vec::new();
    for px in [16u32, 32, 48, 64, 128, 256, 512, 1024] {
        let tree = if px <= 32 { &small } else { &full };
        let data = png(tree, px, px);
        write(&format!("agente-code-icon-{px}.png"), &data);
        if matches!(px, 16 | 32 | 48 | 64 | 128 | 256) {
            ico_images.push((px, data));
        }
    }
    write("favicon.ico", &ico(&ico_images));
    write(
        "agente-code-icon-small.svg",
        outline(&icon_svg(true)).as_bytes(),
    );

    // Lockups: measure the outlined text once, then size the canvas to it.
    let probe = parse(&lockup_svg(true, 1200.0), &opt);
    let right = probe.root().abs_bounding_box().right();
    assert!(
        right > 200.0,
        "wordmark did not outline — set AGENTE_BRAND_FONT to a Space Grotesk Medium file"
    );
    let width = (right + 6.0).ceil();
    for (on_dark, name) in [(true, "on-dark"), (false, "on-light")] {
        let tree = parse(&lockup_svg(on_dark, width), &opt);
        write(
            &format!("agente-code-lockup-{name}.svg"),
            tree.to_string(&usvg::WriteOptions::default()).as_bytes(),
        );
        write(
            &format!("agente-code-lockup-{name}@2x.png"),
            &png(&tree, (width * 2.0) as u32, 240),
        );
    }
}
