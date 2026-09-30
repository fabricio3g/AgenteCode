import { describe, expect, it } from 'vitest';
import { overlapsViewport } from './browser-occlusion';

function box(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe('browser overlay intersection', () => {
  const viewport = box(100, 100, 200, 200);

  it('covers contained and partially overlapping overlays', () => {
    expect(overlapsViewport(viewport, box(120, 120, 20, 20))).toBe(true);
    expect(overlapsViewport(viewport, box(90, 90, 20, 20))).toBe(true);
    expect(overlapsViewport(viewport, box(80, 80, 300, 300))).toBe(true);
  });

  it('ignores overlays outside the viewport or touching only its edge', () => {
    expect(overlapsViewport(viewport, box(300, 100, 20, 20))).toBe(false);
    expect(overlapsViewport(viewport, box(100, 300, 20, 20))).toBe(false);
    expect(overlapsViewport(viewport, box(80, 100, 20, 20))).toBe(false);
    expect(overlapsViewport(viewport, box(100, 80, 20, 20))).toBe(false);
  });

  it('ignores hidden overlays with zero width or height', () => {
    expect(overlapsViewport(viewport, box(120, 120, 0, 20))).toBe(false);
    expect(overlapsViewport(viewport, box(120, 120, 20, 0))).toBe(false);
  });
});
