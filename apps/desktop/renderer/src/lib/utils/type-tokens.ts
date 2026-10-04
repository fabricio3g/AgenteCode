/**
 * Resolved typography tokens, for the two surfaces that paint outside CSS:
 * Monaco and xterm both measure text on a canvas, so they need a font family
 * string and a pixel number instead of a `var()`. Reading the tokens off
 * <html> keeps them on the same ladder as the rest of the interface: Settings →
 * Text size reaches the terminal and the editor, and the reading font reaches
 * them through `--font-mono`.
 */

export function cssToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** `--text-code` in pixels. Whole pixels: fractional sizes blur on 1x displays. */
export function codeFontSize(fallback = 13): number {
  const px = Number.parseFloat(cssToken('--text-code', `${fallback}px`));
  return Number.isFinite(px) ? Math.round(px) : fallback;
}

/** The code stack, so a user who picks a reading font gets it in code too. */
export function codeFontFamily(): string {
  return cssToken('--font-mono', "'IBM Plex Mono', monospace");
}
