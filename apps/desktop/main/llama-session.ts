import { randomBytes } from 'node:crypto';

/**
 * Per-run credentials for the local llama-server instances.
 *
 * Each server binds to 127.0.0.1 (or the LAN, when shared), but its CORS
 * policy defaults to `*` — so without a key, any web page the user has open
 * can POST to the port and drive their local model. A key is generated per
 * launch and per port, never persisted, and handed to the server via
 * `--api-key`.
 *
 * The main instance (the one chat uses by default) is tracked separately so
 * `llamaSessionHeaders()` keeps meaning "the server we launched for chat".
 *
 * `/health` and `/models` stay public in llama.cpp, so process supervision
 * keeps working without it.
 */
const keys = new Map<number, string>();
let mainPort: number | null = null;

/** Start a session for the main (chat) instance. */
export function startLlamaSession(port: number): string {
  mainPort = port;
  return startInstanceSession(port);
}

export function endLlamaSession(): void {
  if (mainPort != null) keys.delete(mainPort);
  mainPort = null;
}

/** A key for an extra instance on `port`. */
export function startInstanceSession(port: number): string {
  const key = randomBytes(24).toString('hex');
  keys.set(port, key);
  return key;
}

export function endInstanceSession(port: number): void {
  keys.delete(port);
}

function getLlamaSessionKey(): string {
  return mainPort != null ? keys.get(mainPort) ?? '' : '';
}

export function sessionKeyForPort(port: number): string {
  return keys.get(port) ?? '';
}

/** Returns the session key when `baseUrl` addresses a server we launched. */
export function resolveLlamaSessionKey(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(baseUrl || ''));
  } catch {
    return '';
  }
  const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (!isLoopback) return '';
  return keys.get(Number(parsed.port)) ?? '';
}

/** Authorization header for main-process calls to the main local server. */
export function llamaSessionHeaders(): Record<string, string> {
  const key = getLlamaSessionKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}
