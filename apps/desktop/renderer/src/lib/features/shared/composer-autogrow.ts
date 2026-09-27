/**
 * Shared composer autogrow.
 *
 * Single source of truth for textarea sizing.
 * Used by home Composer and code CodeComposer.
 * Measured against empty height: empty value collapses
 * to CSS min-height instead of sticking at max height.
 */
export const MAX_COMPOSER_TEXTAREA_PX = 220;

export function autogrowTextarea(element: HTMLTextAreaElement, maxPx: number = MAX_COMPOSER_TEXTAREA_PX): void {
  element.style.height = 'auto';
  const measured = element.scrollHeight;
  const next = element.value ? Math.min(measured, maxPx) : 0;
  element.style.height = next ? `${next}px` : '';
}
