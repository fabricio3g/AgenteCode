// Slow-motion Pastel Supernova & Atmospheric Wash WebGL2 background engine
// Designed to sit underneath monochrome antique natural-science engravings
// (multiply in Light mode, screen in Dark mode) for an illuminated folio effect.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uDark;   // 0.0 = warm archival light, 1.0 = deep velvet dark
uniform int uMode;     // 0 = pastel supernova, 1 = sunlit pastel wash, 2 = celestial corona
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec2 m = (uMouse - 0.5) * vec2(aspect, 1.0);
  float t = uTime * 0.14;

  // Pastel palette — Anthropic-inspired warm clay, mineral sky, dusty lavender, botanical sage
  vec3 lightPaper = vec3(0.961, 0.945, 0.914); // #F5F1E9
  vec3 darkSpace  = vec3(0.075, 0.072, 0.068); // #131211

  vec3 pClay     = mix(vec3(0.925, 0.725, 0.620), vec3(0.840, 0.460, 0.300), uDark);
  vec3 pSky      = mix(vec3(0.710, 0.825, 0.890), vec3(0.360, 0.560, 0.740), uDark);
  vec3 pLavender = mix(vec3(0.815, 0.760, 0.875), vec3(0.510, 0.430, 0.680), uDark);
  vec3 pSage     = mix(vec3(0.760, 0.840, 0.755), vec3(0.370, 0.560, 0.460), uDark);
  vec3 pGold     = mix(vec3(0.955, 0.865, 0.710), vec3(0.920, 0.720, 0.460), uDark);

  // Supernova / focal center weighted gently to the right-center so left text stays serene
  vec2 center = (uMode == 1) ? vec2(0.05 * aspect, -0.06) : vec2(0.24 * aspect, 0.02);
  center += m * 0.055;

  vec2 d = p - center;
  float r = length(d);
  float ang = atan(d.y, d.x);

  // Domain-warped organic nebula flow
  vec2 q = vec2(fbm(p * 1.45 + vec2(t * 0.35, -t * 0.25)),
                fbm(p * 1.45 + vec2(-t * 0.22, t * 0.31) + 4.3));
  vec2 w = vec2(fbm(p * 1.9 + q * 1.35 + vec2(t * 0.18, 2.1)),
                fbm(p * 1.9 + q * 1.35 + vec2(-1.4, -t * 0.16)));

  float n1 = fbm(p * 1.5 + w * 1.15);
  float n2 = fbm(p * 2.6 - q * 0.9 + vec2(t * 0.12));

  vec3 base = mix(lightPaper, darkSpace, uDark);
  vec3 col = base;

  if (uMode == 0) {
    // Mode 0: Slow-Motion Pastel Supernova
    float core = exp(-r * r * 3.2);
    // Slow expanding shockwave shells
    float wave1 = sin(r * 7.5 - t * 2.4 + n1 * 3.2) * 0.5 + 0.5;
    float wave2 = sin(r * 13.0 - t * 3.1 + n2 * 4.0) * 0.5 + 0.5;
    float shell = smoothstep(0.15, 0.95, wave1) * exp(-abs(r - 0.36 - 0.06 * sin(t * 0.8)) * 3.8);
    float outerShell = smoothstep(0.3, 0.95, wave2) * exp(-abs(r - 0.62) * 3.2);

    // Filaments radiating softly outward
    float rays = fbm(vec2(ang * 3.0 + n1 * 1.8, r * 2.2 - t * 0.9));
    float halo = exp(-r * 1.65) * (0.55 + 0.65 * rays);

    vec3 neb = mix(pSky, pLavender, smoothstep(0.28, 0.74, n1));
    neb = mix(neb, pClay, smoothstep(0.35, 0.78, shell + halo * 0.55));
    neb = mix(neb, pGold, core * 0.75);
    neb = mix(neb, pSage, outerShell * 0.45);

    float strength = mix(0.62, 0.82, uDark);
    float mask = clamp(halo * 0.95 + shell * 0.7 + outerShell * 0.45 + core * 0.85, 0.0, 1.0);
    // Keep left copy area gently calmer
    float copyCalm = smoothstep(-0.72 * aspect, 0.25 * aspect, p.x);
    mask *= mix(0.42, 1.0, copyCalm);

    col = mix(base, neb, mask * strength);

    // Subtle slow-drifting cosmic motes
    vec2 cell = floor((p + vec2(t * 0.04, -t * 0.02)) * 26.0);
    vec2 f = fract((p + vec2(t * 0.04, -t * 0.02)) * 26.0) - 0.5;
    float rnd = hash(cell);
    float twinkle = 0.5 + 0.5 * sin(t * 4.0 + rnd * 40.0);
    float mote = step(0.955, rnd) * smoothstep(0.14, 0.0, length(f)) * twinkle * mask;
    col = mix(col, mix(pClay, vec3(1.0, 0.96, 0.88), uDark), mote * mix(0.45, 0.85, uDark));
  } else if (uMode == 1) {
    // Mode 1: Sunlit Pastel Watercolor Atmospheric Wash
    float b1 = smoothstep(0.22, 0.82, fbm(p * 1.2 + q * 0.85 + vec2(t * 0.14, 0.0)));
    float b2 = smoothstep(0.28, 0.80, fbm(p * 1.5 - w * 0.85 + vec2(0.0, -t * 0.12)));
    float b3 = smoothstep(0.35, 0.85, n2);

    vec3 wash = mix(base, pClay, b1 * mix(0.46, 0.42, uDark));
    wash = mix(wash, pSky, b2 * mix(0.48, 0.44, uDark));
    wash = mix(wash, pSage, b3 * mix(0.36, 0.30, uDark));
    wash = mix(wash, pGold, exp(-r * r * 2.2) * mix(0.32, 0.35, uDark));
    col = wash;
  } else {
    // Mode 2: Celestial Corona & Pastel Dust
    float ring = exp(-pow((r - 0.38) * 6.2, 2.0));
    float corona = exp(-r * 2.1) * (0.5 + 0.5 * fbm(vec2(ang * 4.5, r * 3.0 - t * 0.7)));
    float mist = smoothstep(0.25, 0.85, n1) * 0.5;
    vec3 tint = mix(pLavender, pSky, smoothstep(-0.4, 0.5, d.y));
    tint = mix(tint, pClay, ring * 0.85 + corona * 0.5);
    tint = mix(tint, pGold, ring * smoothstep(0.4, 0.9, n2) * 0.6);
    float msk = clamp(ring * 0.85 + corona * 0.65 + mist * 0.42, 0.0, 1.0);
    col = mix(base, tint, msk * mix(0.60, 0.78, uDark));
  }

  // Gentle deband dither so pastel gradients never band
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s));
  }
  return s;
}

export function mountSupernova(canvas, opts = {}) {
  if (!canvas) return null;
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (!gl) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const uRes = gl.getUniformLocation(prog, "uRes");
  const uTime = gl.getUniformLocation(prog, "uTime");
  const uMouse = gl.getUniformLocation(prog, "uMouse");
  const uDark = gl.getUniformLocation(prog, "uDark");
  const uMode = gl.getUniformLocation(prog, "uMode");

  const modeMap = { supernova: 0, wash: 1, corona: 2 };
  const mode = modeMap[opts.mode || "supernova"] ?? 0;

  let mx = 0.5, my = 0.5, tx = 0.5, ty = 0.5;
  let darkTarget = document.documentElement.dataset.theme === "dark" ? 1 : 0;
  let darkCur = darkTarget;
  let visible = true;
  let raf = 0;
  let start = performance.now();

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };

  const render = (now) => {
    raf = 0;
    if (!visible && !reduceMotion.matches) return;
    resize();
    tx += (mx - tx) * 0.04;
    ty += (my - ty) * 0.04;
    darkCur += (darkTarget - darkCur) * 0.1;

    gl.useProgram(prog);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, reduceMotion.matches ? 14.0 : (now - start) * 0.001);
    gl.uniform2f(uMouse, tx, 1.0 - ty);
    gl.uniform1f(uDark, darkCur);
    gl.uniform1i(uMode, mode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!reduceMotion.matches || Math.abs(darkTarget - darkCur) > 0.005) {
      raf = requestAnimationFrame(render);
    }
  };

  const kick = () => { if (!raf) raf = requestAnimationFrame(render); };

  const ro = new ResizeObserver(() => { resize(); kick(); });
  ro.observe(canvas);

  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) kick();
  }, { threshold: 0.01 });
  io.observe(canvas);

  addEventListener("pointermove", (e) => {
    mx = e.clientX / Math.max(innerWidth, 1);
    my = e.clientY / Math.max(innerHeight, 1);
  }, { passive: true });

  document.addEventListener("themechange", () => {
    darkTarget = document.documentElement.dataset.theme === "dark" ? 1 : 0;
    kick();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && visible) kick();
  });

  kick();
  return { destroy() { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); } };
}
