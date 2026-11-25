import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cloneProjectRepo, createProjectFolder, expandHome } from '../../main/project-setup.ts';
import { cloneUrlProblem, folderNameProblem, repoNameFromUrl } from '../../shared/project-setup.ts';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agente-project-setup-'));
}

test('folder names follow the rules every platform shares', () => {
  assert.equal(folderNameProblem('my-app'), null);
  assert.equal(folderNameProblem('  '), 'empty');
  assert.equal(folderNameProblem('..'), 'dots');
  assert.equal(folderNameProblem('a/b'), 'characters');
  assert.equal(folderNameProblem('a\\b'), 'characters');
  assert.equal(folderNameProblem('what?'), 'characters');
  assert.equal(folderNameProblem('trailing.'), 'trailing');
  assert.equal(folderNameProblem('CON'), 'reserved');
  assert.equal(folderNameProblem('nul.txt'), 'reserved');
  assert.equal(folderNameProblem('x'.repeat(256)), 'tooLong');
});

test('only network clone URLs are accepted', () => {
  for (const ok of ['https://github.com/owner/repo.git', 'http://host/x', 'ssh://git@host/owner/repo', 'git://host/repo', 'git@github.com:owner/repo.git']) {
    assert.equal(cloneUrlProblem(ok), null, ok);
  }
  for (const bad of ['', '--upload-pack=touch /tmp/x', 'ext::sh -c touch% /tmp/pwned', 'file:///etc', '/home/me/repo', 'C:\\repo', 'https://', 'git@host:x::y']) {
    assert.notEqual(cloneUrlProblem(bad), null, bad);
  }
});

test('a clone lands in a folder named after its repository', () => {
  assert.equal(repoNameFromUrl('https://github.com/owner/repo.git'), 'repo');
  assert.equal(repoNameFromUrl('git@github.com:owner/my-lib.git/'), 'my-lib');
  assert.equal(repoNameFromUrl('https://host/group/sub/project'), 'project');
});

test('~ expands to the home folder', () => {
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('~/code', '/h'), path.join('/h', 'code'));
});

test('a new folder is created and git-initialised, never over an existing one', async () => {
  const parent = await tempDir();
  const calls = [];
  const runGit = async (args, cwd) => { calls.push({ args, cwd }); };
  const made = await createProjectFolder({ parent, name: 'fresh' }, { runGit });
  assert.equal(made.path, path.join(parent, 'fresh'));
  assert.equal(made.gitInitialized, true);
  assert.ok((await fs.stat(made.path)).isDirectory());
  assert.deepEqual(calls, [{ args: ['init'], cwd: made.path }]);

  await assert.rejects(createProjectFolder({ parent, name: 'fresh' }, { runGit }), /already exists/);
  await assert.rejects(createProjectFolder({ parent, name: 'a/b' }, { runGit }), /cannot contain/);
  await assert.rejects(createProjectFolder({ parent: path.join(parent, 'nope'), name: 'x' }, { runGit }), /does not exist/);

  // Without git (or when git fails) the folder is still made.
  const plain = await createProjectFolder({ parent, name: 'plain', git: false }, { runGit });
  assert.equal(plain.gitInitialized, false);
  const noGit = await createProjectFolder({ parent, name: 'nogit' }, { runGit: async () => { throw new Error('Git is not installed'); } });
  assert.equal(noGit.gitInitialized, false);
  assert.ok((await fs.stat(noGit.path)).isDirectory());
  await fs.rm(parent, { recursive: true, force: true });
});

test('a clone passes the URL after -- with local transports off, and cleans up on failure', async () => {
  const parent = await tempDir();
  const calls = [];
  const made = await cloneProjectRepo(
    { url: 'https://github.com/owner/repo.git', parent },
    { runGit: async (args, cwd) => { calls.push({ args, cwd }); await fs.mkdir(args.at(-1)); } }
  );
  assert.equal(made.path, path.join(parent, 'repo'));
  assert.deepEqual(calls[0].args, ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--', 'https://github.com/owner/repo.git', made.path]);

  await assert.rejects(cloneProjectRepo({ url: 'https://github.com/owner/repo.git', parent }, { runGit: async () => {} }), /already exists/);
  await assert.rejects(cloneProjectRepo({ url: 'ext::sh', parent }, { runGit: async () => {} }), /https:\/\//);

  const failed = path.join(parent, 'broken');
  await assert.rejects(cloneProjectRepo(
    { url: 'https://host/x/broken', parent },
    { runGit: async (args) => { await fs.mkdir(args.at(-1)); throw new Error('Repository not found.'); } }
  ), /Repository not found/);
  assert.equal(await fs.stat(failed).then(() => true, () => false), false, 'half-written clone removed');
  await fs.rm(parent, { recursive: true, force: true });
});
