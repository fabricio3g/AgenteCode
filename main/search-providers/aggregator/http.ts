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

export async function fetchAggregatorHtml(url: string, headers: Record<string, string> = {}, options: Record<string, unknown> = {}): Promise<string> {
  const resp = await fetchWithRetry(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': AGGREGATOR_USER_AGENT,
      ...headers,
    },
    timeout_ms: Number(options.timeout_ms) || 8000,
    retries: Number(options.retries ?? 0),
    signal: options.signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}
