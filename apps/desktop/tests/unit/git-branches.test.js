import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { branchState, parseRefs, parseTrack, switchBranch } from '../../main/agente/git-branches.ts';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agente-branches-'));
}

/** A repository with one commit on `main` and a second branch `other`. */
function repoWithTwoBranches() {
  const root = tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('branch', '-M', 'main');
  git('switch', '-c', 'other', '-q');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  git('commit', '-qam', 'other');
  git('switch', 'main', '-q');
  return { root, git };
}

describe('track parsing', () => {
  it('reads ahead, behind, gone and empty track strings', () => {
    assert.deepEqual(parseTrack('[ahead 1, behind 2]'), { ahead: 1, behind: 2 });
    assert.deepEqual(parseTrack('[ahead 3]'), { ahead: 3, behind: 0 });
    assert.deepEqual(parseTrack('[behind 4]'), { ahead: 0, behind: 4 });
    assert.deepEqual(parseTrack('[gone]'), { ahead: 0, behind: 0 });
    assert.deepEqual(parseTrack(''), { ahead: 0, behind: 0 });
  });

  it('reads for-each-ref lines, marking the current branch', () => {
    const raw = ['main\ta1b2c3d\torigin/main\t[ahead 1, behind 2]\t*', 'feat/x\te4f5a6b\t\t\t ', ''].join('\n');
    assert.deepEqual(parseRefs(raw), [
      { name: 'main', commit: 'a1b2c3d', current: true, upstream: 'origin/main', ahead: 1, behind: 2 },
      { name: 'feat/x', commit: 'e4f5a6b', current: false, ahead: 0, behind: 0 }
    ]);
  });
});

describe('branches in a git repository', () => {
  it('reports the current branch, the list and the dirty flag', async () => {
    const { root } = repoWithTwoBranches();
    const state = await branchState(root);
    assert.equal(state.source, 'git');
    assert.equal(state.current, 'main');
    assert.equal(state.detached, false);
    assert.equal(state.dirty, false);
    assert.deepEqual(state.branches.map((branch) => branch.name), ['main', 'other']);
    assert.equal(state.branches[0].current, true);

    // Untracked files do not block a switch, so they do not count as dirty.
    fs.writeFileSync(path.join(root, 'notes.md'), 'x\n');
    assert.equal((await branchState(root)).dirty, false);
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    assert.equal((await branchState(root)).dirty, true);
  });

  it('switches branches and creates a new one', async () => {
    const { root, git } = repoWithTwoBranches();
    const switched = await switchBranch(root, 'other');
    assert.deepEqual(switched, { ok: true, branch: 'other' });
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two\n');
    assert.equal((await branchState(root)).current, 'other');

    const created = await switchBranch(root, 'feat/new', true);
    assert.deepEqual(created, { ok: true, branch: 'feat/new' });
    assert.equal((await branchState(root)).current, 'feat/new');
    assert.ok(git('branch', '--list').toString().includes('feat/new'));
  });

  it('refuses an unknown branch, an invalid new name and a conflicting switch', async () => {
    const { root } = repoWithTwoBranches();
    assert.deepEqual(await switchBranch(root, 'nope'), { ok: false, error: 'No local branch named "nope".' });
    assert.equal((await switchBranch(root, 'bad name', true)).ok, false);
    assert.equal((await switchBranch(root, ''))?.ok, false);

    // A tracked file that differs between the branches blocks the checkout.
    // The message is git's, in whatever language it is configured with, so the
    // test only asserts the failure and that nothing moved.
    fs.writeFileSync(path.join(root, 'a.txt'), 'working copy\n');
    const blocked = await switchBranch(root, 'other');
    assert.equal(blocked.ok, false);
    assert.ok((blocked.error ?? '').length > 0);
    assert.equal((await branchState(root)).current, 'main');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'working copy\n');
  });

  it('reads a detached HEAD as a commit, not a branch', async () => {
    const { root, git } = repoWithTwoBranches();
    git('checkout', '--detach', '-q', 'HEAD');
    const state = await branchState(root);
    assert.equal(state.detached, true);
    assert.match(state.current ?? '', /^[0-9a-f]{7,}$/);
    assert.ok(state.branches.every((branch) => !branch.current));
  });
});

describe('branches of a project inside a bigger repository', () => {
  it('uses the project folder as the working directory', async () => {
    const repo = tempDir();
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
  git('config', 'core.autocrlf', 'false');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    const root = path.join(repo, 'apps', 'web');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('branch', '-M', 'main');
    git('branch', 'from-subfolder');

    const state = await branchState(root);
    assert.equal(state.current, 'main');
    assert.deepEqual(state.branches.map((branch) => branch.name), ['from-subfolder', 'main']);
    assert.deepEqual(await switchBranch(root, 'from-subfolder'), { ok: true, branch: 'from-subfolder' });
    assert.equal((await branchState(root)).current, 'from-subfolder');
  });
});

describe('branches outside git', () => {
  it('reports nothing to switch', async () => {
    const root = tempDir();
    assert.deepEqual(await branchState(root), { source: 'none', current: null, detached: false, dirty: false, branches: [] });
    const result = await switchBranch(root, 'main');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not a git repository/i);
  });
});
