import { mergeAndRankResults } from '../shared.ts';
import type { SearchResult } from '../shared.ts';
import {
  AGGREGATOR_CONCURRENCY,
  AGGREGATOR_COOLDOWN_MS,
  AGGREGATOR_DEADLINE_MS,
  AGGREGATOR_ENGINE_CATALOG,
  AGGREGATOR_FAILURE_THRESHOLD,
  SUPPORTED_AGGREGATOR_ENGINES,
} from './constants.ts';
import type { AggregatorEngineId } from './constants.ts';
import { runAggregatorEngine } from './engines.ts';
import { engineMissingRequirements, getEngineOption, normalizeAggregatorEngines } from './options.ts';

export { normalizeAggregatorEngines } from './options.ts';

export interface AggregatorEngineAttempt {
  engine: string;
  success: boolean;
  result_count: number;
  latency_ms: number;
  error?: string;
  missing?: string[];
  cooldown_until?: string;
  skipped?: boolean;
}

export interface AggregatorDiagnostics {
  engine_attempts: AggregatorEngineAttempt[];
  elapsed_ms: number;
  deadline_reached: boolean;
  enabled_engines: string[];
}

type CircuitState = { failures: number; cooldownUntil: number };
const circuitStates = new Map<string, CircuitState>();

function circuitKey(engine: string, options: Record<string, unknown>): string {
  return `${engine}:${getEngineOption(options, engine, 'base_url') || 'default'}`;
}

function recordSuccess(key: string): void {
  circuitStates.delete(key);
}

function recordFailure(key: string): number {
  const current = circuitStates.get(key) || { failures: 0, cooldownUntil: 0 };
  const failures = current.failures + 1;
  const cooldownUntil = failures >= AGGREGATOR_FAILURE_THRESHOLD ? Date.now() + AGGREGATOR_COOLDOWN_MS : 0;
  circuitStates.set(key, { failures, cooldownUntil });
  return cooldownUntil;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Search failed');
}

async function executeEngine(
  engine: AggregatorEngineId,
  query: string,
  limit: number,
  options: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ results: SearchResult[]; attempt: AggregatorEngineAttempt }> {
  const started = Date.now();
  const missing = engineMissingRequirements(engine, options);
  if (missing.length) {
    return { results: [], attempt: { engine, success: false, result_count: 0, latency_ms: 0, missing, skipped: true } };
  }

  const key = circuitKey(engine, options);
  const circuit = circuitStates.get(key);
  if (circuit?.cooldownUntil && circuit.cooldownUntil > Date.now()) {
    return {
      results: [],
      attempt: {
        engine, success: false, result_count: 0, latency_ms: 0, skipped: true,
        cooldown_until: new Date(circuit.cooldownUntil).toISOString(),
      },
    };
  }

  try {
    const results = await runAggregatorEngine(engine, query, limit, { ...options, aggregator_signal: signal });
    // A well-formed answer with no matches is a healthy engine: only
    // transport, service or response failures (thrown below) count toward
    // the cooldown. The empty count stays visible in the diagnostics.
    recordSuccess(key);
    return {
      results,
      attempt: { engine, success: true, result_count: results.length, latency_ms: Date.now() - started },
    };
  } catch (error: unknown) {
    const cooldownUntil = signal.aborted ? 0 : recordFailure(key);
    return {
      results: [],
      attempt: {
        engine, success: false, result_count: 0, latency_ms: Date.now() - started,
        error: signal.aborted ? 'Aggregate deadline reached' : errorMessage(error),
        cooldown_until: cooldownUntil ? new Date(cooldownUntil).toISOString() : undefined,
      },
    };
  }
}

export async function searchAggregator(query: string, maxResults: number, options: Record<string, unknown> = {}): Promise<SearchResult[]> {
  const started = Date.now();
  const engines = normalizeAggregatorEngines(options?.aggregator_engines, options);
  const diagnostics: AggregatorDiagnostics = {
    engine_attempts: [],
    elapsed_ms: 0,
    deadline_reached: false,
    enabled_engines: [...engines],
  };
  options.aggregator_diagnostics = diagnostics;
  if (!engines.length) return [];

  const perEngineLimit = Math.max(3, Math.min(maxResults, 10));
  const controller = new AbortController();
  const externalSignal = options?.signal as AbortSignal | undefined;
  if (externalSignal?.aborted) {
    throw new DOMException('Search aborted', 'AbortError');
  }
  const onExternalAbort = () => controller.abort(externalSignal?.reason ?? new DOMException('Search aborted', 'AbortError'));
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const concurrency = Math.max(1, Math.min(Number(options?.aggregator_concurrency) || AGGREGATOR_CONCURRENCY, AGGREGATOR_CONCURRENCY));
  const deadlineMs = Math.max(1000, Math.min(Number(options?.aggregator_deadline_ms) || AGGREGATOR_DEADLINE_MS, 30_000));
  const allResults: SearchResult[] = [];
  let cursor = 0;

  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = cursor++;
      if (index >= engines.length) return;
      const engine = engines[index];
      const { results, attempt } = await executeEngine(engine, query, perEngineLimit, options, controller.signal);
      diagnostics.engine_attempts.push(attempt);
      allResults.push(...results.map((result) => ({
        ...result,
        provider: 'aggregator',
        providers: [...new Set(['aggregator', ...(result.providers || []), result.provider].filter(Boolean))],
        metadata: { ...(result.metadata || {}), aggregator_engine: engine },
      })));
    }
  };

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(() => {
        diagnostics.deadline_reached = true;
        controller.abort(new Error('Aggregate deadline reached'));
        resolve();
      }, deadlineMs);
    });
    const workers = Promise.all(Array.from({ length: Math.min(concurrency, engines.length) }, () => worker())).then(() => undefined);
    await Promise.race([workers, deadline]);
    if (externalSignal?.aborted) throw new DOMException('Search aborted', 'AbortError');
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    if (!controller.signal.aborted) controller.abort();
  }
  diagnostics.elapsed_ms = Date.now() - started;

  return mergeAndRankResults(allResults, query, maxResults).map((result, index) => ({
    ...result,
    provider: 'aggregator',
    source_rank: index + 1,
    metadata: { ...(result.metadata || {}), aggregator_diagnostics: diagnostics },
  }));
}

export function getSupportedAggregatorEngines(): string[] {
  return [...SUPPORTED_AGGREGATOR_ENGINES];
}

export function getAggregatorCatalog() {
  return AGGREGATOR_ENGINE_CATALOG.map((item) => ({ ...item, requires: [...item.requires] }));
}

export async function probeAggregatorEngines(
  engineIds: unknown,
  options: Record<string, unknown> = {},
  query = 'Agente search test',
): Promise<AggregatorDiagnostics> {
  const probeOptions = { ...options, aggregator_engines: normalizeAggregatorEngines(engineIds, options), aggregator_deadline_ms: 12_000 };
  await searchAggregator(query, 1, probeOptions);
  return probeOptions.aggregator_diagnostics as AggregatorDiagnostics;
}

export function resetAggregatorCircuitBreakers(): void {
  circuitStates.clear();
}
