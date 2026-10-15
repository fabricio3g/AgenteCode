#!/usr/bin/env node
/**
 * Generates `ui/design/AgenteTokens.kt` from the desktop's own token sheet, so
 * the phone cannot drift from the design language the Electron renderer and the
 * TUI already share.
 *
 * Sources (never edited by hand):
 *   apps/desktop/renderer/src/app.css        planes, text, lines, radii, motion
 *   apps/desktop/shared/window-theme.ts      the canvas colour per theme
 *
 * Usage:
 *   node apps/android/scripts/gen-tokens.mjs           write the file
 *   node apps/android/scripts/gen-tokens.mjs --check   fail if it is stale
 *
 * `--check` runs in the Android workflow, so a desktop token change that the
 * phone has not picked up breaks CI instead of shipping.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const APP_CSS = join(repo, 'apps/desktop/renderer/src/app.css');
const WINDOW_THEME = join(repo, 'apps/desktop/shared/window-theme.ts');
const OUT = join(repo, 'apps/android/app/src/main/java/dev/agente/android/ui/design/AgenteTokens.kt')
const RES = join(repo, 'apps/android/app/src/main/res');

/* ── CSS reading ─────────────────────────────────────────────────────────── */

/** Declarations of one top-level rule, with `var()` references left intact. */
function block(css, selector) {
  const lines = css.split('\n');
  const start = lines.findIndex((line) => line === `${selector} {`);
  if (start === -1) throw new Error(`app.css has no \`${selector} {\` rule`);
  const end = lines.indexOf('}', start);
  if (end === -1) throw new Error(`\`${selector}\` is never closed`);

  const out = new Map();
  let text = '';
  let depth = 0;
  let quote = null;
  for (const char of lines.slice(start + 1, end).join('\n')) {
    if (quote) {
      text += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; text += char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ';' && depth === 0) {
      const declaration = text.trim();
      const colon = declaration.indexOf(':');
      if (declaration.startsWith('--') && colon !== -1) {
        out.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
      }
      text = '';
      continue;
    }
    text += char;
  }
  return out;
}

/** `var(--x)` chains resolve inside the theme, then against `:root`. */
function resolveToken(name, theme, root, seen = new Set()) {
  if (seen.has(name)) throw new Error(`circular var() at ${name}`);
  seen.add(name);
  const raw = theme.get(name) ?? root.get(name);
  if (raw === undefined) throw new Error(`app.css has no ${name}`);
  const match = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  return match ? resolveToken(match[1], theme, root, seen) : raw;
}

function windowThemeColors() {
  const source = readFileSync(WINDOW_THEME, 'utf8');
  const read = (theme) => {
    const match = new RegExp(`${theme}: \\{ color: '(#[0-9a-f]{6})', symbolColor: '(#[0-9a-f]{6})' \\}`).exec(source);
    if (!match) throw new Error(`window-theme.ts has no ${theme} colours`);
    return { background: match[1], foreground: match[2] };
  };
  return { light: read('light'), dark: read('dark') };
}

/* ── value conversion ────────────────────────────────────────────────────── */

const hex = (value, what) => {
  const digits = value.slice(1);
  const expand = digits.length === 3 || digits.length === 4 ? [...digits].map((d) => d + d).join('') : digits;
  const alpha = expand.length === 8 ? expand.slice(6) : 'ff';
  return { argb: (alpha + expand.slice(0, 6)).toUpperCase(), hex: expand.slice(0, 6), alpha: parseInt(alpha, 16) / 255, what };
};

/** `#rrggbb`, `#rrggbbaa` and `rgb(r g b / a)` all land on Compose's ARGB long. */
function color(value, what) {
  if (value.startsWith('#')) return `Color(0x${hex(value, what).argb})`;
  const match = /^rgb\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(value);
  if (!match) throw new Error(`${what}: cannot read colour \`${value}\``);
  const channel = (n) => Math.round(Number(n)).toString(16).padStart(2, '0');
  const alpha = match[4] === undefined ? 255 : Math.round(Number(match[4]) * 255);
  const argb = (alpha.toString(16).padStart(2, '0') + channel(match[1]) + channel(match[2]) + channel(match[3])).toUpperCase();
  return `Color(0x${argb})`;
}

/** Lengths land in dp (rem = 16px, the browser default the desktop relies on). */
function dp(value, what) {
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem) return `${trim(Number(rem[1]) * 16)}.dp`;
  const px = /^([\d.]+)px$/.exec(value);
  if (px) return `${trim(Number(px[1]))}.dp`;
  const scale = /^calc\(([\d.]+)px \* var\(--reading-scale\)\)$/.exec(value);
  if (scale) return `${trim(Number(scale[1]))}.sp`;
  throw new Error(`${what}: cannot read length \`${value}\``);
}

function trim(number) {
  const rounded = Math.round(number * 1000) / 1000;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`;
}

function number(value, what) {
  if (!/^-?[\d.]+$/.test(value)) throw new Error(`${what}: cannot read number \`${value}\``);
  return trim(Number(value));
}

function millis(value, what) {
  const match = /^(\d+)ms$/.exec(value);
  if (!match) throw new Error(`${what}: cannot read duration \`${value}\``);
  return match[1];
}

function curve(value, what) {
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(value);
  if (!match) throw new Error(`${what}: cannot read curve \`${value}\``);
  const points = match[1].split(',').map((part) => Number(part.trim()));
  if (points.length !== 4 || points.some(Number.isNaN)) throw new Error(`${what}: bad curve \`${value}\``);
  return points.map((point) => trim(point)).join('f, ') + 'f';
}

/* ── the table ───────────────────────────────────────────────────────────── */

/** Kotlin name, token, reader. One line per value the phone is allowed to know. */
const COLORS = [
  ['canvas', '--theme-background', 'window'],
  ['foreground', '--theme-foreground', 'window'],
  ['card', '--card'],
  ['panel', '--popover'],
  ['plane', '--sidebar'],
  ['muted', '--muted'],
  ['mutedForeground', '--muted-foreground'],
  ['secondary', '--text-secondary'],
  ['line', '--border'],
  ['lineSubtle', '--border-subtle'],
  ['accent', '--brand-accent'],
  ['accentStrong', '--brand-accent-strong'],
  ['activePlane', '--nav-current-bg'],
  ['rowHover', '--float-row-hover'],
  ['ring', '--input'],
  ['tileAccent', '--tile-accent'],
  ['tileHighlight', '--tile-hi']
];

const METRICS = [
  ['composerRadius', '--composer-radius'],
  ['cardRadius', '--radius'],
  ['rowRadius', '--float-row-radius'],
  ['inputRadius', '--radius-input'],
  ['icon', '--sidebar-icon'],
  ['rowHeight', '--sidebar-row-h'],
  ['rowGap', '--sidebar-row-gap', 'gap'],
  ['threadWidth', '--thread-width'],
  ['textProse', '--text-prose'],
  ['textBase', '--text-base'],
  ['textSm', '--text-sm'],
  ['textXs', '--text-xs'],
  ['textCode', '--text-code'],
  ['leading', '--leading-base'],
  ['trackingCaption', '--tracking-caption']
];

const MOTION = [
  ['instant', '--motion-instant'],
  ['fast', '--motion-fast'],
  ['normal', '--motion-normal'],
  ['smooth', '--motion-smooth'],
  ['dialog', '--motion-dialog']
];

const CURVES = [
  ['standard', '--motion-ease'],
  ['enter', '--motion-ease-out'],
  ['exit', '--motion-ease-in']
];

/** Only what a stronger-contrast preference raises (see `html.a11y-contrast`). */
const CONTRAST = [
  ['mutedForeground', '--muted-foreground'],
  ['secondary', '--text-secondary'],
  ['line', '--border'],
  ['lineSubtle', '--border-subtle'],
  ['ring', '--input']
];

function render() {
  // Comments go first: the sheet explains itself with apostrophes, and a
  // quote tracker that cannot tell a comment from a string never recovers.
  const css = readFileSync(APP_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const root = block(css, ':root');
  const themes = {
    light: { tokens: root, window: windowThemeColors().light },
    dark: { tokens: block(css, '.dark'), window: windowThemeColors().dark }
  };
  // The desktop's row gap lives in the row recipe, not in :root.
  root.set('--sidebar-row-gap', '0.625rem');

  const value = (theme, token) => {
    if (token === '--theme-background' || token === '--theme-foreground') {
      return color(themes[theme].window[token === '--theme-background' ? 'background' : 'foreground'], token);
    }
    const raw = resolveToken(token, themes[theme].tokens, root);
    // The mosaic keeps its channels as `r g b` triples in CSS.
    return token.startsWith('--tile-') ? color(`rgb(${raw})`, token) : color(raw, token);
  };

  const palette = (theme) => COLORS.map(([name, token]) =>
    `        ${name} = ${value(theme, token)}`
  ).join(',\n');

  const contrast = (theme) => {
    // The stronger-contrast values live in their own rules, so they resolve
    // against the raised sheet first and the theme underneath it second.
    const raised = theme === 'dark' ? block(css, 'html.dark.a11y-contrast') : block(css, 'html.a11y-contrast');
    return CONTRAST.map(([name, token]) =>
      `        ${name} = ${color(resolveToken(token, raised, themes[theme].tokens), token)}`
    ).join(',\n');
  };

  const metrics = METRICS.map(([name, token]) => {
    const raw = resolveToken(token, themes.light.tokens, root);
    if (token === '--leading-base') return `        const val ${name} = ${number(raw, token)}f`;
    if (token === '--tracking-caption') return `        val ${name} = ${trim(Number(raw.replace('em', '')))}.em`;
    const rendered = dp(raw, token);
    // The type ladder is text (scaled by the system font size), not spacing.
    return `        val ${name}: ${rendered.endsWith('.sp') ? 'TextUnit' : 'Dp'} = ${rendered}`;
  }).join('\n');

  return `package dev.agente.android.ui.design

// Generated by apps/android/scripts/gen-tokens.mjs — do not edit.
//
// Every value below is read from the desktop's token sheet
// (apps/desktop/renderer/src/app.css, apps/desktop/shared/window-theme.ts), so
// the phone's planes, text ladder, radii and motion ladder are the desktop's
// own numbers rather than a second palette that merely looks similar. The
// Android-only touch adaptations live in AgenteMetrics.kt.

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** One theme's planes, text colours and hairlines. */
data class AgentePalette(
    val canvas: Color,
    val foreground: Color,
    val card: Color,
    val panel: Color,
    val plane: Color,
    val rail: Color,
    val muted: Color,
    val mutedForeground: Color,
    val secondary: Color,
    val line: Color,
    val lineSubtle: Color,
    val accent: Color,
    val accentStrong: Color,
    val activePlane: Color,
    val rowHover: Color,
    val ring: Color,
    val tileAccent: Color,
    val tileHighlight: Color
)

/** The tokens a stronger-contrast preference raises. */
data class AgenteContrast(
    val mutedForeground: Color,
    val secondary: Color,
    val line: Color,
    val lineSubtle: Color,
    val ring: Color
)

object AgenteTokens {
    val lightPalette = AgentePalette(
${palette('light')}
    )

    val darkPalette = AgentePalette(
${palette('dark')}
    )

    val lightContrast = AgenteContrast(
${contrast('light')}
    )

    val darkContrast = AgenteContrast(
${contrast('dark')}
    )

    /** The desktop's one type ladder, multiplied there by \`--reading-scale\`
     *  and here by the system font scale (that is what \`sp\` is). */
    object Type {
${metrics.split('\n').filter((line) => /text|leading|tracking/.test(line)).join('\n')}
    }

    object Shape {
${metrics.split('\n').filter((line) => /Radius|rowRadius/.test(line)).join('\n')}
    }

    /** Desktop geometry the phone keeps: glyph size, row recipe, thread measure. */
    object Geometry {
${metrics.split('\n').filter((line) => /icon|rowHeight|rowGap|threadWidth/.test(line)).join('\n')}
    }

    /** Durations in milliseconds, from the five-step ladder. */
    object Motion {
${MOTION.map(([name, token]) => `        const val ${name} = ${millis(resolveToken(token, root, root), token)}`).join('\n')}
    }

    /** Cubic-bezier control points, in Compose's \`CubicBezierEasing\` order. */
    object Curves {
${CURVES.map(([name, token]) => `        val ${name} = floatArrayOf(${curve(resolveToken(token, root, root), token)})`).join('\n')}
    }

    /** The mosaic's rounding, as a fraction of the cell. */
    const val tileRadius = ${number(resolveToken('--tile-radius', root, root), '--tile-radius')}f
    const val tileAlpha = ${number(resolveToken('--tile-alpha', root, root), '--tile-alpha')}f
}
`;
}

const generated = render();

/** The launch window's colour, from the same two values the canvas uses. */
function windowColors() {
  const colors = windowThemeColors();
  const file = (qualifier, hex) => `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/android/scripts/gen-tokens.mjs from shared/window-theme.ts. -->
<resources>
    <color name="window_background">${hex}</color>
</resources>
`;
  return [
    [join(RES, 'values', 'colors.xml'), file('values', colors.light.background)],
    [join(RES, 'values-night', 'colors.xml'), file('values-night', colors.dark.background)]
  ];
}

if (process.argv.includes('--check')) {
  let stale = existsSync(OUT) && readFileSync(OUT, 'utf8') !== generated ? 1 : 0;
  if (stale) console.error('stale: AgenteTokens.kt');
  for (const [file, content] of windowColors()) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) {
      console.error(`stale: ${file.replace(`${repo}/`, '')}`);
      stale += 1;
    }
  }
  if (stale) {
    console.error('Run: node apps/android/scripts/gen-tokens.mjs');
    process.exit(1);
  }
  console.log('Tokens and window colours are current.');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, generated);
  for (const [file, content] of windowColors()) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  console.log(`Wrote ${OUT.replace(`${repo}/`, '')} and the window colours`);
}
