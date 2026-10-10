import type { RequestMessage } from '$lib/services/chat/types';
import type { ApiModelMetadataValue, ContextBudgetValue, InvokeFn } from '$lib/stores/app-context-budget';
import { buildApiContextBudgetFromMessages, buildFallbackContextBudget, buildLocalContextBudget, inferContextWindowFromModel } from '$lib/stores/app-context-budget';

const METADATA_PREVIEW_TIMEOUT_MS = 5000;

async function awaitMetadataForPreview(fetchMetadata: () => Promise<ApiModelMetadataValue | null>): Promise<ApiModelMetadataValue | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchMetadata().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), METADATA_PREVIEW_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolve a context-budget preview for local/runtime or provider/API mode. */
export async function resolveContextBudgetPreview(params: {
  backendMode: 'api' | 'local';
  invoke: InvokeFn;
  messages: RequestMessage[];
  localContextLength?: number;
  localMaxTokens?: number;
  providerMaxTokens?: number;
  activeProviderModel?: string;
  activeProviderName: string;
  readCachedMetadata: (cacheKey: string) => ApiModelMetadataValue | null;
  fetchMetadata: (providerName: string, model: string) => Promise<ApiModelMetadataValue | null>;
}): Promise<ContextBudgetValue | null> {
  if (params.backendMode === 'local') {
    const budget = await buildLocalContextBudget({
      invoke: params.invoke,
      contextLength: params.localContextLength,
      maxTokens: params.localMaxTokens,
      messages: params.messages
    });
    return budget || buildFallbackContextBudget({
      messages: params.messages,
      contextWindow: params.localContextLength,
      maxTokens: params.localMaxTokens
    });
  }

  const model = params.activeProviderModel;
  if (!model) {
    return buildFallbackContextBudget({
      messages: params.messages,
      contextWindow: 4096,
      maxTokens: params.providerMaxTokens
    });
  }

  const cacheKey = `${params.activeProviderName}:${model}`;
  let modelMetadata = params.readCachedMetadata(cacheKey);
  if (!modelMetadata) {
    modelMetadata = await awaitMetadataForPreview(() => params.fetchMetadata(params.activeProviderName, model));
  }
  const contextWindow = modelMetadata?.context_window || null;
  if (!contextWindow || !modelMetadata) {
    return buildFallbackContextBudget({
      messages: params.messages,
      contextWindow: inferContextWindowFromModel(params.activeProviderName, model) || 4096,
      maxTokens: params.providerMaxTokens
    });
  }

  return buildApiContextBudgetFromMessages({
    invoke: params.invoke,
    messages: params.messages,
    contextWindow,
    providerMaxTokens: params.providerMaxTokens,
    modelMetadata
  });
}
