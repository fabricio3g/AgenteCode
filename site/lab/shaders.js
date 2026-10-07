// Shader lab: every candidate is a glfx (WebGL2) effect reading the theme's
// palette as uniforms, so a theme toggle only swaps colours.
import { mountGL, hasWebGL2 } from "../glfx/glfx.js?v=14";
import { FX } from "../glfx/effects.js?v=14";
import { mountTiles } from "../js/tiles.js?v=14";
import { paletteFor } from "../glfx/palettes.js?v=14";
import { initTheme } from "../js/ui.js?v=14";

initTheme();

const root = document.documentElement;

const palette = () => paletteFor(root.dataset.palette, root.dataset.theme);

const CANDIDATES = [
  { set: "Library", fx: "gradient", use: "Hero · footer" },
  { set: "Library", fx: "noisefield", use: "Footer" },
  { set: "Plates", fx: "sea", use: "Hero" },
  { set: "Plates", fx: "nautilus", use: "Hero" },
  { set: "Plates", fx: "radiolarian", use: "Hero · bots" },
  { set: "Plates", fx: "medusa", use: "Hero · bots" },
  { set: "Plates", fx: "ink", use: "Hero" },
  { set: "Plates", fx: "relief", use: "Hero · get started" },
  { set: "Plates", fx: "sunflower", use: "Bots" },
  { set: "Plates", fx: "currents", use: "Server · footer" },
  { set: "Plates", fx: "abyss", use: "Footer" },
  { set: "Ocean", fx: "surface", use: "Hero · footer" },
  { set: "Ocean", fx: "kelp", use: "Bots · footer" },
  { set: "Ocean", fx: "swell", use: "Hero" },
  { set: "Ocean", fx: "tidepool", use: "Get started" },
  { set: "Ocean", fx: "sonar", use: "Server panel" },
  { set: "Nature", fx: "coral", use: "Hero · bots" },
  { set: "Nature", fx: "watercolour", use: "Hero · footer" },
  { set: "Nature", fx: "cells", use: "Principles" },
  { set: "Nature", fx: "filings", use: "Bots · interactive" },
  { set: "Old book", fx: "chart", use: "Hero · get started" },
  { set: "Old book", fx: "botanical", use: "Bots" },
  { set: "Old book", fx: "spiral", use: "Hero" },
  { set: "Old book", fx: "mezzotint", use: "Footer" },
  { set: "Old book", fx: "atlas", use: "Hero · footer" },
  { set: "Abstract", fx: "dither", use: "Hero" },
  { set: "Abstract", fx: "mesh", use: "Hero · footer" },
  { set: "Abstract", fx: "godrays", use: "Hero" },
  { set: "Abstract", fx: "aurora", use: "Get started · footer" },
  { set: "Abstract", fx: "dots", use: "Bots · principles" },
  { set: "Abstract", fx: "ascii", use: "Code panel" },
  // Warm nature studies: ivory paper, ink partings and clay used as a tint.
  { set: "Plates", fx: "strata", use: "Hero · footer" },
  { set: "Nature", fx: "meadow", use: "Bots · footer" },
  { set: "Nature", fx: "cirrus", use: "Hero · get started" },
  { set: "Old book", fx: "stipple", use: "Hero · principles" },
  // Complementary fields: orange against cyan, indigo and plum, on deep ground.
  { set: "Abstract", fx: "ember", use: "Hero" },
  { set: "Ocean", fx: "tide", use: "Hero · footer" },
  { set: "Abstract", fx: "corona", use: "Hero · get started" },
  { set: "Plates", fx: "dune", use: "Footer · principles" },
  { set: "Nature", fx: "mycelium", use: "Bots · server" },
  { set: "Old book", fx: "marbling", use: "Hero · footer" },
  { set: "Old book", fx: "riso", use: "Get started · footer" },
  { set: "Abstract", fx: "cloth", use: "Bots · footer" },
  { set: "Nature", fx: "dapple", use: "Bots · principles" },
  { set: "Plates", fx: "frost", use: "Hero · get started" },
  { set: "Abstract", fx: "glaze", use: "Hero · footer" },
  { set: "Abstract", fx: "iris", use: "Hero" },
  { set: "Ocean", fx: "solstice", use: "Hero · footer" },
  { set: "Plates", fx: "columnar", use: "Get started · server" },
  { set: "Abstract", fx: "papercut", use: "Hero · bots" },
  { set: "Old book", fx: "isobars", use: "Server · principles" },
  { set: "Ocean", fx: "ripple", use: "Hero · footer" },
  { set: "Nature", fx: "reef", use: "Hero · bots" },
  { set: "Nature", fx: "pollen", use: "Footer · bots" },
  { set: "Plates", fx: "crackle", use: "Get started · footer" },
  { set: "Old book", fx: "woodcut", use: "Hero · principles" },
];

const grid = document.getElementById("grid");
const notice = document.getElementById("notice");
const tpl = document.getElementById("card-tpl");
const webgl2 = hasWebGL2();
const live = []; // { cand, node, status, inst }
let paused = false;

if (!webgl2) {
  notice.hidden = false;
  notice.textContent = "This browser has no WebGL2, so every card shows the tile-field fallback.";
}

// Mount on a fresh canvas (a canvas keeps whichever context it first had),
// falling back to the tile field when WebGL2 is missing.
function mountInto(host, cand, report) {
  const canvas = document.createElement("canvas");
  host.querySelector("canvas").replaceWith(canvas);
  const t0 = performance.now();
  const inst = webgl2 ? mountGL(canvas, FX[cand.fx], palette()) : null;
  if (inst) { report?.(`${Math.round(performance.now() - t0)} ms`, false); return inst; }
  mountTiles(canvas, { focus: [0.5, 0.8] });
  report?.("tile fallback", true);
  return null;
}

function setStatus(entry, text, err) { entry.status.textContent = text; entry.status.classList.toggle("err", err); }
function mount(entry) {
  entry.inst = mountInto(entry.node.querySelector(".stagebox"), entry.cand, (t, err) => setStatus(entry, t, err));
  if (paused) entry.inst?.pause();
}
function unmount(entry) { entry.inst?.destroy(); entry.inst = null; setStatus(entry, "idle", false); }

// Browsers cap live WebGL contexts (~16), so only cards near the viewport hold one.
const near = new IntersectionObserver((items) => {
  for (const it of items) {
    const entry = live.find((e) => e.node === it.target);
    if (it.isIntersecting && !entry.inst) mount(entry);
    else if (!it.isIntersecting && entry.inst) unmount(entry);
  }
}, { rootMargin: "200px 0px" });

for (const cand of CANDIDATES) {
  const fx = FX[cand.fx];
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector(".meta b").textContent = fx.name;
  node.querySelector(".meta span").textContent = fx.note;
  node.querySelector(".meta code").textContent = `${cand.set} · ${cand.use}`;
  const entry = { cand, node, status: node.querySelector(".status"), inst: null };
  node.querySelector(".preview").addEventListener("click", () => openFull(cand));
  grid.append(node);
  live.push(entry);
  near.observe(node);
}

// Set filter.
const filter = document.getElementById("sets");
for (const name of ["All", ...new Set(CANDIDATES.map((c) => c.set))]) {
  const b = document.createElement("button");
  b.className = "ui-btn ui-btn-ghost ui-btn-sm";
  b.type = "button";
  b.textContent = name;
  b.setAttribute("aria-pressed", String(name === "All"));
  b.addEventListener("click", () => {
    for (const x of filter.children) x.setAttribute("aria-pressed", String(x === b));
    for (const e of live) e.node.hidden = name !== "All" && e.cand.set !== name;
  });
  filter.append(b);
}

// Theme toggle: new colour uniforms, no rebuild.
new MutationObserver(() => {
  for (const e of live) e.inst?.setColors(palette());
  fullInst?.setColors(palette());
}).observe(root, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });

// Palette toggle: the same effects in Agente's graphite-orange or in Claude's
// warm neutrals. Colours only, nothing recompiles.
const palBtn = document.getElementById("palette");
function paintPalette() { document.getElementById("palette-label").textContent = root.dataset.palette === "claude" ? "Claude" : "Agente"; }
palBtn.addEventListener("click", () => {
  root.dataset.palette = root.dataset.palette === "claude" ? "agente" : "claude";
  try { localStorage.setItem("agente-palette", root.dataset.palette); } catch (e) {}
  paintPalette();
});
paintPalette();

document.getElementById("pause").addEventListener("click", (ev) => {
  paused = !paused;
  ev.currentTarget.setAttribute("aria-pressed", String(paused));
  ev.currentTarget.lastChild.textContent = paused ? "Resume all" : "Pause all";
  for (const e of live) paused ? e.inst?.pause() : e.inst?.resume();
});

// Fullscreen hero preview.
const full = document.getElementById("full");
let fullInst = null;
function openFull(cand) {
  full.classList.add("open");
  fullInst?.destroy();
  fullInst = mountInto(full, cand);
}
function closeFull() { full.classList.remove("open"); fullInst?.destroy(); fullInst = null; }
document.getElementById("full-close").addEventListener("click", closeFull);
addEventListener("keydown", (e) => { if (e.key === "Escape") closeFull(); });
