// Restrained, slow-motion Pastel Supernova & Atmospheric Wash WebGL2 engine.
// Designed to sit silently behind 1838 monochrome natural-science engravings
// (multiply in Light mode, screen in Dark mode) without fighting text contrast.

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
uniform float uDark;
uniform int uMode;       // 0 = orbital supernova, 1 = sunlit coastal horizon, 2 = botanical corona
uniform vec2 uFocus;     // normalized focal anchor in UV space
uniform float uStrength; // overall glow intensity
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
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = rot * p * 2.01 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec2 focus = (uFocus - 0.5) * vec2(aspect, 1.0);
  vec2 m = (uMouse - 0.5) * vec2(aspect, 1.0);

  // Ultra-slow meditative motion
  float t = uTime * 0.055;
  vec2 center = focus + m * 0.032;

  // Base canvas tones aligned to CSS tokens (#FAF9F5 light, #181817 dark)
  vec3 lightCanvas = vec3(0.980, 0.976, 0.961);
  vec3 darkCanvas  = vec3(0.094, 0.094, 0.090);
  vec3 base = mix(lightCanvas, darkCanvas, uDark);

  // Restrained pastel palette — luminous apricot, warm clay, mineral mist, pale lavender
  vec3 pApricot  = mix(vec3(0.965, 0.820, 0.725), vec3(0.455, 0.255, 0.175), uDark);
  vec3 pRoseClay = mix(vec3(0.935, 0.775, 0.745), vec3(0.390, 0.220, 0.235), uDark);
  vec3 pSkyMist  = mix(vec3(0.800, 0.875, 0.920), vec3(0.185, 0.275, 0.345), uDark);
  vec3 pLavender = mix(vec3(0.865, 0.835, 0.915), vec3(0.255, 0.220, 0.340), uDark);
  vec3 pGold     = mix(vec3(0.980, 0.905, 0.775), vec3(0.540, 0.365, 0.215), uDark);

  // Smooth, wide organic flow without crisp rings or grid artifacts
  vec2 q = vec2(
    fbm(p * 1.05 + vec2(t * 0.40, -t * 0.28)),
    fbm(p * 1.05 + vec2(-t * 0.25, t * 0.34) + 3.7)
  );
  float n1 = fbm(p * 1.25 + q * 0.95 + vec2(t * 0.14, 0.0));
  float n2 = fbm(p * 1.85 - q * 0.75 + vec2(0.0, -t * 0.11));

  vec2 d = p - center;
  float r = length(d);
  float breathe = 1.0 + 0.06 * sin(t * 2.1);

  vec3 col = base;

  if (uMode == 0) {
    // Mode 0: Orbital Supernova — soft glowing bloom anchored behind right-side plate
    float bloom = exp(-(r * r) / (0.34 * breathe));
    float halo  = exp(-r * 1.55) * (0.60 + 0.45 * n1);
    float veil  = smoothstep(0.28, 0.78, n2) * exp(-r * 1.15);

    vec3 tint = mix(pSkyMist, pLavender, smoothstep(0.25, 0.75, n1));
    tint = mix(tint, pRoseClay, smoothstep(0.32, 0.76, halo));
    tint = mix(tint, pApricot, bloom * 0.78);
    tint = mix(tint, pGold, exp(-(r * r) * 6.5) * 0.65);

    // Keep left reading plane calm and open
    float leftCalm = smoothstep(-0.62 * aspect, 0.18 * aspect, p.x);
    float mask = clamp(bloom * 0.72 + halo * 0.45 + veil * 0.28, 0.0, 1.0);
    mask *= mix(0.22, 1.0, leftCalm);

    col = mix(base, tint, mask * uStrength * mix(0.72, 0.64, uDark));
  } else if (uMode == 1) {
    // Mode 1: Sunlit Coastal Horizon — warm luminous band rising behind bottom coastline
    float horizonY = smoothstep(0.55, -0.45, p.y + (n1 - 0.5) * 0.16);
    float sunGlow  = exp(-pow((p.x - center.x) * 1.15, 2.0) - pow((p.y + 0.24) * 2.2, 2.0));
    float mist     = smoothstep(0.30, 0.80, n2) * horizonY;

    vec3 tint = mix(pSkyMist, pRoseClay, smoothstep(0.25, 0.75, horizonY));
    tint = mix(tint, pApricot, sunGlow * 0.72 + mist * 0.35);
    tint = mix(tint, pGold, exp(-r * r * 3.8) * 0.45);

    float mask = clamp(horizonY * 0.52 + sunGlow * 0.62 + mist * 0.22, 0.0, 1.0);
    // Keep upper sky calm for centered hero typography
    float skyCalm = smoothstep(0.36, -0.26, p.y);
    mask *= mix(0.18, 1.0, skyCalm);

    col = mix(base, tint, mask * uStrength * mix(0.74, 0.62, uDark));
  } else {
    // Mode 2: Botanical Corona — delicate side-edge pastel aura behind leaf venation
    float bloom = exp(-(r * r) / (0.38 * breathe));
    float drift = smoothstep(0.30, 0.80, n1) * exp(-r * 1.25);

    vec3 tint = mix(pLavender, pSkyMist, smoothstep(-0.35, 0.45, d.y));
    tint = mix(tint, pRoseClay, bloom * 0.70);
    tint = mix(tint, pApricot, exp(-(r * r) * 4.5) * 0.72);

    float rightEdge = smoothstep(-0.45 * aspect, 0.38 * aspect, p.x);
    float mask = clamp(bloom * 0.75 + drift * 0.45, 0.0, 1.0) * mix(0.12, 1.0, rightEdge);

    col = mix(base, tint, mask * uStrength * mix(0.72, 0.68, uDark));
  }

  // Subtle dither to prevent gradient banding
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
  const uFocus = gl.getUniformLocation(prog, "uFocus");
  const uStrength = gl.getUniformLocation(prog, "uStrength");

  const modeMap = { supernova: 0, wash: 1, corona: 2 };
  const mode = modeMap[opts.mode || "supernova"] ?? 0;
  const focus = opts.focus || (mode === 1 ? [0.54, 0.25] : [0.76, 0.52]);
  const strength = opts.strength ?? 0.85;

  let mx = 0.5, my = 0.5, tx = 0.5, ty = 0.5;
  let darkTarget = document.documentElement.dataset.theme === "dark" ? 1 : 0;
  let darkCur = darkTarget;
  let visible = true;
  let raf = 0;
  const start = performance.now();

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
    tx += (mx - tx) * 0.035;
    ty += (my - ty) * 0.035;
    darkCur += (darkTarget - darkCur) * 0.12;

    gl.useProgram(prog);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, reduceMotion.matches ? 18.0 : (now - start) * 0.001);
    gl.uniform2f(uMouse, tx, 1.0 - ty);
    gl.uniform1f(uDark, darkCur);
    gl.uniform1i(uMode, mode);
    gl.uniform2f(uFocus, focus[0], focus[1]);
    gl.uniform1f(uStrength, strength);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!reduceMotion.matches || Math.abs(darkTarget - darkCur) > 0.004) {
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
