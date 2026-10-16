import type { DesignCanvasTool, DesignComment, DesignFiles, DesignPick, DesignSelection, DesignStroke, DesignToolResult, DesignVersion } from '$shared/design';
import { invoke, listen } from '$lib/services/bridge';
import { DesignWorkspaceController } from './design-workspace.svelte';
import { boardLayout, nearestFree, clampZoom, DOCK_WIDTH, FRAME_SIZE_IDS, fitView, frameKey, INSPECTOR_WIDTH, resolveSelected, zoomAt, type Board, type BoardFrame, type BoardView, type FramePositions, type FrameSizeId } from './design-view';
import { decideTextEdit, formatTurnContext, type AnimCommand, type MotionItem } from './design-picker';
import { startsBurst } from './design-edit-ops';
import { planStyleEdit, styleEditNote } from './design-source';
import { MAX_STROKES } from './design-strokes';
import { tokenEdit, type TokenDecl } from './design-tokens';
import { DESIGN_FLOWS_FILE, parseFlows, toggleLink, type DesignFlowLink } from '$shared/design-flows';
import { isReferencePath, readFileBase64, referencePaths } from './design-references';

const PREFS_KEY = 'agente.design.prefs';
const SCHEMES = ['auto', 'light', 'dark'] as const;
export type DesignScheme = (typeof SCHEMES)[number];
/** The resizable side panes: the chat dock on the left, the inspector on the right. */
export type PaneId = 'dock' | 'inspector';
export type InspectorTab = 'element' | 'tokens' | 'code';
export const TOKENS_FILE = 'tokens.css';

/** The active frame's page, as the store reaches it: one frame, or every frame at once. */
export interface FrameHost {
  post(message: Record<string, unknown>): void;
  broadcast(message: Record<string, unknown>): void;
}

interface DesignPrefs {
  /** Before the board: the one width the canvas showed. Read once to seed `sizes`. */
  viewport?: string;
  /** The sizes every page and variant is drawn at on the board. */
  sizes?: FrameSizeId[];
  chatOpen?: boolean;
  scheme?: DesignScheme;
  inspectorOpen?: boolean;
  layersOpen?: boolean;
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
  inspectorTab = $state<InspectorTab>('element');
  /** The Layers panel over the canvas's left edge. */
  layersOpen = $state(this.initialPrefs.layersOpen ?? false);
  /** The layer row under the pointer; the frame outlines that element. */
  layerHover = $state('');
  /** Freehand marks; they go to the agent with the next message. */
  strokes = $state.raw<DesignStroke[]>([]);
  /** Set after a direct edit: the page reloads, so its selection is picked again and its scroll kept. */
  repick = $state<{ page: string; selector: string; at: number } | null>(null);
  /** Requested widths of the side panes; the layout clamps them to the room each one has. */
  dockWidth = $state(this.initialPrefs.dockWidth ?? DOCK_WIDTH.default);
  inspectorWidth = $state(this.initialPrefs.inspectorWidth ?? INSPECTOR_WIDTH.default);
  /** True while a pane edge is held: the canvas follows the drag without easing. */
  resizing = $state(false);
  /** The open page's animations and playhead, as the timeline shows them. */
  motion = $state.raw<MotionState>(NO_MOTION);
  #timer: ReturnType<typeof setTimeout> | undefined;
  #send: ((command: AnimCommand) => void) | null = null;
  #frames: FrameHost | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #lastEditAt: number | null = null;

  #savePrefs() {
    const prefs: DesignPrefs = {
      sizes: this.sizes,
      chatOpen: this.chatOpen,
      scheme: this.scheme,
      inspectorOpen: this.inspectorOpen,
      layersOpen: this.layersOpen,
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
  /** The canvas hands over the frames it can message (null when none is on screen). */
  bindFrames(host: FrameHost | null) { this.#frames = host; }
  /** Sets a custom property on every frame's root, a live preview until the saved value reloads the page. */
  previewVar(name: string, value: string | null) { this.#frames?.broadcast({ type: 'cssvar', name, value }); }
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
  /** The frame being dragged: it floats over the board until it is dropped. */
  moving = $state<string | null>(null);
  readonly board: Board = $derived(boardLayout(this.data.pages, this.data.variants.map((variant) => variant.entry), this.sizes, this.positions, this.moving));
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
    this.moving = key;
    this.positions = { ...this.positions, [key]: { x: Math.round(x), y: Math.round(y) } };
  }
  /** A dropped frame never lands on another: it snaps to the nearest free spot, then the place is kept. */
  endMove(key: string) {
    const frame = this.board.frames.find((item) => item.key === key);
    const want = this.positions[key];
    this.moving = null;
    if (frame && want) {
      const spot = nearestFree({ ...frame, x: want.x, y: want.y }, this.board.frames.filter((item) => item.key !== key));
      this.positions = { ...this.positions, [key]: { x: Math.round(spot.x), y: Math.round(spot.y) } };
    }
    this.#savePositions();
  }
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
    this.strokes = this.strokes.filter((item) => item.page !== page);
    this.comments = this.comments.filter((item) => item.page !== page);
    if (this.selected === page) this.select(this.data.pages[0] ?? '');
  }

  /** Every page and variant the board draws, the names a link can use. */
  readonly boardPages: string[] = $derived([...this.data.pages, ...this.data.variants.map((variant) => variant.entry)]);
  /** Page links from `flows.json`, with links to pages that are gone dropped. */
  readonly links: DesignFlowLink[] = $derived(parseFlows(this.data.files[DESIGN_FLOWS_FILE], this.boardPages));
  /** The images in `references/`, as data URLs the tray shows. */
  readonly references: Array<{ path: string; src: string }> = $derived(referencePaths(Object.keys(this.data.files)).map((path) => ({ path, src: this.data.files[path] })));

  /** Links `from` to `to`, or unlinks when it is already linked; main validates and writes `flows.json`. */
  async toggleLink(from: string, to: string) {
    const chatId = this.chatId;
    if (!chatId) return;
    await invoke('design_manage', { chatId, action: 'set_flows', links: toggleLink(this.links, from, to) });
  }

  /** Opens a file dialog in main and adds the chosen images to `references/`. Returns how many were added and how many were refused. */
  async pickReferences(): Promise<{ added: number; failed: number }> {
    const chatId = this.chatId;
    if (!chatId) return { added: 0, failed: 0 };
    const result = await invoke<{ added: string[]; failed?: number }>('design_manage', { chatId, action: 'pick_references' });
    return { added: result?.added?.length ?? 0, failed: result?.failed ?? 0 };
  }

  /** Adds an image the user pasted or dropped. Main checks the bytes; a refusal throws with its reason. */
  async addReferenceBlob(name: string, data: string): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) return;
    await invoke('design_manage', { chatId, action: 'add_reference', name, data });
  }

  /** Adds dropped or pasted image files; one that main refuses is counted, not fatal. */
  async addReferenceFiles(files: File[]): Promise<{ added: number; failed: number }> {
    let added = 0;
    let failed = 0;
    for (const file of files.slice(0, 8)) {
      try {
        await this.addReferenceBlob(file.name || 'image', await readFileBase64(file));
        added += 1;
      } catch { failed += 1; }
    }
    return { added, failed };
  }

  async removeReference(path: string) {
    const chatId = this.chatId;
    if (!chatId || !isReferencePath(path)) return;
    await invoke('design_manage', { chatId, action: 'remove_reference', path });
  }

  /** Main opens the public page in a private window and keeps a screenshot of it in `references/`. */
  async captureSite(url: string): Promise<{ ok: boolean; error?: string }> {
    const chatId = this.chatId;
    if (!chatId) return { ok: false };
    const result = await invoke<{ ok: boolean; error?: string; saved?: string }>('design_reference', { chatId, url, saveScreenshot: true });
    if (result.ok && !result.saved) return { ok: false, error: result.error };
    return { ok: result.ok, error: result.error };
  }

  /** The frame that draws `page` at `size`, if it is on the board. */
  frame(page: string, size: FrameSizeId) {
    return this.board.frames.find((item) => item.key === frameKey(page, size)) ?? null;
  }

  setScheme(scheme: DesignScheme) { this.scheme = scheme; this.#savePrefs(); }
  toggleInspector() { this.inspectorOpen = !this.inspectorOpen; this.#savePrefs(); }
  toggleLayers() { this.layersOpen = !this.layersOpen; this.#savePrefs(); }
  /** Opens the inspector on a tab (the edit toolbar's "show in Code"). */
  showInInspector(tab: InspectorTab) {
    this.inspectorTab = tab;
    if (!this.inspectorOpen) this.toggleInspector();
  }

  /** Selects an element in the active frame by selector (the Layers panel); the Select tool takes over so its toolbar shows. */
  pickSelector(selector: string) {
    this.tool = 'select';
    this.#frames?.post({ type: 'pick', selector, reveal: true });
  }

  /** Escape, one step at a time: the last mark first while drawing, then the tool back to Browse. False when there was nothing to undo. */
  escape(): boolean {
    if (this.tool === 'draw' && this.strokes.length) { this.removeLastStroke(); return true; }
    if (this.tool !== 'browse') { this.tool = 'browse'; return true; }
    return false;
  }

  addStroke(stroke: Omit<DesignStroke, 'id'>): string {
    const id = nextId('mark');
    this.strokes = [...this.strokes, { ...stroke, id }].slice(-MAX_STROKES);
    return id;
  }
  setStrokeHits(id: string, hits: string[]) { this.strokes = this.strokes.map((item) => (item.id === id ? { ...item, hits } : item)); }
  removeLastStroke() { this.strokes = this.strokes.slice(0, -1); }
  clearStrokes() { this.strokes = []; }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job, job);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * A change the edit toolbar made to one element's inline style. It is
   * written straight into the page source with design_edit (one at a time, so
   * a run of clicks never edits stale text); a version is saved before the
   * first edit of a burst, so Versions can undo it. When the element cannot
   * be found exactly once, it becomes a comment for the agent instead.
   */
  applyStyleEdit(pick: DesignSelection, set: Record<string, string | null>): Promise<void> {
    return this.#enqueue(async () => {
      const chatId = this.chatId;
      if (!chatId) return;
      const plan = planStyleEdit(this.data.files[pick.page], pick.selector, set);
      if (plan.kind === 'none') return;
      if (plan.kind === 'apply') {
        try {
          if (startsBurst(this.#lastEditAt, Date.now())) {
            try { await invoke('design_manage', { chatId, action: 'snapshot', label: 'Before direct edits', auto: true }); } catch { /* the edit is still worth making */ }
          }
          const result = await invoke<DesignToolResult>('design_tool', { chatId, name: 'design_edit', args: { path: pick.page, old_text: plan.oldText, new_text: plan.newText } });
          if (result.ok) {
            this.#lastEditAt = Date.now();
            const styles = { ...pick.styles };
            for (const [name, value] of Object.entries(set)) { if (value === null) delete styles[name]; else styles[name] = value; }
            this.selection = this.selection.map((item) => (item.id === pick.id ? { ...item, styles } : item));
            this.repick = { page: pick.page, selector: pick.selector, at: Date.now() };
            await this.refresh();
            return;
          }
        } catch {
          // Fall through: the agent gets the edit as a comment instead.
        }
      }
      if (this.chatId !== chatId) return;
      this.addComment({ page: pick.page, selector: pick.selector, x: pick.box.x, y: pick.box.y, note: plan.kind === 'comment' ? plan.note : styleEditNote(pick.selector, set), ...(pick.width ? { width: pick.width } : {}) });
    });
  }

  /** Rewrites one token declaration in tokens.css; returns an error message, or '' when it was written. */
  writeToken(decl: TokenDecl, value: string): Promise<string> {
    return this.#enqueue(async () => {
      const chatId = this.chatId;
      const text = this.data.files[TOKENS_FILE];
      if (!chatId || text === undefined) return '';
      const edit = tokenEdit(text, decl, value);
      if (!edit || edit.old_text === edit.new_text) return '';
      try {
        const result = await invoke<DesignToolResult>('design_tool', { chatId, name: 'design_edit', args: { path: TOKENS_FILE, old_text: edit.old_text, new_text: edit.new_text } });
        if (!result?.ok) return result?.content || 'failed';
        await this.refresh();
        return '';
      } catch {
        return 'failed';
      }
    });
  }

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
    const context = formatTurnContext(this.selection, this.comments, this.strokes);
    this.selection = [];
    this.comments = [];
    this.strokes = [];
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
    this.strokes = [];
    this.repick = null;
    this.layerHover = '';
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
