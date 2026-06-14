import { mergeAndRankResults } from '../shared.ts';
import type { SearchResult } from '../shared.ts';
import { SUPPORTED_AGGREGATOR_ENGINES } from './constants.ts';
import { runAggregatorEngine } from './engines.ts';
import { normalizeAggregatorEngines } from './options.ts';

export { normalizeAggregatorEngines } from './options.ts';

export async function searchAggregator(query: string, maxResults: number, options: Record<string, unknown> = {}): Promise<SearchResult[]> {
  const engines = normalizeAggregatorEngines(options?.aggregator_engines, options);
  if (!engines.length) return [];

  const perEngineLimit = Math.max(3, Math.min(maxResults, 10));
  const settled = await Promise.allSettled(
    engines.map((engine) => runAggregatorEngine(engine, query, perEngineLimit, options))
  );

  const results: SearchResult[] = [];
  const errors: Array<{ engine: string; error: string }> = [];
  for (let index = 0; index < settled.length; index += 1) {
    const entry = settled[index];
    const engine = engines[index];
    if (entry.status === 'fulfilled') {
      results.push(...entry.value.map((result) => ({
        ...result,
        provider: 'aggregator',
        providers: [...new Set(['aggregator', ...(result.providers || []), result.provider].filter(Boolean))],
        metadata: { ...(result.metadata || {}), aggregator_engine: engine },
      })));
    } else {
      errors.push({ engine, error: entry.reason?.message || String(entry.reason || 'Search failed') });
    }
  }

  return mergeAndRankResults(results, query, maxResults).map((result, index) => ({
    ...result,
    provider: 'aggregator',
    source_rank: index + 1,
    metadata: { ...(result.metadata || {}), aggregator_errors: errors },
  }));
}

export function getSupportedAggregatorEngines(): string[] {
  return [...SUPPORTED_AGGREGATOR_ENGINES];
}
