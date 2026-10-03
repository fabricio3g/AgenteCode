import { describe, expect, it } from 'vitest';
import { ancestorDirs, buildTree, firstChildPath, parentPath, visibleRows } from './file-tree';

describe('the explorer tree', () => {
  it('nests paths and sorts folders first, then names', () => {
    const tree = buildTree(['src/lib/b.ts', 'src/a.ts', 'README.md', 'src/lib/a.ts', 'src/zeta/deep/f.ts']);
    expect(tree.map((node) => node.name)).toEqual(['src', 'README.md']);
    const src = tree[0]!;
    expect(src.dir).toBe(true);
    expect(src.children.map((node) => node.name)).toEqual(['lib', 'zeta', 'a.ts']);
    expect(src.children[0]!.children.map((node) => `${node.path}:${node.dir}`)).toEqual(['src/lib/a.ts:false', 'src/lib/b.ts:false']);
    expect(tree[1]!.path).toBe('README.md');
  });

  it('shares one folder node between files that live in it', () => {
    const tree = buildTree(['a/b/c.ts', 'a/b/d.ts', 'a/e.ts']);
    const a = tree[0]!;
    const b = a.children[0]!;
    expect(a.children.map((node) => node.name)).toEqual(['b', 'e.ts']);
    expect(b.children.map((node) => node.path)).toEqual(['a/b/c.ts', 'a/b/d.ts']);
  });

  it('normalizes separators and ignores blank or root-only entries', () => {
    const tree = buildTree(['src\\win.ts', '', '/', 'src//double.ts']);
    expect(tree.map((node) => node.path)).toEqual(['src']);
    expect(tree[0]!.children.map((node) => node.path)).toEqual(['src/double.ts', 'src/win.ts']);
  });

  it('paints only the rows the open folders reach', () => {
    const tree = buildTree(['src/a.ts', 'src/lib/b.ts', 'top.ts']);
    expect(visibleRows(tree, new Set()).map((row) => row.node.path)).toEqual(['src', 'top.ts']);

    const openSrc = visibleRows(tree, new Set(['src']));
    expect(openSrc.map((row) => `${row.depth}:${row.node.path}`)).toEqual(['0:src', '1:src/lib', '1:src/a.ts', '0:top.ts']);
    expect(openSrc[0]!.expanded).toBe(true);
    expect(openSrc[1]!.expanded).toBe(false);

    expect(visibleRows(tree, new Set(['src', 'src/lib'])).map((row) => row.node.path)).toEqual(['src', 'src/lib', 'src/lib/b.ts', 'src/a.ts', 'top.ts']);
  });
});

describe('tree navigation helpers', () => {
  it('walks to the parent and lists an ancestor chain', () => {
    expect(parentPath('src/lib/a.ts')).toBe('src/lib');
    expect(parentPath('a.ts')).toBeNull();
    expect(ancestorDirs('src/lib/a.ts')).toEqual(['src', 'src/lib']);
    expect(ancestorDirs('a.ts')).toEqual([]);
  });

  it('opens into the first child, or nowhere for a file', () => {
    const tree = buildTree(['src/a.ts', 'top.ts']);
    expect(firstChildPath(tree[0]!)).toBe('src/a.ts');
    expect(firstChildPath(tree[1]!)).toBeNull();
  });
});
