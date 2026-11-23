import { bootFolio } from "./js/folio-fx.js?v=21";
import { mountSupernova } from "./js/supernova-bg.js?v=21";

bootFolio({ defaultTheme: "light" });

mountSupernova(document.getElementById("bg-horizon"), {
  mode: "wash",
  focus: [0.50, 0.30],
  strength: 0.72,
});

mountSupernova(document.getElementById("bg-cta"), {
  mode: "supernova",
  focus: [0.50, 0.50],
  strength: 0.55,
});

document.querySelectorAll("[data-install]").forEach((link) => {
  link.addEventListener("click", () => {
    document.getElementById(`g-${link.dataset.install}`)?.click();
  });
});
