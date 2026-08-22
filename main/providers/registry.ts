// ── Provider registry ──────────────────────────────────────────────────
// Resolution is a scan over the dialect table plus two real adapters.
// Every provider object exposes the same surface: stream() chunks,
// complete(), and the model-catalog queries. Adding a provider is a row
// in dialects.ts, not a class.

import { DIALECTS, resolveDialect, getDialect } from './dialects.ts';
import { createOpenAiProvider, type ProviderObject } from './openai-core.ts';
import { anthropicProvider } from './anthropic.ts';
import { geminiProvider } from './gemini.ts';

const adapters = new Map<string, ProviderObject>();

function adapterFor(dialectId: string): ProviderObject {
  let adapter = adapters.get(dialectId);
  if (!adapter) {
    if (dialectId === 'anthropic') adapter = anthropicProvider as unknown as ProviderObject;
    else if (dialectId === 'gemini') adapter = geminiProvider as unknown as ProviderObject;
    else {
      const dialect = getDialect(dialectId);
      if (!dialect) throw new Error(`Unknown provider dialect "${dialectId}"`);
      adapter = createOpenAiProvider(dialect);
    }
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

/** The live provider directory (dsh's configurable-provider list). */
export function listProviders(): Array<{ id: string; label: string; group: 'cloud' | 'local' }> {
  return DIALECTS.map((d) => ({ id: d.id, label: d.label, group: d.group }));
}
