#!/usr/bin/env python3
"""Author the Agente mascot frames as palette-indexed pixel art.

Pixels are placed explicitly (that is what pixel art is); LibreSprite then
turns the frames into an editable `.aseprite` source and the brand exports.
Palette is the fixed brand set, so the mascot renders the same in both themes.
"""
from __future__ import annotations
import pathlib
import sys

W = H = 16

# Fixed brand palette (matches crates/agente-tui/src/widgets/welcome.rs).
PALETTE = {
    " ": (0, 0, 0, 0),            # transparent
    ".": (0x11, 0x13, 0x17, 255),  # ink tile
    ":": (0x2a, 0x2d, 0x34, 255),  # tile edge (silhouette)
    "W": (0xf2, 0xf2, 0xf3, 255),  # off-white
    "T": (0xe5, 0xa4, 0x45, 255),  # amber
    "t": (0x9a, 0x72, 0x33, 255),  # dim amber
}
ORDER = list(PALETTE)

def blank():
    return [[" "] * W for _ in range(H)]

def put(g, x, y, c):
    if 0 <= x < W and 0 <= y < H:
        g[y][x] = c

def body(g, top=3, bottom=12):
    """Rounded 12x10 ink tile, corners cut so the silhouette reads round."""
    x0, x1 = 2, 13
    for x in range(x0, x1 + 1):
        put(g, x, top, ":")
        put(g, x, bottom, ":")
    for y in range(top, bottom + 1):
        put(g, x0, y, ":")
        put(g, x1, y, ":")
    for y in range(top + 1, bottom):
        for x in range(x0 + 1, x1):
            put(g, x, y, ".")
    for corner in ((x0, top), (x1, top), (x0, bottom), (x1, bottom)):
        put(g, *corner, " ")

def tilde(g, y=0, flip=False):
    """The logo's 8x2 tilde (`welcome::ICON`), hovering above the head."""
    up = [(2, 0), (3, 0), (6, 0), (7, 0)]
    lo = [(0, 1), (1, 1), (4, 1), (5, 1)]
    for dx, dy in (lo + up if flip else up + lo):
        put(g, 4 + dx, y + dy, "T")

def eyes(g, state="open", y=6):
    left = (5, 6)
    right = (9, 10)
    if state == "open":
        for x0 in (left, right):
            for dx in (0, 1):
                for dy in (0, 1):
                    put(g, x0[0] + dx, y + dy, "T")
    elif state == "blink":
        for x0 in (left, right):
            put(g, x0[0], y + 1, "t")
            put(g, x0[0] + 1, y + 1, "t")
    elif state == "happy":                      # ^ ^
        for x0 in (left, right):
            put(g, x0[0] + 1, y, "T")
            put(g, x0[0], y + 1, "T")
            put(g, x0[0] + 2, y + 1, "T")

def mouth(g, on=True):
    if on:
        for x, y in ((6, 10), (9, 10), (7, 11), (8, 11)):
            put(g, x, y, "T")

def feet(g, y=13):
    for x in (5, 6, 9, 10):
        put(g, x, y, "W")

def arms(g, wave=False):
    if wave:
        for y in (5, 6, 7):
            put(g, 14, y, ":")
        put(g, 15, 5, ":")
    else:
        for y in (8, 9):
            put(g, 1, y, ":")
            put(g, 14, y, ":")

def frame(eye="open", flip=False, wave=False, down=0):
    g = blank()
    tilde(g, 0 + down, flip)
    body(g, 3 + down, 12 + down)
    eyes(g, eye, 6 + down)
    mouth(g)
    feet(g, 13 + down)
    arms(g, wave)
    return ["".join(r) for r in g]

FRAMES = {
    "idle-a": frame(),
    "idle-b": frame(down=1),
    "blink": frame(eye="blink"),
    "happy": frame(eye="happy"),
    "wave": frame(wave=True),
}

def write_png(rows, path: pathlib.Path):
    from PIL import Image
    im = Image.new("RGBA", (W, H))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            im.putpixel((x, y), PALETTE[ch])
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)
    return path

def write_sheet(path: pathlib.Path, rows: list[str], scale: int = 8, gap: int = 4, bg=(0, 0, 0, 255)):
    from PIL import Image
    n = len(rows)
    tile = W * scale
    im = Image.new("RGBA", (n * tile + (n + 1) * gap, tile + 2 * gap), bg)
    src = Image.new("RGBA", (W, H))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            src.putpixel((x, y), PALETTE[ch])
        pass
    return im

def main() -> int:
    out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("out")
    for name, rows in FRAMES.items():
        assert len({len(r) for r in rows}) == 1, f"{name} is ragged"
        write_png(rows, out / f"{name}.png")
        print(f"wrote {out / (name + '.png')}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
