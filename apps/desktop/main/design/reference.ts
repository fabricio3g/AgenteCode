/**
 * `design_reference`: read a public page the way a designer skims one. The page
 * opens in a private offscreen window (no preload, no Node, a memory-only
 * session, every request limited to public http(s)), settles, and is measured by
 * `reference-page.ts`. Only the reading goes back to the model: tokens, a JPEG
 * of the viewport when the model can see, a saved screenshot and optionally a
 * design system built from the tokens. The page itself never comes back.
 */
import { randomUUID } from 'node:crypto';
import { BrowserWindow, session, type NativeImage } from 'electron';
import type { DesignReferenceRequest, DesignReferenceResult } from '../../shared/design.ts';
import { isSafePublicUrl } from '../web-scraper.ts';
import { REFERENCE_PAGE_SCRIPT, REFERENCE_SETTLE_SCRIPT } from './reference-page.ts';
import { buildReferenceTokens, clampReferenceWidth, designMd, referenceBrief, referenceStem, tokensCss, type ReferenceCapture } from './reference-tokens.ts';
import { saveReferenceScreenshot } from './references.ts';
import { createSystemFromFiles } from './systems.ts';

const LOAD_MS = 15_000;
const READ_MS = 30_000;
/** The screenshot's height: one screen, as a visitor first sees the page. */
const VIEWPORT_HEIGHT = 900;
/** A JPEG wider than this is only more upload, not more legibility. */
const MODEL_IMAGE_WIDTH = 1280;

export interface ReferenceHost {
  /** The chat's workspace (already created). */
  root: string;
  /** `<app data>/design-systems`. */
  systemsRoot: string;
}

/** Only public web addresses may load, so the page cannot reach the user's machine or network. */
function allowedReferenceRequest(url: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  return isSafePublicUrl(url);
}

function createReferenceWindow(width: number): BrowserWindow {
  const guest = session.fromPartition(`reference-${randomUUID()}`, { cache: false });
  guest.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  guest.setPermissionCheckHandler(() => false);
  guest.setDevicePermissionHandler(() => false);
  // Every request is checked, redirects and subresources included: a public page cannot pull in a private address.
  guest.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedReferenceRequest(details.url) }));
  guest.on('will-download', (event) => event.preventDefault());
  const win = new BrowserWindow({
    show: false,
    width,
    height: VIEWPORT_HEIGHT,
    useContentSize: true,
    title: 'Design reference · Private',
    webPreferences: {
      session: guest,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      javascript: true,
      spellcheck: false,
      devTools: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false
    }
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The page is read where it loaded: links and scripts cannot take the window somewhere else.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.on('unresponsive', () => { if (!win.isDestroyed()) win.destroy(); });
  win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.destroy(); });
  win.once('closed', () => { void guest.clearStorageData().catch(() => {}); });
  return win;
}

function withTimeout<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

interface Capture { reading: ReferenceCapture; image: NativeImage | null }

/** Load, settle and measure one page in `win`. The caller owns the window. */
async function readPageIn(win: BrowserWindow, url: string, wantImage: boolean): Promise<Capture> {
  await withTimeout(win.loadURL(url), LOAD_MS, 'The page did not finish loading within 15 seconds.');
  await win.webContents.executeJavaScript(REFERENCE_SETTLE_SCRIPT, false);
  const reading = await win.webContents.executeJavaScript(REFERENCE_PAGE_SCRIPT, false) as ReferenceCapture;
  const image = wantImage ? await win.webContents.capturePage() : null;
  return { reading, image: image && !image.isEmpty() ? image : null };
}

/** The screenshot a vision model gets: JPEG, at most {@link MODEL_IMAGE_WIDTH} wide. */
function toModelImage(image: NativeImage): { data: string; mimeType: string } {
  const { width } = image.getSize();
  const scaled = width > MODEL_IMAGE_WIDTH ? image.resize({ width: MODEL_IMAGE_WIDTH, quality: 'good' }) : image;
  return { data: scaled.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' };
}

const failure = (error: string): DesignReferenceResult => ({ ok: false, error, text: '' });
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Read a page and return what the model needs. Every failure comes back as a result, never a throw. */
export async function runDesignReference(request: DesignReferenceRequest, host: ReferenceHost): Promise<DesignReferenceResult> {
  const url = typeof request?.url === 'string' ? request.url.trim() : '';
  if (!isSafePublicUrl(url)) return failure('Only public http(s) pages can be read: no localhost, private network addresses or credentials in the URL.');
  const width = clampReferenceWidth(request.width);
  const wantImage = request.image === true;
  const saveShot = request.saveScreenshot === true;
  const systemName = typeof request.saveAsSystem === 'string' ? request.saveAsSystem.trim() : '';
  // One window per read. The whole read has a deadline: when it passes, the window is destroyed, which ends any pending load.
  let win: BrowserWindow | undefined;
  let timedOut = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let capture: Capture;
  try {
    const page = createReferenceWindow(width);
    win = page;
    deadline = setTimeout(() => {
      timedOut = true;
      if (!page.isDestroyed()) page.destroy();
    }, READ_MS);
    capture = await readPageIn(page, url, wantImage || saveShot);
  } catch (error) {
    return failure(timedOut ? 'Reading the page took longer than 30 seconds.' : `Could not read the page: ${messageOf(error)}`);
  } finally {
    clearTimeout(deadline);
    if (win && !win.isDestroyed()) win.destroy();
  }
  try {
    const tokens = buildReferenceTokens(capture.reading);
    const saved = saveShot && capture.image ? saveReferenceScreenshot(host.root, referenceStem(url), capture.image.toPNG()) : undefined;
    const system = systemName
      ? createSystemFromFiles(host.systemsRoot, {
        name: systemName,
        description: `Read from ${url} by design_reference.`,
        files: { 'tokens.css': tokensCss(tokens), 'DESIGN.md': designMd(tokens) }
      })
      : undefined;
    const modelImage = wantImage && capture.image ? toModelImage(capture.image) : undefined;
    const text = referenceBrief(tokens, {
      image: modelImage ? `attached (${width}px wide viewport)` : undefined,
      saved,
      system: system?.name
    });
    return { ok: true, text, ...(modelImage ? { image: modelImage } : {}), ...(saved ? { saved } : {}), ...(system ? { system: { id: system.id, name: system.name } } : {}) };
  } catch (error) {
    return failure(messageOf(error));
  }
}
