import { app, BrowserWindow, Menu, Tray, nativeImage, shell, session, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { registerIpcHandlers } from './ipc-handlers.ts';

// Handle both ESM (tsx dev) and CJS (esbuild bundled) environments
// esbuild CJS bundle provides __dirname global, ESM uses import.meta.url

// Get __dirname - works in both CJS bundle and ESM with tsx
const __dirname: string = (() => {
  // In CJS bundled by esbuild, __dirname is a global
  // We use eval to safely access it without TypeScript complaining
  try {
    const cjsDirname = eval('typeof __dirname === "string" ? __dirname : null');
    if (cjsDirname) return cjsDirname;
  } catch {}
  
  // In ESM with tsx, derive from import.meta.url
  try {
    const metaUrl = (import.meta as any)?.url;
    if (typeof metaUrl === 'string' && metaUrl) {
      const { fileURLToPath } = require('node:url');
      return path.dirname(fileURLToPath(metaUrl));
    }
  } catch {}
  
  // Fallback
  return process.cwd();
})();

const IS_DEV = !app.isPackaged;
const RENDERER_DEV_URL = 'http://localhost:5173';
const RENDERER_PROD_PATH = path.join(__dirname, '..', 'renderer', 'dist', 'index.html');
const APP_NAME = 'Chatea LM';

let mainWindow = null;
let tray = null;
let webviewerWindow = null;
let activeWorkState = { active: false, reasons: [] };

// Resolve preload path - different for dev (bundled) vs production (packaged)
const PRELOAD_PATH = IS_DEV
  ? path.join(__dirname, '..', '..', 'preload', 'preload.cjs') // Dev: dist-electron/main/ -> project root
  : path.join(app.getAppPath(), 'preload', 'preload.cjs'); // Production: packaged app path

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });

  if (IS_DEV) {
    mainWindow.loadURL(RENDERER_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(RENDERER_PROD_PATH);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow?.show());
}

export function createWebviewerWindow(url, title = 'Web Viewer') {
  if (webviewerWindow && !webviewerWindow.isDestroyed()) {
    webviewerWindow.focus();
    webviewerWindow.loadURL(url);
    return;
  }

  webviewerWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    title: title,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });

  webviewerWindow.loadURL(url);
  webviewerWindow.setMenuBarVisibility(false);

  webviewerWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    shell.openExternal(openUrl);
    return { action: 'deny' };
  });

  webviewerWindow.on('closed', () => {
    webviewerWindow = null;
  });
}

export function getMainWindow() {
  return mainWindow;
}

export function setActiveWorkState(state = {}) {
  const active = !!state.active;
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

export { getAppPaths } from './paths.ts';

// Disable Chromium sandbox if SUID helper is not configured (dev environments)
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  // Remove CSP headers that could block LLM-generated preview content in iframes
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    callback({ responseHeaders: headers });
  });

  // Grant microphone and camera permissions for media devices (getUserMedia)
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'camera') {
      return true;
    }
    return null;
  });

  session.defaultSession.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'camera' || details.deviceType === 'microphone') {
      return true;
    }
    return false;
  });

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  try {
    const { cleanupLlm } = await import('./llm-runner.js');
    cleanupLlm();
  } catch { /* ignore cleanup errors */ }
  try {
    const { closeDb } = await import('./chat-db.js');
    closeDb();
  } catch { /* ignore cleanup errors */ }
});
