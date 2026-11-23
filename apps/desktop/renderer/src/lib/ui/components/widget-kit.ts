/**
 * The shell every HTML card and widget renders in: the app's own theme tokens,
 * a small set of component classes (`fx-*`) the model builds with, and — for
 * interactive widgets — a tiny helper script plus the height reporter.
 *
 * Widgets run in a sealed frame: `sandbox="allow-scripts"` without
 * `allow-same-origin` gives them an opaque origin (no app storage, no parent
 * DOM), and the CSP below blocks every network request. They can compute,
 * animate and respond to input — nothing else.
 */

import { visualizationFonts } from './visualization-fonts';

/** The app tokens a card inherits, read from the live theme. */
const TOKENS = [
  'background', 'foreground', 'card', 'muted', 'muted-foreground', 'border', 'border-subtle',
  'primary', 'primary-foreground', 'brand-accent', 'accent-green-text', 'accent-green-bg', 'accent-red-text',
  'accent-red-bg', 'accent-yellow-text', 'accent-yellow-bg', 'accent-blue-text', 'accent-blue-bg',
  'font-sans', 'font-mono', 'text-xs', 'text-sm', 'text-base', 'reading-scale', 'radius-sm',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6'
] as const;

export function readThemeTokens(root: HTMLElement = document.documentElement): string {
  const style = getComputedStyle(root);
  const dark = root.classList.contains('dark') || root.dataset.theme === 'dark';
  const vars = TOKENS.map((name) => {
    const value = style.getPropertyValue(`--${name}`).trim();
    return value ? `--${name}:${value};` : '';
  }).join('');
  return visualizationFonts(style.getPropertyValue('--font-sans')) + `:root{color-scheme:${dark ? 'dark' : 'light'};${vars}}`;
}

/** Blocks all network access; inline code and data URLs only. */
export const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** Minimal, token-based components. Everything is opt-in by class. */
const WIDGET_KIT_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;color:var(--foreground,#111);font:var(--text-sm,14px)/1.6 var(--font-sans,system-ui,sans-serif);-webkit-font-smoothing:antialiased}
body{padding:2px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
h1,h2,h3,h4{margin:0 0 .45em;line-height:1.25;letter-spacing:-.02em;font-weight:600}
h1{font-size:calc(var(--text-base,16px)*1.35)}h2{font-size:var(--text-base,16px)}h3{font-size:var(--text-sm,14px)}
p{margin:0 0 .6em}
a{color:inherit;text-underline-offset:2px}
img,svg,canvas{max-width:100%}
table{border-collapse:collapse;width:100%}
th,td{padding:.45rem .6rem;border-bottom:1px solid var(--border-subtle,#eee);text-align:left;font-variant-numeric:tabular-nums}
th{font-size:var(--text-xs,12px);font-weight:500;color:var(--muted-foreground,#666)}
button,input,select,textarea{font:inherit;color:inherit}
input[type=text],input[type=number],input[type=search],select,textarea{width:100%;padding:.45rem .65rem;border:1px solid var(--border-subtle,#ddd);border-radius:.5rem;background:color-mix(in srgb,var(--foreground) 3%,transparent);outline:none;transition:border-color .15s,background-color .15s}
input:focus,select:focus,textarea:focus{border-color:color-mix(in srgb,var(--foreground) 30%,var(--border));background:var(--background,#fff)}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:1.25rem;margin:0;background:transparent;cursor:pointer}input[type=range]::-webkit-slider-runnable-track{height:.25rem;border-radius:999px;background:color-mix(in srgb,var(--foreground,#111) 14%,transparent)}input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:.95rem;height:.95rem;margin-top:-.35rem;border:2px solid var(--background,#fff);border-radius:50%;background:var(--chart-1,var(--foreground,#111));box-shadow:0 0 0 1px color-mix(in srgb,var(--foreground) 12%,transparent);transition:transform .1s}input[type=range]:active::-webkit-slider-thumb{transform:scale(1.12)}
input[type=checkbox],input[type=radio]{accent-color:var(--foreground,#111)}
label{font-size:var(--text-xs,12px);color:var(--muted-foreground,#666)}
details{border-radius:.625rem;background:color-mix(in srgb,var(--foreground) 3%,transparent);padding:.6rem .8rem}
details+details{margin-top:.4rem}
summary{cursor:pointer;font-weight:500;list-style:none}
summary::-webkit-details-marker{display:none}
summary::after{content:'+';float:right;color:var(--muted-foreground);transition:rotate .15s}
details[open] summary::after{rotate:45deg}
.fx-stack{display:flex;flex-direction:column;gap:.65rem}
.fx-row{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}
.fx-between{display:flex;align-items:center;justify-content:space-between;gap:.6rem}
.fx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.55rem}
.fx-card{padding:.75rem .875rem;border:0;border-radius:.625rem;background:color-mix(in srgb,var(--foreground) 3.5%,transparent)}
.fx-muted{color:var(--muted-foreground,#666)}
.fx-small{font-size:var(--text-xs,12px)}
.fx-label{font-size:var(--text-xs,12px);font-weight:450;color:var(--muted-foreground,#666);letter-spacing:.005em}
.fx-value{font-size:calc(var(--text-base,16px)*1.45);font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.2}
.fx-divider{height:1px;background:var(--border-subtle,#eee);margin:.35rem 0}
.fx-btn{display:inline-flex;align-items:center;justify-content:center;gap:.35rem;height:2rem;padding:0 .85rem;border:1px solid transparent;border-radius:.5rem;background:color-mix(in srgb,var(--foreground) 5%,transparent);cursor:pointer;font-size:var(--text-sm,14px);font-weight:500;transition:background-color .12s,border-color .12s,transform .1s}
.fx-btn:hover{background:color-mix(in srgb,var(--foreground) 9%,transparent)}
.fx-btn:active{transform:scale(.98)}
.fx-btn.primary{background:var(--foreground,#111);color:var(--background,#fff)}
.fx-btn.primary:hover{opacity:.88}
.fx-btn.ghost{background:transparent;color:var(--muted-foreground,#666)}
.fx-btn.ghost:hover{background:color-mix(in srgb,var(--foreground) 5%,transparent);color:var(--foreground)}
.fx-seg{display:inline-flex;gap:2px;padding:3px;border:0;border-radius:.55rem;background:color-mix(in srgb,var(--foreground) 4.5%,transparent)}
.fx-seg button{height:26px;padding:0 .75rem;border:0;border-radius:.4rem;background:transparent;cursor:pointer;font-size:var(--text-xs,12px);font-weight:500;color:var(--muted-foreground);transition:color .12s,background-color .12s}.fx-seg button:hover{color:var(--foreground)}
.fx-seg button.on,.fx-seg button[aria-pressed=true]{background:light-dark(var(--background,#fff),color-mix(in srgb,var(--foreground) 12%,var(--card,#232323)));color:var(--foreground,#111);box-shadow:0 1px 2px rgb(0 0 0/.08)}
.fx-chip{display:inline-flex;align-items:center;gap:.3rem;height:1.5rem;padding:0 .6rem;border-radius:999px;background:color-mix(in srgb,var(--foreground) 5%,transparent);font-size:var(--text-xs,12px);font-weight:500}
.fx-chip.good{background:var(--accent-green-bg);color:var(--accent-green-text)}
.fx-chip.bad{background:var(--accent-red-bg);color:var(--accent-red-text)}
.fx-chip.warn{background:var(--accent-yellow-bg);color:var(--accent-yellow-text)}
.fx-chip.info{background:var(--accent-blue-bg);color:var(--accent-blue-text)}
.fx-up{color:var(--accent-green-text)}.fx-down{color:var(--accent-red-text)}
.fx-bar{height:.375rem;border-radius:999px;background:color-mix(in srgb,var(--foreground) 8%,transparent);overflow:hidden}
.fx-bar>span{display:block;height:100%;border-radius:inherit;background:var(--chart-1,var(--foreground,#111));transition:width .25s cubic-bezier(.2,.8,.2,1)}
.fx-tabs{display:flex;gap:1rem;border-bottom:1px solid var(--border-subtle,#eee);margin-bottom:.65rem}
.fx-tabs button{padding:.35rem 0;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:none;cursor:pointer;color:var(--muted-foreground);font-size:var(--text-sm,14px);font-weight:500;transition:color .12s}
.fx-tabs button:hover{color:var(--foreground)}
.fx-tabs button.on{color:var(--foreground);border-bottom-color:var(--chart-1,var(--foreground))}
.fx-list{margin:0;padding:0;list-style:none}
.fx-list>li{display:flex;align-items:center;gap:.6rem;padding:.45rem 0;border-bottom:1px solid var(--border-subtle,#eee)}
.fx-list>li:last-child{border-bottom:0}
.fx-timeline{margin:0;padding:0 0 0 1rem;list-style:none;border-left:1px solid var(--border-subtle,#ddd)}
.fx-timeline>li{position:relative;padding:0 0 .8rem .4rem}
.fx-timeline>li::before{content:'';position:absolute;left:-1.28rem;top:.45rem;width:.45rem;height:.45rem;border-radius:50%;background:var(--foreground,#111)}
.fx-fade{animation:fx-fade .2s ease both}
@keyframes fx-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.fx-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(7.25rem,1fr));gap:.5rem}
.fx-metrics>.fx-card{padding:.7rem .8rem;border-radius:.625rem;background:color-mix(in srgb,var(--foreground) 3.5%,transparent)}
.fx-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(7rem,1fr));border-block:1px solid var(--border-subtle,#eee)}
.fx-kpis>.fx-kpi{padding:.65rem .8rem;border-right:1px solid var(--border-subtle,#eee)}
.fx-kpis>.fx-kpi:first-child{padding-left:0}.fx-kpis>.fx-kpi:last-child{border-right:0}
.fx-stage{position:relative;padding:.85rem;border-radius:.625rem;background:color-mix(in srgb,var(--foreground) 3%,transparent);overflow:hidden}
.fx-takeaway{display:flex;align-items:center;gap:.45rem;padding-top:.6rem;border-top:1px solid var(--border-subtle,#eee);font-size:var(--text-xs,12px);color:var(--muted-foreground)}
.fx-takeaway::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--brand-accent,var(--chart-1,var(--foreground)));flex-shrink:0}
.fx-chart{padding-top:.85rem;border-top:1px solid var(--border-subtle,#eee)}
.fx-insight{font-size:var(--text-sm,14px);font-weight:600;letter-spacing:-.015em}
.fx-caption{font-size:var(--text-xs,12px);color:var(--muted-foreground)}
button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--chart-1,var(--foreground));outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/**
 * Helpers available to widget code as `fx`, plus the height reporter. `fx.ask`
 * posts a follow-up question to the app, which drops it in the composer for
 * the user to send — a widget never sends messages on its own.
 */
const WIDGET_RUNTIME_JS = `
(() => {
  const post = (type, data) => parent.postMessage({ source: 'flaxeo-widget', type, ...data }, '*');
  const fmtNum = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  let audioCtx = null;
  const tok = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim() || fb;

  function plot(el, opts = {}) {
    const target = typeof el === 'string' ? document.querySelector(el) : el;
    if (!target) return;
    const W = opts.width || 560, H = opts.height || 200, pad = { l: 38, r: 16, t: 14, b: 26 };
    const xr = opts.xRange || [0, 10], yr = opts.yRange || [0, 10];
    const sx = (x) => pad.l + ((x - xr[0]) / (xr[1] - xr[0] || 1)) * (W - pad.l - pad.r);
    const sy = (y) => (H - pad.b) - ((y - yr[0]) / (yr[1] - yr[0] || 1)) * (H - pad.t - pad.b);
    const series = Array.isArray(opts.series) ? opts.series : [];
    const lines = series.map((s) => {
      const pts = (s.points || []).map((p, i) => (i ? 'L' : 'M') + sx(p.x).toFixed(1) + ' ' + sy(p.y).toFixed(1)).join(' ');
      const col = s.accent ? tok('brand-accent', '#e8793a') : (s.color || tok('foreground', '#111'));
      const area = s.area && pts ? '<path d="' + pts + ' L' + sx(s.points[s.points.length - 1].x).toFixed(1) + ' ' + (H - pad.b) + ' L' + sx(s.points[0].x).toFixed(1) + ' ' + (H - pad.b) + ' Z" fill="' + col + '" opacity="0.12"/>' : '';
      return area + '<path d="' + pts + '" fill="none" stroke="' + col + '" stroke-width="' + (s.width || 2) + '" stroke-linecap="round"' + (s.dashed ? ' stroke-dasharray="4 3"' : '') + '/>';
    }).join('');
    const markers = (opts.points || []).map((p) => {
      const col = p.accent ? tok('brand-accent', '#e8793a') : tok('foreground', '#111');
      return '<circle cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="5" fill="' + col + '" stroke="' + tok('background', '#fff') + '" stroke-width="2"/>'
        + (p.label ? '<text x="' + (sx(p.x) + 8).toFixed(1) + '" y="' + (sy(p.y) + 4).toFixed(1) + '" fill="' + col + '" font-size="11" font-weight="600">' + p.label + '</text>' : '');
    }).join('');
    target.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="display:block;width:100%;height:auto">'
      + '<line x1="' + pad.l + '" y1="' + (H - pad.b) + '" x2="' + (W - pad.r) + '" y2="' + (H - pad.b) + '" stroke="' + tok('border', '#ddd') + '"/>'
      + '<line x1="' + pad.l + '" y1="' + pad.t + '" x2="' + pad.l + '" y2="' + (H - pad.b) + '" stroke="' + tok('border', '#ddd') + '"/>'
      + lines + markers + '</svg>';
  }

  function scene3d(canvas, opts = {}) {
    const el = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
    if (!el || !el.getContext) return { stop() {} };
    const ctx = el.getContext('2d');
    let rotY = opts.rotY ?? 0.55, rotX = opts.rotX ?? 0.34, drag = false, last = null, raf = 0, alive = true;
    const h = opts.height || 260;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(240, Math.round(el.getBoundingClientRect().width || 520));
      el.width = w * dpr; el.height = h * dpr; el.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return w;
    };
    let w = resize();
    const proj = (x, y, z) => {
      const cy = Math.cos(rotY), sy = Math.sin(rotY), x1 = x * cy - z * sy, z1 = x * sy + z * cy;
      const cx = Math.cos(rotX), sx = Math.sin(rotX), y2 = y * cx - z1 * sx, z2 = y * sx + z1 * cx;
      const s = 380 / Math.max(80, 300 + z2);
      return { x: w / 2 + x1 * s, y: h / 2 - y2 * s, z: z2, s, a: Math.max(0.28, Math.min(1, 1 - (z2 + 120) / 360)) };
    };
    const tick = (t) => {
      if (!alive) return;
      if (opts.autoRotate !== false && !drag) rotY += 0.007;
      ctx.clearRect(0, 0, w, h);
      if (typeof opts.draw === 'function') opts.draw({ ctx, proj, w, h, t: t / 1000, accent: tok('brand-accent', '#e8793a'), ink: tok('foreground', '#111'), muted: tok('muted-foreground', '#666'), border: tok('border', '#ddd') });
      raf = requestAnimationFrame(tick);
    };
    el.style.cursor = 'grab'; el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => { drag = true; last = { x: e.clientX, y: e.clientY }; el.setPointerCapture?.(e.pointerId); });
    el.addEventListener('pointermove', (e) => { if (!drag || !last) return; rotY += (e.clientX - last.x) * 0.01; rotX = Math.max(-1.2, Math.min(1.2, rotX + (e.clientY - last.y) * 0.01)); last = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', () => { drag = false; });
    window.addEventListener('resize', () => { w = resize(); });
    raf = requestAnimationFrame(tick);
    return { stop() { alive = false; cancelAnimationFrame(raf); } };
  }

  function sound(freqs) {
    try {
      const list = Array.isArray(freqs) ? freqs : [freqs];
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      list.slice(0, 6).forEach((hz) => {
        if (!Number.isFinite(hz) || hz <= 20 || hz > 4000) return;
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.type = 'triangle'; osc.frequency.value = hz;
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.exponentialRampToValueAtTime(0.07, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.65);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(now); osc.stop(now + 0.68);
      });
    } catch {}
  }

  window.fx = {
    $: (sel, root = document) => root.querySelector(sel),
    $$: (sel, root = document) => [...root.querySelectorAll(sel)],
    num: (n, opts) => (opts ? new Intl.NumberFormat(undefined, opts) : fmtNum).format(n),
    money: (n, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n),
    pct: (n, digits = 1) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: digits }).format(n),
    ask: (text) => post('ask', { text: String(text || '').slice(0, 2000) }),
    plot,
    scene3d,
    sound
  };
  let last = 0;
  const report = () => {
    // The body, not the document: the document is never shorter than the frame.
    const h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h !== last) { last = h; post('height', { height: h }); }
  };
  addEventListener('DOMContentLoaded', () => new ResizeObserver(report).observe(document.body));
  addEventListener('load', report);
  addEventListener('error', (e) => post('error', { message: String(e.message || 'Script error') }));
})();
`;

function escapeScriptClose(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script');
}

/** A full document for a card; `script` makes it an interactive widget. */
export function buildWidgetDocument(opts: { html: string; script?: string; tokens: string }): string {
  const interactive = !!opts.script?.trim();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>`
    + (interactive ? `<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}"/>` : '')
    + `<meta name="viewport" content="width=device-width,initial-scale=1"/>`
    + `<style>${opts.tokens}${WIDGET_KIT_CSS}</style>`
    + (interactive ? `<script>${WIDGET_RUNTIME_JS}</script>` : '')
    + `</head><body>${opts.html}`
    + (interactive ? `<script>try{${escapeScriptClose(opts.script!)}}catch(e){parent.postMessage({source:'flaxeo-widget',type:'error',message:String(e&&e.message||e)},'*')}</script>` : '')
    + `</body></html>`;
}
