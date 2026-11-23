// The files of a project, for `@` mentions in the Code composer: what git
// tracks (plus untracked files it doesn't ignore), or a bounded walk that
// skips the usual build and dependency folders when it isn't a repository.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 20_000;
const SKIP = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next', '.svelte-kit', '.venv', 'venv', '__pycache__', '.cache']);

function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 },
      (error, stdout) => resolve(error ? null : stdout.split('\n').filter(Boolean).slice(0, MAX_FILES))
    );
  });
}

export function walkFiles(root: string, limit = MAX_FILES): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) stack.push(child);
      } else if (entry.isFile()) {
        out.push(child);
        if (out.length >= limit) break;
      }
    }
  }
  return out.sort();
}

export async function listProjectFiles(root: string): Promise<string[]> {
  if (!root || !fs.existsSync(root)) return [];
  // Prefer the compiled Rust .gitignore-aware walker (`project.files`) when the
  // daemon is reachable; fall back to git/JS walk if offline or in unit tests.
  try {
    const { runtimeConnection } = await import('./rust-engine.ts');
    const client = await runtimeConnection();
    const result = await client.request<{ files?: string[] }>('project.files', {
      project_dir: root,
      limit: MAX_FILES
    });
    if (Array.isArray(result?.files)) return result.files;
  } catch {
    // Fall through to local git / directory walk.
  }
  return (await gitFiles(root)) ?? walkFiles(root);
}
