/**
 * The canvas board's data: the images on it, the marks drawn over them, and
 * the instruction the agent finally reads.
 *
 * Every coordinate is in the *source image's own pixels*, never in screen
 * pixels. Zoom and pan are a transform on the `viewBox` alone, so no amount of
 * scrolling can silently rescale the geometry the model is told about.
 * Prompt coordinates are emitted as fractions of the image size for the same
 * reason: a screenshot resized on its way through a provider still points at
 * the same place.
 *
 * Pure on purpose — no runes, no DOM, no store. Everything here is unit
 * tested, and the reactive board lives beside it in `canvas-board.svelte.ts`.
 */

export type MarkKind = 'rect' | 'ellipse' | 'arrow' | 'line' | 'freehand' | 'text' | 'highlight' | 'blur';
/** `select` picks and drags existing marks, `pan` moves the board; every
 * other tool draws a mark of that kind. */
export type ToolId = MarkKind | 'select' | 'pan';

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

export interface CanvasImage {
  id: string;
  /**
   * Where the daemon stored the imported copy — what an `@path` refers to.
   * Absent on a blank board: there is no bitmap, only paper to draw on.
   */
  path?: string;
  name: string;
  /** Natural bitmap size, and therefore the unit of every mark on this image. */
  w: number;
  h: number;
}

export interface CanvasMark extends Box {
  id: string;
  imageId: string;
  kind: MarkKind;
  /** Freehand ink only. A line or arrow derives its points from the box. */
  points?: Array<[number, number]>;
  /** The label on a text mark, and the instruction on a point. */
  text?: string;
  color: string;
  width: number;
  opacity: number;
}

export interface CanvasView { zoom: number; panX: number; panY: number }

export interface CanvasDoc {
  images: CanvasImage[];
  marks: CanvasMark[];
  view: CanvasView;
  /** Which marks carry an instruction worth cropping for. */
  labelled: string[];
  /** The board the panel paints when a conversation holds more than one. */
  activeImageId?: string;
}

/** Strokes a user can draw with, in toolbar order. */
export const TOOLS: ToolId[] = ['select', 'rect', 'ellipse', 'arrow', 'line', 'freehand', 'text', 'highlight', 'blur', 'pan'];

/** Paper for a board the user starts from scratch, in the 16:10 most screens arrive in. */
export const BOARD_W = 1600;
export const BOARD_H = 1000;

/**
 * A blank board has no source bitmap: nothing was uploaded, so there is no
 * attachment path to read and nothing to preview. Everything else about it is
 * an ordinary image record, which keeps marks, crops and the whole handoff
 * geometry unchanged.
 */
export function isBlankBoard(image: CanvasImage): boolean {
  return !image.path;
}

/** The record a new blank board is created from; the store mints the id. */
export function blankBoard(name: string, w: number = BOARD_W, h: number = BOARD_H): Omit<CanvasImage, 'id'> {
  return { name, w, h };
}

/** Marks that *point* at something: a region a crop can be cut around. */
export function isPoint(mark: CanvasMark): boolean {
  return mark.kind === 'rect' || mark.kind === 'ellipse' || mark.kind === 'arrow' || mark.kind === 'line' || mark.kind === 'freehand';
}

/** What a drag leaves behind: a box with non-negative sides, whatever corner it started at. */
export function normalizeBox(from: Point, to: Point): Box {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
}

/** The smallest box holding every point of a freehand stroke. */
export function boundsOf(points: Array<[number, number]>): Box {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Grow (or, with a negative pad, shrink) a box, clamped to the image. */
export function padded(box: Box, pad: number, image: CanvasImage): Box {
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return {
    x,
    y,
    w: Math.min(image.w, box.x + box.w + pad) - x,
    h: Math.min(image.h, box.y + box.h + pad) - y
  };
}

/** Add or replace a mark, keeping the list order stable so ids stay meaningful. */
export function withMark(marks: CanvasMark[], mark: CanvasMark): CanvasMark[] {
  const at = marks.findIndex((item) => item.id === mark.id);
  if (at < 0) return [...marks, mark];
  const next = marks.slice();
  next[at] = mark;
  return next;
}

export function withoutMark(marks: CanvasMark[], id: string): CanvasMark[] {
  return marks.filter((mark) => mark.id !== id);
}

export function marksFor(doc: CanvasDoc, imageId: string): CanvasMark[] {
  return doc.marks.filter((mark) => mark.imageId === imageId);
}

/** Move/resize a mark; the box is normalized so a flip cannot store a negative side. */
export function moveMark(mark: CanvasMark, from: Point, by: Point, image: CanvasImage): CanvasMark {
  const box = normalizeBox({ x: from.x + by.x, y: from.y + by.y }, { x: from.x + by.x + mark.w, y: from.y + by.y + mark.h });
  return { ...mark, ...clampToImage(box, image) };
}

export function resizeMark(mark: CanvasMark, box: Box, image: CanvasImage): CanvasMark {
  return { ...mark, ...clampToImage(box, image) };
}

function clampToImage(box: Box, image: CanvasImage): Box {
  const x = Math.max(0, Math.min(image.w, box.x));
  const y = Math.max(0, Math.min(image.h, box.y));
  return { x, y, w: Math.min(image.w - x, box.w), h: Math.min(image.h - y, box.h) };
}

// ── Handing the board to the agent ────────────────────────────────────────

/**
 * One PNG to render and import: a region of an image (`box: null` is all of
 * it) carrying the marks that belong there.
 */
export interface HandoffEntry {
  imageId: string;
  box: Box | null;
  marks: CanvasMark[];
}

export interface HandoffPlan {
  /** One full-size annotated image per source image, in board order. */
  overview: HandoffEntry[];
  /** One tight crop per point that carries an instruction. */
  points: HandoffEntry[];
}

/**
 * What to export, as pure geometry.
 *
 * A point only earns a crop when it was given a label — an unlabelled box is
 * an outline the model can already see on the overview image, and sending it
 * twice just burns context.
 */
export function planHandoff(doc: CanvasDoc): HandoffPlan {
  const labelled = new Set(doc.labelled);
  const overview = doc.images.map((image) => ({ imageId: image.id, box: null, marks: marksFor(doc, image.id) }));
  const points: HandoffEntry[] = [];
  for (const image of doc.images) {
    for (const mark of marksFor(doc, image.id)) {
      if (!isPoint(mark) || !labelled.has(mark.id)) continue;
      points.push({ imageId: image.id, box: padded(mark, CROP_PAD, image), marks: [mark] });
    }
  }
  return { overview, points };
}

/** Breathing room around a crop, in image pixels. */
export const CROP_PAD = 12;

export interface HandoffPoint {
  label: string;
  kind: MarkKind;
  /** Fraction of image size, not pixels. */
  box: Box;
  path: string;
}

export interface HandoffPrompt {
  text: string;
  /** Number of files the caller has to import — one per overview, one per point. */
  fileCount: number;
}

/** Two decimals is the point where a fraction stops being useful to a model. */
export function formatFraction(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

export function asFractions(box: Box, image: CanvasImage): Box {
  return { x: box.x / image.w, y: box.y / image.h, w: box.w / image.w, h: box.h / image.h };
}

/**
 * The message the agent receives: an overall view of each image, then one line
 * per point naming what was drawn, where it sits, and the crop that isolates
 * it. The user writes the labels, so the prose is theirs; only the scaffold
 * is ours.
 */
/**
 * Append to a draft without eating what is already there.
 *
 * Both composers need this and neither should own it: the Code composer holds
 * its text locally, Home's lives in the store, and the canvas panel has to
 * merge into whichever one it finds.
 */
export function mergeDraft(current: string, addition: string): string {
  const base = current.trimEnd();
  return base ? `${base}\n\n${addition}` : addition;
}

export function composePrompt(overviewPaths: string[], points: HandoffPoint[], header: string, empty: string): HandoffPrompt {
  const files = [...overviewPaths, ...points.map((point) => point.path)].filter(Boolean);
  if (!files.length) return { text: empty, fileCount: 0 };

  const lines = points.map((point, index) => {
    const box = point.box;
    const where = `(${formatFraction(box.x)}, ${formatFraction(box.y)})–(${formatFraction(box.x + box.w)}, ${formatFraction(box.y + box.h)})`;
    return `${index + 1}. "${point.label}" — ${point.kind} at ${where} — @${point.path}`;
  });

  const views = overviewPaths.filter(Boolean).map((path) => `@${path}`).join(', ');
  const body = lines.length ? `\n\n${lines.join('\n')}` : '';
  return { text: `${header}\n\nOverall: ${views}.${body}`, fileCount: files.length };
}
