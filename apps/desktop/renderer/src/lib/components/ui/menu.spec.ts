import { describe, expect, it } from 'vitest';
import { placePanel } from './menu';

describe('viewport-constrained menus', () => {
  const viewport = { width: 360, height: 280 };
  const anchor = { top: 210, bottom: 242, left: 300, right: 332 };

  it('keeps a long command menu above the composer and makes its content scrollable', () => {
    const result = placePanel(anchor, { width: 320, height: 900 }, 'top-start', viewport);
    expect(result.top).toBeGreaterThanOrEqual(6);
    expect(result.top + result.maxHeight).toBeLessThan(anchor.top);
    expect(result.maxHeight).toBeGreaterThan(100);
    expect(result.maxHeight).toBeLessThan(900);
    expect(result.left + 320).toBeLessThanOrEqual(viewport.width - 6);
  });

  it('flips to the side with room and constrains an oversized minimum width', () => {
    const result = placePanel({ top: 8, bottom: 40, left: 8, right: 48 }, { width: 500, height: 160 }, 'top-end', viewport);
    expect(result.top).toBe(46);
    expect(result.left).toBe(6);
    expect(result.maxWidth).toBe(348);
    expect(result.top + 160).toBeLessThanOrEqual(viewport.height - 6);
  });

  it('repositions after a resize even when neither side fits the content', () => {
    const result = placePanel({ top: 82, bottom: 114, left: 80, right: 120 }, { width: 250, height: 200 }, 'bottom-start', { width: 200, height: 150 });
    expect(result.top).toBeGreaterThanOrEqual(6);
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(144);
    expect(result.left + result.maxWidth).toBeLessThanOrEqual(194);
  });
});
