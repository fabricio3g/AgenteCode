import { BrowserWindow, dialog, nativeImage } from 'electron';
import { APP_NAME } from '../shared/brand.ts';

let mainWindow: BrowserWindow | null = null;
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
