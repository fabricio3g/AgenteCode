import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProcessRegistry, findLocalUrls } from '../../main/agente/processes.ts';

describe('findLocalUrls', () => {
  it('finds dev-server URLs through color codes and rewrites 0.0.0.0', () => {
    const line = '\u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m';
    assert.deepEqual(findLocalUrls(line), ['http://localhost:5173/']);
    assert.deepEqual(findLocalUrls('listening on http://0.0.0.0:3000.'), ['http://localhost:3000']);
    assert.deepEqual(findLocalUrls('see https://example.com'), []);
  });
});

describe('ProcessRegistry', { skip: process.platform === 'win32' }, () => {
  it('reports output, URLs and exit', async () => {
    const registry = new ProcessRegistry();
    const events = [];
    registry.onEvent((event) => events.push(event.type));
    const started = registry.start({ chatId: 'c1', command: 'echo "ready on http://127.0.0.1:4321"; exit 2', cwd: process.cwd() });
    await registry.settle(started.id, 3000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const info = registry.get(started.id);
    assert.equal(info.status, 'exited');
    assert.equal(info.exitCode, 2);
    assert.deepEqual(info.urls, ['http://127.0.0.1:4321']);
    assert.match(registry.output(started.id), /ready on/);
    assert.ok(events.includes('process_start') && events.includes('process_url') && events.includes('process_exit'));
  });

  it('stops the whole process group, children included', async () => {
    const registry = new ProcessRegistry();
    // The shell starts a child that would outlive a plain kill of the shell.
    const started = registry.start({ chatId: 'c1', command: 'sleep 30 & echo child $!; wait', cwd: process.cwd() });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const childPid = Number(registry.output(started.id).match(/child (\d+)/)?.[1]);
    assert.ok(childPid > 0);
    assert.equal(await registry.stop(started.id), true);
    assert.equal(registry.get(started.id).status, 'stopped');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  });

  it('sees a Python server URL right away (unbuffered output)', async () => {
    const registry = new ProcessRegistry();
    const started = registry.start({ chatId: 'c1', command: 'python3 -c "import time; print(\'Serving on http://127.0.0.1:8123/\'); time.sleep(5)"', cwd: process.cwd() });
    await registry.settle(started.id, 3000);
    assert.deepEqual(registry.get(started.id).urls, ['http://127.0.0.1:8123/']);
    await registry.stop(started.id);
  });

  it('lists and clears per conversation', async () => {
    const registry = new ProcessRegistry();
    const a = registry.start({ chatId: 'a', command: 'true', cwd: process.cwd() });
    registry.start({ chatId: 'b', command: 'sleep 5', cwd: process.cwd() });
    await registry.settle(a.id, 2000);
    assert.equal(registry.list('a').length, 1);
    await registry.stopChat('b');
    assert.equal(registry.list('b').length, 0);
    registry.prune('a');
    assert.equal(registry.list().length, 0);
  });
});
