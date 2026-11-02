// Real SQLite + Blender integration in an isolated profile. No LLM/provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, nativeImage } from 'electron';
import { DEFAULT_SCENE } from '../../shared/design-3d.ts';
import { runBlenderRequest } from '../../main/design/blender.ts';
import { blenderAsset } from '../../main/design/blender-engine.ts';
import Database from '../../main/sqlite.ts';

const root = process.env.AGENTE_BLENDER_SMOKE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'agente-blender-smoke-'));
process.env.AGENTE_HOME = root;
app.setPath('userData', path.join(root, 'browser'));
app.disableHardwareAcceleration();
const events: string[] = [];
const event = { sender: { isDestroyed: () => false, send: (channel: string) => { events.push(channel); } } } as never;
async function run() {
  await app.whenReady();
  const database = new Database(path.join(root, 'test.db'));
  database.exec('CREATE TABLE smoke (value TEXT); INSERT INTO smoke VALUES (\'ready\')');
  assert.equal(database.prepare('SELECT value FROM smoke').get().value, 'ready');
  database.close();
  console.log('ELECTRON_SQLITE_OK', process.versions.node);
  assert.match(blenderAsset('win32', 'arm64'), /windows-arm64.zip$/);
  assert.match(blenderAsset('darwin', 'arm64'), /macos-arm64.dmg$/);
  assert.match(blenderAsset('linux', 'x64'), /linux-x64.tar.xz$/);
  assert.throws(() => blenderAsset('linux', 'arm64'), /Choose an existing/);
  let state = await runBlenderRequest(event, { chatId: 'smoke', action: 'status' }) as any;
  if (!state.available) {
    if (process.env.AGENTE_BLENDER_SMOKE_INSTALL !== '1') throw new Error('Set AGENTE_BLENDER_SMOKE_INSTALL=1 to test the platform download in this isolated profile.');
    console.log('INSTALLING_BLENDER', root);
    await runBlenderRequest(event, { chatId: 'smoke', action: 'install' });
  }
  const scene = { ...DEFAULT_SCENE, render: { width: 256, height: 256, engine: 'cycles', samples: 4 } };
  const start = Date.now();
  state = await runBlenderRequest(event, { chatId: 'smoke', action: 'build', scene, render: true }) as any;
  assert.equal(state.error, undefined, state.error);
  assert.equal(state.busy, false);
  assert.equal(state.model, true);
  assert.equal(state.render, true);
  const model = await runBlenderRequest(event, { chatId: 'smoke', action: 'asset', asset: 'model' }) as any;
  assert.equal(Buffer.from(model.data, 'base64').toString('ascii', 0, 4), 'glTF');
  const render = await runBlenderRequest(event, { chatId: 'smoke', action: 'asset', asset: 'render' }) as any;
  const png = Buffer.from(render.data, 'base64');
  const image = nativeImage.createFromBuffer(png);
  assert.deepEqual(image.getSize(), { width: 256, height: 256 });
  assert.equal(image.isEmpty(), false);
  const pixels = image.toBitmap();
  assert.equal(pixels.every((value, index) => value === pixels[index % 4]), false, 'Render must contain a scene, not a blank image');
  fs.writeFileSync(path.join(root, 'render.png'), png);
  assert.ok(events.includes('design_changed'));
  const pending = runBlenderRequest(event, { chatId: 'smoke', action: 'build', scene, render: true, owner: 'cancel-test' });
  await runBlenderRequest(event, { chatId: 'smoke', action: 'cancel', owner: 'foreign' });
  const running = await runBlenderRequest(event, { chatId: 'smoke', action: 'status' }) as any;
  assert.equal(running.busy, true);
  await runBlenderRequest(event, { chatId: 'smoke', action: 'cancel', owner: 'cancel-test' });
  assert.match((await pending as any).error, /stopped/);
  console.log('BLENDER_SMOKE_OK', JSON.stringify({ root, elapsedMs: Date.now() - start, modelBytes: Buffer.from(model.data, 'base64').length, renderBytes: png.length }));
}
void run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
