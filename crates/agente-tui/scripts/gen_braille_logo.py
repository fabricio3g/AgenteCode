#!/usr/bin/env python3
"""
Generate a high-quality AM (amplitude-modulated) halftone of the AGENTE wordmark.

Inspired by https://halftone.xoihazard.com/ (Vector Halftone Maker):
  - Square screen of circular dots
  - Dot radius ∝ local ink coverage
  - Export SVG of circles + compact Unicode braille for the TUI

Outputs:
  assets/agente-wordmark-halftone.svg  (vector circles)
  src/brand_logo_data.rs               (2–3 row braille for terminal)
"""

from __future__ import annotations

import math
from pathlib import Path

# ── Bold geometric letterforms (unit cells) ───────────────────────────────
# Each glyph is drawn as filled polygons on a continuous plane, then sampled.

GLYPH_PATHS: dict[str, list[list[tuple[float, float]]]] = {
    # Coordinates in [0,1]×[0,1] (y down). Thick strokes for readable halftone.
    "F": [
        [(0.05, 0.05), (0.95, 0.05), (0.95, 0.22), (0.28, 0.22), (0.28, 0.42),
         (0.78, 0.42), (0.78, 0.58), (0.28, 0.58), (0.28, 0.95), (0.05, 0.95)],
    ],
    "L": [
        [(0.05, 0.05), (0.28, 0.05), (0.28, 0.78), (0.95, 0.78), (0.95, 0.95),
         (0.05, 0.95)],
    ],
    "A": [
        # outer
        [(0.50, 0.05), (0.95, 0.95), (0.72, 0.95), (0.62, 0.72), (0.38, 0.72),
         (0.28, 0.95), (0.05, 0.95)],
        # crossbar hole is painted as positive bar instead of hole for simplicity
    ],
    "X": [
        [(0.05, 0.05), (0.22, 0.05), (0.50, 0.38), (0.78, 0.05), (0.95, 0.05),
         (0.95, 0.22), (0.62, 0.50), (0.95, 0.78), (0.95, 0.95), (0.78, 0.95),
         (0.50, 0.62), (0.22, 0.95), (0.05, 0.95), (0.05, 0.78), (0.38, 0.50),
         (0.05, 0.22)],
    ],
    "E": [
        [(0.05, 0.05), (0.95, 0.05), (0.95, 0.22), (0.28, 0.22), (0.28, 0.42),
         (0.78, 0.42), (0.78, 0.58), (0.28, 0.58), (0.28, 0.78), (0.95, 0.78),
         (0.95, 0.95), (0.05, 0.95)],
    ],
    "O": [
        # annulus approximated as outer disc minus later (filled oval for mask)
        # outer rounded rect-ish via many points of ellipse
    ],
}

# Bitmap fallback (cleaner for A crossbar / O ring) — 8×10 bold
GLYPH_BITS: dict[str, list[str]] = {
    "F": [
        "########",
        "########",
        "##......",
        "##......",
        "######..",
        "######..",
        "##......",
        "##......",
        "##......",
        "##......",
    ],
    "L": [
        "##......",
        "##......",
        "##......",
        "##......",
        "##......",
        "##......",
        "##......",
        "##......",
        "########",
        "########",
    ],
    "A": [
        "..####..",
        ".######.",
        "##....##",
        "##....##",
        "########",
        "########",
        "##....##",
        "##....##",
        "##....##",
        "##....##",
    ],
    "X": [
        "##....##",
        "##....##",
        ".##..##.",
        "..####..",
        "...##...",
        "...##...",
        "..####..",
        ".##..##.",
        "##....##",
        "##....##",
    ],
    "E": [
        "########",
        "########",
        "##......",
        "##......",
        "######..",
        "######..",
        "##......",
        "##......",
        "########",
        "########",
    ],
    "O": [
        "..####..",
        ".######.",
        "##....##",
        "##....##",
        "##....##",
        "##....##",
        "##....##",
        "##....##",
        ".######.",
        "..####..",
    ],
}

# Braille packing 2×4
DOT_MAP = [
    (0, 0, 0x01),
    (1, 0, 0x02),
    (2, 0, 0x04),
    (3, 0, 0x40),
    (0, 1, 0x08),
    (1, 1, 0x10),
    (2, 1, 0x20),
    (3, 1, 0x80),
]


def render_text_mask(text: str, px_h: int, letter_gap: int) -> tuple[list[list[float]], int, int]:
    """Grayscale mask 0..1 (1 = ink), height px_h, auto width."""
    gh = len(next(iter(GLYPH_BITS.values())))
    gw = len(next(iter(GLYPH_BITS.values()))[0])
    scale = max(1, px_h // gh)
    # supersample then box-filter for soft edges
    ss = 3
    cell = scale * ss
    gap = letter_gap * ss
    chars = list(text)
    raw_w = len(chars) * gw * cell + max(0, len(chars) - 1) * gap
    raw_h = gh * cell
    raw = [[0.0] * raw_w for _ in range(raw_h)]

    x0 = 0
    for i, ch in enumerate(chars):
        g = GLYPH_BITS[ch]
        for y, row in enumerate(g):
            for x, c in enumerate(row):
                if c != "#":
                    continue
                for dy in range(cell):
                    for dx in range(cell):
                        raw[y * cell + dy][x0 + x * cell + dx] = 1.0
        x0 += gw * cell
        if i + 1 < len(chars):
            x0 += gap

    # Downsample ss×ss → soft coverage
    out_h = raw_h // ss
    out_w = raw_w // ss
    out = [[0.0] * out_w for _ in range(out_h)]
    for y in range(out_h):
        for x in range(out_w):
            s = 0.0
            for dy in range(ss):
                for dx in range(ss):
                    s += raw[y * ss + dy][x * ss + dx]
            out[y][x] = s / (ss * ss)
    return out, out_w, out_h


def am_halftone_circles(
    mask: list[list[float]],
    w: int,
    h: int,
    cell: float,
    angle_deg: float = 22.5,
) -> list[tuple[float, float, float]]:
    """
    Classical square-screen AM halftone (like Vector Halftone Maker 'Square').
    Returns list of (cx, cy, radius) in pixel space.
    Dot area ∝ local ink; max radius ≈ cell * 0.5 * sqrt(2) * k.
    """
    theta = math.radians(angle_deg)
    ct, st = math.cos(theta), math.sin(theta)
    # Rotated lattice covering the bbox
    # Map pixel (x,y) → screen coords
    circles: list[tuple[float, float, float]] = []

    # Extent of rotated grid
    corners = [(0, 0), (w, 0), (0, h), (w, h)]
    us = [ct * x + st * y for x, y in corners]
    vs = [-st * x + ct * y for x, y in corners]
    u0, u1 = min(us) - cell, max(us) + cell
    v0, v1 = min(vs) - cell, max(vs) + cell

    u = u0
    while u <= u1:
        v = v0
        while v <= v1:
            # screen → pixel
            cx = ct * u - st * v
            cy = st * u + ct * v
            if -cell <= cx < w + cell and -cell <= cy < h + cell:
                # sample average ink in cell neighborhood
                ink = sample_avg(mask, w, h, cx, cy, cell * 0.45)
                if ink > 0.04:
                    # area proportional to ink; radius = cell * sqrt(ink) * k
                    r = cell * 0.48 * math.sqrt(min(1.0, ink * 1.15))
                    if r > 0.35:
                        circles.append((cx, cy, r))
            v += cell
        u += cell
    return circles


def sample_avg(
    mask: list[list[float]], w: int, h: int, cx: float, cy: float, rad: float
) -> float:
    x0 = max(0, int(cx - rad))
    x1 = min(w - 1, int(cx + rad))
    y0 = max(0, int(cy - rad))
    y1 = min(h - 1, int(cy + rad))
    if x1 < x0 or y1 < y0:
        return 0.0
    s = 0.0
    n = 0
    r2 = rad * rad
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            if dx * dx + dy * dy <= r2:
                s += mask[y][x]
                n += 1
    return s / n if n else 0.0


def rasterize_circles(
    circles: list[tuple[float, float, float]], w: int, h: int
) -> list[list[bool]]:
    grid = [[False] * w for _ in range(h)]
    for cx, cy, r in circles:
        r2 = r * r
        x0 = max(0, int(cx - r - 1))
        x1 = min(w - 1, int(cx + r + 1))
        y0 = max(0, int(cy - r - 1))
        y1 = min(h - 1, int(cy + r + 1))
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                dx, dy = x + 0.5 - cx, y + 0.5 - cy
                if dx * dx + dy * dy <= r2:
                    grid[y][x] = True
    return grid


def to_braille(grid: list[list[bool]], max_rows: int = 3) -> list[str]:
    h, w = len(grid), len(grid[0])
    # pad
    while h % 4:
        grid.append([False] * w)
        h += 1
    if w % 2:
        for row in grid:
            row.append(False)
        w += 1

    rows = []
    for by in range(0, h, 4):
        chars = []
        for bx in range(0, w, 2):
            bits = 0
            for dy, dx, bit in DOT_MAP:
                yy, xx = by + dy, bx + dx
                if yy < h and xx < w and grid[yy][xx]:
                    bits |= bit
            chars.append(chr(0x2800 + bits))
        s = "".join(chars).rstrip("\u2800")
        if any(c != "\u2800" for c in s):
            rows.append(s)
    if len(rows) > max_rows:
        # Keep middle band if somehow too tall
        rows = rows[:max_rows]
    return rows


def write_svg(
    path: Path,
    circles: list[tuple[float, float, float]],
    w: int,
    h: int,
    margin: float = 8.0,
) -> None:
    """Vector circles SVG in the spirit of halftone.xoihazard.com export."""
    vb_w = w + margin * 2
    vb_h = h + margin * 2
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb_w:.1f} {vb_h:.1f}" '
        f'role="img" aria-label="AGENTE">',
        "  <title>AGENTE</title>",
        f'  <rect width="100%" height="100%" fill="#0f0f12"/>',
        f'  <g fill="#8abeb7" transform="translate({margin},{margin})">',
    ]
    for cx, cy, r in circles:
        parts.append(f'    <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}"/>')
    parts.append("  </g>")
    parts.append("</svg>")
    path.write_text("\n".join(parts) + "\n", encoding="utf-8")


def write_braille_rs(path: Path, lines: list[str]) -> None:
    body = ",\n".join(f'    "{line}"' for line in lines)
    width = max((len(l) for l in lines), default=0)
    src = f"""// @generated by scripts/gen_braille_logo.py — do not edit by hand.
// AM circular-dot half-tone (square screen), same idea as https://halftone.xoihazard.com/
// Source: assets/agente-wordmark-halftone.svg
// Compact braille for TUI: {len(lines)} rows × {width} cols.

pub const AGENTE_BRAILLE: &[&str] = &[
{body}
];

pub const AGENTE_BRAILLE_WIDTH: usize = {width};
pub const AGENTE_BRAILLE_HEIGHT: usize = {len(lines)};
"""
    path.write_text(src, encoding="utf-8")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    assets = root / "assets"
    assets.mkdir(exist_ok=True)

    # High-res mask (short aspect — not tall)
    # height ~28 px → after braille ≈ 7 cells → too tall; aim h=12–16 → 3–4 braille max
    # For 2 braille rows need h≈8. Use h=16 and then vertical downsample 2:1 before braille.
    mask, w, h = render_text_mask("AGENTE", px_h=20, letter_gap=2)

    # Screen cell: smaller = denser (SOFT-like). ~2.2–2.8 px for fine half-tone.
    cell = 2.4
    circles = am_halftone_circles(mask, w, h, cell=cell, angle_deg=22.5)

    # SVG export (true vector half-tone)
    svg_path = assets / "agente-wordmark-halftone.svg"
    write_svg(svg_path, circles, w, h)

    # Also keep a simple text SVG reference
    (assets / "agente-wordmark.svg").write_text(
        f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="AGENTE">
  <title>AGENTE (mask reference)</title>
  <rect width="{w}" height="{h}" fill="#fff"/>
  <!-- Halftone circles live in agente-wordmark-halftone.svg -->
</svg>
""",
        encoding="utf-8",
    )

    # Raster circles → bool → compress height to 8 for 2 braille rows
    ink = rasterize_circles(circles, w, h)
    target_h = 8
    if h > target_h:
        # OR-pool vertical bands
        band = h / target_h
        small = [[False] * w for _ in range(target_h)]
        for y in range(target_h):
            y0 = int(y * band)
            y1 = int((y + 1) * band)
            for yy in range(y0, min(y1, h)):
                for x in range(w):
                    if ink[yy][x]:
                        small[y][x] = True
        ink = small
        h = target_h

    # Optional horizontal downscale if very wide
    max_braille_cols = 36
    if w // 2 > max_braille_cols:
        target_w = max_braille_cols * 2
        band = w / target_w
        small_w = [[False] * target_w for _ in range(h)]
        for x in range(target_w):
            x0 = int(x * band)
            x1 = int((x + 1) * band)
            for xx in range(x0, min(x1, w)):
                for y in range(h):
                    if ink[y][xx]:
                        small_w[y][x] = True
        ink = small_w
        w = target_w

    lines = to_braille(ink, max_rows=2)
    rs_path = root / "src" / "brand_logo_data.rs"
    write_braille_rs(rs_path, lines)

    print(f"circles={len(circles)} mask={w}x{h}")
    print(f"Wrote {svg_path}")
    print(f"Wrote {rs_path} ({len(lines)} rows × {max(map(len, lines), default=0)} cols)")
    for line in lines:
        print(line)


if __name__ == "__main__":
    main()
