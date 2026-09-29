import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkFiles, listProjectFiles } from '../../main/agente/project-files.ts';

test('walkFiles lists files and skips dependency and build folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-files-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/app.ts'), '');
  fs.writeFileSync(path.join(root, 'README.md'), '');
  fs.writeFileSync(path.join(root, 'node_modules/x/index.js'), '');
  assert.deepEqual(walkFiles(root), ['README.md', 'src/app.ts']);
  assert.equal(walkFiles(root, 1).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('listProjectFiles is empty for a missing folder', async () => {
  assert.deepEqual(await listProjectFiles('/nonexistent/agente/project'), []);
});
