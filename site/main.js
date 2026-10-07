import { mountPlate } from "./js/plate.js?v=14";
import { initTeam } from "./js/team.js?v=14";
import { initTheme, initSegmented, initCopy, initReveal, initScroll, initStack } from "./js/ui.js?v=14";

initTheme();
initSegmented();
initCopy();
initReveal();
initScroll();
initStack();
initTeam();

// The rotating plate behind the whole page.
mountPlate(document.getElementById("plate"), document.getElementById("plate-next"));
