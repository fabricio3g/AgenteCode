import { mountTiles } from "./js/tiles.js?v=20";
import { initTheme, initSegmented, initCopy, initReveal, initScroll } from "./js/ui.js?v=20";

initTheme();
initSegmented();
initCopy();
initReveal();
initScroll();

// The tile field the terminal's welcome card floats on, glowing up from the product shot.
const tiles = document.getElementById("hero-tiles");
if (tiles) mountTiles(tiles, { focus: [0.7, 0.85] });

// The browser chrome follows the page theme.
const themeColor = document.querySelector('meta[name="theme-color"]');
const syncChrome = () => themeColor?.setAttribute("content", document.documentElement.dataset.theme === "light" ? "#ffffff" : "#1c1c1c");
document.addEventListener("themechange", syncChrome);
syncChrome();

// "Install the CLI" lands on the install section with the CLI tab open.
document.querySelectorAll("[data-install]").forEach((link) => {
  link.addEventListener("click", () => document.getElementById(`g-${link.dataset.install}`)?.click());
});
