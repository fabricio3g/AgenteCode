export interface BrowserBounds { x: number; y: number; width: number; height: number }
export interface BrowserPresentation { bounds: BrowserBounds | null; exposed: boolean; occluded: boolean }

/** DOM coordinates are CSS pixels; child View bounds use the parent window's DIPs. */
export function browserViewBounds(rect: BrowserBounds | null, zoom: number, content: { width: number; height: number }): BrowserBounds | null {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, zoom, content.width, content.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || zoom <= 0) return null;
  const x = Math.max(0, Math.round(rect.x * zoom)), y = Math.max(0, Math.round(rect.y * zoom));
  const right = Math.min(content.width, Math.round((rect.x + rect.width) * zoom));
  const bottom = Math.min(content.height, Math.round((rect.y + rect.height) * zoom));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
