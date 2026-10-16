import { describe, expect, it } from 'vitest';
import type { DesignStroke } from '$shared/design';
import { formatTurnContext } from './design-picker';
import { formatMarks, isMark, PROBE_POINTS, rankHits, samplePoints, screenPoints, strokeBox } from './design-strokes';

const line = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 100 + (i % 2) }));

describe('strokes', () => {
  it('measures a mark and ignores a click', () => {
    expect(strokeBox([{ x: 10.4, y: 20 }, { x: 50, y: 70.2 }])).toEqual({ x: 10, y: 20, width: 40, height: 50 });
    expect(isMark([{ x: 0, y: 0 }])).toBe(false);
    expect(isMark([{ x: 0, y: 0 }, { x: 2, y: 2 }])).toBe(false);
    expect(isMark([{ x: 0, y: 0 }, { x: 30, y: 2 }])).toBe(true);
  });

  it('samples evenly with both ends kept', () => {
    const pts = line(100);
    const out = samplePoints(pts);
    expect(out).toHaveLength(PROBE_POINTS);
    expect(out[0]).toBe(pts[0]);
    expect(out[out.length - 1]).toBe(pts[99]);
    expect(samplePoints(line(5))).toHaveLength(5);
  });

  it('ranks the most crossed first and sets html and body aside', () => {
    expect(rankHits([['body'], ['.a'], ['.a'], ['.b'], []])).toEqual(['.a', '.b']);
    expect(rankHits([['body'], ['html']])).toEqual(['body', 'html']);
    expect(rankHits([['.a'], ['.b'], ['.c'], ['.d'], ['.e']], 2)).toEqual(['.a', '.b']);
  });

  it('maps page points to a frame-relative screen path', () => {
    expect(screenPoints([{ x: 100, y: 300 }, { x: 110, y: 310 }], { x: 0, y: 200 }, 0.5)).toBe('50,50 55,55');
  });
});

describe('marks in the turn context', () => {
  const stroke: DesignStroke = { id: 's1', page: 'index.html', width: 1440, points: [{ x: 120, y: 340 }, { x: 400, y: 380 }], hits: ['.hero h1', '.cta'] };

  it('describes each mark by box and the elements it crosses', () => {
    expect(formatMarks([stroke]).slice(3)).toEqual(['1. index.html at 1440px: freehand mark 280×40 at 120,340, over `.hero h1`, `.cta`']);
  });

  it('adds the block, and marks alone are enough for a context', () => {
    const text = formatTurnContext([], [], [stroke]);
    expect(text).toContain('## Marks drawn on the canvas');
    expect(formatTurnContext([], [], [])).toBe('');
    expect(formatMarks([{ ...stroke, hits: undefined, width: undefined }]).at(-1)).toBe('1. index.html: freehand mark 280×40 at 120,340');
  });
});
