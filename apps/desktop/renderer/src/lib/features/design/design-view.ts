/** Pure view logic for the Design canvas: the board of frames, zoom and pan, which page is showing, shortcut mapping. */
import type { DesignFiles } from '$shared/design';

/**
 * The sizes a page can be drawn at on the board, widest first (the order a row
 * lays them out in). Each frame is a screen of that device: content scrolls
 * inside it, so a long page never stretches the board.
 */
export const FRAME_SIZES = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'tablet', width: 834, height: 1112 },
  { id: 'mobile', width: 390, height: 844 }
] as const;
export type FrameSizeId = (typeof FRAME_SIZES)[number]['id'];
export const FRAME_SIZE_IDS: readonly FrameSizeId[] = FRAME_SIZES.map((size) => size.id);

/** Space between frames on the board, in page px: beside each other in a row, and between rows (room for the labels). */
export const BOARD_GAP = { column: 120, row: 240 } as const;
/** Room kept around the board when it is fitted to the pane, in screen px. */
export const FIT_PAD = 48;

/** One frame on the board: a page (or variant entry) at one size, placed in page px. */
export interface BoardFrame {
  key: string;
  page: string;
  size: FrameSizeId;
  variant: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The board's frames and its bounds in page px (a frame dragged up or left moves the origin below zero). */
export interface Board { frames: BoardFrame[]; x: number; y: number; width: number; height: number }

/** Where the user dragged frames to, by frame key, in page px; anything else keeps its laid-out place. */
export type FramePositions = Record<string, { x: number; y: number }>;

/** The key of the frame that draws `page` at `size`. */
export const frameKey = (page: string, size: FrameSizeId) => `${size}:${page}`;

/**
 * Lays the board out: a row per page, then a row per variant, each row holding
 * one frame per chosen size, widest first. Sizes keep FRAME_SIZES order however
 * they were picked, and an empty or unknown choice falls back to desktop. A
 * frame the user dragged sits where they left it.
 */
export function boardLayout(pages: readonly string[], variants: readonly string[], sizes: readonly FrameSizeId[], positions: FramePositions = {}): Board {
  const chosen = FRAME_SIZES.filter((size) => sizes.includes(size.id));
  const row = chosen.length ? chosen : [FRAME_SIZES[0]];
  const rowHeight = Math.max(...row.map((size) => size.height));
  const frames: BoardFrame[] = [];
  const entries = [...pages.map((page) => ({ page, variant: false })), ...variants.map((page) => ({ page, variant: true }))];
  entries.forEach((entry, index) => {
    const y = index * (rowHeight + BOARD_GAP.row);
    let x = 0;
    for (const size of row) {
      const key = frameKey(entry.page, size.id);
      const moved = positions[key];
      const place = moved && Number.isFinite(moved.x) && Number.isFinite(moved.y) ? moved : { x, y };
      frames.push({ key, page: entry.page, size: size.id, variant: entry.variant, x: place.x, y: place.y, width: size.width, height: size.height });
      x += size.width + BOARD_GAP.column;
    }
  });
  if (!frames.length) return { frames, x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + frame.width));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
  return { frames, x: left, y: top, width: right - left, height: bottom - top };
}

/** Zoom levels the zoom menu offers; 100% is the page at its real size. */
export const ZOOM_PRESETS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2] as const;
/** A fitted board of many frames may go below the smallest preset, never below this. */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = ZOOM_PRESETS[ZOOM_PRESETS.length - 1];

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** The next preset above (1) or below (-1) `current`; at either end it stays put. */
export function nextZoomPreset(current: number, direction: 1 | -1): number {
  const next = direction > 0
    ? ZOOM_PRESETS.find((preset) => preset > current + 1e-6)
    : [...ZOOM_PRESETS].reverse().find((preset) => preset < current - 1e-6);
  return next ?? clampZoom(current);
}

/** "75%" for a scale. */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** Where the board sits on screen: its scale and the screen position of its top-left corner. */
export interface BoardView { scale: number; x: number; y: number }
type Size = { width: number; height: number };

/**
 * The view that shows a box of the board (the whole board, or one frame) in
 * the pane: as large as fits with FIT_PAD around it, never above 100%, centred.
 * `origin` is the box's top-left in page px.
 */
export function fitView(box: Size, pane: Size, origin = { x: 0, y: 0 }): BoardView {
  if (box.width <= 0 || box.height <= 0 || pane.width <= 0 || pane.height <= 0) return { scale: 1, x: FIT_PAD, y: FIT_PAD };
  const room = { width: Math.max(1, pane.width - FIT_PAD * 2), height: Math.max(1, pane.height - FIT_PAD * 2) };
  const scale = clampZoom(Math.min(1, room.width / box.width, room.height / box.height));
  return {
    scale,
    x: Math.round((pane.width - box.width * scale) / 2 - origin.x * scale),
    y: Math.round((pane.height - box.height * scale) / 2 - origin.y * scale)
  };
}

/** The view after zooming to `scale` around a screen point, which stays over the same spot of the board. */
export function zoomAt(view: BoardView, scale: number, point: { x: number; y: number }): BoardView {
  const next = clampZoom(scale);
  const ratio = next / view.scale;
  return { scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

/** A frame's box on screen under a view. */
export function screenBox(frame: Pick<BoardFrame, 'x' | 'y' | 'width' | 'height'>, view: BoardView) {
  return { left: view.x + frame.x * view.scale, top: view.y + frame.y * view.scale, width: frame.width * view.scale, height: frame.height * view.scale };
}

/**
 * Whether a frame is on screen, or within `margin` px of it. Frames far off
 * screen draw a blank sheet instead of running the page, so a board of many
 * frames costs what the pane shows.
 */
export function frameOnScreen(frame: Pick<BoardFrame, 'x' | 'y' | 'width' | 'height'>, view: BoardView, pane: Size, margin = 200): boolean {
  const box = screenBox(frame, view);
  return box.left < pane.width + margin && box.top < pane.height + margin && box.left + box.width > -margin && box.top + box.height > -margin;
}

/** The HTML file to show: the current one if it still exists, else the entry page, else nothing. */
export function resolveSelected(selected: string, data: Pick<DesignFiles, 'pages' | 'variants'>): string {
  if (data.pages.includes(selected) || data.variants.some((variant) => variant.entry === selected)) return selected;
  return data.pages[0] ?? '';
}

export type DesignShortcut = { kind: 'size'; size: FrameSizeId } | { kind: 'fit' | 'reload' | 'variants' | 'versions' | 'chat' | 'timeline' | 'layers' };

const DIGITS: Record<string, FrameSizeId> = { Digit1: 'mobile', Digit2: 'tablet', Digit3: 'desktop' };
const LETTERS: Record<string, Exclude<DesignShortcut['kind'], 'size'>> = { Digit4: 'fit', KeyR: 'reload', KeyV: 'variants', KeyT: 'versions', KeyC: 'chat', KeyM: 'timeline', KeyL: 'layers' };

/** Ctrl/⌘+Alt+key. `code` is used because Alt changes `key` on macOS. 1–3 toggle a size on the board, 4 fits it. */
export function shortcutFor(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): DesignShortcut | null {
  if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey) return null;
  if (DIGITS[event.code]) return { kind: 'size', size: DIGITS[event.code] };
  const kind = LETTERS[event.code];
  return kind ? { kind } : null;
}

/** "variants/bold/index.html" → "bold"; a plain page keeps its file name. */
export function pageLabel(path: string): string {
  const variant = path.match(/^variants\/([^/]+)\//);
  return variant ? variant[1] : path;
}

/** The top chrome of every column: the toolbar and the inspector header share this height. */
export const CHROME_HEIGHT = 36;

/** Pane widths in px at the app's 100% scale (16px = 1rem). */
export const DOCK_WIDTH = { min: 288, default: 416, max: 640 } as const;
export const INSPECTOR_WIDTH = { min: 240, default: 288, max: 512 } as const;
/** The canvas keeps at least this much width before a pane beside it gives way to an overlay. */
export const CANVAS_MIN = 352;
/** An overlaid pane leaves this much of the canvas uncovered, so the canvas and its tool pill stay usable. */
export const SHEET_PEEK = 128;

/** Clamps a width to [min, max]; a max below min resolves to min. Rounds to whole pixels. */
export function clampWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

export interface PaneRequest {
  dockOpen: boolean;
  dockWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
}

export interface PaneLayout {
  /**
   * Inline panes sit beside the canvas. An overlaid pane covers the canvas's edge
   * as a sheet when the canvas would drop below CANVAS_MIN. `hidden` marks a dock
   * that gives way: on a window too narrow for two sheets, the inspector takes the room.
   */
  dock: { width: number; overlay: boolean; hidden: boolean; limit: number };
  inspector: { width: number; overlay: boolean; limit: number };
  /** Space the inline dock takes from the canvas's left edge. */
  canvasLeft: number;
  /** Space the inline inspector takes from the canvas's right edge. */
  canvasRight: number;
}

/**
 * Where the panes sit in a surface of `surface` px. The canvas comes first, then
 * the dock, then the inspector. The dock goes beside the canvas while the canvas
 * keeps its minimum, else it overlays the canvas's left edge. When the inspector
 * would not fit beside an inline dock, the dock narrows to its minimum first; if
 * the inspector still does not fit, it overlays the canvas's right edge. Two
 * overlays at once would leave no canvas to see, so the dock steps aside then.
 * Each `limit` is the widest that pane may be dragged in its current mode.
 */
export function paneLayout(surface: number, request: PaneRequest): PaneLayout {
  const dockInline0 = request.dockOpen && surface - CANVAS_MIN >= DOCK_WIDTH.min;
  let dockWidth = clampWidth(request.dockWidth, DOCK_WIDTH.min, Math.min(DOCK_WIDTH.max, dockInline0 ? surface - CANVAS_MIN : surface - SHEET_PEEK));
  if (request.inspectorOpen && dockInline0 && surface - dockWidth - CANVAS_MIN < INSPECTOR_WIDTH.min) dockWidth = DOCK_WIDTH.min;
  const dockInline = dockInline0;
  const canvasLeft = dockInline ? dockWidth : 0;
  const inspectorRoom = surface - canvasLeft - CANVAS_MIN;
  const inspectorInline = request.inspectorOpen && inspectorRoom >= INSPECTOR_WIDTH.min;
  const inspectorLimit = Math.min(INSPECTOR_WIDTH.max, inspectorInline ? inspectorRoom : surface - canvasLeft - SHEET_PEEK);
  const inspectorWidth = clampWidth(request.inspectorWidth, INSPECTOR_WIDTH.min, Math.max(INSPECTOR_WIDTH.min, inspectorLimit));
  const dockOverlay = request.dockOpen && !dockInline;
  const inspectorOverlay = request.inspectorOpen && !inspectorInline;
  const dockLimit = Math.min(DOCK_WIDTH.max, dockInline ? surface - CANVAS_MIN : surface - SHEET_PEEK);
  return {
    dock: { width: dockWidth, overlay: dockOverlay, hidden: dockOverlay && inspectorOverlay, limit: Math.max(DOCK_WIDTH.min, dockLimit) },
    inspector: { width: inspectorWidth, overlay: inspectorOverlay, limit: Math.max(INSPECTOR_WIDTH.min, inspectorLimit) },
    canvasLeft,
    canvasRight: inspectorInline ? inspectorWidth : 0
  };
}

/**
 * The top bar's secondary controls. Page, system and export can sit on the row;
 * the preview scheme, reload and the folder always live in More, so the bar
 * stays one quiet line. Zoom lives in the tool dock at the bottom.
 */
export type ToolbarItem = 'page' | 'scheme' | 'system' | 'reload' | 'folder' | 'export';

export interface ToolbarPlan {
  /** Whether the row is packed tight: its groups sit closer when the canvas is cramped. */
  tight: boolean;
  /** Whether the design-system chip shows its name, or only its icon. */
  systemName: boolean;
  /** Controls drawn on the row, in the order the toolbar draws them. */
  inline: ToolbarItem[];
  /** Controls listed in the More menu, in the order the menu lists them. */
  more: ToolbarItem[];
}

/**
 * Which top-bar controls fit the canvas column. Wide keeps the page, the
 * system chip and Export on the row; compact moves the system into More;
 * cramped moves everything into More.
 */
export function toolbarPlan(canvasWidth: number): ToolbarPlan {
  if (canvasWidth >= 760) {
    return { tight: false, systemName: true, inline: ['page', 'system', 'export'], more: ['scheme', 'reload', 'folder'] };
  }
  if (canvasWidth >= 520) {
    return { tight: false, systemName: false, inline: ['page', 'export'], more: ['system', 'scheme', 'reload', 'folder'] };
  }
  return { tight: true, systemName: false, inline: [], more: ['page', 'system', 'scheme', 'reload', 'folder', 'export'] };
}

/**
 * How many leading items fit on `rows` lines of a wrapping row. `tops` are the
 * items' top edges in DOM order. Items of one line can differ by a few pixels
 * (a button is taller than a chip and sits centred), so an item starts a new
 * line only when its top is more than `slack` below the line's first item; a
 * line is at least a chip and its gap tall, so the slack stays well under that.
 */
export function itemsInRows(tops: readonly number[], rows: number, slack = 8): number {
  let line = 0;
  let lineTop = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < tops.length; index += 1) {
    if (tops[index] > lineTop + slack) {
      line += 1;
      lineTop = tops[index];
      if (line > rows) return index;
    }
  }
  return tops.length;
}

/** A comment pin is a 20px disc; it sits this far up and left of the element's corner. */
export const PIN_SIZE = 20;
export const PIN_GAP = 4;

/**
 * Where a comment pin sits on screen: just outside the top-left corner of the
 * element it is pinned to (up and to the left, so it never covers the element's
 * text), clamped so the pin stays inside the frame. `anchor` is the element's
 * page position; the result is in px on the stage, `scale` included.
 */
export function pinOrigin(anchor: { x: number; y: number }, scroll: { x: number; y: number }, scale: number, frame: { width: number; height: number }): { left: number; top: number } {
  const clampTo = (value: number, limit: number) => Math.max(0, Math.min(Math.max(0, limit - PIN_SIZE), value));
  return {
    left: clampTo((anchor.x - scroll.x) * scale - PIN_SIZE - PIN_GAP, frame.width),
    top: clampTo((anchor.y - scroll.y) * scale - PIN_SIZE - PIN_GAP, frame.height)
  };
}

export interface Rect { left: number; top: number; width: number; height: number }

/**
 * Where the edit toolbar floats: left edges aligned with the selected element
 * (kept inside the pane), just above it, or below it when there is no room
 * above. `minTop` is the highest the bar may sit: the top edge of the frame
 * the element is in, so the bar never covers the frame's label above it (it
 * goes below the element instead). `below` tells the selection prompt to step
 * out of its way.
 */
export function editBarPlacement(el: Rect, bar: Size, pane: Size, gap = 8, edge = 4, minTop = edge): { left: number; top: number; below: boolean } {
  const left = Math.max(edge, Math.min(el.left, pane.width - bar.width - edge));
  const above = el.top - gap - bar.height;
  if (above >= Math.max(edge, minTop)) return { left, top: above, below: false };
  const top = Math.min(el.top + el.height + gap, Math.max(edge, pane.height - bar.height - edge));
  return { left, top, below: true };
}
