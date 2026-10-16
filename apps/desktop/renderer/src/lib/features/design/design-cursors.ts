/**
 * The canvas's pointer for each tool: one ink arrow with a white rim (it reads
 * on any page the agent draws) and a small ember badge naming the tool. Browse
 * keeps the page's own cursor. The badge sits below-right of the tip, so the
 * arrow never covers what it points at.
 *
 * The frame is an opaque origin and gets the value over postMessage (`tool`),
 * so this is a plain CSS `cursor` value with crosshair as the fallback.
 */
import type { DesignCanvasTool } from '$shared/design';

const EMBER = '#e76d1f';
const ARROW = '<path d="M4 3L4 21L9 16.5L12.5 24L15.5 22.6L12 15.2L18.5 15Z" fill="#111317" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>';

const BADGES: Record<Exclude<DesignCanvasTool, 'browse'>, string> = {
  select:
    `<rect x="17" y="17" width="13" height="13" rx="3" fill="${EMBER}" stroke="#fff" stroke-width="1"/>` +
    '<rect x="20" y="20" width="7" height="7" rx="1" fill="none" stroke="#fff" stroke-width="1.3" stroke-dasharray="2 1.5"/>',
  comment:
    `<path d="M18.5 29.5L19.4 26.6A6.5 6.5 0 1 1 21.4 28.6Z" fill="${EMBER}" stroke="#fff" stroke-width="1" stroke-linejoin="round"/>` +
    '<path d="M21 23.5H27M24 20.5V26.5" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>'
};

/** The CSS `cursor` value for a tool; empty for Browse, which leaves the page's own. */
export function toolCursor(tool: DesignCanvasTool): string {
  if (tool === 'browse') return '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${ARROW}${BADGES[tool]}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 4 3, crosshair`;
}
