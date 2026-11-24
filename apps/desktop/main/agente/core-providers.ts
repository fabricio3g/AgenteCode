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
      const keys = Object.entries(entries)
        .filter(([id]) => !id.includes(':'))
        .map(([id, entry]) => [id, entry.key || entry.token || ''] as const);
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

type ProviderEntry = { api_key?: string; has_api_key?: boolean; base_url?: string; model?: string };
type KeyedProviders = Record<string, ProviderEntry>;
type LlmConfigSlice = { provider?: string; providers?: KeyedProviders };

const CORE_ENV_VARS: Record<string, readonly string[]> = {
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  glm: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY']
};

/**
 * Sync provider credentials, explicit disconnects, changed base URLs, and
 * default provider/model from a Desktop config write into the Rust core.
 *
 * Newly typed keys of core-offered providers are saved in the core (`auth.json`)
 * and stripped from `llm.providers`, calling `forget(id)` to drop Desktop's copy.
 */
export async function syncProvidersToCore(
  connect: () => Promise<Rpc>,
  llm: LlmConfigSlice | undefined,
  previousLlm: LlmConfigSlice | undefined,
  forget: (id: string) => void
): Promise<void> {
  if (!llm) return;
  const providers = llm.providers || {};
  const prevProviders = previousLlm?.providers || {};

  const hasWork =
    Object.entries(providers).some(([id, p]) => {
      if (p?.api_key?.trim()) return true;
      if (p?.has_api_key === false) return true;
      const nextUrl = p?.base_url?.trim();
      const prevUrl = prevProviders[id]?.base_url?.trim();
      if (nextUrl !== undefined && nextUrl !== prevUrl) return true;
      return false;
    })
    || (!!llm.provider && llm.provider !== 'local');

  if (!hasWork) return;

  const client = await connect().catch(() => null);
  const status = client && (await coreProviderStatus(client).catch(() => null));
  if (!client || !status) return;

  const statusById = new Map(status.providers.map((entry) => [entry.id, entry]));

  for (const [id, provider] of Object.entries(providers)) {
    const coreEntry = statusById.get(id);
    if (!coreEntry) continue;

    const nextKey = provider?.api_key?.trim() || '';
    const nextUrl = provider?.base_url?.trim();
    const prevUrl = prevProviders[id]?.base_url?.trim();
    const urlChanged = nextUrl !== undefined && nextUrl !== prevUrl;

    if (!nextKey && provider?.has_api_key === false && coreEntry.stored_key) {
      try {
        await client.request('providers.disconnect', { id });
        forget(id);
      } catch (error) {
        console.warn(`[agente] could not disconnect ${id} in the core: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    if (nextKey || urlChanged) {
      try {
        await client.request('providers.connect', {
          id,
          ...(nextKey ? { api_key: nextKey } : {}),
          ...(urlChanged ? { base_url: nextUrl } : {})
        });
      } catch (error) {
        // Keep it in Desktop rather than lose it; the next start moves it.
        console.warn(`[agente] could not save ${id} in the core: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (nextKey) {
        delete provider.api_key;
        forget(id);
      }
    }
  }

  const activeProvider = llm.provider?.trim();
  if (activeProvider && statusById.has(activeProvider)) {
    const activeModel =
      providers[activeProvider]?.model?.trim()
      || prevProviders[activeProvider]?.model?.trim()
      || '';
    if (
      activeModel
      && (activeProvider !== status.default_provider || activeModel !== status.default_model)
    ) {
      try {
        await client.request('providers.set_default', { provider: activeProvider, model: activeModel });
      } catch (error) {
        console.warn(`[agente] could not sync default model to the core: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/**
 * Pull newly typed keys of core-offered providers out of a Desktop config
 * write and save them in the core instead (an empty key means "unchanged");
 * `forget` then drops Desktop's own copy.
 */
export async function routeKeysToCore(connect: () => Promise<Rpc>, providers: KeyedProviders | undefined, forget: (id: string) => void): Promise<void> {
  await syncProvidersToCore(connect, { providers }, undefined, forget);
}

/** The renderer sees only `has_api_key`: providers with a key in the core (or env) have one. */
export function flagCoreKeys(
  providers: Record<string, { has_api_key?: boolean }>,
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const id of Object.keys(coreKeys())) {
    if (id.includes(':')) continue;
    providers[id] = { ...providers[id], has_api_key: true };
  }
  for (const [id, vars] of Object.entries(CORE_ENV_VARS)) {
    if (vars.some((name) => Boolean(env[name]?.trim()))) {
      providers[id] = { ...providers[id], has_api_key: true };
    }
  }
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
