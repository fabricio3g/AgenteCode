/** Loaded before data migration and native imports so early failures are recorded. */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startupErrorPage } from './startup-support.ts';

export const smokeMode = process.argv.includes('--smoke-test');
if (smokeMode) {
  const root = process.env.AGENTE_SMOKE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'Agente smoke ñ '));
  fs.mkdirSync(root, { recursive: true });
  process.env.AGENTE_HOME = path.join(root, 'data');
  process.env.AGENTE_CONFIG_DIR = path.join(root, 'core');
  process.env.AGENTE_SMOKE_SOCKET = process.platform === 'win32' ? `\\\\.\\pipe\\agente-smoke-${path.basename(root)}` : path.join(root, 'runtime.sock');
  app.setPath('appData', root);
  app.setPath('home', root);
  app.setPath('userData', path.join(root, 'browser'));
  // No network or native-model warmup is needed to prove packaged startup.
  app.disableHardwareAcceleration();
}
app.setAppLogsPath();
const logPath = path.join(app.getPath('logs'), 'startup.log');
let window: BrowserWindow | undefined;
let ready = false;
let failed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function record(message: string): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1_048_576) fs.renameSync(logPath, `${logPath}.previous`);
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch { /* An unwritable log must not hide the startup error. */ }
  console.error(`[startup] ${message}`);
}

export async function failStartup(error: unknown): Promise<void> {
  if (failed) return;
  failed = true;
  if (timer) clearTimeout(timer);
  // Only startup errors go here, never provider/config payloads.
  record(error instanceof Error ? error.stack || error.message : String(error));
  let failureScreenVerified = false;
  try {
    await app.whenReady();
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({ width: 760, height: 380, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    }
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupErrorPage(logPath))}`);
    window.show();
    if (smokeMode) {
      const visible = await window.webContents.executeJavaScript("!!document.querySelector('[data-startup-error]')");
      if (!visible || !fs.existsSync(logPath)) throw new Error('Startup failure did not produce a visible diagnostic');
      fs.writeFileSync(path.join(path.dirname(logPath), 'failure.png'), (await window.webContents.capturePage()).toPNG());
      failureScreenVerified = true;
    }
  } catch (fallbackError) {
    record(`Failure screen: ${String(fallbackError)}`);
    if (!smokeMode) dialog.showErrorBox('Agente could not start', `Please restart the app.\nStartup log: ${logPath}`);
  } finally {
    if (smokeMode) {
      if (failureScreenVerified) console.error(`SMOKE_FAILURE_SCREEN ${JSON.stringify({ logPath })}`);
      app.exit(1);
    }
  }
}

process.on('uncaughtException', (error) => { void failStartup(error); });
process.on('unhandledRejection', (error) => { if (!ready) void failStartup(error); else console.error(error); });

export function attachStartupDiagnostics(win: BrowserWindow): void {
  window = win;
  ready = false;
  failed = false;
  record(`Loading ${app.isPackaged ? 'packaged' : 'development'} renderer`);
  win.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) void failStartup(new Error(`Page load: ${code} ${description}`));
  });
  win.webContents.on('preload-error', (_event, _file, error) => { void failStartup(error); });
  win.webContents.on('render-process-gone', (_event, details) => { void failStartup(new Error(`Renderer exited: ${details.reason} (${details.exitCode})`)); });
  win.webContents.on('console-message', (details) => {
    if (smokeMode) console.log(`[renderer:${details.level}] ${details.message}`);
    if (!ready && details.level === 'error' && /Uncaught|\[startup\]/.test(details.message)) void failStartup(new Error(`Renderer bootstrap: ${details.message}`));
  });
  timer = setTimeout(() => { if (!ready) void failStartup(new Error('Renderer startup timed out after 30 seconds')); }, 30_000);
  win.once('closed', () => { if (timer) clearTimeout(timer); });
}

ipcMain.handle('desktop_renderer_ready', async (event, payload?: { worker?: boolean }) => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || failed) throw new Error('Foreign or failed renderer');
  const mounted = await window.webContents.executeJavaScript("(() => { const shell = document.querySelector('[data-desktop-shell]'); return !!shell && shell.getBoundingClientRect().width > 0 && !!shell.textContent.trim(); })()");
  if (!mounted) throw new Error('Application shell is not mounted');
  if (smokeMode && !payload?.worker) throw new Error('Editor worker was not checked');
  ready = true;
  if (timer) clearTimeout(timer);
  if (smokeMode) {
    try {
      const binary = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'agente.exe' : 'agente');
      const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
      if (!/agente/i.test(version)) throw new Error('Bundled Rust version check failed');
      // Let Chromium present the shell before capturing its first frame.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const image = await window.webContents.capturePage();
      if (image.isEmpty()) throw new Error('Window did not paint');
      const pixels = image.toBitmap();
      if (pixels.every((value, index) => value === pixels[index % 4])) throw new Error('Window painted a blank frame');
      fs.writeFileSync(path.join(path.dirname(logPath), 'ready.png'), image.toPNG());
      console.log(`SMOKE_READY ${JSON.stringify({ version: version.trim(), logPath })}`);
      setTimeout(() => app.exit(0), 100);
    } catch (error) { await failStartup(error); }
  }
  return { ok: true };
});

ipcMain.on('desktop_bootstrap_error', (event, message: unknown) => {
  if (!ready && window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) {
    void failStartup(new Error(typeof message === 'string' ? message.slice(0, 2000) : 'Renderer bootstrap failed'));
  }
});
