import type { DesignCanvasTool, DesignComment, DesignFiles, DesignPick, DesignSelection, DesignToolResult, DesignVersion } from '$shared/design';
import { invoke, listen } from '$lib/services/bridge';
import { DesignWorkspaceController } from './design-workspace.svelte';
import { resolveSelected, clampZoom, DOCK_WIDTH, INSPECTOR_WIDTH, type ViewportId } from './design-view';
import { decideTextEdit, formatTurnContext, type AnimCommand, type MotionItem } from './design-picker';

const PREFS_KEY = 'agente.design.prefs';
const SCHEMES = ['auto', 'light', 'dark'] as const;
export type DesignScheme = (typeof SCHEMES)[number];
/** The resizable side panes: the chat dock on the left, the inspector on the right. */
export type PaneId = 'dock' | 'inspector';

interface DesignPrefs {
  viewport?: ViewportId;
  chatOpen?: boolean;
  zoom?: number | null;
  scheme?: DesignScheme;
  inspectorOpen?: boolean;
  dockWidth?: number;
  inspectorWidth?: number;
}

function readPrefs(): DesignPrefs {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}

/** What the timeline knows about the open page's animations: the list, whether reduced motion is previewed, and the playhead. */
export interface MotionState {
  items: MotionItem[];
  reduced: boolean;
  /** ms on the timeline's axis */
  time: number;
  playing: boolean;
  count: number;
}
const NO_MOTION: MotionState = { items: [], reduced: false, time: 0, playing: false, count: 0 };

/** A text edit the picker reported, with the element's page position. */
export interface DesignTextEdit {
  page: string;
  selector: string;
  oldText: string;
  newText: string;
  x: number;
  y: number;
}

const MAX_SELECTION = 12;
let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter += 1).toString(36)}`;

/**
 * The open design's canvas state. The workspace itself lives in main; this
 * holds what the canvas is showing and refetches when main says it changed.
 */
class DesignStore {
  private readonly initialPrefs = readPrefs();
  private readonly workspace = new DesignWorkspaceController({
    read: (chatId) => invoke<DesignFiles>('design_files', { chatId }),
    versions: (chatId) => invoke<DesignVersion[]>('design_manage', { chatId, action: 'versions' })
  });
  get chatId() { return this.workspace.chatId; }
  get data() { return this.workspace.data; }
  get versions() { return this.workspace.versions; }
  get loading() { return this.workspace.loading; }
  selected = $state('');
  tray = $state<'variants' | 'versions' | 'timeline' | null>(null);
  viewport = $state<ViewportId>(this.initialPrefs.viewport ?? 'desktop');
  chatOpen = $state(this.initialPrefs.chatOpen ?? true);
  /** Bumped by Reload so an unchanged document still remounts the frame. */
  reloadKey = $state(0);
  /** Pointer mode on the canvas. Not persisted: a fresh canvas always starts browsing. */
  tool = $state<DesignCanvasTool>('browse');
  /** Elements the user picked; they go to the agent with the next message. */
  selection = $state.raw<DesignSelection[]>([]);
  /** Notes pinned on the canvas; they go to the agent with the next message. */
  comments = $state.raw<DesignComment[]>([]);
  /** null = fit to the pane; otherwise the scale of the page (1 = actual size). */
  zoom = $state<number | null>(this.initialPrefs.zoom ?? null);
  scheme = $state<DesignScheme>(this.initialPrefs.scheme ?? 'auto');
  inspectorOpen = $state(this.initialPrefs.inspectorOpen ?? false);
  /** Requested widths of the side panes; the layout clamps them to the room each one has. */
  dockWidth = $state(this.initialPrefs.dockWidth ?? DOCK_WIDTH.default);
  inspectorWidth = $state(this.initialPrefs.inspectorWidth ?? INSPECTOR_WIDTH.default);
  /** True while a pane edge is held: the canvas follows the drag without easing. */
  resizing = $state(false);
  /** The open page's animations and playhead, as the timeline shows them. */
  motion = $state.raw<MotionState>(NO_MOTION);
  #timer: ReturnType<typeof setTimeout> | undefined;
  #send: ((command: AnimCommand) => void) | null = null;

  #savePrefs() {
    const prefs: DesignPrefs = {
      viewport: this.viewport,
      chatOpen: this.chatOpen,
      zoom: this.zoom,
      scheme: this.scheme,
      inspectorOpen: this.inspectorOpen,
      dockWidth: this.dockWidth,
      inspectorWidth: this.inspectorWidth
    };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  }

  /** A pane edge is held: the layout follows the pointer, and nothing is written until endResize. */
  beginResize() { this.resizing = true; }
  setPaneWidth(pane: PaneId, width: number) {
    if (pane === 'dock') this.dockWidth = width;
    else this.inspectorWidth = width;
  }
  /** The drag (or key nudge) is over: stop following and keep both widths. */
  endResize() {
    this.resizing = false;
    this.#savePrefs();
  }
  /** Double-clicking a pane edge puts that pane back at its default width. */
  resetPaneWidth(pane: PaneId) {
    this.setPaneWidth(pane, pane === 'dock' ? DOCK_WIDTH.default : INSPECTOR_WIDTH.default);
    this.#savePrefs();
  }

  setViewport(viewport: ViewportId) { this.viewport = viewport; this.#savePrefs(); }
  toggleChat() { this.chatOpen = !this.chatOpen; this.#savePrefs(); }
  toggleTray(tray: 'variants' | 'versions' | 'timeline') {
    this.tray = this.tray === tray ? null : tray;
    if (this.tray === 'versions') void this.refreshVersions();
  }

  /** The canvas hands over its way to talk to the page; a null sender means no frame is on screen. */
  bindFrame(send: ((command: AnimCommand) => void) | null) { this.#send = send; }
  /** Sends one animation command to the open page; nothing happens when no page is on screen. */
  sendAnim(command: AnimCommand) { this.#send?.(command); }
  /** The page reported its animations (on open, on a change, or after a reduced-motion switch). */
  setMotionItems(items: MotionItem[], reduced: boolean) { this.motion = { ...this.motion, items, reduced, count: items.length }; }
  /** The playhead, reported while the timeline watches the page. */
  setPlayhead(time: number, playing: boolean, count: number) { this.motion = { ...this.motion, time, playing, count }; }
  select(path: string) { this.selected = path; }
  reload() { this.reloadKey += 1; void this.refresh(); }

  setTool(tool: DesignCanvasTool) { this.tool = tool; }

  setZoom(zoom: number | null) {
    this.zoom = zoom === null ? null : Math.round(clampZoom(zoom) * 100) / 100;
    this.#savePrefs();
  }
  /** Adds `step` (a fraction, so 0.1 is ten points) to the current zoom, or to `fallback` when fit. */
  zoomBy(step: number, fallback = 1) {
    this.setZoom((this.zoom ?? fallback) + step);
  }

  setScheme(scheme: DesignScheme) { this.scheme = scheme; this.#savePrefs(); }
  toggleInspector() { this.inspectorOpen = !this.inspectorOpen; this.#savePrefs(); }

  /**
   * Records a pick. Replace mode (a plain click) makes it the whole selection;
   * additive mode (shift+click) toggles it in, so a second shift+click removes it.
   */
  addSelection(pick: DesignPick, additive: boolean) {
    const page = this.selected;
    const same = (item: DesignSelection) => item.page === page && item.selector === pick.selector;
    if (additive && this.selection.some(same)) {
      this.selection = this.selection.filter((item) => !same(item));
      return;
    }
    const next: DesignSelection = { ...pick, id: nextId('sel'), page };
    this.selection = additive ? [...this.selection, next].slice(-MAX_SELECTION) : [next];
  }
  removeSelection(id: string) { this.selection = this.selection.filter((item) => item.id !== id); }
  clearSelection() { this.selection = []; }

  addComment(comment: Omit<DesignComment, 'id'>) {
    this.comments = [...this.comments, { ...comment, id: nextId('note') }];
  }
  removeComment(id: string) { this.comments = this.comments.filter((item) => item.id !== id); }
  clearComments() { this.comments = []; }

  /**
   * A text edit made on the canvas. When the old text is unambiguous in the
   * page's source it is applied with design_edit (main emits design_changed,
   * so the canvas refreshes); otherwise it becomes a comment for the agent.
   */
  async applyTextEdit(edit: DesignTextEdit) {
    const chatId = this.chatId;
    const decision = decideTextEdit(this.data.files[edit.page], edit.oldText, edit.newText);
    if (decision.kind === 'none') return;
    if (decision.kind === 'apply' && chatId) {
      try {
        const result = await invoke<DesignToolResult>('design_tool', {
          chatId,
          name: 'design_edit',
          args: { path: edit.page, old_text: decision.oldText, new_text: decision.newText }
        });
        if (result.ok) return;
      } catch {
        // Fall through: the agent gets the edit as a comment instead.
      }
    }
    if (this.chatId !== chatId) return;
    this.addComment({ page: edit.page, selector: edit.selector, x: edit.x, y: edit.y, note: decision.note });
  }

  /**
   * The selection and comments as a markdown block for the next agent turn,
   * which clears them. Empty when the user pointed at nothing.
   */
  takeTurnContext(): string {
    const context = formatTurnContext(this.selection, this.comments);
    this.selection = [];
    this.comments = [];
    return context;
  }

  /** Point the canvas at a design. */
  async open(chatId: string | null) {
    if (chatId === this.chatId) return;
    clearTimeout(this.#timer);
    this.workspace.reset(chatId);
    this.selected = '';
    this.tray = null;
    this.selection = [];
    this.comments = [];
    this.motion = NO_MOTION;
    if (chatId) await this.refresh();
  }

  async refresh() {
    if (!await this.workspace.refresh()) return;
    this.selected = resolveSelected(this.selected, this.data);
    if (this.tray === 'versions') await this.refreshVersions();
  }

  refreshVersions() { return this.workspace.refreshVersions(); }

  async restore(version: number) {
    if (!this.chatId) return;
    await invoke('design_manage', { chatId: this.chatId, action: 'restore', version });
  }

  async promote(variant: string) {
    if (!this.chatId) return;
    const chatId = this.chatId;
    await invoke('design_manage', { chatId, action: 'promote', variant });
    if (this.chatId !== chatId) return;
    this.selected = 'index.html';
    this.tray = null;
  }

  reveal() { if (this.chatId) void invoke('design_manage', { chatId: this.chatId, action: 'reveal' }); }

  /** Main reports a write; a burst of them (one per tool call) becomes one refetch. */
  changed(chatId: string) {
    if (chatId !== this.chatId) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { void this.refresh(); }, 120);
  }

  /** Subscribe to workspace changes; returns the unsubscribe. */
  watch(): () => void {
    let off: (() => void) | undefined;
    let stopped = false;
    void listen<{ chatId: string }>('design_changed', (event) => this.changed(event.chatId)).then((unlisten) => {
      if (stopped) unlisten(); else off = unlisten;
    });
    return () => { stopped = true; off?.(); clearTimeout(this.#timer); };
  }
}

export const designStore = new DesignStore();
