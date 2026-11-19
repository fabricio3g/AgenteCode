// Settings → Search drives the core's `web_search` too (Code space, TUI):
// the choice, the SearXNG URL and the keyed providers' keys go to the
// daemon's `web.sync`, which writes the core's `web.json` and `auth.json`.
// Desktop stays the source of truth: every sync sends the whole picture.

import { AgenteRpcError, type AgenteClient } from '../agente-client.ts';

type Rpc = Pick<AgenteClient, 'request'>;

type SearchSettings = {
  provider?: string;
  max_results?: number;
  providers?: Record<string, { api_key?: unknown; base_url?: unknown } | undefined>;
};

export type WebSyncPayload = {
  provider: string;
  max_results?: number;
  searxng_url?: string;
  keys: Record<string, string>;
};

/** Providers the core can search with a key. */
const KEYED = ['brave', 'tavily', 'exa'] as const;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** What `web.sync` gets for Desktop's search settings. */
export function webSyncPayload(search: SearchSettings | undefined): WebSyncPayload {
  const providers = search?.providers || {};
  const keys: Record<string, string> = {};
  for (const id of KEYED) {
    const key = text(providers[id]?.api_key);
    if (key) keys[id] = key;
  }
  const payload: WebSyncPayload = { provider: text(search?.provider) || 'auto', keys };
  const searxng = text(providers.searxng?.base_url);
  if (searxng) payload.searxng_url = searxng;
  const max = Number(search?.max_results);
  if (Number.isFinite(max) && max > 0) payload.max_results = Math.round(max);
  return payload;
}

let lastSynced = '';

/**
 * Hand Desktop's search settings to the core. A payload this process already
 * sent connects to nothing; a core without `web.sync` (older binary) is left
 * alone.
 */
export async function syncWebSearchToCore(connect: () => Promise<Rpc>, search: SearchSettings | undefined): Promise<void> {
  const payload = webSyncPayload(search);
  const signature = JSON.stringify(payload);
  if (signature === lastSynced) return;
  try {
    await (await connect()).request('web.sync', payload);
    lastSynced = signature;
  } catch (error) {
    if (error instanceof AgenteRpcError && error.code === -32601) return;
    throw error;
  }
}
