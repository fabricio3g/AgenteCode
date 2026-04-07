import { app, BrowserWindow, Menu, Tray, nativeImage, shell, session, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpcHandlers } from './ipc-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_DEV = !app.isPackaged;
const RENDERER_DEV_URL = 'http://localhost:5173';
const RENDERER_PROD_PATH = path.join(__dirname, '..', 'renderer', 'dist', 'index.html');

let mainWindow = null;
let tray = null;
let webviewerWindow = null;
let activeWorkState = { active: false, reasons: [] };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'TalamoLM',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
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
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('TalamoLM');

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
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
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
    title: 'Quit TalamoLM?',
    message: 'Work is still in progress.',
    detail: `${reasonText}\n\nIf you quit now, in-progress work may be interrupted.`
  });

  if (result.response === 1) {
    win.close();
    return { closed: true, prompted: true };
  }

  return { closed: false, prompted: true };
}

export function getAppPaths() {
  const envOverride = String(process.env.TALAMOLM_HOME || '').trim();
  const legacyAppData = path.join(app.getPath('home'), '.talamolm');
  const platformAppData = path.join(app.getPath('appData'), 'TalamoLM');
  const appData = envOverride || (fs.existsSync(legacyAppData) ? legacyAppData : platformAppData);
  const projectRoot = IS_DEV
    ? path.resolve(__dirname, '..', '..')
    : path.dirname(app.getPath('exe'));

  return {
    appData,
    modelsRoot: IS_DEV
      ? path.join(projectRoot, 'models')
      : path.join(process.resourcesPath, 'models'),
    assetsRoot: IS_DEV
      ? path.join(projectRoot, 'assets')
      : path.join(process.resourcesPath, 'assets'),
    localModelsRoot: path.join(appData, 'models', 'llama-cpp'),
    localBinRoot: path.join(appData, 'bin'),
    localBinVersionsRoot: path.join(appData, 'bin', 'versions'),
    cacheRoot: path.join(appData, 'cache'),
    configPath: path.join(appData, 'config.json'),
    secretsPath: path.join(appData, 'secrets.json'),
    projectRoot,
    IS_DEV
  };
}

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
