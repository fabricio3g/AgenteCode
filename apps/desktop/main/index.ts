import './bootstrap-data.ts';
import { app, BrowserWindow, Menu, Tray, nativeImage, shell, session, dialog, systemPreferences } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { registerIpcHandlers } from './ipc-handlers.ts';
import { stopAllInstances } from './instances.ts';
import { initTts } from './voice/audiocpp-tts.ts';
import { moduleDirname } from './module-env.ts';
import { APP_NAME } from '../shared/brand.ts';
import { setMainWindow, setPreloadPath, getMainWindow, requestMainWindowClose, setActiveWorkState } from './window-manager.ts';

// Resolves under both the esbuild CJS bundle and tsx's ESM loader.
const moduleDir = moduleDirname(import.meta.url);

const IS_DEV = !app.isPackaged;
const RENDERER_DEV_URL = 'http://localhost:5173';
/*
 * Node's fetch tries IPv4 and IPv6 side by side ("happy eyeballs") but gives
 * each attempt only 250 ms. On a slow link where IPv6 is unroutable and the
 * IPv4 handshake takes a second, every attempt fails and the request reports
 * ETIMEDOUT for a site that is reachable — weather, search, page reads and
 * providers all broke that way. Give each attempt time to finish.
 */
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

// Packaged, the main bundle runs from app.asar/dist-electron/main: the
// renderer and preload are found from the app's root, not from here.
const RENDERER_PROD_PATH = path.join(app.getAppPath(), 'renderer', 'dist', 'index.html');
const APP_ICON_PATH = IS_DEV
  ? path.join(moduleDir, '..', '..', 'renderer', 'public', 'app-icon.png')
  : path.join(app.getAppPath(), 'renderer', 'dist', 'app-icon.png');

let tray = null;

// Resolve preload path - different for dev (bundled) vs production (packaged)
const PRELOAD_PATH = IS_DEV
  ? path.join(moduleDir, '..', '..', 'preload', 'preload.cjs') // Dev: dist-electron/main/ -> project root
  : path.join(app.getAppPath(), 'preload', 'preload.cjs'); // Production: packaged app path

setPreloadPath(PRELOAD_PATH);

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    icon: fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true
    }
  });

  setMainWindow(mainWindow);

  if (IS_DEV) {
    mainWindow.loadURL(RENDERER_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(RENDERER_PROD_PATH);
  }

  mainWindow.on('closed', () => {
    setMainWindow(null);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) {
        void shell.openExternal(url).catch(() => {});
      }
    } catch { /* Ignore invalid external URLs. */ }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
}

function createTray() {
  const icon = fs.existsSync(APP_ICON_PATH)
    ? nativeImage.createFromPath(APP_ICON_PATH)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => getMainWindow()?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => getMainWindow()?.show());
}

app.whenReady().then(async () => {
  // Grant microphone and camera permissions for media devices (getUserMedia)
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').catch(() => {});
  }

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'camera') {
      return true;
    }
    return null;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone' || permission === 'camera');
  });

  session.defaultSession.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'camera' || details.deviceType === 'microphone') {
      return true;
    }
    return false;
  });

  registerIpcHandlers();
  createWindow();

  // Preload Kokoro TTS model in background while app finishes booting
  initTts().catch(() => {});

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
    const { disposeAllAgenteSessions, disposeCodeWorkspace } = await import('./ipc-handlers.js');
    disposeAllAgenteSessions();
    disposeCodeWorkspace();
  } catch { /* ignore cleanup errors */ }
  try {
    const { cleanupLlm } = await import('./llm-runner.js');
    cleanupLlm();
    stopAllInstances();
  } catch { /* ignore cleanup errors */ }
  try {
    const { closeDb } = await import('./chat-db.js');
    closeDb();
  } catch { /* ignore cleanup errors */ }
});
