import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { fileDiff, listChanges, parsePorcelain, revertFile } from '../../main/agente/changes.ts';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agente-changes-'));
}

describe('parsePorcelain', () => {
  it('reads added, modified, deleted, untracked and renamed entries', () => {
    const raw = [' M src/a.ts', 'A  new.ts', ' D gone.ts', '?? notes.md', 'R  b.ts', 'old-b.ts', ''].join('\0');
    assert.deepEqual(parsePorcelain(raw), [
      { path: 'src/a.ts', kind: 'modified' },
      { path: 'new.ts', kind: 'created' },
      { path: 'gone.ts', kind: 'deleted' },
      { path: 'notes.md', kind: 'created' },
      { path: 'b.ts', kind: 'renamed' }
    ]);
  });
});

describe('changes in a git repository', () => {
  it('lists, diffs and reverts against HEAD', async () => {
    const root = tempDir();
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\nthree\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'new\n');

    const list = await listChanges(root);
    assert.equal(list.source, 'git');
    assert.deepEqual(list.files, [
      { path: 'a.txt', kind: 'modified', additions: 2, deletions: 1 },
      { path: 'b.txt', kind: 'created', additions: 1, deletions: 0 }
    ]);
    const diff = await fileDiff(root, 'a.txt');
    assert.equal(diff.before, 'one\ntwo\n');
    assert.equal(diff.after, 'one\nTWO\nthree\n');

    await revertFile(root, 'a.txt');
    await revertFile(root, 'b.txt');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
    assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
    assert.deepEqual((await listChanges(root)).files, []);
  });
});

describe('a project inside a bigger repository', () => {
  it('lists, diffs and reverts with paths from the project folder', async () => {
    const repo = tempDir();
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    const root = path.join(repo, 'apps', 'web');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(root, 'new.txt'), 'n\n');
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'changed\n');

    assert.deepEqual((await listChanges(root)).files, [
      { path: 'a.txt', kind: 'modified', additions: 1, deletions: 0 },
      { path: 'new.txt', kind: 'created', additions: 1, deletions: 0 }
    ]);
    const diff = await fileDiff(root, 'a.txt');
    assert.equal(diff.before, 'one\n');
    assert.equal(diff.after, 'one\ntwo\n');
    await revertFile(root, 'a.txt');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  });
});

describe('changes outside git', () => {
  it('has nothing to compare against', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.txt'), 'text\n');
    assert.deepEqual(await listChanges(root), { source: 'none', files: [] });
    await assert.rejects(() => revertFile(root, 'a.txt'), /No earlier version/);
  });

  it('refuses paths outside the project', async () => {
    await assert.rejects(() => fileDiff(tempDir(), '../../etc/passwd'), /escapes the project root/);
  });
});
