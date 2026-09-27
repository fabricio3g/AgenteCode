import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keyringAppName, migrateBrowserProfile, migrateDataFolder, mapDataPath, DATA_FOLDER_NAME } from '../../main/data-folder.ts';

function tree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

test('moves an old Chatea folder into Agente with the new layout and paths', () => {
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
  const root = '/data/Agente';
  assert.equal(mapDataPath('/home/me/models/x.gguf', ['/old/Chatea'], root), '/home/me/models/x.gguf');
  assert.equal(mapDataPath('/old/Chatea/cache/a.db', ['/old/Chatea'], root), '/data/Agente/cache/a.db');
});

test('moves a Flaxeo Chat folder into Agente and rewrites its stored paths', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'flx-'));
  const old = path.join(appData, 'Flaxeo Chat');
  const root = path.join(appData, 'Agente');
  const llama = path.join(old, 'engines', 'llama.cpp', 'b9-vulkan', 'llama-server');
  tree(old, {
    'engines/llama.cpp/b9-vulkan/llama-server': 'x',
    'models/chat/m.gguf': 'x',
    'Local Storage/leveldb/000003.log': 'ls',
    'config.json': JSON.stringify({ llm: { local: { runtime_path: llama, models_dir: path.join(old, 'models', 'chat') } } })
  });

  assert.equal(DATA_FOLDER_NAME, 'Agente');
  assert.ok(migrateDataFolder(appData, appData).length > 0);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(root, 'models', 'chat', 'm.gguf')));
  assert.ok(fs.existsSync(path.join(root, 'Local Storage', 'leveldb', '000003.log')));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(cfg.llm.local.runtime_path, path.join(root, 'engines', 'llama.cpp', 'b9-vulkan', 'llama-server'));
  assert.equal(cfg.llm.local.models_dir, path.join(root, 'models', 'chat'));
});

test('brings the old browser profile into the new userData folder once', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'flx-'));
  const userData = path.join(appData, 'agente-desktop');
  tree(path.join(appData, 'chatealm'), { 'Local Storage/leveldb/CURRENT': 'x', Preferences: '{}' });
  // Electron may create the new folder before this runs.
  tree(userData, { 'Local State': '{}' });

  assert.ok(migrateBrowserProfile(appData, userData).length > 0);
  assert.ok(fs.existsSync(path.join(userData, 'Local Storage', 'leveldb', 'CURRENT')));
  assert.ok(fs.existsSync(path.join(userData, 'Preferences')));
  assert.equal(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'), '{}');
  assert.deepEqual(migrateBrowserProfile(appData, userData), []);
});

test('an install that brought saved secrets keeps the old keyring name, once decided', () => {
  const withSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'flx-'));
  tree(withSecrets, { 'secrets.json': '{}' });
  assert.equal(keyringAppName(withSecrets, 'chatealm'), 'chatealm');
  // Recorded: later starts agree even if the legacy name passed changes.
  assert.equal(keyringAppName(withSecrets, 'other'), 'chatealm');

  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flx-'));
  assert.equal(keyringAppName(fresh, 'chatealm'), null);
  // Secrets saved later by the new name stay under the new name.
  tree(fresh, { 'secrets.json': '{}' });
  assert.equal(keyringAppName(fresh, 'chatealm'), null);
});
