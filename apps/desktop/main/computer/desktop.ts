import crypto from 'node:crypto';
import { app, BrowserWindow, desktopCapturer, dialog, powerMonitor, screen, webContents, type IpcMain } from 'electron';
import type { ComputerAction, ComputerObservation, ComputerState } from '../../shared/computer.ts';
import { ComputerSession, type ComputerOwner } from './session.ts';
import { ComputerHelper, computerHelperPath } from './helper.ts';
import { ComputerOverlayWindows } from './overlay.ts';

type Geometry = { displayId: number; bounds: Electron.Rectangle; scale: number; physical: Electron.Rectangle; protected?: Electron.Rectangle };
const helper = new ComputerHelper();
const overlay = new ComputerOverlayWindows();
let geometry: Geometry | undefined;

function physical(bounds: Electron.Rectangle) {
  const start = screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
  const end = screen.dipToScreenPoint({ x: bounds.x + bounds.width - 1, y: bounds.y + bounds.height - 1 });
  return { x: start.x, y: start.y, width: end.x - start.x + 1, height: end.y - start.y + 1 };
}
function within(point: { x: number; y: number }, bounds: Electron.Rectangle) {
  return point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}

export const computerSession = new ComputerSession({
  async ready() {
    if (process.platform !== 'win32') throw new Error('Computer control is currently available on Windows only.');
    const version = process.getSystemVersion().split('.').map(Number);
    if (version[0] === 10 && version[2] < 19041) throw new Error('Computer control requires Windows 10 version 2004 or later to exclude its overlay from capture.');
    await helper.ready();
  },
  async confirm(owner, task) {
    const contents = webContents.fromId(owner.webContentsId);
    const win = contents && BrowserWindow.fromWebContents(contents);
    if (!win || win.isDestroyed()) return false;
    const answer = await dialog.showMessageBox(win, {
      type: 'question', title: 'Use this computer', message: 'Allow computer use for this task?',
      detail: `${task}\n\nAgente can control this computer’s mouse and keyboard across your desktop. Screenshots are sent to this chat’s selected model and may remain with the chat.\n\nA full-screen overlay and labelled pointer show when Agente is working. Press Escape once to take over.`,
      buttons: ['Not now', 'Allow for this task'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return answer.response === 1;
  },
  arm: lease => helper.arm(lease),
  revoke() { geometry = undefined; helper.revoke(); },
  async observe() {
    // Screenshots are on demand, never a recording or a background stream.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(4096, Math.round(display.size.width * display.scaleFactor));
    const height = Math.min(4096, Math.round(display.size.height * display.scaleFactor));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const source = sources.find(candidate => candidate.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error('No screen image is available. Check screen capture permissions.');
    const size = source.thumbnail.getSize();
    const bar = overlay.barBounds();
    geometry = { displayId: display.id, bounds: display.bounds, scale: display.scaleFactor, physical: physical(display.bounds), protected: bar ? physical(bar) : undefined };
    return { id: crypto.randomUUID(), displayId: String(display.id), width: size.width, height: size.height, capturedAt: Date.now(), image: { data: source.thumbnail.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' } };
  },
  async act(action, observation, lease) {
    const mapped = mapAction(action, observation);
    await helper.act(lease, mapped);
    const pointer = 'x' in mapped ? screen.screenToDipPoint({ x: mapped.kind === 'drag' ? mapped.to_x : mapped.x, y: mapped.kind === 'drag' ? mapped.to_y : mapped.y }) : undefined;
    return pointer;
  },
  present: state => overlay.present({ ...state, pointer: state.phase === 'active' ? state.pointer ?? screen.getCursorScreenPoint() : undefined }),
  dismiss: () => overlay.dismiss(),
}, state => {
  const id = computerSession.owner?.webContentsId;
  const owner = id && webContents.fromId(id);
  if (owner && !owner.isDestroyed()) owner.send('computer_state', state);
});

function mapAction(action: ComputerAction, observation: ComputerObservation): ComputerAction {
  const current = geometry && screen.getAllDisplays().find(display => display.id === geometry!.displayId);
  if (!geometry || !current || observation.displayId !== String(current.id) || JSON.stringify(current.bounds) !== JSON.stringify(geometry.bounds) || current.scaleFactor !== geometry.scale) throw new Error('Display geometry changed. Take another computer_observe.');
  const rect = geometry.physical;
  const transform = (x: number, y: number) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= observation.width || y >= observation.height) throw new Error('Pointer coordinates must be within the latest screenshot.');
    const point = { x: rect.x + Math.round(x * (rect.width - 1) / Math.max(1, observation.width - 1)), y: rect.y + Math.round(y * (rect.height - 1) / Math.max(1, observation.height - 1)) };
    if (geometry!.protected && within(point, geometry!.protected)) throw new Error('The agent cannot operate its own control bar. Choose another target.');
    return point;
  };
  if (!('x' in action)) return action;
  const point = transform(action.x, action.y);
  if (action.kind === 'drag') {
    const end = transform(action.to_x, action.to_y);
    // Reject the entire path if it crosses the control bar.
    for (let i = 1; i < 30; i++) transform(Math.round(action.x + (action.to_x - action.x) * i / 30), Math.round(action.y + (action.to_y - action.y) * i / 30));
    return { ...action, ...point, to_x: end.x, to_y: end.y };
  }
  return { ...action, ...point };
}

helper.onRevoke = reason => computerSession.takeover(reason);
helper.onPointer = point => { if (computerSession.state.phase === 'active') overlay.pointer(screen.screenToDipPoint(point)); };
overlay.onFailure = () => computerSession.takeover('overlay_unavailable');

/** Called with a host-owned runtime identity, never tool-supplied session data. */
export function bindComputerOwner(owner: ComputerOwner) { computerSession.attach(owner); }
export function settleComputerTurn(sessionId: string, turnId: string) { computerSession.settled(sessionId, turnId); }
export function cancelComputerTurn(sessionId: string, reason = 'cancelled') {
  if (computerSession.owner?.sessionId === sessionId) computerSession.takeover(reason);
}
export function disposeComputer() { computerSession.end('app_closed'); helper.close(); }

export function registerComputerHandlers(ipcMain: IpcMain) {
  const knownOwners = new Set<number>();
  ipcMain.handle('computer_status', event => {
    if (!knownOwners.has(event.sender.id)) {
      knownOwners.add(event.sender.id);
      const release = () => { computerSession.releaseOwner(event.sender.id); knownOwners.delete(event.sender.id); };
      event.sender.once('destroyed', release); event.sender.once('render-process-gone', release);
    }
    const own = computerSession.owner?.webContentsId === event.sender.id;
    return { available: !!computerHelperPath(), state: own ? computerSession.state : { ...computerSession.state, task: '', activity: '', canResume: false }, owned: own };
  });
  ipcMain.handle('computer_control', (event, args: { action?: unknown } = {}) => {
    const owner = computerSession.owner;
    if (!owner || (!overlay.isBar(event.sender) && owner.webContentsId !== event.sender.id)) throw new Error('Computer control belongs to another window.');
    if (args.action === 'takeover') computerSession.takeover();
    else if (args.action === 'resume') computerSession.resume();
    else if (args.action === 'end') { owner.stop(); computerSession.end(); }
    else throw new Error('Unknown computer control.');
    return { ok: true };
  });
  ipcMain.handle('computer_overlay_ready', event => { if (!overlay.owns(event.sender)) throw new Error('Not a computer overlay.'); overlay.send(); });
  const displayChanged = () => { computerSession.takeover('display_changed'); overlay.dismiss(); };
  screen.on('display-added', displayChanged); screen.on('display-removed', displayChanged); screen.on('display-metrics-changed', displayChanged);
  powerMonitor.on('lock-screen', () => computerSession.takeover('screen_locked'));
  powerMonitor.on('suspend', () => computerSession.takeover('suspended'));
  app.once('before-quit', disposeComputer);
}

export type { ComputerOwner, ComputerState };
