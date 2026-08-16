import { randomBytes } from 'node:crypto';

/**
 * Per-run credential for the local llama-server.
 *
 * The server binds to 127.0.0.1, but its CORS policy defaults to `*` — so
 * without a key, any web page the user has open can POST to the port and drive
 * their local model. The key is generated per launch, never persisted, and
 * handed to the server via `--api-key`.
 *
 * `/health` and `/models` stay public in llama.cpp, so process supervision
 * keeps working without it.
 */
let sessionKey = '';
let sessionPort: number | null = null;

export function startLlamaSession(port: number): string {
  sessionKey = randomBytes(24).toString('hex');
  sessionPort = port;
  return sessionKey;
}

export function endLlamaSession(): void {
  sessionKey = '';
  sessionPort = null;
}

export function getLlamaSessionKey(): string {
  return sessionKey;
}

/** Returns the session key when `baseUrl` addresses the server we launched. */
export function resolveLlamaSessionKey(baseUrl: string): string {
  if (!sessionKey || sessionPort == null) return '';
  let parsed: URL;
  try {
    parsed = new URL(String(baseUrl || ''));
  } catch {
    return '';
  }
  const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (!isLoopback) return '';
  return Number(parsed.port) === sessionPort ? sessionKey : '';
}

/** Authorization header for main-process calls to the local server. */
export function llamaSessionHeaders(): Record<string, string> {
  return sessionKey ? { Authorization: `Bearer ${sessionKey}` } : {};
}
