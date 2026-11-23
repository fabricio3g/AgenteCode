// Calm, tactile motion & interaction layer for the Natural Science Folio mockups.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const root = document.documentElement;

export function initTheme(defaultTheme = "light") {
  const stored = (() => { try { return localStorage.getItem("agente-folio-theme"); } catch { return null; } })();
  const apply = (t) => {
    root.dataset.theme = t;
    document.dispatchEvent(new Event("themechange"));
  };
  apply(stored || defaultTheme);

  const btn = document.getElementById("theme-toggle");
  btn?.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("agente-folio-theme", next); } catch {}
    if (!document.startViewTransition || reduceMotion.matches) return apply(next);
    const b = btn.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(() => apply(next)).ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 460, easing: "cubic-bezier(.16,1,.3,1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  });
}

export function initScrollNav() {
  const nav = document.querySelector(".nav");
  if (!nav) return;
  const sync = () => nav.classList.toggle("scrolled", scrollY > 18);
  addEventListener("scroll", sync, { passive: true });
  sync();
}

export function initReveal() {
  const targets = [...document.querySelectorAll("[data-reveal], .hairline")];
  if (!targets.length) return;
  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -30px 0px" },
  );
  targets.forEach((el) => io.observe(el));
}

export function initSegmented() {
  document.querySelectorAll(".segmented[role=tablist]").forEach((list) => {
    const tabs = [...list.querySelectorAll("[role=tab]")];
    const panels = tabs.map((t) => document.getElementById(t.getAttribute("aria-controls")));
    const thumb = list.querySelector(".seg-thumb");
    let index = Math.max(0, tabs.findIndex((t) => t.getAttribute("aria-selected") === "true"));

    const place = () => {
      const btn = tabs[index];
      if (!thumb || !btn) return;
      const inset = parseFloat(getComputedStyle(list).paddingLeft) || 0;
      thumb.style.width = `${btn.offsetWidth}px`;
      thumb.style.transform = `translateX(${btn.offsetLeft - inset}px)`;
    };

    const select = (i) => {
      index = (i + tabs.length) % tabs.length;
      tabs.forEach((t, j) => {
        const on = j === index;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        panels[j]?.classList.toggle("is-active", on);
      });
      place();
    };

    tabs.forEach((t, i) => t.addEventListener("click", () => select(i)));
    new ResizeObserver(place).observe(list);
    document.fonts?.ready.then(place);
    select(index);
    list.classList.add("ready");
  });
}

export function initCopy() {
  document.querySelectorAll("[data-copy-from]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const el = document.getElementById(btn.dataset.copyFrom);
      if (!el) return;
      try { await navigator.clipboard.writeText(el.textContent.trim()); } catch {}
      const label = btn.querySelector("span") || btn;
      const prev = label.textContent;
      btn.classList.add("copied");
      label.textContent = "Copied";
      setTimeout(() => { btn.classList.remove("copied"); label.textContent = prev; }, 1600);
    });
  });
}

// Gentle scroll parallax + damped pointer drift for engraved plates.
export function initPlateMotion() {
  if (reduceMotion.matches) return;
  const plates = [...document.querySelectorAll("[data-parallax]")];
  if (!plates.length) return;

  let mx = 0, my = 0, tx = 0, ty = 0;
  let raf = 0;

  const state = plates.map((el) => ({
    el,
    speed: Number(el.dataset.parallax || 0.08),
    drift: Number(el.dataset.drift || 8),
    curY: 0,
  }));

  const tick = () => {
    raf = 0;
    tx += (mx - tx) * 0.06;
    ty += (my - ty) * 0.06;
    let moving = Math.abs(mx - tx) > 0.002 || Math.abs(my - ty) > 0.002;

    const vh = innerHeight;
    for (const s of state) {
      const r = s.el.parentElement.getBoundingClientRect();
      if (r.bottom < -120 || r.top > vh + 120) continue;
      const center = (r.top + r.height * 0.5 - vh * 0.5) / vh;
      const targetY = center * s.speed * 220;
      s.curY += (targetY - s.curY) * 0.12;
      if (Math.abs(targetY - s.curY) > 0.08) moving = true;
      const dx = tx * s.drift;
      const dy = s.curY + ty * s.drift * 0.6;
      s.el.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`;
    }
    if (moving) raf = requestAnimationFrame(tick);
  };

  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  addEventListener("scroll", kick, { passive: true });
  addEventListener("pointermove", (e) => {
    mx = (e.clientX / innerWidth - 0.5) * 2;
    my = (e.clientY / innerHeight - 0.5) * 2;
    kick();
  }, { passive: true });
  kick();
}

export function bootFolio(opts = {}) {
  initTheme(opts.defaultTheme || "light");
  initScrollNav();
  initReveal();
  initSegmented();
  initCopy();
  initPlateMotion();
}
