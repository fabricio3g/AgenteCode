import { mountAscii } from "./js/ascii.js";
import { initInstall } from "./js/install.js";
import { initTheme, initSegmented, initCopy, initReveal, initScroll } from "./js/ui.js";

initTheme();
initSegmented();
initInstall();
initCopy();
initReveal();
initScroll();

mountAscii(document.getElementById("ascii-hero"), { interactive: true, focus: [0.5, 0.8] });
mountAscii(document.getElementById("ascii-foot"), { focus: [0.5, 1.15], corner: 0 });
