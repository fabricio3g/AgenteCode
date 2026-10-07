#!/usr/bin/env python3
"""Compose review sheets and an animated GIF from the authored frames."""
from __future__ import annotations
import pathlib, sys
from PIL import Image

PANEL = (0x18, 0x18, 0x1c, 255)   # hero card surface (dark theme)
INK = (0x00, 0x00, 0x00, 255)     # hero canvas

def load(p):
    return Image.open(p).convert("RGBA")

def sheet(paths, scale=12, gap=6, bg=PANEL):
    tiles = [load(p).resize((Image.open(p).width * scale, Image.open(p).height * scale), Image.NEAREST)
             for p in paths]
    w = sum(t.width for t in tiles) + gap * (len(tiles) + 1)
    h = max(t.height for t in tiles) + gap * 2
    out = Image.new("RGBA", (w, h), bg)
    x = gap
    for t in tiles:
        out.alpha_composite(t, (x, gap))
        x += t.width + gap
    return out

def gif(paths, out, scale=10, durations=None, loop=0, bg=PANEL):
    frames = [load(p).resize((Image.open(p).width * scale, Image.open(p).height * scale), Image.NEAREST)
              for p in paths]
    base = Image.new("RGBA", frames[0].size, bg)
    composed = []
    for f in frames:
        c = base.copy()
        c.alpha_composite(f)
        composed.append(c.convert("P", palette=Image.ADAPTIVE, colors=16))
    durations = durations or [180] * len(composed)
    composed[0].save(out, save_all=True, append_images=composed[1:], duration=durations, loop=loop, disposal=2)
    return out

if __name__ == "__main__":
    d = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    idle = [d / "idle-a.png", d / "idle-b.png"]
    allf = [d / "idle-a.png", d / "idle-b.png", d / "blink.png", d / "idle-a.png", d / "happy.png", d / "wave.png"]
    sheet(allf).save(out / "sheet.png")
    gif(allf, out / "idle.gif", durations=[160, 160, 90, 700, 260, 500])
    print("wrote", out / "sheet.png", out / "idle.gif")
