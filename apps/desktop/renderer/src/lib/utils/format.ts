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

/**
 * A count with its thousands grouped: `42459` → `42,459`.
 *
 * A diff badge is the reason this exists — an ungrouped five-digit line count
 * is read as noise, not as a number — and `Intl` is the only thing that knows
 * where the app's locale puts the separator.
 */
export function groupedNumber(value: number | null | undefined): string {
  const count = Number(value);
  return Number.isFinite(count) ? Math.round(count).toLocaleString() : '0';
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

/**
 * A model id without its vendor prefix, for a row that has one line to spare:
 * `anthropic/claude-sonnet-4` → `claude-sonnet-4`. The full id stays in the
 * element's `title`.
 */
export function shortModel(model: string | null | undefined): string {
  const text = String(model ?? '').trim();
  const slash = text.lastIndexOf('/');
  return slash === -1 ? text : text.slice(slash + 1);
}
