import type { ModelOption } from '$lib/types/chat';

type Listed = string | { id?: unknown; name?: unknown; availability?: unknown };

/**
 * `fetch_provider_models` answers with the provider's live ids merged with
 * models.dev's record (retired and unlisted models marked). Older builds and
 * keyless local runtimes still answer with plain ids; both shapes land here.
 */
export function listedModels(raw: unknown): ModelOption[] {
  if (!Array.isArray(raw)) throw new Error('Invalid provider model list');
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const entry of raw as Listed[]) {
    const id = String(typeof entry === 'string' ? entry : entry?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const availability = typeof entry === 'object' && (entry.availability === 'retired' || entry.availability === 'catalog')
      ? entry.availability
      : undefined;
    out.push({ id, name: id, source: 'api', ...(availability ? { availability } : {}) });
  }
  return out;
}
