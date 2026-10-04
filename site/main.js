import { mountTiles } from "./js/tiles.js";
import { initInstall } from "./js/install.js";
import { initTeam } from "./js/team.js";
import { initTheme, initSegmented, initCopy, initReveal, initScroll } from "./js/ui.js";

initTheme();
initSegmented();
initInstall();
initCopy();
initReveal();
initScroll();
initTeam();

mountTiles(document.getElementById("tiles-hero"), { focus: [0.5, 0.7] });
// The footer runs quieter than the hero, and the last strip of its field is
// faded out in CSS so the wordmark and links stay legible over it.
mountTiles(document.getElementById("tiles-foot"), {
  cell: [11, 11], focus: [0.5, 1.24], corner: 0, ember: 0.7, dim: 0.4,
});
