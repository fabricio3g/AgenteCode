/** Pure view logic for the Design canvas: viewport geometry, which page is showing, shortcut mapping. */
import type { DesignFiles } from '$shared/design';

export const VIEWPORTS = [
  { id: 'mobile', width: 390 },
  { id: 'tablet', width: 834 },
  { id: 'desktop', width: 1440 },
  { id: 'fit', width: null }
] as const;
export type ViewportId = (typeof VIEWPORTS)[number]['id'];

/** Breathing room around the frame inside the canvas, in px. */
export const CANVAS_GUTTER = 24;

export interface FrameGeometry { width: number; height: number; scale: number }

/** Zoom levels the canvas steps through; 100% is the page at its real size. */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;
export const ZOOM_MIN = ZOOM_PRESETS[0];
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

/**
 * The frame renders at its viewport's real width, scaled down to fit the pane
 * (never up), so breakpoints behave as they would on that device. Fit uses the
 * pane's own width at scale 1. An explicit zoom (null = fit) sets the scale
 * outright, even above 1, and the frame then grows past the pane so it scrolls.
 */
export function frameGeometry(viewport: ViewportId, container: { width: number; height: number }, zoom: number | null = null): FrameGeometry {
  const room = { width: Math.max(160, container.width - CANVAS_GUTTER * 2), height: Math.max(160, container.height - CANVAS_GUTTER * 2) };
  const width = VIEWPORTS.find((item) => item.id === viewport)?.width ?? null;
  if (zoom !== null) {
    const scale = clampZoom(zoom);
    return { width: width ?? room.width / scale, height: room.height / scale, scale };
  }
  if (width === null) return { width: room.width, height: room.height, scale: 1 };
  const scale = Math.min(1, room.width / width);
  return { width, height: Math.round(room.height / scale), scale };
}

/** The HTML file to show: the current one if it still exists, else the entry page, else nothing. */
export function resolveSelected(selected: string, data: Pick<DesignFiles, 'pages' | 'variants'>): string {
  if (data.pages.includes(selected) || data.variants.some((variant) => variant.entry === selected)) return selected;
  return data.pages[0] ?? '';
}

export type DesignShortcut = { kind: 'viewport'; viewport: ViewportId } | { kind: 'reload' | 'variants' | 'versions' | 'chat' | 'timeline' };

const DIGITS: Record<string, ViewportId> = { Digit1: 'mobile', Digit2: 'tablet', Digit3: 'desktop', Digit4: 'fit' };
const LETTERS: Record<string, DesignShortcut['kind']> = { KeyR: 'reload', KeyV: 'variants', KeyT: 'versions', KeyC: 'chat', KeyM: 'timeline' };

/** Ctrl/⌘+Alt+key. `code` is used because Alt changes `key` on macOS. */
export function shortcutFor(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): DesignShortcut | null {
  if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey) return null;
  if (DIGITS[event.code]) return { kind: 'viewport', viewport: DIGITS[event.code] };
  const kind = LETTERS[event.code];
  return kind && kind !== 'viewport' ? ({ kind } as DesignShortcut) : null;
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

/** The toolbar's secondary controls, the ones that fold into its More menu when the canvas is narrow. */
export type ToolbarItem = 'page' | 'scheme' | 'system' | 'reload' | 'folder' | 'export';

export interface ToolbarPlan {
  /** Whether the row is packed tight: its groups sit closer when the canvas is cramped. */
  tight: boolean;
  /** Whether the − and + zoom steps show beside the percentage (the percentage always does). */
  zoomSteps: boolean;
  /** Whether the design-system chip shows its name, or only its icon. */
  systemName: boolean;
  /** Controls drawn on the row, in the order the toolbar draws them. */
  inline: ToolbarItem[];
  /** Controls listed in the More menu, in the order the menu lists them. */
  more: ToolbarItem[];
}

/**
 * Which toolbar controls fit the canvas column. Wide keeps everything on the
 * row; compact moves the page, scheme, folder and export into More; cramped
 * also moves the system chip and reload, and the zoom keeps only its percentage.
 */
export function toolbarPlan(canvasWidth: number): ToolbarPlan {
  if (canvasWidth >= 880) {
    return { tight: false, zoomSteps: true, systemName: true, inline: ['page', 'scheme', 'system', 'reload', 'folder', 'export'], more: [] };
  }
  if (canvasWidth >= 480) {
    return { tight: false, zoomSteps: true, systemName: false, inline: ['system', 'reload'], more: ['page', 'scheme', 'folder', 'export'] };
  }
  return { tight: true, zoomSteps: false, systemName: false, inline: [], more: ['page', 'scheme', 'system', 'reload', 'folder', 'export'] };
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
