import type { IpcMain } from 'electron';
import { getDialect, resolveDialect } from '../providers/dialects.ts';
import { testProviderConnection } from '../providers/connection-test.ts';
import { mergeModelLists, type CatalogEntry } from '../providers/model-list-merge.ts';

type Provider = {
  name: string;
  /** Local servers (llama.cpp, Ollama, LM Studio, custom) take no key. */
  dialect: { group: 'cloud' | 'local' };
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
  onModelsRefreshed?: (providerName: string) => void;
};

export function registerProviderHandlers({ ipcMain, resolveProvider, resolveApiKey, onModelsRefreshed }: ProviderHandlerDeps): void {
  ipcMain.handle('fetch_provider_models', async (_e, { baseUrl, apiKey, providerName }) => {
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    if (!realKey && provider.dialect.group === 'cloud') {
      throw new Error(`No API key configured for ${providerName || 'the selected provider'}. Please add your API key in Settings > LLM Providers.`);
    }
    const live = await provider.fetchModels(realKey, baseUrl);
    if (providerName) onModelsRefreshed?.(providerName);
    if (!providerName || providerName === 'local' || !Array.isArray(live)) return live;
    // What the provider no longer lists (retired) or never listed still shows,
    // from models.dev, marked as such.
    const catalog = await coreCatalogModels(providerName).catch(() => []);
    return mergeModelLists(live.map(String), catalog);
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
    // The window the Rust core compacts against (registry, live discovery,
    // models.dev), so Home's meter matches Code's and the TUI's.
    const fromCore = providerName && providerName !== 'local' ? await coreModelContext(providerName, modelId).catch(() => null) : null;
    if (fromCore) return fromCore;
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    if (!realKey && provider.dialect.group === 'cloud') {
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

type CoreModelInfo = { limits?: { context?: number | null; output?: number | null }; cost?: { input?: number | null; output?: number | null } | null };

/** A model's window, output cap and prices as the core knows them; null when it knows no window. */
async function coreCatalogModels(providerName: string): Promise<CatalogEntry[]> {
  const { runtimeConnection } = await import('../agente/rust-engine.ts');
  const client = await runtimeConnection();
  const result = await client.request<{ models?: CatalogEntry[] }>('models.catalog', { provider: providerName });
  return Array.isArray(result.models) ? result.models : [];
}

async function coreModelContext(providerName: string, modelId: string) {
  const { runtimeConnection } = await import('../agente/rust-engine.ts');
  const client = await runtimeConnection();
  const info = await client.request<CoreModelInfo>('models.info', { provider: providerName, model: modelId });
  const contextWindow = Number(info.limits?.context);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return {
    context_window: contextWindow,
    max_completion_tokens: Number(info.limits?.output) || undefined,
    prompt_cost_per_million: Number(info.cost?.input) || undefined,
    completion_cost_per_million: Number(info.cost?.output) || undefined
  };
}
