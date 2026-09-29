import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AgenteClient, AgenteRpcError } from '../../main/agente-client.ts';
import { AgenteDaemon, defaultSocketPath, resolveAgenteBinary, REQUIRED_CAPABILITIES } from '../../main/agente-daemon.ts';

/** Short socket paths: Unix sockets cap the path at ~108 bytes. */
function socketDir(tag) {
  return fs.mkdtempSync(path.join('/tmp', `ag-${tag}-`));
}

test('the client matches replies, surfaces errors and notifications, and fails pending calls on close', async () => {
  const dir = socketDir('client');
  const socketPath = path.join(dir, 's.sock');
  const server = net.createServer((connection) => {
    connection.setEncoding('utf8');
    let buffer = '';
    connection.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.method === 'echo') {
          // A notification may arrive before the reply, split across writes.
          const note = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { n: 1 } });
          connection.write(note.slice(0, 10));
          connection.write(`${note.slice(10)}\n`);
          connection.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.params })}\n`);
        } else if (message.method === 'hang') {
          connection.destroy();
        } else {
          connection.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } })}\n`);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const client = await AgenteClient.connect(socketPath);
  const notes = [];
  client.onNotification((method, params) => notes.push({ method, params }));

  assert.deepEqual(await client.request('echo', { a: 1 }), { a: 1 });
  assert.deepEqual(notes, [{ method: 'event', params: { n: 1 } }]);

  await assert.rejects(client.request('nope'), (error) => error instanceof AgenteRpcError && error.code === -32601);

  let closed = false;
  client.onClose(() => { closed = true; });
  await assert.rejects(client.request('hang'), /closed/);
  assert.equal(closed, true);
  assert.equal(client.isClosed, true);
  await assert.rejects(client.request('echo'), /not connected/);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the default socket follows XDG_RUNTIME_DIR, else ~/.agente', () => {
  assert.equal(defaultSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux'), '/run/user/1000/agente/agente.sock');
  assert.equal(defaultSocketPath({ HOME: '/home/me' }, 'linux'), '/home/me/.agente/agente.sock');
  assert.equal(defaultSocketPath({ USERNAME: 'ana' }, 'win32'), '\\\\.\\pipe\\agente-ana');
});

test('a reused daemon missing desktop methods is rejected during initialization', async () => {
  const dir = socketDir('stale');
  const socketPath = path.join(dir, 's.sock');
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const server = net.createServer((connection) => {
    connection.once('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      connection.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocol_version: 2, version: '0.2.1' } }) + '\n');
    });
    connection.once('close', disconnected);
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const daemon = new AgenteDaemon({ binary: null, socketPath });
    await assert.rejects(daemon.connect(), /incompatible.*missing bots.*Restart agente serve/s);
    await closed;
    assert.equal(server.listening, true, 'an incompatible external daemon is not stopped');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const binary = resolveAgenteBinary({ repoRoot });

test('Desktop starts agente serve, runs a command through it, and reuses a running daemon', { skip: !binary && 'no agente build in this checkout' }, async () => {
  const dir = socketDir('daemon');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-daemon-home-'));
  const env = { AGENTE_CONFIG_DIR: path.join(home, 'cfg'), AGENTE_SESSIONS_DIR: path.join(home, 'sessions') };
  const socketPath = path.join(dir, 'agente.sock');
  const daemon = new AgenteDaemon({ binary, socketPath, env });
  try {
    const client = await daemon.connect();
    const hello = await client.request('initialize');
    assert.ok(REQUIRED_CAPABILITIES.every((capability) => hello.capabilities.includes(capability)));
    assert.ok(Array.isArray(await client.request('bots.list')), 'Bots uses the current backend');
    assert.equal(await daemon.connect(), client, 'one connection is shared');

    const notes = [];
    const outcome = new Promise((resolve) => {
      client.onNotification((method, params) => {
        notes.push({ method, params });
        if (method === 'turn.outcome') resolve(params);
      });
    });
    const sessionId = crypto.randomUUID();
    await client.request('turn.exec', { session_id: sessionId, tool: 'shell', arguments: { command: 'echo from-desktop' } });
    assert.equal((await outcome).status, 'completed');
    const result = notes.find((note) => note.params?.event?.type === 'tool_result');
    assert.match(result.params.event.content, /from-desktop/);

    // A second app instance attaches to the same daemon instead of starting one.
    const other = new AgenteDaemon({ binary: null, socketPath });
    const attached = await other.connect();
    assert.deepEqual(await attached.request('session.list'), []);
    other.stop();
  } finally {
    daemon.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fs.existsSync(socketPath), false, 'the socket is removed when the runtime stops');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
