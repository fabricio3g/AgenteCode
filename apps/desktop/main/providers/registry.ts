// ── Provider registry ──────────────────────────────────────────────────
// Resolution is a scan over the dialect table; every provider speaks the
// OpenAI-compatible protocol (Anthropic and Gemini were removed: their terms
// do not allow use from third-party clients like this one).
// Every provider object exposes the same surface: stream() chunks,
// complete(), and the model-catalog queries. Adding a provider is a row
// in dialects.ts, not a class.

import { resolveDialect, getDialect } from './dialects.ts';
import { createOpenAiProvider, type ProviderObject } from './openai-core.ts';

const adapters = new Map<string, ProviderObject>();

function adapterFor(dialectId: string): ProviderObject {
  let adapter = adapters.get(dialectId);
  if (!adapter) {
    const dialect = getDialect(dialectId);
    if (!dialect) throw new Error(`Unknown provider dialect "${dialectId}"`);
    adapter = createOpenAiProvider(dialect);
    adapters.set(dialectId, adapter);
  }
  return adapter;
}

/**
 * Resolve the provider for a route. Signature preserved from the old
 * registry — every caller (chat pipeline, agent runtime, IPC handlers)
 * keeps working unchanged.
 */
export function resolveProvider(providerName?: string, baseUrl?: string): ProviderObject {
  const dialect = resolveDialect(providerName, baseUrl);
  return adapterFor(dialect.id);
}
