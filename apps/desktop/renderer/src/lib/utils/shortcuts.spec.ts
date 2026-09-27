import { describe, expect, it } from 'vitest';
import { formatShortcut } from './shortcuts';

describe('formatShortcut', () => {
  it('spells modifiers for the platform', () => {
    expect(formatShortcut('mod+shift+k', true)).toBe('⌘⇧K');
    expect(formatShortcut('mod+shift+k', false)).toBe('Ctrl+Shift+K');
    expect(formatShortcut('escape', false)).toBe('Esc');
    expect(formatShortcut('F2', true)).toBe('F2');
  });
});
