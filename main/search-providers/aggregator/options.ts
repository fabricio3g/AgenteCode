import { DEFAULT_AGGREGATOR_ENGINES, SUPPORTED_AGGREGATOR_ENGINES } from './constants.ts';
import type { AggregatorEngineId } from './constants.ts';

export function safeSearchLevel(options: Record<string, unknown>): number {
  const level = Number(options?.safe_search ?? options?.safeSearch ?? 2);
  if (!Number.isFinite(level)) return 2;
  return Math.max(0, Math.min(4, level));
}

export function normalizeAggregatorEngines(value: unknown, options: Record<string, unknown> = {}): AggregatorEngineId[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : DEFAULT_AGGREGATOR_ENGINES;

  const engines = raw
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);

  if (options?.searxng_base_url && !engines.includes('searxng')) {
    engines.push('searxng');
  }

  return [...new Set(engines)].filter((engine): engine is AggregatorEngineId => {
    if (engine === 'searxng') return !!options?.searxng_base_url;
    return SUPPORTED_AGGREGATOR_ENGINES.includes(engine as AggregatorEngineId);
  });
}
