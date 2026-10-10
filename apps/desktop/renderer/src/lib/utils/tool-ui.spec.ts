import { describe, expect, it } from 'vitest';
import { activityColor } from './tool-ui';

describe('activityColor', () => {
  it('gives each task its own hue', () => {
    expect(activityColor('searching')).toBe('var(--accent-sky)');
    expect(activityColor('reading')).toBe('var(--accent-green)');
    expect(activityColor('writing')).toBe('var(--accent-violet)');
    expect(activityColor('creating_files')).toBe('var(--accent-violet)');
    expect(activityColor('planning')).toBe('var(--accent-amber)');
  });

  it('leaves the brand default for runs without a task colour', () => {
    expect(activityColor(undefined)).toBe('');
    expect(activityColor(null)).toBe('');
    expect(activityColor('stopped')).toBe('');
    expect(activityColor('completed')).toBe('');
  });
});
