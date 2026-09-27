// ── The look of generated files (main ⇄ renderer) ─────────────────────
// Reports, work-product HTML, printed PDFs, DOCX and PPTX all share one quiet
// design: neutral ink, one muted accent, a readable measure, hairline tables.
// Generated files leave the app, so they can't use the app's CSS tokens; the
// concrete colors live here, once.

import { APP_NAME } from './brand.ts';

export const ARTIFACT_BRAND = APP_NAME;

export type ArtifactAccent = 'slate' | 'blue' | 'green' | 'amber' | 'rose' | 'violet';
export type ArtifactTheme = 'light' | 'dark';

/** Muted accents; each has a light-mode and dark-mode shade. */
export const ARTIFACT_ACCENTS: Record<ArtifactAccent, { light: string; dark: string }> = {
  slate: { light: '#475569', dark: '#94a3b8' },
  blue: { light: '#2f5fb3', dark: '#8fb3f0' },
  green: { light: '#2f7a55', dark: '#86c9a4' },
  amber: { light: '#a0621a', dark: '#e3b16f' },
  rose: { light: '#b0425a', dark: '#eb9aac' },
  violet: { light: '#6a4bb3', dark: '#b9a3ec' }
};

export const ARTIFACT_INK = {
  light: { bg: '#ffffff', page: '#ffffff', text: '#1b1b1f', muted: '#6b6b76', line: '#e6e6ea', soft: '#f6f6f8' },
  dark: { bg: '#161618', page: '#161618', text: '#ededf0', muted: '#9a9aa5', line: '#2c2c31', soft: '#1f1f23' }
} as const;

/** Hex without '#', as docx and pptxgenjs want it. */
export function bareHex(color: string): string {
  return color.replace(/^#/, '').toUpperCase();
}

export function resolveAccent(value: unknown): ArtifactAccent {
  return typeof value === 'string' && value in ARTIFACT_ACCENTS ? (value as ArtifactAccent) : 'slate';
}

export function resolveTheme(value: unknown): ArtifactTheme {
  return value === 'dark' ? 'dark' : 'light';
}

/** The stylesheet for a generated HTML document (screen + print). */
export function artifactDocumentCss(theme: ArtifactTheme = 'light', accent: ArtifactAccent = 'slate'): string {
  const ink = ARTIFACT_INK[theme];
  const tint = ARTIFACT_ACCENTS[accent][theme];
  return `
*{box-sizing:border-box}
html{color-scheme:${theme}}
body{margin:0;background:${ink.bg};color:${ink.text};font:16px/1.65 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.page{max-width:720px;margin:0 auto;padding:56px 24px 72px}
.eyebrow{font-size:12px;font-weight:500;color:${tint};margin:0 0 10px}
h1{font-size:34px;line-height:1.15;letter-spacing:-.02em;font-weight:650;margin:0 0 10px}
h2{font-size:21px;line-height:1.3;letter-spacing:-.01em;font-weight:620;margin:40px 0 10px}
h3{font-size:17px;line-height:1.35;font-weight:600;margin:28px 0 8px}
h4{font-size:15px;font-weight:600;margin:22px 0 6px}
p{margin:0 0 14px}
.subtitle{font-size:18px;color:${ink.muted};margin:0 0 6px}
.meta{font-size:13px;color:${ink.muted};margin:0 0 36px;padding-bottom:24px;border-bottom:1px solid ${ink.line}}
a{color:${tint};text-underline-offset:2px}
ul,ol{margin:0 0 14px;padding-left:22px}li{margin:4px 0}
blockquote,.callout{margin:18px 0;padding:12px 16px;border-left:2px solid ${tint};background:${ink.soft};border-radius:0 8px 8px 0;color:${ink.text}}
blockquote p:last-child,.callout p:last-child{margin:0}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:${ink.soft};padding:1px 5px;border-radius:5px}
pre{background:${ink.soft};padding:14px 16px;border-radius:10px;overflow:auto}pre code{background:none;padding:0}
img{max-width:100%;height:auto;border-radius:8px}
hr{border:0;border-top:1px solid ${ink.line};margin:32px 0}
.table-wrap{overflow:auto;margin:14px 0 20px}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;text-align:left;vertical-align:top;border-bottom:1px solid ${ink.line};overflow-wrap:anywhere}
th{font-weight:600;color:${ink.muted};font-size:12.5px;border-bottom-color:${ink.text}33}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0 28px}
.metrics div{padding:14px 16px;background:${ink.soft};border-radius:12px}
.metrics strong{display:block;font-size:24px;font-weight:620;letter-spacing:-.01em}
.metrics span{font-size:13px;color:${ink.muted}}.metrics small{display:block;font-size:12px;color:${ink.muted};margin-top:4px}
.citations{font-size:13px;color:${ink.muted}}
section{margin:0}
@page{margin:22mm 20mm}
@media print{body{background:#fff;color:#1b1b1f}.page{max-width:none;padding:0}h2,h3{break-after:avoid}tr,.metrics div{break-inside:avoid}thead{display:table-header-group}}
`.trim();
}

/** Wraps rendered body HTML into a full, self-contained document. */
export function artifactDocumentHtml(options: {
  title: string;
  body: string;
  eyebrow?: string;
  subtitle?: string;
  meta?: string;
  theme?: ArtifactTheme;
  accent?: ArtifactAccent;
  lang?: string;
}): string {
  const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const head = [
    options.eyebrow ? `<p class="eyebrow">${esc(options.eyebrow)}</p>` : '',
    `<h1>${esc(options.title)}</h1>`,
    options.subtitle ? `<p class="subtitle">${esc(options.subtitle)}</p>` : '',
    options.meta ? `<p class="meta">${esc(options.meta)}</p>` : ''
  ].join('');
  return `<!doctype html><html lang="${esc(options.lang || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(options.title)}</title><style>${artifactDocumentCss(options.theme, options.accent)}</style></head><body><main class="page">${head}${options.body}</main></body></html>`;
}
