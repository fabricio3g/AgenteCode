import { BrowserWindow, dialog, nativeImage } from 'electron';

let mainWindow: BrowserWindow | null = null;
let webviewerWindow: BrowserWindow | null = null;
let activeWorkState = { active: false, reasons: [] as string[] };
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

export function setActiveWorkState(state: Record<string, any> = {}) {
  const active = !!state.active;
  const reasons = Array.isArray(state.reasons)
    ? state.reasons.map((value: any) => String(value || '').trim()).filter(Boolean)
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
    title: 'Quit Chatea LM?',
    message: 'Work is still in progress.',
    detail: `${reasonText}\n\nIf you quit now, in-progress work may be interrupted.`
  });

  if (result.response === 1) {
    win.close();
    return { closed: true, prompted: true };
  }

  return { closed: false, prompted: true };
}

export function createWebviewerWindow(url: string, title = 'Web Viewer') {
  if (webviewerWindow && !webviewerWindow.isDestroyed()) {
    webviewerWindow.focus();
    webviewerWindow.loadURL(url);
    return;
  }

  webviewerWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    title,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });

  webviewerWindow.loadURL(url);
  webviewerWindow.setMenuBarVisibility(false);

  webviewerWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    require('electron').shell.openExternal(openUrl);
    return { action: 'deny' };
  });

  webviewerWindow.on('closed', () => {
    webviewerWindow = null;
  });
}
