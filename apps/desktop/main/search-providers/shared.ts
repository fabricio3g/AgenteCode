// Shared search utilities, constants, and result-processing helpers
import { toErrorMessage } from '../../shared/errors.ts';

/*
 * Only providers reached through an interface offered for programmatic use:
 * official APIs, and the user's own SearXNG. Result-page scrapers (DuckDuckGo
 * HTML, a hidden browser window) and resellers of scraped Google results
 * (SerpApi, Serper) were removed; Google CSE and Bing's API are closed.
 */
const DEFAULT_PROVIDER_ORDER = [
  'aggregator',
  'tavily',
  'exa',
  'brave',
  'searxng',
  'jina',
  'youcom',
  'perplexity'
];

/** Needs no key: the aggregator's free, API-based sources. */
const FREE_PROVIDER_ORDER = ['aggregator'];

/** Providers that existed before and are gone; saved settings naming them fall back to auto. */
export const REMOVED_SEARCH_PROVIDERS = ['duckduckgo', 'electron', 'serpapi', 'serper', 'google_cse', 'bing'];

const PROVIDER_PRIORITY: Record<string, number> = {
  aggregator: 5.5,
  tavily: 5,
  exa: 4.8,
  brave: 4.5,
  searxng: 3.8,
  jina: 3.3,
  youcom: 3.2,
  perplexity: 3.1
};

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { result: unknown; expires: number }>();

export function getCacheKey(query: string, mode: string, provider: string, discriminator = ''): string {
  return `${provider}:${mode}:${discriminator}:${query}`.toLowerCase();
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

export { toErrorMessage };

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

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * `fetch` with retries, a timeout and the caller's abort signal covering the
 * whole exchange: the response comes back with its body already read.
 */
export async function fetchWithRetry(url: string, opts: Record<string, unknown> = {}): Promise<Response> {
  const retries = (opts.retries as number | undefined) ?? 2;
  const timeoutMs = (opts.timeout_ms as number | undefined) ?? 15000;
  let lastErr: unknown = null;

  for (let i = 0; i <= retries; i += 1) {
    const ctrl = new AbortController();
    const externalSignal = opts.signal as AbortSignal | undefined;
    const abortFromExternal = () => ctrl.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    const timer = setTimeout(() => ctrl.abort(new DOMException('Request timeout', 'TimeoutError')), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: (opts.method as string) || 'GET',
        signal: ctrl.signal,
        headers: opts.headers as Record<string, string> | undefined,
        body: opts.body as string | undefined
      });
      // Read the body while the deadline and the caller's signal still hold:
      // headers can arrive promptly and the body stall, and a read started
      // after this returned would outlive both.
      const body = NULL_BODY_STATUSES.has(resp.status) ? null : await resp.arrayBuffer();
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternal);
      const buffered = new Response(body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers
      });
      Object.defineProperty(buffered, 'url', { value: resp.url });
      return buffered;
    } catch (err: unknown) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternal);
      lastErr = err;
      if (externalSignal?.aborted || i >= retries) throw lastErr;
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

/**
 * OpenAlex (and similar) abstracts often ship as an inverted index:
 * `{ "word": [0, 3], "other": [1] }` → "word other word".
 * Never stringify the object (that yields "[object Object]").
 */
export function textFromInvertedIndex(value: unknown, maxChars = 2000): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const positions: Array<{ word: string; index: number }> = [];
  for (const [word, indexes] of Object.entries(value as Record<string, unknown>)) {
    if (!word || !Array.isArray(indexes)) continue;
    for (const index of indexes) {
      if (typeof index === 'number' && Number.isFinite(index) && index >= 0) {
        positions.push({ word, index });
      }
    }
  }
  if (!positions.length) return '';
  positions.sort((a, b) => a.index - b.index || a.word.localeCompare(b.word));
  return normalizeWhitespace(positions.map((entry) => entry.word).join(' ')).slice(0, maxChars);
}

/** Coerce search snippets/content fields; drop non-text objects (except inverted indexes). */
export function coerceSearchText(value: unknown, maxChars = 4000): string {
  if (value == null) return '';
  if (typeof value === 'string') return normalizeWhitespace(value).slice(0, maxChars);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return normalizeWhitespace(String(value)).slice(0, maxChars);
  }
  if (Array.isArray(value)) {
    return normalizeWhitespace(
      value.map((entry) => (typeof entry === 'string' ? entry : '')).filter(Boolean).join(' ')
    ).slice(0, maxChars);
  }
  if (typeof value === 'object') {
    const fromIndex = textFromInvertedIndex(value, maxChars);
    if (fromIndex) return fromIndex;
  }
  return '';
}

const wordSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'word' })
  : null;

/**
 * Words of any script: letters and digits, so Arabic, accented Latin and
 * Japanese queries keep their terms. Text outside ASCII goes through the
 * word segmenter, which splits unspaced scripts into words.
 */
export function tokenize(text: string): string[] {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) return [];
  // eslint-disable-next-line no-control-regex
  if (!wordSegmenter || /^[\x00-\x7f]*$/.test(normalized)) {
    return normalized.match(/[\p{L}\p{N}]+/gu) || [];
  }
  const tokens: string[] = [];
  for (const part of wordSegmenter.segment(normalized)) {
    if (part.isWordLike) tokens.push(...(part.segment.match(/[\p{L}\p{N}]+/gu) || []));
  }
  return tokens;
}

export function compactSearchContext(context: unknown, max = 1800): string {
  return normalizeWhitespace(context).slice(0, max);
}

/**
 * Whether a query only makes sense with the conversation ("what changed in
 * that release?"). Freshness words alone ("latest Node.js releases") are not
 * a reference, and a query that names its subject (a capitalized name, a
 * version, a dotted name) or is quoted is explicit and sent as typed.
 */
function looksContextDependent(query: string): boolean {
  const normalized = normalizeWhitespace(query);
  if (!normalized) return false;
  if (/["“”]/.test(normalized)) return false;
  const namesSubject = /\s[A-Z]|\d|\w\.\w/.test(normalized) || /^[A-Z][a-z]*[A-Z]/.test(normalized);
  const refers = /\b(this|that|these|those|it|its|he|him|his|she|her|hers|they|them|their|there)\b/i.test(normalized);
  if (refers) {
    // "that release", "this one": a reference even next to a named subject.
    return !namesSubject || /\b(this|that|these|those)\s+(one|ones|release|version|update|change|model|product|company|article|paper|page|thing)\b/i.test(normalized);
  }
  // A bare follow-up ("and the price?", "why") with no subject of its own.
  return !namesSubject && tokenize(normalized).length <= 2;
}

function extractContextTerms(context: string): string[] {
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
    const term = normalizeWhitespace(value).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!term || (term.length < 3 && !/[^\p{ASCII}]/u.test(term))) return;
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
      .filter((token) => (token.length > 4 || /[^\p{ASCII}]/u.test(token)) && !stopTerms.has(token));
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
  if (!looksContextDependent(normalizedQuery)) return normalizedQuery;

  const queryTokens = new Set(tokenize(normalizedQuery));
  const contextTerms = extractContextTerms(normalizedContext)
    .filter((term) => !tokenize(term).every((token) => queryTokens.has(token)));
  if (!contextTerms.length) return normalizedQuery;

  return normalizeWhitespace(`${contextTerms.slice(0, 3).join(' ')} ${normalizedQuery}`).slice(0, 260);
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeUrl(rawUrl: unknown): string {
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

function getDomain(rawUrl: unknown): string {
  try {
    const url = new URL(String(rawUrl));
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function providerPriority(provider: string): number {
  return PROVIDER_PRIORITY[provider] || 1;
}

export function providerDisplayName(provider: string): string {
  const names: Record<string, string> = {
    tavily: 'Tavily',
    aggregator: 'Agente Aggregator',
    brave: 'Brave Search',
    searxng: 'SearXNG',
    exa: 'Exa',
    jina: 'Jina',
    youcom: 'You.com',
    perplexity: 'Perplexity'
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
    case 'searxng':
      return !!options?.searxng_base_url;
    case 'exa':
      return !!options?.exa_api_key;
    case 'jina':
      // s.jina.ai search needs a key; the keyless reader is only used to read pages.
      return !!options?.jina_api_key;
    case 'youcom':
      return !!options?.youcom_api_key;
    case 'perplexity':
      return !!options?.perplexity_api_key;
    default:
      return false;
  }
}

export function providerCandidates(provider: string, options: Record<string, unknown>, _searchMode: string): string[] {
  if (provider && provider !== 'auto' && !REMOVED_SEARCH_PROVIDERS.includes(provider)) return [provider];
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
  const snippet = coerceSearchText(
    item?.snippet || item?.content || item?.description || item?.text || item?.body || item?.summary || ''
  );
  const fullContent = coerceSearchText(
    item?.full_content || item?.fullContent || item?.text || item?.content || item?.body || ''
  );

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

function scoreText(text: string, queryTerms: string[]): number {
  const haystack = normalizeWhitespace(text).toLowerCase();
  if (!haystack || !queryTerms.length) return 0;

  let score = 0;
  for (const term of queryTerms) {
    if (!term) continue;
    if (haystack.includes(term)) {
      score += 1;
    }
    const isUnspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term);
    const hitCount = isUnspaced
      ? Math.max(0, haystack.split(term).length - 1)
      : (haystack.match(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'gu')) || []).length;
    if (hitCount > 0) {
      score += Math.min(hitCount, 4) * 0.25;
    }
  }
  return score;
}

function choosePrimaryProvider(providers: string[]): string {
  const list = Array.isArray(providers) ? providers : Array.from(providers || []);
  if (!list.length) return 'unknown';
  return [...list].sort((a, b) => providerPriority(b) - providerPriority(a))[0] || list[0];
}

function dedupeKey(result: SearchResult): string {
  const url = normalizeUrl(result.url);
  if (url) return `url:${url}`;
  const title = normalizeWhitespace(result.title).toLowerCase();
  const snippet = normalizeWhitespace(result.snippet).toLowerCase().slice(0, 140);
  const domain = getDomain(result.url);
  return `text:${domain}:${title}:${snippet}`;
}

function normalizedTitleKey(title: string): string {
  // Numbers stay: "Node 18 docs" and "Node 20 docs" are different pages.
  return tokenize(title).filter((token) => token.length > 2 || /\d/.test(token)).sort().join(' ');
}

function parsedRecencyBoost(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  if (ageDays <= 1) return 0.8;
  if (ageDays <= 7) return 0.55;
  if (ageDays <= 30) return 0.3;
  if (ageDays <= 365) return 0.1;
  return 0;
}

export function mergeAndRankResults(results: SearchResult[], query: string, limit: number): SearchResult[] {
  const queryTerms = tokenize(query);
  const merged = new Map<string, SearchResult>();
  const titleKeys = new Map<string, string>();
  const fusionScores = new Map<string, number>();

  for (const result of results) {
    let key = dedupeKey(result);
    // The same page under two URLs (http/https, a tracking variant) shares a
    // host and a title; pages on different hosts with one stock title
    // ("Installation guide") are different sources and keep their own text.
    const title = normalizedTitleKey(result.title);
    const titleKey = title ? `${getDomain(result.url)}|${title}` : '';
    if (titleKey && titleKeys.has(titleKey)) key = titleKeys.get(titleKey)!;
    const existing = merged.get(key);
    const reciprocalRank = 1 / (60 + Math.max(1, result.source_rank || 1));
    fusionScores.set(key, (fusionScores.get(key) || 0) + reciprocalRank);
    if (!existing) {
      merged.set(key, {
        ...result,
        providers: Array.isArray(result.providers) ? [...new Set(result.providers)] : [result.provider],
        provider: result.provider || choosePrimaryProvider(result.providers || [result.provider]),
        score: typeof result.score === 'number' ? result.score : 0,
        source_rank: result.source_rank || 0
      });
      if (titleKey) titleKeys.set(titleKey, key);
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

  const ranked = Array.from(merged.entries()).map(([key, result]) => {
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
    const recencyBoost = parsedRecencyBoost(result.published_at);
    const fusionBoost = (fusionScores.get(key) || 0) * 100;
    const consensusBoost = Math.max(0, new Set(providers.filter((p) => p !== 'aggregator')).size - 1) * 0.9;

    return {
      ...result,
      score: providerBoost + titleScore + snippetScore + contentScore + urlScore + existingScore + recencyBoost + fusionBoost + consensusBoost,
      source_rank: result.source_rank || 1,
      provider: result.provider || choosePrimaryProvider(providers)
    };
  });

  ranked.sort((left, right) => {
    if ((right.score || 0) !== (left.score || 0)) return (right.score || 0) - (left.score || 0);
    if ((right.source_rank || 0) !== (left.source_rank || 0)) return (left.source_rank || 0) - (right.source_rank || 0);
    return normalizeWhitespace(left.title).localeCompare(normalizeWhitespace(right.title));
  });

  const diverse: SearchResult[] = [];
  const deferred: SearchResult[] = [];
  const domainCounts = new Map<string, number>();
  for (const result of ranked) {
    const domain = getDomain(result.url);
    const count = domain ? domainCounts.get(domain) || 0 : 0;
    if (domain && count >= 2) {
      deferred.push(result);
      continue;
    }
    diverse.push(result);
    if (domain) domainCounts.set(domain, count + 1);
    if (diverse.length >= limit) break;
  }
  if (diverse.length < limit) diverse.push(...deferred.slice(0, limit - diverse.length));
  return diverse.slice(0, limit);
}

/**
 * Every result's whole page text (or its snippet when the page was not read),
 * paragraphs and lists kept — no character budget, nothing cut.
 */
export function buildContext(results: SearchResult[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const content = cleanText(result.full_content || '').replace(/\n{3,}/g, '\n\n') || normalizeWhitespace(result.snippet);
    if (!content) continue;
    blocks.push([
      `## [${i + 1}] ${result.title || 'Untitled result'}`,
      result.url ? `URL: ${result.url}` : null,
      result.provider ? `Provider: ${providerDisplayName(result.provider)}` : null,
      Number.isFinite(result.score) ? `Score: ${Number(result.score).toFixed(2)}` : null,
      content
    ].filter(Boolean).join('\n\n'));
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
