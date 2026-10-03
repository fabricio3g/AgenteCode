import { activatePanel, clampRect, dockPanel, dockFloating, dockFloatingGroup, floatPanel, forgetPanel, panelIds, parseWorkspaceLayout, setSplitRatio, type DockEdge, type Rect, type Region, type WorkspaceLayout } from '$lib/components/layout/workspace-layout';

const KEY = 'agente.workspaceLayout';
const UNSCOPED = 'unassigned';
function readLegacy(): WorkspaceLayout {
  try { return parseWorkspaceLayout(localStorage.getItem(KEY), localStorage.getItem('agente.rightDock'), localStorage.getItem('flaxeo.code.layout')); }
  catch { return parseWorkspaceLayout(null); }
}
function readScopes(): Record<string, WorkspaceLayout> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (saved.version !== 2 || !saved.scopes || typeof saved.scopes !== 'object' || Array.isArray(saved.scopes)) return {};
    return Object.fromEntries(Object.entries(saved.scopes).filter(([scope]) => scope.startsWith('chat:') || scope.startsWith('space:')).map(([scope, layout]) => [scope, parseWorkspaceLayout(JSON.stringify(layout))]));
  } catch { return {}; }
}
export class WorkspaceLayoutStore {
  scope = $state(UNSCOPED);
  layouts = $state<Record<string, WorkspaceLayout>>(readScopes());
  focused = $state('');
  interacting = $state(false);
  #legacy = readLegacy();
  #claimedLegacy = Object.keys(this.layouts).length > 0;
  get layout(): WorkspaceLayout { return this.layouts[this.scope] ?? this.#legacy; }
  set layout(layout: WorkspaceLayout) { this.layouts[this.scope] = layout; }

  selectScope(scope: string) {
    if (this.scope === scope) return;
    // Roll back a gesture in its original conversation before changing owners.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('workspace-scope-change'));
    if (!this.layouts[scope]) {
      this.layouts[scope] = !this.#claimedLegacy && scope.startsWith('chat:') ? this.#legacy : parseWorkspaceLayout(null);
      if (scope.startsWith('chat:')) this.#claimedLegacy = true;
    }
    this.scope = scope; this.focused = ''; this.interacting = false; this.save();
  }
  save() {
    if (this.scope === UNSCOPED) return;
    try { localStorage.setItem(KEY, JSON.stringify({ version: 2, scopes: Object.fromEntries(Object.entries(this.layouts).filter(([scope]) => scope !== UNSCOPED)) })); } catch { /* Session-only when storage is unavailable. */ }
  }
  forScope(scope: string, run: (store: WorkspaceLayoutStore) => void) {
    if (scope === this.scope) { run(this); return; }
    // Background tools update only their owner's layout, without activating it.
    const owner = new WorkspaceLayoutStore();
    owner.scope = scope; owner.layouts = this.layouts;
    if (!owner.layouts[scope]) owner.layouts[scope] = parseWorkspaceLayout(null);
    run(owner); this.layouts[scope] = owner.layout; this.save();
  }
  snapshot(): WorkspaceLayout { return JSON.parse(JSON.stringify(this.layout)) as WorkspaceLayout; }
  restore(layout: WorkspaceLayout) { this.layout = layout; this.interacting = false; this.save(); }
  has(id: string): boolean { return [...panelIds(this.layout.right), ...panelIds(this.layout.bottom), ...this.layout.floating.flatMap((item) => panelIds(item.group))].includes(id); }
  ensure(id: string, region: Region = 'right') {
    if (!this.has(id)) { this.layout = dockPanel(this.layout, id, region); this.save(); }
  }
  isOpen(id: string): boolean { return this.layout.open.includes(id); }
  show(id: string, region: Region = 'right') {
    this.ensure(id, region);
    if (!this.isOpen(id)) this.layout = { ...this.layout, open: [...this.layout.open, id] };
    this.activate(id); this.save();
  }
  hide(id: string) { this.layout = { ...this.layout, open: this.layout.open.filter((panel) => panel !== id) }; this.save(); }
  /**
   * Open a panel floating over the workspace. For panels that want room —
   * a canvas is useless at the 460px right dock — so the first open lands
   * centred; every later toggle is a plain hide/show.
   */
  showFloating(id: string, rect: Rect, bounds: Rect) {
    this.layout = { ...this.layout, open: this.layout.open.includes(id) ? this.layout.open : [...this.layout.open, id] };
    this.float(id, rect, bounds);
    this.save();
  }
  /** A panel's working area, centred and clamped — the default first-open geometry. */
  static floatingRect(bounds: Rect, size = { width: 880, height: 620 }): Rect {
    const width = Math.min(bounds.width, size.width), height = Math.min(bounds.height, size.height);
    return clampRect({ x: bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height }, bounds);
  }
  forget(id: string) { this.layout = forgetPanel(this.layout, id); this.save(); }
  toggle(id: string, region: Region = 'right') { if (this.isOpen(id)) this.hide(id); else this.show(id, region); }
  activate(id: string) {
    this.focused = id;
    this.layout = activatePanel(this.layout, id);
    const z = Math.max(0, ...this.layout.floating.map((item) => item.z)) + 1;
    this.layout = { ...this.layout, floating: this.layout.floating.map((item) => panelIds(item.group).includes(id) ? { ...item, z } : item) };
    this.save();
  }
  dock(id: string, region: Region, target?: string, edge: DockEdge = 'center') { this.layout = dockPanel(this.layout, id, region, target, edge); this.activate(id); }
  dockFloating(id: string, target: string, edge: DockEdge) { this.layout = dockFloating(this.layout, id, target, edge); this.activate(id); }
  dockGroup(floatingId: string, region: Region | null, target?: string, edge: DockEdge = 'center') { this.layout = dockFloatingGroup(this.layout, floatingId, region, target, edge); this.save(); }
  float(id: string, rect: Rect, bounds: Rect) { this.layout = floatPanel(this.layout, id, clampRect(rect, bounds)); this.activate(id); }
  setFloatingRect(id: string, rect: Rect) { this.layout = { ...this.layout, floating: this.layout.floating.map((item) => panelIds(item.group).includes(id) ? { ...item, rect } : item) }; }
  maximize(id: string) { this.layout = { ...this.layout, floating: this.layout.floating.map((item) => panelIds(item.group).includes(id) ? { ...item, maximized: !item.maximized } : item) }; this.activate(id); }
  resizeSplit(region: Region | null, id: string, ratio: number, floatingId?: string) {
    this.layout = region ? { ...this.layout, [region]: setSplitRatio(this.layout[region], id, ratio) } : { ...this.layout, floating: this.layout.floating.map((item) => item.group.id === floatingId ? { ...item, group: setSplitRatio(item.group, id, ratio)! } : item) };
  }
  reset() {
    const ids = [...panelIds(this.layout.right), ...panelIds(this.layout.bottom), ...this.layout.floating.flatMap((item) => panelIds(item.group))];
    const open = this.layout.open;
    this.layout = { ...parseWorkspaceLayout(null), open };
    for (const id of ids) this.ensure(id, id === 'processes' || id.startsWith('terminal:') ? 'bottom' : 'right');
    this.save();
  }
}
export const workspaceLayout = new WorkspaceLayoutStore();
