import { attachStartupDiagnostics, failStartup, smokeMode } from './startup.ts';
import './bootstrap-data.ts';
import { app, BrowserWindow, Menu, Tray, nativeImage, shell, session, dialog, systemPreferences } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chatDatabase } from './chat-db-client.ts';
import { registerIpcHandlers, disposeAllAgenteSessions, disposeCodeWorkspace } from './ipc-handlers.ts';
import { stopAllInstances } from './instances.ts';
import { moduleDirname } from './module-env.ts';
import { APP_NAME } from '../shared/brand.ts';
import { setMainWindow, setPreloadPath, getMainWindow, requestMainWindowClose, setActiveWorkState, TITLEBAR_HEIGHT, TITLEBAR_OVERLAY, usesCaptionOverlay } from './window-manager.ts';
import { zoomKeyDirection } from '../shared/zoom-keys.ts';

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

// Chromium's HTTP cache is unbounded by default and grew past a gigabyte —
// in development almost all of it Vite modules served from localhost. The
// packaged renderer loads from disk, so a small cache loses nothing.
app.commandLine.appendSwitch('disk-cache-size', String((IS_DEV ? 32 : 128) * 1024 * 1024));

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

// app.exit(), used by smoke mode, skips before-quit. Stop its isolated daemon.
if (smokeMode) app.once('quit', () => {
  disposeAllAgenteSessions();
  disposeCodeWorkspace();
});

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    icon: fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
    // `titleBarStyle` replaces the old `frame: false`, which on macOS *is*
    // 'hidden' and would silently undo the 'hiddenInset' inset below.
    // Windows/Linux keep their caption controls when we add the overlay;
    // macOS keeps its real traffic lights.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // Let the OS draw the caption buttons instead of us faking them: correct
    // hover states, correct hit areas at every DPI, the Win11 snap-layout
    // flyout, and the system menu. macOS ignores this option entirely.
    ...(usesCaptionOverlay
      ? { titleBarOverlay: { ...TITLEBAR_OVERLAY, height: TITLEBAR_HEIGHT } }
      : {}),
    // Win11 draws the rounded corners and shadow itself once the frame is ours.
    roundedCorners: true,
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

  attachStartupDiagnostics(mainWindow);

  if (IS_DEV) {
    void mainWindow.loadURL(RENDERER_DEV_URL).catch(failStartup);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const missing = smokeMode && process.env.AGENTE_SMOKE_CASE === 'missing-assets';
    void mainWindow.loadFile(missing ? `${RENDERER_PROD_PATH}.missing` : RENDERER_PROD_PATH, { query: smokeMode ? { smoke: '1', fault: process.env.AGENTE_SMOKE_CASE || '' } : {} }).catch(failStartup);
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

  // Ctrl/Cmd +, - and 0 change the interface size setting (Settings →
  // Accessibility) instead of an unsaved zoom from the default menu.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const direction = input.type === 'keyDown' ? zoomKeyDirection(input.key, input.control || input.meta, input.alt) : null;
    if (direction === null) return;
    event.preventDefault();
    mainWindow.webContents.send('ui-zoom', direction);
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
  // TTS starts its audio.cpp server on the first speak (generateTtsStream),
  // not at launch: most sessions never speak, and the server costs cores and RAM.

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(failStartup);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let cleanupComplete = false;
let cleanupStarted = false;
app.on('before-quit', async event => {
  if (cleanupComplete) return;
  event.preventDefault();
  if (cleanupStarted) return;
  cleanupStarted = true;
  try { await chatDatabase.close(); } catch (error) { console.warn('[database] shutdown:', error); }
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
  cleanupComplete = true;
  app.quit();
});
