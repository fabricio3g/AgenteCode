// Shared GLSL snippets used by the bundled effects. Each is a string;
// concatenate the ones an effect needs in front of its own code.

// Shared GLSL: paper tooth and drifting particles.
export const PAPER = `
vec3 paperTone(vec3 paper, vec3 ink, vec2 frag) {
  float grain = hash(floor(frag)) - 0.5;
  float fibre = noise(frag * vec2(0.9, 0.08) / u_dpr) - 0.5;
  return mix(paper, ink, 0.035 * grain + 0.03 * fibre);
}`;

export const PARTICLES = `
// One layer of drifting motes: a hashed point per cell, twinkling.
float motes(vec2 frag, float cellPx, float drift, float t, float density) {
  vec2 p = frag / (cellPx * u_dpr);
  p.y += t * drift;
  vec2 id = floor(p), f = fract(p);
  float r = hash(id);
  if (r > density) return 0.0;
  vec2 c = vec2(hash(id + 1.3), hash(id + 7.1)) * 0.8 + 0.1;
  c.x += 0.12 * sin(t * 0.6 + r * 40.0);
  float d = length(f - c) * cellPx;
  float tw = 0.55 + 0.45 * sin(t * (1.0 + r * 2.0) + r * 60.0);
  return smoothstep(1.6, 0.2, d) * tw;
}`;

export const RAYS = `
// Light shafts fanning down from a point above the top edge.
float rays(vec2 uv, float aspect, float t, float lean) {
  vec2 src = vec2(0.5 + lean + 0.08 * sin(t * 0.05), 1.35);
  vec2 d = uv - src; d.x *= aspect;
  float ang = atan(d.x, -d.y);
  float n = fbm(vec2(ang * 7.0, t * 0.07));
  return smoothstep(0.48, 0.9, n) * smoothstep(-0.1, 1.0, uv.y);
}`;

export const PLATE = `
// A slow, domain-warped greyscale field: the "plate" that print styles read tone from.
float plate(vec2 p, float t) {
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
  return fbm(p + 2.0 * q);
}`;

export const HATCH = `
// Coverage of parallel engraved lines (one per unit of v) whose width grows with tone.
float hatch(float v, float tone) {
  float f = abs(fract(v) - 0.5) * 2.0;
  float aa = fwidth(v) * 2.0;
  return (1.0 - smoothstep(tone - aa, tone + aa, f)) * smoothstep(0.0, 0.05, tone);
}`;

export const BAYER = `
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }`;

export const FRAME = `
// The double rule of a book plate, inset from the canvas edge.
float plateFrame(vec2 frag) {
  vec2 d = min(frag, u_res - frag) / u_dpr;
  float m = min(d.x, d.y);
  return max(1.0 - smoothstep(0.4, 1.3, abs(m - 20.0)), (1.0 - smoothstep(0.2, 0.8, abs(m - 25.0))) * 0.6);
}`;

export const BOKEH = `
// Out-of-focus motes: soft discs with a brighter rim, drifting slowly.
float bokeh(vec2 frag, float cellPx, float t, float seed) {
  vec2 p = frag / (cellPx * u_dpr);
  p.y += t * 0.02;
  p.x += sin(t * 0.05 + seed) * 0.3;
  vec2 id = floor(p), f = fract(p);
  float r = hash(id + seed);
  if (r > 0.35) return 0.0;
  vec2 c = 0.2 + 0.6 * vec2(hash(id + 1.7 + seed), hash(id + 9.1 + seed));
  float d = length(f - c) * cellPx;
  float rad = 5.0 + 14.0 * hash(id + 4.4 + seed);
  float disc = smoothstep(rad, rad - 1.5, d);
  float rim = smoothstep(rad - 3.0, rad - 0.5, d) * disc;
  return (disc * 0.45 + rim * 0.55) * (0.55 + 0.45 * sin(t * 0.5 + r * 40.0));
}`;
