import { BrowserWindow, dialog, nativeImage } from 'electron';
import { APP_NAME } from '../shared/brand.ts';
import { TITLEBAR_HEIGHT, TITLEBAR_OVERLAY_COLOR, TITLEBAR_SYMBOL_COLOR } from '../shared/titlebar.ts';

let mainWindow: BrowserWindow | null = null;

export { TITLEBAR_HEIGHT };

/**
 * Caption overlay: theme-matched background and glyphs. The native controls
 * live outside the web contents, so the renderer pushes the live CSS colours
 * through `window:set-titlebar-overlay` on every theme change. Dark is the
 * first-frame default.
 */
export const TITLEBAR_OVERLAY = {
  color: TITLEBAR_OVERLAY_COLOR,
  symbolColor: TITLEBAR_SYMBOL_COLOR
} as const;

/** `titleBarOverlay` is ignored on macOS, where `hiddenInset` keeps the lights. */
export const usesCaptionOverlay = process.platform !== 'darwin';

// `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`. The overlay background is
// transparent, so alpha has to be accepted here.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Hand the caption buttons the current theme's colours. Returns false on
 * macOS (no overlay to paint) and on input the OS would reject.
 */
export function applyTitlebarOverlay(win: BrowserWindow | null, overlay: unknown): boolean {
  if (!win || win.isDestroyed() || !usesCaptionOverlay) return false;
  const next = overlay as { color?: unknown; symbolColor?: unknown } | null;
  const color = typeof next?.color === 'string' ? next.color : '';
  const symbolColor = typeof next?.symbolColor === 'string' ? next.symbolColor : '';
  if (!HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor)) return false;
  win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
  return true;
}
type ActiveWorkState = { active: boolean; reasons: string[] };
type ActiveWorkStateInput = { active?: unknown; reasons?: unknown };

let activeWorkState: ActiveWorkState = { active: false, reasons: [] };
let preloadPath = '';

export function setMainWindow(win: BrowserWindow | null) {
  mainWindow = win;
}

export function setPreloadPath(p: string) {
  preloadPath = p;
}

function getPreloadPath() {
  return preloadPath;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setActiveWorkState(state: ActiveWorkStateInput = {}) {
  const active = Boolean(state.active);
  const reasons = Array.isArray(state.reasons)
    ? state.reasons.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  activeWorkState = { active, reasons };
  return activeWorkState;
}

export async function requestMainWindowClose() {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return { closed: false, prompted: false };
  if (!activeWorkState.active) {
    win.close();
    return { closed: true, prompted: false };
  }

  const reasonText = activeWorkState.reasons.length
    ? `Active tasks: ${activeWorkState.reasons.join(', ')}`
    : 'An operation is still running.';
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: `Quit ${APP_NAME}?`,
    message: 'Work is still in progress.',
    detail: `${reasonText}\n\nIf you quit now, in-progress work may be interrupted.`
  });

  if (result.response === 1) {
    win.close();
    return { closed: true, prompted: true };
  }

  return { closed: false, prompted: true };
}

// Retired: separate webviewer window leaked full preload bridge into
// guest pages. Browsing now lives in the isolated panel (browser-panel.ts)
// with no preload, own partition and per-session hardening.
