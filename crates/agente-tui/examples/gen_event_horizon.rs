//! One-shot generator for `assets/event-horizon.svg` — the welcome hero.
//!
//! Deterministic port of the "ASCII Event Horizon" scene (black hole with
//! orbiting glyph ring, polar jets, photon halo, star field): the same
//! mulberry32 RNG, gaussian scatter, 9-layer ring, and draw order as the
//! reference animation, frozen at t=0. Run from the workspace root:
//!
//! ```sh
//! cargo run -p agente-tui --example gen_event_horizon
//! ```
//!
//! Then rasterize (resvg CLI, system monospace font supplies the texture):
//!
//! ```sh
//! resvg crates/agente-tui/assets/event-horizon.svg crates/agente-tui/assets/event-horizon.png
//! ```

use std::f64::consts::TAU;
use std::fmt::Write as _;
use std::fs;

const OUT: &str = "crates/agente-tui/assets/event-horizon.svg";
const SEED: u32 = 0x71c9_a2f3;

// Canvas — 936x720 = 4x the hero cell box (26x10 cells at ~9x18 px/cell).
const W: f64 = 936.0;
const H: f64 = 720.0;

const GLYPHS: [&str; 9] = ["@", "#", "%", "*", "+", "=", "-", ":", "."];
const STAR_GLYPHS: [&str; 6] = [".", ".", ".", ":", "+", "*"];

/// mulberry32 — bit-exact port of the reference `randomFactory`.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / f64::from(u32::MAX)
    }

    fn pick<'a>(&mut self, list: &[&'a str]) -> &'a str {
        list[(self.next() * list.len() as f64) as usize % list.len()]
    }

    /// Box-Muller, same pairing as the reference `gaussian`.
    fn gaussian(&mut self) -> f64 {
        let u = self.next().max(1e-7);
        let v = self.next();
        (-2.0 * u.ln()).sqrt() * (TAU * v).cos()
    }
}

struct Glyph {
    x: f64,
    y: f64,
    size: f64,
    alpha: f64,
    ch: &'static str,
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

fn main() {
    let mut rng = Rng(SEED);
    let scale = W.min(H);
    let center_x = W * 0.5;
    let center_y = H * 0.53;

    // ── Scene build (counts and spreads from the reference) ──
    let star_count = clamp(W * H / 2550.0, 160.0, 760.0) as usize;
    let ring_count = clamp(W * 1.12, 620.0, 1320.0) as usize;
    let jet_count = clamp(H * 0.25, 120.0, 300.0) as usize;
    let clusters = [
        (0.18_f64, 0.22_f64, 0.046_f64),
        (0.84, 0.31, 0.032),
        (0.76, 0.81, 0.048),
        (0.13, 0.76, 0.023),
    ];

    let mut glyphs: Vec<Glyph> = Vec::new();

    // Stars (29% gathered into the off-axis dust clusters).
    for i in 0..star_count {
        let clustered = (i as f64) < star_count as f64 * 0.29;
        let cluster = clusters[i % clusters.len()];
        let (x, y) = if clustered {
            (
                (cluster.0 + rng.gaussian() * cluster.2) * W,
                (cluster.1 + rng.gaussian() * cluster.2) * H,
            )
        } else {
            (rng.next() * W, rng.next() * H)
        };
        let ch = rng.pick(&STAR_GLYPHS);
        let size = 8.0 + rng.next() * 10.0;
        let alpha = (0.16 + rng.next().powf(2.2) * 0.84) * 1.35;
        glyphs.push(Glyph {
            x,
            y,
            size,
            alpha,
            ch,
        });
    }

    // Polar jets.
    for _ in 0..jet_count {
        let distance = rng.next().powf(1.35) * if rng.next() > 0.5 { 1.0 } else { -1.0 };
        let offset = rng.gaussian();
        let ch = rng.pick(&GLYPHS[2..]);
        let size = 7.5 + rng.next() * 7.0;
        let alpha = (0.18 + (1.0 - distance.abs()) * 0.68) * 1.35;
        let taper = 1.5 + distance.abs() * 17.0;
        let signed_travel = if distance >= 0.0 { 0.0 } else { -0.0 }; // t = 0
        let y = center_y + (distance + signed_travel) * scale * 1.28;
        let x = center_x + offset * taper + (0.0_f64).sin() * (1.5 + distance.abs() * 4.0);
        let flicker = 0.7;
        glyphs.push(Glyph {
            x,
            y,
            size,
            alpha: alpha * flicker * (1.0 - distance.abs() * 0.5),
            ch,
        });
    }

    // Orbiting glyph ring: 9 layers, flattened, back half first.
    struct Ring {
        layer: usize,
        angle: f64,
        radius: f64,
        size: f64,
        alpha: f64,
        scatter: f64,
        ch: &'static str,
    }
    let mut ring_particles: Vec<Ring> = Vec::with_capacity(ring_count);
    for index in 0..ring_count {
        let layer = index % 9;
        let layer_t = layer as f64 / 8.0;
        ring_particles.push(Ring {
            layer,
            angle: rng.next() * TAU,
            radius: 0.245 + layer_t * 0.245 + rng.gaussian() * (0.006 + layer_t * 0.013),
            size: 8.0 + (1.0 - layer_t) * 6.0 + rng.next() * 2.5,
            alpha: 0.24 + (1.0 - layer_t) * 0.66 + rng.next() * 0.1,
            scatter: rng.gaussian(),
            ch: rng.pick(&GLYPHS),
        });
    }

    let draw_ring = |ring_particles: &Vec<Ring>, foreground: bool, glyphs: &mut Vec<Glyph>| {
        for p in ring_particles {
            let spin = p.angle; // t = 0
            let radius = p.radius * scale;
            let x_orbit = spin.cos() * radius;
            let depth = spin.sin();
            if (depth >= 0.0) != foreground {
                continue;
            }
            let thickness = p.scatter * (1.3 + p.layer as f64 * 0.42);
            let y_orbit = depth * radius * 0.205 + thickness;
            let depth_light = 0.68 + (depth + 1.0) * 0.16;
            let inner_boost = 1.0 - p.layer as f64 / 13.0;
            glyphs.push(Glyph {
                x: center_x + x_orbit,
                y: center_y + y_orbit,
                size: p.size * (0.9 + (depth + 1.0) * 0.075),
                alpha: p.alpha * depth_light * 0.84 * inner_boost,
                ch: p.ch,
            });
        }
    };

    draw_ring(&ring_particles, false, &mut glyphs);

    // Photon halo around the core.
    let halo_count = clamp(scale * 0.32, 80.0, f64::INFINITY) as usize;
    for i in 0..halo_count {
        let angle = (i as f64 / halo_count as f64) * TAU;
        let irregular = (i as f64 * 12.9898).sin() * 0.5 + 0.5;
        let radius = scale * 0.084 * (1.05 + irregular * 0.13);
        let flatten = 0.84 + angle.sin() * 0.06;
        glyphs.push(Glyph {
            x: center_x + angle.cos() * radius,
            y: center_y + angle.sin() * radius * flatten,
            size: 8.0 + irregular * 4.5,
            alpha: (0.36 + irregular * 0.48) * 1.3,
            ch: GLYPHS[i % GLYPHS.len()],
        });
    }

    // Front half of the ring passes in front of the black core.
    draw_ring(&ring_particles, true, &mut glyphs);

    // ── Emit the SVG ──
    let mut svg = String::with_capacity(glyphs.len() * 90 + 512);
    svg.push_str(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="936" height="720" viewBox="0 0 936 720">
  <rect width="936" height="720" fill="#020202"/>
  <g font-family="Consolas, Cascadia Mono, DejaVu Sans Mono, monospace" fill="#f8f8f5" text-anchor="middle" dominant-baseline="central">
"##,
    );
    for g in &glyphs {
        if g.alpha <= 0.015 {
            continue;
        }
        let _ = writeln!(
            svg,
            r#"    <text x="{:.2}" y="{:.2}" font-size="{:.1}" opacity="{:.3}">{}</text>"#,
            g.x,
            g.y,
            g.size.max(4.0),
            g.alpha.clamp(0.0, 1.0),
            g.ch
        );
    }
    svg.push_str("  </g>\n</svg>\n");

    fs::write(OUT, &svg).expect("write assets/event-horizon.svg");
    println!(
        "wrote {OUT}: {} glyph nodes, {}x{}",
        glyphs.len(),
        W as u32,
        H as u32
    );
}
