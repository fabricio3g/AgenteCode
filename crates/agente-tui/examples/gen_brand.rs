//! Generator for the Agente Code brand set in `assets/brand/`.
//!
//! The mark is a tilted Quasar Orbital (-28°): a circular black-hole event
//! horizon ringed by a bright photon halo, a tilted hollow elliptical accretion
//! ring, and twin perpendicular relativistic jets, on a black rounded tile
//! inside a graphite rim.
//!
//! - Full / large sizes (`≥ 48 px`): rendered as a 15×15 Matrix Field halftone
//!   of rounded-square tiles (`rx = 0.22 * size`) with four corner star specks.
//! - Optical small sizes (`≤ 32 px`): rendered as a single watertight even-odd
//!   compound path of the same -28° Quasar Orbital on a full-bleed black tile,
//!   staying razor-sharp down to 16 px.
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

use std::fmt::Write as _;
use std::fs;

use resvg::{tiny_skia, usvg};

const OUT: &str = "assets/brand";

/// Quasar tilt angle in degrees (ascending bottom-left → top-right).
const QUASAR_ANGLE_DEG: f32 = -28.0;

/// Watertight, zero-overlap even-odd compound path for the -28° optical-small
/// Quasar Orbital (defined in canonical horizontal/vertical orientation on a
/// 120×120 grid, rotated by `QUASAR_ANGLE_DEG` around `(60, 60)`):
///
/// 1. Outer silhouette: photon ring (`r = 19.5`) fused with twin tapered jets
///    (`y = 7..113`) and the outer accretion ellipse (`rx = 50, ry = 17.5`).
/// 2. Central event-horizon void (`r = 11.2`).
/// 3. Right & left hollow orbital crescents between `r = 19.5` and the inner
///    accretion ellipse (`rx = 43.2, ry = 10.6`).
const SMALL_QUASAR_PATH: &str = concat!(
    // Outer silhouette (clockwise)
    "M60 7 Q62.2 26 65.5 41.29 ",
    "A19.5 19.5 0 0 1 69.18 42.80 ",
    "A50 17.5 0 0 1 69.18 77.20 ",
    "A19.5 19.5 0 0 1 65.5 78.71 ",
    "Q62.2 94 60 113 ",
    "Q57.8 94 54.5 78.71 ",
    "A19.5 19.5 0 0 1 50.82 77.20 ",
    "A50 17.5 0 0 1 50.82 42.80 ",
    "A19.5 19.5 0 0 1 54.5 41.29 ",
    "Q57.8 26 60 7 Z ",
    // Event-horizon circular void
    "M71.2 60 A11.2 11.2 0 1 0 48.8 60 A11.2 11.2 0 1 0 71.2 60 Z ",
    // Right hollow orbital crescent
    "M76.88 50.24 A43.2 10.6 0 0 1 76.88 69.76 A19.5 19.5 0 0 0 76.88 50.24 Z ",
    // Left hollow orbital crescent
    "M43.12 69.76 A43.2 10.6 0 0 1 43.12 50.24 A19.5 19.5 0 0 0 43.12 69.76 Z"
);

/// Graphite rim around the black tile, lit from the top as on the desktop icon.
const RIM_TOP: &str = "#3e3e40";
const RIM_BOTTOM: &str = "#1d1d1f";

/// Evaluates the normalized tilted Quasar Orbital luminance field in `[-1, 1]^2`.
fn quasar_orbital_field(nx: f32, ny: f32) -> f32 {
    let rad = QUASAR_ANGLE_DEG.to_radians();
    let (sn, cs) = rad.sin_cos();
    let u = nx * cs + ny * sn;
    let v = -nx * sn + ny * cs;
    let r = u.hypot(v);

    let void_r = 0.21_f32;
    if r < void_r {
        return 0.0;
    }

    // Luminous photon ring hugging the circular event horizon.
    let ring = (-((r - (void_r + 0.095)) / 0.115).powi(2)).exp() * 1.24;

    // Tilted hollow elliptical accretion ring.
    let ed = (u / 0.84).hypot(v / 0.29);
    let outer_ring = (-((ed - 1.0) / 0.24).powi(2)).exp() * 1.15;
    let inner_glow = (-(v / 0.14).powi(2)).exp() * (-(u / 0.45).powi(2)).exp() * 0.45;
    let disk = outer_ring.max(inner_glow);

    // Twin perpendicular relativistic jets.
    let jet_w = 0.092 * (0.72 + 0.38 * (-v.abs() * 2.0).exp());
    let jet = (-(u / jet_w).powi(2)).exp() * (-(v / 0.94).powi(2) * 0.82).exp() * 1.12;

    ring.max(disk * 0.98 + jet * 0.98)
        .max(ring * 0.78 + disk * 0.56 + jet * 0.56)
        .min(1.0)
}

/// Builds the 15×15 Matrix Field rounded-square tile elements for the large icon.
fn matrix_field_elements() -> String {
    let n: usize = 15;
    let pad = 9.0_f32;
    let step = (120.0 - pad * 2.0) / n as f32;
    let stars: [(usize, usize, f32); 4] = [
        (2, n - 3, 0.42),
        (2, 2, 0.34),
        (n - 3, n - 3, 0.36),
        (n - 3, 2, 0.34),
    ];

    let mut out = String::new();
    for r in 0..n {
        for c in 0..n {
            let x = pad + (c as f32 + 0.5) * step;
            let y = pad + (r as f32 + 0.5) * step;
            let nx = (x - 60.0) / 51.0;
            let ny = (y - 60.0) / 51.0;
            let mut v = quasar_orbital_field(nx, ny);
            let mut is_star = false;
            for &(sr, sc, sv) in &stars {
                if r == sr && c == sc && v < sv {
                    v = sv;
                    is_star = true;
                }
            }
            if v < 0.15 {
                continue;
            }
            let q = if v > 0.78 {
                0.90
            } else if v > 0.58 {
                0.75
            } else if v > 0.40 {
                0.58
            } else if v > 0.25 {
                0.42
            } else {
                0.28
            };
            let sz = step * q;
            let rx = sz * 0.22;
            let op = if is_star {
                0.72
            } else if v > 0.58 {
                1.0
            } else if v > 0.34 {
                0.85
            } else {
                0.62
            };
            if op < 0.99 {
                let _ = write!(
                    out,
                    r##"<rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}" rx="{:.2}" fill="#fff" fill-opacity="{:.2}"/>"##,
                    x - sz / 2.0,
                    y - sz / 2.0,
                    sz,
                    sz,
                    rx,
                    op
                );
            } else {
                let _ = write!(
                    out,
                    r##"<rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}" rx="{:.2}" fill="#fff"/>"##,
                    x - sz / 2.0,
                    y - sz / 2.0,
                    sz,
                    sz,
                    rx
                );
            }
        }
    }
    out
}

/// Tile + mark on a 120-unit grid. `small` is the optical variant for
/// 16–32 px: full-bleed black tile with the clean even-odd Quasar Orbital path.
fn icon_body(small: bool) -> String {
    if small {
        return format!(
            r##"<rect x="0" y="0" width="120" height="120" rx="22" fill="#000"/>
<path fill="#fff" fill-rule="evenodd" transform="translate(60 60) scale(0.92) rotate({QUASAR_ANGLE_DEG}) translate(-60 -60)" d="{SMALL_QUASAR_PATH}"/>"##
        );
    }
    let matrix = matrix_field_elements();
    format!(
        r##"<defs><linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{RIM_TOP}"/><stop offset="1" stop-color="{RIM_BOTTOM}"/></linearGradient></defs>
<rect x="2" y="2" width="116" height="116" rx="22" fill="url(#rim)"/>
<rect x="5.5" y="5.5" width="109" height="109" rx="18.5" fill="#0d0d0e"/>
<g transform="translate(60 60) scale(0.87) translate(-60 -60)">{matrix}</g>"##
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
