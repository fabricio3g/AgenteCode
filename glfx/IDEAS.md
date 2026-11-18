# Backdrop ideas

The design brief behind the shader lab: **a landing page that reads as a naturalist's
workbench** — warm paper, one hand-applied tint, calm motion — with the colour pushed
one step further, so each backdrop pairs the brand's orange with its complements
(cyan, indigo, plum) instead of another shade of orange.

Two palettes drive everything (see `site/lab/shaders.js`):

| | Agente | Claude |
|---|---|---|
| paper | `#f4eee2` / `#15130f` | ivory `#FAF9F5` / slate `#1A1918` |
| tint | `#e76d1f` / `#e8793a` | clay `#D97757` |
| complement | `sea #2f6f7a`, `cyan #0f8ea3` | sky `#6A9BCC`, cloud `#C5D3E0` |
| split | `plum #6a4fc4`, `kelp #5f7d43` | plum `#827DBD`, mineral `#629987` |
| warm mid | `ochre #b97a2c`, `kraft #b98a5a` | kraft `#D4A27F`, matcha/olive |

Roles, not values: a key keeps its hue and flips its lightness between themes, so the
same shader reads as a print on ivory in light mode and as a lit plate on graphite in
dark mode. Every neutral in the Claude palette is warm (R > G > B); there is no pure
grey, no pure black, no pure white.

## Shipped in this pass

Complementary fields (orange against cyan / indigo / plum, deep grounds):

| effect | look | technique |
|---|---|---|
| `ember` | molten bloom on indigo, cyan-rimmed | domain-warped bloom + rim mask + sparks |
| `tide` | two crossing wave trains, crests cyan, troughs orange | `sin(a)·sin(b)` interference + slow amplitude drift |
| `corona` | irregular rayed disc, frayed tips | per-index ray hashes, stipple-frayed tips |
| `dune` | wind ripples, warm crests, mineral shadows | analytic height field, lit by two-tone lambert |
| `mycelium` | fungal web, warm spore nodes | 3 warped Worley wall scales + growth front |
| `reef` | reaction-diffusion colony in colour | Gray-Scott ping-pong + emboss lighting |
| `ripple` | rain rings crossing on dark water | ring trains with per-drop age + specular |
| `pollen` | motes and bokeh on a cooling field | hashed cells, three depth layers |
| `glaze` | celadon crackle, iron speckles | two crackle scales + pooling highlight + sheen |
| `iris` | oil-slick interference bands | thickness field → palette ramp (no rainbow) |
| `solstice` | low sun, dashes of reflection | banded sky ramp + broken reflection path |
| `columnar` | basalt prisms, lit and shadowed faces | hex grid + per-cell tilt lighting |
| `dapple` | sun through foliage | broad canopy fbm cut by Worley leaf bodies |
| `frost` | crystal ferns from the pane edges | ridged noise grown in from the frame edge |
| `cloth` | book cloth, warp and weft | plain weave, cylinder normals, slub, fold |
| `papercut` | five sheets, each casting a shadow | layered ridges with drop shadows |
| `crackle` | dried pan, salt crust | two Worley crack scales, domed plates |
| `isobars` | weather chart with drawn arrows | gaussian pressure field, contour AA, hand-wobbled arrows |
| `marbling` | suminagashi rings in three inks | combed ring fields, inks kept to their own side |
| `riso` | two plates out of register | offset + rotated shape plates, dot screen, multiply |
| `woodcut` | knife-cut sea, one spot colour | flat ink masses with foam edges and hatch strokes |
| `stipple` | ink dots carry the tone | jittered cell dots, radius ∝ √tone |
| `meadow` | field under a travelling gust | per-blade quads with quadratic bend, sheen band |
| `cirrus` | cloud study, sheared bands | anisotropic fbm for cirrus over stratus |
| `strata` | cut through sedimentary beds | warped band index, ink partings |

## Next (sketched, not built)

Growth and organisms
- **Differential growth** — pearly folding rims. Springs along a curve, repulsion within a radius, insert nodes where curvature is high.
- **Physarum** — transport networks. Agents sense trail at three rotated offsets, deposit, diffuse with a 3×3 mean, decay.
- **Lichen crust** — DLA walkers sticking with probability `p`; lower `p` gives hairier rosettes.
- **Fern frond** — Barnsley IFS, four folds, accumulated as a distance so it anti-aliases.
- **Cloud types** — one noise field, three windowings: cumulus (tight height window, `pow` falloff), stratus (very thin), cirrus (anisotropic, sheared).

Landform
- **Rain on a watershed** — droplet erosion: capacity `c = max(Δh, minSlope)·speed·water`, erode behind the drop, deposit where sediment > capacity.
- **Talus slopes** — thermal erosion: move `k·(h − h_lowest)/2` from any cell steeper than the angle of repose.
- **Braided delta** — `1 − ridged(fbm)` as elevation, then widen the ridge valleys.
- **Salt polygons** — true bisector distance `dot(½(a+b), normalize(b−a))` for uneven, broken cracks.
- **Hamada gravel** — jittered Worley with dark varnish where F1 is smallest.

Water and air
- **Foam lace** — foam where the crest folds (`T.x < 0` from a Gerstner tangent) masked by a Worley ridge.
- **Caustic web** — `pow(abs(sin(a·fbm) + sin(b·fbm)), 8)` on two advected layers, added at 10 % for backgrounds.
- **Crepuscular rays** — radial accumulation, 16 taps at half res, decay ≈ 0.96.
- **Heat shimmer** — single-pass refraction: offset the lookup by `k·noise` scaled by distance from the hot surface.

Print and material
- **Cyanotype** — Prussian blue negative, fibre noise, slight edge bleed; tones invert against a blueprint.
- **Halftone rosettes** — rotated screens (90/105/165°), radius ∝ √tone.
- **Engraving line-weight** — walk lines along a flow field, weight from luminance, taper the ends.
- **Lithograph grain** — bias the threshold by a blurred noise so pigment settles in the low spots.
- **Blueprint annotations** — hand-drawn leader lines and arrows over a technical field (the `isobars` arrows are the first cut of this).
- **Ghost illustration** — a wide-line motif at 0.08–0.12 opacity behind a section, drifting a few pixels.

## Rules that keep these usable

1. **60/30/10.** Paper or deep ground for 60 %, the second colour for 30 %, the tint for
   the last 10 %. A full-bleed clay field is the one thing the reference language avoids.
2. **Interest sits right of the copy.** Subjects live at `x ≈ 0.62–0.80` of the frame.
3. **Slow is the point.** 0.02–0.06 units per second of drift; nothing snaps, nothing bounces.
4. **Pixel sizes are CSS px × `u_dpr`**, edges use `smoothstep` over `fwidth`, and every
   smooth gradient ends in `deband()`.
5. **Budget:** ~100 noise samples per pixel for a full-screen effect; simulations at
   `scale 2.5` and ≤ 10 steps, `dpr 0.75–1.25` for soft fields, 1.5–2 for line art.
6. **Text safety:** keep local contrast low under the headline; the lab's card scrim
   (`radial-gradient` of the page colour at 82 %) is the fallback, not the first resort.
7. **No RGB split, no glitch, no per-pixel film grain on a large field** — grain belongs
   in the paper fibres, at a coarse scale.

## Checking a change

```sh
cd site && python3 -m http.server 4321
# every effect, all at once, ~2 min: mounts, reads a pixel back, reports GL errors
open http://127.0.0.1:4321/lab/diag.html
# a handful of effects, one canvas each, with the palette keys they declare
open 'http://127.0.0.1:4321/lab/fxcheck.html?fx=ember,reef,papercut'
# the gallery, with the palette toggle
open http://127.0.0.1:4321/lab/shaders.html
```

Sources behind the technique list: iquilezles.org (warp, fbm, morenoise, voronoilines),
Karl Sims' reaction-diffusion, mrob.com's Pearson classes, inconvergent (differential
line), Sage Jenson (physarum), Job Talle (hydraulic erosion), Catlike Coding (Gerstner),
GPU Gems 2 ch. 19 (refraction) and GPU Gems 3 ch. 13/16 (god rays, vegetation), the
Book of Shaders ch. 13, Wikipedia (mezzotint, halftone, cyanotype, risograph,
hypsometric tints, ripple marks), Bottosson on Oklab. Brand values from
anthropic.com's production CSS and claude.com's swatch list.
