// The bundled effects. Each names the palette colours it reads (exposed to
// GLSL as c_<name>), so the same shader serves both themes.
import { PAPER, PARTICLES, RAYS, PLATE, HATCH, BAYER, FRAME, BOKEH } from "./chunks.js?v=14";
import { NOISE } from "./noise.js?v=14";
import { GRADIENT } from "./gradient.js?v=14";

export const FX = {
  // ---------------------------------------------------------------- Library examples
  gradient: {
    name: "Oklab mesh",
    note: "Drifting colour points blended in Oklab, warped by simplex noise, with film grain.",
    colors: ["bg", "sea", "accent", "hi"],
    dpr: 0.75,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.08;
  p += 0.08 * vec2(sfbm(p * 1.5 + t, 3), sfbm(p * 1.5 - t + 4.0, 3));
  vec4 acc = vec4(0.0);
  meshAdd(acc, p, vec2(aspect * (0.2 + 0.1 * sin(t * 1.3)), 0.8), c_bg, 2.2);
  meshAdd(acc, p, vec2(aspect * (0.75 + 0.1 * cos(t)), 0.75 + 0.1 * sin(t * 0.7)), c_sea, 2.2);
  meshAdd(acc, p, vec2(aspect * (0.6 + 0.15 * sin(t * 0.9)), 0.2), c_accent, 2.2);
  meshAdd(acc, p, vec2(aspect * (0.9 + 0.05 * sin(t * 1.7)), 0.1 + 0.1 * cos(t)), c_hi, 2.2);
  meshAdd(acc, p, vec2(aspect * 0.1, 0.1), c_bg, 2.2);
  vec3 col = meshColor(acc);
  col += (hash(frag + fract(u_time) * 91.0) - 0.5) * 0.04;
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  noisefield: {
    name: "Noise strata",
    note: "Ridged simplex through an Oklab ramp, cut into terraces, with Worley cells for texture.",
    colors: ["abyss", "sea", "ochre", "accent", "hi"],
    dpr: 1,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float t = u_time * 0.03;
  float h = ridged(p * 1.6 + vec2(t, 0.0), 5);
  h = mix(h, warp(p * 2.0, t, 2.0), 0.35);
  float steps = 9.0;
  float terr = floor(h * steps) / steps;
  float edge = 1.0 - smoothstep(0.0, fwidth(h * steps) * 1.5, fract(h * steps));
  vec3 col = ramp5(c_abyss, c_sea, c_ochre, c_accent, c_hi, smoothstep(0.15, 0.85, terr));
  vec2 w = worley(p * 14.0, u_time * 0.2);
  col *= 0.92 + 0.08 * smoothstep(0.0, 0.15, w.y - w.x);
  col = mixOk(col, c_abyss, edge * 0.35);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  // ---------------------------------------------------------------- Plates (single-subject, lit)
  sea: {
    name: "Evening sea",
    note: "A ray-marched ocean at dusk: ridged swell, Fresnel sky reflections and a sun glitter path.",
    colors: ["abyss", "sea", "accent", "hi", "ochre"],
    dpr: 0.75,
    frag: `
float seaH(vec2 p, float t) {
  float h = 0.0, a = 0.55;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  vec2 q = p * 0.22;
  for (int i = 0; i < 5; i++) {
    vec2 w = q + 0.7 * vec2(noise(q + t * 0.25), noise(q.yx - t * 0.25));
    float s = sin(w.x + t * (0.8 + 0.15 * float(i))) * cos(w.y * 0.6 - t * 0.45);
    h += a * pow(1.0 - abs(s), 1.6);
    q = m * q; a *= 0.42;
  }
  return (h - 0.55) * 0.75;
}
vec3 sky(vec3 rd, vec3 sun) {
  float y = max(rd.y, 0.0);
  vec3 c = mix(mix(c_hi, c_accent, 0.55), c_abyss, pow(y, 0.4));
  c = mix(c, c_ochre, exp(-y * 30.0) * 0.25);
  float s = max(dot(rd, sun), 0.0);
  // A warm disc with a soft corona; kept under 1.0 so it never clips to grey.
  vec3 disc = mix(c_hi, vec3(1.0, 0.94, 0.86), 0.6);
  c = mix(c, c_accent, pow(s, 12.0) * 0.4);
  c = mix(c, mix(c_hi, disc, 0.5), pow(s, 180.0) * 0.8);
  return mix(c, disc, smoothstep(0.99955, 0.99975, s));
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (frag - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.6;
  vec3 ro = vec3(0.0, 2.4, t * 1.5);
  vec3 rd = normalize(vec3(uv.x, uv.y - 0.14, 1.5));
  vec3 sun = normalize(vec3(-0.3, 0.07, 1.0));
  vec3 col = sky(rd, sun);
  if (rd.y < 0.0) {
    float d = (ro.y - 0.6) / -rd.y;
    vec3 p;
    for (int i = 0; i < 56; i++) {
      p = ro + rd * d;
      float h = p.y - seaH(p.xz, t);
      if (h < 0.002 * d || d > 250.0) break;
      d += h * 0.75;
    }
    p = ro + rd * d;
    float e = 0.02 + 0.0015 * d;
    vec3 n = normalize(vec3(seaH(p.xz - vec2(e, 0.0), t) - seaH(p.xz + vec2(e, 0.0), t), 2.0 * e,
                            seaH(p.xz - vec2(0.0, e), t) - seaH(p.xz + vec2(0.0, e), t)));
    float fres = pow(clamp(1.0 - dot(n, -rd), 0.0, 1.0), 3.0) * 0.7;
    vec3 body = c_abyss * 0.85 + c_sea * (0.2 + 0.35 * clamp(seaH(p.xz, t) + 0.25, 0.0, 1.0));
    vec3 sc = mix(body, sky(reflect(rd, n), sun), fres);
    sc += c_hi * pow(max(dot(reflect(rd, n), sun), 0.0), 140.0) * 1.6;
    col = mix(sc, sky(vec3(rd.x, 0.0, rd.z), sun), 1.0 - exp(-d * 0.014));
  }
  col *= 1.0 - 0.25 * dot(uv, uv);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  abyss: {
    name: "Abyss",
    note: "Depth haze, light from the surface and out-of-focus plankton. Sparks gather at the cursor.",
    colors: ["abyss", "sea", "hi", "accent"],
    dpr: 1,
    frag: RAYS + PARTICLES + BOKEH + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  float aspect = u_res.x / u_res.y;
  float t = u_time;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec3 col = mix(c_abyss * 0.7, c_abyss, uv.y);
  float r = rays(uv, aspect, t, 0.25);
  col += c_sea * r * 0.4 * (0.3 + 0.7 * uv.y);
  col += c_sea * 0.18 * fbm(p * 1.4 + vec2(t * 0.02, 0.0)) * uv.y;
  col += c_hi * bokeh(frag, 140.0, t, 0.0) * 0.1;
  col += c_accent * bokeh(frag, 190.0, t * 0.8, 7.7) * 0.08;
  vec2 m = u_mouse / u_res;
  float near = exp(-dot((uv - m) * vec2(aspect, 1.0), (uv - m) * vec2(aspect, 1.0)) * 18.0);
  col += c_hi * motes(frag, 18.0, 0.03, t, 0.1 + 0.5 * near) * (0.35 + 0.9 * near);
  col += mix(c_sea, c_hi, 0.5) * motes(frag + 300.0, 40.0, 0.06, t, 0.2) * 0.3;
  col *= 1.0 - 0.35 * pow(length(uv - 0.5) * 1.3, 2.0);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  ink: {
    name: "Ink in water",
    note: "A lit plume of orange ink curling up through still water. The cursor stirs it.",
    colors: ["paper", "sepia", "accent", "hi"],
    dpr: 1,
    frag: PAPER + `
float dens(vec2 p, float t, float aspect) {
  vec2 q = p - vec2(0.0, t * 0.04);
  float w1 = fbm(q * 2.2 + vec2(0.0, t * 0.05));
  float w2 = fbm(q * 2.2 + vec2(5.2, 1.3) - t * 0.04);
  float d = fbm(q * 2.0 + 2.2 * vec2(w1, w2));
  float cx = 0.66 * aspect + 0.12 * sin(p.y * 2.5 - t * 0.15) + 0.05 * sin(p.y * 6.0 + t * 0.2);
  float width = 0.06 + 0.55 * pow(max(p.y, 0.0), 1.2);
  float env = exp(-pow((p.x - cx) / width, 2.0)) * smoothstep(-0.05, 0.3, p.y);
  return smoothstep(0.34, 0.74, d * (0.3 + 1.05 * env));
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = u_res.x / u_res.y;
  vec2 p = frag / u_res.y;
  float t = u_time;
  vec2 m = u_mouse / u_res.y;
  vec2 dm = p - m;
  float s = 1.2 * exp(-dot(dm, dm) * 25.0);
  p = m + mat2(cos(s), -sin(s), sin(s), cos(s)) * dm;
  float d = dens(p, t, aspect);
  float dl = dens(p + vec2(-0.012, 0.014), t, aspect);
  float lit = clamp((d - dl) * 3.0 + 0.5, 0.0, 1.0);
  vec3 inkc = mix(c_accent, c_sepia, smoothstep(0.55, 1.0, d) * 0.55);
  inkc = mix(inkc, c_hi, (1.0 - lit) * 0.45);
  vec3 col = paperTone(c_paper, c_sepia, frag);
  col = mix(col, c_sepia, smoothstep(0.0, 0.5, dl) * (1.0 - d) * 0.06);
  col = mix(col, inkc, d * 0.92);
  float fil = pow(1.0 - abs(fbm(p * 7.0 + vec2(0.0, -t * 0.05)) * 2.0 - 1.0), 10.0);
  col = mix(col, c_accent, fil * smoothstep(0.02, 0.3, d) * 0.35);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  nautilus: {
    name: "Nautilus",
    note: "A sectioned nautilus on a book plate: engraved whorls, chamber septa and the shell's tiger stripes.",
    colors: ["paper", "sepia", "accent", "ochre"],
    dpr: 2,
    frag: PAPER + HATCH + FRAME + `
const float TAU = 6.2831853;
const float B = 0.1752; // ln 3 / 2pi: the shell triples its radius each turn
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec3 col = paperTone(c_paper, c_sepia, frag);
  vec2 uv = (frag - u_res * vec2(0.7, 0.5)) / u_res.y;
  float ang0 = 0.6 + 0.05 * sin(u_time * 0.15);
  uv = mat2(cos(ang0), -sin(ang0), sin(ang0), cos(ang0)) * uv;
  float r = length(uv), th = atan(uv.y, uv.x);
  float s = log(max(r, 1e-5) / 0.34) / (B * TAU) - th / TAU;
  float n = floor(s), f = fract(s);
  float shell = step(s, 0.0) * step(-5.0, s);
  float Th = th + TAU * (n + 1.0);          // angle unwrapped along the spiral

  // Tube shading: light from the upper left across each whorl.
  float lightAcross = sin(f * 3.14159) * 0.7 + 0.3 * cos(th - 2.3) * (f - 0.5) * 2.0;
  float tone = clamp(1.0 - (0.25 + 0.75 * lightAcross), 0.0, 1.0);
  float outer = step(-1.0, n);              // the last whorl shows the outside of the shell

  // Exterior stripes on the last whorl, fading toward the lip.
  float stripe = smoothstep(0.55, 0.8, sin(Th * 11.0 + f * 5.0 + 1.5 * fbm(vec2(Th, f) * 3.0)));
  stripe *= outer * smoothstep(1.0, 0.35, f) * smoothstep(TAU * 0.9, TAU * 0.2, Th);
  // Septa inside the sectioned whorls.
  float u = Th / TAU * 9.0 + 0.9 * f;
  float septa = (1.0 - smoothstep(0.6 * u_dpr, 1.6 * u_dpr, min(fract(u), 1.0 - fract(u)) / fwidth(u))) * (1.0 - outer);
  float chamber = mod(floor(u), 2.0);

  vec3 shellCol = mix(c_paper, c_ochre, 0.18 + 0.12 * chamber * (1.0 - outer));
  shellCol = mix(shellCol, c_accent, stripe * 0.85);
  col = mix(col, shellCol, shell);
  float lines = max(hatch(s * 26.0, tone * 0.75), hatch(dot(frag, vec2(0.6, 0.8)) / (4.0 * u_dpr), (tone - 0.6) * 1.5));
  col = mix(col, c_sepia, shell * lines * 0.8);
  col = mix(col, c_sepia, shell * septa * 0.75);
  // Whorl walls and the outer edge.
  float wall = 1.0 - smoothstep(0.8 * u_dpr, 1.8 * u_dpr, min(f, 1.0 - f) / fwidth(s));
  col = mix(col, c_sepia, wall * step(s, 0.02) * step(-5.0, s) * 0.95);
  col = mix(col, c_sepia, plateFrame(frag) * 0.7);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  radiolarian: {
    name: "Radiolarian",
    note: "A Haeckel-style lattice sphere with radial spines, engraved and turning slowly.",
    colors: ["paper", "sepia", "accent", "ochre"],
    dpr: 1.5,
    frag: PAPER + HATCH + FRAME + `
vec3 hash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
vec2 cell3(vec3 p) {
  vec3 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 d = g + hash3(ip + g) - fp;
        float dd = dot(d, d);
        if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
      }
  return vec2(sqrt(f1), sqrt(f2));
}
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  float px = 1.0 / u_res.y;
  float t = u_time;
  vec2 uv = (frag - u_res * vec2(0.7, 0.5)) / u_res.y;
  float R = 0.27;
  float r = length(uv);
  vec3 col = paperTone(c_paper, c_sepia, frag);

  // Spines.
  float N = 40.0;
  float ang = atan(uv.y, uv.x);
  float k = floor(ang / (6.2831853 / N) + 0.5);
  float sa = k * 6.2831853 / N + 0.02 * sin(t * 0.3 + k);
  vec2 sd = vec2(cos(sa), sin(sa));
  float L = R * (1.2 + 0.25 * hash(vec2(k, 1.0))) * (mod(k, 4.0) < 0.5 ? 1.45 : 1.0);
  float along = dot(uv, sd), perp = abs(dot(uv, vec2(-sd.y, sd.x)));
  float w = 0.0055 * (1.0 - clamp((along - R) / (L - R), 0.0, 1.0)) + 0.4 * px;
  float spine = step(R * 0.95, along) * step(along, L) * (1.0 - smoothstep(w - px, w + px, perp));
  col = mix(col, c_sepia, spine * 0.85);

  if (r < R) {
    vec3 n = vec3(uv, sqrt(R * R - r * r)) / R;
    vec3 q = rotX(0.35) * rotY(t * 0.08) * n;
    vec2 c = cell3(q * 3.2);
    float edge = c.y - c.x;
    float aa = fwidth(edge);
    float bar = 1.0 - smoothstep(0.1, 0.1 + aa * 1.5, edge);
    float lit = clamp(dot(n, normalize(vec3(-0.5, 0.6, 0.65))), 0.0, 1.0);
    // Through the holes: a darker inner shell.
    vec3 inner = mix(c_accent, c_sepia, 0.35 + 0.4 * (1.0 - lit));
    vec2 ci = cell3(rotY(-t * 0.05) * n * 6.0);
    inner = mix(inner, c_ochre, (1.0 - smoothstep(0.05, 0.05 + fwidth(ci.y - ci.x) * 1.5, ci.y - ci.x)) * 0.8);
    col = mix(col, inner, (1.0 - bar) * 0.8);
    vec3 barCol = mix(c_paper, c_ochre, 0.15);
    barCol = mix(barCol, c_sepia, hatch(dot(frag, vec2(0.8, 0.6)) / (3.5 * u_dpr), (1.0 - lit) * 0.8) * 0.85);
    col = mix(col, barCol, bar);
    float rim = 1.0 - smoothstep(0.1, 0.1 + aa, abs(edge - 0.1) );
    col = mix(col, c_sepia, rim * 0.5);
  }
  col = mix(col, c_sepia, (1.0 - smoothstep(0.6 * px * u_dpr, 1.8 * px * u_dpr, abs(r - R))) * 0.9);
  col = mix(col, c_sepia, plateFrame(frag) * 0.7);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  medusa: {
    name: "Medusa",
    note: "A bioluminescent jellyfish pulsing in the dark, trailing tentacles and frilled arms.",
    colors: ["abyss", "sea", "accent", "hi"],
    dpr: 1,
    frag: PARTICLES + RAYS + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  float aspect = u_res.x / u_res.y;
  float t = u_time;
  float px = 1.0 / u_res.y;
  vec3 col = mix(c_abyss * 0.7, c_abyss, uv.y);
  col += c_sea * rays(uv, aspect, t, 0.1) * 0.18;

  float pulse = 0.5 + 0.5 * sin(t * 1.3);
  vec2 q = (frag - u_res * vec2(0.72, 0.64)) / u_res.y;
  q -= vec2(0.02 * sin(t * 0.3), 0.025 * sin(t * 1.3 - 0.8));
  float w = 0.19 * (1.0 + 0.08 * pulse), h = 0.15 * (1.0 - 0.1 * pulse);
  float rimY = -0.015 + 0.008 * cos(q.x / w * 14.0 + t);
  float d = length(q / vec2(w, h)) - 1.0;
  float inside = (1.0 - smoothstep(-0.02, 0.02, d)) * smoothstep(rimY - px, rimY + px, q.y);
  float edge = smoothstep(-0.35, 0.0, d) * inside;
  float ribs = pow(abs(cos(atan(q.x, q.y + 0.06) * 8.0)), 24.0) * inside;
  vec3 glow = c_sea * 0.35 * inside + c_hi * (edge * 0.55 + ribs * 0.25);
  float gon = abs(length(q - vec2(0.0, 0.03)) - 0.045);
  float gonads = (1.0 - smoothstep(0.006, 0.012, gon)) * step(0.35, abs(sin(atan(q.y - 0.03, q.x) * 2.0))) * inside;
  glow += c_accent * gonads * 0.7;

  // Tentacles and oral arms hanging from the margin.
  float tent = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float x0 = (fi / 11.0 - 0.5) * 2.0 * w * 0.95;
    float dy = rimY - q.y;
    float x = x0 * (1.0 + 0.3 * dy) + 0.025 * sin(dy * 16.0 - t * 2.0 + fi) * dy * 3.0;
    float len = 0.35 + 0.2 * hash(vec2(fi, 2.0));
    float l = exp(-abs(q.x - x) / (0.0018 + 0.001 * hash(vec2(fi, 5.0)))) * step(0.0, dy) * smoothstep(len, 0.0, dy);
    tent += l;
  }
  glow += c_hi * tent * 0.35;
  float arms = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float dy = rimY - q.y;
    float x = (fi - 1.5) * 0.012 + 0.03 * sin(dy * 9.0 - t * 1.2 + fi * 1.7) * dy * 2.0;
    float wid = 0.008 * (1.0 + 0.6 * sin(dy * 70.0 + t * 3.0 + fi)) * smoothstep(0.3, 0.0, dy);
    arms += (1.0 - smoothstep(wid - px, wid + px, abs(q.x - x))) * step(0.0, dy);
  }
  glow += c_accent * clamp(arms, 0.0, 1.0) * 0.55;
  glow += c_hi * exp(-length(q) / 0.12) * 0.12 * (0.7 + 0.3 * pulse);
  col += glow;
  col += c_hi * motes(frag, 26.0, 0.04, t, 0.12) * 0.4;
  col *= 1.0 - 0.3 * pow(length(uv - 0.5) * 1.3, 2.0);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  relief: {
    name: "Relief map",
    note: "A hill-shaded survey sheet: hypsometric tints, contours, an orange coast and waterlined shallows.",
    colors: ["paper", "sepia", "sea", "kelp", "ochre", "accent"],
    dpr: 1.5,
    frag: PAPER + HATCH + FRAME + `
float terrain(vec2 p) {
  float h = 0.0, a = 0.5;
  mat2 m = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 6; i++) {
    float n = noise(p);
    float ridge = 1.0 - abs(n * 2.0 - 1.0);
    h += a * mix(n, ridge * ridge, smoothstep(0.0, 2.0, float(i)));
    p = m * p * 2.03 + 7.0; a *= 0.5;
  }
  return h;
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  vec2 p = uv * 1.5 + vec2(u_time * 0.006, 0.0);
  vec2 m = u_mouse / u_res.y;
  float h = terrain(p) + 0.06 * exp(-dot(uv - m, uv - m) * 40.0);
  float e = 1.5 * 1.5 / u_res.y;
  float hx = terrain(p + vec2(e, 0.0)) - terrain(p - vec2(e, 0.0));
  float hy = terrain(p + vec2(0.0, e)) - terrain(p - vec2(0.0, e));
  vec3 n = normalize(vec3(-hx, -hy, 2.0 * e * 0.3));
  float hill = dot(n, normalize(vec3(-1.0, 1.0, 1.1)));
  float SL = 0.5;
  vec3 col = paperTone(c_paper, c_sepia, frag);
  if (h > SL) {
    float k = (h - SL) / 0.35;
    vec3 tint = mix(c_kelp, c_ochre, smoothstep(0.0, 0.55, k));
    tint = mix(tint, c_paper, smoothstep(0.55, 1.0, k));
    col = mix(col, tint, 0.55);
    col *= 0.72 + 0.4 * hill;
    float lv = h * 40.0;
    float c = 1.0 - smoothstep(0.4 * u_dpr, 1.1 * u_dpr, abs(fract(lv - 0.5) - 0.5) / fwidth(lv));
    bool idx = mod(floor(lv + 0.5), 4.0) < 0.5;
    col = mix(col, c_sepia, c * (idx ? 0.5 : 0.22));
  } else {
    float depth = SL - h;
    col = mix(col, c_sea, 0.12 + smoothstep(0.0, 0.2, depth) * 0.35);
    col = mix(col, c_sea, hatch(depth * 90.0, 0.12) * exp(-depth * 22.0) * 0.7);
  }
  float dc = abs(h - SL) / fwidth(h);
  col = mix(col, c_accent, 1.0 - smoothstep(0.8 * u_dpr, 1.8 * u_dpr, dc));
  vec2 g = abs(fract(uv * 4.0) - 0.5) / fwidth(uv * 4.0);
  col = mix(col, c_sepia, (1.0 - smoothstep(0.3 * u_dpr, 0.9 * u_dpr, min(g.x, g.y))) * 0.12);
  col = mix(col, c_sepia, plateFrame(frag) * 0.7);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  sunflower: {
    name: "Golden angle",
    note: "A sunflower head laid out by the golden angle: lit seeds, ray florets, engraved.",
    colors: ["paper", "sepia", "accent", "ochre", "kelp"],
    dpr: 1.5,
    frag: PAPER + HATCH + FRAME + `
const float GA = 2.39996323;
const float OFF[19] = float[19](0.0, 1.0, -1.0, 2.0, -2.0, 8.0, -8.0, 13.0, -13.0, 21.0, -21.0, 34.0, -34.0, 55.0, -55.0, 89.0, -89.0, 144.0, -144.0);
void main() {
  vec2 frag = gl_FragCoord.xy;
  float px = 1.0 / u_res.y;
  float t = u_time;
  vec2 p = (frag - u_res * vec2(0.7, 0.5)) / u_res.y;
  float rot = t * 0.02;
  p = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * p;
  vec2 m = (u_mouse - u_res * vec2(0.7, 0.5)) / u_res.y;
  m = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * m;
  float bulge = exp(-dot(p - m, p - m) * 120.0);
  float c = 0.0095 * (1.0 + 0.012 * sin(t * 0.6));
  float Rd = 0.25;
  float r = length(p);
  vec3 col = paperTone(c_paper, c_sepia, frag);

  // Ray florets: two staggered rings of petals.
  float ang = atan(p.y, p.x);
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    float NP = 34.0;
    float k = floor((ang + fl * 3.14159 / NP) / (6.2831853 / NP) + 0.5);
    float pa = k * 6.2831853 / NP - fl * 3.14159 / NP + 0.03 * sin(t * 0.4 + k);
    float L = 0.13 + 0.03 * hash(vec2(k, fl)) - fl * 0.02;
    vec2 dir = vec2(cos(pa), sin(pa));
    float along = dot(p, dir) - Rd * 0.96;
    float perp = abs(dot(p, vec2(-dir.y, dir.x)));
    float wid = 0.024 * sin(3.14159 * clamp(along / L, 0.0, 1.0));
    float petal = step(0.0, along) * step(along, L) * (1.0 - smoothstep(wid - px, wid + px, perp));
    float edgeP = petal * (1.0 - smoothstep(0.0, 1.5 * px * u_dpr, wid - perp));
    vec3 pc = mix(c_accent, c_ochre, fl * 0.5 + 0.3 * along / L);
    col = mix(col, pc, petal * (0.85 - fl * 0.2));
    col = mix(col, c_sepia, petal * hatch(perp / (0.006), 0.15) * 0.3);
    col = mix(col, c_sepia, edgeP * 0.8);
  }

  if (r < Rd) {
    float nA = (r / c) * (r / c);
    float best = 1e9; vec2 bp = vec2(0.0); float bi = 0.0;
    for (int k = 0; k < 19; k++) {
      float i = round(nA) + OFF[k];
      if (i < 0.0) continue;
      float a = i * GA;
      vec2 sp = c * sqrt(i) * vec2(cos(a), sin(a));
      float d = length(p - sp);
      if (d < best) { best = d; bp = sp; bi = i; }
    }
    float sr = c * 0.5 * (1.0 + 0.4 * bulge);
    float inSeed = 1.0 - smoothstep(sr - px, sr + px, best);
    vec2 sn = (p - bp) / sr;
    float z = sqrt(max(1.0 - dot(sn, sn), 0.0));
    float lit = clamp(dot(vec3(sn, z), normalize(vec3(-0.5, 0.6, 0.7))), 0.0, 1.0);
    float k01 = sqrt(bi) / (Rd / c);
    vec3 seed = mix(c_sepia, c_ochre, smoothstep(0.1, 0.9, k01));
    seed = mix(seed, c_kelp, smoothstep(0.85, 1.0, k01) * 0.5);
    seed = mix(seed, c_accent, (1.0 - smoothstep(0.0, 0.25, k01)) * 0.6);
    seed *= 0.55 + 0.6 * lit;
    col = mix(col, mix(c_sepia, c_ochre, 0.3) * 0.6, 0.85);
    col = mix(col, seed, inSeed);
    col = mix(col, c_sepia, inSeed * (1.0 - smoothstep(0.0, 1.2 * px * u_dpr, sr - best)) * 0.6);
  }
  col = mix(col, c_sepia, plateFrame(frag) * 0.7);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  currents: {
    name: "Currents",
    note: "Animated flow lines tracing gyres and eddies, like a tidal-current chart.",
    colors: ["paper", "sepia", "sea", "accent"],
    dpr: 1,
    frag: PAPER + FRAME + `
vec2 flow(vec2 p, float t, float aspect) {
  vec2 v = vec2(0.25, 0.02);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 c = vec2((0.2 + 0.6 * hash(vec2(fi, 1.0))) * aspect, 0.2 + 0.6 * hash(vec2(fi, 2.0)));
    c += 0.05 * vec2(sin(t * 0.05 + fi), cos(t * 0.04 + fi));
    vec2 d = p - c;
    v += vec2(-d.y, d.x) * exp(-dot(d, d) * 7.0) * (mod(fi, 2.0) < 0.5 ? 2.2 : -2.2);
  }
  float e = 0.02;
  vec2 q = p * 2.2 + t * 0.01;
  v += 0.12 * vec2(noise(q + vec2(0.0, e)) - noise(q - vec2(0.0, e)), noise(q - vec2(e, 0.0)) - noise(q + vec2(e, 0.0))) / (2.0 * e);
  return v;
}
float tex(vec2 q) { return hash(floor(q * u_res.y / (1.6 * u_dpr))); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = u_res.x / u_res.y;
  float t = u_time;
  vec2 p = frag / u_res.y;
  float stepL = 1.6 * u_dpr / u_res.y;
  float acc = 0.0, wsum = 0.0;
  float ph = hash(floor(p * u_res.y / (1.6 * u_dpr))) * 6.2831;
  vec2 q = p;
  for (int i = 0; i < 18; i++) {
    float fi = float(i);
    float w = 0.5 + 0.5 * sin(fi * 0.35 - t * 2.0 + ph);
    acc += tex(q) * w; wsum += w;
    q += normalize(flow(q, t, aspect) + 1e-5) * stepL;
  }
  q = p;
  for (int i = 1; i < 18; i++) {
    float fi = float(i);
    q -= normalize(flow(q, t, aspect) + 1e-5) * stepL;
    float w = 0.5 + 0.5 * sin(-fi * 0.35 - t * 2.0 + ph);
    acc += tex(q) * w; wsum += w;
  }
  float v = clamp((acc / wsum - 0.5) * 4.0 + 0.5, 0.0, 1.0);
  float speed = length(flow(p, t, aspect));
  vec3 ink = mix(c_sea, c_accent, smoothstep(0.6, 1.6, speed));
  vec3 col = paperTone(c_paper, c_sepia, frag);
  col = mix(col, ink, smoothstep(0.45, 0.8, v) * (0.5 + 0.45 * smoothstep(0.2, 1.2, speed)));
  col = mix(col, c_sepia, plateFrame(frag) * 0.7);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  chart: {
    name: "Nautical chart",
    note: "Depth contours, a hand-tinted coast and a graticule on aged paper. The cursor raises a shoal.",
    colors: ["paper", "sepia", "accent", "ochre"],
    dpr: 2,
    frag: PAPER + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  float t = u_time * 0.012;
  vec2 p = uv * 1.5;
  vec2 warp = vec2(fbm(p + vec2(t, 0.0)), fbm(p + vec2(5.2, 1.3) - t));
  float h = fbm(p + 1.3 * warp + vec2(0.0, t * 0.5));
  vec2 m = u_mouse / u_res.y;
  h += 0.09 * exp(-dot(uv - m, uv - m) * 28.0);

  vec3 col = paperTone(c_paper, c_sepia, frag);

  // Land above sea level gets an ochre wash and a stipple.
  float sea = 0.57;
  float land = smoothstep(sea - 0.002, sea + 0.002, h);
  col = mix(col, mix(col, c_ochre, 0.32), land);
  col = mix(col, c_sepia, land * step(0.93, hash(floor(frag / (2.0 * u_dpr)))) * 0.35);

  // Depth contours under water; every fifth is heavier.
  float lv = h * 22.0;
  float fw = fwidth(lv);
  float d = abs(fract(lv - 0.5) - 0.5) / fw;
  bool major = mod(floor(lv + 0.5), 5.0) < 0.5;
  float wid = (major ? 1.1 : 0.55) * u_dpr;
  float line = (1.0 - smoothstep(wid - 0.6, wid + 0.6, d)) * (1.0 - land);
  col = mix(col, c_sepia, line * (major ? 0.85 : 0.55));

  // Coastline in the accent ink, drawn a little heavier.
  float dc = abs(h - sea) / fwidth(h);
  col = mix(col, c_accent, 1.0 - smoothstep(1.0 * u_dpr, 2.0 * u_dpr, dc));

  // Graticule.
  vec2 g = abs(fract(uv * 3.0) - 0.5) / fwidth(uv * 3.0);
  float grid = 1.0 - smoothstep(0.4 * u_dpr, 1.0 * u_dpr, min(g.x, g.y));
  col = mix(col, c_sepia, grid * 0.14);

  // Foxing toward the edges.
  vec2 e = gl_FragCoord.xy / u_res - 0.5;
  col = mix(col, c_ochre, smoothstep(0.35, 0.75, length(e)) * 0.18 * fbm(uv * 3.0));
  o = vec4(col, 1.0);
}`,
  },

  coral: {
    name: "Coral plate",
    note: "A live reaction-diffusion simulation growing coral on paper. Move the cursor to seed it.",
    colors: ["paper", "sepia", "accent", "hi"],
    dpr: 1.5,
    sim: {
      scale: 2.5,
      steps: 10,
      // Mostly substance A, with scattered seeds of B so growth starts everywhere.
      seed(w, h) {
        const d = new Float32Array(w * h * 2);
        for (let i = 0; i < w * h; i++) d[i * 2] = 1;
        const spots = Math.max(12, Math.round((w * h) / 1800));
        for (let s = 0; s < spots; s++) {
          const cx = Math.random() * w, cy = Math.random() * h, r = 2 + Math.random() * 3;
          for (let y = Math.floor(cy - r); y <= cy + r; y++)
            for (let x = Math.floor(cx - r); x <= cx + r; x++) {
              if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
              const i = (((y + h) % h) * w + ((x + w) % w)) * 2;
              d[i] = 0.5; d[i + 1] = 1;
            }
        }
        return d;
      },
      // Gray-Scott, Karl Sims' discretisation, with feed varying gently across
      // the plate so branches and blobs both appear.
      frag: `
uniform sampler2D u_state;
vec2 at(vec2 uv, vec2 px, float x, float y) { return texture(u_state, uv + px * vec2(x, y)).rg; }
void main() {
  vec2 px = 1.0 / u_res;
  vec2 uv = gl_FragCoord.xy * px;
  vec2 s = at(uv, px, 0.0, 0.0);
  vec2 lap = -s
    + 0.2 * (at(uv, px, 1.0, 0.0) + at(uv, px, -1.0, 0.0) + at(uv, px, 0.0, 1.0) + at(uv, px, 0.0, -1.0))
    + 0.05 * (at(uv, px, 1.0, 1.0) + at(uv, px, -1.0, 1.0) + at(uv, px, 1.0, -1.0) + at(uv, px, -1.0, -1.0));
  float a = s.r, b = s.g, abb = a * b * b;
  float F = 0.0545 + 0.006 * (noise(uv * 3.0) - 0.5);
  float K = 0.062;
  a += 1.0 * lap.r - abb + F * (1.0 - a);
  b += 0.5 * lap.g + abb - (K + F) * b;
  if (length(gl_FragCoord.xy - u_mouse) < 4.0) b = 0.9;
  o = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), 0.0, 1.0);
}`,
    },
    frag: PAPER + `
uniform sampler2D u_state;
uniform vec2 u_simres;
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  vec2 px = 1.0 / u_simres;
  float b = texture(u_state, uv).g;
  float bx = texture(u_state, uv + vec2(px.x, 0)).g - texture(u_state, uv - vec2(px.x, 0)).g;
  float by = texture(u_state, uv + vec2(0, px.y)).g - texture(u_state, uv - vec2(0, px.y)).g;
  vec3 n = normalize(vec3(-bx, -by, 0.12));
  float light = dot(n, normalize(vec3(-0.5, 0.6, 0.6)));

  vec3 col = paperTone(c_paper, c_sepia, frag);
  float body = smoothstep(0.16, 0.3, b);
  vec3 coral = mix(c_accent, c_hi, smoothstep(0.3, 0.9, light));
  col = mix(col, coral, body);
  // Ink outline where the coral meets the paper, like a hand-coloured engraving.
  float edge = smoothstep(0.1, 0.2, b) - smoothstep(0.2, 0.3, b);
  col = mix(col, c_sepia, edge * 0.55);
  // Soft cast shadow on the paper side.
  col = mix(col, c_sepia, (1.0 - body) * smoothstep(0.02, 0.12, texture(u_state, uv + px * vec2(1.5, -1.5)).g) * 0.12);
  o = vec4(col, 1.0);
}`,
  },

  kelp: {
    name: "Kelp forest",
    note: "Kelp swaying in two depths under light shafts. The cursor parts it like a current.",
    colors: ["abyss", "sea", "kelp", "ochre", "accent", "hi"],
    dpr: 1.5,
    frag: RAYS + PARTICLES + `
const int N = 22;
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  float aspect = u_res.x / u_res.y;
  float t = u_time;
  float px = 1.0 / u_res.y;

  vec3 col = mix(c_abyss, mix(c_abyss, c_sea, 0.75), pow(uv.y, 1.4));
  col = mix(col, c_sea, rays(uv, aspect, t, 0.0) * 0.35);

  vec2 m = u_mouse / u_res;
  for (int i = 0; i < N; i++) {
    float fi = float(i);
    float r = hash(vec2(fi, 3.1));
    float back = step(0.5, hash(vec2(fi, 9.7)));      // two depth layers
    float base = (fi + 0.5) / float(N) + (r - 0.5) * 0.04;
    float top = 0.55 + 0.42 * hash(vec2(fi, 7.0));
    float y = uv.y;
    if (y > top + 0.02) continue;
    float k = clamp(y / top, 0.0, 1.0);
    float sway = (sin(y * 3.0 + t * (0.35 + 0.25 * r) + fi * 1.7) * 0.05
                + sin(y * 8.0 + t * 0.7 + fi) * 0.01) * k;
    // The cursor pushes nearby fronds aside.
    float dm = (base - m.x) * aspect;
    sway += 0.06 * k * sign(dm) * exp(-dm * dm * 60.0) * exp(-pow((y - m.y) * 3.0, 2.0));
    float x = base + sway;
    float dx = (uv.x - x) * aspect;

    float wid = (0.0045 + 0.003 * r) * (1.0 - 0.6 * k) * (1.0 - 0.35 * back);
    float stem = 1.0 - smoothstep(wid - px, wid + px, abs(dx));

    // Blades alternating along the stipe.
    float seg = y * 18.0 + r * 5.0;
    float side = mod(floor(seg), 2.0) * 2.0 - 1.0;
    vec2 q = vec2(dx * side - 0.016, (fract(seg) - 0.5) / 18.0);
    q = mat2(0.94, -0.34, 0.34, 0.94) * q;
    float blade = 1.0 - smoothstep(0.9, 1.0, length(q / vec2(0.018, 0.024)));
    blade *= step(0.08, k) * (1.0 - smoothstep(0.95, 1.0, k));

    float shape = max(stem, blade * 0.9);
    vec3 tint = mix(c_kelp, c_ochre, smoothstep(0.2, 0.85, k));
    tint = mix(tint, c_accent, smoothstep(0.75, 1.0, k) * 0.55);
    tint = mix(tint, c_abyss, back * 0.45);
    col = mix(col, tint, shape * (back > 0.5 ? 0.7 : 1.0));
  }

  col += c_hi * motes(frag, 22.0, -0.08, t, 0.18) * 0.5;
  o = vec4(col, 1.0);
}`,
  },

  surface: {
    name: "Under the surface",
    note: "Light shafts and caustics from the surface, with marine snow drifting down. The light follows the cursor.",
    colors: ["abyss", "sea", "hi", "accent"],
    dpr: 1.5,
    frag: RAYS + PARTICLES + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  float aspect = u_res.x / u_res.y;
  float t = u_time;

  vec3 col = mix(c_abyss, c_sea, pow(uv.y, 1.8) * 0.85);
  float lean = u_mouse.x > -1e4 ? (u_mouse.x / u_res.x - 0.5) * 0.3 : 0.0;
  col = mix(col, mix(c_sea, c_hi, 0.25), rays(uv, aspect, t, lean) * 0.55);

  // Caustic net near the surface.
  vec2 cp = vec2(uv.x * aspect, uv.y) * 5.0;
  float cn = fbm(cp + vec2(t * 0.15, -t * 0.1) + fbm(cp * 0.7 - t * 0.08));
  float caustic = pow(1.0 - abs(cn * 2.0 - 1.0), 10.0);
  col = mix(col, c_hi, caustic * smoothstep(0.55, 1.0, uv.y) * 0.4);

  // Marine snow in three depths, plus a rare warm speck.
  col += mix(c_sea, c_hi, 0.6) * motes(frag, 34.0, 0.05, t, 0.22) * 0.35;
  col += mix(c_sea, c_hi, 0.8) * motes(frag + 517.0, 22.0, 0.09, t, 0.12) * 0.55;
  col += c_hi * motes(frag + 91.0, 14.0, 0.14, t, 0.05) * 0.8;
  col += c_accent * motes(frag + 33.0, 60.0, 0.03, t, 0.05) * 0.6;

  // Depth falloff toward the bottom.
  col = mix(c_abyss, col, smoothstep(-0.25, 0.6, uv.y));
  o = vec4(col, 1.0);
}`,
  },

  // ---------------------------------------------------------------- Ocean
  swell: {
    name: "Engraved swell",
    note: "Engraved lines riding the swell, cross-hatched in the troughs. The cursor leaves foam.",
    colors: ["paper", "sepia", "accent"],
    dpr: 2,
    frag: PAPER + PLATE + HATCH + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  float t = u_time;
  float swell = sin(uv.x * 5.0 + t * 0.4 + 2.0 * fbm(uv * 1.5 + t * 0.05)) * 0.5 + 0.5;
  float tone = plate(uv * 1.8 + vec2(t * 0.02, 0.0), t * 0.02);
  tone = smoothstep(0.32, 0.72, tone * 0.65 + swell * 0.35);
  vec2 m = u_mouse / u_res.y;
  float dm = length(uv - m);
  tone *= 1.0 - 0.7 * exp(-dm * dm * 60.0);

  float period = 5.0 * u_dpr;
  float y = frag.y + 14.0 * u_dpr * sin(frag.x / (90.0 * u_dpr) + t * 0.5 + fbm(uv * 2.0) * 3.0);
  float a = hatch(y / period, tone * 0.8);
  float b = hatch(dot(frag, vec2(0.5, 0.866)) / period, (tone - 0.55) * 1.4);
  float ink = max(a, b);

  vec3 col = paperTone(c_paper, c_sepia, frag);
  col = mix(col, c_sepia, ink * 0.9);
  col = mix(col, c_accent, smoothstep(0.12, 0.0, tone) * 0.18);
  o = vec4(col, 1.0);
}`,
  },

  tidepool: {
    name: "Tide pool",
    note: "Caustics dancing over sand through shallow water. The cursor drops ripples.",
    colors: ["paper", "sea", "ochre", "hi", "sepia"],
    dpr: 1.25,
    frag: `
float caustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0, inten = 0.005;
  for (int n = 0; n < 5; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  float t = u_time * 0.5;
  vec2 m = u_mouse / u_res.y;
  vec2 dv = uv - m;
  float d = length(dv);
  float rip = sin(d * 90.0 - u_time * 5.0) * exp(-d * 9.0);
  vec2 p = uv + 0.008 * rip * dv / max(d, 1e-3);
  p += 0.012 * vec2(fbm(uv * 4.0 + t * 0.3), fbm(uv * 4.0 - t * 0.3));

  float s = fbm(p * 18.0);
  vec3 sand = mix(c_ochre, c_paper, 0.3 + 0.35 * s);
  sand = mix(sand, c_sepia, step(0.96, hash(floor(p * 260.0))) * 0.3);
  float depth = 0.35 + 0.35 * fbm(p * 2.0 + 4.0);
  vec3 col = mix(sand, c_sea, depth * 0.85);
  vec3 foam = mix(c_hi, vec3(1.0), 0.65);
  float c = clamp(caustic(p * 7.5 - 250.0, t), 0.0, 1.0);
  col = mix(col, foam, c * (0.65 - depth * 0.45));
  col = mix(col, foam, max(rip, 0.0) * exp(-d * 4.0) * 0.25);
  o = vec4(col, 1.0);
}`,
  },

  sonar: {
    name: "Sonar sounding",
    note: "Range rings, a sweeping beam and echoes off a hidden seabed, like an old depth sounding.",
    colors: ["paper", "sepia", "accent"],
    dpr: 2,
    frag: PAPER + `
float gridLine(float v, float w) { return 1.0 - smoothstep(w * 0.5, w * 1.2, abs(fract(v - 0.5) - 0.5) / fwidth(v)); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  vec2 src = vec2(0.12 * aspect, 0.15);
  if (u_mouse.x > -1e4) src = mix(src, u_mouse / u_res.y, 0.15);
  vec2 d = uv - src;
  float r = length(d), a = atan(d.y, d.x);

  vec3 col = paperTone(c_paper, c_sepia, frag);
  col = mix(col, c_sepia, gridLine(r * 10.0, 1.4 * u_dpr) * 0.35);
  col = mix(col, c_sepia, gridLine(a / (6.2831 / 24.0), 1.0 * u_dpr) * 0.1 * step(0.05, r));

  float sweep = mod(u_time * 0.45, 6.2831853);
  float da = mod(sweep - a + 6.2831853, 6.2831853);
  float trail = exp(-da * 2.5);
  col = mix(col, c_accent, trail * 0.12);

  float bed = smoothstep(0.56, 0.6, fbm(uv * 2.5 + 3.0));
  float edgeBed = bed - smoothstep(0.6, 0.66, fbm(uv * 2.5 + 3.0));
  col = mix(col, c_accent, edgeBed * trail * 0.9);
  col = mix(col, c_sepia, bed * trail * 0.25);

  float pr = fract(u_time * 0.07) * 2.2;
  col = mix(col, c_accent, exp(-abs(r - pr) * 140.0) * (1.0 - pr / 2.2) * 0.8);
  o = vec4(col, 1.0);
}`,
  },

  // ---------------------------------------------------------------- Nature
  watercolour: {
    name: "Watercolour tide",
    note: "Washes of sea, kelp and ochre pooling on cold-press paper, with darker pigment at their edges.",
    colors: ["paper", "sepia", "sea", "kelp", "ochre", "accent"],
    dpr: 1.25,
    frag: PAPER + `
float wash(vec2 p, float t, float th, out float edge) {
  float v = fbm(p + 1.2 * vec2(fbm(p * 1.3 + t), fbm(p * 1.3 - t + 3.1)));
  float m = smoothstep(th, th + 0.015, v);
  edge = m - smoothstep(th + 0.015, th + 0.06, v);
  return m;
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  float t = u_time * 0.02;
  vec3 col = paperTone(c_paper, c_sepia, frag);
  float g = noise(frag / (3.0 * u_dpr));
  float e;
  float m;
  m = wash(uv * 1.2, t, 0.47, e);               col = mix(col, c_sea, m * (0.4 + 0.2 * g));    col = mix(col, c_sea * 0.7, e * 0.5);
  m = wash(uv * 1.5 + 7.3, t * 1.2, 0.55, e);   col = mix(col, c_kelp, m * (0.4 + 0.2 * g));   col = mix(col, c_kelp * 0.7, e * 0.5);
  m = wash(uv * 1.7 + 2.1, t * 0.9, 0.6, e);    col = mix(col, c_ochre, m * (0.45 + 0.2 * g)); col = mix(col, c_ochre * 0.7, e * 0.5);
  m = wash(uv * 2.2 + 9.9, t * 1.4, 0.66, e);   col = mix(col, c_accent, m * (0.5 + 0.2 * g)); col = mix(col, c_accent * 0.7, e * 0.5);
  o = vec4(col, 1.0);
}`,
  },

  cells: {
    name: "Cell study",
    note: "Living cells with walls and nuclei, like a microscope slide. The cursor is a lens.",
    colors: ["paper", "sepia", "faint", "kelp", "ochre"],
    dpr: 1.5,
    frag: PAPER + `
vec2 h2(vec2 p) { return vec2(hash(p), hash(p + 19.19)); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  float t = u_time * 0.15;
  float k = 7.0;
  vec2 p = uv * k;
  vec2 mp = (u_mouse / u_res.y) * k;
  float dm = length(p - mp);
  p = mp + (p - mp) * (1.0 - 0.35 * exp(-dm * dm * 0.6));

  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0;
  vec2 best = vec2(0.0), bestId = vec2(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = 0.5 + 0.4 * sin(t + 6.2831 * h2(ip + g));
      vec2 dd = g + r - fp;
      float d = dot(dd, dd);
      if (d < f1) { f2 = f1; f1 = d; best = dd; bestId = ip + g; }
      else if (d < f2) f2 = d;
    }
  float edge = sqrt(f2) - sqrt(f1);
  float aa = 1.5 * k / u_res.y;
  float wall = 1.0 - smoothstep(0.05, 0.05 + aa, edge);
  float nd = length(best);
  float nucleus = 1.0 - smoothstep(0.1, 0.1 + aa, nd);
  float ring = (1.0 - smoothstep(0.0, aa, abs(nd - 0.1)));

  vec3 col = paperTone(c_paper, c_sepia, frag);
  col = mix(col, c_faint, 0.25 + 0.35 * hash(bestId) + 0.2 * smoothstep(0.3, 0.05, edge));
  col = mix(col, c_sepia, step(0.93, hash(floor(frag / (2.0 * u_dpr)))) * 0.2 * (1.0 - wall));
  col = mix(col, c_kelp, wall * 0.85);
  col = mix(col, c_ochre, nucleus * 0.8);
  col = mix(col, c_sepia, ring * 0.6);
  o = vec4(col, 1.0);
}`,
  },

  filings: {
    name: "Iron filings",
    note: "Iron filings tracing a magnet's field. The cursor carries the second pole.",
    colors: ["paper", "sepia", "accent"],
    dpr: 1.5,
    frag: PAPER + `
vec2 field(vec2 p, vec2 a, vec2 b) {
  vec2 da = p - a, db = p - b;
  return da / pow(dot(da, da) + 1e-4, 1.5) - db / pow(dot(db, db) + 1e-4, 1.5);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = u_res.x / u_res.y;
  float t = u_time;
  vec2 pa = vec2(0.5 * aspect - 0.3, 0.5) + 0.03 * vec2(sin(t * 0.3), cos(t * 0.2));
  vec2 pb = vec2(0.5 * aspect + 0.3, 0.5) + 0.03 * vec2(cos(t * 0.25), sin(t * 0.35));
  if (u_mouse.x > -1e4) pb = u_mouse / u_res.y;

  float cell = 7.0 * u_dpr;
  vec2 ip = floor(frag / cell);
  float ink = 0.0, warm = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 id = ip + vec2(float(x), float(y));
      vec2 c = (id + 0.5 + (vec2(hash(id), hash(id + 5.3)) - 0.5) * 0.7) * cell;
      vec2 B = field(c / u_res.y, pa, pb);
      float s = length(B);
      vec2 dir = B / s;
      float wob = 0.15 * sin(t * 0.8 + hash(id) * 30.0);
      dir = mat2(cos(wob), -sin(wob), sin(wob), cos(wob)) * dir;
      float keep = step(hash(id + 3.7), clamp(log(s) / 5.0, 0.12, 1.0));
      float len = cell * (0.35 + 0.15 * hash(id + 1.1));
      vec2 q = frag - c;
      float h = clamp(dot(q, dir), -len, len);
      float dist = length(q - dir * h);
      float w = 0.55 * u_dpr;
      float l = keep * (1.0 - smoothstep(w - 0.6, w + 0.6, dist));
      if (l > ink) { ink = l; warm = smoothstep(2.5, 6.0, log(s)); }
    }
  vec3 col = paperTone(c_paper, c_sepia, frag);
  col = mix(col, mix(c_sepia, c_accent, warm), ink * 0.9);
  o = vec4(col, 1.0);
}`,
  },

  // ---------------------------------------------------------------- Old book
  spiral: {
    name: "Spiral engraving",
    note: "One continuous burin line whose weight carries the image, like a banknote plate.",
    colors: ["paper", "sepia", "accent"],
    dpr: 2,
    frag: PAPER + PLATE + HATCH + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (frag - 0.5 * u_res) / u_res.y;
  vec2 c = 0.03 * vec2(sin(u_time * 0.1), cos(u_time * 0.13));
  if (u_mouse.x > -1e4) c = mix(c, (u_mouse - 0.5 * u_res) / u_res.y, 0.08);
  vec2 d = uv - c;
  float r = length(d), a = atan(d.y, d.x);
  float tone = smoothstep(0.3, 0.75, plate(uv * 1.8 + 3.0, u_time * 0.02));
  float v = r * u_res.y / (5.0 * u_dpr) - a / 6.2831853;
  v += 0.12 * sin(a * 9.0 + r * 20.0 - u_time * 0.3);
  float line = hatch(v, 0.12 + 0.75 * tone);
  vec3 col = paperTone(c_paper, c_sepia, frag);
  col = mix(col, c_accent, line * 0.95);
  o = vec4(col, 1.0);
}`,
  },

  mezzotint: {
    name: "Mezzotint",
    note: "A rocked, grained plate of a slow storm. The cursor burnishes it lighter.",
    colors: ["paper", "sepia"],
    dpr: 1.5,
    frag: PAPER + PLATE + `
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  float tone = smoothstep(0.25, 0.8, plate(uv * 2.4, u_time * 0.03));
  tone = mix(tone, 1.0, smoothstep(0.45, 0.9, length(frag / u_res - 0.5)) * 0.4);
  vec2 m = u_mouse / u_res.y;
  tone *= 1.0 - 0.75 * exp(-dot(uv - m, uv - m) * 50.0);
  float th = ign(floor(frag / (1.5 * u_dpr)));
  float ink = step(th, tone);
  vec3 col = paperTone(c_paper, c_sepia, frag);
  col = mix(col, c_sepia, ink * 0.92);
  o = vec4(col, 1.0);
}`,
  },

  atlas: {
    name: "Celestial atlas",
    note: "A turning star chart: declination rings, hour lines, the ecliptic and wandering planets.",
    colors: ["abyss", "sea", "ochre", "sepia", "accent", "hi"],
    dpr: 1.5,
    frag: PARTICLES + `
float ringLine(float v, float w) { return 1.0 - smoothstep(w * 0.5, w * 1.2, abs(fract(v - 0.5) - 0.5) / fwidth(v)); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (frag - 0.5 * u_res) / u_res.y;
  float t = u_time;
  float r = length(uv);
  float a = atan(uv.y, uv.x) + t * 0.01;

  vec3 col = mix(c_abyss, mix(c_abyss, c_sea, 0.4), smoothstep(0.7, 0.0, r));
  col = mix(col, c_ochre, ringLine(r * 10.0, 1.0 * u_dpr) * 0.22 * step(r, 0.48));
  col = mix(col, c_ochre, ringLine(a / (6.2831853 / 24.0), 0.8 * u_dpr) * 0.12 * step(0.1, r) * step(r, 0.48));

  // Outer degree band with ticks.
  float band = step(0.47, r) * step(r, 0.5);
  float tick = ringLine(a / (6.2831853 / 72.0), 1.0 * u_dpr);
  col = mix(col, c_ochre, band * (0.12 + tick * 0.5));
  col = mix(col, c_ochre, ringLine(r * 10.0 + 0.3, 1.0 * u_dpr) * 0.35 * step(0.46, r) * step(r, 0.51));

  // The ecliptic, dashed.
  float ca = cos(0.4 + t * 0.01), sa = sin(0.4 + t * 0.01);
  vec2 q = mat2(ca, -sa, sa, ca) * uv;
  float e = length(q / vec2(0.42, 0.18));
  float dash = step(0.5, fract(atan(q.y, q.x) * 12.0));
  col = mix(col, c_accent, (1.0 - smoothstep(0.0, 1.5 * fwidth(e), abs(e - 1.0))) * dash * 0.7);

  // Planets on circular orbits.
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float pr = 0.1 + fi * 0.08;
    float pa = t * (0.12 / (1.0 + fi)) + fi * 2.1;
    vec2 pp = pr * vec2(cos(pa), sin(pa));
    float pd = length(uv - pp) * u_res.y / u_dpr;
    col = mix(col, i == 2 ? c_accent : c_hi, 1.0 - smoothstep(2.0, 3.2, pd));
  }

  col += c_sepia * motes(frag, 9.0, 0.0, t, 0.12) * 0.6;
  col += c_hi * motes(frag + 71.0, 31.0, 0.0, t, 0.25) * 0.9;
  o = vec4(col, 1.0);
}`,
  },

  botanical: {
    name: "Botanical plate",
    note: "Engraved leaves and flowers, hand-tinted in kelp and orange. The cursor stirs them.",
    colors: ["paper", "sepia", "kelp", "accent", "ochre"],
    dpr: 2,
    frag: PAPER + HATCH + `
float sdVesica(vec2 p, float r, float d) {
  p = abs(p);
  float b = sqrt(r * r - d * d);
  return ((p.y - b) * d > p.x * b) ? length(p - vec2(0.0, b)) : length(p - vec2(-d, 0.0)) - r;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float px = 1.0 / u_res.y;
  float t = u_time;
  vec2 m = u_mouse / u_res.y;

  vec3 col = paperTone(c_paper, c_sepia, frag);
  col = mix(col, c_sepia, hatch(dot(frag, vec2(0.7, 0.7)) / (6.0 * u_dpr), 0.08) * 0.08);

  for (int s = 0; s < 3; s++) {
    float fs = float(s);
    float baseX = aspect * (0.18 + 0.32 * fs) + 0.04 * sin(fs * 4.0);
    float sway = 0.03 * sin(t * 0.4 + fs * 2.0);
    // Stem.
    float sx = baseX + 0.07 * sin(uv.y * 2.2 + fs) * uv.y + sway * uv.y;
    float top = 0.82 - 0.06 * fs;
    float stem = (1.0 - smoothstep(0.7 * px * u_dpr, 1.6 * px * u_dpr, abs(uv.x - sx))) * step(uv.y, top);
    col = mix(col, c_sepia, stem * 0.85);

    for (int k = 0; k < 6; k++) {
      float fk = float(k);
      float ly = 0.12 + fk * 0.11;
      if (ly > top - 0.06) continue;
      float side = mod(fk + fs, 2.0) * 2.0 - 1.0;
      float lx = baseX + 0.07 * sin(ly * 2.2 + fs) * ly + sway * ly;
      float size = 0.075 * (1.0 - fk * 0.07);
      float ang = side * 1.0 + 0.15 * sin(t * 0.6 + fk + fs);
      ang += 0.5 * side * exp(-dot(vec2(lx, ly) - m, vec2(lx, ly) - m) * 25.0);
      vec2 c = vec2(lx, ly) + rot(-ang) * vec2(0.0, size * 0.6);
      vec2 q = rot(ang) * (uv - c) / size;
      float d = sdVesica(q, 1.0, 0.8) * size;
      float inside = 1.0 - smoothstep(-px, px, d);
      vec3 tint = mod(fk, 3.0) < 1.0 ? c_accent : c_kelp;
      col = mix(col, tint, inside * 0.35);
      col = mix(col, tint * 0.75, inside * smoothstep(-0.012, 0.0, d) * 0.4);
      float veins = hatch((q.y - abs(q.x) * 0.9) * 7.0, 0.12) * inside;
      float rib = (1.0 - smoothstep(0.5 * px, 1.2 * px, abs(q.x) * size)) * inside;
      col = mix(col, c_sepia, max(veins * 0.5, rib * 0.8));
      col = mix(col, c_sepia, (1.0 - smoothstep(0.4 * px * u_dpr, 1.3 * px * u_dpr, abs(d))) * 0.9);
    }
    // Flower at the top: a five-petal rose curve.
    vec2 fc = vec2(baseX + 0.07 * sin(top * 2.2 + fs) * top + sway * top, top);
    vec2 fd = uv - fc;
    float fa = atan(fd.y, fd.x) + t * 0.05;
    float pr = 0.04 * (0.55 + 0.45 * abs(cos(2.5 * fa)));
    float fdist = length(fd) - pr;
    float petal = 1.0 - smoothstep(-px, px, fdist);
    col = mix(col, c_accent, petal * 0.7);
    col = mix(col, c_sepia, (1.0 - smoothstep(0.4 * px * u_dpr, 1.3 * px * u_dpr, abs(fdist))) * 0.9);
    col = mix(col, c_ochre, 1.0 - smoothstep(0.008, 0.008 + px, length(fd)));
  }
  o = vec4(col, 1.0);
}`,
  },

  // ---------------------------------------------------------------- Abstract (round 1)
  dither: {
    name: "Dithered ember",
    note: "A slow orange flow, Bayer-dithered into pixels like the current tile field.",
    colors: ["bg", "accent"],
    dpr: 1,
    frag: BAYER + `
void main() {
  float px = 3.0 * u_dpr;
  vec2 cell = floor(gl_FragCoord.xy / px);
  vec2 uv = cell * px / u_res.y;
  float t = u_time;
  float v = fbm(uv * 1.4 + 1.5 * vec2(fbm(uv * 2.0 + t * 0.05), fbm(uv * 2.0 - t * 0.04)) + t * 0.03);
  vec2 m = u_mouse / u_res.y;
  v += 0.25 * exp(-dot(uv - m, uv - m) * 30.0);
  v = smoothstep(0.45, 0.8, v);
  o = vec4(mix(c_bg, c_accent, step(bayer8(cell), v)), 1.0);
}`,
  },

  mesh: {
    name: "Ember mesh",
    note: "Graphite-to-orange mesh gradient under film grain.",
    colors: ["bg", "faint", "accent", "hi"],
    dpr: 1,
    frag: `
vec3 ramp(float v) {
  if (v < 0.45) return c_bg;
  if (v < 0.7) return mix(c_bg, c_faint, (v - 0.45) / 0.25);
  if (v < 0.9) return mix(c_faint, c_accent, (v - 0.7) / 0.2);
  return mix(c_accent, c_hi, clamp((v - 0.9) / 0.1, 0.0, 1.0));
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.15;
  float v = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 p = vec2(aspect * (0.5 + 0.4 * sin(t * (0.7 + 0.2 * fi) + fi * 2.0)), 0.5 + 0.4 * cos(t * (0.5 + 0.3 * fi) + fi));
    v += (0.6 - 0.1 * fi) * exp(-dot(uv - p, uv - p) * 3.0);
  }
  v += 0.15 * (fbm(uv * 2.0 + t) - 0.5);
  vec3 col = ramp(clamp(v, 0.0, 1.0));
  col += (hash(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5) * 0.05;
  o = vec4(col, 1.0);
}`,
  },

  godrays: {
    name: "Godrays",
    note: "Warm light from the top corner; calm, lets the copy lead.",
    colors: ["bg", "accent"],
    dpr: 1,
    frag: RAYS + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float r = rays(uv, u_res.x / u_res.y, u_time, -0.35);
  vec3 col = mix(c_bg, c_accent, r * 0.3);
  col += (hash(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5) * 0.03;
  o = vec4(col, 1.0);
}`,
  },

  aurora: {
    name: "Aurora rise",
    note: "Curtains of light with bright lower hems, drifting across the top.",
    colors: ["bg", "faint", "accent", "hi"],
    dpr: 1,
    frag: `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float t = u_time;
  vec3 col = c_bg;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float cy = 0.55 + 0.08 * fi + 0.06 * sin(uv.x * 3.0 + t * 0.2 + fi * 1.3) + 0.03 * sin(uv.x * 7.0 - t * 0.3 + fi);
    float d = uv.y - cy;
    float streak = fbm(vec2(uv.x * 30.0 + fi * 7.0 + t * 0.1, t * 0.05));
    float curtain = smoothstep(-0.015, 0.0, d) * exp(-max(d, 0.0) * (5.0 + fi * 2.0)) * (0.3 + 0.9 * streak);
    vec3 cc = i == 1 ? c_hi : (i == 3 ? c_faint : c_accent);
    col = mix(col, cc, clamp(curtain * 0.55, 0.0, 1.0));
  }
  o = vec4(col, 1.0);
}`,
  },

  dots: {
    name: "Dot field + ripples",
    note: "A twinkling dot grid that ripples out from the cursor.",
    colors: ["bg", "accent"],
    dpr: 1.5,
    frag: `
void main() {
  vec2 frag = gl_FragCoord.xy;
  float t = u_time;
  vec2 src = u_mouse.x > -1e4 ? u_mouse : u_res * vec2(0.5 + 0.3 * sin(t * 0.13), 0.5 + 0.3 * cos(t * 0.11));
  vec2 dv = frag - src;
  float d = length(dv);
  float wave = sin(d / (12.0 * u_dpr) - t * 4.0) * exp(-d / (260.0 * u_dpr));
  vec2 p = frag + dv / max(d, 1.0) * wave * 4.0 * u_dpr;
  float cell = 14.0 * u_dpr;
  vec2 id = floor(p / cell);
  float dist = length(fract(p / cell) - 0.5) * cell;
  float h = hash(id);
  float tw = 0.5 + 0.5 * sin(t * (1.0 + h) + h * 50.0);
  float size = (1.1 + 0.9 * max(wave, 0.0)) * u_dpr;
  float dot_ = 1.0 - smoothstep(size - 0.7, size + 0.7, dist);
  o = vec4(mix(c_bg, c_accent, dot_ * (0.25 + 0.55 * tw + 0.3 * max(wave, 0.0))), 1.0);
}`,
  },

  ascii: {
    name: "ASCII flow",
    note: "A flowing gradient drawn as terminal glyphs, from dots to @.",
    colors: ["bg", "faint", "accent", "hi"],
    dpr: 1,
    frag: `
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float glyph(int g, vec2 p) {
  float d = 1e5;
  if (g == 1) d = length(p - vec2(0.0, -4.0)) - 1.0;
  else if (g == 2) d = min(length(p - vec2(0.0, -3.0)), length(p - vec2(0.0, 3.0))) - 1.0;
  else if (g == 3) d = sdBox(p, vec2(3.0, 0.6));
  else if (g == 4) d = min(sdBox(p - vec2(0.0, 2.0), vec2(3.0, 0.6)), sdBox(p + vec2(0.0, 2.0), vec2(3.0, 0.6)));
  else if (g == 5) d = min(sdBox(p, vec2(3.0, 0.6)), sdBox(p, vec2(0.6, 3.0)));
  else if (g == 6) {
    vec2 q = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p;
    d = min(min(sdBox(p, vec2(3.0, 0.6)), sdBox(p, vec2(0.6, 3.0))), min(sdBox(q, vec2(3.0, 0.6)), sdBox(q, vec2(0.6, 3.0))));
  } else if (g == 7) {
    d = min(min(sdBox(p - vec2(1.6, 0.0), vec2(0.6, 4.5)), sdBox(p + vec2(1.6, 0.0), vec2(0.6, 4.5))),
            min(sdBox(p - vec2(0.0, 1.8), vec2(3.2, 0.6)), sdBox(p + vec2(0.0, 1.8), vec2(3.2, 0.6))));
  } else if (g == 8) d = min(abs(length(p) - 3.2) - 0.7, length(p) - 1.2);
  return d;
}
void main() {
  vec2 cellSz = vec2(8.0, 14.0) * u_dpr;
  vec2 id = floor(gl_FragCoord.xy / cellSz);
  vec2 q = (fract(gl_FragCoord.xy / cellSz) - 0.5) * cellSz / u_dpr;
  vec2 uv = (id + 0.5) * cellSz / u_res.y;
  float t = u_time;
  float v = fbm(uv * 1.6 + 1.4 * vec2(fbm(uv * 2.0 + t * 0.06), fbm(uv * 2.0 - t * 0.05)) + t * 0.03);
  vec2 m = u_mouse / u_res.y;
  v += 0.3 * exp(-dot(uv - m, uv - m) * 25.0);
  v = smoothstep(0.35, 0.85, v);
  int g = int(floor(v * 8.99));
  float ink = 1.0 - smoothstep(-0.5, 0.5, glyph(g, q) * u_dpr);
  vec3 gc = mix(c_faint, c_accent, smoothstep(0.2, 0.7, v));
  gc = mix(gc, c_hi, smoothstep(0.8, 1.0, v));
  o = vec4(mix(c_bg, gc, ink), 1.0);
}`,
  },

  // ---------------------------------------------------------------- Warm nature studies
  // Palette keys beyond the first ramp (ivory, clay, kraft, sage) are the
  // Anthropic-adjacent warm neutrals: ivory paper, clay tint, kraft and olive.
  stipple: {
    name: "Stipple plate",
    note: "Ink dots carry the tone, the way an 18th-century stipple engraving builds a form.",
    colors: ["ivory", "sepia", "accent", "ochre", "clay"],
    dpr: 1.5,
    frag: NOISE + PAPER + `
const float PI = 3.14159265;

// A pool of ink, its edge broken up the way a drop dries.
float blot(vec2 p, vec2 c, float r) {
  return smoothstep(r, r * 0.15, length(p - c) + 0.010 * (sfbm(p * 55.0, 2) - 0.5));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = u_res.x / u_res.y;
  vec2 p = (frag - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.05;
  // The quill lies across the plate: nib low on the left, plume rising right.
  // It sways a little, as though the paper were not quite flat.
  float sway = 0.009 * sin(t + 1.3);
  vec2 A = vec2(-0.34 + sway, -0.78);
  vec2 B = vec2(0.26 + sway * 0.5, 0.10);
  vec2 axis = B - A;
  float len = length(axis);
  vec2 dir = axis / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 q = p - A;
  float s = dot(q, dir) / len;   // 0 at the nib, 1 at the tip
  float v = dot(q, nrm);         // across the quill; +v is the narrow vane

  // Vane: it grows out of the bare quill, fattest past the middle, and tapers
  // to a point. The two halves are unequal, and the narrow one has torn open
  // along a barb, which is what tells the eye this is a feather, not a leaf.
  float u = clamp((s - 0.26) / 0.74, 0.0, 1.0);
  float hw = 0.150 * pow(sin(PI * pow(u, 0.68)), 0.80);
  float wide = hw * (v > 0.0 ? 0.78 : 1.15);
  float sd = abs(v) - wide;
  float body = smoothstep(0.0028, -0.0035, sd);
  float split = smoothstep(0.38, 0.44, u) * (1.0 - smoothstep(0.56, 0.62, u))
              * smoothstep(0.0, 0.015, v) * step(wide * 0.55, abs(v));
  body *= 1.0 - split;

  // Across the vane: the light is up and to the left, so the wide half turns
  // into shadow and the narrow half thins away into the light. The dots have
  // to carry that whole ramp, which is the whole trick of the technique.
  float x = clamp(v / max(wide, 1e-4), -1.0, 1.0);
  float tone = mix(0.96, 0.12, smoothstep(-1.0, 1.0, x));
  // One more fold along the length of the vane, where the barbs crowd.
  tone *= 1.0 - 0.26 * exp(-pow((x - 0.34) / 0.24, 2.0));
  tone = max(tone, 0.92 * exp(-pow(x / 0.13, 2.0)));
  // A hand does not shade evenly.
  tone *= 0.88 + 0.24 * sfbm(vec2(s * 5.0, v * 9.0) + 0.5, 3);
  // The contour: an engraver crowds the dots right up to the edge of the form,
  // which is what keeps the silhouette crisp against the bare paper.
  tone = max(tone, (1.0 - smoothstep(0.0, 0.013, abs(sd))) * (v < 0.0 ? 0.90 : 0.34));
  tone *= body;

  // Cast shadow, pooling down and to the right of the quill.
  vec2 off = vec2(0.050, -0.055);
  float os = dot(off, dir) / len, ov = dot(off, nrm);
  float su = clamp(((s - os) - 0.26) / 0.74, 0.0, 1.0);
  float shw = 0.150 * pow(sin(PI * pow(su, 0.68)), 0.80);
  float sw = shw * ((v - ov) > 0.0 ? 0.78 : 1.15);
  float shade = smoothstep(0.060, -0.035, abs(v - ov) - sw);
  tone = max(tone, 0.34 * shade * (1.0 - body));

  // Stray drops where the nib was wiped.
  tone = max(tone, 0.95 * max(blot(p, vec2(-0.22, -0.40), 0.012),
                        max(blot(p, vec2(-0.13, -0.49), 0.006), blot(p, vec2(-0.28, -0.30), 0.004))));

  // The plate is wiped unevenly, so tone falls away toward the edges.
  vec2 np = p / vec2(0.5 * max(aspect, 0.4), 0.5);
  tone *= mix(0.60, 1.0, smoothstep(1.45, 0.40, length(np)));
  tone = clamp(tone, 0.0, 1.0);

  // The stipple itself: one dot per cell, kept with probability = tone, so the
  // count of dots carries the tone the way the burin left it. The cell lattice
  // is sheared along the barbs first, so the dots gather into streaks instead
  // of sitting on an even screen.
  float cell = 3.2 * u_dpr;
  vec2 sc = frag - dir * (0.34 * abs(v) * u_res.y);
  vec2 id = floor(sc / cell);
  vec2 jit = vec2(hash(id + 0.7), hash(id + 7.3)) - 0.5;
  vec2 dotc = (id + 0.5 + jit * 0.35) * cell;
  float pd = length(dotc - sc);
  float keep = step(hash(id + 21.9), tone);
  float rad = (0.34 + 0.12 * sqrt(tone)) * cell * (1.0 + 0.05 * sin(t * 2.0 + hash(id + 3.1) * 6.283));
  float dots = keep * (1.0 - smoothstep(rad - 0.8, rad + 0.8, pd));
  // A finer screen comes in where the tone deepens. That is how a plate builds
  // a shadow: crowding a second stipple into the same inch, not swelling the
  // dots until they run together into a moire.
  float cell2 = cell * 0.56;
  vec2 sc2 = frag - dir * (0.19 * abs(v) * u_res.y);
  vec2 id2 = floor(sc2 / cell2);
  vec2 jit2 = vec2(hash(id2 + 3.3), hash(id2 + 9.7)) - 0.5;
  float pd2 = length((id2 + 0.5 + jit2 * 0.4) * cell2 - sc2);
  float fine = step(hash(id2 + 51.7), smoothstep(0.52, 0.98, tone) * 0.80)
             * (1.0 - smoothstep(cell2 * 0.30, cell2 * 0.40, pd2));
  dots = max(dots, fine);
  // Loose specks the hand left in the lights.
  dots = max(dots, (1.0 - smoothstep(0.0, 1.1, pd)) * step(0.9965, hash(id + 41.0)) * 0.55);

  // The rachis, and the bare quill below the vane, are cut lines rather than
  // dots: the only place a stipple plate ever draws a line.
  float spine = (1.0 - smoothstep(0.0012, 0.0040, abs(v))) * smoothstep(0.28, 0.32, s) * smoothstep(1.02, 0.98, s);
  float qw = mix(0.0025, 0.0075, smoothstep(0.0, 0.26, s));
  float quill = (1.0 - smoothstep(qw, qw + 0.0020, abs(v))) * smoothstep(-0.02, 0.0, s) * smoothstep(0.30, 0.24, s);

  vec3 col = paperTone(c_ivory, c_sepia, frag);
  vec3 ink = mix(c_sepia, c_accent, 0.32 * smoothstep(0.42, 0.95, tone));
  col = mix(col, ink, dots * 0.94);
  col = mix(col, ink, spine * 0.78);
  col = mix(col, ink, quill * 0.90);
  col = mix(col, c_ochre, smoothstep(0.45, 1.0, tone) * 0.06);
  col = mix(col, c_clay, smoothstep(0.60, 1.20, length(np)) * 0.05);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  meadow: {
    name: "Meadow wind",
    note: "A field of blades under a travelling gust, warm on the windward side.",
    colors: ["ivory", "sepia", "sage", "ochre", "accent"],
    dpr: 1.5,
    frag: NOISE + GRADIENT + PAPER + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time;
  float px = u_dpr / u_res.y;

  // Sky: warm paper, a shade heavier towards the right.
  vec3 col = paperTone(c_ivory, c_sepia, frag);
  col = mix(col, c_ochre, 0.07 * smoothstep(0.2, 1.0, uv.x / aspect));

  float gust = 0.5 + 0.5 * sin(t * 0.22 - uv.x * 2.2);

  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float unit = 0.020 + 0.010 * fi;
    float depth = fi / 3.0;
    float id = floor(uv.x / unit);
    float r = hash(vec2(id, 11.0 + fi * 7.0));
    float baseY = 0.30 - 0.11 * depth + 0.04 * r;
    float hgt = (0.20 + 0.30 * r) * (0.55 + 0.5 * depth);
    float q = clamp((uv.y - baseY) / hgt, 0.0, 1.0);
    float phase = r * 6.283 - fi * 0.9;
    float bend = (0.05 + 0.10 * depth) * (0.35 + 0.9 * gust) * sin(t * 0.5 + phase);
    float sx = (id + 0.5 + 0.35 * (hash(vec2(id, 3.0 + fi)) - 0.5)) * unit;
    float w = unit * (0.42 - 0.30 * q) * (0.7 + 0.5 * depth);
    float aa = 1.1 * px;
    float d = abs(uv.x - (sx + bend * q * q)) - w;
    float blade = (1.0 - smoothstep(-aa, aa, d)) * (1.0 - smoothstep(baseY + hgt - aa, baseY + hgt + aa, uv.y));
    blade *= step(baseY - 0.06, uv.y);

    // The gust lights the upper half of the windward blades.
    float lit = 0.25 + 0.75 * smoothstep(0.0, 1.0, gust) * smoothstep(0.45, 0.95, q);
    vec3 leaf = mix(c_sage, c_sepia, 0.60 - 0.30 * depth);
    leaf = mix(leaf, c_ochre, lit * 0.45);
    leaf = mix(leaf, c_accent, lit * lit * 0.22 * (1.0 - depth));
    col = mix(col, leaf, blade * (0.35 + 0.55 * depth));
  }
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  cirrus: {
    name: "Cloud study",
    note: "Cirrus over stratus in warm sky light, sheared slowly across the page.",
    colors: ["ivory", "faint", "sepia", "ochre", "accent"],
    dpr: 1,
    frag: NOISE + PAPER + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.02;

  // Warm sky, brighter towards a low sun off to the right.
  vec3 col = mix(c_ivory, c_faint, smoothstep(0.85, 0.05, p.y) * 0.85);
  vec2 s = p - vec2(aspect * 0.95, 0.12);
  float sun = exp(-dot(s, s) * 5.0);
  col = mix(col, c_ochre, sun * 0.20);
  col = mix(col, c_accent, sun * sun * 0.10);

  // Cirrus: high, thin, sheared hard along x.
  float ci = sfbm(vec2(p.x * 0.9 - t, p.y * 9.0 + t * 0.5), 4);
  ci = smoothstep(0.12, 0.58, ci);
  col = mix(col, c_ivory, ci * 0.55);
  col = mix(col, c_sepia, ci * ci * 0.10);

  // Stratus: a low sheet massing towards the bottom.
  float st = sfbm(vec2(p.x * 1.1 - t * 1.8, p.y * 2.4), 5);
  st = smoothstep(0.44, 0.80, st + 0.16 * smoothstep(0.55, 0.0, p.y));
  col = mix(col, mix(c_ivory, c_faint, 0.6), st * 0.8);
  col = mix(col, c_sepia, st * 0.10);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  strata: {
    name: "Strata section",
    note: "A cut through sedimentary rock: warm beds, ink partings, one clay seam.",
    colors: ["ivory", "faint", "ochre", "kraft", "sepia", "accent"],
    dpr: 1,
    frag: NOISE + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.01;

  // Beds folded very slowly, bedded thicker towards the bottom.
  float y = p.y + 0.045 * sfbm(vec2(p.x * 0.5, p.y * 1.4) + t, 3);
  float band = y * 6.5 + 0.7 * smoothstep(0.0, 1.0, p.y);
  float id = floor(band);
  float f = fract(band);
  float r = hash(vec2(id, 4.4));

  vec3 rock = mix(c_ivory, c_faint, 0.35 + 0.4 * r);
  rock = mix(rock, c_ochre, smoothstep(0.55, 1.0, r) * 0.5);
  rock = mix(rock, c_kraft, smoothstep(0.78, 1.0, hash(vec2(id, 9.9))) * 0.45);
  rock = mix(rock, c_accent, step(0.88, hash(vec2(id, 2.2))) * 0.30);
  rock *= 0.95 + 0.05 * noise(frag * 0.7 / u_dpr);
  float seep = smoothstep(0.60, 0.80, fbm(vec2(p.x * 7.0, p.y * 0.7)));
  rock = mix(rock, c_sepia, seep * 0.12);

  // Ink parting between the beds.
  float e = min(f, 1.0 - f);
  float w = 1.1 * u_dpr * 6.5 / u_res.y;
  float line = 1.0 - smoothstep(w, w + fwidth(band) * 1.5, e);
  o = vec4(deband(mix(rock, c_sepia, line * 0.7), frag), 1.0);
}`,
  },

  // ---------------------------------------------------------------- Complementary fields
  // Orange against its complements: cyan (the direct opposite), indigo/plum
  // (split) and poppy (a hotter neighbour), over deep cool grounds.
  ember: {
    name: "Ember field",
    note: "A molten bloom on deep indigo, its edge laced with cyan filaments.",
    colors: ["deep", "plum", "cyan", "accent", "poppy", "hi"],
    dpr: 0.75,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.05;

  float w = warp(p * 1.5 + vec2(0.0, t), t, 2.0);
  float w2 = warp(p * 2.2 - vec2(t, 0.0), t * 0.8, 2.0);

  vec3 col = mixOk(c_deep, c_plum, 0.10 + 0.22 * smoothstep(0.15, 0.9, w2));
  col = mixOk(col, c_cyan, 0.14 * smoothstep(0.85, 0.25, p.y) * smoothstep(0.3, 0.0, p.x / aspect));

  vec2 c = vec2(aspect * 0.78, 0.16);
  float r = length((p - c) * vec2(1.0, 1.3));
  float ember = smoothstep(0.78, 0.04, r - 0.34 * (w - 0.5));
  col = mixOk(col, c_poppy, ember * 0.55);
  col = mixOk(col, c_accent, ember * ember * 0.80);
  col = mixOk(col, c_hi, ember * ember * ember * 0.55);

  // Where the bloom meets the dark, the complementary colour shows as a rim.
  float edge = smoothstep(0.06, 0.30, ember) * (1.0 - smoothstep(0.40, 0.75, ember));
  float fil = pow(abs(sin(13.0 * w + 4.0 * w2)), 10.0) * smoothstep(0.9, 0.1, ember) * smoothstep(0.06, 0.25, ember);
  col = mixOk(col, c_cyan, edge * 0.45 + fil * 0.55);

  // Sparse embers: one small round dot per cell, so they never read as squares.
  vec2 sc = frag / (7.0 * u_dpr);
  vec2 sid = floor(sc);
  float pick = step(0.9935, hash(sid + floor(u_time * 1.5) * 3.0));
  float dotd = length((sc - sid - 0.5) * 7.0 * u_dpr);
  col += c_hi * pick * (1.0 - smoothstep(0.35, 1.05, dotd)) * 0.7;
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  tide: {
    name: "Complement tide",
    note: "Two crossing wave trains, warm and cool: constructive crests light up, the troughs run orange.",
    colors: ["deep", "sea", "cyan", "accent", "poppy", "hi"],
    dpr: 1,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.35;

  float a = sin(dot(p, vec2(12.5, 5.2)) + t + 1.1 * sfbm(p * 1.4 + t * 0.1, 3));
  float b = sin(dot(p, vec2(-5.6, 14.8)) - t * 0.8 + 1.1 * sfbm(p * 1.6 - t * 0.1 + 9.0, 3));
  float bias = 0.85 + 0.15 * sin(dot(p, vec2(3.0, -2.0)) + t * 0.25);
  float inter = a * b;
  float crest = pow(max(inter, 0.0), 2.0);
  float trough = pow(max(-inter, 0.0), 2.0);

  vec3 col = mixOk(c_deep, c_sea, 0.45 + 0.35 * sin(p.y * 2.4 + t * 0.3));
  crest *= bias;
  col = mixOk(col, c_cyan, crest * 0.75);
  col = mixOk(col, c_hi, crest * crest * 0.35);
  col = mixOk(col, c_accent, trough * 0.60);
  col = mixOk(col, c_poppy, trough * trough * 0.35);

  float sheen = pow(max(0.0, 1.0 - abs(fract(dot(p, vec2(0.8, 0.6)) * 1.4 + 0.2) - 0.5) * 2.0), 6.0);
  col += (c_hi + c_cyan) * 0.05 * sheen * crest;
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  corona: {
    name: "Corona",
    note: "An irregular rayed disc: clay rays, a cyan halo, frayed tips, turning very slowly.",
    colors: ["deep", "plum", "cyan", "accent", "poppy", "ivory", "hi"],
    dpr: 1.5,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.03;
  float px = u_dpr / u_res.y;

  vec2 d = p - vec2(aspect * 0.68, 0.52);
  float r = length(d);
  float ang = atan(d.y, d.x) + t;

  // Rays: every index gets its own length, width and angle jitter, so nothing is symmetric.
  float unit = 0.16;
  float id = floor(ang / unit);
  float ca = (id + 0.5 + 0.35 * (hash(vec2(id, 9.1)) - 0.5)) * unit;
  float da = abs(ang - ca);
  float len = 0.30 + 0.55 * hash(vec2(id, 1.7));
  float wdt = (0.010 + 0.030 * hash(vec2(id, 5.3))) * (0.30 + 0.70 * smoothstep(0.05, 0.6, r / len));
  float ray = (1.0 - smoothstep(wdt, wdt + 1.5 * px, da * r)) * (1.0 - smoothstep(len * 0.35, len, r));
  // Fray the tips into stipple.
  ray *= step(hash(floor(frag / (3.0 * u_dpr)) + 0.5), 0.30 + 0.70 * smoothstep(len, len * 0.45, r));

  vec3 col = mixOk(c_deep, c_plum, 0.14 * smoothstep(0.9, 0.0, r));
  col = mixOk(col, c_cyan, exp(-r * 3.2) * 0.55);
  col = mixOk(col, c_accent, ray * 0.92);
  // A narrower, hotter line down the middle of each ray.
  float hot = (1.0 - smoothstep(wdt * 0.35, wdt * 0.35 + px, da * r)) * (1.0 - smoothstep(len * 0.3, len * 0.85, r));
  col = mixOk(col, c_hi, hot * 0.55);
  col = mixOk(col, c_poppy, ray * smoothstep(0.5, 0.0, r) * 0.35);
  col = mixOk(col, c_hi, 1.0 - smoothstep(0.02, 0.07, r));
  col = mixOk(col, c_ivory, (1.0 - smoothstep(0.015, 0.035, r)) * 0.8);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  // The landing hero's first plate: Corona's rayed disc, engraved the way
  // Stipple builds a form, turning as slowly as Corona does.
  eclipse: {
    name: "Stipple corona",
    note: "Corona engraved as a stipple plate: clay rays and a cyan halo built from ink dots.",
    colors: ["ivory", "sepia", "accent", "poppy", "cyan", "clay"],
    dpr: 2,
    frag: NOISE + PAPER + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = u_res.x / u_res.y;
  vec2 p = frag / u_res.y;
  // On a wide window the disc straddles the detail pane's edge, half on bare
  // paper and half through the glass; on a tall one it rises above the
  // centred copy and shrinks rather than crowding.
  float wide = smoothstep(0.9, 1.3, aspect);
  float R = mix(0.42, 0.36, wide) * min(1.0, aspect / 0.72);
  vec2 d = (p - vec2(aspect * mix(0.55, 0.53, wide), mix(0.70, 0.50, wide))) / R;
  float r = length(d);
  float ang = atan(d.y, d.x) + 0.6 + u_time * 0.02;

  // Rays: each index its own length, width and angle, as in Corona.
  float unit = 0.16;
  float id = floor(ang / unit);
  float ca = (id + 0.5 + 0.35 * (hash(vec2(id, 9.1)) - 0.5)) * unit;
  float da = abs(ang - ca);
  float len = 0.45 + 0.55 * hash(vec2(id, 1.7));
  float wdt = (0.022 + 0.050 * hash(vec2(id, 5.3))) * (0.30 + 0.70 * smoothstep(0.05, 0.6, r / len));
  float x = da * r / wdt;  // 0 on the ray's axis, 1 at its edge
  float along = 1.0 - smoothstep(len * 0.30, len, r);
  // Deep on the axis, thinning to the edge, so every ray is shaded, not filled.
  float ray = (1.0 - smoothstep(0.75, 1.15, x)) * mix(1.0, 0.30, x * x) * along;
  ray *= 0.86 + 0.28 * sfbm(vec2(r * 6.0, id * 1.7), 3);
  // The eclipse: a bare disc ringed by the densest ink on the plate.
  float core = 0.13;
  float ring = exp(-pow((r - core) / 0.035, 2.0));
  float tone = max(ray, ring) * step(core * 0.82, r);
  // Out past the rays the halo carries on as a second, cooler ink.
  float halo = 0.42 * exp(-max(r - core, 0.0) * 3.4) * step(core, r) * (1.0 - ray);

  // The stipple: one dot per cell, kept with probability = tone.
  float cell = 3.0 * u_dpr;
  vec2 id1 = floor(frag / cell);
  vec2 jit = vec2(hash(id1 + 0.7), hash(id1 + 7.3)) - 0.5;
  float pd = length((id1 + 0.5 + jit * 0.35) * cell - frag);
  float keep = step(hash(id1 + 21.9), tone);
  float rad = (0.30 + 0.12 * sqrt(tone)) * cell;
  float dots = keep * (1.0 - smoothstep(rad - 0.7, rad + 0.7, pd));
  // A finer screen crowds in where the ray runs hottest.
  float cell2 = cell * 0.56;
  vec2 id2 = floor(frag / cell2 + 0.5);
  vec2 jit2 = vec2(hash(id2 + 3.3), hash(id2 + 9.7)) - 0.5;
  float pd2 = length((id2 + jit2 * 0.4) * cell2 - frag);
  float fine = step(hash(id2 + 51.7), smoothstep(0.55, 1.0, tone) * 0.75)
             * (1.0 - smoothstep(cell2 * 0.28, cell2 * 0.38, pd2));
  // The halo on its own offset lattice, so the two inks never share a dot.
  vec2 id3 = floor(frag / cell + 0.5);
  float pd3 = length((id3 + (vec2(hash(id3 + 4.1), hash(id3 + 8.2)) - 0.5) * 0.35) * cell - frag);
  float cool = step(hash(id3 + 61.3), halo) * (1.0 - smoothstep(cell * 0.24 - 0.6, cell * 0.24 + 0.6, pd3));
  // Loose specks the hand left on the bare paper.
  float speck = (1.0 - smoothstep(0.0, 1.1, pd)) * step(0.9975, hash(id1 + 41.0)) * 0.5;

  vec3 col = paperTone(c_ivory, c_sepia, frag);
  // Clay at the root of each ray, turning to plain ink toward the frayed tip.
  float tip = smoothstep(0.35, 1.0, r / len);
  vec3 ink = mix(mix(c_accent, c_poppy, ring * 0.5), c_sepia, tip * 0.55);
  col = mix(col, c_cyan, cool * 0.85);
  col = mix(col, ink, max(dots, fine) * 0.94);
  col = mix(col, c_sepia, speck);
  // The plate is wiped unevenly: a faint clay bloom toward the disc.
  col = mix(col, c_clay, 0.05 * exp(-r * 1.6));
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  dune: {
    name: "Dune ripples",
    note: "Wind ripples under a low sun: warm crests and cool shadows, lit by construction.",
    colors: ["kraft", "ochre", "accent", "deep", "cyan", "poppy"],
    dpr: 1.25,
    frag: NOISE + GRADIENT + `
// Height of a ripple field: asymmetric, sharpened on the crest.
float rippleH(vec2 p, float t) {
  float drift = p.x * 0.9 + p.y * 0.45;
  float phase = 21.0 * drift + 0.9 * sfbm(p * 0.7 + vec2(t * 0.1, 0.0), 4);
  float fine = 0.5 + 0.5 * sin(phase * 4.0 + 2.0 * sfbm(p * 3.0, 2));
  return pow(0.5 + 0.5 * sin(phase), 1.6) + 0.18 * fine + 0.05 * sfbm(p * 9.0, 3);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.06;
  float e = 0.004;

  float h = rippleH(p, t);
  vec3 n = normalize(vec3(-(rippleH(p + vec2(e, 0.0), t) - h) / e, -(rippleH(p + vec2(0.0, e), t) - h) / e, 3.0));

  // A low warm sun from the right, cool sky fill from the left: complementary by construction.
  float lit = max(dot(n, normalize(vec3(0.75, 0.35, 0.45))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.5, 0.6, 0.6))), 0.0);

  vec3 col = mixOk(c_deep, c_kraft, 0.35 + 0.65 * h);
  col = mixOk(col, c_ochre, pow(lit, 1.5) * 0.75);
  col = mixOk(col, c_accent, pow(lit, 6.0) * 0.45);
  col = mixOk(col, mixOk(c_deep, c_cyan, 0.6), pow(1.0 - lit, 4.0) * fill * 0.36);
  col = mixOk(col, c_poppy, smoothstep(0.9, 1.0, h) * 0.12);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  mycelium: {
    name: "Mycelium",
    note: "A fungal network creeping across the dark: cyan filaments, warm spore nodes.",
    colors: ["deep", "plum", "cyan", "hi", "accent", "poppy"],
    dpr: 1.25,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.05;

  float w = warp(p * 1.6 + vec2(t * 0.3, 0.0), t, 1.4);

  // Three scales of warped Worley walls read as one branching web.
  float net = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = worley(p * (3.6 + 3.4 * fi) + 0.6 * w + vec2(t * (0.2 + 0.1 * fi), 0.0), 0.0);
    float wall = 1.0 - smoothstep(0.012, 0.012 + 2.2 * fwidth(c.y - c.x), c.y - c.x);
    net = max(net, wall * (1.0 - 0.22 * fi));
  }
  // A growth front: the web thickens towards the right of the frame.
  float grow = smoothstep(aspect * 0.14, aspect * 0.72, p.x + 0.26 * (w - 0.5) + 0.05 * sin(p.y * 3.0 + t));
  net *= grow;

  vec3 col = mixOk(c_deep, c_plum, 0.24 * smoothstep(0.2, 0.9, w));
  col = mixOk(col, c_cyan, net * 0.85);
  col = mixOk(col, c_hi, net * net * 0.30);

  // Spores: a sparse jittered grid, only inside the grown region.
  float cell = 0.09;
  vec2 gid = floor(p / cell);
  vec2 gp = (gid + 0.5 + (vec2(hash(gid), hash(gid + 4.2)) - 0.5) * 0.7) * cell;
  float d = length(p - gp);
  float node = step(0.962, hash(gid + 8.8)) * grow * (1.0 - smoothstep(2.0 * u_dpr / u_res.y, 4.5 * u_dpr / u_res.y, d));
  col = mixOk(col, c_poppy, node * 0.85);
  col = mixOk(col, c_accent, node * 0.35 * smoothstep(0.4, 0.0, d * 40.0));
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  marbling: {
    name: "Suminagashi",
    note: "Paper marbling: three inks combed through a still bath, in clay, mineral and plum.",
    colors: ["ivory", "sepia", "poppy", "cyan", "plum", "ochre"],
    dpr: 1.25,
    frag: NOISE + GRADIENT + PAPER + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.04;

  vec3 col = paperTone(c_ivory, c_sepia, frag);

  // Each ink is a ring field: a comb drags it, noise curls the rings.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = vec2(aspect * (0.30 + 0.22 * fi), 0.48 + 0.20 * sin(fi * 2.1 + t));
    vec2 q = p - c;
    q.y += 0.22 * sin(q.x * 2.1 + fi * 1.7 + t * 0.5);
    q += 0.30 * vec2(sfbm(q * 1.2 + fi * 3.1 + t, 3) - 0.5, sfbm(q * 1.2 - fi * 2.3 - t, 3) - 0.5);
    float d = length(q) * (2.6 + 1.2 * fi) + fi * 0.8 + t * 0.4;
    float band = abs(fract(d) - 0.5) * 2.0;
    float ink = smoothstep(0.84, 0.48, band);
    // Each ink keeps to its own side of the bath, so they layer instead of muddying.
    float own = smoothstep(0.0, 0.7, fi < 1.0 ? p.x : (fi < 2.0 ? p.y : 1.6 - p.x));
    vec3 tint = fi < 1.0 ? c_poppy : (fi < 2.0 ? c_cyan : c_plum);
    col = mixOk(col, tint, ink * own * 0.42);
  }
  col = mixOk(col, c_ochre, 0.05 * sfbm(p * 2.0, 3));
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  riso: {
    name: "Risograph",
    note: "Two ink plates, clay and mineral, printed out of register on warm paper.",
    colors: ["ivory", "sepia", "poppy", "cyan", "plum", "accent"],
    dpr: 1.5,
    frag: NOISE + GRADIENT + PAPER + `
// A rolling hill silhouette, sampled in the plate's own frame.
float hill(vec2 p, float base, float amp, float freq, float t) {
  return p.y - (base + amp * sin(p.x * freq) + 0.02 * sfbm(vec2(p.x * 1.4, 0.0) + t, 3));
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.04;

  // Misregistration: each plate is nudged and turned a hair.
  float rot = 0.011;
  mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
  vec2 off = vec2(2.6, -1.8) * u_dpr / u_res.y;
  vec2 pA = R * (p - vec2(aspect * 0.5, 0.5)) + vec2(aspect * 0.5, 0.5);
  vec2 pB = R * (p + off - vec2(aspect * 0.5, 0.5)) + vec2(aspect * 0.5, 0.5);

  // Plate A: the sun and the near hill. Plate B: the far ridge and its haze.
  float sun = 1.0 - smoothstep(0.105, 0.112, length(pA - vec2(aspect * 0.72, 0.66)));
  float near = 1.0 - smoothstep(-0.004, 0.004, hill(pA, 0.22, 0.05, 2.6, t));
  float far = 1.0 - smoothstep(-0.004, 0.004, hill(pB * vec2(1.0, 1.0), 0.34, 0.04, 1.7, t * 0.7));
  float halo = 1.0 - smoothstep(0.11, 0.30, length(pB - vec2(aspect * 0.72, 0.66)));

  // A coarse dot screen, as a two-colour press would lay it down, plus ink grain.
  vec2 sg = fract(p * 46.0) - 0.5;
  float screen = smoothstep(0.46, 0.30, length(sg));
  float screen2 = smoothstep(0.46, 0.30, length(fract(p * 54.0 + 0.37) - 0.5));
  float grainA = (0.80 + 0.20 * screen) * (0.92 + 0.08 * sfbm(pA * 26.0, 3));
  float grainB = (0.80 + 0.20 * screen2) * (0.92 + 0.08 * sfbm(pB * 30.0, 3));
  float inkA = clamp(max(sun, near) * grainA, 0.0, 1.0) * 0.88;
  float inkB = clamp(max(far * 0.75, halo * 0.35 * (1.0 - sun)) * grainB, 0.0, 1.0) * 0.80;

  vec3 col = paperTone(c_ivory, c_sepia, frag);
  col = mixOk(col, c_accent, inkA);
  col = mixOk(col, c_cyan, inkB);
  // Where the two plates overlap, the inks multiply into a third, darker tone.
  col = mixOk(col, c_plum, min(inkA, inkB) * 0.40);
  col = mixOk(col, c_poppy, max(0.0, inkA - inkB) * 0.25);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  cloth: {
    name: "Book cloth",
    note: "A plain weave: warm warp, mineral weft, slub in the thread, light raked across it.",
    colors: ["ivory", "sepia", "clay", "cyan", "ochre", "accent"],
    dpr: 1.5,
    frag: NOISE + GRADIENT + PAPER + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.03;
  float pitch = 0.019;

  // Slub: the thread wanders, as real cloth does.
  float slubX = 0.10 * sfbm(vec2(p.y * 5.0, p.x * 0.5), 3);
  float slubY = 0.10 * sfbm(vec2(p.x * 5.0, p.y * 0.5) + 7.0, 3);
  float ux = fract(p.x / pitch + slubX);
  float uy = fract(p.y / pitch + slubY);

  // Plain weave: the warp rides over where the cell parity is even.
  float over = mod(floor(p.x / pitch) + floor(p.y / pitch), 2.0);

  // Rounded thread cross-section, shaded by a light from the upper right.
  vec2 n2 = mix(vec2(2.0 * uy - 1.0, 0.30), vec2(0.30, 2.0 * ux - 1.0), over);
  vec3 n = normalize(vec3(n2, 0.85));
  float lit = max(dot(n, normalize(vec3(0.55, 0.42, 0.72))), 0.0);

  vec3 col = paperTone(c_ivory, c_sepia, frag);
  vec3 thread = mixOk(c_cyan, c_clay, over);
  col = mixOk(col, thread, 0.62 + 0.20 * lit);
  col = mixOk(col, c_ivory, pow(lit, 6.0) * 0.30);
  col = mixOk(col, c_ochre, 0.10 * sfbm(p * 3.0, 3));

  // A fold across the bolt, so it reads as cloth and not a pattern.
  float fold = sfbm(p * vec2(1.1, 0.7) + 2.0, 3);
  col = mixOk(col, c_sepia, smoothstep(0.35, 0.85, fold) * 0.24);
  col = mixOk(col, c_ivory, smoothstep(0.42, 0.05, fold) * 0.16);

  // A slow rake of light crossing the bolt.
  float sweep = pow(max(0.0, 1.0 - abs(fract(dot(p, vec2(0.7, 0.5)) * 0.5 - t * 0.06) - 0.5) * 2.0), 3.0);
  col = mixOk(col, c_accent, sweep * 0.18);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  dapple: {
    name: "Leaf light",
    note: "Sun through moving foliage: warm pools of light, cut by leaf shadow.",
    colors: ["deep", "plum", "cyan", "accent", "hi", "ivory"],
    dpr: 1,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.06;

  // Two canopies drifting against each other: one broad and soft, one crisp.
  vec2 sway = vec2(0.09 * sin(t * 0.5), 0.05 * sin(t * 0.7 + 1.3));
  float broad = 0.5 + 0.5 * sfbm((p + sway) * 1.15, 4);
  vec2 c1 = worley((p - sway * 1.3) * 4.6 + 0.45 * (warp(p * 0.8, t, 1.2) - 0.5), 0.0);
  float leaf = 1.0 - smoothstep(0.04, 0.26, c1.x);            // leaf bodies

  // The light survives as pools, and the near leaves cut across them.
  float light = smoothstep(0.28, 0.88, broad + 0.22 * sfbm((p - sway) * 3.2, 3));
  light *= 1.0 - leaf * 0.65;

  vec3 col = mixOk(c_deep, c_plum, 0.30 + 0.25 * broad);
  col = mixOk(col, c_cyan, (1.0 - light) * 0.26 + leaf * 0.12);
  col = mixOk(col, c_accent, light * 0.70);
  col = mixOk(col, c_hi, light * light * 0.45);
  col = mixOk(col, c_ivory, pow(light, 7.0) * 0.30);
  o = vec4(deband(col, frag), 1.0);
}`,
  },
  frost: {
    name: "Frost on glass",
    note: "Crystal ferns creeping in from the cold edges of a pane, warm light behind.",
    colors: ["deep", "cyan", "ivory", "plum", "accent", "hi"],
    dpr: 1.25,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.03;

  // A cold pane with the room's warm light behind it, low on the right.
  vec3 col = mixOk(c_deep, c_cyan, 0.18 + 0.30 * smoothstep(0.95, 0.05, p.y));
  vec2 s = p - vec2(aspect * 0.92, 0.08);
  col = mixOk(col, c_accent, exp(-dot(s, s) * 3.2) * 0.60);
  col = mixOk(col, c_hi, exp(-dot(s, s) * 9.0) * 0.35);

  // Crystal: ridged noise, sharpened, grown in from the pane's edges.
  vec2 q = p * 4.2;
  float n = ridged(q + 0.55 * vec2(sfbm(q * 1.1 + t, 3), sfbm(q * 1.1 + 5.0 - t, 3)), 4);
  float edge = max(max(1.0 - p.y * 2.4, 1.0 - (aspect - p.x) * 2.0), 1.0 - p.x * 1.4);
  edge = smoothstep(0.05, 0.75, edge + 0.25 * sfbm(p * 2.0, 2));
  float frost = smoothstep(0.60, 0.88, n) * edge;
  float veins = smoothstep(0.66, 0.72, n) * (1.0 - smoothstep(0.78, 0.92, n)) * edge;

  col = mixOk(col, c_cyan, frost * 0.55);
  col = mixOk(col, c_hi, pow(frost, 3.0) * 0.55);
  col = mixOk(col, c_ivory, veins * 0.35);
  col = mixOk(col, c_plum, pow(frost, 2.0) * (1.0 - frost) * 0.25);
  o = vec4(deband(col, frag), 1.0);
}`,
  },
  glaze: {
    name: "Celadon glaze",
    note: "A cracked ceramic glaze: two scales of crackle, pooled edges, iron speckles, one sweep of sheen.",
    colors: ["ivory", "cyan", "sepia", "accent", "poppy", "kraft"],
    dpr: 1.25,
    frag: NOISE + GRADIENT + PAPER + `
// Crackle: the bisector distance between Voronoi cells, which breaks more evenly than f2 - f1.
float crackle(vec2 p, float t, float w) {
  vec2 c = worley(p, t);
  return 1.0 - smoothstep(w, w + 2.0 * fwidth(c.y - c.x), c.y - c.x);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.02;

  // The glaze: celadon with a soft drift of thickness.
  float dr = sfbm(p * 1.3 + t, 3);
  vec3 col = mixOk(c_ivory, c_cyan, 0.55 + 0.30 * dr);
  col = mixOk(col, c_kraft, 0.10 * smoothstep(0.4, 0.9, dr));

  // Two scales of crackle, the fine one only where the glaze is thin.
  float big = crackle((p + 0.2 * (dr - 0.5)) * 7.0, 0.0, 0.030);
  float fine = crackle(p * 21.0 + 17.0, 0.0, 0.018) * smoothstep(0.35, 0.75, dr);
  float cr = clamp(big + fine * 0.7, 0.0, 1.0);

  // Glaze pools bright beside each crack, and the crack itself bites dark.
  col = mixOk(col, c_ivory, big * 0.55 + fine * 0.25);
  col = mixOk(col, c_sepia, cr * 0.85);

  // Iron speckles in the clay, and one sweep of sheen across the whole pot.
  vec2 sc = floor(frag / (2.6 * u_dpr));
  float sp = step(0.9965, hash(sc)) * (0.5 + 0.5 * hash(sc + 5.0));
  col = mixOk(col, mixOk(c_accent, c_poppy, hash(sc + 9.0)), sp * 0.9);
  float sheen = pow(max(0.0, 1.0 - abs(fract(dot(p, vec2(0.75, 0.55)) * 0.55 + 0.15) - 0.5) * 2.0), 5.0);
  col = mixOk(col, c_ivory, sheen * 0.22);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  iris: {
    name: "Thin film",
    note: "An oil slick: the interference bands kept to the palette, thinning towards the edges.",
    colors: ["deep", "plum", "cyan", "accent", "poppy", "hi"],
    dpr: 1,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.05;

  // Film thickness: a slow swirl, thinning towards the frame edge.
  float w = warp(p * 1.2 + vec2(0.0, t * 0.5), t, 1.8);
  vec2 q = p - vec2(aspect * 0.5, 0.5);
  float thick = 1.6 + 4.4 * w - 0.8 * smoothstep(0.35, 1.05, length(q / vec2(aspect, 1.0)) * 1.4);

  // The band: one interference term, mapped onto the palette rather than a rainbow.
  float band = 0.5 + 0.5 * cos(6.2831 * (thick - t * 0.30));
  vec3 film = ramp5(c_deep, c_plum, c_cyan, c_hi, c_accent, smoothstep(0.05, 0.95, band));
  film = mixOk(film, c_poppy, smoothstep(0.55, 1.0, band) * 0.35);

  vec3 col = mixOk(c_deep, c_plum, 0.28 * smoothstep(0.3, 0.9, w));
  col = mixOk(col, film, 0.62);
  // A few bright glints where the surface tilts into the light.
  float glint = pow(max(0.0, 1.0 - abs(fract(w * 7.0 - t * 0.5) - 0.5) * 2.0), 12.0);
  col += c_hi * glint * 0.30;
  o = vec4(deband(col, frag), 1.0);
}`,
  },
  solstice: {
    name: "Solstice",
    note: "A low sun over water: indigo to clay in the sky, the reflection broken into dashes.",
    colors: ["deep", "cyan", "plum", "accent", "hi", "poppy"],
    dpr: 1,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.03;

  float horizon = 0.36 + 0.008 * sin(t);
  float sunX = aspect * 0.68;
  vec2 s = vec2(p.x - sunX, (p.y - horizon) * 1.30);
  float sr = length(s);

  vec3 col;
  if (p.y > horizon) {
    // Sky: warm at the horizon, indigo overhead, stratus bars across it.
    float up = smoothstep(horizon, 1.0, p.y);
    col = ramp4(c_hi, c_accent, c_cyan, c_deep, pow(up, 0.85));
    col = mixOk(col, c_plum, 0.18 * smoothstep(0.35, 0.95, up));
    float bars = sfbm(vec2(p.x * 1.2 - t, p.y * 15.0), 4);
    col = mixOk(col, c_deep, smoothstep(0.42, 0.80, bars) * up * 0.45);
    col = mixOk(col, c_hi, exp(-sr * 2.0) * 0.55);
    float disc = 1.0 - smoothstep(0.112, 0.124, sr);
    col = mixOk(col, mixOk(c_accent, c_hi, 0.35), disc * 0.95);
  } else {
    // Water: the sky reflected, darker, with the sun's path broken into dashes.
    float dn = smoothstep(horizon, 0.0, p.y);
    col = ramp4(c_hi, c_accent, c_cyan, c_deep, 0.25 + 0.75 * dn);
    float dash = smoothstep(0.46, 0.86, sfbm(vec2(p.x * 9.0, p.y * 46.0 - t * 2.2), 3));
    float path = exp(-pow((p.x - sunX) * 3.0, 2.0)) * smoothstep(0.75, 0.05, dn);
    col = mixOk(col, c_hi, dash * path * 0.85);
    col = mixOk(col, c_cyan, smoothstep(0.3, 1.0, dn) * 0.20);
  }
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  columnar: {
    name: "Columnar basalt",
    note: "Hexagonal columns cooling toward a vanishing point: warm faces, mineral shadow, ink joints.",
    colors: ["deep", "cyan", "ink", "accent", "ochre", "poppy"],
    dpr: 1.25,
    frag: NOISE + GRADIENT + `
// Nearest hexagon: its local offset and the distance to its edge.
vec2 hexEdge(vec2 p, out vec2 gv) {
  vec2 h = vec2(1.0, 1.7320508);
  vec2 a = mod(p, h) - h * 0.5;
  vec2 b = mod(p - h * 0.5, h) - h * 0.5;
  gv = dot(a, a) < dot(b, b) ? a : b;
  vec2 q = abs(gv);
  return vec2(max(q.x - 0.50, q.y * 0.8660 + q.x * 0.5 - 0.8660), 0.0);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.02;

  // A flat hex grid, lit from the right: warm faces, cool flanks, inked joints.
  vec2 q = (p - vec2(aspect * 0.5, 0.5)) * 3.6 + 0.35 * sfbm(p * 1.1, 2);
  vec2 gv;
  vec2 ed = hexEdge(q, gv);
  float joint = 1.0 - smoothstep(0.02, 0.02 + 2.0 * fwidth(ed.x), ed.x);
  float cellH = hash(floor(q) + 0.5);
  float tilt = clamp(gv.x * 2.6, -1.0, 1.0);
  float lit = clamp(0.55 + 0.45 * tilt, 0.0, 1.0);
  float vert = clamp(gv.y * 2.6, -1.0, 1.0);

  vec3 col = mixOk(c_deep, c_cyan, 0.30 + 0.35 * (1.0 - lit) + 0.18 * cellH);
  col = mixOk(col, c_ochre, pow(lit, 1.8) * 0.85);
  col = mixOk(col, c_accent, pow(lit, 5.0) * 0.40);
  col = mixOk(col, c_poppy, pow(lit, 11.0) * 0.22);
  // Each column is deepest at its foot.
  col = mixOk(col, c_deep, smoothstep(0.10, -0.50, vert) * 0.28);
  // Cooling breaks across the columns, and the joints between them.
  float br = abs(fract(q.y * 0.5 + 0.6 * hash(vec2(floor(q.x) * 0.37, 1.0))) - 0.5) * 2.0;
  col = mixOk(col, c_ink, (1.0 - smoothstep(0.03, 0.03 + 2.0 * fwidth(br), br)) * 0.45);
  col = mixOk(col, c_ink, joint * 0.90);
  // A soft floor light so the field reads as receding.
  col = mixOk(col, c_deep, smoothstep(0.50, 1.0, p.y) * 0.30);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  papercut: {
    name: "Paper cut",
    note: "A landscape cut from five sheets, each casting a shadow on the one behind it.",
    colors: ["ivory", "sepia", "deep", "cyan", "plum", "ochre", "accent"],
    dpr: 1.25,
    frag: NOISE + GRADIENT + PAPER + `
// The cut edge of a layer: a wandering ridge line.
float ridge(vec2 p, float base, float amp, float freq, float seed, float t) {
  return base + amp * sin(p.x * freq + seed) + 0.02 * sfbm(vec2(p.x * 2.0 + seed, seed) + t * 0.05, 3);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.05;
  float px = u_dpr / u_res.y;

  vec3 col = mixOk(c_ivory, c_deep, 0.55 + 0.35 * smoothstep(0.9, 0.3, p.y));
  // A stippled sun in the far sheet.
  float sun = 1.0 - smoothstep(0.085, 0.10, length(p - vec2(aspect * 0.70, 0.80)));
  col = mixOk(col, c_accent, sun * 0.85);

  // Five sheets, far to near: each covers everything below its cut edge.
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float base = 0.62 - 0.105 * fi;
    float amp = 0.030 + 0.012 * fi;
    float r = ridge(p, base, amp, 1.3 + 0.5 * fi, fi * 3.7, t * (0.6 + 0.2 * fi));
    // Shadow cast on the sheet behind, just above the cut.
    col = mixOk(col, c_sepia, (1.0 - smoothstep(-0.01, 0.045, p.y - r)) * smoothstep(-0.02, 0.02, p.y - r) * 0.35);
    vec3 sheet = fi < 1.0 ? c_plum : (fi < 2.0 ? c_cyan : (fi < 3.0 ? c_deep : (fi < 4.0 ? c_ochre : c_accent)));
    float cover = 1.0 - smoothstep(r - px, r + px, p.y);
    col = mixOk(col, sheet, cover * (0.72 + 0.10 * fi));
  }
  // The paper itself.
  col *= 0.94 + 0.06 * noise(frag * 1.6 / u_dpr);
  col = mixOk(col, c_ivory, 0.06 * sfbm(p * 4.0, 3));
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  isobars: {
    name: "Isobars",
    note: "A weather chart: warm highs and mineral lows, contoured, with the wind arrows drawn by hand.",
    colors: ["ivory", "sepia", "accent", "cyan", "plum", "ochre"],
    dpr: 1.5,
    frag: NOISE + GRADIENT + PAPER + `
float pressure(vec2 p, float t) {
  float f = 0.0;
  f += 1.25 * exp(-dot(p - vec2(0.55 * 1.7 + 0.05 * sin(t * 0.2), 0.72), p - vec2(0.55 * 1.7 + 0.05 * sin(t * 0.2), 0.72)) * 4.0);
  f -= 1.35 * exp(-dot(p - vec2(0.30 * 1.7, 0.30 + 0.04 * cos(t * 0.18)), p - vec2(0.30 * 1.7, 0.30 + 0.04 * cos(t * 0.18))) * 4.5);
  f += 0.55 * exp(-dot(p - vec2(1.45, 0.42), p - vec2(1.45, 0.42)) * 9.0);
  f -= 0.35 * exp(-dot(p - vec2(0.95, 0.95), p - vec2(0.95, 0.95)) * 12.0);
  return f;
}
// An anti-aliased line at every integer of v, heavier every fifth (the index line).
float contour(float v) {
  float fr = fract(v);
  float d = min(fr, 1.0 - fr);          // 0 on the line, 0.5 between lines
  float aa = fwidth(v) * 1.2;
  return 1.0 - smoothstep(aa, aa * 2.5, d);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.02;

  float f = pressure(p * vec2(1.0 / 1.7, 1.0) * 1.7, t) + 0.03 * sfbm(p * 3.0, 3);

  // Warm highs, cool lows, and a light tint between the contours.
  vec3 col = paperTone(c_ivory, c_sepia, frag);
  col = mixOk(col, c_accent, smoothstep(0.35, 1.05, f) * 0.30);
  col = mixOk(col, c_ochre, smoothstep(0.1, 0.6, f) * 0.12);
  col = mixOk(col, c_cyan, smoothstep(-0.25, -0.95, f) * 0.28);
  col = mixOk(col, c_plum, smoothstep(-0.6, -1.2, f) * 0.14);

  float v = f * 5.0;
  col = mixOk(col, c_sepia, contour(v) * 0.45);
  col = mixOk(col, c_sepia, contour(v / 5.0) * 0.55);

  // Graticule.
  float gx = abs(fract(p.x / (aspect * 0.25)) - 0.5) * 2.0;
  float gy = abs(fract(p.y / 0.25) - 0.5) * 2.0;
  col = mixOk(col, c_sepia, (1.0 - smoothstep(0.97, 1.0, gx)) * 0.10);
  col = mixOk(col, c_sepia, (1.0 - smoothstep(0.97, 1.0, gy)) * 0.10);

  // Wind arrows: along the isobars, drawn with a wobble like a hand would.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 a = vec2(0.35 + 0.42 * fi, 0.25 + 0.22 * sin(fi * 2.3 + t * 0.3));
    if (i >= 1) a = vec2(0.45 + 0.36 * fi, 0.78 - 0.16 * fi + 0.05 * sin(fi + t * 0.25));
    vec2 rel = p - a;
    float ang = 2.1 + 0.35 * sin(fi * 3.1 + dot(p, vec2(1.0)) + t * 0.2);
    vec2 dir = vec2(cos(ang), sin(ang));
    float alongRaw = dot(rel, dir);
    float along = clamp(alongRaw, -0.075, 0.075);
    float across = abs(dot(rel, vec2(-dir.y, dir.x)));
    float wob = 0.012 * sin(along * 90.0 + fi * 4.0);
    float within = 1.0 - smoothstep(0.072, 0.080, abs(alongRaw));
    float shaft = (1.0 - smoothstep(0.0035, 0.0035 + fwidth(across) * 1.5, abs(across - wob))) * within;
    // Head: two barbs at the far end.
    vec2 tip = a + dir * 0.075;
    float h = 0.0;
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      vec2 hd = normalize(dir * 1.0 + vec2(cos(2.5 + 1.1 * fk), sin(2.5 + 1.1 * fk)) * 0.55);
      float hlRaw = dot(p - tip, hd);
      float ha = abs(dot(p - tip, vec2(-hd.y, hd.x)));
      h = max(h, (1.0 - smoothstep(0.0035, 0.0035 + fwidth(ha) * 1.5, ha)) * (1.0 - smoothstep(0.030, 0.036, abs(hlRaw))));
    }
    col = mixOk(col, c_sepia, clamp(shaft + h, 0.0, 1.0) * 0.65);
  }
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  reef: {
    name: "Reef",
    note: "A reaction-diffusion colony in colour: clay bodies, a mineral leading edge, plum in the deep.",
    colors: ["deep", "cyan", "plum", "accent", "poppy", "hi"],
    dpr: 1.25,
    sim: {
      scale: 2.5,
      steps: 8,
      // Mostly substance A, with scattered seeds of B so growth starts everywhere.
      seed(w, h) {
        const d = new Float32Array(w * h * 2);
        for (let i = 0; i < w * h; i++) d[i * 2] = 1;
        const spots = Math.max(10, Math.round((w * h) / 2600));
        for (let s = 0; s < spots; s++) {
          const cx = Math.random() * w, cy = Math.random() * h, r = 2 + Math.random() * 3;
          for (let y = Math.floor(cy - r); y <= cy + r; y++)
            for (let x = Math.floor(cx - r); x <= cx + r; x++) {
              if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
              const i = (((y + h) % h) * w + ((x + w) % w)) * 2;
              d[i] = 0.5; d[i + 1] = 1;
            }
        }
        return d;
      },
      // Gray-Scott tuned towards worms and mazes, with the feed drifting across
      // the plate so thick colonies and thin veins both appear.
      frag: `
uniform sampler2D u_state;
vec2 at(vec2 uv, vec2 px, float x, float y) { return texture(u_state, uv + px * vec2(x, y)).rg; }
void main() {
  vec2 px = 1.0 / u_res;
  vec2 uv = gl_FragCoord.xy * px;
  vec2 s = at(uv, px, 0.0, 0.0);
  vec2 lap = -s
    + 0.2 * (at(uv, px, 1.0, 0.0) + at(uv, px, -1.0, 0.0) + at(uv, px, 0.0, 1.0) + at(uv, px, 0.0, -1.0))
    + 0.05 * (at(uv, px, 1.0, 1.0) + at(uv, px, -1.0, 1.0) + at(uv, px, 1.0, -1.0) + at(uv, px, -1.0, -1.0));
  float a = s.r, b = s.g, abb = a * b * b;
  float F = 0.0430 + 0.008 * noise(uv * 2.2);
  float K = 0.0635;
  a += 1.0 * lap.r - abb + F * (1.0 - a);
  b += 0.5 * lap.g + abb - (K + F) * b;
  if (length(gl_FragCoord.xy - u_mouse) < 4.0) b = 0.9;
  o = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), 0.0, 1.0);
}`,
    },
    frag: NOISE + GRADIENT + `
uniform sampler2D u_state;
uniform vec2 u_simres;
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  vec2 px = 1.0 / u_simres;
  float b = texture(u_state, uv).g;
  float bx = texture(u_state, uv + vec2(px.x, 0.0)).g - texture(u_state, uv - vec2(px.x, 0.0)).g;
  float by = texture(u_state, uv + vec2(0.0, px.y)).g - texture(u_state, uv - vec2(0.0, px.y)).g;
  vec3 n = normalize(vec3(-bx, -by, 0.16));
  float light = dot(n, normalize(vec3(-0.42, 0.55, 0.72)));

  float body = smoothstep(0.13, 0.26, b);
  vec3 col = mixOk(c_deep, c_plum, smoothstep(0.0, 0.13, b) * 0.8);
  // The thin leading edge is the complementary colour, so growth reads as a rim.
  col = mixOk(col, c_cyan, smoothstep(0.02, 0.11, b) * (1.0 - body) * 0.85);
  col = mixOk(col, mixOk(c_accent, c_hi, 0.30 + 0.45 * light), body * (0.55 + 0.45 * light));
  col = mixOk(col, c_poppy, smoothstep(0.55, 0.95, b) * 0.30);
  col = mixOk(col, c_hi, pow(max(light, 0.0), 10.0) * body * 0.45);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  ripple: {
    name: "Rain rings",
    note: "Rings spreading and crossing on dark water, warm crests on a mineral sheet.",
    colors: ["deep", "cyan", "plum", "accent", "hi", "poppy"],
    dpr: 1,
    frag: NOISE + GRADIENT + `
// One drop: an expanding ring train that fades as it travels.
float ring(vec2 p, vec2 c, float age) {
  float r = length(p - c);
  float front = age * 0.34;
  float phase = (r - front) * 62.0;
  float damp = exp(-max(r - front, 0.0) * 7.0) * exp(-age * 0.55);
  return sin(phase) * damp * smoothstep(front, front - 0.05, r);
}
float waterH(vec2 p, float t) {
  float h = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = vec2(1.72 * (0.14 + 0.72 * hash(vec2(fi, 3.1))), 0.12 + 0.76 * hash(vec2(fi, 7.7)));
    float period = 3.4 + 2.6 * hash(vec2(fi, 1.3));
    float age = mod(t * 0.30 + hash(vec2(fi, 9.9)) * period, period);
    h += ring(p, c, age);
  }
  return h * 0.5 + 0.10 * sfbm(p * 2.2 + t * 0.05, 2);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time;
  float e = 0.004;

  float h = waterH(p, t);
  vec3 n = normalize(vec3(-(waterH(p + vec2(e, 0.0), t) - h) / e, -(waterH(p + vec2(0.0, e), t) - h) / e, 2.2));

  vec3 col = mixOk(c_deep, c_cyan, 0.30 + 0.25 * smoothstep(-0.3, 0.5, h));
  col = mixOk(col, c_plum, smoothstep(0.1, 0.7, p.y) * 0.22);
  float spec = pow(max(dot(n, normalize(vec3(0.35, 0.45, 0.82))), 0.0), 24.0);
  col = mixOk(col, c_hi, spec * 0.85);
  col = mixOk(col, c_accent, smoothstep(0.15, 0.7, h) * 0.35);
  col = mixOk(col, c_poppy, smoothstep(0.45, 0.95, h) * 0.20);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  pollen: {
    name: "Pollen drift",
    note: "Slow motes and out-of-focus pollen crossing a field that cools as it recedes.",
    colors: ["deep", "plum", "cyan", "ochre", "accent", "hi"],
    dpr: 1.25,
    frag: NOISE + GRADIENT + PARTICLES + BOKEH + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time;

  // Deep ground, one warm bloom low right, cooling and lifting towards the top.
  vec3 col = mixOk(c_deep, c_plum, 0.30 * smoothstep(0.05, 1.0, p.y));
  col = mixOk(col, c_cyan, 0.30 * smoothstep(0.35, 1.05, p.y));
  vec2 s = p - vec2(aspect * 0.74, 0.10);
  col = mixOk(col, c_accent, exp(-dot(s, s) * 2.6) * 0.60);
  col = mixOk(col, c_ochre, exp(-dot(s, s) * 6.0) * 0.30);
  col = mixOk(col, c_ochre, 0.08 * sfbm(p * 1.4 + t * 0.02, 3));

  // Three depths of pollen: far bokeh, mid motes, a few near grains.
  col += c_ochre * bokeh(frag + 41.0, 78.0, t * 0.7, 7.0) * 0.30;
  col += c_hi * bokeh(frag, 52.0, t, 1.0) * 0.35;
  col += c_accent * motes(frag, 13.0, 0.03, t, 0.28) * 0.50;
  col += c_hi * motes(frag + 71.0, 7.0, 0.06, t, 0.14) * 0.30;
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  crackle: {
    name: "Salt flat",
    note: "A dried pan: raised plates, mineral in the cracks, a crust of salt catching the light.",
    colors: ["kraft", "ochre", "accent", "deep", "cyan", "ivory"],
    dpr: 1.25,
    frag: NOISE + GRADIENT + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.02;
  float e = 0.004;

  // Two scales of cells: the pan cracks, then the crust cracks finer.
  vec2 c1 = worley(p * 6.0 + 0.3 * sfbm(p * 1.2, 2), 0.0);
  vec2 c2 = worley(p * 15.0 + 17.0, 0.0);
  float cr1 = smoothstep(0.05, 0.0, c1.y - c1.x);
  float cr2 = smoothstep(0.035, 0.0, c2.y - c2.x) * 0.7;

  // Plate tone from the cell it belongs to, plus a domed relief per plate.
  vec2 id = floor(p * 6.0);
  float h = hash(id) * 0.6 + 0.2 * hash(id + 13.0);
  vec2 cen = (id + 0.5) / 6.0;
  float dome = 1.0 - smoothstep(0.05, 0.12, length(p - cen));
  float lip = smoothstep(0.02, 0.0, c1.y - c1.x) * (1.0 - smoothstep(0.05, 0.08, c1.y - c1.x));

  vec3 col = mixOk(c_kraft, c_ochre, 0.35 + 0.5 * h);
  col = mixOk(col, c_accent, smoothstep(0.6, 1.0, h) * 0.35);
  col = mixOk(col, c_ivory, dome * 0.35);
  col = mixOk(col, c_deep, cr1 * 0.75);
  col = mixOk(col, c_cyan, cr2 * (1.0 - cr1) * 0.55);
  col = mixOk(col, c_deep, smoothstep(0.35, 0.9, cr2) * (1.0 - cr1) * 0.20);
  col = mixOk(col, c_ivory, lip * 0.35);

  // Salt bloom and grit.
  float salt = smoothstep(0.55, 0.85, sfbm(p * 7.0 + 3.0, 3));
  col = mixOk(col, c_ivory, salt * 0.30 * (1.0 - cr1));
  col *= 0.94 + 0.06 * noise(frag * 2.2 / u_dpr);
  o = vec4(deband(col, frag), 1.0);
}`,
  },

  woodcut: {
    name: "Woodcut sea",
    note: "A knife-cut sea: ink waves with white foam lines and one plate of spot colour.",
    colors: ["ivory", "sepia", "accent", "deep", "plum", "hi"],
    dpr: 1.5,
    frag: NOISE + GRADIENT + PAPER + `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time * 0.04;
  float px = u_dpr / u_res.y;

  vec3 col = paperTone(c_ivory, c_sepia, frag);

  // A spot-colour sun, cut as a disc with a ring around it.
  vec2 s = p - vec2(aspect * 0.72, 0.74);
  float sr = length(s);
  col = mixOk(col, c_accent, 1.0 - smoothstep(0.10, 0.104, sr));
  col = mixOk(col, c_sepia, (1.0 - smoothstep(0.128, 0.132, abs(sr - 0.145))) * 0.8);

  // Three crests of sea, cut as flat ink masses with a white foam line on top.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float base = 0.44 - 0.13 * fi;
    float crest = base + 0.055 * sin(p.x * (2.1 + 0.5 * fi) + fi * 2.4 + 0.25 * sin(t * 0.4 + fi));
    crest += 0.02 * sfbm(vec2(p.x * 3.0 + fi * 5.0, fi), 3);
    // The cut: everything below the crest is ink, with a lifted foam edge.
    float ink = 1.0 - smoothstep(crest - 1.5 * px, crest + 1.5 * px, p.y);
    vec3 tone = fi < 1.0 ? c_accent : (fi < 2.0 ? c_plum : c_deep);
    col = mixOk(col, tone, ink * (0.85 - 0.15 * fi));
    col = mixOk(col, c_ivory, (1.0 - smoothstep(1.0 * px, 2.6 * px, abs(p.y - crest))) * 0.55);

    // Knife strokes inside the mass: parallel cuts that thin as the sea flattens.
    float hatchv = (p.y - crest) * 42.0 + 0.4 * sin(p.x * 9.0 + fi);
    float hatch = abs(fract(hatchv) - 0.5) * 2.0;
    float inside = smoothstep(crest - 0.02, crest - 0.06, p.y) * ink;
    col = mixOk(col, c_ivory, (1.0 - smoothstep(0.42, 0.72, hatch)) * inside * (0.30 - 0.08 * fi));
  }
  o = vec4(deband(col, frag), 1.0);
}`,
  },
};
