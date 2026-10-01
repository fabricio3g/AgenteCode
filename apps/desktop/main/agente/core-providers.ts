// The Rust core owns provider keys, in the store the TUI shares
// (`auth.json`). Desktop saves them through the daemon, reads
// them back from that file for its own direct calls, and moves keys it kept
// itself into the core once.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgenteRpcError, type AgenteClient } from '../agente-client.ts';

type Rpc = Pick<AgenteClient, 'request'>;

type ProviderStatus = { id: string; connected: boolean; stored_key: boolean; base_url: string | null };
type CoreProviderStatus = { providers: ProviderStatus[]; default_provider: string; default_model: string };

/** The core's auth.json: under AGENTE_CONFIG_DIR, else the platform data dir (Rust `dirs::data_dir`). */
export function coreAuthPath(): string {
  if (process.env.AGENTE_CONFIG_DIR) return path.join(process.env.AGENTE_CONFIG_DIR, 'auth.json');
  const home = os.homedir();
  let data = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  if (process.platform === 'win32') data = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  else if (process.platform === 'darwin') data = path.join(home, 'Library', 'Application Support');
  return path.join(data, 'agente', 'auth.json');
}

let cached: { mtimeMs: number; keys: Record<string, string> } | null = null;

/** Keys the core holds, by provider id. Read-only: writes go through the daemon. */
function coreKeys(): Record<string, string> {
  try {
    const file = coreAuthPath();
    const { mtimeMs } = fs.statSync(file);
    if (cached?.mtimeMs !== mtimeMs) {
      const entries = (JSON.parse(fs.readFileSync(file, 'utf8')).entries || {}) as Record<string, { key?: string; token?: string }>;
      const keys = Object.entries(entries).map(([id, entry]) => [id, entry.key || entry.token || ''] as const);
      cached = { mtimeMs, keys: Object.fromEntries(keys.filter(([, key]) => key)) };
    }
    return cached.keys;
  } catch {
    return {};
  }
}

export function coreKey(providerId?: string): string {
  return providerId ? coreKeys()[providerId] || '' : '';
}

/** The core's providers, or null from a binary that predates provider settings. */
export async function coreProviderStatus(client: Rpc): Promise<CoreProviderStatus | null> {
  try {
    return await client.request<CoreProviderStatus>('providers.status', {});
  } catch (error) {
    if (error instanceof AgenteRpcError && error.code === -32601) return null;
    throw error;
  }
}

/** Providers the core offers itself; Desktop keeps keys for the rest (custom endpoints). */
async function coreOfferedIds(client: Rpc): Promise<Set<string> | null> {
  const status = await coreProviderStatus(client);
  return status ? new Set(status.providers.map((provider) => provider.id)) : null;
}

type KeyedProviders = Record<string, { api_key?: string }>;

/**
 * Pull newly typed keys of core-offered providers out of a Desktop config
 * write and save them in the core instead (an empty key means "unchanged");
 * `forget` then drops Desktop's own copy. Without a core that has provider
 * settings, the write stays as it is.
 */
export async function routeKeysToCore(connect: () => Promise<Rpc>, providers: KeyedProviders | undefined, forget: (id: string) => void): Promise<void> {
  const keyed = Object.entries(providers || {}).filter(([, provider]) => provider?.api_key?.trim());
  if (!keyed.length) return;
  const client = await connect().catch(() => null);
  const offered = client && (await coreOfferedIds(client).catch(() => null));
  if (!client || !offered) return;
  for (const [id, provider] of keyed) {
    if (!offered.has(id)) continue;
    try {
      await client.request('providers.connect', { id, api_key: provider.api_key });
    } catch (error) {
      // Keep it in Desktop rather than lose it; the next start moves it.
      console.warn(`[agente] could not save the ${id} key in the core: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    delete provider.api_key;
    forget(id);
  }
}

/** The renderer sees only `has_api_key`: providers with a key in the core have one. */
export function flagCoreKeys(providers: Record<string, { has_api_key?: boolean }>): void {
  for (const id of Object.keys(coreKeys())) providers[id] = { ...providers[id], has_api_key: true };
}

/**
 * Move keys Desktop kept for core-offered providers into the core (unless
 * the core already has one), then drop Desktop's copy. `forget` clears one
 * provider's key from Desktop's own store.
 */
export async function migrateKeysToCore(client: Rpc, providers: KeyedProviders, forget: (id: string) => void): Promise<void> {
  const status = await coreProviderStatus(client);
  if (!status) return;
  for (const entry of status.providers) {
    const key = providers[entry.id]?.api_key;
    if (!key) continue;
    if (!entry.stored_key) await client.request('providers.connect', { id: entry.id, api_key: key });
    forget(entry.id);
  }
}
