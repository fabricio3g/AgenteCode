// glfx: a tiny WebGL2 effect runner. One full-screen fragment shader per effect,
// optionally fed by a ping-pong simulation, with theme colours as uniforms.
// WebGL2 runs nearly everywhere WebGPU does not (Linux Chrome, older Safari),
// so this is the engine the landing ships; callers fall back to tiles on null.

const HEADER = `#version 300 es
precision highp float;
uniform vec2 u_res;      // drawing-buffer size in px
uniform float u_time;    // seconds
uniform vec2 u_mouse;    // px, y up; far off-screen when there is no pointer
uniform float u_dpr;
out vec4 o;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + 1.0), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p * 2.02 + 17.0; a *= 0.5; }
  return v;
}
// Triangular noise of about one 8-bit step, so smooth gradients never band.
vec3 deband(vec3 c, vec2 frag) { return c + (hash(frag) + hash(frag + 0.593) - 1.0) / 255.0; }
`;

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl, fragSrc, colorNames) {
  const decl = colorNames.map((n) => `uniform vec3 c_${n};`).join("\n");
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, HEADER + decl + "\n" + fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link failed");
  const loc = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(p, i).name;
    loc[name] = gl.getUniformLocation(p, name);
  }
  return { p, loc };
}

export function hasWebGL2() {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

/**
 * Mount an effect on a canvas. Returns a controller, or null when WebGL2 (or a
 * simulation's float render targets) is unavailable, so the caller can fall back.
 * effect: { colors: string[], frag: string, dpr?: number, sim?: { frag, scale, steps, seed(w, h) } }
 */
export function mountGL(canvas, effect, palette) {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, powerPreference: "low-power" });
  if (!gl) return null;
  if (effect.sim && !gl.getExtension("EXT_color_buffer_float")) return null;

  let main, sim;
  try {
    main = compile(gl, effect.frag, effect.colors);
    if (effect.sim) sim = compile(gl, effect.sim.frag, []);
  } catch (e) {
    console.error("glfx:", e.message);
    return null;
  }

  const maxDpr = effect.dpr ?? 1.5;
  let colors = palette;
  let w = 0, h = 0, dpr = 1;
  let mouse = [-1e5, -1e5];
  let running = false, visible = true, raf = 0, destroyed = false;
  const t0 = performance.now();
  // Reduced motion gets one still frame from a moment where the effect has settled.
  const stillTime = 40;

  // ---- simulation state (ping-pong RG16F textures) ----
  let tex = [], fbo = [], sw = 0, sh = 0, cur = 0;
  function initSim() {
    for (const t of tex) gl.deleteTexture(t);
    for (const f of fbo) gl.deleteFramebuffer(f);
    sw = Math.max(32, Math.round(w / effect.sim.scale));
    sh = Math.max(32, Math.round(h / effect.sim.scale));
    const data = effect.sim.seed(sw, sh);
    tex = []; fbo = [];
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, sw, sh, 0, gl.RG, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      tex.push(t); fbo.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    cur = 0;
  }
  function stepSim(n) {
    gl.useProgram(sim.p);
    gl.viewport(0, 0, sw, sh);
    gl.uniform2f(sim.loc.u_res, sw, sh);
    gl.uniform2f(sim.loc.u_mouse, mouse[0] * sw / w, mouse[1] * sh / h);
    gl.uniform1i(sim.loc.u_state, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 0; i < n; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - cur]);
      gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      cur = 1 - cur;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function draw(time) {
    if (sim) stepSim(reduceMotion.matches ? 0 : effect.sim.steps);
    gl.useProgram(main.p);
    gl.viewport(0, 0, w, h);
    const L = main.loc;
    gl.uniform2f(L.u_res, w, h);
    gl.uniform1f(L.u_time, time);
    gl.uniform2f(L.u_mouse, mouse[0], mouse[1]);
    gl.uniform1f(L.u_dpr, dpr);
    // A key the caller forgot simply keeps its default, instead of throwing.
    for (const n of effect.colors) if (L[`c_${n}`] && colors[n]) gl.uniform3fv(L[`c_${n}`], hexToRgb(colors[n]));
    if (sim) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
      gl.uniform1i(L.u_state, 0);
      gl.uniform2f(L.u_simres, sw, sh);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, maxDpr);
    const nw = Math.max(1, Math.round(r.width * dpr)), nh = Math.max(1, Math.round(r.height * dpr));
    if (nw === w && nh === h) return;
    w = canvas.width = nw; h = canvas.height = nh;
    if (sim) {
      initSim();
      // A still frame needs a grown pattern, not the seed.
      if (reduceMotion.matches) stepSim(3000);
    }
    if (!running) draw(stillTime);
  }

  function frame() {
    raf = 0;
    if (!running) return;
    draw((performance.now() - t0) / 1000);
    raf = requestAnimationFrame(frame);
  }
  function sync() {
    const want = visible && !document.hidden && !reduceMotion.matches && !destroyed && !paused;
    if (want && !running) { running = true; raf = requestAnimationFrame(frame); }
    else if (!want && running) { running = false; cancelAnimationFrame(raf); raf = 0; }
  }

  let paused = false;
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); });
  io.observe(canvas);
  const onVis = () => sync();
  document.addEventListener("visibilitychange", onVis);
  // Content sits over the canvas, so track the pointer on the window.
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    mouse = x < 0 || y < 0 || x > r.width || y > r.height ? [-1e5, -1e5] : [x * dpr, (r.height - y) * dpr];
  };
  addEventListener("pointermove", onMove, { passive: true });

  resize();
  sync();

  return {
    setColors(p) { colors = p; if (!running) draw(stillTime); },
    pause() { paused = true; sync(); },
    resume() { paused = false; sync(); },
    destroy() {
      destroyed = true; sync();
      ro.disconnect(); io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      removeEventListener("pointermove", onMove);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
