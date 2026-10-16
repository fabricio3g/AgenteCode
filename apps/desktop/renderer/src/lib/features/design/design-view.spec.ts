import { describe, expect, it } from 'vitest';
import { BOARD_GAP, boardLayout, CANVAS_MIN, clampZoom, DOCK_WIDTH, FIT_PAD, fitView, frameOnScreen, INSPECTOR_WIDTH, itemsInRows, nextZoomPreset, pageLabel, paneLayout, PIN_SIZE, pinOrigin, resolveSelected, screenBox, SHEET_PEEK, shortcutFor, toolbarPlan, ZOOM_MIN, zoomAt, zoomLabel } from './design-view';

describe('boardLayout', () => {
  it('lays a row per page then per variant, one frame per size, widest first', () => {
    const board = boardLayout(['index.html', 'pricing.html'], ['variants/bold/index.html'], ['mobile', 'desktop']);
    expect(board.frames.map((frame) => frame.key)).toEqual([
      'desktop:index.html', 'mobile:index.html',
      'desktop:pricing.html', 'mobile:pricing.html',
      'desktop:variants/bold/index.html', 'mobile:variants/bold/index.html'
    ]);
    const [desktop, mobile, nextRow] = board.frames;
    expect(desktop).toMatchObject({ x: 0, y: 0, width: 1440, height: 900, variant: false });
    expect(mobile).toMatchObject({ x: 1440 + BOARD_GAP.column, y: 0, width: 390, height: 844 });
    // Rows are as tall as their tallest size, so every row starts on the same rhythm.
    expect(nextRow.y).toBe(900 + BOARD_GAP.row);
    expect(board.frames.at(-1)?.variant).toBe(true);
    expect(board).toMatchObject({ x: 0, y: 0, width: 1440 + BOARD_GAP.column + 390, height: 3 * 900 + 2 * BOARD_GAP.row });
  });

  it('keeps a dragged frame where it was left and grows the bounds around it', () => {
    const board = boardLayout(['index.html'], [], ['desktop', 'mobile'], { 'mobile:index.html': { x: -600, y: 1200 }, 'desktop:gone.html': { x: 9, y: 9 } });
    expect(board.frames[1]).toMatchObject({ x: -600, y: 1200 });
    expect(board).toMatchObject({ x: -600, y: 0, width: 600 + 1440, height: 1200 + 844 });
  });

  it('falls back to desktop when no size is chosen, and is empty with no pages', () => {
    expect(boardLayout(['index.html'], [], []).frames.map((frame) => frame.size)).toEqual(['desktop']);
    expect(boardLayout([], [], ['desktop'])).toEqual({ frames: [], x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('board view', () => {
  it('fits the board inside the pane with padding, centred, never above 100%', () => {
    const view = fitView({ width: 2000, height: 1000 }, { width: 1096, height: 696 });
    expect(view.scale).toBeCloseTo(0.5, 5);
    expect(view.x).toBe(48);
    expect(view.y).toBe(98);
    expect(fitView({ width: 300, height: 200 }, { width: 1000, height: 800 }).scale).toBe(1);
  });

  it('fits one frame by its own origin', () => {
    const view = fitView({ width: 390, height: 844 }, { width: 600, height: 944 }, { x: 1560, y: 0 });
    expect(view.scale).toBe(1);
    expect(screenBox({ x: 1560, y: 0, width: 390, height: 844 }, view)).toEqual({ left: 105, top: 50, width: 390, height: 844 });
  });

  it('survives a pane or board that has not been measured', () => {
    expect(fitView({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({ scale: 1, x: FIT_PAD, y: FIT_PAD });
    expect(fitView({ width: 800, height: 600 }, { width: 0, height: 0 }).scale).toBe(1);
  });

  it('zooms around a point, which stays over the same spot of the board', () => {
    const view = { scale: 0.5, x: 100, y: 40 };
    const point = { x: 300, y: 240 };
    const before = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
    const next = zoomAt(view, 1, point);
    expect(next.scale).toBe(1);
    expect((point.x - next.x) / next.scale).toBeCloseTo(before.x, 6);
    expect((point.y - next.y) / next.scale).toBeCloseTo(before.y, 6);
  });

  it('runs only the frames on screen or near it', () => {
    const pane = { width: 800, height: 600 };
    const view = { scale: 0.5, x: 0, y: 0 };
    expect(frameOnScreen({ x: 0, y: 0, width: 1440, height: 900 }, view, pane)).toBe(true);
    expect(frameOnScreen({ x: 4000, y: 0, width: 1440, height: 900 }, view, pane)).toBe(false);
    expect(frameOnScreen({ x: 0, y: -2400, width: 1440, height: 900 }, view, pane)).toBe(false);
  });

  it('clamps zoom to its range, lets a fitted board go below the presets, and ignores non-finite input', () => {
    expect(clampZoom(9)).toBe(2);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(0.08)).toBe(0.08);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe('zoom presets', () => {
  it('steps to the next preset in each direction and stops at the ends', () => {
    expect(nextZoomPreset(1, 1)).toBe(1.5);
    expect(nextZoomPreset(1, -1)).toBe(0.75);
    expect(nextZoomPreset(0.7, 1)).toBe(0.75);
    expect(nextZoomPreset(0.7, -1)).toBe(0.5);
    expect(nextZoomPreset(2, 1)).toBe(2);
    expect(nextZoomPreset(0.1, -1)).toBe(0.1);
    expect(nextZoomPreset(0.08, 1)).toBe(0.1);
  });

  it('labels a scale as a whole percentage', () => {
    expect(zoomLabel(0.75)).toBe('75%');
    expect(zoomLabel(1.5)).toBe('150%');
  });
});

describe('resolveSelected', () => {
  const data = { pages: ['index.html', 'pricing.html'], variants: [{ name: 'bold', entry: 'variants/bold/index.html' }] };
  it('keeps a page or variant that exists, else falls back to the entry page', () => {
    expect(resolveSelected('pricing.html', data)).toBe('pricing.html');
    expect(resolveSelected('variants/bold/index.html', data)).toBe('variants/bold/index.html');
    expect(resolveSelected('gone.html', data)).toBe('index.html');
    expect(resolveSelected('x', { pages: [], variants: [] })).toBe('');
  });
});

describe('shortcutFor', () => {
  const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({ code, ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, ...extra });
  it('maps Ctrl/Cmd+Alt combos', () => {
    expect(shortcutFor(key('Digit1'))).toEqual({ kind: 'size', size: 'mobile' });
    expect(shortcutFor(key('Digit3'))).toEqual({ kind: 'size', size: 'desktop' });
    expect(shortcutFor(key('Digit4', { ctrlKey: false, metaKey: true }))).toEqual({ kind: 'fit' });
    expect(shortcutFor(key('KeyR'))).toEqual({ kind: 'reload' });
    expect(shortcutFor(key('KeyV'))).toEqual({ kind: 'variants' });
    expect(shortcutFor(key('KeyT'))).toEqual({ kind: 'versions' });
    expect(shortcutFor(key('KeyC'))).toEqual({ kind: 'chat' });
  });
  it('ignores everything else', () => {
    expect(shortcutFor(key('KeyR', { altKey: false }))).toBeNull();
    expect(shortcutFor(key('KeyR', { ctrlKey: false }))).toBeNull();
    expect(shortcutFor(key('KeyR', { shiftKey: true }))).toBeNull();
    expect(shortcutFor(key('KeyZ'))).toBeNull();
  });
});

describe('pageLabel', () => {
  it('names a variant by its folder', () => {
    expect(pageLabel('variants/bold/index.html')).toBe('bold');
    expect(pageLabel('pricing.html')).toBe('pricing.html');
  });
});

describe('paneLayout', () => {
  const open = { dockOpen: true, dockWidth: DOCK_WIDTH.default, inspectorOpen: true, inspectorWidth: INSPECTOR_WIDTH.default };

  it('keeps both panes inline when the canvas keeps its minimum', () => {
    const layout = paneLayout(1100, open);
    expect(layout.dock).toMatchObject({ width: 416, overlay: false });
    expect(layout.inspector).toMatchObject({ width: 288, overlay: false });
    expect(layout.canvasLeft + layout.canvasRight).toBe(416 + 288);
  });

  it('narrows the dock to fit beside the canvas before it overlays', () => {
    const layout = paneLayout(760, { ...open, inspectorOpen: false });
    expect(layout.dock).toMatchObject({ width: 760 - CANVAS_MIN, overlay: false });
    expect(layout.canvasLeft).toBe(760 - CANVAS_MIN);
  });

  it('overlays the dock when not even its minimum fits beside the canvas', () => {
    const layout = paneLayout(600, { ...open, inspectorOpen: false });
    expect(layout.dock).toMatchObject({ width: 416, overlay: true });
    expect(layout.canvasLeft).toBe(0);
  });

  it('narrows the dock to its minimum before the inspector would have to overlay', () => {
    const layout = paneLayout(996, open);
    expect(layout.dock).toMatchObject({ width: DOCK_WIDTH.min, overlay: false });
    expect(layout.inspector).toMatchObject({ width: 288, overlay: false });
    expect(layout.canvasLeft).toBe(DOCK_WIDTH.min);
    expect(layout.canvasRight).toBe(288);
  });

  it('turns the inspector into a sheet over the canvas when even the narrowed dock leaves no room', () => {
    const layout = paneLayout(706, open);
    expect(layout.dock).toMatchObject({ width: DOCK_WIDTH.min, overlay: false, hidden: false });
    expect(layout.inspector).toMatchObject({ overlay: true, width: 288 });
    expect(layout.canvasLeft).toBe(DOCK_WIDTH.min);
    expect(layout.canvasRight).toBe(0);
  });

  it('shows only one sheet when a window is too narrow for both, so the canvas stays visible', () => {
    const layout = paneLayout(536, open);
    expect(layout.dock).toMatchObject({ overlay: true, hidden: true });
    expect(layout.inspector.overlay).toBe(true);
    expect(536 - layout.inspector.width).toBeGreaterThanOrEqual(CANVAS_MIN - SHEET_PEEK);
  });

  it('never lets the canvas drop below its minimum for an inline pane', () => {
    for (let surface = 640; surface <= 1600; surface += 20) {
      const layout = paneLayout(surface, open);
      if (!layout.dock.overlay && !layout.inspector.overlay) {
        expect(surface - layout.canvasLeft - layout.canvasRight).toBeGreaterThanOrEqual(CANVAS_MIN);
      }
    }
  });

  it('gives a closed pane no space and no overlay', () => {
    const layout = paneLayout(900, { ...open, dockOpen: false, inspectorOpen: false });
    expect(layout).toMatchObject({ canvasLeft: 0, canvasRight: 0, dock: { overlay: false }, inspector: { overlay: false } });
  });

  it('clamps a stored width to the room the pane has in its current mode', () => {
    expect(paneLayout(900, { ...open, dockWidth: 2000, inspectorOpen: false }).dock).toMatchObject({ width: 900 - CANVAS_MIN, limit: 900 - CANVAS_MIN });
    expect(paneLayout(900, { ...open, dockWidth: 10, inspectorOpen: false }).dock.width).toBe(DOCK_WIDTH.min);
    expect(paneLayout(1400, { ...open, dockWidth: 2000, inspectorOpen: false }).dock.width).toBe(DOCK_WIDTH.max);
  });
});

describe('toolbarPlan', () => {
  it('keeps the page, the system and Export on the row when the canvas is wide', () => {
    const plan = toolbarPlan(1000);
    expect(plan).toMatchObject({ tight: false, systemName: true });
    expect(plan.inline).toEqual(['page', 'system', 'export']);
    // The bar stays one quiet line: these never sit on it.
    expect(plan.more).toEqual(['scheme', 'reload', 'folder']);
  });

  it('moves the system chip into More when the canvas is narrower', () => {
    const plan = toolbarPlan(600);
    expect(plan.inline).toEqual(['page', 'export']);
    expect(plan.more).toEqual(['system', 'scheme', 'reload', 'folder']);
    expect(plan.systemName).toBe(false);
  });

  it('packs every secondary control into More when the canvas is cramped', () => {
    const plan = toolbarPlan(CANVAS_MIN);
    expect(plan).toMatchObject({ tight: true, inline: [] });
    expect([...plan.inline, ...plan.more].sort()).toEqual(['export', 'folder', 'page', 'reload', 'scheme', 'system']);
  });
});

describe('chip rows', () => {
  it('counts the items on the first rows and stops at the first item of the next one', () => {
    expect(itemsInRows([0, 0, 0, 30, 30, 60], 2)).toBe(5);
    expect(itemsInRows([0, 0, 0], 2)).toBe(3);
    expect(itemsInRows([0, 30, 60, 90], 1)).toBe(1);
  });

  it('keeps items of one line together when a button sits a few pixels off the chips', () => {
    expect(itemsInRows([10, 10.4, 12, 36.2], 2)).toBe(4);
    expect(itemsInRows([10, 12, 10, 36, 36, 50], 2)).toBe(5);
  });

  it('is empty-safe', () => {
    expect(itemsInRows([], 2)).toBe(0);
  });
});

describe('comment pins', () => {
  it('sit just up and left of the element corner, outside its box', () => {
    const origin = pinOrigin({ x: 300, y: 200 }, { x: 0, y: 0 }, 1, { width: 800, height: 600 });
    expect(origin).toEqual({ left: 300 - PIN_SIZE - 4, top: 200 - PIN_SIZE - 4 });
  });

  it('follow the scroll and the zoom', () => {
    const origin = pinOrigin({ x: 300, y: 200 }, { x: 100, y: 50 }, 0.5, { width: 800, height: 600 });
    expect(origin).toEqual({ left: (300 - 100) * 0.5 - PIN_SIZE - 4, top: (200 - 50) * 0.5 - PIN_SIZE - 4 });
  });

  it('clamp inside the frame when the corner is at its edge', () => {
    expect(pinOrigin({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, { width: 800, height: 600 })).toEqual({ left: 0, top: 0 });
    expect(pinOrigin({ x: 900, y: 700 }, { x: 0, y: 0 }, 1, { width: 800, height: 600 })).toEqual({ left: 800 - PIN_SIZE, top: 600 - PIN_SIZE });
  });
});

describe('the timeline shortcut', () => {
  it('opens the timeline with Ctrl/⌘+Alt+M', () => {
    expect(shortcutFor({ code: 'KeyM', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false })).toEqual({ kind: 'timeline' });
    expect(shortcutFor({ code: 'KeyM', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
  });
});
