#!/usr/bin/env python3
"""Convert assets/agente-hero.png into src/brand_logo_data.rs (braille hero)."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

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


def strip_cols(rows: list[str]) -> list[str]:
    if not rows:
        return rows
    max_len = max(len(r) for r in rows)
    rows = [r.ljust(max_len, "\u2800") for r in rows]
    left = 0
    while left < max_len and all(r[left] == "\u2800" for r in rows):
        left += 1
    right = max_len
    while right > left and all(r[right - 1] == "\u2800" for r in rows):
        right -= 1
    return [r[left:right].rstrip("\u2800") for r in rows]


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    src = root / "assets" / "agente-hero.png"
    out_rs = root / "src" / "brand_logo_data.rs"

    im = Image.open(src).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    im = Image.alpha_composite(bg, im).convert("L")

    # ~72 braille columns keeps the hero readable on typical 80-col terminals
    # while preserving the wide AGENTE code aspect.
    target_braille_cols = 72
    target_w = target_braille_cols * 2
    aspect = im.height / im.width
    target_h = max(8, int(round(target_w * aspect)))
    if target_h % 4:
        target_h += 4 - (target_h % 4)

    im = im.resize((target_w, target_h), Image.Resampling.LANCZOS)

    # Black half-tone dots on white → ink where dark
    threshold = 200
    grid: list[list[bool]] = []
    for y in range(target_h):
        row = [im.getpixel((x, y)) < threshold for x in range(target_w)]
        grid.append(row)

    h, w = len(grid), len(grid[0])
    if w % 2:
        for row in grid:
            row.append(False)
        w += 1
    if h % 4:
        for _ in range(4 - (h % 4)):
            grid.append([False] * w)
        h = len(grid)

    lines: list[str] = []
    for by in range(0, h, 4):
        chars: list[str] = []
        for bx in range(0, w, 2):
            bits = 0
            for dy, dx, bit in DOT_MAP:
                yy, xx = by + dy, bx + dx
                if yy < h and xx < w and grid[yy][xx]:
                    bits |= bit
            chars.append(chr(0x2800 + bits))
        s = "".join(chars).rstrip("\u2800")
        if any(c != "\u2800" for c in s):
            lines.append(s)

    lines = strip_cols(lines)
    width = max((len(l) for l in lines), default=0)
    body = ",\n".join(f'    "{line}"' for line in lines)
    out_rs.write_text(
        f"""// @generated from assets/agente-hero.png — do not edit by hand.
// Half-tone AGENTE code wordmark used as the welcome hero.
// Braille: {len(lines)} rows × {width} cols.

pub const AGENTE_BRAILLE: &[&str] = &[
{body}
];

pub const AGENTE_BRAILLE_WIDTH: usize = {width};
pub const AGENTE_BRAILLE_HEIGHT: usize = {len(lines)};
""",
        encoding="utf-8",
    )
    print(f"raster={target_w}x{target_h} braille={width}x{len(lines)}")
    print(f"Wrote {out_rs}")
    for line in lines:
        print(line)


if __name__ == "__main__":
    main()
