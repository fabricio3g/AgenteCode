import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
let root, models, config;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-model-import-'));
  process.env.AGENTE_HOME = path.join(root, 'app');
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { isPackaged: false, getPath: (name) => path.join(root, name) } } };
  models = await import('../../main/model-manager.ts');
  config = await import('../../main/config.ts');
});
after(() => { delete process.env.AGENTE_HOME; fs.rmSync(root, { recursive: true, force: true }); });

function fixture(relative, architecture = 'llama') {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const str = (value) => { const bytes = Buffer.from(value); const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(bytes.length)); return Buffer.concat([size, bytes]); };
  const key = str('general.architecture'), type = Buffer.alloc(4); type.writeUInt32LE(8);
  const header = Buffer.alloc(24); header.write('GGUF'); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(1n, 16);
  fs.writeFileSync(filename, Buffer.concat([header, key, type, str(architecture)]));
  return filename;
}

describe('GGUF import and library discovery', () => {
  it('imports an external GGUF and keeps it visible after index refresh', async () => {
    const filename = fixture('external/model.gguf');
    const result = await models.importLocalModel({ filePath: filename });
    assert.equal(result.success, true);
    assert.equal(result.model.path, filename);
    assert.equal(config.loadConfig().llm.local.models.length, 1);
    assert.ok((await models.getLocalModels()).models.some((model) => model.path === filename));
    assert.ok((await models.getIndexedModels()).some((model) => model.path === filename));
    await models.importLocalModel({ filePath: filename });
    assert.equal(config.loadConfig().llm.local.models.length, 1, 'repeat import is idempotent');
  });

  it('keeps equally named external models distinct', async () => {
    const other = fixture('different/model.gguf');
    const result = await models.importLocalModel({ filePath: other });
    assert.equal(config.loadConfig().llm.local.models.length, 2);
    assert.notEqual(result.model.id, config.loadConfig().llm.local.models[0].id);
    assert.equal((await models.getLocalModels()).models.filter((model) => model.name === 'model.gguf').length, 2);
  });

  it('validates GGUFs before copying and does not overwrite a managed model', async () => {
    const filename = fixture('copy/managed.gguf');
    const imported = await models.importLocalModel({ filePath: filename, copy_to_managed: true });
    assert.notEqual(imported.model.path, filename);
    const collision = fixture('collision/managed.gguf');
    const previous = fs.readFileSync(imported.model.path);
    await assert.rejects(models.importLocalModel({ filePath: collision, copy_to_managed: true }), /already in the model folder/);
    assert.deepEqual(fs.readFileSync(imported.model.path), previous);
    const broken = path.join(root, 'broken.gguf'); fs.writeFileSync(broken, 'GGUF');
    await assert.rejects(models.importLocalModel({ filePath: broken, copy_to_managed: true }), /header is incomplete/);
    assert.ok(!fs.existsSync(path.join(await models.getModelsDirPath(), 'broken.gguf')));
  });

  it('normalizes a split model to its first shard and checks missing siblings', async () => {
    const first = fixture('split/sharded-00001-of-00002.gguf');
    await assert.rejects(models.importLocalModel({ filePath: first }), /Missing: sharded-00002-of-00002/);
    const second = fixture('split/sharded-00002-of-00002.gguf');
    const imported = await models.importLocalModel({ filePath: second });
    assert.equal(imported.model.path, first);
    assert.equal((await models.getLocalModels()).models.filter((model) => model.name.startsWith('sharded-')).length, 1);
  });

  it('refuses a projector as a language model', async () => {
    const projector = fixture('external/mmproj-test.gguf', 'clip');
    await assert.rejects(models.importLocalModel({ filePath: projector }), /vision projector/);
  });

  it('uses architecture metadata without an app-side model allowlist', async () => {
    const filename = fixture('external/new-model-family.gguf', 'future_llama_architecture');
    const imported = await models.importLocalModel({ filePath: filename });
    assert.equal(imported.model.architecture, 'future_llama_architecture');
    assert.equal((await models.getLocalModels()).models.find((model) => model.path === filename).architecture, 'future_llama_architecture');
  });

  it('removes a deleted external model from the registry and index', async () => {
    const filename = fixture('external/delete-me.gguf');
    await models.importLocalModel({ filePath: filename });
    await models.deleteLocalModel(filename);
    assert.ok(!config.loadConfig().llm.local.models.some((model) => model.path === filename));
    assert.ok(!(await models.getIndexedModels()).some((model) => model.path === filename));
  });
});
