import type { ApiModelMetadataValue } from '$lib/stores/app-context-budget';
import { normalizeApiModelMetadata, type InvokeFn } from '$lib/stores/app-context-budget';

/** Stable metadata cache key for provider-model pair. */
export function buildApiModelMetadataCacheKey(providerName: string, model: string): string {
  return `${providerName}:${model}`;
}

/** Fetch and normalize metadata from the backend API-model context endpoint. */
export async function fetchApiModelMetadataFromProvider(params: {
  invoke: InvokeFn;
  providerName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}): Promise<ApiModelMetadataValue | null> {
  const result = await params.invoke<unknown>('get_api_model_context', {
    providerName: params.providerName,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    modelId: params.model
  });
  return normalizeApiModelMetadata(result);
}

/** Read from cache first, otherwise execute provided fetch callback. */
export async function getCachedOrFetchApiModelMetadata(params: {
  providerName: string;
  model: string;
  cache: Record<string, ApiModelMetadataValue>;
  fetchFresh: () => Promise<ApiModelMetadataValue | null>;
}): Promise<ApiModelMetadataValue | null> {
  const cacheKey = buildApiModelMetadataCacheKey(params.providerName, params.model);
  const cached = params.cache[cacheKey];
  if (cached) return cached;
  return params.fetchFresh();
}
