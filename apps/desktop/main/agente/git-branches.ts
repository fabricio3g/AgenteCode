// ── The branches of a project's repository ─────────────────────────────
// The branch chip in the pane strip reads this, and switching a branch goes
// through the same helper the Changes pane uses: `git` in the project folder,
// so a project nested inside a bigger repository still only acts on its own
// checkout and never on the repository root.
//
// Switching is an action: failures (a dirty worktree that would be overwritten)
// come back as `{ ok: false, error }` with git's own message, which is more
// useful to the user than anything this module could invent.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitBranch, GitBranches, SwitchBranchResult } from '../../shared/code-workspace.ts';
import { isGitRepo } from './changes.ts';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  return stdout;
}

/**
 * One tab-separated field per branch. A ref name cannot contain a tab, so the
 * format needs no escaping.
 */
const REF_FORMAT = '%(refname:short)\t%(objectname:short)\t%(upstream:short)\t%(upstream:track)\t%(HEAD)';

/** `[ahead 1, behind 2]` / `[gone]` / empty, as `%(upstream:track)` prints it. */
export function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** Parse the `for-each-ref` output. Exported for tests. */
export function parseRefs(raw: string): GitBranch[] {
  const out: GitBranch[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [name, commit, upstream, track, head] = line.split('\t');
    if (!name) continue;
    const { ahead, behind } = parseTrack(track ?? '');
    out.push({
      name,
      commit: commit ?? '',
      current: (head ?? '').trim() === '*',
      ...(upstream ? { upstream } : {}),
      ahead,
      behind
    });
  }
  return out;
}

/** Local branches, oldest tip last: `--sort=refname` keeps the menu stable. */
async function listBranches(projectRoot: string): Promise<GitBranch[]> {
  const raw = await git(projectRoot, ['for-each-ref', `--format=${REF_FORMAT}`, '--sort=refname', 'refs/heads']);
  return parseRefs(raw);
}

export async function branchState(projectRoot: string): Promise<GitBranches> {
  const empty: GitBranches = { source: 'none', current: null, detached: false, dirty: false, branches: [] };
  if (!projectRoot || !(await isGitRepo(projectRoot))) return empty;

  const [branches, head, dirty] = await Promise.all([
    listBranches(projectRoot).catch(() => [] as GitBranch[]),
    git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).then((out) => out.trim()).catch(() => ''),
    // Untracked files do not block a switch, so they do not count as dirty.
    git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).then((out) => out.length > 0).catch(() => false)
  ]);

  if (head && head !== 'HEAD') return { source: 'git', current: head, detached: false, dirty, branches };

  // Detached: the chip shows the commit it sits on.
  const sha = await git(projectRoot, ['rev-parse', '--short', 'HEAD']).then((out) => out.trim()).catch(() => '');
  return { source: 'git', current: sha || null, detached: true, dirty, branches };
}

/** `git switch`, with `-c` when the branch does not exist yet. */
export async function switchBranch(projectRoot: string, name: string, create = false): Promise<SwitchBranchResult> {
  const branch = name.trim();
  if (!branch) return { ok: false, error: 'Enter a branch name.' };
  if (!projectRoot || !(await isGitRepo(projectRoot))) return { ok: false, error: 'This project is not a git repository.' };
  if (branch.startsWith('-')) return { ok: false, error: `"${branch}" is not a valid branch name.` };

  if (create) {
    // git owns ref-name validation; asking it keeps the rules in one place.
    const valid = await git(projectRoot, ['check-ref-format', '--branch', branch]).then(() => true, () => false);
    if (!valid) return { ok: false, error: `"${branch}" is not a valid branch name.` };
  } else {
    const known = (await listBranches(projectRoot).catch(() => [] as GitBranch[])).some((item) => item.name === branch);
    if (!known) return { ok: false, error: `No local branch named "${branch}".` };
  }

  try {
    await git(projectRoot, create ? ['switch', '-c', branch] : ['switch', branch]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return { ok: false, error: stderr || (error as Error).message };
  }
  return { ok: true, branch };
}
