import { describe, expect, it } from 'vitest';
import { activatePanel, clampRect, dockFloating, dockPanel, dropEdge, filterNode, floatPanel, groups, measureWorkspace, panelIds, parseWorkspaceLayout, projectedSplitRatio, resizeCorners, resizeRect, setSplitRatio, type WorkspaceLayout } from './workspace-layout';
import { browserViewBounds } from '$shared/browser-presentation';

const bounds = { x: 0, y: 0, width: 1200, height: 800 };
const empty = (): WorkspaceLayout => parseWorkspaceLayout('{"version":1}');
const ids = (layout: WorkspaceLayout) => [...panelIds(layout.right), ...panelIds(layout.bottom), ...layout.floating.flatMap((item) => panelIds(item.group))];

describe('workspace layout', () => {
  it('migrates dock sizes, relative heights and visibility', () => {
    const layout = parseWorkspaceLayout(null, '{"width":530,"weights":{"browser":2,"changes":1}}', '{"bottomHeight":310,"changesOpen":true,"bottomOpen":true}');
    expect(layout.rightWidth).toBe(530); expect(layout.bottomHeight).toBe(310);
    expect(layout.open).toEqual(['changes', 'processes']);
    const measured = measureWorkspace(layout, { ...bounds, height: 1200 }, new Set(['changes', 'browser']));
    expect(measured.placements[1].rect.height / measured.placements[0].rect.height).toBeCloseTo(2);
  });
  it('sanitizes corrupt storage, duplicate IDs, malformed dimensions and old PTYs', () => {
    expect(parseWorkspaceLayout('null').rightWidth).toBe(460);
    expect(parseWorkspaceLayout('[]').bottomHeight).toBe(260);
    const layout = parseWorkspaceLayout(JSON.stringify({ version: 1, rightWidth: 'wide', right: { kind: 'group', id: 'g', panels: ['browser', 'browser', 'terminal:old', 'unknown'], active: 'unknown' }, bottom: { kind: 'group', id: 'g2', panels: ['browser', 'processes'], active: 'browser' }, open: ['browser', 'terminal:old', 'browser'], floating: [{ group: { kind: 'group', id: 'g3', panels: ['plan'], active: 'plan' }, rect: { x: 1e9, width: -20 } }] }));
    expect(ids(layout)).toEqual(['browser', 'processes', 'plan']); expect(layout.open).toEqual(['browser']);
    expect(layout.rightWidth).toBe(460); expect(layout.floating[0].rect.width).toBe(240);
  });
  it('moves a panel through splits, tabs and floating groups without duplicating it', () => {
    let layout = dockPanel(empty(), 'browser', 'right');
    layout = dockPanel(layout, 'changes', 'right', groups(layout.right)[0].id, 'bottom');
    expect(layout.right?.kind).toBe('split');
    layout = dockPanel(layout, 'changes', 'right', groups(layout.right)[0].id, 'center');
    expect(layout.right?.kind).toBe('group'); expect(groups(layout.right)[0].active).toBe('changes');
    layout = floatPanel(layout, 'changes', { x: 60, y: 60, width: 400, height: 300 });
    layout = dockFloating(layout, 'browser', layout.floating[0].group.id, 'left');
    expect(layout.right).toBeNull(); expect(layout.floating[0].group.kind).toBe('split');
    layout = dockPanel(layout, 'changes', 'bottom');
    expect(ids(layout).sort()).toEqual(['browser', 'changes']); expect(new Set(ids(layout)).size).toBe(2);
    expect(layout.floating[0].group.kind).toBe('group');
  });
  it('restores placement, group selection, maximization and stacking order', () => {
    let layout = dockPanel(empty(), 'browser', 'right');
    layout = dockPanel(layout, 'plan', 'right', groups(layout.right)[0].id);
    layout = activatePanel(layout, 'browser');
    layout = floatPanel(layout, 'changes', { x: 80, y: 90, width: 400, height: 350 });
    layout.floating[0].maximized = true; layout.open = ['browser', 'changes'];
    expect(parseWorkspaceLayout(JSON.stringify(layout))).toEqual(layout);
  });
  it('temporarily groups undersized splits without mutating the saved arrangement', () => {
    let layout = dockPanel(empty(), 'browser', 'right');
    layout = dockPanel(layout, 'changes', 'right', groups(layout.right)[0].id, 'right');
    const snapshot = JSON.stringify(layout);
    const compact = measureWorkspace(layout, bounds, new Set(['browser', 'changes']), 'changes');
    expect(compact.placements).toHaveLength(1); expect(compact.placements[0].group.active).toBe('changes');
    const wide = measureWorkspace({ ...layout, rightWidth: 600 }, bounds, new Set(['browser', 'changes']));
    expect(wide.placements).toHaveLength(2); expect(JSON.stringify(layout)).toBe(snapshot);
    expect(filterNode(layout.right, new Set(['changes']))?.kind).toBe('group');
  });
  it('provides both outer resize axes with a single panel', () => {
    const layout = dockPanel(empty(), 'browser', 'right');
    const measured = measureWorkspace({ ...layout, rightHeight: 360 }, bounds, new Set(['browser']));
    expect(measured.dividers.map((item) => item.outer)).toEqual(['rightWidth', 'rightHeight', 'rightTop']);
    expect(measured.placements[0].rect.height).toBe(360);
  });
  it('keeps split ratios and every floating resize direction inside the workspace', () => {
    let layout = dockPanel(empty(), 'browser', 'right');
    layout = dockPanel(layout, 'changes', 'right', groups(layout.right)[0].id, 'bottom');
    const split = layout.right!;
    expect(setSplitRatio(split, split.id, 20)?.kind).toBe('split');
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const rect = resizeRect({ x: 100, y: 100, width: 400, height: 300 }, edge, -1000, 1000, bounds);
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.width); expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.height);
      expect(rect.width).toBeGreaterThanOrEqual(240); expect(rect.height).toBeGreaterThanOrEqual(140);
    }
    expect(clampRect({ x: 500, y: 500, width: 800, height: 500 }, { x: 0, y: 0, width: 200, height: 100 })).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
  it('preserves resize continuity when hidden panels change the displayed split ratio', () => {
    const layout = parseWorkspaceLayout(null);
    const visible = new Set(['changes', 'browser']);
    const projected = filterNode(layout.right, visible)!;
    const ratio = projectedSplitRatio(layout.right, projected.id, visible, 0.65);
    const next = setSplitRatio(layout.right, projected.id, ratio);
    const shown = filterNode(next, visible);
    expect(shown?.kind === 'split' && shown.ratio).toBeCloseTo(0.65);
    const measured = measureWorkspace(layout, bounds, visible);
    const corners = resizeCorners(measured.dividers, bounds);
    expect(corners).toHaveLength(3);
    expect(corners[0].x.outer).toBe('rightWidth');
    expect(corners[0].y.outer).toBeUndefined();
  });
  it('maps central and edge drops consistently', () => {
    expect(dropEdge(bounds, 600, 400)).toBe('center'); expect(dropEdge(bounds, 10, 400)).toBe('left');
    expect(dropEdge(bounds, 1190, 400)).toBe('right'); expect(dropEdge(bounds, 600, 10)).toBe('top'); expect(dropEdge(bounds, 600, 790)).toBe('bottom');
  });
});

describe('native browser presentation geometry', () => {
  it('converts CSS rectangles to native coordinates at UI scale without applying display DPI', () => {
    for (const zoom of [0.5, 1, 1.25, 1.5, 2]) expect(browserViewBounds({ x: 40, y: 60, width: 200, height: 80 }, zoom, bounds)).toEqual({ x: 40 * zoom, y: 60 * zoom, width: 200 * zoom, height: 80 * zoom });
  });
  it('clips to the window and accepts a viewport shorter than 200 pixels', () => {
    expect(browserViewBounds({ x: 1180, y: 780, width: 80, height: 90 }, 1, bounds)).toEqual({ x: 1180, y: 780, width: 20, height: 20 });
    expect(browserViewBounds({ x: -10, y: -20, width: 100, height: 100 }, 1, bounds)).toEqual({ x: 0, y: 0, width: 90, height: 80 });
    expect(browserViewBounds({ x: 0, y: 0, width: NaN, height: 100 }, 1, bounds)).toBeNull();
    expect(browserViewBounds(null, 1, bounds)).toBeNull();
  });
});
