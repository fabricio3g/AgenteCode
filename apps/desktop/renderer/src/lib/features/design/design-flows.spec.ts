import { describe, expect, it } from 'vitest';
import { flowPath, hasLink, MAX_FLOW_LINKS, parseFlowLinks, parseFlows, pruneLinks, serializeFlows, toggleLink } from '$shared/design-flows';

const pages = ['index.html', 'pricing.html', 'variants/bold/index.html'];

describe('parseFlows', () => {
  it('reads { links } and a bare list, dropping what is wrong', () => {
    const text = JSON.stringify({ links: [
      { from: 'index.html', to: 'pricing.html' },
      { from: 'index.html', to: 'pricing.html' },
      { from: 'index.html', to: 'index.html' },
      { from: 'index.html', to: 'gone.html' },
      { from: '../x.html', to: 'pricing.html' },
      { from: 'pricing.html', to: 'variants/bold/index.html' },
      { from: 1, to: 'pricing.html' }
    ] });
    expect(parseFlows(text, pages)).toEqual([{ from: 'index.html', to: 'pricing.html' }, { from: 'pricing.html', to: 'variants/bold/index.html' }]);
    expect(parseFlows(JSON.stringify([{ from: 'index.html', to: 'pricing.html' }]), pages)).toHaveLength(1);
  });
  it('answers no links for missing or broken text', () => {
    expect(parseFlows(undefined)).toEqual([]);
    expect(parseFlows('{nope')).toEqual([]);
    expect(parseFlows('{"links":"x"}')).toEqual([]);
  });
  it('caps the list', () => {
    const many = Array.from({ length: MAX_FLOW_LINKS + 20 }, (_, i) => ({ from: 'index.html', to: `p${i}.html` }));
    expect(parseFlowLinks(many)).toHaveLength(MAX_FLOW_LINKS);
  });
});

describe('parseFlowLinks strict', () => {
  it('throws on the first bad link instead of dropping it', () => {
    expect(() => parseFlowLinks([{ from: 'index.html', to: 'gone.html' }], pages, true)).toThrow(/Unknown page/);
    expect(() => parseFlowLinks([{ from: 'index.html', to: 'index.html' }], pages, true)).toThrow(/itself/);
    expect(() => parseFlowLinks([{ from: 'a' }], pages, true)).toThrow(/needs/);
    expect(() => parseFlowLinks('x', pages, true)).toThrow(/list/);
    expect(parseFlowLinks([{ from: 'index.html', to: 'pricing.html' }], pages, true)).toHaveLength(1);
  });
});

describe('link edits', () => {
  it('toggles a link and round-trips through the file text', () => {
    const one = toggleLink([], 'index.html', 'pricing.html');
    expect(hasLink(one, 'index.html', 'pricing.html')).toBe(true);
    expect(hasLink(one, 'pricing.html', 'index.html')).toBe(false);
    expect(parseFlows(serializeFlows(one), pages)).toEqual(one);
    expect(toggleLink(one, 'index.html', 'pricing.html')).toEqual([]);
    expect(toggleLink(one, 'index.html', 'index.html')).toEqual(one);
  });
  it('prunes links to deleted pages', () => {
    const links = [{ from: 'index.html', to: 'pricing.html' }, { from: 'index.html', to: 'gone.html' }];
    expect(pruneLinks(links, pages)).toEqual([links[0]]);
  });
});

describe('flowPath', () => {
  const a = { left: 0, top: 0, width: 100, height: 100 };
  it('leaves the facing side: right of a to left of b when b is to the right', () => {
    const path = flowPath(a, { left: 300, top: 0, width: 100, height: 100 });
    expect(path.d.startsWith('M100 50C')).toBe(true);
    expect(path.x).toBe(300);
    expect(path.y).toBe(50);
    expect(path.angle).toBe(0);
  });
  it('goes the other way when b is to the left', () => {
    const path = flowPath({ ...a, left: 300 }, a);
    expect(path.d.startsWith('M300 50C')).toBe(true);
    expect(Math.abs(path.angle)).toBe(180);
  });
  it('uses top and bottom for a frame straight below', () => {
    const path = flowPath(a, { left: 0, top: 300, width: 100, height: 100 });
    expect(path.d.startsWith('M50 100C')).toBe(true);
    expect(path.y).toBe(300);
    expect(path.angle).toBe(90);
  });
});
