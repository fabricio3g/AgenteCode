import { app, BrowserWindow, Menu, Tray, nativeImage, shell, session, dialog, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { registerIpcHandlers } from './ipc-handlers.ts';
import { initTts } from './tts-engine.ts';
import { setMainWindow, setPreloadPath, getMainWindow, createWebviewerWindow, requestMainWindowClose, setActiveWorkState } from './window-manager.ts';

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
const APP_ICON_PATH = IS_DEV
  ? path.join(__dirname, '..', '..', 'renderer', 'public', 'app-icon.png')
  : path.join(__dirname, '..', 'renderer', 'dist', 'app-icon.png');
const APP_NAME = 'Chatea';

let tray = null;

// Resolve preload path - different for dev (bundled) vs production (packaged)
const PRELOAD_PATH = IS_DEV
  ? path.join(__dirname, '..', '..', 'preload', 'preload.cjs') // Dev: dist-electron/main/ -> project root
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
      nodeIntegrationInWorker: true,
      sandbox: false,
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
    shell.openExternal(url);
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
    const { cleanupLlm } = await import('./llm-runner.js');
    cleanupLlm();
  } catch { /* ignore cleanup errors */ }
  try {
    const { closeDb } = await import('./chat-db.js');
    closeDb();
  } catch { /* ignore cleanup errors */ }
});
