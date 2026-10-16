import { describe, expect, it } from 'vitest';
import { ancestorSelectors, buildLayerTree, layerIndexFor, layerKey, visibleRows, type LayerNode } from './design-layers';
import { findBySelector, scanElements } from './design-source';

const PAGE = `<html><head><style>a{}</style></head><body>
<header class="top nav"><h1 id="t">Title <em>x</em></h1></header>
<main><section class="s"><p>One</p><p>Two</p><svg><path d="M0"/></svg></section>
<ul><li>a</li><li>b</li></ul></main>
<script>1</script></body></html>`;

describe('buildLayerTree', () => {
  const tree = buildLayerTree(PAGE);

  it('lists the body elements, not the head or scripts', () => {
    expect(tree.map((n) => n.tag)).toEqual(['header', 'main']);
    expect(JSON.stringify(tree)).not.toContain('"tag":"style"');
  });

  it('labels with tag and first class, and previews the own text only', () => {
    expect(tree[0].label).toBe('header.top');
    const h1 = tree[0].children[0];
    expect(h1.selector).toBe('#t');
    expect(h1.text).toBe('Title');
  });

  it('writes selectors that resolve back to exactly their element', () => {
    const els = scanElements(PAGE);
    const walk = (nodes: LayerNode[]) => nodes.forEach((n) => {
      const found = findBySelector(els, n.selector);
      expect(found.map((el) => el.index)).toEqual([n.index]);
      walk(n.children);
    });
    walk(tree);
    expect(tree[1].children[0].children[1].selector).toBe('html > body > main > section.s > p:nth-of-type(2)');
  });

  it('draws svg as one row', () => {
    const svg = tree[1].children[0].children[2];
    expect(svg.tag).toBe('svg');
    expect(svg.children).toEqual([]);
  });

  it('is empty without a source', () => {
    expect(buildLayerTree(undefined)).toEqual([]);
  });
});

describe('layerIndexFor / ancestorSelectors', () => {
  it('matches a picker selector to its row and finds the way down', () => {
    const tree = buildLayerTree(PAGE);
    const index = layerIndexFor(PAGE, 'section.s > p:nth-of-type(2)')!;
    expect(index).toBe(tree[1].children[0].children[1].index);
    expect(ancestorSelectors(tree, index)).toEqual([tree[1].selector, tree[1].children[0].selector]);
    expect(layerIndexFor(PAGE, 'p')).toBeNull();
  });
});

describe('visibleRows + layerKey', () => {
  const tree = buildLayerTree(PAGE);

  it('opens the top level by default and honours overrides', () => {
    const rows = visibleRows(tree, {});
    expect(rows.map((r) => r.node.label)).toEqual(['header.top', 'h1', 'main', 'section.s', 'ul']);
    const open = visibleRows(tree, { [tree[1].children[0].selector]: true });
    expect(open.map((r) => r.node.tag)).toContain('p');
    const shut = visibleRows(tree, { [tree[1].selector]: false });
    expect(shut.map((r) => r.node.tag)).toEqual(['header', 'h1', 'main']);
  });

  it('moves with arrows, clamped at both ends', () => {
    const rows = visibleRows(tree, {});
    expect(layerKey(rows, 0, 'ArrowDown')).toEqual({ focus: 1 });
    expect(layerKey(rows, 0, 'ArrowUp')).toEqual({ focus: 0 });
    expect(layerKey(rows, 4, 'ArrowDown')).toEqual({ focus: 4 });
    expect(layerKey(rows, 2, 'End')).toEqual({ focus: 4 });
    expect(layerKey(rows, 2, 'x')).toBeNull();
  });

  it('opens with Right, enters an open row, folds with Left, then climbs', () => {
    const rows = visibleRows(tree, {});
    const section = rows.findIndex((r) => r.node.label === 'section.s');
    expect(layerKey(rows, section, 'ArrowRight')).toEqual({ focus: section, toggle: { selector: rows[section].node.selector, open: true } });
    const main = rows.findIndex((r) => r.node.label === 'main');
    expect(layerKey(rows, main, 'ArrowRight')).toEqual({ focus: main + 1 });
    expect(layerKey(rows, main, 'ArrowLeft')).toEqual({ focus: main, toggle: { selector: rows[main].node.selector, open: false } });
    expect(layerKey(rows, rows.findIndex((r) => r.node.label === 'ul'), 'ArrowLeft')).toEqual({ focus: main });
  });

  it('selects with Enter', () => {
    const rows = visibleRows(tree, {});
    expect(layerKey(rows, 1, 'Enter')).toEqual({ focus: 1, select: true });
    expect(layerKey([], 0, 'Enter')).toBeNull();
  });
});
