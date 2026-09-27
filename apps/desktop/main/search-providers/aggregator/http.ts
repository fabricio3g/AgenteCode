import { fetchWithRetry } from '../shared.ts';
import { AGGREGATOR_USER_AGENT } from './constants.ts';

export async function fetchAggregatorJson(url: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const resp = await fetchWithRetry(url, {
    headers: { Accept: 'application/json', 'User-Agent': AGGREGATOR_USER_AGENT },
    timeout_ms: Number(options.timeout_ms) || 8000,
    retries: Number(options.retries ?? 1),
    signal: options.signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json() as Record<string, unknown>;
}
