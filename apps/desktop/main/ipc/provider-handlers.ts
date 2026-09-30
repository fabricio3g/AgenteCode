import type { IpcMain } from 'electron';
import { getDialect, resolveDialect } from '../providers/dialects.ts';
import { testProviderConnection } from '../providers/connection-test.ts';

type Provider = {
  name: string;
  fetchModels: (apiKey: string, baseUrl?: string) => Promise<unknown>;
  fetchModelMetadata: (apiKey: string, baseUrl: string, modelId: string) => Promise<unknown>;
  checkToolSupport: (args: {
    baseUrl: string;
    apiKey: string;
    model?: string;
    modelPath?: string;
    providerName?: string;
  }) => Promise<unknown>;
};

type ProviderHandlerDeps = {
  ipcMain: IpcMain;
  resolveProvider: (providerName?: string, baseUrl?: string) => Provider;
  resolveApiKey: (apiKey: string, baseUrl: string, providerName?: string) => string;
};

export function registerProviderHandlers({ ipcMain, resolveProvider, resolveApiKey }: ProviderHandlerDeps): void {
  ipcMain.handle('fetch_provider_models', async (_e, { baseUrl, apiKey, providerName }) => {
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    if (!realKey && provider.name !== 'local') {
      throw new Error(`No API key configured for ${providerName || 'the selected provider'}. Please add your API key in Settings > LLM Providers.`);
    }
    return provider.fetchModels(realKey, baseUrl);
  });

  ipcMain.handle('test_provider_connection', async (_e, { baseUrl, apiKey, providerName }) => {
    const dialect = getDialect(String(providerName || '')) ?? resolveDialect(providerName, baseUrl);
    return testProviderConnection({
      dialect,
      baseUrl,
      apiKey: resolveApiKey(apiKey, baseUrl, providerName),
      requireKey: dialect.group === 'cloud'
    });
  });

  ipcMain.handle('get_api_model_context', async (_e, { baseUrl, apiKey, providerName, modelId }) => {
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    if (!realKey && provider.name !== 'local') {
      return null;
    }
    return provider.fetchModelMetadata(realKey, baseUrl, modelId);
  });

  ipcMain.handle('detect_tool_support', async (_e, { baseUrl, apiKey, providerName, model, modelPath }) => {
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    return provider.checkToolSupport({
      baseUrl,
      apiKey: realKey,
      model,
      modelPath,
      providerName,
    });
  });

  // The provider directory is the core's TOML specs, the same list the TUI offers.
  ipcMain.handle('list_provider_specs', async () => {
    const { listProviderSpecs } = await import('../agente/thinking.ts');
    return listProviderSpecs();
  });

  // Levels come from the shared core, the same profile the TUI shows.
  ipcMain.handle('get_reasoning_capabilities', async (_e, { providerName, model }) => {
    const { reasoningCapabilities } = await import('../agente/thinking.ts');
    return reasoningCapabilities(String(providerName || ''), String(model || ''));
  });
}
