//! Generator for the Agente Code brand set in `assets/brand/`.
//!
//! The mark is a white "A" crossed by an orbit swoosh, with a moon at its top
//! right, on a black rounded tile inside a graphite rim — the desktop app's
//! icon (`apps/desktop/renderer/public/app-icon.png`). Its artwork exists as
//! raster masters only (`agente-code-icon-black-white.png` and the rimmed
//! `agente-code-icon-graphite-relief.png`, 1254 px), so [`MARK`] is that mark
//! traced once: marching squares at the 50% grey level over the black-and-white
//! master, joined into closed loops (the A with its swoosh, the A's counter,
//! the moon) and simplified to 0.6 px (Ramer–Douglas–Peucker), on a 120-unit
//! grid and filled even-odd. Everything else is built from it:
//!
//! ```sh
//! cargo run -p agente-tui --example gen_brand
//! ```
//!
//! The "Agente Code" wordmark comes outlined from `agente-code-wordmark.svg`
//! (Space Grotesk Medium, OFL), so no font is needed and the committed SVGs
//! contain paths, never text. Outputs: tile icon SVG (and its small optical
//! variant), lockups for dark and light backgrounds (SVG + 2x PNG), icon PNGs
//! from 16 to 1024 px, and a multi-size `favicon.ico`.

use std::fs;

use resvg::{tiny_skia, usvg};

const OUT: &str = "assets/brand";

/// The traced mark on the 120-unit grid (see the module docs); fill it
/// even-odd so the counter stays open.
const MARK: &str = "M52.76 25.31 L67.29 25.31 L73.65 40.05 L83.11 62.88 L87.42 61.23 L92.68 58.82 L96.7 56.72 L100.14 54.61 L101.2 53.88 L101.39 53.83 L101.53 53.92 L101.51 54.31 L101.33 54.69 L99.86 56.77 L98.28 58.52 L95.93 60.74 L93.06 63.03 L91.15 64.38 L88.37 66.12 L85.12 67.88 L85.05 67.99 L90.68 81.77 L95.74 94.52 L82.34 94.54 L81.96 94.48 L73.65 72.87 L73.54 72.64 L73.44 72.62 L70.48 73.66 L66.17 74.98 L58.52 76.99 L51.63 78.44 L47.32 79.21 L43.21 79.81 L37.56 94.6 L24.15 94.59 L29.63 80.72 L26.08 80.36 L22.73 79.69 L20.24 78.8 L19.28 78.33 L18.23 77.68 L17.39 76.99 L16.67 76.22 L16.27 75.65 L15.81 74.69 L15.6 73.92 L15.52 72.87 L15.71 71.72 L15.98 70.96 L16.86 69.33 L17.64 68.28 L18.71 67.12 L20.05 65.95 L21.67 64.8 L23.3 63.86 L25.31 62.9 L27.61 62.05 L27.64 62.15 L26.27 63.28 L24.74 64.79 L24.07 65.6 L23.38 66.65 L22.91 67.7 L22.7 68.66 L22.71 69.33 L22.99 70.29 L23.59 71.04 L24.26 71.53 L25.31 72.03 L26.46 72.39 L28.37 72.79 L30 72.97 L32.58 73.05 L32.73 72.97 L36.28 64.07 L43.09 47.51 L49.33 32.88 Z M59.95 39.51 L57.24 45.69 L51.03 60.33 L46.36 71.84 L52.11 71.06 L58.8 69.84 L65.12 68.39 L69.43 67.25 L71.34 66.65 Z M103.89 39.95 L104.74 39.93 L106.17 40.21 L107.22 40.71 L108.09 41.32 L108.99 42.34 L109.47 43.21 L109.86 44.35 L110 45.41 L109.96 46.65 L109.69 47.8 L109.16 48.95 L108.47 49.89 L107.7 50.6 L106.75 51.18 L105.79 51.54 L104.55 51.71 L103.3 51.64 L102.25 51.36 L101.1 50.78 L100.24 50.12 L99.55 49.33 L98.98 48.37 L98.58 47.32 L98.4 45.98 L98.49 44.74 L98.86 43.59 L99.44 42.54 L100.05 41.81 L101 40.98 L101.87 40.49 L102.92 40.12 Z";

/// Graphite rim around the black tile, lit from the top as on the desktop icon.
const RIM_TOP: &str = "#3c3c3c";
const RIM_BOTTOM: &str = "#1d1d1d";

/// Tile + mark on a 120-unit grid. `small` is the optical variant for
/// 16–32 px: the rim would turn to a grey smear, so the tile goes full bleed
/// and the mark grows a step to keep its swoosh and moon legible.
fn icon_body(small: bool) -> String {
    if small {
        return format!(
            r##"<rect x="0" y="0" width="120" height="120" rx="20" fill="#000"/>
<path fill="#fff" fill-rule="evenodd" transform="translate(60 60) scale(1.14) translate(-63 -60)" d="{MARK}"/>"##
        );
    }
    format!(
        r##"<defs><linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{RIM_TOP}"/><stop offset="1" stop-color="{RIM_BOTTOM}"/></linearGradient></defs>
<rect x="2" y="2" width="116" height="116" rx="18" fill="url(#rim)"/>
<rect x="5.5" y="5.5" width="109" height="109" rx="14.5" fill="#000"/>
<path fill="#fff" fill-rule="evenodd" d="{MARK}"/>"##
    )
}

fn icon_svg(small: bool) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">{}</svg>"#,
        icon_body(small)
    )
}

/// One path's `d` from the wordmark asset, found by its `id`.
fn wordmark_path(svg: &str, id: &str) -> String {
    let start = svg
        .find(&format!(r#"id="{id}""#))
        .unwrap_or_else(|| panic!("wordmark path #{id}"));
    let d = svg[start..].find(r#" d=""#).expect("path data") + start + 4;
    let end = svg[d..].find('"').expect("closing quote") + d;
    svg[d..end].to_string()
}

/// Icon + "Agente Code" wordmark. `on_dark` picks text colors for dark
/// backgrounds. `width` is filled in after measuring the wordmark.
fn lockup_svg(wordmark: &str, on_dark: bool, width: f32) -> String {
    let (primary, secondary) = if on_dark {
        ("#f2f2f3", "#8b8f98")
    } else {
        ("#111317", "#6b6f78")
    };
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="120" viewBox="0 0 {width} 120">{}<path fill="{primary}" d="{}"/><path fill="{secondary}" d="{}"/></svg>"#,
        icon_body(false),
        wordmark_path(wordmark, "agente"),
        wordmark_path(wordmark, "code"),
    )
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
    let opt = usvg::Options::default();
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

    // Lockups: measure the wordmark once, then size the canvas to it.
    let wordmark = fs::read_to_string(format!("{OUT}/agente-code-wordmark.svg"))
        .expect("read agente-code-wordmark.svg");
    let probe = parse(&lockup_svg(&wordmark, true, 1200.0), &opt);
    let width = (probe.root().abs_bounding_box().right() + 6.0).ceil();
    for (on_dark, name) in [(true, "on-dark"), (false, "on-light")] {
        let tree = parse(&lockup_svg(&wordmark, on_dark, width), &opt);
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
