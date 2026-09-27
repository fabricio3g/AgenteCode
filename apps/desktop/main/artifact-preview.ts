import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
import { protectedArtifactHtml } from '../shared/artifact-preview-policy.ts';
import { getMainWindow } from './window-manager.ts';

/** A fresh, memory-only guest for each document; no preload or app session. */
export function createArtifactWindow(interactive = false): BrowserWindow {
  const guest = session.fromPartition(`artifact-${randomUUID()}`, { cache: false });
  guest.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  guest.setPermissionCheckHandler(() => false);
  guest.setDevicePermissionHandler(() => false);
  guest.enableNetworkEmulation({ offline: true });
  guest.webRequest.onBeforeRequest((details, callback) => {
    // data: resources are local to the supplied document. Everything else,
    // including file:, localhost, WebSockets and custom protocols, is denied.
    callback({ cancel: !details.url.startsWith('data:') });
  });
  guest.on('will-download', (event) => event.preventDefault());
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    title: 'Artifact preview · Offline',
    parent: getMainWindow() || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      session: guest, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
      javascript: interactive, spellcheck: false, devTools: false,
      navigateOnDragDrop: false
    }
  });
  win.setMenu(null);
  win.webContents.setAudioMuted(true);
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('page-title-updated', (event) => event.preventDefault());
  win.on('unresponsive', () => { if (!win.isDestroyed()) win.destroy(); });
  win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.destroy(); });
  win.once('closed', () => { void guest.clearStorageData().catch(() => {}); });
  return win;
}

export async function loadArtifactHtml(win: BrowserWindow, html: string, interactive = false) {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(protectedArtifactHtml(html, interactive))}`);
}

export async function withArtifactTimeout<T>(operation: Promise<T>, milliseconds = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Document rendering timed out. Please try again.')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
