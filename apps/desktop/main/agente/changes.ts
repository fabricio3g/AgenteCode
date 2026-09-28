// ── What changed in a project ──────────────────────────────────────────
// The Changes pane lists changed files and shows each one's diff. Git is the
// source of truth: it also sees edits made through the shell, formatters and
// the user's own editor. Outside a git repository the pane has nothing to
// compare against (the chat's own undo still works there).

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, ChangeKind, ChangeList, FileDiff } from '../../shared/code-workspace.ts';

const run = promisify(execFile);

/** `relative` resolved inside `projectRoot`; throws when it points outside. */
function resolveInRoot(projectRoot: string, relative: string): string {
  const root = path.resolve(projectRoot);
  const abs = path.isAbsolute(relative) ? path.resolve(relative) : path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path "${relative}" escapes the project root`);
  }
  return abs;
}
const MAX_DIFF_BYTES = 400_000;

async function git(cwd: string, args: string[], maxBuffer = 20 * 1024 * 1024): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer, windowsHide: true });
  return stdout;
}

export async function isGitRepo(projectRoot: string): Promise<boolean> {
  try {
    return (await git(projectRoot, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** Parse `git status --porcelain=v1 -z`. Exported for tests. */
export function parsePorcelain(raw: string): Array<{ path: string; kind: ChangeKind }> {
  const out: Array<{ path: string; kind: ChangeKind }> = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    if (x === 'R' || x === 'C') {
      i += 1; // the next field is the original path
      out.push({ path: file, kind: 'renamed' });
    } else if (x === '?' || x === 'A') {
      out.push({ path: file, kind: 'created' });
    } else if (x === 'D' || y === 'D') {
      out.push({ path: file, kind: 'deleted' });
    } else {
      out.push({ path: file, kind: 'modified' });
    }
  }
  return out;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

async function gitChanges(projectRoot: string): Promise<ChangeList> {
  const [status, numstat, branch] = await Promise.all([
    git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(projectRoot, ['diff', 'HEAD', '--numstat', '-z']).catch(() => ''),
    git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).then((out) => out.trim()).catch(() => '')
  ]);
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split('\0')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (match) counts.set(match[3], { additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 });
  }
  const files = await Promise.all(parsePorcelain(status).map(async (file): Promise<ChangedFile> => {
    const known = counts.get(file.path);
    if (known) return { ...file, ...known };
    if (file.kind === 'created') {
      const text = await fsp.readFile(path.join(projectRoot, file.path), 'utf8').catch(() => '');
      return { ...file, additions: countLines(text), deletions: 0 };
    }
    return { ...file, additions: 0, deletions: 0 };
  }));
  return { source: 'git', ...(branch && branch !== 'HEAD' ? { branch } : {}), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function listChanges(projectRoot: string): Promise<ChangeList> {
  if (await isGitRepo(projectRoot)) return gitChanges(projectRoot);
  return { source: 'none', files: [] };
}

function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\0');
}

export async function fileDiff(projectRoot: string, relPath: string): Promise<FileDiff> {
  const abs = resolveInRoot(projectRoot, relPath);
  const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
  const after = await fsp.readFile(abs, 'utf8').catch(() => '');
  let before = '';
  if (await isGitRepo(projectRoot)) {
    before = await git(projectRoot, ['show', `HEAD:${rel}`]).catch(() => '');
  }
  const binary = looksBinary(before) || looksBinary(after);
  const tooLarge = before.length + after.length > MAX_DIFF_BYTES;
  return {
    path: rel,
    before: binary || tooLarge ? '' : before,
    after: binary || tooLarge ? '' : after,
    binary,
    tooLarge
  };
}

/** Put one file back to how it is in HEAD (removing it when HEAD doesn't have it). */
export async function revertFile(projectRoot: string, relPath: string): Promise<void> {
  const abs = resolveInRoot(projectRoot, relPath);
  const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
  if (!(await isGitRepo(projectRoot))) throw new Error(`No earlier version of ${rel} was recorded.`);
  const tracked = await git(projectRoot, ['ls-files', '--error-unmatch', '--', rel]).then(() => true, () => false);
  const inHead = await git(projectRoot, ['cat-file', '-e', `HEAD:${rel}`]).then(() => true, () => false);
  if (inHead) await git(projectRoot, ['checkout', 'HEAD', '--', rel]);
  else {
    if (tracked) await git(projectRoot, ['rm', '--cached', '--quiet', '--', rel]).catch(() => '');
    await fsp.rm(abs, { force: true });
  }
}
