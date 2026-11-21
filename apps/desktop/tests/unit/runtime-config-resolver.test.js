import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');

let tempDir;
let resolver;
let discoveredBinary;

function installElectronMock(root) {
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        isPackaged: false,
        getPath(name) {
          if (name === 'home') return path.join(root, 'home');
          if (name === 'appData') return path.join(root, 'appData');
          if (name === 'exe') return path.join(root, 'app.exe');
          return path.join(root, name);
        }
      }
    }
  };
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-config-resolver-'));
  process.env.AGENTE_HOME = tempDir;
  installElectronMock(tempDir);

  const binDir = path.join(tempDir, 'engines', 'llama.cpp', 'default');
  fs.mkdirSync(binDir, { recursive: true });
  const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  discoveredBinary = path.join(binDir, binName);
  fs.writeFileSync(discoveredBinary, 'stub');

  resolver = await import('../../main/runtime-config-resolver.ts');
});

after(() => {
  delete process.env.AGENTE_HOME;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveRuntimeConfig', () => {
  it('preserves mainGpu index 0 instead of coercing it to null', () => {
    const withZero = resolver.resolveRuntimeConfig({
      runtimePath: discoveredBinary,
      userBackend: 'cpu',
      mainGpu: 0
    });
    assert.equal(withZero.mainGpu, 0);

    const withUndefined = resolver.resolveRuntimeConfig({
      runtimePath: discoveredBinary,
      userBackend: 'cpu'
    });
    assert.equal(withUndefined.mainGpu, null);
  });

  it('returns the auto-discovered effectiveRuntimePath when runtimePath is empty or missing', () => {
    const fromEmpty = resolver.resolveRuntimeConfig({
      runtimePath: '',
      userBackend: 'cpu'
    });
    assert.equal(fromEmpty.runtimePath, discoveredBinary);

    const fromMissing = resolver.resolveRuntimeConfig({
      runtimePath: path.join(tempDir, 'does-not-exist', 'llama-server.exe'),
      userBackend: 'cpu'
    });
    assert.equal(fromMissing.runtimePath, discoveredBinary);
  });
});
