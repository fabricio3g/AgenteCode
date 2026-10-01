import { it } from 'node:test';
import assert from 'node:assert/strict';
import { startupErrorPage } from '../../main/startup-support.ts';

it('failure page renders without the app bundle and escapes the log path', () => {
  const html = startupErrorPage('C:\\Agente ñ\\<script>alert(1)</script>\\startup.log');
  assert.match(html, /data-startup-error/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /startup.log/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { packageReport } from '../../scripts/package-report.mjs';
const asar = createRequire(import.meta.url)('@electron/asar');
const { bundledDuplicates } = createRequire(import.meta.url)('../../scripts/packaging.cjs');
it('prunes bundled JS but keeps native dependencies and their shared transitive packages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-closure-'));
  try {
    const native = path.join(root, 'node_modules/native-db');
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify({ dependencies: { shared: '1' } }));
    const manifest = { dependencies: { bundled: '1', shared: '1', 'native-db': '1' } };
    const meta = { inputs: { 'node_modules/bundled/index.js': {}, 'node_modules/shared/index.js': {} }, outputs: { main: { imports: [{ path: 'native-db', external: true }] } } };
    assert.deepEqual(bundledDuplicates(root, manifest, meta), ['bundled']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('reports ASAR assets and native files once, including unpacked dependencies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-report-'));
  try {
    const application = path.join(root, 'source');
    const unpacked = path.join(root, 'linux-unpacked');
    const resources = path.join(unpacked, 'resources');
    const files = {
      'renderer/dist/assets/app.js': 'renderer',
      'node_modules/native-db/addon.node': 'native',
      'node_modules/bundled/index.js': 'javascript'
    };
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(application, name)), { recursive: true });
      fs.writeFileSync(path.join(application, name), content);
    }
    fs.mkdirSync(resources, { recursive: true });
    await asar.createPackageWithOptions(application, path.join(resources, 'app.asar'), { unpack: '**/*.node' });
    fs.mkdirSync(path.join(resources, 'bin/llama/cuda'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'bin', process.platform === 'win32' ? 'agente.exe' : 'agente'), 'rust');
    fs.writeFileSync(path.join(resources, 'bin/llama/cuda/backend'), 'gpu');
    fs.writeFileSync(path.join(root, 'AgenteDesktop-linux-x64.AppImage'), 'installer');
    const result = packageReport(unpacked, root);
    assert.equal(result.renderer, 8);
    assert.equal(result.dependencies, 16);
    assert.equal(result.rust, 4);
    assert.equal(result.backends['llama/cuda'], 3);
    assert.equal(result.installers['AgenteDesktop-linux-x64.AppImage'], 9);
    assert.ok(result.installed > 31);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
