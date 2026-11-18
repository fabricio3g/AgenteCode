// ── Long-running processes started by the Code agent ───────────────────
// `bash` with background: true (a dev server, a watcher, a test runner in
// watch mode) lands here instead of blocking a turn. Each process runs in its
// own process group so stopping it takes its children too, keeps the tail of
// its output, and reports localhost URLs it prints so the UI can open them in
// the browser panel.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { ProcessEvent, ProcessInfo } from '../../shared/code-workspace.ts';

export type { ProcessEvent, ProcessInfo };

const MAX_BUFFER = 200_000;
const FLUSH_MS = 120;
const STOP_GRACE_MS = 2_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s'"<>)\]]*)?/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Local URLs in a chunk of output, 0.0.0.0 rewritten to something a browser opens. */
export function findLocalUrls(text: string): string[] {
  const found = stripAnsi(text).match(LOCAL_URL) ?? [];
  return [...new Set(found.map((url) => url.replace('//0.0.0.0', '//localhost').replace(/[.,;:]+$/, '')))];
}

interface Entry {
  info: ProcessInfo;
  child: ChildProcess;
  buffer: string;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  exited: Promise<void>;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // Already gone.
  }
}

export class ProcessRegistry {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(event: ProcessEvent) => void>();
  private seq = 0;

  onEvent(listener: (event: ProcessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ProcessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  start(args: { chatId: string; command: string; cwd: string; env?: NodeJS.ProcessEnv }): ProcessInfo {
    const id = `p${++this.seq}-${Date.now().toString(36)}`;
    const isWindows = process.platform === 'win32';
    const child = spawn(isWindows ? 'cmd.exe' : 'bash', isWindows ? ['/c', args.command] : ['-c', args.command], {
      cwd: args.cwd,
      // Unbuffered Python so "Serving on http://…" arrives now, not at exit.
      env: { ...process.env, ...args.env, FORCE_COLOR: '0', NO_COLOR: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so stop() reaches whatever the command spawned.
      detached: !isWindows,
      windowsHide: true
    });
    const info: ProcessInfo = {
      id,
      chatId: args.chatId,
      command: args.command,
      cwd: args.cwd,
      pid: child.pid ?? null,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      urls: []
    };
    let resolveExit!: () => void;
    const entry: Entry = { info, child, buffer: '', pending: '', flushTimer: null, exited: new Promise((resolve) => { resolveExit = resolve; }) };
    this.entries.set(id, entry);

    const onData = (data: Buffer) => this.append(entry, data.toString('utf8'));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const finish = (code: number | null) => {
      if (entry.info.status === 'running') entry.info.status = 'exited';
      entry.info.exitCode = code;
      entry.info.endedAt = Date.now();
      this.flush(entry);
      this.emit({ type: 'process_exit', process: { ...entry.info } });
      resolveExit();
    };
    child.once('exit', (code) => finish(code));
    child.once('error', (error) => {
      this.append(entry, `\n${error.message}\n`);
      finish(127);
    });

    this.emit({ type: 'process_start', process: { ...info } });
    return { ...info };
  }

  private append(entry: Entry, text: string): void {
    entry.buffer = (entry.buffer + text).slice(-MAX_BUFFER);
    entry.pending += text;
    for (const url of findLocalUrls(text)) {
      if (entry.info.urls.includes(url)) continue;
      entry.info.urls.push(url);
      this.emit({ type: 'process_url', process: { ...entry.info }, url });
    }
    if (!entry.flushTimer) entry.flushTimer = setTimeout(() => this.flush(entry), FLUSH_MS);
  }

  private flush(entry: Entry): void {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    if (!entry.pending) return;
    const chunk = entry.pending;
    entry.pending = '';
    this.emit({ type: 'process_output', id: entry.info.id, chatId: entry.info.chatId, chunk });
  }

  get(id: string): ProcessInfo | null {
    const entry = this.entries.get(id);
    return entry ? { ...entry.info } : null;
  }

  /** The output so far (ANSI stripped), optionally only the last `tailChars`. */
  output(id: string, tailChars?: number): string | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const text = stripAnsi(entry.buffer);
    return tailChars ? text.slice(-tailChars) : text;
  }

  list(chatId?: string): ProcessInfo[] {
    return [...this.entries.values()]
      .filter((entry) => !chatId || entry.info.chatId === chatId)
      .map((entry) => ({ ...entry.info }));
  }

  /** Wait until the process prints a URL, exits, or `ms` passes. */
  async settle(id: string, ms: number): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const started = Date.now();
    while (Date.now() - started < ms && entry.info.status === 'running' && !entry.info.urls.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** SIGTERM the whole group, then SIGKILL whatever is left after a grace period. */
  async stop(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || entry.info.status !== 'running') return false;
    entry.info.status = 'stopped';
    killTree(entry.child, 'SIGTERM');
    const timer = setTimeout(() => killTree(entry.child, 'SIGKILL'), STOP_GRACE_MS);
    await entry.exited;
    clearTimeout(timer);
    return true;
  }

  /** Forget finished processes (the UI's "clear"). */
  prune(chatId?: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.info.status !== 'running' && (!chatId || entry.info.chatId === chatId)) this.entries.delete(id);
    }
  }

  async stopChat(chatId: string): Promise<void> {
    await Promise.all(this.list(chatId).filter((p) => p.status === 'running').map((p) => this.stop(p.id)));
    this.prune(chatId);
  }

  /** App quit: no grace period, nothing may outlive the app. */
  killAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.info.status === 'running') killTree(entry.child, 'SIGKILL');
    }
  }
}

export const processRegistry = new ProcessRegistry();
