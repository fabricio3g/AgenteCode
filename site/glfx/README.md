# glfx

A small WebGL2 engine for animated backgrounds. Each effect is one fragment shader that draws the whole canvas, with theme colours passed in as uniforms. There's no build step and no dependencies: just ES modules.

WebGL2 runs in about 97% of browsers, including Firefox, Safari and Linux Chrome, where WebGPU often has no GPU adapter.

```
glfx/
  glfx.js       engine: context, render loop, resize, pointer, pause, simulations
  noise.js      NOISE: simplex, fractal, ridged, domain warp, Worley, curl
  gradient.js   GRADIENT: Oklab mixing, ramps, linear/radial/conic, mesh, cosine palettes
  chunks.js     helpers used by the bundled effects (paper, hatching, rays, motes, bokeh...)
  effects.js    FX: the bundled effects
```

Live gallery: `site/lab/shaders.html` (Palette button swaps Agente colours for Claude's).
Compile check for every effect: `site/lab/diag.html`; a handful at a time, labelled:
`site/lab/fxcheck.html?fx=ember,reef,papercut`. Ideas and rules: `IDEAS.md`.

## 1. Mount an effect

```html
<div class="hero">
  <canvas id="bg"></canvas>
  <h1>A workbench is more than a chat.</h1>
</div>
```

```css
.hero { position: relative; isolation: isolate; }
.hero canvas { position: absolute; inset: 0; width: 100%; height: 100%; z-index: -1; }
```

```js
import { mountGL } from "./glfx/glfx.js";
import { FX } from "./glfx/effects.js";

const palette = {
  bg: "#161616", accent: "#e8793a", hi: "#ffbe98", faint: "#3a2418", ink: "#ececec",
  paper: "#15130f", sepia: "#e6dbc4", sea: "#1f5560", abyss: "#08161a", kelp: "#4f6b3a", ochre: "#c98a3c",
};

const fx = mountGL(document.getElementById("bg"), FX.sea, palette);
if (!fx) {
  // No WebGL2 (or no float render targets for a simulation): show a fallback.
}
```

The canvas sizes itself from its CSS box. Give it a size and the engine handles the rest.

### Controller

| Method | What it does |
|---|---|
| `setColors(palette)` | Swap colours (for example on a theme toggle). Nothing recompiles. |
| `pause()` / `resume()` | Stop or restart the render loop. |
| `destroy()` | Stop and release the WebGL context. Call this when the element leaves the page. |

### What the engine does for you

- **Resolution:** drawing-buffer size is CSS size × `devicePixelRatio`, capped by the effect's `dpr`.
- **Visibility:** pauses when the canvas is scrolled off screen or the tab is hidden.
- **Reduced motion:** with `prefers-reduced-motion`, draws one still frame and never animates. Simulations are stepped ahead first so the still frame isn't the empty seed.
- **Pointer:** tracked on `window`, so content layered over the canvas doesn't block it.

> **Context budget.** Browsers allow about 16 live WebGL contexts per page and silently drop the oldest. Keep a page to 2–3 effects, and `destroy()` any you unmount. The lab mounts only the cards near the viewport for this reason.

## 2. Write an effect

An effect is a plain object:

```js
export const myEffect = {
  name: "Tide lines",                       // label, for galleries
  note: "One-line description.",
  colors: ["paper", "sea", "accent"],       // palette keys this shader reads
  dpr: 1.5,                                 // max pixel ratio (lower = cheaper)
  frag: `
void main() {
  vec2 p = gl_FragCoord.xy / u_res.y;       // height-normalised coords
  float v = fbm(p * 3.0 + u_time * 0.05);
  o = vec4(mix(c_paper, c_sea, v), 1.0);
}`,
};
```

`frag` is the body of a GLSL ES 3.00 fragment shader. The engine adds `#version`, precision, the uniforms and the core helpers above it, and adds one `uniform vec3 c_<name>;` for each entry in `colors`. Write the result to `o`.

### Available in every shader

| Name | Type | Meaning |
|---|---|---|
| `u_res` | `vec2` | drawing-buffer size in device px |
| `u_time` | `float` | seconds since mount |
| `u_mouse` | `vec2` | pointer in device px, y up; far off-screen (`< -1e4`) when absent |
| `u_dpr` | `float` | the pixel ratio actually used; multiply px sizes by it |
| `c_<name>` | `vec3` | each palette colour you listed, sRGB 0..1 |
| `hash(vec2)` | `float` | white noise 0..1 |
| `noise(vec2)` | `float` | value noise 0..1 (quintic smoothing) |
| `fbm(vec2)` | `float` | 5-octave value noise, about 0.2..0.8 |
| `deband(vec3 col, vec2 frag)` | `vec3` | ±1/255 triangular dither; use it on any smooth gradient |

### Conventions that keep effects consistent

- **Coordinates:** use `gl_FragCoord.xy / u_res.y` so circles stay round at any aspect ratio. Use `frag / u_res` when you want 0..1 across both axes.
- **Pixel sizes:** write line widths and dot sizes in CSS px × `u_dpr`, so they look the same on every screen.
- **Anti-aliasing:** draw edges with `smoothstep` over `fwidth(...)` instead of `step`.
- **Banding:** end with `o = vec4(deband(col, gl_FragCoord.xy), 1.0);`.
- **Cursor:** treat `u_mouse.x < -1e4` as "no pointer" and fade any cursor influence with `exp(-d*d*k)`.
- **Composition:** keep the subject off the text column. The hero copy is left-aligned, so put the interest at `x ≈ 0.65–0.75`.

### Include libraries

Concatenate the GLSL strings you need in front of your code:

```js
import { NOISE } from "./noise.js";
import { GRADIENT } from "./gradient.js";

frag: NOISE + GRADIENT + `void main() { ... }`
```

## 3. Noise (`noise.js`)

| Function | Range | Use for |
|---|---|---|
| `simplex(vec2 p)` | -1..1 | smooth, non-grid noise |
| `sfbm(vec2 p, int octaves)` | about -1..1 | fractal simplex (clouds, terrain) |
| `ridged(vec2 p, int octaves)` | 0..1 | sharp crests: mountains, wave tops, veins |
| `warp(vec2 p, float t, float amount)` | 0..1 | domain warp, the organic swirl behind most flow looks |
| `worley(vec2 p, float t)` | `vec2(f1, f2)` | cells. `f2 - f1` is small on walls and `f1` is small at centres |
| `curl(vec2 p)` | `vec2` | divergence-free flow direction for advecting lines or particles |

Recipes:

```glsl
// Marble / smoke
float v = warp(p * 2.0, u_time * 0.02, 2.0);

// Cell walls, anti-aliased
vec2 w = worley(p * 8.0, u_time * 0.2);
float wall = 1.0 - smoothstep(0.03, 0.03 + fwidth(w.y - w.x), w.y - w.x);

// Contour lines of any field h
float lv = h * 20.0;
float line = 1.0 - smoothstep(0.5 * u_dpr, 1.2 * u_dpr, abs(fract(lv - 0.5) - 0.5) / fwidth(lv));

// Animate by moving through the field, not by scaling it
float n = sfbm(p * 3.0 + vec2(u_time * 0.05, 0.0), 4);
```

## 4. Gradients (`gradient.js`)

Mixing happens in **Oklab**, so orange → teal stays saturated instead of going muddy through grey.

| Function | Use for |
|---|---|
| `mixOk(a, b, t)` | perceptual mix of two colours |
| `ramp3/4/5(c0, …, t)` | evenly spaced multi-stop ramps |
| `linearT(p, from, to)` | t along a line |
| `radialT(p, centre, radius)` | t outward from a point |
| `conicT(p, centre, turn)` | t around a point |
| `meshAdd(acc, p, point, color, softness)` + `meshColor(acc)` | soft mesh gradient from N moving points |
| `cosinePalette(t, a, b, c, d)` | a whole palette from four vec3s |
| `toOklab` / `fromOklab` | raw conversions |

Recipes:

```glsl
// Linear gradient, top-left to bottom-right, through three palette colours
float t = linearT(p, vec2(0.0, 1.0), vec2(u_res.x / u_res.y, 0.0));
vec3 col = ramp3(c_bg, c_sea, c_accent, t);

// Noise-driven gradient: any scalar field can index a ramp
vec3 col = ramp4(c_abyss, c_sea, c_accent, c_hi, smoothstep(0.3, 0.8, warp(p * 1.5, u_time * 0.03, 2.0)));

// Mesh gradient (see FX.gradient for the animated version)
vec4 acc = vec4(0.0);
meshAdd(acc, p, vec2(0.3, 0.7), c_bg, 2.2);
meshAdd(acc, p, vec2(1.2, 0.3), c_accent, 2.2);
vec3 col = meshColor(acc);
```

Higher `softness` in `meshAdd` gives tighter colour pools; around 2 is soft.

## 5. Simulations

For stateful effects (reaction-diffusion, trails, fluid), add `sim`. The engine keeps two RG16F textures and runs `steps` passes per frame before drawing. This needs `EXT_color_buffer_float`; without it `mountGL` returns `null`.

```js
sim: {
  scale: 2.5,                  // sim texel = 2.5 drawing-buffer px
  steps: 10,                   // passes per frame
  seed(w, h) { return new Float32Array(w * h * 2); },   // RG initial state
  frag: `
uniform sampler2D u_state;     // previous state; u_res is the sim size here
void main() {
  vec2 s = texture(u_state, gl_FragCoord.xy / u_res).rg;
  o = vec4(s, 0.0, 1.0);       // next state in .rg
}`,
},
// then read it in the main frag:
frag: `uniform sampler2D u_state; uniform vec2 u_simres; void main() { ... }`,
```

Inside the sim pass, `u_mouse` is in sim texels. See `FX.coral` for a full Gray-Scott example.

## 6. Performance

- Lower `dpr` for soft scenes (`0.75` for the ray-marched sea and the mesh gradient). Keep `1.5–2` for line art.
- Loops must have constant bounds. Break out early with `if (i >= n) break;`.
- `fbm` costs 5 noise samples. A domain warp is 3 `fbm`s, so about 15. Budget about 100 noise samples per pixel for a full-screen effect.
- Measure in the real page with the pane or tab visible: background tabs are throttled.

## 7. Bundled effects

`Object.keys(FX)` lists them. They're grouped in the lab as:

- **Library:** `gradient`, `noisefield` (worked examples of the two libraries)
- **Plates:** `sea`, `nautilus`, `radiolarian`, `medusa`, `ink`, `relief`, `sunflower`, `currents`, `abyss`,
  `strata`, `dune`, `frost`, `columnar`, `crackle`
- **Ocean:** `surface`, `kelp`, `swell`, `tidepool`, `sonar`, `tide`, `solstice`, `ripple`
- **Nature:** `coral`, `watercolour`, `cells`, `filings`, `meadow`, `cirrus`, `mycelium`, `dapple`,
  `reef`, `pollen`
- **Old book:** `chart`, `botanical`, `spiral`, `mezzotint`, `atlas`, `stipple`, `marbling`, `riso`,
  `isobars`, `woodcut`
- **Abstract:** `dither`, `mesh`, `godrays`, `aurora`, `dots`, `ascii`, `ember`, `corona`, `cloth`,
  `glaze`, `iris`, `papercut`

Each lists the palette keys it needs in `colors`. Pass a palette that has all of them — a key
you leave out keeps its default rather than throwing.

### Palette keys

The first group is the original naturalist ramp; the second is the warm-paper group and the
complementary group added with the landing redesign. Keys are roles, not values: each keeps
its hue and flips lightness with the theme.

| key | role |
|---|---|
| `bg`, `ink`, `faint` | the page, its ink, its faintest wash |
| `paper`, `sepia` | a printed sheet and its ink |
| `sea`, `abyss`, `kelp`, `ochre` | ocean and field tones |
| `accent`, `hi` | the brand tint and its highlight |
| `ivory`, `clay`, `kraft`, `sage` | warm paper, clay tint, kraft and olive (Anthropic-adjacent) |
| `deep`, `cyan`, `plum`, `poppy` | the complementary group: deep ground, cyan, blue-violet, hot neighbour |

`site/lab/shaders.js` holds two complete palettes — Agente and Claude — and the lab's
**Palette** button swaps between them without recompiling anything. `glfx/IDEAS.md` has the
design rationale, the colour rules and the effets still to build.
