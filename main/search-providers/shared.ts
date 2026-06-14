// Shared search utilities, constants, and result-processing helpers

export const DEFAULT_PROVIDER_ORDER = [
  'aggregator',
  'tavily',
  'brave',
  'google_cse',
  'serpapi',
  'searxng',
  'electron',
  'bing',
  'serper',
  'exa',
  'jina',
  'youcom',
  'perplexity',
  'duckduckgo'
];

export const FREE_PROVIDER_ORDER = ['aggregator', 'duckduckgo', 'jina', 'electron'];

export const PROVIDER_PRIORITY: Record<string, number> = {
  aggregator: 5.5,
  tavily: 5,
  brave: 4.5,
  google_cse: 4.2,
  serpapi: 4,
  searxng: 3.8,
  electron: 3.9,
  bing: 3.6,
  serper: 3.5,
  exa: 3.4,
  jina: 3.3,
  youcom: 3.2,
  perplexity: 3.1,
  duckduckgo: 2.8
};

export const DEFAULT_CONTEXT_BUDGET = {
  search: 4500,
  deep: 14000,
  max: 26000
};

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { result: unknown; expires: number }>();

export function getCacheKey(query: string, mode: string, provider: string): string {
  return `${provider}:${mode}:${query}`.toLowerCase();
}

export function getCachedResult(key: string): unknown | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    searchCache.delete(key);
    return null;
  }
  return entry.result;
}

export function setCachedResult(key: string, result: unknown): void {
  if (searchCache.size >= 100) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { result, expires: Date.now() + SEARCH_CACHE_TTL_MS });
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function classifyNetworkError(err: unknown) {
  const msg = toErrorMessage(err).toLowerCase();
  const errorName = (err && typeof err === 'object' && 'name' in err) ? String((err as { name?: string }).name) : '';
  if (errorName === 'AbortError' || msg.includes('timeout')) {
    return { error_type: 'timeout', retryable: true, hint: 'Request timed out.' };
  }
  if (msg.includes('enotfound') || msg.includes('dns')) {
    return { error_type: 'dns', retryable: true, hint: 'DNS lookup failed.' };
  }
  if (msg.includes('econnrefused') || msg.includes('network') || msg.includes('failed to fetch')) {
    return { error_type: 'network', retryable: true, hint: 'Network connection failed.' };
  }
  return { error_type: 'unknown', retryable: false, hint: 'Unexpected error.' };
}

export async function fetchWithRetry(url: string, opts: Record<string, unknown> = {}): Promise<Response> {
  const retries = (opts.retries as number | undefined) ?? 2;
  const timeoutMs = (opts.timeout_ms as number | undefined) ?? 15000;
  let lastErr: unknown = null;

  for (let i = 0; i <= retries; i += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: (opts.method as string) || 'GET',
        signal: ctrl.signal,
        headers: opts.headers as Record<string, string> | undefined,
        body: opts.body as string | undefined
      });
      clearTimeout(timer);
      return resp;
    } catch (err: unknown) {
      clearTimeout(timer);
      lastErr = err;
      if (i >= retries) throw lastErr;
      await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
    }
  }

  throw lastErr;
}

export function normalizeProviderName(provider: unknown): string {
  return String(provider || 'auto').trim().toLowerCase() || 'auto';
}

export function normalizeWhitespace(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function cleanText(text: unknown): string {
  return String(text ?? '').replace(/\u0000/g, '').trim();
}

export function tokenize(text: string): string[] {
  return normalizeWhitespace(text).toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function compactSearchContext(context: unknown, max = 1800): string {
  return normalizeWhitespace(context).slice(0, max);
}

export function looksContextDependent(query: string): boolean {
  const normalized = normalizeWhitespace(query).toLowerCase();
  if (!normalized) return false;
  return /\b(this|that|these|those|it|its|he|him|his|she|her|hers|they|them|their|there|latest|recent|current|today|now|news|update|price|stock|version|release)\b/i.test(normalized);
}

export function extractContextTerms(context: string): string[] {
  const text = compactSearchContext(context);
  if (!text) return [];

  const terms: string[] = [];
  const seen = new Set<string>();
  const stopTerms = new Set([
    'user', 'assistant', 'search', 'about', 'latest', 'recent', 'current',
    'please', 'would', 'could', 'should', 'what', 'when', 'where', 'which',
    'there', 'their', 'these', 'those', 'context', 'message'
  ]);
  const add = (value: string) => {
    const term = normalizeWhitespace(value).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!term || term.length < 3) return;
    const key = term.toLowerCase();
    if (stopTerms.has(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };

  const properNameMatches = Array.from(text.matchAll(/\b[A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4}\b/g));
  for (const match of properNameMatches.reverse()) {
    add(match[0]);
    if (terms.length >= 8) break;
  }

  if (terms.length < 4) {
    const candidates = tokenize(text)
      .filter((token) => token.length > 4 && !stopTerms.has(token));
    for (const token of candidates) {
      add(token);
      if (terms.length >= 6) break;
    }
  }

  return terms.slice(0, 6);
}

export function buildEffectiveSearchQuery(query: string, context: string): string {
  const normalizedQuery = normalizeWhitespace(query);
  const normalizedContext = compactSearchContext(context);
  if (!normalizedQuery || !normalizedContext) return normalizedQuery;
  if (!looksContextDependent(normalizedQuery) && normalizedQuery.length >= 16) return normalizedQuery;

  const queryTokens = new Set(tokenize(normalizedQuery));
  const contextTerms = extractContextTerms(normalizedContext)
    .filter((term) => !tokenize(term).every((token) => queryTokens.has(token)));
  if (!contextTerms.length) return normalizedQuery;

  return normalizeWhitespace(`${contextTerms.slice(0, 3).join(' ')} ${normalizedQuery}`).slice(0, 260);
}

export function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeUrl(rawUrl: unknown): string {
  const value = normalizeWhitespace(rawUrl);
  if (!value) return '';

  try {
    const url = new URL(value);
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ref']) {
      url.searchParams.delete(key);
    }
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return value.toLowerCase();
  }
}

export function getDomain(rawUrl: unknown): string {
  try {
    const url = new URL(String(rawUrl));
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function providerPriority(provider: string): number {
  return PROVIDER_PRIORITY[provider] || 1;
}

export function providerDisplayName(provider: string): string {
  const names: Record<string, string> = {
    tavily: 'Tavily',
    aggregator: 'Chatea Aggregator',
    brave: 'Brave Search',
    google_cse: 'Google CSE',
    serpapi: 'SerpAPI',
    searxng: 'SearXNG',
    electron: 'Electron Browser',
    bing: 'Bing Search',
    serper: 'Serper',
    exa: 'Exa',
    jina: 'Jina',
    youcom: 'You.com',
    perplexity: 'Perplexity',
    duckduckgo: 'DuckDuckGo'
  };
  return names[provider] || provider;
}

export function providerHasCredentials(provider: string, options: Record<string, unknown>): boolean {
  switch (provider) {
    case 'tavily':
      return !!options?.tavily_api_key;
    case 'aggregator':
      return true;
    case 'brave':
      return !!options?.brave_api_key;
    case 'google_cse':
      return !!options?.google_cse_api_key && !!options?.google_cse_id;
    case 'serpapi':
      return !!options?.serpapi_api_key;
    case 'searxng':
      return !!options?.searxng_base_url;
    case 'electron':
      return true;
    case 'bing':
      return !!options?.bing_api_key;
    case 'serper':
      return !!options?.serper_api_key;
    case 'exa':
      return !!options?.exa_api_key;
    case 'jina':
      return true;
    case 'youcom':
      return !!options?.youcom_api_key;
    case 'perplexity':
      return !!options?.perplexity_api_key;
    case 'duckduckgo':
      return true;
    default:
      return false;
  }
}

export function providerCandidates(provider: string, options: Record<string, unknown>, _searchMode: string): string[] {
  if (provider && provider !== 'auto') return [provider];
  const keyed = DEFAULT_PROVIDER_ORDER.filter((candidate) => {
    if (FREE_PROVIDER_ORDER.includes(candidate)) return false;
    return providerHasCredentials(candidate, options);
  });
  const free = FREE_PROVIDER_ORDER.filter((candidate) => providerHasCredentials(candidate, options));
  return [...keyed, ...free];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  full_content: string;
  provider: string;
  providers: string[];
  source_rank: number;
  score?: number;
  published_at: string | null;
  metadata: Record<string, unknown>;
}

export function requireOption(options: Record<string, unknown>, key: string, message: string): string {
  const value = options?.[key];
  if (!value) throw new Error(message);
  return value as string;
}

export function pickFirstArray(data: unknown, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = (data as Record<string, unknown> | undefined)?.[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [];
}

export function mapSearchResults(
  provider: string,
  items: Record<string, unknown>[],
  mapper: (item: Record<string, unknown>, index: number) => Record<string, unknown>,
  maxResults: number
): SearchResult[] {
  return items
    .map((item, index) => normalizeSearchItem(provider, mapper(item, index), index))
    .slice(0, maxResults);
}

export function normalizeSearchItem(provider: string, item: Record<string, unknown>, index: number): SearchResult {
  const title = normalizeWhitespace(item?.title || item?.name || item?.heading || item?.label || '') || `Result ${index + 1}`;
  const url = normalizeWhitespace(item?.url || item?.link || item?.href || item?.source || item?.canonical_url || '');
  const snippet = normalizeWhitespace(
    item?.snippet || item?.content || item?.description || item?.text || item?.body || item?.summary || ''
  );
  const fullContent = cleanText(item?.full_content || item?.fullContent || item?.text || item?.content || item?.body || '');

  return {
    title,
    url,
    snippet,
    full_content: fullContent,
    provider,
    providers: [provider],
    source_rank: index + 1,
    score: typeof item?.score === 'number' ? item.score : undefined,
    published_at: (item?.published_at as string) || (item?.publishedAt as string) || (item?.date as string) || (item?.publishedDate as string) || (item?.lastUpdated as string) || null,
    metadata: (item?.metadata as Record<string, unknown>) || {}
  };
}

export function parseSearchResultsFromText(provider: string, text: string, maxResults: number, fallbackUrl = ''): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(text)) && results.length < maxResults) {
    const title = normalizeWhitespace(match[1]);
    const url = normalizeWhitespace(match[2]);
    const start = Math.max(0, (match.index || 0) - 120);
    const snippet = normalizeWhitespace(text.slice(start, start + 480));
    results.push(normalizeSearchItem(provider, {
      title,
      url,
      snippet,
      full_content: text.slice(start, start + 1600)
    }, results.length));
  }

  if (results.length) return results;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (results.length >= maxResults) break;
    const urlMatch = line.match(/https?:\/\/\S+/);
    if (!urlMatch) continue;
    const url = normalizeWhitespace(urlMatch[0].replace(/[),.;]+$/, ''));
    const title = normalizeWhitespace(
      line
        .replace(urlMatch[0], '')
        .replace(/^[-*•\d.\s]+/, '')
        .replace(/^[\[{(]+|[\]})]+$/g, '')
    ) || providerDisplayName(provider);
    results.push(normalizeSearchItem(provider, {
      title,
      url,
      snippet: line,
      full_content: line
    }, results.length));
  }

  if (!results.length && normalizeWhitespace(text)) {
    results.push(normalizeSearchItem(provider, {
      title: `${providerDisplayName(provider)} result`,
      url: fallbackUrl,
      snippet: text.slice(0, 1200),
      full_content: text.slice(0, 4000)
    }, 0));
  }

  return results.slice(0, maxResults);
}

export function scoreText(text: string, queryTerms: string[]): number {
  const haystack = normalizeWhitespace(text).toLowerCase();
  if (!haystack || !queryTerms.length) return 0;

  let score = 0;
  for (const term of queryTerms) {
    if (!term) continue;
    if (haystack.includes(term)) {
      score += 1;
    }
    const hits = haystack.match(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g')) || [];
    if (hits.length) {
      score += Math.min(hits.length, 4) * 0.25;
    }
  }
  return score;
}

export function choosePrimaryProvider(providers: string[]): string {
  const list = Array.isArray(providers) ? providers : Array.from(providers || []);
  if (!list.length) return 'unknown';
  return [...list].sort((a, b) => providerPriority(b) - providerPriority(a))[0] || list[0];
}

export function dedupeKey(result: SearchResult): string {
  const url = normalizeUrl(result.url);
  if (url) return `url:${url}`;
  const title = normalizeWhitespace(result.title).toLowerCase();
  const snippet = normalizeWhitespace(result.snippet).toLowerCase().slice(0, 140);
  const domain = getDomain(result.url);
  return `text:${domain}:${title}:${snippet}`;
}

export function mergeAndRankResults(results: SearchResult[], query: string, limit: number): SearchResult[] {
  const queryTerms = tokenize(query);
  const merged = new Map<string, SearchResult>();

  for (const result of results) {
    const key = dedupeKey(result);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...result,
        providers: Array.isArray(result.providers) ? [...new Set(result.providers)] : [result.provider],
        provider: result.provider || choosePrimaryProvider(result.providers || [result.provider]),
        score: typeof result.score === 'number' ? result.score : 0,
        source_rank: result.source_rank || 0
      });
      continue;
    }

    const providers = new Set([...(existing.providers || []), ...(result.providers || []), result.provider].filter(Boolean));
    existing.providers = [...providers];
    existing.provider = choosePrimaryProvider(existing.providers);
    existing.title = existing.title || result.title;
    existing.snippet = (existing.snippet || result.snippet || '').length >= (result.snippet || '').length ? existing.snippet : result.snippet;
    existing.full_content = (existing.full_content || '').length >= (result.full_content || '').length ? existing.full_content : result.full_content;
    existing.url = existing.url || result.url;
    existing.published_at = existing.published_at || result.published_at || null;
    existing.metadata = { ...(existing.metadata || {}), ...(result.metadata || {}) };
    existing.score = Math.max(existing.score || 0, typeof result.score === 'number' ? result.score : 0);
    existing.source_rank = Math.min(existing.source_rank || Infinity, result.source_rank || Infinity);
  }

  const ranked = Array.from(merged.values()).map((result, index) => {
    const providers = result.providers || [result.provider];
    let providerBoost = 0;
    for (const p of providers) {
      const pVal = providerPriority(p);
      if (pVal > providerBoost) providerBoost = pVal;
    }
    const titleScore = scoreText(result.title, queryTerms) * 1.75;
    const snippetScore = scoreText(result.snippet, queryTerms);
    const contentScore = scoreText((result.full_content || '').slice(0, 5000), queryTerms) * 0.6;
    const urlScore = scoreText(result.url, queryTerms) * 0.25;
    const existingScore = typeof result.score === 'number' ? result.score * 0.15 : 0;
    const recencyBoost = result.published_at ? 0.25 : 0;
    const rankBoost = Math.max(0, 1.5 - index * 0.03);

    return {
      ...result,
      score: providerBoost + titleScore + snippetScore + contentScore + urlScore + existingScore + recencyBoost + rankBoost,
      source_rank: result.source_rank || index + 1,
      provider: result.provider || choosePrimaryProvider(providers)
    };
  });

  ranked.sort((left, right) => {
    if ((right.score || 0) !== (left.score || 0)) return (right.score || 0) - (left.score || 0);
    if ((right.source_rank || 0) !== (left.source_rank || 0)) return (left.source_rank || 0) - (right.source_rank || 0);
    return normalizeWhitespace(left.title).localeCompare(normalizeWhitespace(right.title));
  });

  return ranked.slice(0, limit);
}

export function buildContext(results: SearchResult[], budgetChars: number): string {
  const blocks: string[] = [];
  let used = 0;

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const content = normalizeWhitespace((result.full_content || '').trim()) || normalizeWhitespace(result.snippet);
    if (!content) continue;

    const block = [
      `## [${i + 1}] ${result.title || 'Untitled result'}`,
      result.url ? `URL: ${result.url}` : null,
      result.provider ? `Provider: ${providerDisplayName(result.provider)}` : null,
      Number.isFinite(result.score) ? `Score: ${Number(result.score).toFixed(2)}` : null,
      content
    ].filter(Boolean).join('\n\n');

    if (blocks.length && used + block.length > budgetChars) break;
    blocks.push(block.slice(0, Math.max(1200, budgetChars)));
    used += block.length + 24;
  }

  return blocks.join('\n\n---\n\n');
}

export function buildJinaReaderUrl(url: string, baseUrl = 'https://r.jina.ai'): string {
  const target = normalizeWhitespace(url);
  if (!target) return '';
  const cleanedBase = String(baseUrl || 'https://r.jina.ai').replace(/\/+$/, '');
  const cleanedTarget = target.replace(/^https?:\/\//i, '');
  return `${cleanedBase}/http://${cleanedTarget}`;
}

export function providerSearchError(provider: string, err: unknown) {
  const info = classifyNetworkError(err);
  const message = (err instanceof Error ? err.message : String(err || 'Search failed'));
  return {
    query: '',
    results: [],
    context: '',
    provider_used: provider,
    error: `${providerDisplayName(provider)}: ${message}`,
    error_type: info.error_type,
    retryable: info.retryable
  };
}
