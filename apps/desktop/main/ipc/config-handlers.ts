import type { IpcMain } from 'electron';
import type { AppConfigLike } from './types.ts';
import { flagCoreKeys, routeKeysToCore } from '../agente/core-providers.ts';
import { syncWebSearchToCore } from '../agente/core-web.ts';
import { forgetProviderKey } from '../config.ts';

type ConfigHandlerDeps = {
  ipcMain: IpcMain;
  loadConfig: () => unknown;
  redactConfig: (cfg: unknown) => unknown;
  loadConfigFromDisk: () => unknown;
  saveConfig: (cfg: unknown) => unknown;
  updateConfig: (partial: unknown) => unknown;
};

function mergeRedactedProviderKeys(cfg: AppConfigLike, diskConfig: AppConfigLike): void {
  const incomingProviders = cfg.llm?.providers || {};
  const diskProviders = diskConfig.llm?.providers || {};

  for (const [name, provider] of Object.entries(incomingProviders)) {
    if (!provider.api_key && diskProviders[name]?.api_key) {
      provider.api_key = diskProviders[name]?.api_key;
    }
    delete provider.has_api_key;
  }

  const incomingSearchProviders = cfg.search?.providers || {};
  const diskSearchProviders = diskConfig.search?.providers || {};
  for (const [name, provider] of Object.entries(incomingSearchProviders)) {
    if (!provider.api_key && diskSearchProviders[name]?.api_key) {
      provider.api_key = diskSearchProviders[name]?.api_key;
    }
    delete provider.has_api_key;
  }
  for (const section of ['tts', 'stt'] as const) {
    const incoming = (cfg[section] as { providers?: Record<string, { api_key?: string; has_api_key?: boolean }> } | undefined)?.providers ?? {};
    const disk = (diskConfig[section] as { providers?: Record<string, { api_key?: string }> } | undefined)?.providers ?? {};
    for (const [name, provider] of Object.entries(incoming)) {
      if (!provider.api_key && disk[name]?.api_key) provider.api_key = disk[name].api_key;
      delete provider.has_api_key;
    }
  }
}

export function registerConfigHandlers({
  ipcMain,
  loadConfig,
  redactConfig,
  loadConfigFromDisk,
  saveConfig,
  updateConfig,
}: ConfigHandlerDeps): void {
  ipcMain.handle('get_config', () => {
    const redacted = redactConfig(loadConfig()) as AppConfigLike;
    if (redacted.llm) flagCoreKeys((redacted.llm.providers ??= {}));
    return redacted;
  });

  // Keys of providers the Rust core offers go to its store, not Desktop's.
  const runtime = async () => (await import('../agente/rust-engine.ts')).runtimeConnection();
  ipcMain.handle('save_config', async (_e, cfg) => {
    const diskConfig = loadConfigFromDisk() as AppConfigLike;
    const nextConfig = (cfg || {}) as AppConfigLike;
    mergeRedactedProviderKeys(nextConfig, diskConfig);
    await routeKeysToCore(runtime, nextConfig.llm?.providers, forgetProviderKey);
    void forgetThinkingRoutes();
    const saved = saveConfig(nextConfig);
    syncSearch();
    return saved;
  });

  ipcMain.handle('update_config', async (_e, partial) => {
    await routeKeysToCore(runtime, (partial as AppConfigLike | undefined)?.llm?.providers, forgetProviderKey);
    void forgetThinkingRoutes();
    const updated = await updateConfig(partial);
    if ((partial as AppConfigLike | undefined)?.search) syncSearch();
    return updated;
  });

  /** Settings → Search also drives the core's web_search (Code space, TUI). */
  function syncSearch(): void {
    const search = (loadConfig() as AppConfigLike).search;
    void syncWebSearchToCore(runtime, search).catch((error: unknown) => {
      console.warn(`[agente] web search settings not synced: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

/** Provider keys, URLs or models may have changed: re-resolve thinking routes. */
async function forgetThinkingRoutes(): Promise<void> {
  const { resetThinkingCache } = await import('../agente/thinking.ts');
  resetThinkingCache();
}
