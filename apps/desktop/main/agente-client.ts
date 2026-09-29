// ── Agente runtime client ──────────────────────────────────────────────
// Talks to `agente serve` (the Rust runtime) over its local socket: JSON-RPC
// 2.0, one message per line. Requests resolve with their result or reject
// with an AgenteRpcError; everything the server pushes (`event`,
// `turn.outcome`, `events.lagged`) goes to the notification listeners.

import net from 'node:net';

export class AgenteRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'AgenteRpcError';
    this.code = code;
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type NotificationListener = (method: string, params: unknown) => void;
type Incoming = { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

function parseMessage(line: string): Incoming | null {
  try {
    return JSON.parse(line) as Incoming;
  } catch {
    return null;
  }
}

export class AgenteClient {
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  private constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('close', () => this.shutdown(new Error('The Agente runtime connection closed.')));
    socket.on('error', (error) => this.shutdown(error));
  }

  static connect(socketPath: string): Promise<AgenteClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const fail = (error: Error) => reject(error);
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        resolve(new AgenteClient(socket));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(method: string, params: unknown = null, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The Agente runtime is not connected.'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agente runtime request ${method} timed out after ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.end();
    this.shutdown(new Error('The Agente runtime connection was closed.'));
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    const message = parseMessage(line);
    if (!message) return;
    if (typeof message.method === 'string' && message.id === undefined) {
      for (const listener of this.listeners) listener(message.method, message.params);
      return;
    }
    if (typeof message.id === 'number') this.settle(message.id, message);
  }

  private settle(id: number, message: Incoming): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (!message.error) {
      pending.resolve(message.result);
      return;
    }
    const code = Number(message.error.code ?? -32603);
    pending.reject(new AgenteRpcError(code, String(message.error.message ?? 'Agente runtime error')));
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.listeners.clear();
  }
}
