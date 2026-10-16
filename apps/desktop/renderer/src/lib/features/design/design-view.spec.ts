import { describe, expect, it } from 'vitest';
import { CANVAS_MIN, clampZoom, DOCK_WIDTH, frameGeometry, INSPECTOR_WIDTH, itemsInRows, nextZoomPreset, pageLabel, paneLayout, PIN_SIZE, pinOrigin, resolveSelected, SHEET_PEEK, shortcutFor, toolbarPlan, zoomLabel } from './design-view';

describe('explicit zoom', () => {
  it('sets the scale outright, above 1 included, and keeps the viewport width', () => {
    expect(frameGeometry('desktop', { width: 1048, height: 700 }, 0.5)).toEqual({ width: 1440, height: (700 - 48) / 0.5, scale: 0.5 });
    expect(frameGeometry('mobile', { width: 1048, height: 700 }, 2)).toMatchObject({ width: 390, scale: 2 });
  });

  it('fit viewport keeps the pane width visible at any zoom', () => {
    const geometry = frameGeometry('fit', { width: 900, height: 600 }, 2);
    expect(geometry.width * geometry.scale).toBeCloseTo(852, 5);
  });

  it('clamps to the preset range and ignores non-finite input', () => {
    expect(clampZoom(9)).toBe(2);
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(frameGeometry('desktop', { width: 1048, height: 700 }, 10).scale).toBe(2);
  });
});

describe('zoom presets', () => {
  it('steps to the next preset in each direction and stops at the ends', () => {
    expect(nextZoomPreset(1, 1)).toBe(1.5);
    expect(nextZoomPreset(1, -1)).toBe(0.75);
    expect(nextZoomPreset(0.7, 1)).toBe(0.75);
    expect(nextZoomPreset(0.7, -1)).toBe(0.5);
    expect(nextZoomPreset(2, 1)).toBe(2);
    expect(nextZoomPreset(0.25, -1)).toBe(0.25);
  });

  it('labels a scale as a whole percentage', () => {
    expect(zoomLabel(0.75)).toBe('75%');
    expect(zoomLabel(1.5)).toBe('150%');
  });
});

describe('frameGeometry', () => {
  it('scales a wide viewport down to the pane and never up', () => {
    const desktop = frameGeometry('desktop', { width: 1048, height: 700 });
    expect(desktop.width).toBe(1440);
    expect(desktop.scale).toBeCloseTo(1000 / 1440, 5);
    expect(frameGeometry('mobile', { width: 1048, height: 700 })).toMatchObject({ width: 390, scale: 1, height: 652 });
  });

  it('fit uses the pane itself', () => {
    expect(frameGeometry('fit', { width: 900, height: 600 })).toEqual({ width: 852, height: 552, scale: 1 });
  });

  it('survives a pane that has not been measured', () => {
    const geometry = frameGeometry('desktop', { width: 0, height: 0 });
    expect(geometry.scale).toBeGreaterThan(0);
    expect(Number.isFinite(geometry.height)).toBe(true);
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
    expect(shortcutFor(key('Digit1'))).toEqual({ kind: 'viewport', viewport: 'mobile' });
    expect(shortcutFor(key('Digit4', { ctrlKey: false, metaKey: true }))).toEqual({ kind: 'viewport', viewport: 'fit' });
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
