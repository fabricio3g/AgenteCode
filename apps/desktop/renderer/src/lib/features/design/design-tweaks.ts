/**
 * Tweaks: a few adjustable values the agent declares in `tweaks.json`, each
 * bound to one custom property of tokens.css. The file is read leniently (a
 * bad entry is dropped, never an error), and a tweak is shown only when its
 * property really is declared in tokens.css, so the control always has
 * something to edit. Writing goes through the Tokens tab's own path.
 */
import { colorToHex, type TokenDecl } from './design-tokens';

export const TWEAKS_FILE = 'tweaks.json';
const MAX_TWEAKS = 12;

export interface TweakOption { value: string; label: string }

export interface Tweak {
  id: string;
  label: string;
  type: 'range' | 'color' | 'choice';
  /** The custom property, `--name`. */
  cssVar: string;
  min?: number;
  max?: number;
  step?: number;
  /** Appended to a range's number (`px`, `rem`, `ms`, or none). */
  unit?: string;
  options?: TweakOption[];
  /** The agent's default, used only when tokens.css has no value to read. */
  value?: string | number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown, max = 80) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const VAR = /^--[A-Za-z0-9_-]+$/;
const UNIT = /^[a-z%]{0,4}$/;
/** What may be written as a token value: nothing that ends the declaration or the block. */
const SAFE = /^[^;{}\n\r<>\\]{1,120}$/;

function readOption(value: unknown): TweakOption | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return SAFE.test(text) ? { value: text, label: text } : null;
  }
  if (!isRecord(value)) return null;
  const v = str(value.value, 120);
  return SAFE.test(v) ? { value: v, label: str(value.label) || v } : null;
}

function readTweak(value: unknown): Tweak | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (type !== 'range' && type !== 'color' && type !== 'choice') return null;
  const cssVar = str(value.var ?? value.cssVar ?? value.css, 80);
  const id = str(value.id, 40) || cssVar.replace(/^--/, '');
  if (!VAR.test(cssVar) || !id) return null;
  const base: Tweak = { id, label: str(value.label) || id, type, cssVar };
  if (typeof value.value === 'string' || typeof value.value === 'number') base.value = value.value;
  if (type === 'range') {
    const min = num(value.min);
    const max = num(value.max);
    if (min === undefined || max === undefined || max <= min) return null;
    const step = num(value.step);
    const unit = str(value.unit, 4);
    return { ...base, min, max, step: step && step > 0 ? step : (max - min) / 100 >= 1 ? 1 : (max - min) / 100, unit: UNIT.test(unit) ? unit : '' };
  }
  if (type === 'choice') {
    const options = Array.isArray(value.options) ? value.options.map(readOption).filter((o): o is TweakOption => o !== null).slice(0, 12) : [];
    return options.length >= 2 ? { ...base, options } : null;
  }
  return base;
}

/** The tweaks a `tweaks.json` declares: an array, or `{ tweaks: [...] }`. Entries with a repeated id keep the first. */
export function parseTweaks(json: string | undefined): Tweak[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.tweaks) ? raw.tweaks : [];
  const seen = new Set<string>();
  const out: Tweak[] = [];
  for (const item of list) {
    const tweak = readTweak(item);
    if (!tweak || seen.has(tweak.id)) continue;
    seen.add(tweak.id);
    out.push(tweak);
    if (out.length >= MAX_TWEAKS) break;
  }
  return out;
}

/** A tweak with the token it edits and the value it has now. */
export interface ResolvedTweak { tweak: Tweak; decl: TokenDecl; current: string }

/** The tweaks whose property is declared (light scheme) in tokens.css, with their current values. */
export function resolveTweaks(tweaks: Tweak[], light: TokenDecl[]): ResolvedTweak[] {
  const out: ResolvedTweak[] = [];
  for (const tweak of tweaks) {
    const decl = light.find((item) => item.name === tweak.cssVar);
    if (decl) out.push({ tweak, decl, current: decl.value.trim() });
  }
  return out;
}

/** The number in a range's current value (`12px` → 12); the tweak's own default, then its minimum, when it has none. */
export function rangeValue(resolved: ResolvedTweak): number {
  const n = Number.parseFloat(resolved.current);
  if (Number.isFinite(n)) return n;
  const fallback = Number(resolved.tweak.value);
  return Number.isFinite(fallback) ? fallback : (resolved.tweak.min ?? 0);
}

/** What goes into tokens.css for a range position. */
export function rangeText(tweak: Tweak, n: number): string {
  const step = tweak.step ?? 1;
  const places = (String(step).split('.')[1] ?? '').length;
  const clamped = Math.min(tweak.max ?? n, Math.max(tweak.min ?? n, n));
  return `${Number(clamped.toFixed(places))}${tweak.unit ?? ''}`;
}

/** The value a colour control shows: the token as `#rrggbb`, else the tweak's default, else null. */
export function colorValue(resolved: ResolvedTweak): string | null {
  return colorToHex(resolved.current) ?? (typeof resolved.tweak.value === 'string' ? colorToHex(resolved.tweak.value) : null);
}

export const isSafeTokenValue = (value: string) => SAFE.test(value.trim());
