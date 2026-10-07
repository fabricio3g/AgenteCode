#!/usr/bin/env python3
"""Side-by-side text render of sprite variants (2 chars per pixel, correct aspect)."""
from __future__ import annotations
W = H = 16

def blank(): return [[" "] * W for _ in range(H)]
def put(g, x, y, c):
    if 0 <= x < W and 0 <= y < H: g[y][x] = c

def body(g, top=3, bot=12):
    x0, x1 = 2, 13
    for x in range(x0, x1 + 1):
        put(g, x, top, ":"); put(g, x, bot, ":")
    for y in range(top, bot + 1):
        put(g, x0, y, ":"); put(g, x1, y, ":")
    for y in range(top + 1, bot):
        for x in range(x0 + 1, x1): put(g, x, y, ".")
    for c in ((x0, top), (x1, top), (x0, bot), (x1, bot)): put(g, *c, " ")

def wave_wide(g, y=0, flip=False):
    """The logo's 8x2 tilde, hovering."""
    up = [(2, 0), (3, 0), (6, 0), (7, 0)]; lo = [(0, 1), (1, 1), (4, 1), (5, 1)]
    for dx, dy in (lo + up if flip else up + lo): put(g, 4 + dx, y + dy, "T")

def wave_compact(g, y=0, flip=False):
    """4x2 wave on a 2px stalk: an antenna whose tip is the tilde."""
    up = [(1, 0), (2, 0)]; lo = [(0, 1), (3, 1)]
    for dx, dy in (lo + up if flip else up + lo): put(g, 6 + dx, y + dy, "T")
    for y2 in (y + 2, y + 3): put(g, 7, y2, ":"); put(g, 8, y2, ":")

def wave_compact_float(g, y=0, flip=False):
    up = [(1, 0), (2, 0)]; lo = [(0, 1), (3, 1)]
    for dx, dy in (lo + up if flip else up + lo): put(g, 6 + dx, y + dy, "T")

def eyes(g, state="open", y=6):
    L, R = 5, 9
    if state == "open":
        for x0 in (L, R):
            for dx in (0, 1):
                for dy in (0, 1): put(g, x0 + dx, y + dy, "T")
    elif state == "blink":
        for x0 in (L, R): put(g, x0, y + 1, "t"); put(g, x0 + 1, y + 1, "t")
    elif state == "happy":
        for x0 in (L, R):
            put(g, x0 + 1, y, "T"); put(g, x0, y + 1, "T"); put(g, x0 + 2, y + 1, "T")

def mouth(g, on=True):
    if on:
        for x, y in ((6, 10), (9, 10), (7, 11), (8, 11)): put(g, x, y, "T")

def feet(g, y=13):
    for x in (5, 6, 9, 10): put(g, x, y, "W")

def arms(g, wave=False):
    if wave:
        for y in (5, 6, 7): put(g, 14, y, ":")
        put(g, 15, 5, ":")
    else:
        for y in (8, 9): put(g, 1, y, ":"); put(g, 14, y, ":")

def show(name, rows, eye="open", wave=False, mouth_on=True):
    g = blank()
    if name == "wide": wave_wide(g)
    elif name == "antenna": wave_compact(g)
    else: wave_compact_float(g)
    body(g); eyes(g, eye); mouth(g, mouth_on); feet(g); arms(g, wave)
    print(f"-- {name} ({eye})")
    for y in range(0, H, 2):
        print("    " + "".join(f"{rows[y][x] if False else ''}" + g[y][x] * 2 for x in range(W))[:76])
    print()

if __name__ == "__main__":
    show("wide", None)
    show("antenna", None)
    show("float", None)
    show("float-blink", None, eye="blink")
    show("float-happy", None, eye="happy")
    show("float-wave", None, wave=True)
