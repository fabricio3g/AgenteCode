import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { APP_NAME } from '../shared/brand.ts';
import { WINDOW_THEME_COLORS } from '../shared/window-theme.ts';
import { WindowThemePreferences } from './window-theme-preferences.ts';

let mainWindow: BrowserWindow | null = null;
let trayAvailable = false;
let quitting = false;
export function setTrayAvailable(value: boolean) { trayAvailable = value; }
export function setQuitting(value: boolean) { quitting = value; }
function hidesToTray() { return trayAvailable && !quitting && (process.platform === 'win32' || process.platform === 'linux'); }
export function attachCloseToTray(win: BrowserWindow) {
  win.on('close', event => { if (win === getMainWindow() && hidesToTray()) { event.preventDefault(); win.hide(); } });
}
let themePreferences: WindowThemePreferences | undefined;
const paintedColors = new WeakMap<BrowserWindow, string>();

export function initialWindowColors() {
  themePreferences ??= new WindowThemePreferences(path.join(app.getPath('userData'), 'window-theme.json'));
  return WINDOW_THEME_COLORS[themePreferences.theme];
}

export async function flushWindowTheme(): Promise<void> { await themePreferences?.flush(); }

// `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`. The window background is painted
// from a CSS colour, so alpha has to be accepted here.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Paint the window behind the page and remember the theme it belongs to.
 *
 * The caption itself is drawn in the page (`WindowControls.svelte`), so there
 * is no `titleBarOverlay` to recolour: this only keeps the frame's own colour
 * matching the theme, so a resize or a rounded corner never flashes the
 * platform's default grey.
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

export function setMainWindow(win: BrowserWindow | null) {
  mainWindow = win;
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
  if (win === getMainWindow() && hidesToTray()) { win.hide(); return { closed: false, prompted: false, hidden: true }; }
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
