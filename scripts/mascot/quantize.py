#!/usr/bin/env python3
"""Judge a generated mascot image by re-pixelating it into the Agente palette.

Crops to the character, downscales to a sprite grid, snaps every pixel to the
brand palette and prints the result as text (so the sprite can be read without
looking at the PNG) plus metrics that predict how it will read at 20 px in the
terminal: silhouette symmetry, palette spread, edge cleanliness.
"""
from __future__ import annotations
import sys, pathlib
from PIL import Image, ImageChops, ImageFilter

# Brand palette: ink tile, panel, off-white mark, amber accent, dim amber.
PALETTE = [
    (" ", (0x11, 0x13, 0x17), "transparent/ink"),
    (".", (0x1f, 0x22, 0x29), "panel"),
    ("#", (0xf2, 0xf2, 0xf3), "off-white"),
    ("+", (0xe5, 0xa4, 0x45), "amber"),
    ("-", (0x8a, 0x6a, 0x35), "dim amber"),
]

def content_box(img: Image.Image, tol: int = 18) -> tuple[int, int, int, int]:
    """Bounding box of the subject: everything that differs from the corner color."""
    rgb = img.convert("RGB")
    bg = rgb.getpixel((0, 0))
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
    mask = diff.point(lambda v: 255 if v > tol else 0).filter(ImageFilter.MaxFilter(3))
    box = mask.getbbox()
    return box or (0, 0, rgb.width, rgb.height)

def to_sprite(path: pathlib.Path, width: int, pad: int = 1) -> list[list[int]]:
    """Palette index per pixel of a `width`-wide square sprite."""
    img = Image.open(path).convert("RGBA")
    x0, y0, x1, y1 = content_box(img)
    img = img.crop((x0, y0, x1, y1))
    # Square it around the subject so the aspect never skews the sprite.
    side = max(img.size)
    sq = Image.new("RGBA", (side, side), img.getpixel((0, 0)))
    sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    inner = max(4, width - pad * 2)
    small = sq.resize((inner, inner), Image.LANCZOS)
    rows = [[0] * width for _ in range(width)]
    for y in range(inner):
        for x in range(inner):
            r, g, b, a = small.getpixel((x, y))
            rows[y + pad][x + pad] = nearest(r, g, b)
    return rows

def nearest(r: int, g: int, b: int) -> int:
    best, best_d = 0, 1 << 30
    for i, (_, (pr, pg, pb), _) in enumerate(PALETTE):
        d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
        if d < best_d:
            best, best_d = i, d
    return best

def preview(rows: list[list[int]], half: bool = True) -> str:
    out = []
    step = 2 if half else 1
    for y in range(0, len(rows), step):
        line = "".join(PALETTE[p][0] for p in rows[y])
        if half and y + 1 < len(rows):
            line += "   "
            line += "".join(PALETTE[p][0] for p in rows[y + 1])
        out.append(line)
    return "\n".join(out)

def metrics(rows: list[list[int]]) -> str:
    n = len(rows)
    counts = [0] * len(PALETTE)
    for r in rows:
        for p in r:
            counts[p] += 1
    subject = sum(counts[1:])
    mirror = sum(1 for y in range(n) for x in range(n // 2) if rows[y][x] != rows[y][n - 1 - x])
    filled = sum(1 for p in (p for r in rows for p in r) if p != 0)
    return (f"grid={n}  subject={subject}px  ink={counts[0]} panel={counts[1]} "
            f"white={counts[2]} amber={counts[3]} dim={counts[4]}  "
            f"mirror-mismatch={100 * mirror / max(1, (n * n) // 2):.0f}%  "
            f"coverage={100 * filled // (n * n)}%")

if __name__ == "__main__":
    args = sys.argv[1:]
    path = pathlib.Path(args[0])
    width = int(args[1]) if len(args) > 1 else 24
    rows = to_sprite(path, width)
    print(f"== {path}  at {width}px")
    print(metrics(rows))
    print(preview(rows))
