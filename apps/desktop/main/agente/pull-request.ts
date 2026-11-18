// ── The current branch as a pull request ───────────────────────────────
// The session column reads this: which base the branch would merge into, how
// many commits it carries past it, where to open a PR on the web, and — when
// the GitHub CLI is installed and signed in — the PR that already exists for
// the branch, with its checks rolled up into one state.
//
// Everything is read-only and every step degrades on its own: no remote means
// no compare link, no `gh` (or no PR) means `pr: null`, and none of it throws.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PullRequestChecks, PullRequestState } from '../../shared/code-workspace.ts';
import { isGitRepo } from './changes.ts';

const run = promisify(execFile);

async function exec(cmd: string, cwd: string, args: string[], timeout = 8000): Promise<string> {
  const { stdout } = await run(cmd, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}
const git = (cwd: string, args: string[]) => exec('git', cwd, args);

/** `git@github.com:o/r.git`, `https://github.com/o/r.git` → `https://github.com/o/r`. Exported for tests. */
export function webUrl(remote: string): string | null {
  const value = remote.trim();
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(value);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const http = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(value);
  return http ? `https://${http[1]}/${http[2]}` : null;
}

/** One state for a PR's checks, from `gh`'s `statusCheckRollup`. Exported for tests. */
export function rollupChecks(rollup: unknown): PullRequestChecks {
  if (!Array.isArray(rollup) || !rollup.length) return 'none';
  let pending = false;
  for (const item of rollup as Array<Record<string, unknown>>) {
    const status = String(item.status ?? item.state ?? '').toUpperCase();
    const conclusion = String(item.conclusion ?? item.state ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) return 'fail';
    if ((status && status !== 'COMPLETED' && status !== 'SUCCESS') || conclusion === 'PENDING' || conclusion === 'EXPECTED') pending = true;
  }
  return pending ? 'pending' : 'pass';
}

/** The branch a PR would target: the remote's HEAD, else `main` or `master` when the remote has one. */
async function baseBranch(cwd: string): Promise<string | null> {
  const head = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  if (head.startsWith('origin/')) return head.slice('origin/'.length);
  for (const name of ['main', 'master']) {
    const found = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]).catch(() => '');
    if (found) return name;
  }
  return null;
}

async function existingPr(cwd: string): Promise<PullRequestState['pr']> {
  try {
    const raw = await exec('gh', cwd, ['pr', 'view', '--json', 'number,title,url,state,isDraft,statusCheckRollup'], 10000);
    const data = JSON.parse(raw) as { number: number; title: string; url: string; state: string; isDraft: boolean; statusCheckRollup?: unknown };
    const state = data.state === 'MERGED' || data.state === 'CLOSED' ? data.state : 'OPEN';
    return { number: data.number, title: data.title, url: data.url, state, draft: !!data.isDraft, checks: rollupChecks(data.statusCheckRollup) };
  } catch {
    // No gh, not signed in, or no PR for this branch.
    return null;
  }
}

export async function pullRequestState(projectRoot: string): Promise<PullRequestState> {
  const empty: PullRequestState = { source: 'none', branch: null, base: null, ahead: 0, compareUrl: null, pr: null };
  if (!projectRoot || !(await isGitRepo(projectRoot))) return empty;
  const branch = await git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
  if (!branch || branch === 'HEAD') return { ...empty, source: 'git' };

  const [base, remote, pr] = await Promise.all([
    baseBranch(projectRoot),
    git(projectRoot, ['remote', 'get-url', 'origin']).catch(() => ''),
    existingPr(projectRoot)
  ]);
  const ahead = base && base !== branch
    ? Number(await git(projectRoot, ['rev-list', '--count', `refs/remotes/origin/${base}..HEAD`]).catch(() => '0')) || 0
    : 0;
  const web = remote ? webUrl(remote) : null;
  const compareUrl = web && base && base !== branch && /github\.com\//.test(web)
    ? `${web}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`
    : null;
  return { source: 'git', branch, base, ahead, compareUrl, pr };
}
