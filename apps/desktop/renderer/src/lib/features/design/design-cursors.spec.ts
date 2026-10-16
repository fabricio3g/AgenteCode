import { describe, expect, it } from 'vitest';
import { toolCursor } from './design-cursors';
import { PICKER_SOURCE } from './design-picker';

describe('canvas cursors', () => {
  it('leaves the page its own cursor while browsing', () => {
    expect(toolCursor('browse')).toBe('');
  });

  it('gives each pointing tool its own badge on the same arrow, tip as the hotspot', () => {
    const select = toolCursor('select');
    const comment = toolCursor('comment');
    const draw = toolCursor('draw');
    for (const cursor of [select, comment, draw]) {
      expect(cursor).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) 4 3, crosshair$/);
      // The value travels into the frame's stylesheet: nothing in it may close the rule.
      expect(cursor).not.toMatch(/[;{}]/);
    }
    expect(select).not.toBe(comment);
    expect(draw).not.toBe(select);
    expect(decodeURIComponent(select)).toContain('#e76d1f');
  });

  it('draws the picker in the brand ember, never the old blue, and takes the cursor from the host', () => {
    expect(PICKER_SOURCE).not.toContain('#4f6bed');
    expect(PICKER_SOURCE).toContain('#e76d1f');
    expect(PICKER_SOURCE).toContain('setMode(data.tool, data.cursor)');
  });
});
