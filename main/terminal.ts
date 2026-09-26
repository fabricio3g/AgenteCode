// ── Integrated terminal ────────────────────────────────────────────────
// Real shells (node-pty) for the Code space's terminal dock. Output goes to
// the window that opened the terminal as `terminal_event`; the renderer
// renders it with xterm.js. node-pty is a native module, so it is loaded
// lazily: a missing or broken build disables terminals instead of the app.

import os from 'node:os';
import type { WebContents } from 'electron';
import type { IPty } from 'node-pty';
import type { TerminalEvent } from '../shared/code-workspace.ts';

interface Terminal {
  pty: IPty;
  owner: WebContents;
  cwd: string;
}

const terminals = new Map<string, Terminal>();
let seq = 0;
let ptyModule: typeof import('node-pty') | null = null;

async function loadPty(): Promise<typeof import('node-pty')> {
  if (!ptyModule) ptyModule = await import('node-pty');
  return ptyModule;
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: process.env.COMSPEC?.includes('powershell') ? process.env.COMSPEC : 'powershell.exe', args: [] };
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

function send(owner: WebContents, event: TerminalEvent): void {
  if (!owner.isDestroyed()) owner.send('terminal_event', event);
}

export async function createTerminal(owner: WebContents, args: { cwd?: string; cols?: number; rows?: number }): Promise<{ id: string; shell: string }> {
  const pty = await loadPty();
  const shell = defaultShell();
  const cwd = args.cwd || os.homedir();
  const id = `t${++seq}`;
  const proc = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: Math.max(20, args.cols ?? 80),
    rows: Math.max(4, args.rows ?? 24),
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
  });
  terminals.set(id, { pty: proc, owner, cwd });
  proc.onData((data) => send(owner, { type: 'data', id, data }));
  proc.onExit(({ exitCode }) => {
    terminals.delete(id);
    send(owner, { type: 'exit', id, exitCode });
  });
  // A closed window takes its shells with it.
  owner.once('destroyed', () => killTerminal(id));
  return { id, shell: shell.file.split(/[\\/]/).pop() || shell.file };
}

export function writeTerminal(id: string, data: string): void {
  terminals.get(id)?.pty.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const term = terminals.get(id);
  if (!term || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
  try {
    term.pty.resize(Math.max(20, Math.floor(cols)), Math.max(4, Math.floor(rows)));
  } catch {
    // The shell exited between the resize and now.
  }
}

export function killTerminal(id: string): void {
  const term = terminals.get(id);
  if (!term) return;
  terminals.delete(id);
  try {
    term.pty.kill();
  } catch {
    // Already gone.
  }
}

export function killAllTerminals(): void {
  for (const id of [...terminals.keys()]) killTerminal(id);
}
