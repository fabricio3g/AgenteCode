// ── Built-in coding tools ──────────────────────────────────────────────
// read / write / edit / bash / grep / ls against the project root. Plain
// registered tools — an extension could have provided any of them.

import { spawn, type ChildProcess } from 'node:child_process';
import type { ProcessRegistry } from '../processes.ts';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { z } from 'zod';
import { defineTool, resolveInRoot } from './define-tool.ts';
import type { AgentTool } from '../../../shared/agent-core/types.ts';

const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LINES = 2000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_GREP_RESULTS = 200;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', 'target']);

const relPathSchema = z.string().min(1).describe('Path relative to the project root');

function withLineNumbers(content: string, startLine = 1): string {
  const lines = content.split('\n');
  const pad = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(pad, ' ')}\t${line}`)
    .join('\n');
}

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8000);
  return probe.includes(0);
}

export function createReadTool(projectRoot: string): AgentTool {
  return defineTool({
    name: 'read',
    description:
      'Read a text file from the project. Returns content with line numbers. Use offset/limit for large files.',
    schema: z.object({
      path: relPathSchema,
      offset: z.number().int().min(1).optional().describe('1-based line to start from'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max lines to return')
    }),
    executionMode: 'parallel',
    async execute(args) {
      const abs = resolveInRoot(projectRoot, args.path);
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat) return { content: `File not found: ${args.path}`, isError: true };
      if (stat.isDirectory()) return { content: `${args.path} is a directory — use ls instead.`, isError: true };

      const handle = await fsp.open(abs, 'r');
      try {
        const size = Math.min(stat.size, MAX_READ_BYTES);
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, 0);
        if (looksBinary(buffer)) {
          return { content: `${args.path} is binary (${stat.size} bytes).`, details: { binary: true, size: stat.size } };
        }
        let text = buffer.toString('utf8');
        const allLines = text.split('\n');
        const offset = args.offset ?? 1;
        const limit = args.limit ?? MAX_READ_LINES;
        const slice = allLines.slice(offset - 1, offset - 1 + limit);
        const truncatedLines = allLines.length - (offset - 1) - slice.length;
        text = slice.join('\n');
        if (stat.size > MAX_READ_BYTES) text += `\n… (file truncated at ${MAX_READ_BYTES} bytes)`;
        if (truncatedLines > 0) text += `\n… (${truncatedLines} more lines — pass a larger limit or offset)`;
        return {
          content: withLineNumbers(text, offset),
          details: { path: args.path, bytes: stat.size, truncated: stat.size > MAX_READ_BYTES }
        };
      } finally {
        await handle.close();
      }
    }
  });
}

/**
 * A plain write that would shrink a large file to a fragment which does not
 * begin the way the file does is almost always a continuation sent without
 * append — the failure that wipes a long file mid-way. Exported for tests.
 */
export function looksLikeLostContinuation(existing: string, next: string): boolean {
  if (existing.length < 4_000 || next.length >= existing.length * 0.5) return false;
  // A real rewrite opens the same way (a doctype, an import, a shebang).
  const firstLine = (text: string) => (text.trimStart().split('\n')[0] ?? '').trim().slice(0, 80);
  return firstLine(next) !== firstLine(existing);
}

export function createWriteTool(projectRoot: string): AgentTool {
  return defineTool({
    name: 'write',
    description:
      'Create or overwrite a file with the given content. Parent directories are created. ' +
      'For a long file, write the first part, then add the rest with append: true calls — never write a fragment without append, it replaces the whole file.',
    schema: z.object({
      path: relPathSchema,
      content: z.string().describe('File content (the whole file, or the next part with append: true)'),
      append: z.boolean().optional().describe('Add content to the end of the existing file instead of replacing it'),
      overwrite: z.boolean().optional().describe('Confirm replacing a large existing file with much shorter content')
    }),
    mutating: true,
    executionMode: 'sequential',
    async execute(args) {
      const abs = resolveInRoot(projectRoot, args.path);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      if (args.append) {
        await fsp.appendFile(abs, args.content, 'utf8');
        const total = (await fsp.stat(abs)).size;
        return {
          content: `Appended ${args.content.length} bytes to ${args.path} (now ${total} bytes).`,
          details: { path: args.path, bytes: Buffer.byteLength(args.content), appended: true }
        };
      }
      const existing = await fsp.readFile(abs, 'utf8').catch(() => null);
      if (existing !== null && !args.overwrite && looksLikeLostContinuation(existing, args.content)) {
        return {
          content: `Not written: this would replace ${args.path} (${existing.length} bytes) with ${args.content.length} bytes that do not start like the file — it looks like the next part of it. `
            + 'To add it to the end, call write again with append: true. To really replace the file, pass overwrite: true.',
          isError: true
        };
      }
      await fsp.writeFile(abs, args.content, 'utf8');
      return {
        content: `Wrote ${args.content.length} bytes to ${args.path}.`,
        details: { path: args.path, bytes: Buffer.byteLength(args.content) }
      };
    }
  });
}

export function createEditTool(projectRoot: string): AgentTool {
  return defineTool({
    name: 'edit',
    description:
      'Replace an exact text snippet in a file. oldText must match exactly (including whitespace) and be unique unless replaceAll is set.',
    schema: z.object({
      path: relPathSchema,
      oldText: z.string().min(1).describe('Exact text to replace'),
      newText: z.string().describe('Replacement text'),
      replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match')
    }),
    mutating: true,
    executionMode: 'sequential',
    async execute(args) {
      const abs = resolveInRoot(projectRoot, args.path);
      const original = await fsp.readFile(abs, 'utf8').catch(() => null);
      if (original === null) return { content: `File not found: ${args.path}`, isError: true };

      const occurrences = original.split(args.oldText).length - 1;
      if (occurrences === 0) {
        return { content: `oldText not found in ${args.path}. Read the file again and copy the text exactly.`, isError: true };
      }
      if (occurrences > 1 && !args.replaceAll) {
        return {
          content: `oldText appears ${occurrences} times in ${args.path}. Add surrounding context to make it unique, or set replaceAll.`,
          isError: true
        };
      }

      const updated = args.replaceAll
        ? original.split(args.oldText).join(args.newText)
        : original.replace(args.oldText, args.newText);
      await fsp.writeFile(abs, updated, 'utf8');

      const oldLines = args.oldText.split('\n').length;
      const newLines = args.newText.split('\n').length;
      return {
        content: `Edited ${args.path}: replaced ${occurrences} occurrence(s).`,
        details: {
          path: args.path,
          occurrences,
          additions: newLines,
          deletions: oldLines
        }
      };
    }
  });
}

export interface BashToolOptions {
  /** Owning conversation; background processes are listed and stopped per chat. */
  chatId?: string;
  processes?: ProcessRegistry;
}

/** Kill a detached child and everything it spawned. */
function killGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

export function createBashTool(projectRoot: string, options: BashToolOptions = {}): AgentTool {
  const { chatId, processes } = options;
  return defineTool({
    name: 'bash',
    description:
      'Run a shell command in the project root and return combined stdout/stderr with the exit code. Avoid interactive commands.' +
      (processes
        ? ' For anything that keeps running (dev servers, watchers, `npm run dev`), set background: true — the call returns right away with a process id and the first output; read more with process_output and stop it with process_stop.'
        : ''),
    schema: z.object({
      command: z.string().min(1).describe('The command to run'),
      timeoutMs: z.number().int().min(1000).max(600_000).optional().describe('Timeout in ms (default 120000). Ignored with background.'),
      ...(processes
        ? { background: z.boolean().optional().describe('Keep running after this call returns (servers, watchers)') }
        : {})
    }),
    mutating: true,
    executionMode: 'sequential',
    async execute(args, ctx) {
      if (processes && chatId && (args as { background?: boolean }).background) {
        const started = processes.start({ chatId, command: args.command, cwd: projectRoot });
        await processes.settle(started.id, 4_000);
        const info = processes.get(started.id) ?? started;
        const firstOutput = (processes.output(started.id, 4_000) ?? '').trim();
        const state = info.status === 'running'
          ? `Running in the background as ${info.id}.`
          : `Exited with code ${info.exitCode} before it could keep running.`;
        return {
          content: [state, info.urls.length ? `Listening on ${info.urls.join(', ')}` : '', firstOutput || '(no output yet)']
            .filter(Boolean).join('\n'),
          isError: info.status !== 'running' && info.exitCode !== 0,
          details: { processId: info.id, urls: info.urls, background: true }
        };
      }

      const timeoutMs = args.timeoutMs ?? 120_000;
      const isWindows = process.platform === 'win32';
      const child = spawn(isWindows ? 'cmd.exe' : 'bash', isWindows ? ['/c', args.command] : ['-c', args.command], {
        cwd: projectRoot,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own group, so a timeout or Stop also ends what it spawned.
        detached: !isWindows
      });

      let output = '';
      let truncated = false;
      let lastUpdate = 0;
      const append = (chunk: Buffer) => {
        if (output.length >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        output += chunk.toString('utf8', 0, Math.min(chunk.length, MAX_OUTPUT_BYTES - output.length));
        // Stream the tail so a long command is visibly alive.
        const now = Date.now();
        if (now - lastUpdate > 250) {
          lastUpdate = now;
          ctx.onUpdate?.(output.slice(-4_000));
        }
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', (err) => {
          output += `\nspawn error: ${err.message}`;
          resolve({ code: 127, signal: null });
        });
      });

      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
      ctx.signal.addEventListener('abort', () => killGroup(child), { once: true });
      const started = Date.now();
      const { code } = await exited;
      clearTimeout(timer);

      const durationMs = Date.now() - started;
      let report = output.trim();
      if (truncated) report += `\n… (output truncated at ${MAX_OUTPUT_BYTES} bytes)`;
      const tail = timedOut
        ? `\n(exit: timed out after ${timeoutMs}ms${processes ? ' — use background: true for commands that keep running' : ''})`
        : `\n(exit ${code})`;

      return {
        content: `${report || '(no output)'}${tail}`,
        isError: code !== 0,
        details: { exitCode: code, durationMs, timedOut }
      };
    }
  });
}

async function* walkFiles(root: string, maxFiles = 5000): AsyncGenerator<string> {
  let visited = 0;
  const queue: string[] = [root];
  while (queue.length && visited < maxFiles) {
    const dir = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full);
      } else if (entry.isFile()) {
        visited += 1;
        if (visited >= maxFiles) return;
        yield full;
      }
    }
  }
}

export function createGrepTool(projectRoot: string): AgentTool {
  return defineTool({
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns path:line matches.',
    schema: z.object({
      pattern: z.string().min(1).describe('JavaScript regular expression'),
      path: z.string().optional().describe('Directory or file to search (default: project root)'),
      include: z.string().optional().describe('Glob filter for file names, e.g. "*.ts"'),
      maxResults: z.number().int().min(1).max(500).optional()
    }),
    executionMode: 'parallel',
    async execute(args) {
      let regex: RegExp;
      try {
        regex = new RegExp(args.pattern);
      } catch (err: unknown) {
        return { content: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }

      const target = resolveInRoot(projectRoot, args.path || '.');
      const stat = await fsp.stat(target).catch(() => null);
      if (!stat) return { content: `Path not found: ${args.path}`, isError: true };

      const includeRegex = args.include ? globToRegExp(args.include) : null;
      const limit = args.maxResults ?? MAX_GREP_RESULTS;
      const matches: string[] = [];

      const searchFile = async (abs: string) => {
        if (matches.length >= limit) return;
        if (includeRegex && !includeRegex.test(path.basename(abs))) return;
        const buffer = await fsp.readFile(abs).catch(() => null);
        if (!buffer || buffer.length > 1024 * 1024 || looksBinary(buffer)) return;
        const rel = path.relative(projectRoot, abs);
        const lines = buffer.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          if (regex.test(lines[i]!)) matches.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 240)}`);
        }
      };

      if (stat.isFile()) {
        await searchFile(target);
      } else {
        for await (const abs of walkFiles(target)) {
          await searchFile(abs);
          if (matches.length >= limit) break;
        }
      }

      if (!matches.length) return { content: 'No matches.', details: { count: 0 } };
      return {
        content: matches.join('\n') + (matches.length >= limit ? `\n… (stopped at ${limit} matches)` : ''),
        details: { count: matches.length, truncated: matches.length >= limit }
      };
    }
  });
}

export function createLsTool(projectRoot: string): AgentTool {
  return defineTool({
    name: 'ls',
    description: 'List a directory (name + type + size). Skips hidden and vendored directories by default.',
    schema: z.object({
      path: z.string().optional().describe('Directory to list (default: project root)'),
      all: z.boolean().optional().describe('Include hidden and vendored entries')
    }),
    executionMode: 'parallel',
    async execute(args) {
      const abs = resolveInRoot(projectRoot, args.path || '.');
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat) return { content: `Path not found: ${args.path}`, isError: true };
      if (stat.isFile()) return { content: `${args.path} is a file.`, details: { file: true } };

      const entries = await fsp.readdir(abs, { withFileTypes: true });
      const rows: string[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!args.all && (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name))) continue;
        if (entry.isDirectory()) rows.push(`${entry.name}/`);
        else if (entry.isSymbolicLink()) rows.push(`${entry.name} →`);
        else {
          const size = await fsp.stat(path.join(abs, entry.name)).then((s) => s.size).catch(() => 0);
          rows.push(`${entry.name} (${size} bytes)`);
        }
      }
      return {
        content: rows.join('\n') || '(empty)',
        details: { path: args.path || '.', count: rows.length }
      };
    }
  });
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function createBuiltinTools(projectRoot: string, bash: BashToolOptions = {}): AgentTool[] {
  return [
    createReadTool(projectRoot),
    createWriteTool(projectRoot),
    createEditTool(projectRoot),
    createBashTool(projectRoot, bash),
    createGrepTool(projectRoot),
    createLsTool(projectRoot)
  ];
}
