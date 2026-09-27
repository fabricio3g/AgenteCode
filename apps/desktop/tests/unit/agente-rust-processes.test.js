import test from 'node:test';
import assert from 'node:assert/strict';
import { RustProcessBridge, isRustProcessId } from '../../main/agente/rust-processes.ts';

/** A runtime with one process whose state the test moves along. */
function fakeRuntime() {
  const state = { status: 'running', output: 'starting\n', urls: [], stopped: false, calls: [] };
  const client = {
    async request(method, params) {
      state.calls.push({ method, params });
      if (method === 'processes.list') {
        if (params.project_dir !== '/work/app') return [];
        return [{ id: 'p1', command: 'npm run dev', project_dir: '/work/app', started_at: 1, status: state.status, exit_code: state.status === 'exited' ? 0 : null, urls: state.urls }];
      }
      if (method === 'processes.output') return { output: state.output };
      if (method === 'processes.stop') {
        state.stopped = true;
        return { stopped: true };
      }
      throw new Error(method);
    }
  };
  return { state, client };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

test('runtime processes reach the Processes pane as events, with rs- ids', async () => {
  const { state, client } = fakeRuntime();
  const bridge = new RustProcessBridge(() => Promise.resolve(client), () => [{ chatId: 'chat-1', projectRoot: '/work/app' }]);
  const events = [];
  bridge.onEvent((event) => events.push(event));
  try {
    bridge.nudge();
    await settle();
    assert.deepEqual(events.map((e) => e.type), ['process_start', 'process_output']);
    const started = events[0].process;
    assert.equal(started.id, 'rs-p1');
    assert.equal(started.chatId, 'chat-1');
    assert.equal(events[1].chunk, 'starting\n');
    assert.ok(isRustProcessId(started.id));
    assert.deepEqual(bridge.list('chat-1').map((p) => p.id), ['rs-p1']);
    assert.deepEqual(bridge.list('other'), []);

    state.output += 'ready on http://localhost:3000\n';
    state.urls = ['http://localhost:3000'];
    bridge.nudge();
    await settle();
    assert.equal(events.at(-2).type, 'process_output');
    assert.equal(events.at(-2).chunk, 'ready on http://localhost:3000\n', 'only the new output');
    assert.equal(events.at(-1).type, 'process_url');

    assert.equal(await bridge.output('rs-p1'), state.output);
    assert.equal(await bridge.stop('rs-p1'), true);
    assert.equal(state.calls.find((c) => c.method === 'processes.stop').params.id, 'p1');

    state.status = 'exited';
    bridge.nudge();
    await settle();
    assert.equal(events.at(-1).type, 'process_exit');
    assert.equal(events.at(-1).process.exitCode, 0);
  } finally {
    bridge.dispose();
  }
});
