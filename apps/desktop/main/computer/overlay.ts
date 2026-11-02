import { app, BrowserWindow, screen, type Rectangle, type WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { ComputerState } from '../../shared/computer.ts';
import { computerOverlayHtml } from './overlay-html.ts';

/** Click-through display covers and a separate clickable, non-activating bar. */
export class ComputerOverlayWindows {
  constructor(private readonly options: { visible?: boolean } = {}) {}
  private covers = new Map<number, BrowserWindow>();
  private bar?: BrowserWindow;
  private state?: ComputerState;
  private opening?: Promise<void>;
  onFailure: () => void = () => {};
  owns(sender: WebContents) { return this.bar?.webContents.id === sender.id || [...this.covers.values()].some(win => win.webContents.id === sender.id); }
  isBar(sender: WebContents) { return this.bar?.webContents.id === sender.id; }
  barBounds(): Rectangle | undefined { return this.bar && !this.bar.isDestroyed() ? this.bar.getBounds() : undefined; }

  async present(state: ComputerState) {
    this.state = state;
    if (!['active', 'paused', 'preparing'].includes(state.phase)) return;
    if (!this.opening) this.opening = this.open().catch(error => { this.opening = undefined; throw error; });
    await this.opening;
    if (this.state !== state) return;
    this.send();
    for (const win of this.covers.values()) { if (state.phase === 'active' && this.options.visible !== false) win.showInactive(); else win.hide(); }
    if (this.options.visible !== false) this.bar?.showInactive();
  }
  pointer(point: { x: number; y: number }) {
    if (!this.state || this.state.phase !== 'active') return;
    this.state = { ...this.state, pointer: point }; this.send();
  }
  private async open() {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const windows: Promise<void>[] = [];
    const root = app.getAppPath();
    const assets = path.join(root, 'renderer', 'dist', 'assets');
    const bundled = fs.existsSync(assets) ? fs.readdirSync(assets).find(name => name.startsWith('geist-latin-wght-normal-') && name.endsWith('.woff2')) : undefined;
    const fontPath = app.isPackaged && bundled ? path.join(assets, bundled) : path.join(root, 'renderer', 'node_modules', '@fontsource-variable', 'geist', 'files', 'geist-latin-wght-normal.woff2');
    const font = fs.existsSync(fontPath) ? fs.readFileSync(fontPath).toString('base64') : '';
    for (const display of displays) {
      const cover = this.create(display.bounds, 'veil');
      cover.setIgnoreMouseEvents(true);
      this.covers.set(display.id, cover);
      windows.push(cover.loadURL(`data:text/html;base64,${Buffer.from(computerOverlayHtml('veil', font)).toString('base64')}`));
    }
    const width = Math.min(720, primary.workArea.width - 24);
    const bounds = { x: primary.workArea.x + Math.round((primary.workArea.width - width) / 2), y: primary.workArea.y + 8, width, height: 88 };
    this.bar = this.create(bounds, 'bar');
    windows.push(this.bar.loadURL(`data:text/html;base64,${Buffer.from(computerOverlayHtml('bar', font)).toString('base64')}`));
    await Promise.all(windows);
  }
  private create(bounds: Rectangle, kind: string) {
    const win = new BrowserWindow({ ...bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true,
      title: `Agente computer ${kind}`, webPreferences: { preload: path.join(app.getAppPath(), 'preload', 'computer.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('data:text/html;')) event.preventDefault(); });
    win.webContents.on('render-process-gone', () => this.onFailure());
    win.on('unresponsive', () => this.onFailure());
    return win;
  }
  send() {
    if (!this.state) return;
    for (const [id, win] of this.covers) {
      if (win.isDestroyed()) continue;
      const bounds = screen.getAllDisplays().find(display => display.id === id)?.bounds;
      const point = this.state.pointer;
      win.webContents.send('computer_overlay_state', { ...this.state, pointer: point && bounds ? { x: point.x - bounds.x, y: point.y - bounds.y } : undefined });
    }
    if (this.bar && !this.bar.isDestroyed()) this.bar.webContents.send('computer_overlay_state', this.state);
  }
  dismiss() {
    this.state = undefined;
    const windows = [...this.covers.values(), ...(this.bar ? [this.bar] : [])];
    this.covers.clear(); this.bar = undefined; this.opening = undefined;
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
  }
}
