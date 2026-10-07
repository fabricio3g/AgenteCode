#!/usr/bin/env python3
"""Scratchpad for the Agente mascot: author the sprite as text and look at it
the way the terminal will paint it (one cell = 2 pixels tall) before it moves
into Rust.

legend: ' ' empty · '.' ink tile · ':' tile edge · 'W' off-white · 'T' amber · 't' dim amber
"""
from __future__ import annotations

W = H = 16

def blank():
    return [[" "] * W for _ in range(H)]

def put(g, x, y, c):
    if 0 <= x < W and 0 <= y < H:
        g[y][x] = c

# ── the ink tile body, the app icon come alive ────────────────────────────────
# Rounded 12x10 tile: x 2..13, y 3..12, corners cut so the silhouette rounds.
BODY_X0, BODY_X1, BODY_Y0, BODY_Y1 = 2, 13, 3, 12

def body(g):
    for x in range(BODY_X0, BODY_X1 + 1):
        put(g, x, BODY_Y0, ":")          # top edge
        put(g, x, BODY_Y1, ":")          # bottom edge
    for y in range(BODY_Y0, BODY_Y1 + 1):
        put(g, BODY_X0, y, ":")          # left edge
        put(g, BODY_X1, y, ":")          # right edge
    for y in range(BODY_Y0 + 1, BODY_Y1):
        for x in range(BODY_X0 + 1, BODY_X1):
            put(g, x, y, ".")
    for x, y in ((BODY_X0, BODY_Y0), (BODY_X1, BODY_Y0), (BODY_X0, BODY_Y1), (BODY_X1, BODY_Y1)):
        put(g, x, y, " ")                # cut corners -> rounded tile

# ── the floating tilde: the logo's wave, hovering above the head ─────────────
TILDE_X, TILDE_Y = 4, 0

def tilde(g, flip=False):
    """The 8x2 tilde from `welcome::ICON`, optionally flipped vertically."""
    up = [(2, 0), (3, 0), (6, 0), (7, 0)]
    lo = [(0, 1), (1, 1), (4, 1), (5, 1)]
    for dx, dy in (lo + up if flip else up + lo):
        put(g, TILDE_X + dx, TILDE_Y + dy, "T")

# ── face ─────────────────────────────────────────────────────────────────────
def eyes(g, state="open"):
    if state == "open":
        for x, y in ((5, 6), (6, 6), (5, 7), (6, 7), (9, 6), (10, 6), (9, 7), (10, 7)):
            put(g, x, y, "T")
    elif state == "blink":
        for x in (5, 6, 9, 10):
            put(g, x, 7, "t")
    elif state == "happy":                   # ^ ^
        for x, y in ((4, 7), (5, 6), (6, 6), (7, 7), (8, 7), (9, 6), (10, 6), (11, 7)):
            put(g, x, y, "T")

def smile(g, on=True):
    if on:
        for x, y in ((6, 10), (9, 10), (7, 11), (8, 11)):
            put(g, x, y, "T")

def feet(g):
    for x in (5, 6, 9, 10):
        put(g, x, 13, "W")

def arms(g, wave=False):
    for y in (8, 9):
        put(g, 1, y, ":")
    if wave:
        for y in (6, 7, 8):
            put(g, 14, y, ":")
        put(g, 15, 6, ":")
    else:
        for y in (8, 9):
            put(g, 14, y, ":")

def frame(eye="open", flip=False, wave=False):
    g = blank()
    tilde(g, flip)
    body(g)
    eyes(g, eye)
    smile(g)
    feet(g)
    arms(g, wave)
    return ["".join(r) for r in g]

GLYPH = {(" ", " "): " ", (" ", "."): "▄", (".", " "): "▀", (".", "."): "█",
         (" ", ":"): "╩", (":", " "): "╦", (":", ":"): "▊", (".", ":"): "▄",
         (":", "."): "▀", (" ", "T"): "t", ("T", " "): "T", ("T", "T"): "▓",
         (" ", "W"): "w", ("W", " "): "W", (".", "T"): "τ", ("T", "."): "Γ",
         (":", "T"): "τ", ("T", ":"): "Γ", (".", "t"): "·", ("t", "."): "·",
         (" ", "t"): "·", ("t", " "): "·", ("W", "."): "w", (".", "W"): "W",
         (":", "W"): "w", ("W", ":"): "W"}

def show(name, rows):
    print(f"-- {name}")
    for line in rows:
        print("   " + line)
    print("   as painted (cell = 1 col x 2 px):")
    for y in range(0, H, 2):
        print("     " + "".join(GLYPH.get((rows[y][x], rows[y + 1][x]), "?") for x in range(W)))

if __name__ == "__main__":
    for name, kw in (("idle", {}), ("idle-flip", {"flip": True}),
                     ("blink", {"eye": "blink"}), ("happy", {"eye": "happy"}),
                     ("wave", {"wave": True})):
        rows = frame(**kw)
        assert len({len(r) for r in rows}) == 1 and len(rows) == H
        show(name, rows)
