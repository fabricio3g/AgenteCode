import type { ReasoningLevel } from '$lib/types/chat';

/** How many of the meter's four bars a level fills. Auto (null) shows none filled. */
export function effortBars(level: ReasoningLevel | null): number {
  switch (level) {
    case null:
    case 'off':
    case 'disabled':
    case 'none':
      return 0;
    case 'minimal':
    case 'low':
      return 1;
    case 'medium':
    case 'default':
    case 'enabled':
    case 'on':
      return 2;
    case 'high':
      return 3;
    case 'xhigh':
    case 'max':
      return 4;
    default:
      return 2;
  }
}

/** The effort spectrum, as CSS colours: quick (cool) → balanced → deep (warm). */
const SPECTRUM = ['var(--effort-low)', 'var(--effort-mid)', 'var(--effort-high)'];

/** The colour at a point (0–1) on the effort spectrum. */
export function effortColor(fraction: number): string {
  const at = Math.max(0, Math.min(1, fraction)) * (SPECTRUM.length - 1);
  const from = Math.floor(at);
  const to = Math.min(SPECTRUM.length - 1, from + 1);
  const mix = Math.round((at - from) * 100);
  return mix === 0 ? SPECTRUM[from] : `color-mix(in oklab, ${SPECTRUM[from]} ${100 - mix}%, ${SPECTRUM[to]})`;
}
