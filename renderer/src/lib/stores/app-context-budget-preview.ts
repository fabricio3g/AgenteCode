import type { RequestMessage } from '$lib/services/chat-api';
import type { ApiModelMetadataValue, ContextBudgetValue, InvokeFn } from '$lib/stores/app-context-budget';
import { buildApiContextBudgetFromMessages, buildLocalContextBudget } from '$lib/stores/app-context-budget';

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
    return buildLocalContextBudget({
      invoke: params.invoke,
      contextLength: params.localContextLength,
      maxTokens: params.localMaxTokens,
      messages: params.messages
    });
  }

  const model = params.activeProviderModel;
  if (!model) return null;

  const cacheKey = `${params.activeProviderName}:${model}`;
  let modelMetadata = params.readCachedMetadata(cacheKey);
  if (!modelMetadata) {
    modelMetadata = await params.fetchMetadata(params.activeProviderName, model);
  }
  const contextWindow = modelMetadata?.context_window || null;
  if (!contextWindow || !modelMetadata) return null;

  return buildApiContextBudgetFromMessages({
    invoke: params.invoke,
    messages: params.messages,
    contextWindow,
    providerMaxTokens: params.providerMaxTokens,
    modelMetadata
  });
}
