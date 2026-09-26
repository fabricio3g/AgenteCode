import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateDataFolder, mapDataPath, DATA_FOLDER_NAME } from '../../main/data-folder.ts';

function tree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

test('moves an old Chatea folder into Flaxeo Chat with the new layout and paths', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'flx-'));
  const old = path.join(appData, 'Chatea');
  const root = path.join(appData, DATA_FOLDER_NAME);
  const llama = path.join(old, 'bin', 'versions', 'b1-vulkan', 'llama-server');
  const model = path.join(old, 'models', 'llama-cpp', 'test', 'm.gguf');
  tree(old, {
    'bin/versions/b1-vulkan/llama-server': 'x',
    'bin/whisper/versions/b2-x64/whisper-cli': 'x',
    'models/llama-cpp/test/m.gguf': 'x',
    'cache/chat-history.db': 'db',
    'config.json': JSON.stringify({ llm: { local: { models_dir: path.join(old, 'models', 'llama-cpp'), runtime_path: llama, model_path: model } }, stt: { runtime_path: path.join(old, 'bin', 'whisper', 'versions', 'b2-x64', 'whisper-cli') }, name: 'keep me' })
  });

  const moves = migrateDataFolder(appData, appData);
  assert.ok(moves.length > 0);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(root, 'engines', 'llama.cpp', 'b1-vulkan', 'llama-server')));
  assert.ok(fs.existsSync(path.join(root, 'engines', 'whisper.cpp', 'b2-x64', 'whisper-cli')));
  assert.ok(fs.existsSync(path.join(root, 'models', 'chat', 'test', 'm.gguf')));
  assert.ok(fs.existsSync(path.join(root, 'cache', 'chat-history.db')));
  assert.equal(fs.existsSync(path.join(root, 'bin')), false);

  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(cfg.llm.local.models_dir, path.join(root, 'models', 'chat'));
  assert.equal(cfg.llm.local.runtime_path, path.join(root, 'engines', 'llama.cpp', 'b1-vulkan', 'llama-server'));
  assert.equal(cfg.llm.local.model_path, path.join(root, 'models', 'chat', 'test', 'm.gguf'));
  assert.equal(cfg.stt.runtime_path, path.join(root, 'engines', 'whisper.cpp', 'b2-x64', 'whisper-cli'));
  assert.equal(cfg.name, 'keep me');

  // A second start changes nothing.
  assert.deepEqual(migrateDataFolder(appData, appData), []);
});

test('leaves unrelated paths alone', () => {
  const root = '/data/Flaxeo Chat';
  assert.equal(mapDataPath('/home/me/models/x.gguf', ['/old/Chatea'], root), '/home/me/models/x.gguf');
  assert.equal(mapDataPath('/old/Chatea/cache/a.db', ['/old/Chatea'], root), '/data/Flaxeo Chat/cache/a.db');
});
