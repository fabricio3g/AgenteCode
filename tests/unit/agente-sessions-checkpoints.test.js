import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { SessionTree, projectSlug } from '../../main/agente/sessions/session-tree.ts';
import { CheckpointStore } from '../../main/agente/tools/checkpoint.ts';
import { createBuiltinTools } from '../../main/agente/tools/builtins.ts';

function tempProject() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'agente-proj-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('agente session tree', () => {
  it('round-trips entries through the JSONL file and rebuilds context', async () => {
    const { root, cleanup } = tempProject();
    const sessionsDir = path.join(root, '.sessions');
    try {
      const tree = SessionTree.create(root, sessionsDir, 'sess-1');
      tree.append('user', { content: 'hello' });
      tree.append('assistant', { content: 'hi', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }], stopReason: 'toolUse' });
      tree.append('tool_result', { toolCallId: 'c1', toolName: 'read', content: 'file body', isError: false });
      tree.append('assistant', { content: 'done', stopReason: 'stop' });

      const reopened = await SessionTree.open(tree.filePath);
      assert.strictEqual(reopened.header.id, 'sess-1');
      assert.strictEqual(reopened.listEntries().length, 4);
      assert.strictEqual(reopened.listEntries().at(-1).parentId, reopened.listEntries()[2].id);

      const context = reopened.buildContext();
      assert.strictEqual(context.length, 4);
      assert.strictEqual(context[0].content, 'hello');
      assert.strictEqual(context[1].toolCalls[0].name, 'read');
      assert.strictEqual(context[2].role, 'tool');
    } finally {
      cleanup();
    }
  });

  it('rebuilds context from the compaction summary plus post-compaction entries', async () => {
    const { root, cleanup } = tempProject();
    const sessionsDir = path.join(root, '.sessions');
    try {
      const tree = SessionTree.create(root, sessionsDir, 'sess-2');
      tree.append('user', { content: 'old question' });
      tree.append('assistant', { content: 'old answer', stopReason: 'stop' });
      tree.append('compaction', { summary: 'We set up the project.' });
      tree.append('user', { content: 'new question' });

      const reopened = await SessionTree.open(tree.filePath);
      const context = reopened.buildContext();
      assert.strictEqual(context.length, 2);
      assert.match(context[0].content, /conversation summary/);
      assert.match(context[0].content, /We set up the project\./);
      assert.strictEqual(context[1].content, 'new question');
    } finally {
      cleanup();
    }
  });

  it('ignores torn tail writes when reopening', async () => {
    const { root, cleanup } = tempProject();
    const sessionsDir = path.join(root, '.sessions');
    try {
      const tree = SessionTree.create(root, sessionsDir, 'sess-3');
      tree.append('user', { content: 'q' });
      fs.appendFileSync(tree.filePath, '{"type":"entry","id":"tor');
      const reopened = await SessionTree.open(tree.filePath);
      assert.strictEqual(reopened.listEntries().length, 1);
    } finally {
      cleanup();
    }
  });

  it('derives a stable, filesystem-safe project slug', () => {
    const slugA = projectSlug('/home/user/My Project!');
    const slugB = projectSlug('/home/user/My Project!');
    const slugC = projectSlashGuard('/other');
    assert.strictEqual(slugA, slugB);
    assert.notStrictEqual(slugA, slugC);
    assert.match(slugA, /^My-Project-/);
    function projectSlashGuard(p) {
      const slug = projectSlug(p);
      assert.ok(!slug.includes('/'));
      return slug;
    }
  });
});

describe('agente checkpoints', () => {
  it('captures, diffs, and restores a turn', async () => {
    const { root, cleanup } = tempProject();
    const checkpointRoot = path.join(root, '.checkpoints');
    try {
      const file = path.join(root, 'src', 'app.ts');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, 'line1\nline2\nline3\n');

      const store = new CheckpointStore(checkpointRoot);
      await store.capture(file, root, 1);
      await fsp.writeFile(file, 'line1\nCHANGED\nline3\nline4\n');

      const stats = await store.finalizeTurn(root, 1);
      assert.strictEqual(stats.length, 1);
      assert.strictEqual(stats[0].kind, 'modified');
      assert.strictEqual(stats[0].additions, 2);
      assert.strictEqual(stats[0].deletions, 1);

      const restored = await store.restore(root, 1);
      assert.strictEqual(restored, 1);
      assert.strictEqual(await fsp.readFile(file, 'utf8'), 'line1\nline2\nline3\n');

      const summaries = await store.listTurns();
      assert.strictEqual(summaries.length, 1);
      assert.strictEqual(summaries[0].turnIndex, 1);
    } finally {
      cleanup();
    }
  });

  it('records file creation so rollback deletes the file', async () => {
    const { root, cleanup } = tempProject();
    const checkpointRoot = path.join(root, '.checkpoints');
    try {
      const store = new CheckpointStore(checkpointRoot);
      const file = path.join(root, 'new-file.ts');
      await store.capture(file, root, 1); // file does not exist yet
      await fsp.writeFile(file, 'brand new\n');
      const stats = await store.finalizeTurn(root, 1);
      assert.strictEqual(stats[0].kind, 'created');

      await store.restore(root, 1);
      await assert.rejects(fsp.stat(file));
    } finally {
      cleanup();
    }
  });
});

describe('agente builtin tools', () => {
  it('read → write → edit → read round-trip with line numbers', async () => {
    const { root, cleanup } = tempProject();
    try {
      const tools = new Map(createBuiltinTools(root).map((t) => [t.name, t]));
      const ctx = { signal: new AbortController().signal };

      const write = await tools.get('write').execute('c1', { path: 'notes/a.txt', content: 'alpha\nbeta\n' }, ctx);
      assert.ok(!write.isError, write.content);

      const read = await tools.get('read').execute('c2', { path: 'notes/a.txt' }, ctx);
      assert.match(read.content, /1\s+alpha/);

      const edit = await tools.get('edit').execute('c3', { path: 'notes/a.txt', oldText: 'beta', newText: 'gamma' }, ctx);
      assert.ok(!edit.isError, edit.content);

      const after = await tools.get('read').execute('c4', { path: 'notes/a.txt' }, ctx);
      assert.match(after.content, /gamma/);
    } finally {
      cleanup();
    }
  });

  it('edit refuses ambiguous matches and reports the count', async () => {
    const { root, cleanup } = tempProject();
    try {
      const tools = new Map(createBuiltinTools(root).map((t) => [t.name, t]));
      const ctx = { signal: new AbortController().signal };
      await tools.get('write').execute('c1', { path: 'dup.txt', content: 'x\nx\n' }, ctx);
      const ambiguous = await tools.get('edit').execute('c2', { path: 'dup.txt', oldText: 'x', newText: 'y' }, ctx);
      assert.ok(ambiguous.isError);
      assert.match(ambiguous.content, /2 times/);

      const all = await tools.get('edit').execute('c3', { path: 'dup.txt', oldText: 'x', newText: 'y', replaceAll: true }, ctx);
      assert.ok(!all.isError, all.content);
    } finally {
      cleanup();
    }
  });

  it('bash reports non-zero exits as errors with output', async () => {
    const { root, cleanup } = tempProject();
    try {
      const tools = new Map(createBuiltinTools(root).map((t) => [t.name, t]));
      const ctx = { signal: new AbortController().signal };
      const okRun = await tools.get('bash').execute('c1', { command: 'echo agente-ok' }, ctx);
      assert.ok(!okRun.isError, okRun.content);
      assert.match(okRun.content, /agente-ok/);

      const fail = await tools.get('bash').execute('c2', { command: 'exit 3' }, ctx);
      assert.ok(fail.isError);
      assert.match(fail.content, /exit 3/);
    } finally {
      cleanup();
    }
  });

  it('grep finds matches with line numbers and skips nothing user-visible', async () => {
    const { root, cleanup } = tempProject();
    try {
      const tools = new Map(createBuiltinTools(root).map((t) => [t.name, t]));
      const ctx = { signal: new AbortController().signal };
      await tools.get('write').execute('c1', { path: 'one.ts', content: 'const a = 1;\nconst b = 2;\n' }, ctx);
      await tools.get('write').execute('c2', { path: 'two.ts', content: 'const a = 3;\n' }, ctx);

      const found = await tools.get('grep').execute('c3', { pattern: 'const a', include: '*.ts' }, ctx);
      assert.ok(!found.isError, found.content);
      assert.match(found.content, /one\.ts:1:/);
      assert.match(found.content, /two\.ts:1:/);

      const none = await tools.get('grep').execute('c4', { pattern: 'zzzz' }, ctx);
      assert.strictEqual(none.content, 'No matches.');
    } finally {
      cleanup();
    }
  });

  it('ls lists directories and hides vendored entries by default', async () => {
    const { root, cleanup } = tempProject();
    try {
      const tools = new Map(createBuiltinTools(root).map((t) => [t.name, t]));
      const ctx = { signal: new AbortController().signal };
      await fsp.mkdir(path.join(root, 'node_modules'), { recursive: true });
      await fsp.mkdir(path.join(root, 'src'), { recursive: true });
      await fsp.writeFile(path.join(root, 'src', 'i.ts'), 'x');

      const listing = await tools.get('ls').execute('c1', {}, ctx);
      assert.ok(!listing.isError, listing.content);
      assert.match(listing.content, /src\//);
      assert.doesNotMatch(listing.content, /node_modules/);
    } finally {
      cleanup();
    }
  });
});
