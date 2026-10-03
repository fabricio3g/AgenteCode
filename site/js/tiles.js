// Tiles — a mosaic of small squares in the brand orange. The slow field that
// used to be spelled out in ASCII glyphs now resolves into pixels: a horizon
// glow, wave rings rolling out of it, a drifting tide and a few embers, all
// quantized into a handful of brightness levels so the gradient reads as a
// pixel-art dither instead of a smooth wash.
//
// WebGL2 evaluates the field once per tile into an offscreen texture (cheap,
// resolution independent), then paints antialiased rounded tiles from it. A
// Canvas2D fallback draws the same math when WebGL2 is missing or `?nogl` is
// set. Colors come from CSS: --tile-accent, --tile-hi, --tile-alpha,
// --tile-levels, --tile-radius, --tile-inset.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const forceFallback = new URLSearchParams(location.search).has("nogl");
const UNIT = 720; // one field unit = 720 CSS px, so the shape is resolution free

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Pass 1 — one fragment per tile: how bright that tile is, 0..1.
const FRAG_FIELD = `#version 300 es
precision highp float;
uniform vec2 uGrid;     // tiles across / down
uniform vec2 uSize;     // field size, in field units
uniform float uTime;
uniform vec2 uFocus;    // glow center, fraction of width / height
uniform float uCorner;  // strength of the second light in the top-right
uniform float uWave;    // strength of the rings rolling out of the glow
uniform float uEmber;   // strength of the single-tile twinkles
uniform float uGamma;   // contrast: the field stays mostly empty

out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}


void main() {
  vec2 uv = gl_FragCoord.xy / uGrid;
  vec2 p = uv * uSize;
  float t = uTime;

  // A slow domain warp, so the tide breathes instead of sitting still.
  vec2 warp = vec2(noise(uv * 1.3 + vec2(t * 0.05, -t * 0.03)),
                   noise(uv * 1.3 + 7.3 - vec2(t * 0.04, t * 0.02))) - 0.5;
  vec2 q = p + warp * 0.10;

  // The horizon glow, swaying a little; a second light in the top-right corner.
  vec2 hc = uFocus * uSize + vec2(sin(t * 0.11) * 0.12, sin(t * 0.07) * 0.03);
  vec2 hd = (q - hc) * vec2(0.62, 1.55);
  float horizon = exp(-dot(hd, hd) * 1.5);
  vec2 cd = (q - vec2(uSize.x * 0.92, -0.08)) * vec2(0.9, 1.3);
  float corner = exp(-dot(cd, cd) * 3.2) * uCorner;

  // Low frequency swells only — no busy texture.
  float swell = noise(uv * 1.6 + vec2(t * 0.05, -t * 0.03)) * 0.6
              + noise(uv * 3.1 - vec2(t * 0.04, t * 0.02)) * 0.4;

  // Rings rolling out of the glow, with a finer chop along the horizon.
  float d = length((q - hc) * vec2(0.82, 1.0));
  float rings = pow(0.5 + 0.5 * sin(d * 11.0 - t * 0.7), 4.0) * uWave;
  float chop = (0.5 + 0.5 * sin(uv.x * 22.0 + t * 0.5)) * 0.07;

  float g = (horizon + corner) * (0.70 + 0.36 * swell) * (1.0 - chop);
  g += rings * (0.25 + 0.75 * horizon);

  g = clamp(g, 0.0, 1.0);

  // Embers: rare tiles flaring on their own phase, only where the field is lit.
  float id = hash(gl_FragCoord.xy * 1.37);
  float phase = hash(gl_FragCoord.xy * 2.11 + 3.7) * 6.2831;
  float pulse = pow(0.5 + 0.5 * sin(t * 1.6 + phase), 14.0);
  g += step(0.975, id) * pulse * smoothstep(0.12, 0.42, g) * uEmber;

  // Contrast: most tiles stay empty so the lit core carries the composition.
  outColor = vec4(pow(clamp(g, 0.0, 1.0), uGamma), 0.0, 0.0, 1.0);
}`;

// Pass 2 — fullscreen: read the tile brightness, quantize it with an ordered
// dither and fill the tile shape.
const FRAG_PAINT = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uCell;
uniform float uLevels;
uniform float uAlpha;
uniform float uFade;
uniform float uRadius;   // corner radius as a fraction of the tile size
uniform float uInset;    // gap between tiles, fraction of the cell
uniform vec3 uAccent;
uniform vec3 uHi;
uniform sampler2D uField;
out vec4 outColor;

// 4x4 ordered dither, so the level steps blend instead of banding.
float bayer(vec2 c) {
  int x = int(mod(c.x, 4.0)), y = int(mod(c.y, 4.0));
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[y * 4 + x]) + 0.5) / 16.0;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 tile = floor(px / uCell);
  vec2 local = fract(px / uCell);

  float v = texelFetch(uField, ivec2(tile), 0).r;
  float lev = clamp(floor(v * uLevels + bayer(tile)), 0.0, uLevels);
  if (lev < 0.5) { outColor = vec4(0.0); return; }
  float i = lev / uLevels;

  // The tile: a rounded square that grows a little as it brightens.
  float s = uInset * 0.5 * (0.88 + 0.12 * i);
  float r = min(uRadius * s * 2.0, s);
  vec2 q = abs(local - 0.5) - (s - r);
  float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
  float cov = 1.0 - smoothstep(-fwidth(d), fwidth(d), d);
  if (cov <= 0.002) { outColor = vec4(0.0); return; }

  vec3 col = mix(uAccent, uHi, pow(i, 1.6));
  float a = cov * uAlpha * uFade * pow(i, 1.35);
  outColor = vec4(col * a, a);
}`;

function readColors(el) {
  const cs = getComputedStyle(el);
  const rgb = (name, fallback) =>
    (cs.getPropertyValue(name).trim() || fallback).split(/[ ,]+/).map((n) => Number(n) / 255);
  const num = (name, fallback) => Number(cs.getPropertyValue(name).trim() || fallback);
  return {
    accent: rgb("--tile-accent", "232 121 58"),
    hi: rgb("--tile-hi", "255 186 148"),
    alpha: num("--tile-alpha", 0.9),
    levels: num("--tile-levels", 6),
    radius: num("--tile-radius", 0.35),
    inset: num("--tile-inset", 0.82),
  };
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, frag) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const cache = {};
  return {
    use() { gl.useProgram(p); return this; },
    loc(n) { return cache[n] ?? (cache[n] = gl.getUniformLocation(p, n)); },
  };
}

// A canvas only ever hands out one kind of context, so check WebGL2 and the
// field framebuffer on a throwaway canvas before touching the real one.
function canRenderField() {
  if (forceFallback) return false;
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2");
  if (!gl) return false;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return ok;
}

// A canvas that already handed out a context cannot give a 2D one, so a failed
// WebGL start swaps in a fresh element with the same id and classes.
function freshCanvas(dead) {
  const next = dead.cloneNode(false);
  dead.replaceWith(next);
  return next;
}

function webglRenderer(canvas, opts) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const field = program(gl, FRAG_FIELD);
  const paint = program(gl, FRAG_PAINT);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); // storage before the completeness check
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let cols = 1, rows = 1, size = [1, 1], cell = [1, 1], dpr = 1;
  let col = readColors(canvas);

  return {
    kind: "webgl2",
    resize(w, h, d) {
      size = [w, h];
      dpr = d;
      cell = [opts.cell[0] * d, opts.cell[1] * d];
      cols = Math.max(1, Math.ceil(w / cell[0]));
      rows = Math.max(1, Math.ceil(h / cell[1]));
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    },
    colors(c) { col = c; },
    draw(t, fade) {
      // 1 · the field, one fragment per tile
      field.use();
      gl.uniform2f(field.loc("uGrid"), cols, rows);
      gl.uniform2f(field.loc("uSize"), size[0] / (UNIT * dpr), size[1] / (UNIT * dpr));
      gl.uniform1f(field.loc("uTime"), t);
      gl.uniform2f(field.loc("uFocus"), opts.focus[0], opts.focus[1]);
      gl.uniform1f(field.loc("uCorner"), opts.corner);
      gl.uniform1f(field.loc("uWave"), opts.wave);
      gl.uniform1f(field.loc("uEmber"), opts.ember);
      gl.uniform1f(field.loc("uGamma"), opts.gamma);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, cols, rows);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2 · the tiles
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, size[0], size[1]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      paint.use();
      gl.uniform2f(paint.loc("uRes"), size[0], size[1]);
      gl.uniform2f(paint.loc("uCell"), cell[0], cell[1]);
      gl.uniform1f(paint.loc("uLevels"), col.levels);
      gl.uniform1f(paint.loc("uAlpha"), col.alpha * opts.dim);
      gl.uniform1f(paint.loc("uFade"), fade);
      gl.uniform1f(paint.loc("uRadius"), col.radius);
      gl.uniform1f(paint.loc("uInset"), col.inset);
      gl.uniform3fv(paint.loc("uAccent"), col.accent);
      gl.uniform3fv(paint.loc("uHi"), col.hi);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(paint.loc("uField"), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

// Canvas2D fallback: coarser tiles, the same field and levels, drawn with roundRect.
function canvasRenderer(canvas, opts) {
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, dpr = 1, col = readColors(canvas);
  const rgb = (a) => a.map((v) => Math.round(v * 255)).join(",");
  const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  return {
    kind: "canvas2d",
    fps: 15,
    resize(W, H, D) { w = W; h = H; dpr = D; },
    colors(c) { col = c; },
    draw(t, fade) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w / dpr, h / dpr);
      const [cw, ch] = opts.cell;
      const cols = Math.ceil(w / dpr / cw), rows = Math.ceil(h / dpr / ch);
      const sx = w / dpr / UNIT, sy = h / dpr / UNIT;
      const levels = col.levels;
      const hx = (opts.focus[0] + Math.sin(t * 0.11) * 0.12) * sx;
      const hy = opts.focus[1] * sy;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const px = (x + 0.5) / cols * sx, py = (y + 0.5) / rows * sy;
          const dx = (px - hx) * 0.62, dy = (py - hy) * 1.55;
          const cx = (px - sx * 0.92) * 0.9, cy = (py + sy * 0.08) * 1.3;
          const swell = 0.5 + 0.5 * Math.sin(px * 3.5 + t * 0.35) * Math.sin(py * 2.2 - t * 0.24);
          let g = (Math.exp(-(dx * dx + dy * dy) * 1.5) + Math.exp(-(cx * cx + cy * cy) * 3.2) * opts.corner)
                * (0.7 + 0.36 * swell);
          g = Math.min(1, g);
          const lev = Math.min(levels, Math.floor(g * levels + (B[(y % 4) * 4 + (x % 4)] + 0.5) / 16));
          if (lev < 1) continue;
          const i = lev / levels;
          const s = col.inset * cw * 0.5 * (0.88 + 0.12 * i);
          const r = Math.min(col.radius * s * 2, s);
          const mix = Math.pow(i, 1.6);
          ctx.fillStyle = `rgba(${rgb(col.accent.map((v, k) => v + (col.hi[k] - v) * mix))},${(col.alpha * fade * Math.pow(i, 1.35) * opts.dim).toFixed(3)})`;
          ctx.beginPath();
          ctx.roundRect((x + 0.5) * cw - s, (y + 0.5) * ch - s, s * 2, s * 2, r);
          ctx.fill();
        }
      }
    },
  };
}

/**
 * Mount a tile field on `canvas`. Options:
 *   cell: [w, h] CSS px per tile, focus: [x, y] glow center (0..1), corner: top-right
 *   light, wave / ember: motion strengths, dim: overall strength (the footer runs
 *   quieter so its wordmark stays readable).
 */
export function mountTiles(el, options = {}) {
  const opts = {
    cell: [12, 12], focus: [0.5, 1.0], corner: 0.5, wave: 0.22, ember: 0.55,
    gamma: 1.9, dim: 1, ...options,
  };
  let canvas = el;
  let r = null;
  if (canRenderField()) {
    try {
      r = webglRenderer(canvas, opts);
    } catch (e) {
      // The canvas already spent its one context, so start over with a new one.
      console.warn("tiles: webgl2 failed", e);
      canvas = freshCanvas(canvas);
    }
  }
  if (!r) r = canvasRenderer(canvas, opts);
  canvas.dataset.renderer = r.kind;

  let dpr = 1, visible = true, running = false, last = 0, time = 8, born = performance.now();
  let slow = false, avg = 16;
  const stats = { frames: 0, cpu: 0 };
  canvas.__tilesStats = stats;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    // Layout size, not the transformed rect, so a scaled canvas still gets a
    // full resolution buffer.
    const w = Math.max(1, Math.round((canvas.clientWidth || rect.width) * dprOf()));
    const h = Math.max(1, Math.round((canvas.clientHeight || rect.height) * dprOf()));
    if (w === canvas.width && h === canvas.height) return;
    dpr = dprOf();
    canvas.width = w;
    canvas.height = h;
    r.resize(w, h, dpr);
  }
  function dprOf() { return Math.min(devicePixelRatio || 1, 2); }
  function recolor() { r.colors(readColors(canvas)); }
  function still() { r.draw(time, 1); }

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
    const t0 = performance.now();
    try {
      r.draw(time, ease);
    } catch (e) {
      stats.errors = `${e?.message || e}`;
    }
    stats.cpu += performance.now() - t0;
    stats.frames++;
  }

  function update() {
    const want = visible && !document.hidden && !reduceMotion.matches;
    if (want && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
    if (!want) { running = false; if (reduceMotion.matches) still(); }
    stats.running = running;
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