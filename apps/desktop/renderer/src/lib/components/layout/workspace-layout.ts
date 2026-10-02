/** Geometry and immutable layout operations, shared by mouse, keyboard and persistence. */
export type Region = 'right' | 'bottom';
export type DockEdge = 'left' | 'right' | 'top' | 'bottom' | 'center';
export interface Rect { x: number; y: number; width: number; height: number }
export interface PanelGroup { kind: 'group'; id: string; panels: string[]; active: string }
export interface PanelSplit { kind: 'split'; id: string; axis: 'x' | 'y'; ratio: number; a: DockNode; b: DockNode }
export type DockNode = PanelGroup | PanelSplit;
export interface FloatingGroup { group: DockNode; rect: Rect; z: number; maximized: boolean }
export interface WorkspaceLayout {
  version: 1;
  right: DockNode | null;
  bottom: DockNode | null;
  rightWidth: number;
  rightTop: number;
  rightHeight: number | null;
  bottomHeight: number;
  bottomWidth: number | null;
  floating: FloatingGroup[];
  open: string[];
}
export interface Placement { group: PanelGroup; groupIds: string[]; rect: Rect; region: Region | null; z: number; maximized: boolean; floatingId?: string }
export interface Divider { id: string; axis: 'x' | 'y'; rect: Rect; length: number; ratio?: number; region: Region | null; floatingId?: string; outer?: 'rightWidth' | 'rightHeight' | 'rightTop' | 'bottomWidth' | 'bottomHeight' }
export interface ResizeCorner { id: string; rect: Rect; edge: string; x: Divider; y: Divider }
/** Combine intersecting dock splitters so a corner changes both dimensions. */
export function resizeCorners(dividers: Divider[], bounds: Rect): ResizeCorner[] {
  const result: ResizeCorner[] = [];
  for (const x of dividers.filter((item) => item.axis === 'x' && item.region)) {
    for (const y of dividers.filter((item) => item.axis === 'y' && item.region === x.region)) {
      const cx = x.rect.x + x.rect.width / 2, cy = y.rect.y + y.rect.height / 2;
      if (cx < y.rect.x - 1 || cx > y.rect.x + y.rect.width + 1 || cy < x.rect.y - 1 || cy > x.rect.y + x.rect.height + 1) continue;
      result.push({ id: `${x.id}:${y.id}`, x, y, edge: `${y.outer === 'bottomHeight' || y.outer === 'rightTop' ? 'n' : 's'}${x.outer === 'rightWidth' ? 'w' : 'e'}`, rect: {
        x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - 24, cx - 12)),
        y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - 24, cy - 12)), width: 24, height: 24
      } });
    }
  }
  return result;
}
const GAP = 4;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 140;
const known = new Set(['changes', 'plan', 'browser', 'artifact', 'routines', 'processes']);
const validId = (id: unknown): id is string => typeof id === 'string' && (known.has(id) || /^terminal:[\w-]+$/.test(id));
const finite = (value: unknown, fallback: number, min = 1, max = 10000) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const json = (raw: string | null): Record<string, unknown> => {
  try { const value = JSON.parse(raw || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
};
export const group = (id: string): PanelGroup => ({ kind: 'group', id: `group:${id}:${crypto.randomUUID()}`, panels: [id], active: id });
export function panelIds(node: DockNode | null): string[] {
  return !node ? [] : node.kind === 'group' ? node.panels : [...panelIds(node.a), ...panelIds(node.b)];
}
export function groups(node: DockNode | null): PanelGroup[] {
  return !node ? [] : node.kind === 'group' ? [node] : [...groups(node.a), ...groups(node.b)];
}
function join(a: DockNode | null, b: DockNode | null, original: PanelSplit): DockNode | null {
  return a && b ? { ...original, a, b } : a ?? b;
}
export function filterNode(node: DockNode | null, visible: Set<string>): DockNode | null {
  function project(current: DockNode | null): { node: DockNode | null; share: number } {
    if (!current) return { node: null, share: 0 };
    if (current.kind === 'split') {
      const a = project(current.a), b = project(current.b);
      const ashare = a.share * current.ratio, bshare = b.share * (1 - current.ratio), share = ashare + bshare;
      return { node: join(a.node, b.node, { ...current, ratio: share ? ashare / share : current.ratio }), share };
    }
    const panels = current.panels.filter((id) => visible.has(id));
    return { node: panels.length ? { ...current, panels, active: panels.includes(current.active) ? current.active : panels[0] } : null, share: panels.length ? 1 : 0 };
  }
  return project(node).node;
}
export function removePanel(node: DockNode | null, id: string): DockNode | null {
  return filterNode(node, new Set(panelIds(node).filter((panel) => panel !== id)));
}
function insert(node: DockNode, target: string, added: DockNode, edge: DockEdge): DockNode {
  if (node.kind === 'split') return { ...node, a: insert(node.a, target, added, edge), b: insert(node.b, target, added, edge) };
  if (node.id !== target) return node;
  if (edge === 'center') return { ...node, panels: [...node.panels, ...panelIds(added)], active: groups(added)[0].active };
  const first = edge === 'left' || edge === 'top';
  return { kind: 'split', id: `split:${added.id}:${target}:${edge}`, axis: edge === 'left' || edge === 'right' ? 'x' : 'y', ratio: 0.5, a: first ? added : node, b: first ? node : added };
}
function detached(layout: WorkspaceLayout, id: string): WorkspaceLayout {
  return { ...layout, right: removePanel(layout.right, id), bottom: removePanel(layout.bottom, id), floating: layout.floating.flatMap((item) => {
    const next = removePanel(item.group, id);
    return next ? [{ ...item, group: next }] : [];
  }) };
}
export function forgetPanel(layout: WorkspaceLayout, id: string): WorkspaceLayout { return { ...detached(layout, id), open: layout.open.filter((panel) => panel !== id) }; }
export function dockPanel(layout: WorkspaceLayout, id: string, region: Region, target?: string, edge: DockEdge = 'center'): WorkspaceLayout {
  if (target && groups(layout[region]).some((item) => item.id === target && item.panels.length === 1 && item.panels[0] === id)) return layout;
  const next = detached(layout, id);
  const root = next[region];
  const match = groups(root).find((item) => item.id === target);
  return { ...next, [region]: root ? insert(root, match?.id ?? groups(root).at(-1)!.id, group(id), target && match ? edge : region === 'right' ? 'bottom' : 'center') : group(id) };
}
export function floatPanel(layout: WorkspaceLayout, id: string, rect: Rect): WorkspaceLayout {
  const next = detached(layout, id);
  return { ...next, floating: [...next.floating, { group: group(id), rect, z: Math.max(0, ...layout.floating.map((item) => item.z)) + 1, maximized: false }] };
}
export function dockFloating(layout: WorkspaceLayout, id: string, target: string, edge: DockEdge): WorkspaceLayout {
  const item = layout.floating.find((entry) => groups(entry.group).some((leaf) => leaf.id === target));
  if (!item || (panelIds(item.group).length === 1 && panelIds(item.group)[0] === id)) return layout;
  const next = detached(layout, id);
  return { ...next, floating: next.floating.map((entry) => groups(entry.group).some((leaf) => leaf.id === target) ? { ...entry, group: insert(entry.group, target, group(id), edge) } : entry) };
}
export function dockFloatingGroup(layout: WorkspaceLayout, floatingId: string, region: Region | null, target?: string, edge: DockEdge = 'center'): WorkspaceLayout {
  const item = layout.floating.find((entry) => entry.group.id === floatingId);
  if (!item) return layout;
  const next = { ...layout, floating: layout.floating.filter((entry) => entry !== item) };
  if (region) {
    const root = next[region], match = groups(root).find((leaf) => leaf.id === target);
    return { ...next, [region]: root ? insert(root, match?.id ?? groups(root).at(-1)!.id, item.group, match ? edge : region === 'right' ? 'bottom' : 'center') : item.group };
  }
  return { ...next, floating: next.floating.map((entry) => groups(entry.group).some((leaf) => leaf.id === target) ? { ...entry, group: insert(entry.group, target!, item.group, edge) } : entry) };
}
export function activatePanel(layout: WorkspaceLayout, id: string): WorkspaceLayout {
  const activate = (node: DockNode | null): DockNode | null => !node ? null : node.kind === 'split'
    ? { ...node, a: activate(node.a)!, b: activate(node.b)! }
    : node.panels.includes(id) ? { ...node, active: id } : node;
  return { ...layout, right: activate(layout.right), bottom: activate(layout.bottom), floating: layout.floating.map((item) => ({ ...item, group: activate(item.group)! })) };
}
export function setSplitRatio(node: DockNode | null, id: string, ratio: number): DockNode | null {
  if (!node || node.kind === 'group') return node;
  return node.id === id ? { ...node, ratio: finite(ratio, 0.5, 0.05, 0.95) } : { ...node, a: setSplitRatio(node.a, id, ratio)!, b: setSplitRatio(node.b, id, ratio)! };
}
export function findSplit(node: DockNode | null, id: string): PanelSplit | null {
  if (!node || node.kind === 'group') return null;
  return node.id === id ? node : findSplit(node.a, id) ?? findSplit(node.b, id);
}
export function projectedSplitRatio(node: DockNode | null, id: string, visible: Set<string>, ratio: number): number {
  const split = findSplit(node, id);
  function share(current: DockNode): number {
    return current.kind === 'group' ? Number(current.panels.some((panel) => visible.has(panel))) : current.ratio * share(current.a) + (1 - current.ratio) * share(current.b);
  }
  if (!split) return ratio;
  const a = share(split.a), b = share(split.b);
  return a && b ? ratio * b / (a * (1 - ratio) + ratio * b) : ratio;
}
export function clampRect(rect: Rect, bounds: Rect): Rect {
  const width = Math.min(bounds.width, finite(rect.width, 560, Math.min(MIN_WIDTH, bounds.width)));
  const height = Math.min(bounds.height, finite(rect.height, 360, Math.min(MIN_HEIGHT, bounds.height)));
  return { width, height, x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, finite(rect.x, bounds.x, -10000))), y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, finite(rect.y, bounds.y, -10000))) };
}
export function resizeRect(start: Rect, edge: string, dx: number, dy: number, bounds: Rect): Rect {
  let { x, y, width, height } = start;
  if (edge.includes('e')) width = Math.max(Math.min(MIN_WIDTH, bounds.width), Math.min(bounds.x + bounds.width - x, width + dx));
  if (edge.includes('s')) height = Math.max(Math.min(MIN_HEIGHT, bounds.height), Math.min(bounds.y + bounds.height - y, height + dy));
  if (edge.includes('w')) { const next = Math.max(bounds.x, Math.min(x + width - Math.min(MIN_WIDTH, bounds.width), x + dx)); width += x - next; x = next; }
  if (edge.includes('n')) { const next = Math.max(bounds.y, Math.min(y + height - Math.min(MIN_HEIGHT, bounds.height), y + dy)); height += y - next; y = next; }
  return clampRect({ x, y, width, height }, bounds);
}
/** Read saved layout and migrate the two previous stores. PTYs do not survive restart. */
export function parseWorkspaceLayout(raw: string | null, oldRight: string | null = null, oldBottom: string | null = null): WorkspaceLayout {
  const saved = json(raw), right = json(oldRight), bottom = json(oldBottom);
  const seen = new Set<string>();
  const seenNodes = new Set<string>();
  function node(value: unknown, depth = 0): DockNode | null {
    if (!value || typeof value !== 'object' || depth > 32) return null;
    const data = value as Record<string, unknown>;
    if (typeof data.id !== 'string' || seenNodes.has(data.id)) return null;
    seenNodes.add(data.id);
    if (data.kind === 'split') {
      const a = node(data.a, depth + 1), b = node(data.b, depth + 1);
      return a && b ? { kind: 'split', id: data.id, axis: data.axis === 'x' ? 'x' : 'y', ratio: finite(data.ratio, 0.5, 0.05, 0.95), a, b } : a ?? b;
    }
    if (data.kind !== 'group' || !Array.isArray(data.panels)) return null;
    const panels = data.panels.filter((id): id is string => {
      if (!validId(id) || id.startsWith('terminal:') || seen.has(id)) return false;
      seen.add(id); return true;
    });
    return panels.length ? { kind: 'group', id: data.id, panels, active: panels.includes(String(data.active)) ? String(data.active) : panels[0] } : null;
  }
  const modern = saved.version === 1;
  let layout: WorkspaceLayout = {
    version: 1, right: modern ? node(saved.right) : null, bottom: modern ? node(saved.bottom) : null,
    rightWidth: finite(modern ? saved.rightWidth : right.width, 460, MIN_WIDTH),
    rightTop: modern ? finite(saved.rightTop, 0, 0) : 0,
    rightHeight: modern && typeof saved.rightHeight === 'number' ? finite(saved.rightHeight, 360, MIN_HEIGHT) : null,
    bottomHeight: finite(modern ? saved.bottomHeight : bottom.bottomHeight, 260, MIN_HEIGHT),
    bottomWidth: modern && typeof saved.bottomWidth === 'number' ? finite(saved.bottomWidth, 560, MIN_WIDTH) : null,
    floating: [], open: modern && Array.isArray(saved.open) ? [...new Set(saved.open.filter((id): id is string => validId(id) && !id.startsWith('terminal:')))] : [ ...(bottom.changesOpen === true ? ['changes'] : []), ...(bottom.bottomOpen === true ? ['processes'] : []) ]
  };
  if (modern && Array.isArray(saved.floating)) layout.floating = saved.floating.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const data = value as Record<string, unknown>, parsed = node(data.group), rect = data.rect as Partial<Rect> | undefined;
    return parsed ? [{ group: parsed, rect: { x: finite(rect?.x, 40, -10000), y: finite(rect?.y, 40, -10000), width: finite(rect?.width, 560, MIN_WIDTH), height: finite(rect?.height, 360, MIN_HEIGHT) }, z: finite(data.z, 1), maximized: data.maximized === true }] : [];
  });
  if (!modern) {
    const ids = ['changes', 'plan', 'artifact', 'routines', 'browser'];
    const weights = right.weights && typeof right.weights === 'object' ? right.weights as Record<string, unknown> : {};
    let total = 0;
    for (const id of ids) {
      const weight = finite(weights[id], 1, 0.01, 100);
      const added = group(id);
      layout.right = layout.right ? { kind: 'split', id: `migration:${id}`, axis: 'y', ratio: total / (total + weight), a: layout.right, b: added } : added;
      total += weight;
    }
    layout.bottom = group('processes');
  }
  return layout;
}
function minimum(node: DockNode): { width: number; height: number } {
  if (node.kind === 'group') return { width: MIN_WIDTH, height: MIN_HEIGHT };
  const a = minimum(node.a), b = minimum(node.b);
  return node.axis === 'x' ? { width: a.width + b.width + GAP, height: Math.max(a.height, b.height) } : { width: Math.max(a.width, b.width), height: a.height + b.height + GAP };
}
export function measureWorkspace(layout: WorkspaceLayout, bounds: Rect, visible: Set<string>, focused = ''): { main: Rect; placements: Placement[]; dividers: Divider[] } {
  const placements: Placement[] = [], dividers: Divider[] = [];
  const right = filterNode(layout.right, visible), bottom = filterNode(layout.bottom, visible);
  const rw = right ? Math.min(Math.max(MIN_WIDTH, bounds.width - 320), layout.rightWidth, bounds.width) : 0;
  const mainWidth = Math.max(0, bounds.width - rw - (right ? GAP : 0));
  const bh = bottom ? Math.min(layout.bottomHeight, Math.max(MIN_HEIGHT, bounds.height - 220), bounds.height) : 0;
  const main = { ...bounds, width: mainWidth, height: Math.max(0, bounds.height - bh - (bottom ? GAP : 0)) };
  function walk(node: DockNode, rect: Rect, region: Region | null, z = 1, maximized = false, floatingId?: string) {
    const min = minimum(node);
    if (node.kind === 'group' || rect.width < min.width || rect.height < min.height) {
      const leaves = groups(node), panels = panelIds(node);
      const active = panels.includes(focused) ? focused : leaves.find((leaf) => panels.includes(leaf.active))?.active ?? panels[0];
      placements.push({ group: { kind: 'group', id: leaves[0].id, panels, active }, groupIds: leaves.map((leaf) => leaf.id), rect, region, z, maximized, floatingId });
      return;
    }
    const horizontal = node.axis === 'x', length = (horizontal ? rect.width : rect.height) - GAP;
    const amin = minimum(node.a), bmin = minimum(node.b);
    const size = Math.max(horizontal ? amin.width : amin.height, Math.min(length - (horizontal ? bmin.width : bmin.height), length * node.ratio));
    const a = { ...rect, ...(horizontal ? { width: size } : { height: size }) };
    const b = { ...rect, ...(horizontal ? { x: rect.x + size + GAP, width: length - size } : { y: rect.y + size + GAP, height: length - size }) };
    dividers.push({ id: node.id, axis: node.axis, region, length, ratio: size / length, floatingId, rect: horizontal ? { x: rect.x + size - 5, y: rect.y, width: 14, height: rect.height } : { x: rect.x, y: rect.y + size - 5, width: rect.width, height: 14 } });
    walk(node.a, a, region, z, maximized, floatingId); walk(node.b, b, region, z, maximized, floatingId);
  }
  if (right) {
    const top = Math.min(layout.rightTop, Math.max(0, bounds.height - MIN_HEIGHT));
    const rect = { x: bounds.x + bounds.width - rw, y: bounds.y + top, width: rw, height: Math.min(bounds.height - top, layout.rightHeight ?? bounds.height) };
    walk(right, rect, 'right');
    dividers.push({ id: 'rightWidth', outer: 'rightWidth', axis: 'x', region: 'right', length: bounds.width, rect: { x: rect.x - 7, y: rect.y, width: 14, height: rect.height } }, { id: 'rightHeight', outer: 'rightHeight', axis: 'y', region: 'right', length: bounds.height - top, rect: { x: rect.x, y: rect.y + rect.height - 12, width: rect.width, height: 14 } }, { id: 'rightTop', outer: 'rightTop', axis: 'y', region: 'right', length: rect.height, rect: { x: rect.x, y: Math.max(bounds.y, rect.y - 5), width: rect.width, height: 10 } });
  }
  if (bottom) {
    const rect = { x: bounds.x, y: bounds.y + bounds.height - bh, width: Math.min(mainWidth, layout.bottomWidth ?? mainWidth), height: bh };
    walk(bottom, rect, 'bottom');
    dividers.push({ id: 'bottomHeight', outer: 'bottomHeight', axis: 'y', region: 'bottom', length: bounds.height, rect: { x: rect.x, y: rect.y - 7, width: rect.width, height: 14 } }, { id: 'bottomWidth', outer: 'bottomWidth', axis: 'x', region: 'bottom', length: mainWidth, rect: { x: rect.x + rect.width - 12, y: rect.y, width: 14, height: rect.height } });
  }
  for (const item of layout.floating) {
    const node = filterNode(item.group, visible);
    if (node) walk(node, item.maximized ? bounds : clampRect(item.rect, bounds), null, item.z + 10, item.maximized, item.group.id);
  }
  return { main, placements, dividers };
}
export function dropEdge(rect: Rect, x: number, y: number): DockEdge {
  const nx = (x - rect.x) / rect.width, ny = (y - rect.y) / rect.height;
  const distances = [{ edge: 'left' as const, d: nx }, { edge: 'right' as const, d: 1 - nx }, { edge: 'top' as const, d: ny }, { edge: 'bottom' as const, d: 1 - ny }].sort((a, b) => a.d - b.d);
  return distances[0].d < 0.25 ? distances[0].edge : 'center';
}
export function previewRect(rect: Rect, edge: DockEdge): Rect {
  return { ...rect, ...(edge === 'left' ? { width: rect.width / 2 } : edge === 'right' ? { x: rect.x + rect.width / 2, width: rect.width / 2 } : edge === 'top' ? { height: rect.height / 2 } : edge === 'bottom' ? { y: rect.y + rect.height / 2, height: rect.height / 2 } : {}) };
}
