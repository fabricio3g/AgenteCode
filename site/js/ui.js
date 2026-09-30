// Page behaviour: theme (with Desktop's circle reveal), segmented controls,
// copy buttons, scroll reveals, nav + hero scroll state.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const systemLight = matchMedia("(prefers-color-scheme: light)");
const root = document.documentElement;

// ---------- Theme ----------
function storedTheme() {
  try { return localStorage.getItem("agente-theme"); } catch (e) { return null; }
}
function applyTheme(theme) {
  root.dataset.theme = theme;
  document.dispatchEvent(new Event("themechange"));
}
export function initTheme() {
  applyTheme(storedTheme() || (systemLight.matches ? "light" : "dark"));
  systemLight.addEventListener("change", (e) => { if (!storedTheme()) applyTheme(e.matches ? "light" : "dark"); });

  const btn = document.getElementById("theme-toggle");
  btn?.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    try { localStorage.setItem("agente-theme", next); } catch (e) {}
    if (!document.startViewTransition || reduceMotion.matches) return applyTheme(next);
    const b = btn.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(() => applyTheme(next)).ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 420, easing: "cubic-bezier(.16,1,.3,1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  });
}

// ---------- Segmented controls ----------
/** Slide a segmented control's thumb under `button`. */
export function placeThumb(list, button) {
  const thumb = list.querySelector(".seg-thumb");
  if (!thumb || !button) return;
  const inset = parseFloat(getComputedStyle(list).paddingLeft) || 0;
  thumb.style.width = `${button.offsetWidth}px`;
  thumb.style.transform = `translateX(${button.offsetLeft - inset}px)`;
}

// <div class="segmented" role="tablist" data-auto="6000"> buttons[aria-controls] </div>
export function initSegmented() {
  document.querySelectorAll(".segmented[role=tablist]").forEach((list) => {
    const tabs = [...list.querySelectorAll("[role=tab]")];
    const panels = tabs.map((t) => document.getElementById(t.getAttribute("aria-controls")));
    let index = Math.max(0, tabs.findIndex((t) => t.getAttribute("aria-selected") === "true"));

    const moveThumb = () => placeThumb(list, tabs[index]);
    function select(i, focus) {
      index = (i + tabs.length) % tabs.length;
      tabs.forEach((t, j) => {
        const on = j === index;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        panels[j].classList.toggle("is-active", on);
        panels[j].inert = !on;
        panels[j].setAttribute("aria-hidden", String(!on));
      });
      moveThumb();
      if (focus) tabs[index].focus();
    }

    // Auto-advance until the visitor touches the control or its panels.
    const auto = Number(list.dataset.auto || 0);
    let timer = 0, inView = false, stopped = !auto || reduceMotion.matches;
    const stop = () => { stopped = true; clearInterval(timer); list.classList.remove("is-auto"); };
    const arm = () => {
      clearInterval(timer);
      if (stopped || !inView) return list.classList.remove("is-auto");
      list.classList.remove("is-auto");
      void list.offsetWidth; // restart the progress hairline
      list.classList.add("is-auto");
      list.style.setProperty("--auto", `${auto}ms`);
      timer = setInterval(() => { select(index + 1); arm(); }, auto);
    };
    if (auto) {
      new IntersectionObserver(([e]) => { inView = e.isIntersecting; arm(); }, { threshold: 0.4 })
        .observe(panels[0].parentElement);
      [list, panels[0].parentElement].forEach((el) => {
        el.addEventListener("pointerdown", stop);
        el.addEventListener("focusin", stop);
      });
    }

    tabs.forEach((t, i) => {
      t.addEventListener("click", () => { stop(); select(i); });
      t.addEventListener("keydown", (e) => {
        const k = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (k === undefined) return;
        e.preventDefault();
        stop();
        select(k, true);
      });
    });
    new ResizeObserver(moveThumb).observe(list);
    document.fonts?.ready.then(moveThumb);
    select(index);
    list.classList.add("ready");
  });
}

// ---------- Copy ----------
/** Copy `text`, then flash the button's copied state for a moment. */
export async function copyText(btn, text) {
  let ok = true;
  try { await navigator.clipboard.writeText(text); } catch (e) { ok = false; }
  btn.classList.toggle("copied", ok);
  const label = btn.querySelector(".copy-label");
  if (label) label.textContent = ok ? "Copied" : "Select to copy";
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.classList.remove("copied");
    if (label) label.textContent = "Copy";
  }, 1600);
}

export function initCopy() {
  document.querySelectorAll("[data-copy], [data-copy-from]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { copy, copyFrom } = btn.dataset;
      copyText(btn, copyFrom ? document.getElementById(copyFrom).textContent.trim() : copy);
    });
  });
}

// ---------- Reveal on scroll (Desktop's scroll-fade-in) ----------
export function initReveal() {
  const els = document.querySelectorAll("[data-reveal]");
  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      io.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px -10% 0px" });
  els.forEach((el) => io.observe(el));
}

// ---------- Nav + hero scroll state ----------
export function initScroll() {
  const nav = document.querySelector(".nav");
  const hero = document.querySelector(".hero");
  let queued = false;
  function apply() {
    queued = false;
    const y = scrollY;
    nav?.classList.toggle("scrolled", y > 8);
    if (!hero || reduceMotion.matches) return;
    const p = Math.min(1, Math.max(0, y / hero.offsetHeight));
    hero.style.setProperty("--hero-p", p.toFixed(4));
  }
  addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(apply); } }, { passive: true });
  apply();
}
