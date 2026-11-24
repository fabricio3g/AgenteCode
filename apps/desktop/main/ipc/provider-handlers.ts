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
    const named = String(providerName || '').trim();
    // Delegate saved core cloud providers to Rust `models.discover` (handles
    // OpenRouter reasoning metadata, Anthropic paging, and models.dev enrichment
    // in one native call without duplicating /models fetching in TS).
    if (named && !apiKey && named !== 'local' && named !== 'llamacpp' && named !== 'lmstudio' && named !== 'ollama' && named !== 'custom') {
      try {
        const { runtimeConnection } = await import('../agente/rust-engine.ts');
        const client = await runtimeConnection();
        const [discovered, catalog] = await Promise.all([
          client.request<{ models?: Array<{ id: string }> }>('models.discover', { provider: named }),
          coreCatalogModels(named).catch(() => [])
        ]);
        const liveIds = (discovered?.models ?? []).map((m) => String(m.id)).filter(Boolean);
        if (liveIds.length > 0) {
          onModelsRefreshed?.(named);
          return mergeModelLists(liveIds, catalog);
        }
      } catch {
        // Fall through to TS dialect fetch if daemon is offline or provider has an unsaved baseUrl.
      }
    }
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    if (!realKey && provider.dialect.group === 'cloud') {
      throw new Error(`No API key configured for ${providerName || 'the selected provider'}. Please add your API key in Settings > LLM Providers.`);
    }
    const live = await provider.fetchModels(realKey, baseUrl);
    if (providerName) onModelsRefreshed?.(providerName);
    if (!providerName || providerName === 'local' || !Array.isArray(live)) return live;
    // Models.dev rows the provider does not list follow, marked; retired ones
    // never show (the core's `catalog_extras` decides which).
    const catalog = await coreCatalogModels(providerName).catch(() => []);
    return mergeModelLists(live.map(String), catalog);
  });

  ipcMain.handle('test_provider_connection', async (_e, { baseUrl, apiKey, providerName }) => {
    const named = String(providerName || '').trim();
    // Delegate saved core provider checks to Rust (honors TOML specs, env keys,
    // and non-OpenAI formats like MiniMax/GLM/OpenCode without duplicating HTTP logic).
    if (named && !apiKey && named !== 'local' && named !== 'custom') {
      try {
        const { runtimeConnection } = await import('../agente/rust-engine.ts');
        const client = await runtimeConnection();
        const tested = await client.request<{ ok: boolean; models?: string[]; count?: number; latency_ms?: number }>('providers.test', { provider: named });
        if (tested?.ok) {
          return { ok: true, models: Array.isArray(tested.models) ? tested.models : [] };
        }
      } catch {
        // Fall through to the direct dialect probe when testing an unsaved custom URL/draft.
      }
    }
    const dialect = getDialect(named) ?? resolveDialect(providerName, baseUrl);
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
    // Fast path: ask Rust's catalog (`models.info`) before burning a 12s live completion probe.
    const named = String(providerName || '').trim();
    if (named && model && named !== 'local' && named !== 'llamacpp' && named !== 'lmstudio' && named !== 'ollama' && named !== 'custom') {
      try {
        const card = await modelCard(named, String(model));
        if (card.tools) {
          return { supported: true, source: 'core-catalog' };
        }
      } catch {
        // Fall through to live probe if daemon is unavailable.
      }
    }
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

  // What the model picker's card shows: window, output cap, prices and what the
  // model accepts, all from the core's catalog (models.dev + live lists).
  ipcMain.handle('get_model_card', async (_e, { providerName, model }) => modelCard(String(providerName || ''), String(model || '')));

  // Levels come from the shared core, the same profile the TUI shows.
  ipcMain.handle('get_reasoning_capabilities', async (_e, { providerName, model }) => {
    const { reasoningCapabilities } = await import('../agente/thinking.ts');
    return reasoningCapabilities(String(providerName || ''), String(model || ''));
  });
}

type CoreModelInfo = { limits?: { context?: number | null; output?: number | null }; cost?: { input?: number | null; output?: number | null } | null };

function optionalPrice(value: number | null | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value >= 0 ? value : undefined;
}

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
    prompt_cost_per_million: optionalPrice(info.cost?.input),
    completion_cost_per_million: optionalPrice(info.cost?.output)
  };
}

type CoreModelCard = {
  limits?: { context?: number | null; output?: number | null };
  cost?: { input?: number | null; output?: number | null; cache_read?: number | null } | null;
  capabilities?: { reasoning?: boolean; toolcall?: boolean; vision?: boolean; input_modalities?: string[] } | null;
};

/** Numbers the core does not know come back null, never 0, so the card can leave them out. */
async function modelCard(providerName: string, modelId: string) {
  const { runtimeConnection } = await import('../agente/rust-engine.ts');
  const client = await runtimeConnection();
  const info = await client.request<CoreModelCard>('models.info', { provider: providerName, model: modelId });
  const known = (value: unknown) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  const caps = info.capabilities ?? {};
  const inputs = Array.isArray(caps.input_modalities) && caps.input_modalities.length
    ? caps.input_modalities.map(String)
    : caps.vision ? ['text', 'image'] : [];
  return {
    context: known(info.limits?.context),
    output: known(info.limits?.output),
    cost: info.cost ? { input: info.cost.input ?? null, output: info.cost.output ?? null, cacheRead: known(info.cost.cache_read) } : null,
    inputs,
    tools: caps.toolcall === true,
    reasoning: caps.reasoning === true
  };
}
