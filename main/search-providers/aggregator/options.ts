import {
  AGGREGATOR_ENGINE_CATALOG,
  DEFAULT_AGGREGATOR_ENGINES,
  SUPPORTED_AGGREGATOR_ENGINES,
} from './constants.ts';
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

  return [...new Set(engines)].filter((engine): engine is AggregatorEngineId => {
    return SUPPORTED_AGGREGATOR_ENGINES.includes(engine as AggregatorEngineId);
  });
}

export function getEngineDefinition(engineId: string) {
  return AGGREGATOR_ENGINE_CATALOG.find((item) => item.id === engineId);
}

export function getEngineOption(options: Record<string, unknown>, engineId: string, key: 'api_key' | 'base_url'): string {
  const direct = options?.[`${engineId}_${key}`];
  const aliases: Record<string, string[]> = {
    fourget_base_url: ['fourget_url'],
    ollama_web_api_key: ['ollama_api_key'],
    perplexity_search_api_key: ['perplexity_api_key'],
    perplexity_search_base_url: ['perplexity_api_url'],
  };
  const aliasValue = aliases[`${engineId}_${key}`]?.map((name) => options?.[name]).find(Boolean);
  return String(direct || aliasValue || '').trim();
}

export function engineMissingRequirements(engineId: string, options: Record<string, unknown>): string[] {
  const definition = getEngineDefinition(engineId);
  if (!definition) return ['unsupported'];
  return definition.requires.filter((requirement) => !getEngineOption(options, engineId, requirement));
}
