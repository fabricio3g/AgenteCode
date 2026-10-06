import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { APP_NAME } from '../shared/brand.ts';
import { TITLEBAR_HEIGHT, TITLEBAR_OVERLAY_COLOR, TITLEBAR_SYMBOL_COLOR } from '../shared/titlebar.ts';
import { WINDOW_THEME_COLORS } from '../shared/window-theme.ts';
import { WindowThemePreferences } from './window-theme-preferences.ts';

let mainWindow: BrowserWindow | null = null;
let themePreferences: WindowThemePreferences | undefined;
const paintedColors = new WeakMap<BrowserWindow, string>();

export function initialWindowColors() {
  themePreferences ??= new WindowThemePreferences(path.join(app.getPath('userData'), 'window-theme.json'));
  return WINDOW_THEME_COLORS[themePreferences.theme];
}

export async function flushWindowTheme(): Promise<void> { await themePreferences?.flush(); }

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

/**
 * Windows draws its caption buttons through `titleBarOverlay` (snap layouts,
 * system menu). macOS keeps its traffic lights. Linux gets neither: its
 * overlay does not repaint reliably when the colour changes, so the buttons
 * kept the old theme and never dimmed under a dialog. The renderer draws them
 * there instead (`WindowControls.svelte`), inside the page like everything else.
 */
export const usesCaptionOverlay = process.platform === 'win32';

// `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`. The overlay background is
// transparent, so alpha has to be accepted here.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Update the backing window and native caption together, including on reload.
 */
export function applyTitlebarOverlay(win: BrowserWindow | null, overlay: unknown): boolean {
  if (!win || win.isDestroyed()) return false;
  const next = overlay as { color?: unknown; symbolColor?: unknown } | null;
  const color = typeof next?.color === 'string' ? next.color : '';
  const symbolColor = typeof next?.symbolColor === 'string' ? next.symbolColor : '';
  if (!HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor)) return false;
  const key = `${color}:${symbolColor}`;
  if (paintedColors.get(win) !== key) {
    win.setBackgroundColor(color);
    if (usesCaptionOverlay) win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
    paintedColors.set(win, key);
  }
  const theme = color === WINDOW_THEME_COLORS.dark.color ? 'dark' : color === WINDOW_THEME_COLORS.light.color ? 'light' : null;
  if (theme) {
    initialWindowColors();
    themePreferences!.update(theme);
  }
  return true;
}
type ActiveWorkState = { active: boolean; reasons: string[] };
type ActiveWorkStateInput = { active?: unknown; reasons?: unknown };

const activeWorkByWindow = new Map<number, ActiveWorkState>();
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

export function setActiveWorkState(state: ActiveWorkStateInput = {}, win = getMainWindow()) {
  const active = Boolean(state.active);
  const reasons = Array.isArray(state.reasons)
    ? state.reasons.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  activeWorkState = { active, reasons };
  if (win) activeWorkByWindow.set(win.id, activeWorkState);
  return activeWorkState;
}

export async function requestMainWindowClose(win = getMainWindow()) {
  if (!win || win.isDestroyed()) return { closed: false, prompted: false };
  const work = activeWorkByWindow.get(win.id) ?? activeWorkState;
  if (!work.active) {
    win.close();
    return { closed: true, prompted: false };
  }

  const reasonText = work.reasons.length
    ? `Active tasks: ${work.reasons.join(', ')}`
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

let conversationWindowFactory: ((chatId: string) => BrowserWindow) | undefined;
export function setConversationWindowFactory(factory: (chatId: string) => BrowserWindow) { conversationWindowFactory = factory; }
export function openConversationWindow(chatId: unknown) {
  if (typeof chatId !== 'string' || !chatId.trim() || chatId.length > 512) throw new Error('Conversation is required');
  if (!conversationWindowFactory) throw new Error('Window factory is unavailable');
  return { windowId: conversationWindowFactory(chatId).id };
}

// Retired: separate webviewer window leaked full preload bridge into
// guest pages. Browsing now lives in the isolated panel (browser-panel.ts)
// with no preload, own partition and per-session hardening.
