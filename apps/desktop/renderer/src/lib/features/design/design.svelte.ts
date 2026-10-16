import type { DesignCanvasTool, DesignComment, DesignFiles, DesignPick, DesignSelection, DesignToolResult, DesignVersion } from '$shared/design';
import { invoke, listen } from '$lib/services/bridge';
import { DesignWorkspaceController } from './design-workspace.svelte';
import { boardLayout, clampZoom, DOCK_WIDTH, FRAME_SIZE_IDS, fitView, frameKey, INSPECTOR_WIDTH, resolveSelected, zoomAt, type Board, type BoardFrame, type BoardView, type FramePositions, type FrameSizeId } from './design-view';
import { decideTextEdit, formatTurnContext, type AnimCommand, type MotionItem } from './design-picker';

const PREFS_KEY = 'agente.design.prefs';
const SCHEMES = ['auto', 'light', 'dark'] as const;
export type DesignScheme = (typeof SCHEMES)[number];
/** The resizable side panes: the chat dock on the left, the inspector on the right. */
export type PaneId = 'dock' | 'inspector';

interface DesignPrefs {
  /** Before the board: the one width the canvas showed. Read once to seed `sizes`. */
  viewport?: string;
  /** The sizes every page and variant is drawn at on the board. */
  sizes?: FrameSizeId[];
  chatOpen?: boolean;
  scheme?: DesignScheme;
  inspectorOpen?: boolean;
  dockWidth?: number;
  inspectorWidth?: number;
}

/** Where frames were dragged, kept per design in this browser (layout is a view preference, not part of the design). */
const BOARD_KEY = (chatId: string) => `agente.design.board.${chatId}`;
function readPositions(chatId: string | null): FramePositions {
  if (!chatId) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(BOARD_KEY(chatId)) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function readPrefs(): DesignPrefs {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}

/** The saved sizes, or the width the single-frame canvas used to show, else desktop. */
function initialSizes(prefs: DesignPrefs): FrameSizeId[] {
  const saved = (prefs.sizes ?? []).filter((size) => FRAME_SIZE_IDS.includes(size));
  if (saved.length) return saved;
  const legacy = FRAME_SIZE_IDS.find((size) => size === prefs.viewport);
  return [legacy ?? 'desktop'];
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
  /** The frame width it was made in, carried onto the comment it may become. */
  width?: number;
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
  /** The sizes on the board; never empty. */
  sizes = $state<FrameSizeId[]>(initialSizes(this.initialPrefs));
  chatOpen = $state(this.initialPrefs.chatOpen ?? true);
  /** Bumped by Reload so an unchanged document still remounts the frame. */
  reloadKey = $state(0);
  /** Pointer mode on the canvas. Not persisted: a fresh canvas always starts browsing. */
  tool = $state<DesignCanvasTool>('browse');
  /** Elements the user picked; they go to the agent with the next message. */
  selection = $state.raw<DesignSelection[]>([]);
  /** Notes pinned on the canvas; they go to the agent with the next message. */
  comments = $state.raw<DesignComment[]>([]);
  /**
   * null = the whole board fitted to the pane (it refits as the pane or the
   * board changes); otherwise the scale of the board (1 = pages at real size),
   * with `pan` its top-left on screen. Not saved: a design always opens fitted.
   */
  zoom = $state<number | null>(null);
  pan = $state({ x: 0, y: 0 });
  /** The canvas's measured size, which the fitted view and zooming around the centre read. */
  pane = $state({ width: 0, height: 0 });
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
      sizes: this.sizes,
      chatOpen: this.chatOpen,
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

  /** Adds or removes a size on the board; the last one stays, so the board is never empty. */
  toggleSize(size: FrameSizeId) {
    const on = this.sizes.includes(size);
    if (on && this.sizes.length === 1) return;
    this.sizes = on ? this.sizes.filter((item) => item !== size) : FRAME_SIZE_IDS.filter((item) => item === size || this.sizes.includes(item));
    this.#savePrefs();
  }
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
  /** Makes a page the selected one; with a frame key, that frame (one size of it) becomes the active frame. */
  select(path: string, key = '') { this.selected = path; this.frameKey = key; }
  reload() { this.reloadKey += 1; void this.refresh(); }

  setTool(tool: DesignCanvasTool) { this.tool = tool; }

  /** Every page, then every variant, at each chosen size. */
  /** Frames the user dragged, by key; saved per design when a drag ends. */
  positions = $state.raw<FramePositions>({});
  readonly board: Board = $derived(boardLayout(this.data.pages, this.data.variants.map((variant) => variant.entry), this.sizes, this.positions));
  /** Where the board sits on screen now: fitted, or the explicit zoom and pan. */
  readonly view: BoardView = $derived(this.zoom === null ? fitView(this.board, this.pane, this.board) : { scale: this.zoom, x: this.pan.x, y: this.pan.y });
  /** The frame last picked in, focused or clicked; it wins over the page's other sizes while its page stays selected. */
  frameKey = $state('');
  /** The frame the ring, the timeline and the selection prompt act on: that frame, else the selected page at its widest size. */
  readonly activeFrame: BoardFrame | null = $derived(
    this.board.frames.find((frame) => frame.key === this.frameKey && frame.page === this.selected)
      ?? this.board.frames.find((frame) => frame.page === this.selected)
      ?? null
  );

  #setView(view: BoardView) {
    this.zoom = Math.round(clampZoom(view.scale) * 1000) / 1000;
    this.pan = { x: view.x, y: view.y };
  }
  /**
   * Zooms to `zoom` around `point` (screen px in the canvas; the pane's centre
   * when left out), so what is under it stays put. null fits the whole board.
   */
  setZoom(zoom: number | null, point?: { x: number; y: number }) {
    if (zoom === null) { this.zoom = null; return; }
    this.#setView(zoomAt(this.view, zoom, point ?? { x: this.pane.width / 2, y: this.pane.height / 2 }));
  }
  /** Adds `step` (a fraction, so 0.1 is ten points) to the current zoom. */
  zoomBy(step: number, point?: { x: number; y: number }) {
    this.setZoom(this.view.scale + step, point);
  }
  /** Multiplies the zoom (wheel and pinch), around `point`. */
  zoomByFactor(factor: number, point?: { x: number; y: number }) {
    this.setZoom(this.view.scale * factor, point);
  }
  /** Moves the board by screen px; a fitted board becomes an explicit view first. */
  panBy(dx: number, dy: number) {
    const view = this.view;
    this.#setView({ scale: view.scale, x: view.x + dx, y: view.y + dy });
  }
  /** Fits one frame to the pane and makes its page the selected one. */
  focusFrame(key: string) {
    const frame = this.board.frames.find((item) => item.key === key);
    if (!frame) return;
    this.select(frame.page, frame.key);
    this.#setView(fitView(frame, this.pane, frame));
  }
  /** Puts a frame at a board position while it is dragged; `endMove` keeps it. */
  moveFrame(key: string, x: number, y: number) {
    // A fitted board would refit under the pointer as the bounds grow; hold the view still while a frame moves.
    if (this.zoom === null) this.#setView(this.view);
    this.positions = { ...this.positions, [key]: { x: Math.round(x), y: Math.round(y) } };
  }
  endMove() { this.#savePositions(); }
  /** Puts every frame back in its row. */
  tidyBoard() {
    this.positions = {};
    this.#savePositions();
    this.zoom = null;
  }
  #savePositions() {
    if (!this.chatId) return;
    try {
      if (Object.keys(this.positions).length) localStorage.setItem(BOARD_KEY(this.chatId), JSON.stringify(this.positions));
      else localStorage.removeItem(BOARD_KEY(this.chatId));
    } catch { /* private mode: the layout lasts for this session */ }
  }

  /** Deletes a page or a variant from the design; main saves a version first, and design_changed refreshes the board. */
  async removePage(page: string) {
    const chatId = this.chatId;
    if (!chatId) return;
    await invoke('design_manage', { chatId, action: 'remove', page });
    if (this.chatId !== chatId) return;
    this.selection = this.selection.filter((item) => item.page !== page);
    this.comments = this.comments.filter((item) => item.page !== page);
    if (this.selected === page) this.select(this.data.pages[0] ?? '');
  }

  /** The frame that draws `page` at `size`, if it is on the board. */
  frame(page: string, size: FrameSizeId) {
    return this.board.frames.find((item) => item.key === frameKey(page, size)) ?? null;
  }

  setScheme(scheme: DesignScheme) { this.scheme = scheme; this.#savePrefs(); }
  toggleInspector() { this.inspectorOpen = !this.inspectorOpen; this.#savePrefs(); }

  /**
   * Records a pick. Replace mode (a plain click) makes it the whole selection;
   * additive mode (shift+click) toggles it in, so a second shift+click removes it.
   */
  addSelection(pick: DesignPick, additive: boolean, page = this.selected, width?: number) {
    const same = (item: DesignSelection) => item.page === page && item.selector === pick.selector;
    if (additive && this.selection.some(same)) {
      this.selection = this.selection.filter((item) => !same(item));
      return;
    }
    const next: DesignSelection = { ...pick, id: nextId('sel'), page, ...(width ? { width } : {}) };
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
    this.addComment({ page: edit.page, selector: edit.selector, x: edit.x, y: edit.y, note: decision.note, ...(edit.width ? { width: edit.width } : {}) });
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
    this.frameKey = '';
    this.tray = null;
    this.zoom = null;
    this.positions = readPositions(chatId);
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
