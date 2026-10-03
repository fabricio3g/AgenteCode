// ── Opening a file in the user's editor ────────────────────────────────
// "Open in editor" is not `shell.openPath`: that hands the file to whatever the
// OS associates with it, which for source files is often nothing at all. Here
// the editor is chosen (preference, then $VISUAL/$EDITOR, then a PATH probe for
// the usual suspects) and launched with the file, and with the line when the
// editor understands one.
//
// Terminal editors have no window to launch into, so they are not spawned at
// all: the answer carries a shell line the app runs in its own terminal.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { OpenInEditorArgs, OpenInEditorResult } from '../../shared/code-workspace.ts';

export interface EditorInvocation {
  command: string;
  args: string[];
  /** nvim-style: run it in the app's terminal instead of detached. */
  terminal: boolean;
}

/** Editors looked for on PATH when nothing is configured, best known first. */
export const EDITOR_CANDIDATES = ['code', 'cursor', 'windsurf', 'codium', 'zed', 'subl', 'idea', 'sublime_text', 'nvim', 'vim'];

/** Editors that only run inside a terminal. */
const TERMINAL_EDITORS = new Set(['nvim', 'vim', 'vi', 'hx', 'helix', 'nano', 'micro', 'emacs']);

/** `basename` without the Windows launcher suffix, lowercased. */
function commandName(command: string): string {
  const base = path.basename(command.replace(/\\/g, '/')).toLowerCase();
  return base.replace(/\.(cmd|exe|bat|ps1)$/, '');
}

/** `file:line` for the editors that take one argument, the file alone otherwise. */
function withLine(file: string, line?: number): string {
  return line && line > 0 ? `${file}:${line}` : file;
}

/** Split a configured command line on whitespace, honouring double quotes. */
export function splitCommand(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of value.trim()) {
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && /\s/.test(char)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/**
 * How one editor is launched with a file. Pure, so the argument rules are
 * tested without spawning anything.
 *
 * A configured command may place `{file}` and `{line}` itself; without a
 * placeholder the family rule applies, and an unknown editor simply gets the
 * path appended.
 */
export function editorInvocation(editor: string, file: string, line?: number): EditorInvocation {
  const parts = splitCommand(editor);
  if (!parts.length) throw new Error('No editor configured.');
  const [command, ...configured] = parts;
  const terminal = TERMINAL_EDITORS.has(commandName(command));

  if (configured.some((arg) => arg.includes('{file}') || arg.includes('{line}'))) {
    return {
      command,
      args: configured.map((arg) => arg.replaceAll('{file}', file).replaceAll('{line}', line && line > 0 ? String(line) : '')),
      terminal
    };
  }

  const name = commandName(command);
  // Below, `line` is only honoured when the editor has a way to take it.
  if (['code', 'code-insiders', 'codium', 'cursor', 'windsurf', 'trae'].includes(name)) {
    return { command, args: [...configured, '-g', withLine(file, line)], terminal };
  }
  if (['zed', 'zedit', 'subl', 'sublime_text', 'lapce'].includes(name)) {
    return { command, args: [...configured, withLine(file, line)], terminal };
  }
  if (['idea', 'webstorm', 'pycharm', 'goland', 'clion', 'rustrover', 'phpstorm', 'rider', 'rubymine', 'datagrip'].includes(name)) {
    const at = line && line > 0 ? ['--line', String(line)] : [];
    return { command, args: [...configured, ...at, file], terminal };
  }
  if (terminal) {
    const at = line && line > 0 ? [`+${line}`] : [];
    return { command, args: [...configured, ...at, file], terminal };
  }
  return { command, args: [...configured, file], terminal };
}

/** Resolve `command` on PATH (or as a path), the way a shell would find it. */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!command) return null;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const candidates = command.includes('/') || command.includes('\\')
    ? exts.map((ext) => command + ext)
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap((dir) => exts.map((ext) => path.join(dir, command + ext)));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The editor to use: the preference, then `$VISUAL`/`$EDITOR`, then the first
 * candidate on PATH. Null means "tell the user to configure one".
 */
export function resolveEditor(preferred?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = (preferred ?? '').trim();
  if (configured) return configured;
  const fromEnv = (env.VISUAL || env.EDITOR || '').trim();
  if (fromEnv && which(splitCommand(fromEnv)[0] ?? '', env)) return fromEnv;
  for (const candidate of EDITOR_CANDIDATES) if (which(candidate, env)) return candidate;
  return null;
}

/** One shell line for the terminal fallback, quoted for the platform. */
export function shellLine(invocation: EditorInvocation): string {
  const quote = (value: string): string => (process.platform === 'win32'
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'\\''`)}'`);
  return [invocation.command, ...invocation.args].map(quote).join(' ');
}

/** `relative` resolved inside `projectRoot`; throws when it points outside. */
function resolveInRoot(projectRoot: string, relative: string): string {
  const root = path.resolve(projectRoot);
  const abs = path.isAbsolute(relative) ? path.resolve(relative) : path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path "${relative}" escapes the project root`);
  return abs;
}

export function openInEditor(args: OpenInEditorArgs & { editor?: string }): Promise<OpenInEditorResult> {
  return new Promise((resolve) => {
    let file: string;
    try {
      file = resolveInRoot(args.projectRoot, args.path);
    } catch (error) {
      resolve({ ok: false, error: (error as Error).message });
      return;
    }

    const editor = resolveEditor(args.editor);
    if (!editor) {
      resolve({ ok: false, error: 'No editor found. Set one in Settings, or set $EDITOR.' });
      return;
    }

    let invocation: EditorInvocation;
    try {
      invocation = editorInvocation(editor, file, args.line);
    } catch (error) {
      resolve({ ok: false, error: (error as Error).message });
      return;
    }

    if (invocation.terminal) {
      resolve({ ok: true, editor: commandName(invocation.command), terminal: { command: shellLine(invocation), cwd: path.resolve(args.projectRoot) } });
      return;
    }

    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // Windows ships the launchers as .cmd, which needs a shell to run.
      shell: process.platform === 'win32'
    });
    child.once('error', (error) => resolve({ ok: false, error: `${invocation.command}: ${error.message}` }));
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, editor: commandName(invocation.command) });
    });
  });
}
