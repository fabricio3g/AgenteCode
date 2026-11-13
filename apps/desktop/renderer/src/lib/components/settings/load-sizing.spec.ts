import { describe, expect, it } from 'vitest';
import { contextToPosition, parseTokens, positionToContext, shortTokens, SLIDER_STEPS } from './load-sizing';

describe('load sizing', () => {
  it('maps the ends of the slider to the ends of the range', () => {
    expect(positionToContext(0, 512, 262144)).toBe(512);
    expect(positionToContext(SLIDER_STEPS, 512, 262144)).toBe(262144);
    expect(contextToPosition(262144, 512, 262144)).toBe(SLIDER_STEPS);
  });

  it('gives everyday sizes real travel and lands on them exactly', () => {
    // On a 256k model, 32k sits two thirds along instead of at 12%.
    const at32k = contextToPosition(32768, 512, 262144);
    expect(at32k).toBeGreaterThan(600);
    expect(positionToContext(at32k, 512, 262144)).toBe(32768);
    for (const size of [4096, 8192, 16384, 65536]) {
      expect(positionToContext(contextToPosition(size, 512, 262144), 512, 262144)).toBe(size);
    }
  });

  it('reads and writes sizes the way people type them', () => {
    expect(parseTokens('32k')).toBe(32768);
    expect(parseTokens('32768')).toBe(32768);
    expect(parseTokens('1M')).toBe(1048576);
    expect(parseTokens('32.768')).toBe(32768);
    expect(parseTokens('auto')).toBeNull();
    expect(shortTokens(262144)).toBe('256k');
    expect(shortTokens(1048576)).toBe('1M');
  });
});
