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

  it('opens a submenu beside its row, flipping left when the right has no room', () => {
    const row = { top: 150, bottom: 180, left: 20, right: 200 };
    const right = placePanel(row, { width: 120, height: 100 }, 'right-end', viewport);
    expect(right.left).toBe(206);
    expect(right.top + 100).toBe(180);
    const flipped = placePanel({ top: 150, bottom: 180, left: 230, right: 350 }, { width: 120, height: 100 }, 'right-start', viewport);
    expect(flipped.left + 120).toBeLessThanOrEqual(224);
    expect(flipped.top).toBe(150);
  });
});
