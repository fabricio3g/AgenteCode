/**
 * The edit toolbar's arithmetic: what each button writes, given the element's
 * computed styles as the picker reported them. Pure, so the steps are spec'd
 * without a canvas. Every function returns the inline-style properties to set
 * (see `planStyleEdit`); nothing here touches a file.
 */
import { isColorValue, parseTokens, tokensFor } from './design-tokens';

export type StyleSet = Record<string, string>;

/** Type sizes in px, the ladder A− / A+ walk. */
export const FONT_STEPS = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64, 72, 96];
export const RADIUS_STEPS = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 9999];
export const PADDING_STEPS = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64];

/** The first number of a px length (`16px`, `12.5px 4px`), or null for anything else. */
export function parsePx(value: string | undefined): number | null {
  const match = /^\s*(-?\d*\.?\d+)px\b/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

/** The next ladder step in a direction from `current`; the ends hold. */
export function stepValue(current: number, ladder: number[], dir: 1 | -1): number {
  if (dir === 1) return ladder.find((step) => step > current + 0.01) ?? ladder[ladder.length - 1];
  return [...ladder].reverse().find((step) => step < current - 0.01) ?? ladder[0];
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

export function fontSizeEdit(styles: Record<string, string>, dir: 1 | -1): StyleSet {
  return { 'font-size': px(stepValue(parsePx(styles['font-size']) ?? 16, FONT_STEPS, dir)) };
}

/** Bold toggles between the regular weight and 700; 600 and up counts as bold already. */
export function boldEdit(styles: Record<string, string>): StyleSet {
  const weight = Number(styles['font-weight']);
  return { 'font-weight': Number.isFinite(weight) && weight >= 600 ? '400' : '700' };
}

export function radiusEdit(styles: Record<string, string>, dir: 1 | -1): StyleSet {
  return { 'border-radius': px(stepValue(parsePx(styles['border-radius']) ?? 0, RADIUS_STEPS, dir)) };
}

/** The four sides of a `padding` shorthand (1 to 4 values), in px; null when any is not px. */
export function paddingSides(value: string | undefined): [number, number, number, number] | null {
  const parts = (value ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map((part) => parsePx(part));
  if (nums.some((n) => n === null)) return null;
  const [top, right = top, bottom = top, left = right] = nums as number[];
  return [top, right, bottom, left];
}

/** Each side steps on its own, so uneven padding keeps its shape; equal sides collapse to a short value. */
export function paddingEdit(styles: Record<string, string>, dir: 1 | -1): StyleSet {
  const sides = paddingSides(styles.padding) ?? [0, 0, 0, 0];
  const [top, right, bottom, left] = sides.map((side) => stepValue(side, PADDING_STEPS, dir));
  const list = top === bottom && right === left ? (top === right ? [top] : [top, right]) : [top, right, bottom, left];
  return { padding: list.map(px).join(' ') };
}

/** A colour swatch: what it shows and what the page gets (`var(--accent)` keeps the link to the token). */
export interface Swatch { label: string; show: string; css: string }

export const NEUTRAL_SWATCHES: Swatch[] = [
  { label: 'Ink', show: '#111317', css: '#111317' },
  { label: 'Grey', show: '#6b7280', css: '#6b7280' },
  { label: 'Mist', show: '#e5e7eb', css: '#e5e7eb' },
  { label: 'White', show: '#ffffff', css: '#ffffff' },
  { label: 'Ember', show: '#e76d1f', css: '#e76d1f' }
];

const MAX_SWATCHES = 10;

/** The design's own colours (literal values in `:root` of tokens.css) when it has any, else a short neutral set with the ember. */
export function swatchesFor(tokensCss: string | undefined): { fromDesign: Swatch[]; fallback: Swatch[] } {
  const colors = tokensFor(parseTokens(tokensCss ?? ''), 'light').filter((decl) => decl.group === 'color' && isColorValue(decl.value));
  const fromDesign = colors.slice(0, MAX_SWATCHES).map((decl) => ({ label: decl.name.replace(/^--/, ''), show: decl.value, css: `var(${decl.name})` }));
  return { fromDesign, fallback: fromDesign.length ? [] : NEUTRAL_SWATCHES };
}

/** Edits within this gap are one burst, so one automatic snapshot covers a run of clicks. */
export const BURST_MS = 20_000;

/** Whether an edit made at `now` starts a new burst, given when the last one was made (null = none yet). */
export function startsBurst(last: number | null, now: number, gap = BURST_MS): boolean {
  return last === null || now - last > gap;
}
