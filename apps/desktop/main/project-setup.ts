// Making a project folder from the Add project dialog: a new empty folder
// (with `git init`), or a clone of a remote repository. Main owns both — the
// renderer only names a parent folder, a folder name and a URL, and every one
// of them is checked here before anything touches the disk.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { cloneUrlProblem, folderNameProblem, PROBLEM_TEXT, repoNameFromUrl } from '../shared/project-setup.ts';

/** Clones can be big; past this the clone is abandoned. */
const CLONE_TIMEOUT_MS = 15 * 60 * 1000;

export type ProjectSetupResult = { path: string; gitInitialized?: boolean };

/** `~` and `~/x` become the home folder; anything else resolves to an absolute path. */
export function expandHome(input: string, home = os.homedir()): string {
  const text = input.trim();
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) return nodePath.join(home, text.slice(2));
  return nodePath.resolve(text);
}

async function assertParent(parent: string): Promise<string> {
  const dir = expandHome(parent);
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`The folder ${dir} does not exist.`);
  return dir;
}

async function assertFree(target: string): Promise<void> {
  if (await fs.stat(target).then(() => true, () => false)) {
    throw new Error(`${target} already exists. Pick another name, or open it with Open folder.`);
  }
}

function runGit(args: string[], cwd: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      // Never stop on a credential prompt nobody can answer.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
    }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return reject(new Error('Git is not installed or not on PATH.'));
      const said = String(stderr || '').trim().split('\n').filter(Boolean).pop();
      reject(new Error(said || error.message));
    });
  });
}

/** Create `<parent>/<name>` (it must not exist) and `git init` it when asked. */
export async function createProjectFolder(
  { parent, name, git = true }: { parent: string; name: string; git?: boolean },
  deps: { runGit?: typeof runGit } = {}
): Promise<ProjectSetupResult> {
  const problem = folderNameProblem(name);
  if (problem) throw new Error(PROBLEM_TEXT[problem]);
  const dir = await assertParent(parent);
  const target = nodePath.join(dir, name.trim());
  await assertFree(target);
  await fs.mkdir(target);
  if (!git) return { path: target, gitInitialized: false };
  try {
    await (deps.runGit ?? runGit)(['init'], target, 30_000);
    return { path: target, gitInitialized: true };
  } catch {
    // The folder is still a good project without git.
    return { path: target, gitInitialized: false };
  }
}

/** Clone `url` into `<parent>/<name>` (default: the repository's name). */
export async function cloneProjectRepo(
  { url, parent, name }: { url: string; parent: string; name?: string },
  deps: { runGit?: typeof runGit } = {}
): Promise<ProjectSetupResult> {
  const urlProblem = cloneUrlProblem(url);
  if (urlProblem) throw new Error(PROBLEM_TEXT[urlProblem]);
  const folder = (name?.trim() || repoNameFromUrl(url));
  const problem = folderNameProblem(folder);
  if (problem) throw new Error(PROBLEM_TEXT[problem]);
  const dir = await assertParent(parent);
  const target = nodePath.join(dir, folder);
  await assertFree(target);
  try {
    await (deps.runGit ?? runGit)(
      ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--', url.trim(), target],
      dir,
      CLONE_TIMEOUT_MS
    );
  } catch (error) {
    // A failed clone leaves a half-written folder; it was ours, so remove it.
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { path: target };
}
