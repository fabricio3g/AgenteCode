// ── Desktop tools for the Rust runtime (MCP) ───────────────────────────
// Some tools only exist inside the app: the in-app browser, for one. The
// Rust runtime already speaks MCP, so Desktop serves those tools as a tiny
// MCP server (Streamable HTTP, JSON responses) on 127.0.0.1 with a random
// bearer token, and registers it through runtime.configure. Read-only tools
// are marked so the runtime runs them without asking; the others follow its
// usual approval rules.

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentTool, ToolResult } from '../../shared/agent-core/types.ts';

const PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type DesktopToolServer = {
  url: string;
  token: string;
  close(): Promise<void>;
};

type RpcRequest = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

/** Tools that change nothing and go nowhere run without an approval. */
function isReadOnly(tool: AgentTool): boolean {
  return !tool.mutating && !tool.requiresApproval;
}

function toolList(tools: AgentTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    annotations: { readOnlyHint: isReadOnly(tool) }
  }));
}

function callResult(result: ToolResult) {
  return {
    content: [
      { type: 'text', text: result.content },
      ...(result.images ?? []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
    ],
    isError: !!result.isError
  };
}

async function callTool(tools: Map<string, AgentTool>, params: Record<string, unknown> = {}) {
  const tool = tools.get(String(params.name ?? ''));
  if (!tool) return callResult({ content: `Unknown tool ${String(params.name)}`, isError: true });
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    const signal = new AbortController().signal;
    return callResult(await tool.execute(`mcp-${crypto.randomUUID()}`, args, { signal }));
  } catch (error: unknown) {
    return callResult({ content: error instanceof Error ? error.message : String(error), isError: true });
  }
}

type Handler = (tools: Map<string, AgentTool>, params: Record<string, unknown> | undefined) => unknown;

const HANDLERS: Record<string, Handler> = {
  initialize: (_tools, params) => ({
    protocolVersion: String(params?.protocolVersion ?? PROTOCOL_VERSION),
    capabilities: { tools: {} },
    serverInfo: { name: 'agente-desktop', version: '1' }
  }),
  ping: () => ({}),
  'tools/list': (tools) => ({ tools: toolList([...tools.values()]) }),
  'tools/call': (tools, params) => callTool(tools, params)
};

/** The JSON-RPC result for one request. */
async function answer(tools: Map<string, AgentTool>, request: RpcRequest): Promise<unknown> {
  const handler = HANDLERS[String(request.method)];
  if (!handler) throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
  return handler(tools, request.params);
}

async function reply(tools: Map<string, AgentTool>, request: RpcRequest): Promise<unknown | undefined> {
  if (request.id === undefined) return undefined; // notification
  try {
    return { jsonrpc: '2.0', id: request.id, result: await answer(tools, request) };
  } catch (error: unknown) {
    const code = (error as { code?: number }).code ?? -32603;
    return { jsonrpc: '2.0', id: request.id, error: { code, message: error instanceof Error ? error.message : String(error) } };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** An HTTP status to refuse with, or null when the request may proceed. */
function refusal(token: string, req: http.IncomingMessage): number | null {
  if (req.headers.authorization !== `Bearer ${token}`) return 401;
  // No server-initiated stream: every answer rides its request.
  return req.method === 'POST' ? null : 405;
}

async function handle(tools: Map<string, AgentTool>, token: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const refused = refusal(token, req);
  if (refused) {
    res.writeHead(refused, refused === 405 ? { Allow: 'POST' } : {}).end();
    return;
  }
  const body = JSON.parse(await readBody(req)) as RpcRequest | RpcRequest[];
  const requests = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(requests.map((request) => reply(tools, request)))).filter((value) => value !== undefined);
  if (!replies.length) {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
}

/** Serve `tools` to the Rust runtime; resolves once listening. */
export function serveDesktopTools(tools: AgentTool[]): Promise<DesktopToolServer> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    handle(byName, token, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        token,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}
