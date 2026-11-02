import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerSession, ComputerActionRejected } from '../../main/computer/session.ts';

const signal = () => new AbortController().signal;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup(overrides = {}) {
  const calls = { arm: [], revoke: 0, stop: 0, resume: 0, actions: 0, captures: 0, state: [] };
  const platform = {
    ready: async () => {}, confirm: async () => true,
    arm: async generation => { calls.arm.push(generation); },
    revoke: () => { calls.revoke++; },
    observe: async () => { calls.captures++; return { id: `shot-${calls.captures}`, width: 800, height: 600, displayId: '1', capturedAt: Date.now(), image: { data: '', mimeType: 'image/jpeg' } }; },
    act: async () => { calls.actions++; return { x: 20, y: 20 }; },
    present: async () => {}, dismiss: () => {}, ...overrides,
  };
  const owner = { sessionId: 'session-a', turnId: 'turn-a', chatId: 'chat-a', space: 'home', webContentsId: 1, stop: () => { calls.stop++; }, resume: () => { calls.resume++; } };
  const session = new ComputerSession(platform, state => calls.state.push(state));
  return { session, calls, owner };
}

test('no screenshot/input before an explicit grant, including a denied request', async () => {
  const { session, calls, owner } = setup({ confirm: async () => false });
  await assert.rejects(() => session.observe(owner, signal()), /another chat/);
  await assert.rejects(() => session.request(owner, 'Test app', signal()), /declined/);
  assert.equal(calls.arm.length, 0); assert.equal(calls.captures, 0); assert.equal(calls.actions, 0);
  session.end();
});
test('Escape revokes immediately, stops the turn, and prevents tool-driven resume', async () => {
  const { session, calls, owner } = setup();
  await session.request(owner, 'Test app', signal());
  const observation = await session.observe(owner, signal());
  session.takeover('escape');
  assert.equal(session.state.phase, 'paused'); assert.equal(calls.revoke, 1); assert.equal(calls.stop, 1);
  await assert.rejects(() => session.act(owner, observation.id, { kind: 'click', x: 20, y: 20 }, signal()), /control_revoked/);
  await assert.rejects(() => session.request(owner, 'Resume myself', signal()), /owned/);
  assert.equal(calls.actions, 0); session.end();
});
test('explicit Resume requires settlement and a fresh generation and observation', async () => {
  const { session, calls, owner } = setup();
  await session.request(owner, 'Test app', signal());
  const old = await session.observe(owner, signal());
  session.takeover('escape');
  assert.throws(() => session.resume(), /previous turn/);
  session.settled(owner.sessionId, owner.turnId); session.resume();
  assert.equal(calls.resume, 1); assert.equal(session.state.phase, 'preparing');
  await assert.rejects(() => session.observe(owner, signal()), /cancelled turn/);
  session.attach(owner);
  await assert.rejects(() => session.request(owner, 'Old turn', signal()), /cancelled turn/);
  const next = { ...owner, turnId: 'turn-b' };
  session.attach(next);
  await assert.rejects(() => session.act(next, old.id, { kind: 'click', x: 20, y: 20 }, signal()), /fresh/);
  assert.notEqual(calls.arm[0], calls.arm[1]);
  const fresh = await session.observe(next, signal());
  await session.act(next, fresh.id, { kind: 'click', x: 20, y: 20 }, signal());
  assert.equal(calls.actions, 1); session.end();
});
test('one global desktop owner across Home and Code/windows', async () => {
  const { session, owner } = setup();
  await session.request(owner, 'Test app', signal());
  const foreign = { ...owner, sessionId: 'session-b', chatId: 'code-chat', space: 'code', webContentsId: 2 };
  await assert.rejects(() => session.request(foreign, 'Other task', signal()), /owned/);
  await assert.rejects(() => session.observe(foreign, signal()), /another chat/);
  session.end();
});
test('late permission approval cannot reactivate a cancelled request', async () => {
  const permission = deferred();
  const { session, owner, calls } = setup({ confirm: () => permission.promise });
  const controller = new AbortController();
  const requesting = session.request(owner, 'Test app', controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); permission.resolve(true);
  await assert.rejects(() => requesting);
  assert.equal(calls.arm.length, 0); assert.equal(session.state.phase, 'ended');
});
test('takeover during an in-flight capture discards its pixels', async () => {
  const capture = deferred();
  const { session, owner } = setup({ observe: () => capture.promise });
  await session.request(owner, 'Test app', signal());
  const pending = session.observe(owner, signal());
  await new Promise(resolve => setImmediate(resolve));
  session.takeover('escape');
  capture.resolve({ id: 'stale', capturedAt: Date.now() });
  await assert.rejects(() => pending, /control_revoked/); session.end();
});
test('parallel requests/actions cannot interleave and observations are single-use', async () => {
  const running = deferred();
  const { session, owner, calls } = setup({ act: async () => { calls.actions++; await running.promise; } });
  await session.request(owner, 'Test app', signal());
  const shot = await session.observe(owner, signal());
  const pending = session.act(owner, shot.id, { kind: 'click', x: 20, y: 20 }, signal());
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => session.observe(owner, signal()), /in progress/);
  running.resolve(); await pending;
  await assert.rejects(() => session.act(owner, shot.id, { kind: 'click', x: 20, y: 20 }, signal()), /fresh/);
  assert.equal(calls.actions, 1); session.end();
});
test('a native failure pauses control and is never replayed', async () => {
  const { session, owner, calls } = setup({ act: async () => { calls.actions++; throw new Error('blocked input'); } });
  await session.request(owner, 'Test app', signal());
  const shot = await session.observe(owner, signal());
  await assert.rejects(() => session.act(owner, shot.id, { kind: 'click', x: 20, y: 20 }, signal()), /blocked/);
  assert.equal(session.state.phase, 'paused'); assert.equal(calls.stop, 1); assert.equal(calls.actions, 1); session.end();
});

test('rejected targets do not stop the agent and require a fresh observation', async () => {
  let rejected = true;
  const { session, owner, calls } = setup({ act: async () => {
    if (rejected) throw new ComputerActionRejected('Control bar covers this target; no input was sent.');
    calls.actions++;
  } });
  await session.request(owner, 'Test app', signal());
  const shot = await session.observe(owner, signal());
  await assert.rejects(() => session.act(owner, shot.id, { kind:'click', x:20, y:20 }, signal()), /no input/);
  assert.equal(session.state.phase, 'active'); assert.equal(calls.stop, 0); assert.equal(calls.revoke, 0);
  await assert.rejects(() => session.act(owner, shot.id, { kind:'click', x:20, y:20 }, signal()), /fresh/);
  rejected = false;
  const fresh = await session.observe(owner, signal());
  await session.act(owner, fresh.id, { kind:'key', keys:['Control','L'] }, signal());
  assert.equal(calls.actions, 1); session.end();
});
test('turn completion and owner destruction release input/capture', async () => {
  for (const how of ['settled', 'closed']) {
    const { session, owner, calls } = setup();
    await session.request(owner, 'Test app', signal());
    if (how === 'settled') session.settled(owner.sessionId, owner.turnId); else session.releaseOwner(owner.webContentsId);
    assert.equal(session.state.phase, 'ended'); assert.equal(session.owner, undefined); assert.ok(calls.revoke);
  }
});
test('takeover during native arming cannot show an active session afterwards', async () => {
  const armed = deferred();
  const { session, owner } = setup({ arm: () => armed.promise });
  const pending = session.request(owner, 'Test app', signal());
  await new Promise(resolve => setImmediate(resolve));
  session.takeover('escape'); armed.resolve();
  await assert.rejects(() => pending, /revoked/); assert.equal(session.state.phase, 'paused'); session.end();
});
