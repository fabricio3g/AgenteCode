import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { deleteSessionFiles } from '../../main/agente/sessions/session-data.ts';

function tempDirs() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'agente-data-'));
  const dirs = { sessionsDir: path.join(root, 'sessions'), checkpointsDir: path.join(root, 'checkpoints') };
  const write = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  };
  return { root, dirs, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('deleteSessionFiles', () => {
  it('removes only the requested sessions and their checkpoints', async () => {
    const { root, dirs, write, cleanup } = tempDirs();
    try {
      const project = path.join(root, 'project');
      write(path.join(project, 'src', 'index.ts'));
      write(path.join(dirs.sessionsDir, 'demo-1', '1700-agente-1-aaaa.jsonl'));
      write(path.join(dirs.sessionsDir, 'demo-1', '1800-agente-2-bbbb.jsonl'));
      write(path.join(dirs.checkpointsDir, 'agente-1-aaaa', '1', 'before', 'src', 'index.ts'));
      write(path.join(dirs.checkpointsDir, 'agente-2-bbbb', '1', 'before', 'a.ts'));

      const removed = await deleteSessionFiles(dirs, ['agente-1-aaaa']);

      assert.strictEqual(removed, 1);
      assert.deepStrictEqual(fs.readdirSync(path.join(dirs.sessionsDir, 'demo-1')), ['1800-agente-2-bbbb.jsonl']);
      assert.deepStrictEqual(fs.readdirSync(dirs.checkpointsDir), ['agente-2-bbbb']);
      // The project folder is never touched.
      assert.ok(fs.existsSync(path.join(project, 'src', 'index.ts')));
    } finally {
      cleanup();
    }
  });

  it('drops an emptied project folder and refuses path-like ids', async () => {
    const { dirs, write, cleanup } = tempDirs();
    try {
      write(path.join(dirs.sessionsDir, 'demo-1', '1700-agente-1-aaaa.jsonl'));
      write(path.join(dirs.checkpointsDir, 'keep', 'x'));

      assert.strictEqual(await deleteSessionFiles(dirs, ['../checkpoints/keep', '..']), 0);
      assert.ok(fs.existsSync(path.join(dirs.checkpointsDir, 'keep', 'x')));

      await deleteSessionFiles(dirs, ['agente-1-aaaa']);
      assert.deepStrictEqual(fs.readdirSync(dirs.sessionsDir), []);
    } finally {
      cleanup();
    }
  });
});
