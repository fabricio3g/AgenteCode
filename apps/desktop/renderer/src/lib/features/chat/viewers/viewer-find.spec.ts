// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { findTextRanges } from './viewer-find.svelte';
describe('safe viewer text search', () => {
  it('finds phrases across formatting without rewriting links or attributes', () => {
    const root = document.createElement('article'); root.innerHTML = '<p><a href="https://example.com/rate">Growth <b>rate</b></a> is 12.5%</p>';
    const before = root.innerHTML;
    const hits = findTextRanges(root, 'Growth rate');
    expect(hits.map((hit) => hit.toString())).toEqual(['Growth rate']);
    expect(root.innerHTML).toBe(before);
    expect(findTextRanges(root, 'https://example.com')).toEqual([]);
  });
  it('does not join unrelated paragraphs or interpret a query as regex', () => {
    const root = document.createElement('article'); root.innerHTML = '<p>first</p><p>second $42 [a]</p>';
    expect(findTextRanges(root, 'firstsecond')).toHaveLength(0);
    expect(findTextRanges(root, '$42 [a]')).toHaveLength(1);
  });
});
