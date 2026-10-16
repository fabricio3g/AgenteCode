import { describe, expect, it } from 'vitest';
import { parseTokens, tokensFor } from './design-tokens';
import { colorValue, isSafeTokenValue, parseTweaks, rangeText, rangeValue, resolveTweaks } from './design-tweaks';

const FILE = JSON.stringify([
  { id: 'radius', label: 'Corner radius', type: 'range', var: '--radius', min: 0, max: 24, step: 2, unit: 'px', value: 8 },
  { id: 'accent', label: 'Accent', type: 'color', var: '--accent', value: '#e76d1f' },
  { id: 'density', label: 'Density', type: 'choice', var: '--density', options: ['compact', { value: 'roomy', label: 'Roomy' }] },
  { id: 'radius', type: 'color', var: '--dup' },
  { id: 'bad1', type: 'range', var: 'radius', min: 0, max: 1 },
  { id: 'bad2', type: 'range', var: '--x', min: 5, max: 1 },
  { id: 'bad3', type: 'choice', var: '--y', options: ['one'] },
  { id: 'bad4', type: 'slider', var: '--z' },
  'nope'
]);

describe('parseTweaks', () => {
  it('keeps well-formed tweaks and drops the rest', () => {
    const tweaks = parseTweaks(FILE);
    expect(tweaks.map((t) => t.id)).toEqual(['radius', 'accent', 'density']);
    expect(tweaks[0]).toMatchObject({ cssVar: '--radius', min: 0, max: 24, step: 2, unit: 'px' });
    expect(tweaks[2].options).toEqual([{ value: 'compact', label: 'compact' }, { value: 'roomy', label: 'Roomy' }]);
  });
  it('accepts an object with a tweaks array, and survives bad JSON', () => {
    expect(parseTweaks(JSON.stringify({ tweaks: [{ type: 'color', var: '--c' }] }))).toHaveLength(1);
    expect(parseTweaks('{oops')).toEqual([]);
    expect(parseTweaks(undefined)).toEqual([]);
  });
  it('drops option values that could end the declaration', () => {
    const t = parseTweaks(JSON.stringify([{ type: 'choice', var: '--d', options: ['a', 'b; c', 'x}', 'd'] }]));
    expect(t[0].options?.map((o) => o.value)).toEqual(['a', 'd']);
  });
});

describe('resolveTweaks', () => {
  const css = ':root { --radius: 12px; --accent: #112233; }';
  const light = tokensFor(parseTokens(css), 'light');
  const resolved = resolveTweaks(parseTweaks(FILE), light);

  it('shows only tweaks whose property is declared, with the current value', () => {
    expect(resolved.map((r) => [r.tweak.id, r.current])).toEqual([['radius', '12px'], ['accent', '#112233']]);
  });
  it('reads and writes range values with the unit and step precision', () => {
    expect(rangeValue(resolved[0])).toBe(12);
    expect(rangeText(resolved[0].tweak, 13.9)).toBe('14px');
    expect(rangeText(resolved[0].tweak, 99)).toBe('24px');
    expect(rangeText({ ...resolved[0].tweak, step: 0.1, unit: 'rem', max: 4 }, 1.2500001)).toBe('1.3rem');
  });
  it('gives a colour as hex', () => {
    expect(colorValue(resolved[1])).toBe('#112233');
  });
  it('guards what is written', () => {
    expect(isSafeTokenValue('12px')).toBe(true);
    expect(isSafeTokenValue('1; x')).toBe(false);
  });
});
