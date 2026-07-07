import type { IpcMain } from 'electron';

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
  getReasoningCapabilities?: (apiKey: string, baseUrl: string, modelId: string, modelPath?: string) => Promise<unknown>;
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

  ipcMain.handle('get_reasoning_capabilities', async (_e, { baseUrl, apiKey, providerName, model, modelPath }) => {
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    if (!provider.getReasoningCapabilities) {
      return { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' };
    }
    try {
      return await provider.getReasoningCapabilities(realKey, baseUrl, model, modelPath);
    } catch {
      return { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' };
    }
  });
}
