import { activatePanel, canSplit, clampRect, dockPanel, dockFloating, dockFloatingGroup, floatPanel, forgetPanel, measurePanes, pane, paneShowing, panes, panelIds, parseWorkspaceLayout, removePane, setPaneChat, setPaneRatio, setSplitRatio, splitPane, type DockEdge, type PaneLeaf, type Rect, type Region, type WorkspaceLayout } from '$lib/components/layout/workspace-layout';

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
  panelFocus = $state<Record<string, string>>({});
  get focused(): string { return this.panelFocus[this.scope] ?? ''; }
  set focused(id: string) { this.panelFocus[this.scope] = id; }
  /** The pane that owns the keyboard: its composer, its scroll, its panels. */
  focusedPane = $state('');
  interacting = $state(false);
  /**
   * The centre's measured size. A split is refused against this rather than
   * against the window: the dock takes its share first, and a menu item can say
   * why instead of squeezing two columns into one conversation's width.
   */
  centreSize = $state({ width: 0, height: 0 });
  #legacy = readLegacy();
  #claimedLegacy = Object.keys(this.layouts).length > 0;
  get layout(): WorkspaceLayout { return this.layouts[this.scope] ?? this.#legacy; }
  set layout(layout: WorkspaceLayout) { this.layouts[this.scope] = layout; }

  selectScope(scope: string) {
    if (this.scope === scope) return;
    // Roll back a gesture in its original conversation before changing owners.
    if (this.interacting && typeof window !== 'undefined') window.dispatchEvent(new Event('workspace-scope-change'));
    if (!this.layouts[scope]) {
      this.layouts[scope] = !this.#claimedLegacy && scope.startsWith('chat:') ? this.#legacy : parseWorkspaceLayout(null);
      if (scope.startsWith('chat:')) this.#claimedLegacy = true;
    }
    this.scope = scope; this.focused = ''; this.interacting = false; this.save();
  }
  #savedScopes = new Map(Object.entries(this.layouts).map(([scope, layout]) => [scope, JSON.stringify(layout)]));
  save() {
    if (this.scope === UNSCOPED) return;
    try {
      const saved = readScopes();
      for (const [scope, layout] of Object.entries(this.layouts)) {
        if (scope === UNSCOPED) continue;
        const value = JSON.stringify(layout);
        if (this.#savedScopes.get(scope) !== value) saved[scope] = layout;
        this.#savedScopes.set(scope, value);
      }
      localStorage.setItem(KEY, JSON.stringify({ version: 2, scopes: saved }));
    } catch { /* Session-only when storage is unavailable. */ }
  }
  #owners = new Map<string, WorkspaceLayoutStore>();
  scoped(scope: string): WorkspaceLayoutStore {
    if (!this.layouts[scope]) { this.layouts[scope] = !this.#claimedLegacy && scope.startsWith('chat:') ? this.#legacy : parseWorkspaceLayout(null); if (scope.startsWith('chat:')) this.#claimedLegacy = true; }
    let owner = this.#owners.get(scope);
    if (!owner) {
      owner = new ScopedWorkspaceLayoutStore(this, scope);
      this.#owners.set(scope, owner);
    }
    return owner;
  }
  forScope(scope: string, run: (store: WorkspaceLayoutStore) => void) {
    run(scope === this.scope ? this : this.scoped(scope));
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
  /* ── the centre: conversations side by side ─────────────────────────────── */

  /**
   * Where the centre lives.
   *
   * The dock is per conversation — its panels belong to the chat you are reading
   * — but a split spans conversations, so the panes are stored with the *space*.
   * Keyed per chat, the second pane's conversation brought its own single-pane
   * centre with it and the split vanished the moment it took the keyboard.
   */
  spaceScope = $state('space:code');

  #space(): WorkspaceLayout {
    return this.layouts[this.spaceScope] ?? parseWorkspaceLayout(null);
  }

  get centre(): WorkspaceLayout['centre'] {
    return this.#space().centre;
  }

  set centre(node: WorkspaceLayout['centre']) {
    this.layouts = { ...this.layouts, [this.spaceScope]: { ...this.#space(), centre: node } };
  }

  /** The conversations on screen, in reading order. */
  get panes(): PaneLeaf[] { return panes(this.centre); }

  /** The pane showing this conversation, so it is never opened twice. */
  paneForChat(chatId: string): PaneLeaf | null { return paneShowing(this.centre, chatId); }

  /**
   * The chat the rest of the app reads as "current": the focused pane's, or the
   * first pane's while the focus is somewhere else (a panel, a floating window).
   */
  get centreChatId(): string | null {
    const leaves = this.panes;
    return (leaves.find((leaf) => leaf.id === this.focusedPane) ?? leaves[0])?.chatId ?? null;
  }

  /**
   * Show a conversation in the centre. With no centre yet it opens the first
   * pane; otherwise it swaps the focused pane's conversation — what choosing a
   * row in the sidebar has always done. A conversation that already has a pane
   * is focused instead of shown twice.
   */
  showConversation(chatId: string) {
    const existing = this.paneForChat(chatId);
    if (existing) { this.focusPane(existing.id); return; }
    const leaves = this.panes;
    if (!leaves.length) {
      const leaf = pane(chatId);
      this.centre = leaf;
      this.focusedPane = leaf.id;
      this.save();
      return;
    }
    const target = leaves.find((leaf) => leaf.id === this.focusedPane) ?? leaves[0];
    this.focusedPane = target.id;
    this.centre = setPaneChat(this.centre, target.id, chatId);
    this.save();
  }

  pruneConversations(chatIds: Set<string>) {
    const missing = this.panes.filter((leaf) => !chatIds.has(leaf.chatId));
    if (!missing.length) return;
    for (const leaf of missing) this.centre = removePane(this.centre, leaf.id);
    if (!this.panes.some((leaf) => leaf.id === this.focusedPane)) this.focusedPane = this.panes[0]?.id ?? '';
    this.save();
  }

  focusPane(id: string) { this.focusedPane = id; }

  /**
   * Open a conversation beside another. Refuses when the area cannot hold a
   * second readable pane, so the caller can say why instead of squeezing two
   * columns into one conversation's width.
   */
  splitWith(chatId: string, edge: 'left' | 'right' | 'top' | 'bottom', bounds: Rect, target?: string): boolean {
    const existing = this.paneForChat(chatId);
    if (existing) { this.focusPane(existing.id); return true; }
    const anchorRect = measurePanes(this.centre, bounds, this.focusedPane).panes.find((item) => item.id === (target ?? this.focusedPane))?.rect ?? bounds;
    if (!canSplit(anchorRect, edge === 'left' || edge === 'right' ? 'x' : 'y')) return false;
    const leaves = this.panes;
    const anchor = target ?? (leaves.find((leaf) => leaf.id === this.focusedPane) ?? leaves[0])?.id ?? null;
    const leaf = pane(chatId);
    this.centre = splitPane(this.centre, anchor, leaf, edge);
    this.focusedPane = leaf.id;
    this.save();
    return true;
  }

  /** Close one pane. The last pane is the tab's centre, so it stays. */
  closePane(id: string): boolean {
    const leaves = this.panes;
    if (leaves.length <= 1) return false;
    const index = leaves.findIndex((leaf) => leaf.id === id);
    if (index < 0) return false;
    this.centre = removePane(this.centre, id);
    if (this.focusedPane === id) this.focusedPane = (leaves[index + 1] ?? leaves[index - 1]).id;
    this.save();
    return true;
  }

  resizePanes(id: string, ratio: number) {
    this.centre = setPaneRatio(this.centre, id, ratio);
  }

  reset() {
    const ids = [...panelIds(this.layout.right), ...panelIds(this.layout.bottom), ...this.layout.floating.flatMap((item) => panelIds(item.group))];
    const open = this.layout.open;
    this.layout = { ...parseWorkspaceLayout(null), open };
    for (const id of ids) this.ensure(id, id === 'processes' || id.startsWith('terminal:') ? 'bottom' : 'right');
    this.save();
  }
}
class ScopedWorkspaceLayoutStore extends WorkspaceLayoutStore {
  constructor(private parent: WorkspaceLayoutStore, scope: string) { super(); this.scope = scope; }
  override get layout(): WorkspaceLayout { return this.parent.layouts[this.scope]; }
  override set layout(value: WorkspaceLayout) { this.parent.layouts[this.scope] = value; }
  override get focused(): string { return this.parent.panelFocus[this.scope] ?? ''; }
  override set focused(id: string) { this.parent.panelFocus[this.scope] = id; }
  override save() { this.parent.save(); }
}
export const workspaceLayout = new WorkspaceLayoutStore();
