import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCESSIBILITY, parseAccessibility, stepScale, UI_SCALES } from './accessibility.svelte';

describe('parseAccessibility', () => {
  it('falls back to the defaults for missing or broken data', () => {
    expect(parseAccessibility(null)).toEqual(DEFAULT_ACCESSIBILITY);
    expect(parseAccessibility('{not json')).toEqual(DEFAULT_ACCESSIBILITY);
  });

  it('keeps valid values and drops unknown ones', () => {
    const prefs = parseAccessibility(JSON.stringify({ uiScale: 1.25, font: 'hyperlegible', reduceMotion: 'on', highContrast: true, extra: 1 }));
    expect(prefs).toEqual({ ...DEFAULT_ACCESSIBILITY, uiScale: 1.25, font: 'hyperlegible', reduceMotion: 'on', highContrast: true });
  });

  it('clamps sizes and rejects unknown choices', () => {
    const prefs = parseAccessibility(JSON.stringify({ uiScale: 9, textScale: 'big', font: 'comic', reduceMotion: 'maybe' }));
    expect(prefs.uiScale).toBe(2);
    expect(prefs.textScale).toBe(1);
    expect(prefs.font).toBe('default');
    expect(prefs.reduceMotion).toBe('system');
  });
});

describe('stepScale', () => {
  it('moves between the presets and stops at the ends', () => {
    expect(stepScale(1, 1)).toBe(1.1);
    expect(stepScale(1, -1)).toBe(0.9);
    expect(stepScale(1.5, 1)).toBe(1.75);
    expect(stepScale(2, 1)).toBe(2);
    expect(stepScale(0.9, -1)).toBe(0.9);
  });

  it('reaches the 200% ceiling the accessibility criteria ask for', () => {
    expect(stepScale(1.75, 1)).toBe(2);
    expect(Math.max(...UI_SCALES)).toBe(2);
  });

  it('snaps an in-between size to the next preset', () => {
    expect(stepScale(1.05, 1)).toBe(1.1);
    expect(stepScale(1.05, -1)).toBe(1);
  });
});
