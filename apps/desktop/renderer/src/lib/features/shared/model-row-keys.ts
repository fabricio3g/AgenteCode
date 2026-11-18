/**
 * Arrow keys in a model list: Down/Up walk the enabled `[data-model-option]`
 * rows inside `panel`, and Up from the first row returns to the search field.
 * Keys pressed anywhere else (outside the field and the rows) are left alone.
 * The composer's switcher and the shared picker dialog both walk their rows
 * this way.
 */
export function moveAmongModelRows(event: KeyboardEvent, panel: HTMLElement | undefined, search: HTMLInputElement | undefined): void {
  if (!panel) return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...panel.querySelectorAll<HTMLButtonElement>('[data-model-option]:not(:disabled)')];
  const current = rows.findIndex((row) => row === document.activeElement);
  if (document.activeElement !== search && current < 0) return;
  event.preventDefault();
  const next = current + (event.key === 'ArrowDown' ? 1 : -1);
  if (next < 0 && current >= 0) search?.focus();
  else {
    const row = rows[Math.min(rows.length - 1, Math.max(0, next))];
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  }
}
