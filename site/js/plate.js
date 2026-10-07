// The landing backdrop: a rotation of plates from the lab, crossfading on a
// full-window canvas every so often; the caption under the copy shows the next one on click.
// Same effect objects and palette module as the lab, so a theme change only
// swaps colour uniforms — nothing recompiles. Each plate mounts on a fresh
// canvas and the old context is destroyed once the fade ends, so the page never
// holds more than two. If WebGL2 is missing, or no shader will build, the tile
// field takes over and the caption goes away.

import { mountGL, hasWebGL2 } from "../glfx/glfx.js?v=14";
import { FX } from "../glfx/effects.js?v=14";
import { paletteFor } from "../glfx/palettes.js?v=14";
import { mountTiles } from "./tiles.js?v=14";

const PLATES = ["eclipse", "dune", "riso", "papercut", "currents", "gradient", "noisefield", "mycelium", "ember", "dither"];
const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const EVERY = 14000;
const FADE = 900;

const root = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const palette = () => paletteFor("agente", root.dataset.theme);

export function mountPlate(canvas, button) {
  if (!canvas) return null;
  const template = canvas.cloneNode(false);
  const number = button?.querySelector("[data-plate-no]");
  const name = button?.querySelector("[data-plate-name]");
  let current = { canvas, ctrl: null };
  let index = -1;

  // Mount plate `i` on a fresh canvas over the current one, skipping any that
  // will not build. Returns false when none would.
  function show(i) {
    for (let tries = 0; tries < PLATES.length; tries++) {
      const at = (i + tries) % PLATES.length;
      const fresh = template.cloneNode(false);
      current.canvas.after(fresh);
      const ctrl = hasWebGL2() ? mountGL(fresh, FX[PLATES[at]], palette()) : null;
      if (!ctrl) { fresh.remove(); continue; }

      const old = current;
      current = { canvas: fresh, ctrl };
      index = at;
      requestAnimationFrame(() => fresh.classList.add("ready"));
      old.canvas.classList.remove("ready");
      setTimeout(() => { old.ctrl?.destroy(); old.canvas.remove(); }, old.ctrl ? FADE : 0);
      if (number) number.textContent = NUMERALS[at];
      if (name) name.textContent = FX[PLATES[at]].name;
      return true;
    }
    return false;
  }

  if (!show(0)) {
    // A canvas keeps whichever context it was first handed, so the fallback
    // needs a new element rather than one a failed mount touched.
    const fresh = template.cloneNode(false);
    fresh.classList.replace("plate", "tiles");
    current.canvas.replaceWith(fresh);
    mountTiles(fresh, { focus: [0.5, 0.8] });
    if (button) button.hidden = true;
    return null;
  }

  // Advance on a timer while the plate is on screen; a click moves on at once
  // and restarts the wait. Reduced motion keeps the plate until it is clicked.
  let timer = 0, visible = true;
  const arm = () => {
    clearTimeout(timer);
    if (reduceMotion.matches || !visible || document.hidden) return;
    timer = setTimeout(() => { show(index + 1); arm(); }, EVERY);
  };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; arm(); }).observe(button?.closest("section") || canvas);
  document.addEventListener("visibilitychange", arm);
  button?.addEventListener("click", () => { show(index + 1); arm(); });
  document.addEventListener("themechange", () => current.ctrl?.setColors(palette()));
  arm();
  return current;
}
