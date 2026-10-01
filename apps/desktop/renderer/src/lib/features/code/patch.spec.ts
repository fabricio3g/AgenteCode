import { describe, expect, it } from 'vitest';
import { looksLikePatch, parsePatch } from './patch';

describe('parsePatch', () => {
  it('numbers old and new lines and marks the gap between hunks', () => {
    const rows = parsePatch('--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9,1 +9,1 @@\n---x\n+y');
    expect(rows).toEqual([
      { kind: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'b', oldNo: 2 },
      { kind: 'add', text: 'c', newNo: 2 },
      { kind: 'hunk', text: '@@ -9,1 +9,1 @@' },
      { kind: 'del', text: '--x', oldNo: 9 },
      { kind: 'add', text: 'y', newNo: 9 }
    ]);
  });

  it('reads a bare +/- listing without numbers', () => {
    expect(parsePatch('+new\n-old')).toEqual([{ kind: 'add', text: 'new' }, { kind: 'del', text: 'old' }]);
    expect(looksLikePatch('@@ -1 +1 @@')).toBe(true);
    expect(looksLikePatch('plain output')).toBe(false);
  });
});
