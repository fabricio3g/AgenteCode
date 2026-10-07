// Gradient library (GLSL). Prepend GRADIENT to an effect's frag to use these.
// Mixing happens in Oklab, so blends between two colours stay vivid instead
// of passing through grey the way plain RGB mixes do.

export const GRADIENT = `
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

vec3 toOklab(vec3 c) {
  c = toLinear(c);
  vec3 lms = mat3(0.4122214708, 0.2119034982, 0.0883024619,
                  0.5363325363, 0.6806995451, 0.2817188376,
                  0.0514459929, 0.1073969566, 0.6299787005) * c;
  lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
  return mat3(0.2104542553, 1.9779984951, 0.0259040371,
              0.7936177850, -2.4285922050, 0.7827717662,
              -0.0040720468, 0.4505937099, -0.8086757660) * lms;
}
vec3 fromOklab(vec3 L) {
  vec3 lms = mat3(1.0, 1.0, 1.0,
                  0.3963377774, -0.1055613458, -0.0894841775,
                  0.2158037573, -0.0638541728, -1.2914855480) * L;
  lms = lms * lms * lms;
  return toSrgb(mat3(4.0767416621, -1.2684380046, -0.0041960863,
                     -3.3077115913, 2.6097574011, -0.7034186147,
                     0.2309699292, -0.3413193965, 1.7076147010) * lms);
}

// Perceptual mix of two sRGB colours.
vec3 mixOk(vec3 a, vec3 b, float t) { return fromOklab(mix(toOklab(a), toOklab(b), clamp(t, 0.0, 1.0))); }

// Ramps: evenly spaced stops, t in 0..1.
vec3 ramp3(vec3 a, vec3 b, vec3 c, float t) {
  t = clamp(t, 0.0, 1.0) * 2.0;
  return t < 1.0 ? mixOk(a, b, t) : mixOk(b, c, t - 1.0);
}
vec3 ramp4(vec3 a, vec3 b, vec3 c, vec3 d, float t) {
  t = clamp(t, 0.0, 1.0) * 3.0;
  return t < 1.0 ? mixOk(a, b, t) : (t < 2.0 ? mixOk(b, c, t - 1.0) : mixOk(c, d, t - 2.0));
}
vec3 ramp5(vec3 a, vec3 b, vec3 c, vec3 d, vec3 e, float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  if (t < 1.0) return mixOk(a, b, t);
  if (t < 2.0) return mixOk(b, c, t - 1.0);
  if (t < 3.0) return mixOk(c, d, t - 2.0);
  return mixOk(d, e, t - 3.0);
}

// Gradient coordinates, all returning t in 0..1 for a ramp.
// p is in height-normalised units (frag / u_res.y), so shapes stay round.
float linearT(vec2 p, vec2 from, vec2 to) { vec2 d = to - from; return clamp(dot(p - from, d) / dot(d, d), 0.0, 1.0); }
float radialT(vec2 p, vec2 centre, float radius) { return clamp(length(p - centre) / radius, 0.0, 1.0); }
float conicT(vec2 p, vec2 centre, float turn) { return fract(atan(p.y - centre.y, p.x - centre.x) / 6.2831853 + 0.5 + turn); }

// Soft mesh gradient: N drifting colour points blended by inverse-distance weights.
// Call meshAdd() per point, then meshColor() once.
void meshAdd(inout vec4 acc, vec2 p, vec2 point, vec3 color, float softness) {
  float w = 1.0 / pow(length(p - point) + 0.02, softness);
  acc += vec4(toOklab(color) * w, w);
}
vec3 meshColor(vec4 acc) { return fromOklab(acc.rgb / acc.a); }

// Cosine palette (Inigo Quilez): a whole ramp from four vec3s.
vec3 cosinePalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(6.2831853 * (c * t + d)); }
`;
