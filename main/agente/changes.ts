// ── What changed in a project ──────────────────────────────────────────
// The Changes pane lists changed files and shows each one's diff. In a git
// repository git is the source of truth — it also sees edits made through
// bash, formatters and the user's own editor. Outside git, the agent's turn
// checkpoints are the only record: the oldest snapshot of each file is the
// "before".

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, ChangeKind, ChangeList, FileDiff } from '../../shared/code-workspace.ts';
import { resolveInRoot } from './tools/define-tool.ts';

const run = promisify(execFile);
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

/**
 * The oldest snapshot of every file the agent touched, across turns. The
 * checkpoint dir holds `<turn>/before/<rel>` (or `<rel>.absent` for files
 * the turn created).
 */
async function earliestSnapshots(checkpointDir: string): Promise<Map<string, { snapshot: string; absent: boolean }>> {
  const result = new Map<string, { snapshot: string; absent: boolean }>();
  const turns = (await fsp.readdir(checkpointDir).catch(() => [] as string[]))
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b));
  for (const turn of turns) {
    const base = path.join(checkpointDir, turn, 'before');
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
        else {
          const absent = entry.name.endsWith('.absent');
          const key = absent ? rel.slice(0, -'.absent'.length) : rel;
          if (!result.has(key)) result.set(key, { snapshot: path.join(dir, entry.name), absent });
        }
      }
    };
    await walk(base, '');
  }
  return result;
}

async function checkpointChanges(projectRoot: string, checkpointDir: string): Promise<ChangeList> {
  const snapshots = await earliestSnapshots(checkpointDir);
  const files: ChangedFile[] = [];
  for (const [rel, { snapshot, absent }] of snapshots) {
    const current = await fsp.readFile(path.join(projectRoot, rel), 'utf8').catch(() => null);
    const before = absent ? null : await fsp.readFile(snapshot, 'utf8').catch(() => '');
    if (before === null && current === null) continue;
    if (before === null) files.push({ path: rel, kind: 'created', additions: countLines(current ?? ''), deletions: 0 });
    else if (current === null) files.push({ path: rel, kind: 'deleted', additions: 0, deletions: countLines(before) });
    else if (before !== current) {
      // Cheap counts; the pane computes the exact diff when a file is opened.
      const a = new Set(before.split('\n'));
      const b = new Set(current.split('\n'));
      files.push({
        path: rel,
        kind: 'modified',
        additions: [...b].filter((line) => !a.has(line)).length,
        deletions: [...a].filter((line) => !b.has(line)).length
      });
    }
  }
  return { source: files.length ? 'checkpoints' : 'none', files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function listChanges(projectRoot: string, checkpointDir?: string): Promise<ChangeList> {
  if (await isGitRepo(projectRoot)) return gitChanges(projectRoot);
  if (checkpointDir) return checkpointChanges(projectRoot, checkpointDir);
  return { source: 'none', files: [] };
}

function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\0');
}

export async function fileDiff(projectRoot: string, relPath: string, checkpointDir?: string): Promise<FileDiff> {
  const abs = resolveInRoot(projectRoot, relPath);
  const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
  const after = await fsp.readFile(abs, 'utf8').catch(() => '');
  let before = '';
  if (await isGitRepo(projectRoot)) {
    before = await git(projectRoot, ['show', `HEAD:${rel}`]).catch(() => '');
  } else if (checkpointDir) {
    const snap = (await earliestSnapshots(checkpointDir)).get(rel);
    if (snap && !snap.absent) before = await fsp.readFile(snap.snapshot, 'utf8').catch(() => '');
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

/** Put one file back to its "before" (HEAD in git, the oldest snapshot otherwise). */
export async function revertFile(projectRoot: string, relPath: string, checkpointDir?: string): Promise<void> {
  const abs = resolveInRoot(projectRoot, relPath);
  const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
  if (await isGitRepo(projectRoot)) {
    const tracked = await git(projectRoot, ['ls-files', '--error-unmatch', '--', rel]).then(() => true, () => false);
    const inHead = await git(projectRoot, ['cat-file', '-e', `HEAD:${rel}`]).then(() => true, () => false);
    if (inHead) await git(projectRoot, ['checkout', 'HEAD', '--', rel]);
    else {
      if (tracked) await git(projectRoot, ['rm', '--cached', '--quiet', '--', rel]).catch(() => '');
      await fsp.rm(abs, { force: true });
    }
    return;
  }
  const snap = checkpointDir ? (await earliestSnapshots(checkpointDir)).get(rel) : undefined;
  if (!snap) throw new Error(`No earlier version of ${rel} was recorded.`);
  if (snap.absent) await fsp.rm(abs, { force: true });
  else {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.copyFile(snap.snapshot, abs);
  }
}
