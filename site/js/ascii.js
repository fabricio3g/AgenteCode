// ASCII gradient field — a slow, domain-warped noise gradient drawn as
// characters from a density ramp. WebGL2 with a runtime glyph atlas; a
// Canvas2D fallback (the TUI's tilde-sea math) when WebGL2 is missing or
// `?nogl` is set. Colors come from CSS: --ascii-ink, --ascii-accent, --ascii-alpha.

const RAMP = [" ", "·", ":", "-", "~", "+", "*"];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const forceFallback = new URLSearchParams(location.search).has("nogl");

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;       // canvas size, device px
uniform vec2 uCell;      // cell size, device px
uniform float uDpr;
uniform float uTime;
uniform float uFade;     // intro 0..1
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uAlpha;
uniform vec3 uPointer;   // xy in field units, z = strength
uniform vec2 uFocus;     // horizon center, fraction of width/height
uniform float uCorner;   // strength of the top-right glow
uniform float uGlyphs;
uniform sampler2D uAtlas;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// 4x4 ordered dither, so the gradient steps blend instead of banding.
float bayer(vec2 c) {
  int x = int(mod(c.x, 4.0)), y = int(mod(c.y, 4.0));
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[y * 4 + x]) + 0.5) / 16.0;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 cell = floor(px / uCell);
  vec2 local = fract(px / uCell);
  float unit = 720.0 * uDpr;                            // field unit = 720 CSS px
  vec2 uv = (cell + 0.5) * uCell / unit;
  vec2 size = uRes / unit;
  float t = uTime;

  // A wide horizon glow that breathes and sways slowly…
  vec2 hc = uFocus * size + vec2(sin(t * 0.11) * 0.12, sin(t * 0.07) * 0.03);
  vec2 hd = (uv - hc) * vec2(0.62, 1.55);
  float horizon = exp(-dot(hd, hd) * 1.5);
  // …a faint second light in the top-right corner…
  vec2 cd = (uv - vec2(size.x * 0.92, -0.08)) * vec2(0.9, 1.3);
  float corner = exp(-dot(cd, cd) * 3.2) * uCorner;
  // …and soft drifting swells (low frequency only: no busy texture).
  float swell = noise(uv * 1.6 + vec2(t * 0.05, -t * 0.03)) * 0.6
              + noise(uv * 3.1 - vec2(t * 0.04, t * 0.02)) * 0.4;
  float ripple = sin(uv.x * 7.0 + uv.y * 2.0 - t * 0.35) * 0.5 + 0.5;

  float g = (horizon + corner) * (0.72 + 0.38 * swell) * (0.9 + 0.1 * ripple);
  vec2 toP = uv - uPointer.xy;
  g += exp(-dot(toP, toP) * 22.0) * uPointer.z * 0.22;
  g = clamp(g, 0.0, 1.0);

  float level = g * (uGlyphs - 1.0);
  float idx = clamp(floor(level + bayer(cell)), 0.0, uGlyphs - 1.0);
  float glyph = texture(uAtlas, vec2((idx + local.x) / uGlyphs, local.y)).r;

  vec3 warm = mix(uAccent, vec3(1.0, 0.86, 0.74), smoothstep(0.75, 1.0, g) * 0.35);
  vec3 color = mix(uInk, warm, smoothstep(0.12, 0.7, g));
  float a = glyph * uAlpha * uFade * (0.35 + 0.65 * g);
  outColor = vec4(color * a, a);
}`;

function readColors(el) {
  const cs = getComputedStyle(el);
  const rgb = (name, fallback) =>
    (cs.getPropertyValue(name).trim() || fallback).split(/[ ,]+/).map((n) => Number(n) / 255);
  return {
    ink: rgb("--ascii-ink", "150 150 150"),
    accent: rgb("--ascii-accent", "232 121 58"),
    alpha: Number(cs.getPropertyValue("--ascii-alpha").trim() || 0.35),
  };
}

async function buildAtlas(cellW, cellH) {
  const font = `500 ${Math.round(cellH * 0.78)}px "IBM Plex Mono", ui-monospace, monospace`;
  try { await document.fonts?.load(font, RAMP.join("")); } catch (e) { /* system mono is fine */ }
  const c = document.createElement("canvas");
  c.width = cellW * RAMP.length;
  c.height = cellH;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.font = font;
  g.textAlign = "center";
  g.textBaseline = "middle";
  RAMP.forEach((ch, i) => g.fillText(ch, i * cellW + cellW / 2, cellH * 0.54));
  return c;
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

async function webglRenderer(canvas, opts) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const u = (n) => gl.getUniformLocation(prog, n);
  const loc = {
    res: u("uRes"), cell: u("uCell"), time: u("uTime"), fade: u("uFade"), ink: u("uInk"),
    accent: u("uAccent"), alpha: u("uAlpha"), pointer: u("uPointer"), focus: u("uFocus"),
    glyphs: u("uGlyphs"), atlas: u("uAtlas"), dpr: u("uDpr"), corner: u("uCorner"),
  };

  const atlas = await buildAtlas(32, 64);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(loc.atlas, 0);
  gl.uniform1f(loc.glyphs, RAMP.length);
  gl.uniform2f(loc.focus, opts.focus[0], opts.focus[1]);
  gl.uniform1f(loc.corner, opts.corner);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  return {
    kind: "webgl2",
    resize(w, h, dpr) {
      gl.viewport(0, 0, w, h);
      gl.uniform2f(loc.res, w, h);
      gl.uniform2f(loc.cell, opts.cell[0] * dpr, opts.cell[1] * dpr);
      gl.uniform1f(loc.dpr, dpr);
    },
    colors(c) {
      gl.uniform3fv(loc.ink, c.ink);
      gl.uniform3fv(loc.accent, c.accent);
      gl.uniform1f(loc.alpha, c.alpha);
    },
    draw(t, fade, pointer) {
      gl.uniform1f(loc.time, t);
      gl.uniform1f(loc.fade, fade);
      gl.uniform3f(loc.pointer, pointer.x, pointer.y, pointer.s);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

// Canvas2D fallback: coarser cells, the TUI tilde-sea swell trains.
function canvasRenderer(canvas, opts) {
  const ctx = canvas.getContext("2d");
  const cw = opts.cell[0] + 2, ch = opts.cell[1] + 4;
  let w = 0, h = 0, dpr = 1, col = { ink: [0.6, 0.6, 0.6], accent: [0.9, 0.47, 0.23], alpha: 0.3 };
  const rgb = (a) => a.map((v) => Math.round(v * 255)).join(",");
  return {
    kind: "canvas2d",
    fps: 15,
    resize(W, H, D) { w = W; h = H; dpr = D; },
    colors(c) { col = c; },
    draw(t, fade) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w / dpr, h / dpr);
      ctx.font = `500 ${Math.round(ch * 0.7)}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const cols = Math.ceil(w / dpr / cw), rows = Math.ceil(h / dpr / ch);
      const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
      const hx = opts.focus[0] * cols + Math.sin(t * 0.11) * 6, hy = opts.focus[1] * rows;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const dx = (x - hx) / (cols * 0.8), dy = (y - hy) / (rows * 0.5);
          const cx = (x - cols * 0.92) / (cols * 0.45), cy = (y + rows * 0.08) / (rows * 0.4);
          const swell = 0.5 + 0.5 * Math.sin(x * 0.08 + t * 0.3) * Math.sin(y * 0.15 - t * 0.2);
          let g = (Math.exp(-(dx * dx + dy * dy) * 2) + Math.exp(-(cx * cx + cy * cy) * 2) * opts.corner) * (0.75 + 0.35 * swell);
          g = Math.min(1, g);
          const i = Math.min(RAMP.length - 1, Math.floor(g * (RAMP.length - 1) + (B[(y % 4) * 4 + (x % 4)] + 0.5) / 16));
          if (i <= 0) continue;
          const c = g > 0.45 ? col.accent : col.ink;
          ctx.fillStyle = `rgba(${rgb(c)},${(col.alpha * fade * (0.35 + 0.65 * g)).toFixed(3)})`;
          ctx.fillText(RAMP[i], x * cw + cw / 2, y * ch + ch / 2);
        }
      }
    },
  };
}

/**
 * Mount a field on `canvas`. Options:
 *   cell: [w, h] CSS px, focus: [x, y] glow center (0..1), interactive: follow the pointer.
 */
export async function mountAscii(canvas, options = {}) {
  const opts = { cell: [8, 16], focus: [0.5, 1.0], corner: 0.5, interactive: false, ...options };
  let r = null;
  if (!forceFallback) {
    try { r = await webglRenderer(canvas, opts); } catch (e) { console.warn("ascii: webgl2 failed", e); r = null; }
  }
  if (!r) r = canvasRenderer(canvas, opts);
  canvas.dataset.renderer = r.kind;

  let dpr = 1, visible = true, running = false, last = 0, time = 8, born = performance.now();
  let slow = false, avg = 16;
  const pointer = { x: 0, y: 0, s: 0 }, target = { x: 0, y: 0, s: 0 };
  const stats = { frames: 0, cpu: 0 };
  canvas.__asciiStats = stats;

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    r.resize(canvas.width, canvas.height, dpr);
  }
  function recolor() { r.colors(readColors(canvas)); }
  function still() { r.draw(time, 1, { x: 0, y: 0, s: 0 }); }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    const minGap = r.fps ? 1000 / r.fps : slow ? 32 : 0;
    if (now - last < minGap - 1) return;
    last = now;
    avg = avg * 0.95 + dt * 1000 * 0.05;
    if (!r.fps && !slow && avg > 22 && stats.frames > 90) slow = true; // settle at ~30fps

    const age = (now - born) / 1000;
    const ease = 1 - Math.pow(1 - Math.min(age / 1.2, 1), 3); // speed + fade ease in
    time += dt * ease;
    pointer.x += (target.x - pointer.x) * 0.08;
    pointer.y += (target.y - pointer.y) * 0.08;
    pointer.s += (target.s - pointer.s) * 0.08;
    const t0 = performance.now();
    r.draw(time, ease, pointer);
    stats.cpu += performance.now() - t0;
    stats.frames++;
  }

  function update() {
    const want = visible && !document.hidden && !reduceMotion.matches;
    if (want && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
    if (!want) { running = false; if (reduceMotion.matches) still(); }
    stats.running = running;
  }

  if (opts.interactive) {
    const host = canvas.parentElement;
    host.addEventListener("pointermove", (e) => {
      const b = canvas.getBoundingClientRect();
      target.x = (e.clientX - b.left) / 720;
      target.y = (e.clientY - b.top) / 720;
      target.s = 1;
    });
    host.addEventListener("pointerleave", () => { target.s = 0; });
  }

  resize();
  recolor();
  if (reduceMotion.matches) still();
  new ResizeObserver(() => { resize(); if (!running) still(); }).observe(canvas);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; update(); }).observe(canvas);
  document.addEventListener("visibilitychange", update);
  reduceMotion.addEventListener("change", update);
  document.addEventListener("themechange", () => { recolor(); if (!running) still(); });
  canvas.classList.add("ready");
  update();
  return r.kind;
}
