import { createId } from '$lib/utils/id';
import { blankBoard, boundsOf, moveMark, normalizeBox, resizeMark, withMark, withoutMark, type Box, type CanvasDoc, type CanvasImage, type CanvasMark, type MarkKind, type Point, type ToolId } from './canvas-doc';

/**
 * The board behind the canvas panel, one per conversation.
 *
 * Marks live in image pixels and never in screen pixels, so the board can be
 * scrolled, zoomed and floated without the geometry the agent will read ever
 * moving under the user. Undo is a snapshot stack: an annotation gesture is
 * cheap to describe in full, and a snapshot cannot get out of step with a
 * command log the way a replay would.
 */

const KEY = 'agente.canvas.v1';
/** Bounded so a long session cannot grow localStorage without limit. */
const UNDO_LIMIT = 60;

const SWATCHES = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#111827'];
const DEFAULT_COLOR = SWATCHES[0]!;

function read(): Record<string, CanvasDoc> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    // Only marks and the tool survive a restart: bitmaps are re-imported from
    // their attachment paths, so nothing large is ever written here.
    return Object.fromEntries(
      Object.entries(saved as Record<string, CanvasDoc>).flatMap(([chatId, doc]) =>
        doc && Array.isArray(doc.marks) && Array.isArray(doc.images) ? [[chatId, { ...doc, view: { zoom: 1, panX: 0, panY: 0 } }]] : []
      )
    );
  } catch {
    return {};
  }
}

function blank(): CanvasDoc {
  return { images: [], marks: [], view: { zoom: 1, panX: 0, panY: 0 }, labelled: [] };
}

export class CanvasBoardStore {
  #docs = $state<Record<string, CanvasDoc>>(read());
  /** Full-resolution data URLs, by image id. Never persisted: too big for
   * localStorage, and the daemon already caches the original by path. */
  #srcs = $state<Record<string, string>>({});
  #undo = new Map<string, CanvasDoc[]>();
  #redo = new Map<string, CanvasDoc[]>();
  /** Which board the panel is editing; the panel sets it from its chat. */
  activeChatId = $state('');
  /** Image ids whose bitmap is already being fetched, so a re-render cannot double-load. */
  loading = $state<Set<string>>(new Set());

  tool = $state<ToolId>('select');
  color = $state(DEFAULT_COLOR);
  strokeWidth = $state(4);
  selectedId = $state('');
  /** The id being dragged, so the surface can keep drawing it without a commit. */
  preview = $state<CanvasMark | null>(null);

  get doc(): CanvasDoc {
    return (this.activeChatId && this.#docs[this.activeChatId]) || blank();
  }

  get colors(): string[] {
    return SWATCHES;
  }

  get canUndo(): boolean {
    return (this.#undo.get(this.activeChatId)?.length ?? 0) > 0;
  }

  get canRedo(): boolean {
    return (this.#redo.get(this.activeChatId)?.length ?? 0) > 0;
  }

  #write(doc: CanvasDoc): void {
    if (!this.activeChatId) return;
    const history = this.#undo.get(this.activeChatId) ?? [];
    history.push(this.doc);
    this.#undo.set(this.activeChatId, history.slice(-UNDO_LIMIT));
    this.#redo.delete(this.activeChatId);
    this.#docs[this.activeChatId] = doc;
    this.save();
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(this.#docs).map(([id, doc]) => [id, { ...doc, view: { zoom: 1, panX: 0, panY: 0 } }]))));
    } catch {
      // Private mode or a full quota: the board lasts for this session.
    }
  }

  useChat(chatId: string): void {
    if (this.activeChatId === chatId) return;
    this.activeChatId = chatId;
    this.selectedId = '';
    this.preview = null;
    this.tool = 'select';
  }

  undo(): void {
    const history = this.#undo.get(this.activeChatId);
    if (!history?.length || !this.activeChatId) return;
    const redo = this.#redo.get(this.activeChatId) ?? [];
    redo.push(this.doc);
    this.#redo.set(this.activeChatId, redo);
    this.#docs[this.activeChatId] = history.pop()!;
    this.save();
  }

  redo(): void {
    const redo = this.#redo.get(this.activeChatId);
    if (!redo?.length || !this.activeChatId) return;
    const history = this.#undo.get(this.activeChatId) ?? [];
    history.push(this.doc);
    this.#undo.set(this.activeChatId, history);
    this.#docs[this.activeChatId] = redo.pop()!;
    this.save();
  }

  // ── Images ────────────────────────────────────────────────────────────

  addImage(image: Omit<CanvasImage, 'id'>, src?: string): CanvasImage {
    const added: CanvasImage = { ...image, id: createId('canvas-image') };
    if (src) this.#srcs[added.id] = src;
    this.#write({ ...this.doc, images: [...this.doc.images, added], activeImageId: added.id });
    return added;
  }

  /**
   * A board started from scratch: no upload, no attachment, just paper. The
   * tool jumps to the pen because that is what a blank board is for.
   */
  addBoard(name: string, w?: number, h?: number): CanvasImage {
    const added = this.addImage(blankBoard(name, w, h));
    this.tool = 'freehand';
    this.selectedId = '';
    return added;
  }

  /** Show another board of this conversation. A view change, so not undoable. */
  selectImage(imageId: string): void {
    if (!this.activeChatId) return;
    this.#docs[this.activeChatId] = { ...this.doc, activeImageId: imageId };
    this.selectedId = '';
    this.preview = null;
    this.save();
  }

  /** The bitmap to draw, loading it from the attachment store on first use. */
  src(imageId: string): string | undefined {
    return this.#srcs[imageId];
  }

  async loadSrc(image: CanvasImage, read: (path: string) => Promise<string | null>): Promise<string> {
    const cached = this.#srcs[image.id];
    if (cached) return cached;
    // A blank board has no bitmap to read; only imported images have a path.
    const href = image.path ? await read(image.path) : null;
    if (!href) throw new Error(`Could not read ${image.name}.`);
    this.#srcs[image.id] = href;
    return href;
  }

  removeImage(imageId: string): void {
    const doc = this.doc;
    delete this.#srcs[imageId];
    const images = doc.images.filter((image) => image.id !== imageId);
    this.#write({
      ...doc,
      images,
      marks: doc.marks.filter((mark) => mark.imageId !== imageId),
      activeImageId: doc.activeImageId === imageId ? images[0]?.id : doc.activeImageId
    });
    if (images.length === 0) this.clear();
  }

  clear(): void {
    for (const image of this.doc.images) delete this.#srcs[image.id];
    this.#write(blank());
    this.selectedId = '';
  }

  get image(): CanvasImage | null {
    const doc = this.doc;
    return doc.images.find((image) => image.id === doc.activeImageId) ?? doc.images[0] ?? null;
  }

  // ── Marks ─────────────────────────────────────────────────────────────

  /** A fresh mark for the active image; the surface edits it before committing. */
  draft(kind: MarkKind, box: Box, points?: Array<[number, number]>): CanvasMark {
    const image = this.image;
    return {
      id: createId('canvas-mark'),
      imageId: image?.id ?? '',
      kind,
      ...box,
      points,
      color: this.color,
      width: this.strokeWidth,
      opacity: kind === 'highlight' ? 0.28 : kind === 'blur' ? 1 : 1
    };
  }

  commit(mark: CanvasMark): void {
    if (!mark.imageId) return;
    this.#write({ ...this.doc, marks: withMark(this.doc.marks, mark) });
    this.selectedId = mark.id;
  }

  /** A drag in progress: shown immediately, written once on release. */
  previewMark(mark: CanvasMark | null): void {
    this.preview = mark;
  }

  /** The mark on screen right now — the one being dragged wins over the stored copy. */
  live(id: string): CanvasMark | undefined {
    if (this.preview?.id === id) return this.preview;
    return this.doc.marks.find((mark) => mark.id === id);
  }

  label(id: string, text: string): void {
    const mark = this.doc.marks.find((item) => item.id === id);
    if (!mark) return;
    const trimmed = text.trim();
    const labelled = new Set(this.doc.labelled);
    if (trimmed) labelled.add(id); else labelled.delete(id);
    this.#write({ ...this.doc, marks: withMark(this.doc.marks, { ...mark, text: trimmed || undefined }), labelled: [...labelled] });
  }

  update(mark: CanvasMark, box: Box, points?: Array<[number, number]>): void {
    const image = this.image;
    if (!image) return;
    const next = points ? { ...resizeMark(mark, box, image), points } : resizeMark(mark, box, image);
    this.#write({ ...this.doc, marks: withMark(this.doc.marks, next) });
  }

  move(mark: CanvasMark, from: Point, by: Point): void {
    const image = this.image;
    if (!image) return;
    this.#write({ ...this.doc, marks: withMark(this.doc.marks, moveMark(mark, from, by, image)) });
  }

  remove(id: string): void {
    this.#write({ ...this.doc, marks: withoutMark(this.doc.marks, id), labelled: this.doc.labelled.filter((item) => item !== id) });
    if (this.selectedId === id) this.selectedId = '';
  }

  /** Store a stroke as it is drawn, so freehand needs no preview bookkeeping. */
  stroke(points: Array<[number, number]>): void {
    if (points.length < 2) return;
    this.commit(this.draft('freehand', boundsOf(points), points));
  }

  /** The box a drag produced, honouring the freehand case. */
  static boxFor(from: Point, to: Point): Box {
    return normalizeBox(from, to);
  }

  select(id: string): void {
    this.selectedId = id;
  }

  setInstructions(instructions: string): void {
    if (!this.activeChatId) return;
    this.#docs[this.activeChatId] = { ...this.doc, instructions };
  }

  styleMark(id: string, style: Pick<CanvasMark, 'color' | 'width'>): void {
    const mark = this.doc.marks.find(item => item.id === id);
    if (mark) this.#write({ ...this.doc, marks: withMark(this.doc.marks, { ...mark, ...style }) });
  }
}

export const canvasBoard = new CanvasBoardStore();
