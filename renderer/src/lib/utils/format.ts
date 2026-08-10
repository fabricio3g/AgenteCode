/**
 * Canonical formatters. Before this file there were six `formatBytes`
 * implementations that disagreed on units, precision, and what to print for 0,
 * plus 24 hand-written `? '' : 's'` pluralizations.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Human-readable byte size. `1288490188` → `1.20 GB`.
 *
 * @param bytes  Size in bytes. Non-finite or negative input yields `emptyLabel`.
 * @param emptyLabel  What to print when the size is 0 or unknown.
 */
export function formatBytes(bytes: number | null | undefined, emptyLabel = '—'): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return emptyLabel;

  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }

  // Bytes are always whole; everything larger gets two decimals.
  const digits = unit === 0 ? 0 : 2;
  return `${scaled.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/**
 * Pluralize a noun against a count. Returns the noun only — callers that want
 * the number prefixed should use `countOf`.
 *
 * `plural(1, 'file')` → `file`; `plural(3, 'file')` → `files`;
 * `plural(2, 'entry', 'entries')` → `entries`
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return Math.abs(Number(count)) === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** `countOf(3, 'file')` → `3 files` */
export function countOf(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${plural(count, singular, pluralForm)}`;
}

/**
 * Elapsed seconds as a compact label. `0.4` → `0.4s`; `93` → `1m 33s`.
 * Returns `''` for zero or unknown so callers can drop the element entirely.
 */
export function formatDuration(seconds: number | null | undefined): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 10) return `${(Math.floor(value * 10) / 10).toFixed(1)}s`;
  if (value < 60) return `${Math.floor(value)}s`;
  return `${Math.floor(value / 60)}m ${Math.floor(value % 60)}s`;
}

/** Thousands separators for token counts and similar. `12345` → `12,345` */
export function formatCount(value: number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}
