import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { CheckpointStore } from '../../main/agente/tools/checkpoint.ts';

function setup() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'agente-restore-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const store = new CheckpointStore(path.join(root, 'checkpoints'));
  const file = (rel) => path.join(project, rel);
  return { root, project, store, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('CheckpointStore.restoreTo', () => {
  it('undoes the chosen turn and every later one, then forgets them', async () => {
    const { project, store, file, cleanup } = setup();
    try {
      fs.writeFileSync(file('a.txt'), 'v0');
      // Turn 1 edits a.txt.
      await store.capture(file('a.txt'), project, 1);
      fs.writeFileSync(file('a.txt'), 'v1');
      await store.finalizeTurn(project, 1);
      // Turn 2 edits a.txt again and creates b.txt.
      await store.capture(file('a.txt'), project, 2);
      await store.capture(file('b.txt'), project, 2);
      fs.writeFileSync(file('a.txt'), 'v2');
      fs.writeFileSync(file('b.txt'), 'new');
      await store.finalizeTurn(project, 2);
      // Turn 3 only touches c.txt.
      fs.writeFileSync(file('c.txt'), 'c0');
      await store.capture(file('c.txt'), project, 3);
      fs.writeFileSync(file('c.txt'), 'c3');
      await store.finalizeTurn(project, 3);

      const restored = await store.restoreTo(project, 2);

      assert.deepStrictEqual(restored, ['a.txt', 'b.txt', 'c.txt']);
      assert.strictEqual(fs.readFileSync(file('a.txt'), 'utf8'), 'v1');
      assert.strictEqual(fs.existsSync(file('b.txt')), false);
      assert.strictEqual(fs.readFileSync(file('c.txt'), 'utf8'), 'c0');
      assert.deepStrictEqual((await store.listTurns()).map((turn) => turn.turnIndex), [1]);
    } finally {
      cleanup();
    }
  });

  it('lists the files each turn changed', async () => {
    const { project, store, file, cleanup } = setup();
    try {
      fs.writeFileSync(file('a.txt'), 'x');
      await store.capture(file('a.txt'), project, 1);
      fs.writeFileSync(file('a.txt'), 'y');
      await store.finalizeTurn(project, 1);
      const [turn] = await store.listTurns();
      assert.deepStrictEqual(turn.files, ['a.txt']);
    } finally {
      cleanup();
    }
  });
});
