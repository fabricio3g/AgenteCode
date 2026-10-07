#!/usr/bin/env python3
"""Final mascot geometry: 16x16 sprite, one pixel per character. Prints the
sprite the way the terminal paints it (2 chars per pixel) and emits the Rust
constants, so the art and the TUI never drift apart."""
from __future__ import annotations
W = H = 16

def blank(): return [[" "] * W for _ in range(H)]
def put(g, x, y, c):
    if 0 <= x < W and 0 <= y < H: g[y][x] = c

# Crest = the logo's own tilde (local 8x2), riding the antenna.
CREST_UP = [(2, 0), (3, 0), (6, 0), (7, 0)]   # upper stroke, `welcome::ICON` row 4
CREST_LO = [(0, 1), (1, 1), (4, 1), (5, 1)]   # lower stroke, `welcome::ICON` row 5
CREST_X = 4
TILE_X0, TILE_X1, TILE_Y0, TILE_Y1 = 2, 13, 3, 13
EYE_Y = 7
EYE_L, EYE_R = 5, 9
MOUTH = [(6, 11), (9, 11), (7, 12), (8, 12)]
FEET = [5, 6, 9, 10]
FOOT_Y = 14

def crest(g, flip=False):
    for dx, dy in (CREST_LO + CREST_UP if flip else CREST_UP + CREST_LO):
        put(g, CREST_X + dx, dy, "T")

def stalk(g):
    for x in (7, 8): put(g, x, 2, ":")

def tile(g):
    for x in range(TILE_X0, TILE_X1 + 1):
        put(g, x, TILE_Y0, ":"); put(g, x, TILE_Y1, ":")
    for y in range(TILE_Y0, TILE_Y1 + 1):
        put(g, TILE_X0, y, ":"); put(g, TILE_X1, y, ":")
    for y in range(TILE_Y0 + 1, TILE_Y1):
        for x in range(TILE_X0 + 1, TILE_X1): put(g, x, y, ".")
    for c in ((TILE_X0, TILE_Y0), (TILE_X1, TILE_Y0), (TILE_X0, TILE_Y1), (TILE_X1, TILE_Y1)):
        put(g, *c, " ")

def eyes(g, state="open"):
    for x0 in (EYE_L, EYE_R):
        if state == "open":
            for dx in (0, 1):
                for dy in (0, 1): put(g, x0 + dx, EYE_Y + dy, "T")
        elif state == "blink":
            put(g, x0, EYE_Y + 1, "t"); put(g, x0 + 1, EYE_Y + 1, "t")
        elif state == "happy":
            put(g, x0 + 1, EYE_Y, "T"); put(g, x0, EYE_Y + 1, "T"); put(g, x0 + 2, EYE_Y + 1, "T")

def mouth(g):
    for x, y in MOUTH: put(g, x, y, "T")

def feet(g, dy=0):
    for x in FEET: put(g, x, FOOT_Y + dy, "W")

def arms(g, wave=False):
    for y in (8, 9): put(g, 1, y, ":")
    if wave:
        for y in (5, 6, 7): put(g, 14, y, ":")
        put(g, 15, 5, ":")
    else:
        for y in (8, 9): put(g, 14, y, ":")

def frame(eye="open", flip=False, wave=False, dy=0):
    g = blank()
    crest(g, flip); stalk(g); tile(g); eyes(g, eye); mouth(g); feet(g, dy); arms(g, wave)
    return ["".join(r) for r in g]

def show(name, rows):
    print(f"-- {name}")
    for r in rows:
        print("    " + "".join(c * 2 for c in r))
    print()

if __name__ == "__main__":
    base = frame()
    for name, kw in (("idle", {}), ("blink", {"eye": "blink"}), ("happy", {"eye": "happy"}),
                     ("wave", {"wave": True}), ("crest-flip", {"flip": True})):
        show(name, frame(**kw))
    print("# rust: crest rows (8 wide, painted at x+4)")
    print("const CREST: [&str; 2] = [")
    for dy in (0, 1):
        print(f'    "{"".join("T" if (dx, dy) in CREST_UP + CREST_LO else " " for dx in range(8))}",')
    print("];")
    print("# rust: tile block, rows 2..=13 (12 wide, painted at x+2)")
    print("const TILE: [&str; 12] = [")
    for y in range(2, 14):
        print(f'    "{"".join(base[y][2:14])}",')
    print("];")
