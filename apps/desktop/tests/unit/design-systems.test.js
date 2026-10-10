import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanName, runDesignSystemRequest, scanFolderTokens } from '../../main/design/systems.ts';
import { ensureWorkspace, listFiles, workspaceRoot } from '../../main/design/workspace.ts';

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agente-systems-')));
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function host(name = 'h') {
  const root = path.join(sandbox, name);
  const changes = [];
  const picks = { next: null };
  return {
    changes,
    picks,
    host: {
      systemsRoot: path.join(root, 'design-systems'),
      designsRoot: path.join(root, 'designs'),
      changed: (chatId, paths) => changes.push({ chatId, paths }),
      pickFolder: async () => picks.next
    }
  };
}

function design(h, chatId, files) {
  const root = ensureWorkspace(workspaceRoot(h.designsRoot, chatId));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('cleanName trims, collapses spaces, caps length and refuses blanks', () => {
  assert.equal(cleanName('  Northwind   brand '), 'Northwind brand');
  assert.equal(cleanName('x'.repeat(80)).length, 60);
  assert.throws(() => cleanName('   '), /A name is required/);
  assert.throws(() => cleanName(undefined), /A name is required/);
});

test('scanFolderTokens prefers tokens.css, else generates :root from custom properties', () => {
  const folder = path.join(sandbox, 'app-a');
  fs.mkdirSync(path.join(folder, 'src', 'styles'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'node_modules', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'src', 'styles', 'base.css'), ':root { --brand: #3b5bdb; --tw-ring: 1px; }\n.x { color: var(--brand); }');
  fs.writeFileSync(path.join(folder, 'node_modules', 'lib', 'theme.css'), ':root { --ignored: red; }');
  fs.writeFileSync(path.join(folder, 'tailwind.config.js'), 'module.exports = { content: [], theme: { extend: { colors: { ink: "#111" } } } };');

  const generated = scanFolderTokens(folder);
  assert.match(generated.tokens, /--brand: #3b5bdb;/);
  assert.doesNotMatch(generated.tokens, /--tw-ring|--ignored/);
  assert.equal(generated.properties, 1);
  assert.match(generated.designMd, /Tailwind theme \(reference\)/);
  assert.match(generated.designMd, /theme: \{ extend/);

  fs.writeFileSync(path.join(folder, 'tokens.css'), ':root { --space: 8px; }');
  const verbatim = scanFolderTokens(folder);
  assert.equal(verbatim.tokens, ':root { --space: 8px; }');
});

test('scanFolderTokens refuses a folder with nothing design-shaped', () => {
  const folder = path.join(sandbox, 'empty-app');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'index.js'), 'console.log(1)');
  assert.throws(() => scanFolderTokens(folder), /No design tokens found/);
});

test('a system round-trips: save from a design, apply to another, link, brief, rename, delete', async () => {
  const h = host('round');
  design(h.host, 'chat-one', {
    'tokens.css': ':root { --bg: #f7f6f3; --accent: #3b5bdb; }',
    'DESIGN.md': '# Calm\n\nOne accent colour.',
    'index.html': '<!doctype html><p>page</p>',
    'assets/logo.svg': '<svg></svg>'
  });

  const saved = await runDesignSystemRequest({ action: 'create', chatId: 'chat-one', name: '  Calm   brand ', description: 'For the studio' }, h.host);
  assert.equal(saved.name, 'Calm brand');
  assert.equal(saved.origin, 'design');
  assert.equal(saved.hasTokens, true);
  assert.equal(saved.hasSpecimen, false);

  const listed = await runDesignSystemRequest({ action: 'list' }, h.host);
  assert.deepEqual(listed.map((item) => item.id), [saved.id]);

  const detail = await runDesignSystemRequest({ action: 'get', id: saved.id }, h.host);
  assert.deepEqual(Object.keys(detail.files.files).sort(), ['DESIGN.md', 'assets/logo.svg', 'tokens.css']);

  // The design the system came from has no link to it; applying one makes a fresh design use it.
  assert.equal(await runDesignSystemRequest({ action: 'current', chatId: 'chat-two' }, h.host), null);
  design(h.host, 'chat-two', { 'tokens.css': ':root { --bg: #000; }', 'index.html': '<p>old</p>' });
  const applied = await runDesignSystemRequest({ action: 'apply', chatId: 'chat-two', id: saved.id }, h.host);
  assert.ok(applied.before, 'the design is snapshotted before the system lands');
  assert.deepEqual(applied.paths.sort(), ['DESIGN.md', 'assets/logo.svg', 'tokens.css']);
  assert.equal(fs.readFileSync(path.join(h.host.designsRoot, 'chat-two', 'tokens.css'), 'utf8'), ':root { --bg: #f7f6f3; --accent: #3b5bdb; }');
  assert.equal(h.changes.at(-1).chatId, 'chat-two');

  // The link lives beside the workspace: the agent's listing never shows it.
  const workspace = path.join(h.host.designsRoot, 'chat-two');
  assert.ok(fs.existsSync(path.join(h.host.designsRoot, 'chat-two.system.json')));
  assert.ok(!listFiles(workspace).some((entry) => entry.path.includes('system')));

  assert.equal((await runDesignSystemRequest({ action: 'current', chatId: 'chat-two' }, h.host)).id, saved.id);
  const brief = await runDesignSystemRequest({ action: 'brief', chatId: 'chat-two' }, h.host);
  assert.equal(brief.name, 'Calm brand');
  assert.match(brief.designMd, /One accent colour/);

  await runDesignSystemRequest({ action: 'unlink', chatId: 'chat-two' }, h.host);
  assert.equal(await runDesignSystemRequest({ action: 'brief', chatId: 'chat-two' }, h.host), null);

  const renamed = await runDesignSystemRequest({ action: 'rename', id: saved.id, name: 'Calm 2' }, h.host);
  assert.equal(renamed.name, 'Calm 2');

  await runDesignSystemRequest({ action: 'delete', id: saved.id }, h.host);
  assert.deepEqual(await runDesignSystemRequest({ action: 'list' }, h.host), []);
});

test('create needs tokens or guidance, and ids are never paths', async () => {
  const h = host('guards');
  design(h.host, 'bare', { 'index.html': '<p>only a page</p>' });
  await assert.rejects(runDesignSystemRequest({ action: 'create', chatId: 'bare', name: 'Nope' }, h.host), /Nothing to save yet/);
  await assert.rejects(runDesignSystemRequest({ action: 'get', id: '../designs' }, h.host), /Unknown design system/);
  await assert.rejects(runDesignSystemRequest({ action: 'apply', chatId: '../x', id: 'anything' }, h.host), /Invalid design id/);
  await assert.rejects(runDesignSystemRequest({ action: 'nonsense' }, h.host), /Unknown design system action/);
});

test('import reads the picked folder and saves it as a system; cancel is a no-op', async () => {
  const h = host('import');
  const folder = path.join(sandbox, 'Brand Site');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'styles.css'), ':root { --ink: #111; }');

  h.picks.next = null;
  assert.equal(await runDesignSystemRequest({ action: 'import' }, h.host), null);

  h.picks.next = folder;
  const imported = await runDesignSystemRequest({ action: 'import' }, h.host);
  assert.equal(imported.name, 'Brand Site');
  assert.equal(imported.origin, 'folder');
  assert.equal(imported.hasTokens, true);
  const detail = await runDesignSystemRequest({ action: 'get', id: imported.id }, h.host);
  assert.match(detail.files.files['tokens.css'], /--ink: #111;/);
});
