import type { IpcMain } from 'electron';
import type { AppConfigLike } from './types.ts';

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
  ipcMain.handle('get_config', () => redactConfig(loadConfig()));

  ipcMain.handle('save_config', (_e, cfg) => {
    const diskConfig = loadConfigFromDisk() as AppConfigLike;
    const nextConfig = (cfg || {}) as AppConfigLike;
    mergeRedactedProviderKeys(nextConfig, diskConfig);
    return saveConfig(nextConfig);
  });

  ipcMain.handle('update_config', (_e, partial) => updateConfig(partial));
}
