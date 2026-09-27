import test from 'node:test';
import assert from 'node:assert/strict';
import { serveDesktopTools } from '../../main/agente/desktop-tools-mcp.ts';

const tools = [
  {
    name: 'browser_snapshot',
    description: 'Read the page',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: 'page text' };
    }
  },
  {
    name: 'browser_open',
    description: 'Open a URL',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    requiresApproval: () => true,
    async execute(_id, args) {
      if (!args.url) return { content: 'url missing', isError: true };
      return { content: `opened ${args.url}`, images: [{ data: 'aGk=', mimeType: 'image/png' }] };
    }
  }
];

async function rpc(server, body, token = server.token) {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

test('Desktop tools are served over MCP to whoever holds the token', async () => {
  const server = await serveDesktopTools(tools);
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal((await rpc(server, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong')).status, 401);

    const init = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(init.json.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.json.result.capabilities, { tools: {} });
    assert.equal((await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

    const listed = await rpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const hints = Object.fromEntries(listed.json.result.tools.map((tool) => [tool.name, tool.annotations.readOnlyHint]));
    assert.deepEqual(hints, { browser_snapshot: true, browser_open: false }, 'only harmless tools skip approval');

    const called = await rpc(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_open', arguments: { url: 'http://localhost:5173' } } });
    assert.deepEqual(called.json.result, {
      content: [
        { type: 'text', text: 'opened http://localhost:5173' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' }
      ],
      isError: false
    });

    const failed = await rpc(server, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_open', arguments: {} } });
    assert.equal(failed.json.result.isError, true);
    const unknown = await rpc(server, { jsonrpc: '2.0', id: 5, method: 'resources/list' });
    assert.equal(unknown.json.error.code, -32601);
  } finally {
    await server.close();
  }
});
