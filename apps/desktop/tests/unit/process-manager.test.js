import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ManagedProcess, ProcessStartCancelled } from '../../main/process-manager.ts';

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  signalCode = null;
  signals = [];
  kill(signal) {
    this.signals.push(signal);
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }
  exit(code, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const config = (model) => ({ binaryPath: 'llama-server', args: ['-m', model], healthPort: 11435, statusFields: { model_path: model } });

test('identical model loads share one launch; switching cancels only the old launch', async () => {
  const children = [];
  const statuses = [];
  let ready = false;
  const managed = new ManagedProcess({
    spawn: () => { const child = new Child(); children.push(child); return child; },
    fetch: async () => ({ ok: ready }), healthIntervalMs: 5,
    onStatusChange: (status) => statuses.push({ ...status })
  });
  const a = managed.start(config('a.gguf'));
  const cancelled = assert.rejects(a, ProcessStartCancelled);
  assert.equal(managed.start(config('a.gguf')), a);
  await tick();
  assert.equal(children.length, 1);
  const b = managed.start(config('b.gguf'));
  await cancelled;
  await tick();
  assert.equal(children.length, 2);
  assert.deepEqual(children[0].signals, ['SIGTERM']);
  ready = true;
  assert.equal(await b, 'started');
  assert.equal(managed.status.model_path, 'b.gguf');
  assert.equal(statuses.some((status) => status.state === 'error'), false);
  await managed.stop();
  assert.equal(managed.status.state, 'idle');
});

test('a late health response from a stopped child cannot mark its replacement ready', async () => {
  const children = [];
  let release;
  const healthStarted = new Promise((resolve) => { release = resolve; });
  let reply;
  let ready = false;
  const managed = new ManagedProcess({
    spawn: () => { const child = new Child(); children.push(child); return child; },
    fetch: () => {
      if (children.length > 1) return Promise.resolve({ ok: ready });
      release();
      return new Promise((resolve) => { reply = resolve; });
    }, healthIntervalMs: 5
  });
  const a = managed.start(config('old'));
  const cancelled = assert.rejects(a, ProcessStartCancelled);
  await healthStarted;
  const b = managed.start(config('new'));
  await cancelled;
  await tick();
  reply({ ok: true });
  await tick();
  assert.equal(managed.status.state, 'starting');
  assert.equal(managed.status.model_path, 'new');
  ready = true;
  await b;
  await managed.stop();
});

test('startup timeout keeps its health-check cause when SIGTERM arrives', async () => {
  const child = new Child();
  const managed = new ManagedProcess({ spawn: () => child, fetch: async () => ({ ok: false }), startupTimeoutMs: 20, healthIntervalMs: 5 });
  const loading = managed.start(config('slow'));
  await tick();
  child.stderr.write('load_tensors: reading weights\n');
  await assert.rejects(loading, /health check timed out while loading weights/);
  await tick();
  assert.equal(managed.status.state, 'error');
  assert.match(managed.status.message, /health check timed out/);
  assert.deepEqual(child.signals, ['SIGTERM']);
  await managed.stop();
});

test('an unexpected SIGTERM is reported with the child logs', async () => {
  const child = new Child();
  const managed = new ManagedProcess({ spawn: () => child, fetch: async () => ({ ok: false }) });
  const loading = managed.start(config('broken'));
  const failure = assert.rejects(loading, /signal SIGTERM.*\n.*device failed/s);
  await tick();
  child.stderr.write('device failed\n');
  child.exit(null, 'SIGTERM');
  await failure;
  assert.equal(managed.status.state, 'error');
  assert.match(managed.status.message, /device failed/);
});
