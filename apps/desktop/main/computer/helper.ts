import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ComputerAction } from '../../shared/computer.ts';

export function computerHelperPath(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const bundled = path.join(process.resourcesPath ?? '', 'bin', 'agente-computer.exe');
  if (app.isPackaged) return fs.existsSync(bundled) ? bundled : undefined;
  const root = path.resolve(app.getAppPath(), '..', '..');
  return ['debug', 'release'].map(profile => path.join(root, 'target', profile, 'agente-computer.exe')).find(file => fs.existsSync(file));
}

/** Only a private inherited stdio channel; the helper has no listening port. */
export class ComputerHelper {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private sequence = 0;
  private lease = 0;
  private pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onRevoke: (reason: string) => void = () => {};
  onPointer: (point: { x: number; y: number }) => void = () => {};

  ready() {
    if (this.starting) return this.starting;
    const pending = this.start().catch(error => { if (this.starting === pending) this.starting = undefined; throw error; });
    this.starting = pending;
    return pending;
  }
  private start(): Promise<void> {
    const binary = computerHelperPath();
    if (!binary) return Promise.reject(new Error(process.platform === 'win32' ? 'Computer control helper is missing. Build agente-computer and restart Agente.' : 'Computer control is currently available on Windows only.'));
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      this.child = child;
      const timeout = setTimeout(() => { if (this.child === child) this.close(); reject(new Error('The native Escape listener did not become ready.')); }, 5000);
      let ready = false;
      let errorText = '';
      child.stderr.on('data', data => { errorText = (errorText + String(data)).slice(-2048); });
      const reader = createInterface({ input: child.stdout });
      reader.on('line', line => {
        if (this.child !== child) return;
        try {
          if (line.length > 128 * 1024) throw new Error('Invalid helper message.');
          const event = JSON.parse(line);
          if (event.event === 'ready' && event.protocol === 1) {
            ready = true; clearTimeout(timeout);
            this.heartbeat = setInterval(() => this.write({ id: 0, op: 'ping' }), 500);
            this.heartbeat.unref(); resolve();
          } else if (event.event === 'revoked' && event.lease === this.lease && this.lease !== 0) { this.lease = 0; this.onRevoke(String(event.reason)); }
          else if (event.event === 'pointer' && Number.isFinite(event.x) && Number.isFinite(event.y)) this.onPointer({ x: event.x, y: event.y });
          else if (typeof event.id === 'number') {
            const pending = this.pending.get(event.id);
            if (!pending) return;
            clearTimeout(pending.timer); this.pending.delete(event.id);
            if (event.ok) pending.resolve(); else pending.reject(new Error(String(event.error || 'Native input failed.')));
          }
        } catch { this.onRevoke('helper_protocol_error'); this.close(); }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); if (this.child === child) this.close(); });
      child.once('exit', () => {
        clearTimeout(timeout); reader.close();
        if (!ready) reject(new Error(errorText || 'The native Escape listener failed.'));
        if (this.child === child) {
          if (this.lease !== 0) { const restore = spawn(binary, ['--restore-cursor'], { windowsHide: true, stdio: 'ignore', shell: false }); restore.on('error', () => {}); }
          this.onRevoke('helper_disconnected'); this.close();
        }
      });
      child.stdin.on('error', () => { if (this.child === child) { this.onRevoke('helper_disconnected'); this.close(); } });
    });
  }
  private write(value: unknown) { if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  private call(op: string, payload: Record<string, unknown> = {}) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('Native input helper is disconnected.'));
    const id = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); this.revoke(); this.onRevoke('native_timeout');
        reject(new Error('Native input timed out. Take a new observation; do not replay the action.'));
      }, 12_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, op, ...payload });
    });
  }
  arm(lease: number) { this.lease = lease; return this.call('arm', { lease }); }
  act(lease: number, action: ComputerAction) { return this.call('act', { lease, action }); }
  revoke() { this.lease = 0; this.write({ id: 0, op: 'revoke' }); }
  close() {
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    const child = this.child; this.child = undefined; this.starting = undefined;
    if (child) { child.stdin.end(); const timer = setTimeout(() => child.kill(), 500); timer.unref(); }
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('Native input helper disconnected.')); }
    this.pending.clear();
  }
}
