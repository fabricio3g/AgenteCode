import electron from 'electron';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { isSafePublicUrl, assertSafePublicUrl } from './web-scraper.ts';

export interface LinkPreviewResult {
  url: string;
  host: string;
  title: string;
  description: string;
  imageDataUrl?: string;
  error?: string;
}

const PREVIEW_PARTITION = 'persist:link-preview';
const PREVIEW_WIDTH = 1024;
const PREVIEW_HEIGHT = 640;
const THUMB_WIDTH = 480;
const JPEG_QUALITY = 80;
const LOAD_TIMEOUT_MS = 3000;
const SETTLE_MS = 180;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 32;
const IDLE_DESTROY_MS = 60 * 1000;

let previewWindow: ElectronBrowserWindow | null = null;
let sessionHardened = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let captureSeq = 0;
let queue: Promise<void> = Promise.resolve();

const cache = new Map<string, { value: LinkPreviewResult; expiresAt: number }>();
const inFlight = new Map<string, Promise<LinkPreviewResult>>();

function hostLabel(url: URL): string {
  return url.hostname.replace(/^www\./i, '');
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Synchronous check for URLs eligible for miniature preview capture.
 * Allows public HTTP(S) hosts plus local loopback dev servers; rejects private
 * LAN ranges, cloud metadata endpoints, credentials-in-URL, and non-HTTP schemes.
 */
export function isPreviewableUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (isLoopbackHost(parsed.hostname)) return true;
    return isSafePublicUrl(parsed.toString());
  } catch {
    return false;
  }
}

function hardenPreviewSession(): void {
  if (sessionHardened) return;
  sessionHardened = true;
  const { session } = electron;
  const ses = session.fromPartition(PREVIEW_PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const anySes = ses as unknown as Record<string, unknown>;
  if (typeof anySes['setDevicePermissionHandler'] === 'function') {
    (anySes['setDevicePermissionHandler'] as (h: () => boolean) => void)(() => false);
  }
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const u = new URL(details.url);
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'data:' || u.protocol === 'blob:') {
        callback({ cancel: false });
        return;
      }
    } catch {
      // cancel invalid URLs
    }
    callback({ cancel: true });
  });
}

function scheduleIdleDestroy(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.destroy();
    }
    previewWindow = null;
  }, IDLE_DESTROY_MS);
}

function getPreviewWindow(): ElectronBrowserWindow {
  hardenPreviewSession();
  if (previewWindow && !previewWindow.isDestroyed()) {
    scheduleIdleDestroy();
    return previewWindow;
  }
  const { BrowserWindow } = electron;
  const win = new BrowserWindow({
    show: false,
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    useContentSize: true,
    backgroundColor: '#1c1c1c',
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      partition: PREVIEW_PARTITION,
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isPreviewableUrl(targetUrl)) event.preventDefault();
  });
  win.on('closed', () => {
    if (previewWindow === win) previewWindow = null;
  });
  previewWindow = win;
  scheduleIdleDestroy();
  return win;
}

function waitForRender(win: ElectronBrowserWindow, seq: number): Promise<void> {
  return new Promise((resolve) => {
    const wc = win.webContents;
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      wc.removeListener('did-finish-load', onFinish);
      wc.removeListener('dom-ready', onDomReady);
      wc.removeListener('did-fail-load', onFail);
      clearTimeout(hardTimer);
      if (settleTimer) clearTimeout(settleTimer);
    };
    const finishSoon = (delayMs: number) => {
      if (settled) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, delayMs);
    };
    const onFinish = () => finishSoon(SETTLE_MS);
    const onDomReady = () => finishSoon(450);
    const onFail = (_e: unknown, code: number) => {
      if (code === -3) {
        settled = true;
        cleanup();
        resolve();
        return;
      }
      finishSoon(80);
    };
    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, LOAD_TIMEOUT_MS);

    if (captureSeq !== seq) {
      settled = true;
      cleanup();
      resolve();
      return;
    }

    wc.on('did-finish-load', onFinish);
    wc.on('dom-ready', onDomReady);
    wc.on('did-fail-load', onFail);
  });
}

async function capturePageMetadata(win: ElectronBrowserWindow, targetUrl: URL): Promise<LinkPreviewResult> {
  const wc = win.webContents;
  const host = hostLabel(targetUrl);
  let title = '';
  let description = '';
  try {
    title = (wc.getTitle() || '').trim();
    const meta = await wc.executeJavaScript(
      `(() => {
        const desc = document.querySelector('meta[property="og:description"], meta[name="description"], meta[name="twitter:description"]')?.getAttribute('content') || '';
        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        return { desc: desc.trim(), ogTitle: ogTitle.trim() };
      })()`,
      true
    ) as { desc?: string; ogTitle?: string } | null;
    if (meta?.ogTitle && (!title || title === targetUrl.href)) title = meta.ogTitle;
    if (meta?.desc) description = meta.desc;
  } catch {
    // ignore DOM metadata errors
  }

  let imageDataUrl: string | undefined;
  try {
    const img = await wc.capturePage();
    if (!img.isEmpty()) {
      const resized = img.resize({ width: THUMB_WIDTH });
      const jpeg = resized.toJPEG(JPEG_QUALITY);
      if (jpeg.length > 0) {
        imageDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
      }
    }
  } catch {
    // fallback to metadata-only card if capture fails
  }

  return {
    url: targetUrl.toString(),
    host,
    title: title || host,
    description: description.slice(0, 240),
    ...(imageDataUrl ? { imageDataUrl } : {})
  };
}

function setCacheEntry(url: string, value: LinkPreviewResult): void {
  if (cache.has(url)) cache.delete(url);
  cache.set(url, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
    else break;
  }
}

async function performCapture(targetUrl: URL, seq: number): Promise<LinkPreviewResult> {
  const host = hostLabel(targetUrl);
  if (captureSeq !== seq) {
    return { url: targetUrl.toString(), host, title: host, description: '' };
  }
  const win = getPreviewWindow();
  const ready = waitForRender(win, seq);
  void win.loadURL(targetUrl.toString()).catch(() => {
    // Navigation errors and aborts settle cleanly in waitForRender.
  });
  await ready;
  if (captureSeq !== seq || win.isDestroyed()) {
    return { url: targetUrl.toString(), host, title: host, description: '' };
  }
  const result = await capturePageMetadata(win, targetUrl);
  scheduleIdleDestroy();
  if (result.imageDataUrl) {
    setCacheEntry(targetUrl.toString(), result);
  }
  return result;
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreviewResult> {
  if (!isPreviewableUrl(rawUrl)) {
    return { url: String(rawUrl || ''), host: '', title: '', description: '', error: 'Invalid or blocked URL' };
  }
  const parsed = new URL(rawUrl.trim());
  const normalized = parsed.toString();
  const host = hostLabel(parsed);

  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(normalized);
    cache.set(normalized, cached);
    return cached.value;
  }
  if (cached) cache.delete(normalized);

  const existing = inFlight.get(normalized);
  if (existing) return existing;

  const task = (async () => {
    if (!isLoopbackHost(parsed.hostname)) {
      const safe = await assertSafePublicUrl(normalized);
      if (!safe) {
        return { url: normalized, host, title: host, description: '', error: 'Blocked private host' };
      }
    }
    const seq = ++captureSeq;
    if (previewWindow && !previewWindow.isDestroyed()) {
      try {
        previewWindow.webContents.stop();
      } catch {
        // ignore stop errors
      }
    }
    const next = queue.then(() => performCapture(parsed, seq));
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  })().finally(() => {
    inFlight.delete(normalized);
  });

  inFlight.set(normalized, task);
  return task;
}

export function disposeLinkPreview(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.destroy();
  }
  previewWindow = null;
  cache.clear();
  inFlight.clear();
}
