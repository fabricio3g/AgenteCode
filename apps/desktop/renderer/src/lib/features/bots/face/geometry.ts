// Hand-drawn avatar geometry: deterministic noise, the shape vocabulary and
// the paths every face is built from. Pure functions of their inputs — a bot
// must always look like itself. Ported from the Agente bots showcase
// (github.com/fabricio3g/webshowcase).

export type Point = [number, number];

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Two decimals: enough for a 100-unit viewBox, short attribute strings. */
export const f2 = (v: number) => (Math.round(v * 100) / 100).toString();

// ── deterministic noise ────────────────────────────────────────────────

function hash2(i: number, j: number, s: number): number {
  const h = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

function valueNoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smoothstep(x - xi), yf = smoothstep(y - yi);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
}

function fbm(x: number, y: number, s: number, oct: number): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * valueNoise(x * freq, y * freq, s + i * 17.13);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Sampled on a circle so the wobble closes seamlessly. */
function loopNoise(a: number, s: number, freq: number): number {
  return fbm(Math.cos(a) * freq, Math.sin(a) * freq, s, 3) - 0.5;
}

/** FNV-seeded mulberry-style generator: the same text, the same sequence. */
export function seededRandom(text: string): () => number {
  let h = 2166136261;
  for (const char of text) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let v = Math.imul(h ^ (h >>> 15), 1 | h);
    v ^= v + Math.imul(v ^ (v >>> 7), 61 | v);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

// ── geometry: a 100×100 viewBox, the head resting on an implied floor ──

export const CX = 50, CY = 49, R = 36.5, FLOOR = 90, PIVOT = 88;

function bezierSegment(p0: Point, p1: Point, p2: Point, p3: Point): string {
  return 'C' + f2(p1[0] + (p2[0] - p0[0]) / 6) + ',' + f2(p1[1] + (p2[1] - p0[1]) / 6)
    + ' ' + f2(p2[0] - (p3[0] - p1[0]) / 6) + ',' + f2(p2[1] - (p3[1] - p1[1]) / 6)
    + ' ' + f2(p2[0]) + ',' + f2(p2[1]);
}

export function closedBezier(pts: Point[]): string {
  const n = pts.length;
  let d = 'M' + f2(pts[0][0]) + ',' + f2(pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i];
    const p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += bezierSegment(p0, p1, p2, p3);
  }
  return d + 'Z';
}

function openBezier(pts: Point[]): string {
  const n = pts.length;
  let d = 'M' + f2(pts[0][0]) + ',' + f2(pts[0][1]);
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i];
    const p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    d += bezierSegment(p0, p1, p2, p3);
  }
  return d;
}

// ── shape vocabulary: polar radius functions, so morphing is a lerp ────

export type ShapeName =
  | 'circle' | 'squircle' | 'triangle' | 'flower' | 'cloud' | 'blob'
  | 'drop' | 'pebble' | 'spiky' | 'egg' | 'wide';

const SHAPE_FN: Record<ShapeName, (a: number) => number> = {
  circle: () => 1,
  squircle: (a) => Math.pow(Math.pow(Math.abs(Math.cos(a)), 3.2) + Math.pow(Math.abs(Math.sin(a)), 3.2), -1 / 3.2),
  triangle: (a) => 0.58 + 0.42 * Math.pow(Math.abs(Math.cos(1.5 * (a + Math.PI / 2))), 3.0),
  flower: (a) => 0.97 + 0.11 * Math.cos(6 * a + 0.4),
  cloud: (a) => 0.99 + 0.10 * Math.cos(5 * a + 0.9) + 0.035 * Math.cos(3 * a),
  blob: (a) => 0.99 + 0.11 * Math.cos(3 * a + 1.7) + 0.05 * Math.cos(2 * a),
  drop: (a) => 0.90 + 0.17 * Math.sin(a) + 0.04 * Math.cos(2 * a),
  pebble: (a) => 0.99 + 0.07 * Math.cos(2 * a + 0.6) + 0.03 * Math.cos(4 * a + 2.1),
  spiky: (a) => 0.86 + 0.30 * Math.pow(Math.abs(Math.cos(5 * a)), 1.5),
  egg: (a) => 0.94 + 0.12 * Math.sin(a),
  wide: (a) => 0.94 + 0.16 * Math.abs(Math.cos(a))
};

/** Every shape normalised to the same mean radius: a morph never changes size. */
const SHAPE_NORM = Object.fromEntries(
  (Object.keys(SHAPE_FN) as ShapeName[]).map((name) => {
    const K = 96;
    let sum = 0;
    for (let i = 0; i < K; i++) sum += SHAPE_FN[name]((i / K) * Math.PI * 2);
    return [name, K / sum];
  })
) as Record<ShapeName, number>;

function shapeR(shape: ShapeName, morphTo: ShapeName | null, k: number, a: number): number {
  const ra = SHAPE_FN[shape](a) * SHAPE_NORM[shape];
  if (!k || !morphTo) return ra;
  return ra + (SHAPE_FN[morphTo](a) * SHAPE_NORM[morphTo] - ra) * k;
}

export interface Form {
  lobes: number;
  depth: number;
  bulge: number;
  phase: number;
}

/**
 * The outline for the current pose. Squash, stretch and morph all happen in
 * the radius domain, which keeps the ink weight constant and never resizes
 * the eyes. `points` trades smoothness for cost on small avatars.
 */
export function contourPoints(
  seed: number, variant: number, radius: number, amp: number, ax: number, ay: number,
  shape: ShapeName, morphTo: ShapeName | null, mk: number, sqx: number, sqy: number,
  form: Form, points: number
): Point[] {
  const pts: Point[] = [];
  const lean = (seed % 13) * 0.48;
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2 - Math.PI / 2;
    const character = 1 + form.depth * Math.cos(form.lobes * a + form.phase) + form.bulge * Math.sin(a + form.phase);
    const r = radius * shapeR(shape, morphTo, mk, a) * character
      * (1 + loopNoise(a, seed + variant * 7.31, 1.35) * 2 * amp + Math.cos(a + lean) * 0.02);
    pts.push([CX + Math.cos(a) * r * ax * sqx, CY + Math.sin(a) * r * ay * sqy]);
  }
  return pts;
}

/** Perimeter without getTotalLength (no layout reads). */
export function polyLen(pts: Point[]): number {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    L += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return L * 1.02;
}

/**
 * A variable-width ink line, drawn as a filled ribbon between an outer and
 * an inner contour. It swells on the side turned away from the light, which
 * is how a drawn line implies a turning form.
 */
export function ribbonPath(pts: Point[], lightAngle: number, base: number): string {
  const n = pts.length, outer: Point[] = [], inner: Point[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n], r = pts[(i - 1 + n) % n];
    let tx = q[0] - r[0], ty = q[1] - r[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    let nx = -ty, ny = tx;
    const a = Math.atan2(p[1] - CY, p[0] - CX);
    if (nx * Math.cos(a) + ny * Math.sin(a) < 0) { nx = -nx; ny = -ny; }
    const away = 0.5 + 0.5 * Math.cos(a - (lightAngle + Math.PI));
    const w = base * (0.30 + 1.15 * Math.pow(away, 0.75));
    outer.push([p[0] + nx * w, p[1] + ny * w]);
    inner.push([p[0] - nx * w, p[1] - ny * w]);
  }
  return closedBezier(outer) + closedBezier(inner.slice().reverse());
}

/** An open arc of the contour facing the light: the rim light. */
export function rimPath(pts: Point[], lightAngle: number, spread: number): string {
  const n = pts.length;
  const idx = (a: number) => Math.round((((a + Math.PI / 2) % (Math.PI * 2)) / (Math.PI * 2)) * n);
  let i0 = idx(lightAngle - spread), i1 = idx(lightAngle + spread);
  while (i1 <= i0) i1 += n;
  const out: Point[] = [];
  for (let i = i0; i <= i1; i++) out.push(pts[((i % n) + n) % n]);
  return openBezier(out);
}

/** A hand-drawn eye around its own origin. */
export function eyePath(rx: number, ry: number, seed: number, rot: number): string {
  const N = 16, pts: Point[] = [];
  const c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const w = 1 + loopNoise(a, seed, 2.4) * 0.24;
    const x = Math.cos(a) * rx * w, y = Math.sin(a) * ry * w;
    pts.push([x * c - y * s, x * s + y * c]);
  }
  return closedBezier(pts);
}

/** A happy closed eye: an upward arc with a shaky hand. */
export function arcPath(w: number, h: number, seed: number): string {
  const j = (k: number) => loopNoise(k * 2.7, seed, 2.1) * 2;
  return 'M' + f2(-w) + ',' + f2(h * 0.35 + j(1))
    + 'C' + f2(-w * 0.5) + ',' + f2(-h + j(2))
    + ' ' + f2(w * 0.5) + ',' + f2(-h + j(3))
    + ' ' + f2(w) + ',' + f2(h * 0.35 + j(4));
}

/** Little ink doodles for particles and accessories. */
export const DOODLES = {
  spark: 'M0,-5.4 L1.5,-1.5 L5.4,0 L1.5,1.5 L0,5.4 L-1.5,1.5 L-5.4,0 L-1.5,-1.5 Z',
  star: 'M0,-5.8 L1.8,-1.8 L6,0 L1.8,1.8 L0,5.8 L-1.8,1.8 L-6,0 L-1.8,-1.8 Z',
  heart: 'M0,4.2 C-5.6,-0.4 -5.2,-5  -1.9,-5 C-0.6,-5 0,-3.4 0,-3.4 C0,-3.4 0.6,-5 1.9,-5 C5.2,-5 5.6,-0.4 0,4.2 Z',
  z: 'M-3.4,-4 L3.4,-4 L-3.4,4 L3.4,4',
  drop: 'M0,-5.2 C3.4,-1 4.6,1 4.6,2.6 A4.6,4.6 0 0 1 -4.6,2.6 C-4.6,1 -3.4,-1 0,-5.2 Z'
} as const;

export type Doodle = keyof typeof DOODLES;
