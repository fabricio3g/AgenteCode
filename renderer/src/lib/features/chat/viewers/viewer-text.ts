/**
 * Text helpers shared by the viewers that render searchable content.
 *
 * `TextViewer` and `XlsxViewer` each carried their own identical `escapeHtml`
 * and their own copy of the escape-then-mark search highlighting.
 */

/** Escape a string for safe interpolation into `{@html …}`. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escape `value`, then wrap every case-insensitive occurrence of `term` in
 * `<mark>`. An empty term just escapes, so callers can pass the raw query.
 */
export function highlightTerm(value: string, term: string): string {
  const escapedValue = escapeHtml(value);
  const needle = term.trim();
  if (!needle) return escapedValue;

  const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escapedValue.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
}
