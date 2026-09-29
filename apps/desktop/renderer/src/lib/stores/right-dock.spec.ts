import { describe, expect, it } from 'vitest';
import { parseLayout, shiftWeights } from './right-dock.svelte';

describe('right dock layout', () => {
  it('reads what was saved and falls back on anything else', () => {
    expect(parseLayout('{"width":500,"weights":{"browser":2}}')).toEqual({ width: 500, weights: { browser: 2 } });
    expect(parseLayout('not json')).toEqual({ width: 460, weights: {} });
    expect(parseLayout(null)).toEqual({ width: 460, weights: {} });
    expect(parseLayout('{"width":"wide"}').width).toBe(460);
  });

  it('moves height between two stacked panels without squeezing either away', () => {
    expect(shiftWeights(1, 1, 0.5)).toEqual([1.5, 0.5]);
    const [a, b] = shiftWeights(1, 1, 5);
    expect(a + b).toBeCloseTo(2);
    expect(b).toBeCloseTo(0.3);
  });
});
