// Noise library (GLSL). Prepend NOISE to an effect's frag to use these.
// The engine header already provides hash(), noise() (value noise) and fbm().

export const NOISE = `
// Gradient (simplex) noise in 2D, range about -1..1. Smoother and less grid-aligned than value noise.
vec2 grad2(vec2 p) { float a = hash(p) * 6.2831853; return vec2(cos(a), sin(a)); }
float simplex(vec2 p) {
  const float F = 0.3660254, G = 0.2113249;
  vec2 i = floor(p + (p.x + p.y) * F);
  vec2 a = p - i + (i.x + i.y) * G;
  vec2 o = a.x > a.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 b = a - o + G, c = a - 1.0 + 2.0 * G;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h * vec3(dot(a, grad2(i)), dot(b, grad2(i + o)), dot(c, grad2(i + 1.0)));
  return dot(n, vec3(70.0));
}

// Fractal simplex: octaves of simplex(), range about -1..1.
float sfbm(vec2 p, int octaves) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    v += a * simplex(p); p = r * p * 2.02 + 13.0; a *= 0.5;
  }
  return v;
}

// Ridged fractal: sharp crests (mountains, wave tops), range 0..1.
float ridged(vec2 p, int octaves) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(simplex(p));
    v += a * n * n; p = r * p * 2.03 + 7.0; a *= 0.5;
  }
  return v;
}

// Domain warp: fbm fed through itself, the source of most organic flow. Range 0..1.
float warp(vec2 p, float t, float amount) {
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
  return fbm(p + amount * q);
}

// Cellular (Worley) noise: x = distance to nearest cell point, y = second nearest.
// y - x is small on cell walls; x is small at cell centres.
vec2 worley(vec2 p, float t) {
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.4 * sin(t + 6.2831853 * vec2(hash(ip + g), hash(ip + g + 19.19)));
      float d = length(g + o - fp);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  return vec2(f1, f2);
}

// Curl of simplex noise: a divergence-free flow direction, good for advecting particles or lines.
vec2 curl(vec2 p) {
  float e = 0.01;
  float a = simplex(p + vec2(0.0, e)), b = simplex(p - vec2(0.0, e));
  float c = simplex(p + vec2(e, 0.0)), d = simplex(p - vec2(e, 0.0));
  return vec2(a - b, d - c) / (2.0 * e);
}
`;
