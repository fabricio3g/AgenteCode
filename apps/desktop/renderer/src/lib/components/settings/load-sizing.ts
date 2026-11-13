/**
 * Slider arithmetic for the local load dialog. Context runs from 512 tokens
 * to a model's trained maximum (often 128k–1M), so a linear slider spends
 * nearly all of its travel above 32k; positions here are logarithmic and snap
 * to the sizes people actually pick (powers of two).
 */

export const SLIDER_STEPS = 1000;

/** Slider position (0..SLIDER_STEPS) for a context size. */
export function contextToPosition(value: number, min: number, max: number): number {
  if (max <= min) return SLIDER_STEPS;
  const clamped = Math.min(max, Math.max(min, value));
  return Math.round(((Math.log(clamped) - Math.log(min)) / (Math.log(max) - Math.log(min))) * SLIDER_STEPS);
}

/** Context size for a slider position: the nearest power of two when close, else a 1024 multiple. */
export function positionToContext(position: number, min: number, max: number): number {
  if (position >= SLIDER_STEPS) return max;
  if (position <= 0) return min;
  const raw = Math.exp(Math.log(min) + (position / SLIDER_STEPS) * (Math.log(max) - Math.log(min)));
  const power = 2 ** Math.round(Math.log2(raw));
  if (Math.abs(power - raw) / raw < 0.08 && power >= min && power <= max) return power;
  return Math.min(max, Math.max(min, Math.round(raw / 1024) * 1024));
}

/** 4096 → "4k", 262144 → "256k", 1048576 → "1M". */
export function shortTokens(value: number): string {
  if (value >= 1024 * 1024) return `${+(value / (1024 * 1024)).toFixed(1)}M`;
  if (value >= 1024) return `${Math.round(value / 1024)}k`;
  return String(value);
}

/** A typed context ("32k", "32768", "1m") as tokens, or null when it is not one. */
export function parseTokens(text: string): number | null {
  let cleaned = String(text).trim().toLowerCase().replace(/[\s,_]/g, '');
  // "32.768" is a grouped number in many locales, "1.5k" a decimal.
  if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) cleaned = cleaned.replace(/\./g, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!match) return null;
  const scale = match[2] === 'm' ? 1024 * 1024 : match[2] === 'k' ? 1024 : 1;
  const value = Math.round(Number(match[1]) * scale);
  return Number.isFinite(value) && value > 0 ? value : null;
}
