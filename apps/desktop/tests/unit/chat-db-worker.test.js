import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { ChatDatabaseWorker } from '../../main/chat-db-client.ts';

test('old database worker exit cannot reject requests owned by its replacement', async () => {
  const workers = [];
  class FakeWorker extends EventEmitter {
    unref() {} postMessage(message) { this.last = message; } async terminate() {}
  }
  const database = new ChatDatabaseWorker('unused', 'unused', () => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const first = assert.rejects(database.request('loadAllChats'), /crashed/);
  workers[0].emit('error', new Error('crashed'));
  await first;
  const replacement = database.request('loadAllChats');
  workers[0].emit('exit', 1);
  workers[1].emit('message', { id: workers[1].last.id, result: ['new worker'] });
  assert.deepEqual(await replacement, ['new worker']);
  const closing = database.close();
  workers[1].emit('message', { id: workers[1].last.id, result: null });
  await closing;
});

test('bundled database worker persists without a native SQLite addon', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agente-sqlite-worker-'));
  const workerFile = path.join(directory, 'worker.cjs');
  await build({ entryPoints: ['main/chat-db-worker.ts'], outfile: workerFile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], define: { 'import.meta.url': '__filename' } });
  const database = new ChatDatabaseWorker(workerFile, path.join(directory, 'history.db'));
  try {
    await database.request('saveChatSession', { id: 'design', title: 'Studio', contextMode: 'design', createdAt: 1, updatedAt: 2, messages: [{ id: 'm1', role: 'user', content: 'Create a chair', createdAt: 1 }] });
    const loaded = await database.request('loadAllChats');
    assert.equal(loaded[0].messages[0].content, 'Create a chair');
    assert.equal(loaded[0].contextMode, 'design');
  } finally {
    await database.close();
    // mkdtemp created this exact disposable test directory.
    rmSync(directory, { recursive: true, force: true });
  }
});
