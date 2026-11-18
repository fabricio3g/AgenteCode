/**
 * Resolving a model-supplied accent colour to something safe to interpolate into an
 * inline `style` attribute.
 *
 * Two problems this exists to solve. First, the named accents were five hardcoded
 * Tailwind-500 hexes with no dark variant, so cards were tinted for light mode
 * regardless of theme; they now point at the shared chart palette in `app.css`.
 * Second, the dashboard interpolated `metric.color` — a free-form string straight
 * from the model, validated only as `z.string()` — into a style attribute. A value
 * like `"blue-500"` silently erased the accent bar, and one containing `;` injected
 * arbitrary declarations.
 */

import type { ArtifactKind } from '$lib/types/chat';

/** Every file card uses this theme-aware palette, in chat and the library. */
const KIND_ACCENTS: Record<ArtifactKind, string> = {
  report: 'var(--chart-1)',
  work_product: 'var(--chart-1)',
  document: 'var(--chart-1)',
  spreadsheet: 'var(--accent-green)',
  presentation: 'var(--accent-amber)',
  pdf: 'var(--accent-red)',
  research_package: 'var(--accent-violet)',
  web: 'var(--accent-sky)',
  html_card: 'var(--accent-sky)',
  widget: 'var(--accent-sky)',
  lesson: 'var(--accent-sky)',
  files: 'var(--accent-violet)',
  chart: 'var(--accent-violet)',
  diagram: 'var(--accent-sky)',
  map: 'var(--accent-green)',
  dashboard: 'var(--accent-violet)',
  info_card: 'var(--chart-1)'
};

export function artifactKindAccent(kind: ArtifactKind): string {
  return KIND_ACCENTS[kind];
}

/** Named accents the artifact tools advertise, mapped onto real tokens. */
const NAMED_ACCENTS: Record<string, string> = {
  sky: 'var(--accent-sky)',
  green: 'var(--accent-green)',
  amber: 'var(--accent-amber)',
  red: 'var(--accent-red)',
  violet: 'var(--accent-violet)',
  primary: 'var(--primary)'
};

/**
 * Colour syntaxes a value may legitimately use. Anything else — a Tailwind class
 * name, a bare word that is not a CSS colour keyword, a declaration list — falls
 * back rather than producing an invalid or injected declaration.
 */
const CSS_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|oklch\([\d\s.,%/]+\))$/i;

const DEFAULT_ARTIFACT_ACCENT = 'var(--primary)';

export function resolveArtifactAccent(value: unknown): string {
  const candidate = String(value ?? '').trim();
  if (!candidate) return DEFAULT_ARTIFACT_ACCENT;

  const named = NAMED_ACCENTS[candidate.toLowerCase()];
  if (named) return named;

  // Long values are rejected outright: a real colour is never this long, and the
  // length cap keeps the regex cheap on adversarial input.
  if (candidate.length > 32) return DEFAULT_ARTIFACT_ACCENT;
  return CSS_COLOR.test(candidate) ? candidate : DEFAULT_ARTIFACT_ACCENT;
}
