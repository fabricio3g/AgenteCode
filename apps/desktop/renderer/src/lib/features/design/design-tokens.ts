/**
 * Pure helpers for the Inspector's Tokens tab: read the custom properties a
 * design declares on `:root` (and in its dark scheme blocks), group them for
 * display, and build the exact `design_edit` call that changes one value.
 */

export type TokenScheme = 'light' | 'dark';
export type TokenGroup = 'color' | 'space' | 'radius' | 'font' | 'shadow' | 'motion' | 'other';

export interface TokenDecl {
  name: string;
  value: string;
  scheme: TokenScheme;
  group: TokenGroup;
  /** Offset of the declaration's first character in the source. */
  start: number;
  /** Offset just past the declaration's `;`. */
  end: number;
  /** Offset of the first character of the value. */
  valueStart: number;
}

const COLOR_VALUE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i;

export function isColorValue(value: string): boolean {
  return COLOR_VALUE.test(value.trim());
}

/** The group a token shows under: by its name first, then by what the value looks like. */
export function tokenGroup(name: string, value: string): TokenGroup {
  const key = name.toLowerCase();
  // Motion tokens are named for their role: durations and easings, the whole set the design's motion is built from.
  if (/^--(duration|ease|timing|motion)/.test(key)) return 'motion';
  if (/shadow/.test(key)) return 'shadow';
  if (/radius|rounded/.test(key)) return 'radius';
  if (/space|gap|pad|margin|inset|spacing/.test(key)) return 'space';
  if (/font|family|size|weight|leading|line-?height|tracking|letter/.test(key)) return 'font';
  if (isColorValue(value)) return 'color';
  return 'other';
}

/** Blank out comments but keep every offset, so positions still index the original text. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length));
}

/**
 * Every custom property declared in a `:root` rule. A declaration counts as
 * dark when a `prefers-color-scheme: dark` block or a dark `:root` selector
 * (`:root[data-theme="dark"]`) encloses it. Later declarations of the same
 * name win, which is how the cascade reads them.
 */
export function parseTokens(css: string): TokenDecl[] {
  const src = stripComments(css);
  const frames: { prelude: string; start: number }[] = [];
  const out: TokenDecl[] = [];
  let last = 0;

  /** A declaration ends at `;`, or at the `}` that closes its block (the last one often has no `;`). `end` is just past its text. */
  const declare = (i: number, end: number) => {
    const selector = frames[frames.length - 1]?.prelude ?? '';
    const raw = src.slice(last, i);
    const match = raw.match(/^(\s*)(--[\w-]+)\s*:\s*/);
    if (!match || !/:root\b/.test(selector)) return;
    const start = last + (match[1]?.length ?? 0);
    const valueStart = last + match[0].length;
    const value = src.slice(valueStart, i).trim();
    const dark = /prefers-color-scheme:\s*dark/i.test(frames.map((f) => f.prelude).join(' ')) || /dark/i.test(selector);
    const name = match[2];
    out.push({ name, value, scheme: dark ? 'dark' : 'light', group: tokenGroup(name, value), start, end, valueStart });
  };

  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (char === '{') {
      frames.push({ prelude: src.slice(last, i).trim(), start: last });
      last = i + 1;
    } else if (char === '}') {
      declare(i, i);
      frames.pop();
      last = i + 1;
    } else if (char === ';') {
      declare(i, i + 1);
      last = i + 1;
    }
  }
  return out;
}

/** Tokens of one scheme: the last declaration of each name wins, in first-seen order. */
export function tokensFor(decls: TokenDecl[], scheme: TokenScheme): TokenDecl[] {
  const byName = new Map<string, TokenDecl>();
  for (const decl of decls) if (decl.scheme === scheme) byName.set(decl.name, decl);
  return [...byName.values()];
}

/**
 * The `design_edit` arguments that replace one token's value. The old text is
 * the declaration itself; when the same declaration appears more than once,
 * it is widened with the line before so the edit targets exactly this one.
 */
export function tokenEdit(css: string, decl: TokenDecl, value: string): { old_text: string; new_text: string } | null {
  const next = value.trim();
  if (!next || /[;{}\n]/.test(next)) return null;
  const old = css.slice(decl.start, decl.end);
  const replacement = css.slice(decl.start, decl.valueStart) + next + ';';
  const occurrences = css.split(old).length - 1;
  if (occurrences <= 1) return { old_text: old, new_text: replacement };
  // Widen to the start of the line before, which carries the enclosing selector's context.
  const lineStart = css.lastIndexOf('\n', decl.start - 1);
  const prevStart = lineStart > 0 ? css.lastIndexOf('\n', lineStart - 1) + 1 : 0;
  const prefix = css.slice(prevStart, decl.start);
  return { old_text: prefix + old, new_text: prefix + replacement };
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const toHexByte = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/**
 * A colour as `#rrggbb` for a native colour input, or null when the value
 * cannot be expressed that way (oklch, var(), an alpha below 1, ...).
 */
export function colorToHex(value: string): string | null {
  const v = value.trim();
  const hex = v.match(HEX);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      if (digits.length === 4 && digits[3].toLowerCase() !== 'f') return null;
      return '#' + [...digits.slice(0, 3)].map((c) => c + c).join('').toLowerCase();
    }
    if (digits.length === 8) return digits.slice(6).toLowerCase() === 'ff' ? '#' + digits.slice(0, 6).toLowerCase() : null;
    return '#' + digits.toLowerCase();
  }
  const rgb = v.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:\s*[,/]\s*(1|1\.0+|100%))?\s*\)$/i);
  if (rgb) return '#' + toHexByte(+rgb[1]) + toHexByte(+rgb[2]) + toHexByte(+rgb[3]);
  return null;
}
