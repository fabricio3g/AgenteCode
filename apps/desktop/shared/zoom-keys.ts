// Ctrl/Cmd +, - and 0 → the interface size step (Settings → Accessibility).

const ZOOM_KEYS: Record<string, 1 | -1 | 0> = { '=': 1, '+': 1, '-': -1, '0': 0 };

export function zoomKeyDirection(key: string, modifier: boolean, alt: boolean): 1 | -1 | 0 | null {
  if (!modifier || alt) return null;
  return ZOOM_KEYS[key] ?? null;
}
