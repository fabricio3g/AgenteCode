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
  'primary', 'primary-foreground', 'accent-green-text', 'accent-green-bg', 'accent-red-text',
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
export const WIDGET_KIT_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;color:var(--foreground,#111);font:var(--text-sm,14px)/1.6 var(--font-sans,system-ui,sans-serif);-webkit-font-smoothing:antialiased}
body{padding:2px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
h1,h2,h3,h4{margin:0 0 .4em;line-height:1.25;letter-spacing:-.015em}
h1{font-size:calc(var(--text-base,16px)*1.4)}h2{font-size:var(--text-base,16px)}h3{font-size:var(--text-sm,14px)}
p{margin:0 0 .6em}
a{color:inherit;text-underline-offset:2px}
img,svg,canvas{max-width:100%}
table{border-collapse:collapse;width:100%}
th,td{padding:.4rem .55rem;border-bottom:1px solid var(--border-subtle,#eee);text-align:left;font-variant-numeric:tabular-nums}
th{font-size:var(--text-xs,12px);font-weight:500;color:var(--muted-foreground,#666)}
button,input,select,textarea{font:inherit;color:inherit}
input[type=text],input[type=number],input[type=search],select,textarea{width:100%;padding:.4rem .6rem;border:1px solid var(--border,#ddd);border-radius:.55rem;background:var(--background,#fff);outline:none;transition:border-color .15s}
input:focus,select:focus,textarea:focus{border-color:color-mix(in srgb,var(--foreground) 35%,var(--border))}
input[type=range]{width:100%;accent-color:var(--chart-1,var(--foreground,#111))}
input[type=checkbox],input[type=radio]{accent-color:var(--foreground,#111)}
label{font-size:var(--text-xs,12px);color:var(--muted-foreground,#666)}
details{border:1px solid var(--border-subtle,#eee);border-radius:var(--radius-sm,6px);padding:.55rem .75rem}
details+details{margin-top:.4rem}
summary{cursor:pointer;font-weight:500;list-style:none}
summary::-webkit-details-marker{display:none}
summary::after{content:'+';float:right;color:var(--muted-foreground);transition:rotate .15s}
details[open] summary::after{rotate:45deg}
.fx-stack{display:flex;flex-direction:column;gap:.6rem}
.fx-row{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.fx-between{display:flex;align-items:center;justify-content:space-between;gap:.6rem}
.fx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:.6rem}
.fx-card{padding:.75rem .85rem;border:1px solid var(--border-subtle,#eee);border-radius:var(--radius-sm,6px);background:transparent}
.fx-muted{color:var(--muted-foreground,#666)}
.fx-small{font-size:var(--text-xs,12px)}
.fx-label{font-size:var(--text-xs,12px);font-weight:400;color:var(--muted-foreground,#666);letter-spacing:.01em}
.fx-value{font-size:calc(var(--text-base,16px)*1.6);font-weight:600;letter-spacing:-.035em;font-variant-numeric:tabular-nums;line-height:1.2}
.fx-divider{height:1px;background:var(--border-subtle,#eee);margin:.3rem 0}
.fx-btn{display:inline-flex;align-items:center;justify-content:center;gap:.35rem;height:2rem;padding:0 .8rem;border:1px solid var(--border,#ddd);border-radius:var(--radius-sm,6px);background:var(--background,#fff);cursor:pointer;font-size:var(--text-sm,14px);font-weight:500;transition:background-color .15s,border-color .15s,transform .1s}
.fx-btn:hover{background:var(--muted,#f4f4f5)}
.fx-btn:active{transform:scale(.97)}
.fx-btn.primary{background:var(--foreground,#111);border-color:transparent;color:var(--background,#fff)}
.fx-btn.primary:hover{opacity:.9}
.fx-btn.ghost{border-color:transparent;background:transparent}
.fx-btn.ghost:hover{background:var(--muted)}
.fx-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border,#ddd);border-radius:var(--radius-sm,6px);background:transparent}
.fx-seg button{height:26px;padding:0 .75rem;border:0;border-radius:var(--radius-sm,6px);background:transparent;cursor:pointer;font-size:var(--text-xs,12px);color:var(--muted-foreground)}
.fx-seg button.on,.fx-seg button[aria-pressed=true]{background:var(--foreground,#111);color:var(--background,#fff)}
.fx-chip{display:inline-flex;align-items:center;gap:.3rem;height:1.5rem;padding:0 .6rem;border-radius:999px;background:var(--muted,#f4f4f5);font-size:var(--text-xs,12px);font-weight:500}
.fx-chip.good{background:var(--accent-green-bg);color:var(--accent-green-text)}
.fx-chip.bad{background:var(--accent-red-bg);color:var(--accent-red-text)}
.fx-chip.warn{background:var(--accent-yellow-bg);color:var(--accent-yellow-text)}
.fx-chip.info{background:var(--accent-blue-bg);color:var(--accent-blue-text)}
.fx-up{color:var(--accent-green-text)}.fx-down{color:var(--accent-red-text)}
.fx-bar{height:.45rem;border-radius:999px;background:var(--muted,#f4f4f5);overflow:hidden}
.fx-bar>span{display:block;height:100%;border-radius:inherit;background:var(--chart-1,var(--foreground,#111));transition:width .3s cubic-bezier(.2,.8,.2,1)}
.fx-tabs{display:flex;gap:1rem;border-bottom:1px solid var(--border-subtle,#eee);margin-bottom:.6rem}
.fx-tabs button{padding:.35rem 0;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:none;cursor:pointer;color:var(--muted-foreground);font-size:var(--text-sm,14px)}
.fx-tabs button.on{color:var(--foreground);border-bottom-color:var(--chart-1,var(--foreground))}
.fx-list{margin:0;padding:0;list-style:none}
.fx-list>li{display:flex;align-items:center;gap:.6rem;padding:.45rem 0;border-bottom:1px solid var(--border-subtle,#eee)}
.fx-list>li:last-child{border-bottom:0}
.fx-timeline{margin:0;padding:0 0 0 1rem;list-style:none;border-left:1px solid var(--border,#ddd)}
.fx-timeline>li{position:relative;padding:0 0 .8rem .4rem}
.fx-timeline>li::before{content:'';position:absolute;left:-1.3rem;top:.45rem;width:.5rem;height:.5rem;border-radius:50%;background:var(--foreground,#111)}
.fx-fade{animation:fx-fade .2s ease both}
@keyframes fx-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.fx-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(7rem,1fr));border-block:1px solid var(--border-subtle,#eee)}
.fx-metrics>.fx-card{border:0;border-right:1px solid var(--border-subtle,#eee);border-radius:0;background:none;padding:.7rem .8rem}
.fx-metrics>.fx-card:first-child{padding-left:0}.fx-metrics>.fx-card:last-child{border-right:0}
.fx-chart{padding-top:1rem;border-top:1px solid var(--border-subtle,#eee)}
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
export const WIDGET_RUNTIME_JS = `
(() => {
  const post = (type, data) => parent.postMessage({ source: 'flaxeo-widget', type, ...data }, '*');
  const fmtNum = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  window.fx = {
    $: (sel, root = document) => root.querySelector(sel),
    $$: (sel, root = document) => [...root.querySelectorAll(sel)],
    num: (n, opts) => (opts ? new Intl.NumberFormat(undefined, opts) : fmtNum).format(n),
    money: (n, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n),
    pct: (n, digits = 1) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: digits }).format(n),
    ask: (text) => post('ask', { text: String(text || '').slice(0, 2000) })
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
