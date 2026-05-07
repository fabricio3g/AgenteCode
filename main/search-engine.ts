import { BrowserWindow } from 'electron';
import { LOCAL_GGUF_CATALOG, TTS_MODEL_CATALOG, WHISPER_QUALITY_CATALOG } from './config.ts';
import { EMBEDDING_MODEL_CATALOG } from './rag/embedding-catalog.ts';

const DEFAULT_PROVIDER_ORDER = [
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

const FREE_PROVIDER_ORDER = ['duckduckgo', 'jina', 'electron'];

const PROVIDER_PRIORITY = {
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

const DEFAULT_CONTEXT_BUDGET = {
  search: 4500,
  deep: 9000,
  max: 14000
};

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { result: unknown; expires: number }>();

function getCacheKey(query, mode, provider) {
  return `${provider}:${mode}:${query}`.toLowerCase();
}

function getCachedResult(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    searchCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCachedResult(key, result) {
  if (searchCache.size >= 100) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { result, expires: Date.now() + SEARCH_CACHE_TTL_MS });
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyNetworkError(err: unknown) {
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

async function fetchWithRetry(url, opts = {}) {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeout_ms ?? 15000;
  let lastErr = null;

  for (let i = 0; i <= retries; i += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: opts.method || 'GET',
        signal: ctrl.signal,
        headers: opts.headers,
        body: opts.body
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

function normalizeProviderName(provider) {
  return String(provider || 'auto').trim().toLowerCase() || 'auto';
}

function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function cleanText(text) {
  return String(text ?? '').replace(/\u0000/g, '').trim();
}

function tokenize(text) {
  return normalizeWhitespace(text).toLowerCase().match(/[a-z0-9]+/g) || [];
}

function compactSearchContext(context, max = 1800) {
  return normalizeWhitespace(context).slice(0, max);
}

function looksContextDependent(query) {
  const normalized = normalizeWhitespace(query).toLowerCase();
  if (!normalized) return false;
  return /\b(this|that|these|those|it|its|he|him|his|she|her|hers|they|them|their|there|latest|recent|current|today|now|news|update|price|stock|version|release)\b/i.test(normalized);
}

function extractContextTerms(context) {
  const text = compactSearchContext(context);
  if (!text) return [];

  const terms = [];
  const seen = new Set();
  const stopTerms = new Set([
    'user', 'assistant', 'search', 'about', 'latest', 'recent', 'current',
    'please', 'would', 'could', 'should', 'what', 'when', 'where', 'which',
    'there', 'their', 'these', 'those', 'context', 'message'
  ]);
  const add = (value) => {
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

function buildEffectiveSearchQuery(query, context) {
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeUrl(rawUrl) {
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

function getDomain(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function providerPriority(provider) {
  return PROVIDER_PRIORITY[provider] || 1;
}

function providerDisplayName(provider) {
  const names = {
    tavily: 'Tavily',
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

function providerHasCredentials(provider, options) {
  switch (provider) {
    case 'tavily':
      return !!options?.tavily_api_key;
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

function providerCandidates(provider, options, searchMode) {
  if (provider && provider !== 'auto') return [provider];
  const keyed = DEFAULT_PROVIDER_ORDER.filter((candidate) => {
    if (FREE_PROVIDER_ORDER.includes(candidate)) return false;
    return providerHasCredentials(candidate, options);
  });
  const free = FREE_PROVIDER_ORDER.filter((candidate) => providerHasCredentials(candidate, options));
  return [...keyed, ...free];
}

function normalizeSearchItem(provider, item, index) {
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
    published_at: item?.published_at || item?.publishedAt || item?.date || item?.publishedDate || item?.lastUpdated || null,
    metadata: item?.metadata || {}
  };
}

function parseSearchResultsFromText(provider, text, maxResults, fallbackUrl = '') {
  const results = [];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;

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

function scoreText(text, queryTerms) {
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

function choosePrimaryProvider(providers) {
  const list = Array.isArray(providers) ? providers : Array.from(providers || []);
  if (!list.length) return 'unknown';
  return [...list].sort((a, b) => providerPriority(b) - providerPriority(a))[0] || list[0];
}

function dedupeKey(result) {
  const url = normalizeUrl(result.url);
  if (url) return `url:${url}`;
  const title = normalizeWhitespace(result.title).toLowerCase();
  const snippet = normalizeWhitespace(result.snippet).toLowerCase().slice(0, 140);
  const domain = getDomain(result.url);
  return `text:${domain}:${title}:${snippet}`;
}

function mergeAndRankResults(results, query, limit) {
  const queryTerms = tokenize(query);
  const merged = new Map();

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

function buildContext(results, budgetChars) {
  const blocks = [];
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

function buildJinaReaderUrl(url, baseUrl = 'https://r.jina.ai') {
  const target = normalizeWhitespace(url);
  if (!target) return '';
  const cleanedBase = String(baseUrl || 'https://r.jina.ai').replace(/\/+$/, '');
  const cleanedTarget = target.replace(/^https?:\/\//i, '');
  return `${cleanedBase}/http://${cleanedTarget}`;
}

async function searchTavily(query, maxResults, options) {
  if (!options?.tavily_api_key) throw new Error('No Tavily API key');
  const resp = await fetchWithRetry('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout_ms: 15000,
    body: JSON.stringify({
      api_key: options.tavily_api_key,
      query,
      max_results: maxResults,
      include_answer: false
    })
  });
  const data = await resp.json();
  const items = Array.isArray(data?.results) ? data.results : [];
  return items.map((item, index) => normalizeSearchItem('tavily', {
    title: item?.title,
    url: item?.url,
    snippet: item?.content || item?.snippet || '',
    full_content: item?.content || '',
    score: item?.score,
    published_at: item?.published_date || item?.published_at,
    metadata: item
  }, index)).slice(0, maxResults);
}

async function searchBrave(query, maxResults, options) {
  if (!options?.brave_api_key) throw new Error('No Brave API key');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const resp = await fetchWithRetry(url, {
    headers: { 'X-Subscription-Token': options.brave_api_key, Accept: 'application/json' },
    timeout_ms: 15000
  });
  const data = await resp.json();
  const items = Array.isArray(data?.web?.results) ? data.web.results : Array.isArray(data?.results) ? data.results : [];
  return items.map((item, index) => normalizeSearchItem('brave', {
    title: item?.title,
    url: item?.url,
    snippet: item?.description || item?.snippet || '',
    full_content: item?.description || item?.snippet || '',
    published_at: item?.age || item?.published_at,
    metadata: item
  }, index)).slice(0, maxResults);
}

async function searchGoogleCse(query, maxResults, options) {
  if (!options?.google_cse_api_key || !options?.google_cse_id) {
    throw new Error('Google CSE requires an API key and Search Engine ID — configure them in Settings > Search');
  }
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(options.google_cse_api_key)}&cx=${encodeURIComponent(options.google_cse_id)}&q=${encodeURIComponent(query)}&num=${maxResults}`;
  const resp = await fetchWithRetry(url, { timeout_ms: 15000 });
  const data = await resp.json();
  if (!resp.ok) {
    const apiMsg = data?.error?.message || data?.error?.status || `HTTP ${resp.status}`;
    if (resp.status === 403) throw new Error(`Google CSE: access denied — check your API key and that Custom Search API is enabled (${apiMsg})`);
    if (resp.status === 429) throw new Error(`Google CSE: quota exceeded — daily limit reached (${apiMsg})`);
    throw new Error(`Google CSE: ${apiMsg}`);
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length && data?.searchInformation?.totalResults === '0') {
    // Valid response but zero results — return empty rather than throwing
    return [];
  }
  return items.map((item, index) => normalizeSearchItem('google_cse', {
    title: item?.title,
    url: item?.link,
    snippet: item?.snippet || item?.htmlSnippet || '',
    full_content: item?.snippet || item?.htmlSnippet || '',
    metadata: item
  }, index)).slice(0, maxResults);
}

async function searchSerpApi(query, maxResults, options) {
  if (!options?.serpapi_api_key) throw new Error('No SerpAPI key');
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', options.serpapi_api_key);
  url.searchParams.set('num', String(maxResults));
  const resp = await fetchWithRetry(url.toString(), { timeout_ms: 15000 });
  const data = await resp.json();
  const items = Array.isArray(data?.organic_results) ? data.organic_results : Array.isArray(data?.organic) ? data.organic : Array.isArray(data?.results) ? data.results : [];
  return items.map((item, index) => normalizeSearchItem('serpapi', {
    title: item?.title,
    url: item?.link || item?.url,
    snippet: item?.snippet || item?.description || '',
    full_content: item?.snippet || item?.description || '',
    published_at: item?.date || item?.publication_date,
    metadata: item
  }, index)).slice(0, maxResults);
}

async function searchSearxng(query, maxResults, options) {
  if (!options?.searxng_base_url) throw new Error('No SearXNG base URL');
  const url = new URL('/search', options.searxng_base_url.replace(/\/+$/, '') + '/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en');
  url.searchParams.set('safesearch', '1');
  url.searchParams.set('categories', 'general');
  const resp = await fetchWithRetry(url.toString(), { timeout_ms: 15000 });
  const data = await resp.json();
  const items = Array.isArray(data?.results) ? data.results : [];
  return items.map((item, index) => normalizeSearchItem('searxng', {
    title: item?.title,
    url: item?.url,
    snippet: item?.content || item?.snippet || item?.description || '',
    full_content: item?.content || item?.snippet || item?.description || '',
    published_at: item?.publishedDate || item?.pubdate,
    metadata: item
  }, index)).slice(0, maxResults);
}

async function searchBing(query, maxResults, options) {
  if (!options?.bing_api_key) throw new Error('No Bing API key');
  const endpoint = String(options?.bing_endpoint || 'https://api.bing.microsoft.com/v7.0/search').replace(/\/+$/, '');
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  url.searchParams.set('mkt', 'en-US');
  url.searchParams.set('safeSearch', 'Moderate');
  const resp = await fetchWithRetry(url.toString(), {
    headers: { 'Ocp-Apim-Subscription-Key': options.bing_api_key, Accept: 'application/json' },
    timeout_ms: 15000
  });
  const data = await resp.json();
  const items = Array.isArray(data?.webPages?.value) ? data.webPages.value : Array.isArray(data?.webPages?.results) ? data.webPages.results : [];
  return items.map((item, index) => normalizeSearchItem('bing', {
    title: item?.name,
    url: item?.url,
    snippet: item?.snippet || item?.description || '',
    full_content: item?.snippet || item?.description || '',
    published_at: item?.dateLastCrawled || item?.datePublished,
    metadata: item
  }, index)).slice(0, maxResults);
}

async function searchSerper(query, maxResults, options) {
  if (!options?.serper_api_key) throw new Error('No Serper API key');
  const resp = await fetchWithRetry('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': options.serper_api_key,
      Accept: 'application/json'
    },
    timeout_ms: 15000,
    body: JSON.stringify({ q: query, num: maxResults })
  });
  const data = await resp.json();
  const items = Array.isArray(data?.organic) ? data.organic : Array.isArray(data?.organic_results) ? data.organic_results : Array.isArray(data?.results) ? data.results : [];
  return items.map((item, index) => normalizeSearchItem('serper', {
    title: item?.title || item?.name,
    url: item?.link || item?.url,
    snippet: item?.snippet || item?.description || '',
    full_content: item?.snippet || item?.description || '',
    published_at: item?.date,
    metadata: item
  }, index)).slice(0, maxResults);
}

async function searchExa(query, maxResults, options) {
  if (!options?.exa_api_key) throw new Error('No Exa API key');
  const resp = await fetchWithRetry('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.exa_api_key,
      Accept: 'application/json'
    },
    timeout_ms: 20000,
    body: JSON.stringify({
      query,
      type: 'neural',
      numResults: maxResults,
      contents: { text: true, highlights: true }
    })
  });
  const data = await resp.json();
  const items = Array.isArray(data?.results) ? data.results : Array.isArray(data?.searchResults) ? data.searchResults : [];
  return items.map((item, index) => normalizeSearchItem('exa', {
    title: item?.title,
    url: item?.url,
    snippet: item?.text || item?.highlight || (Array.isArray(item?.highlights) ? item.highlights.join(' ') : ''),
    full_content: item?.text || item?.highlight || (Array.isArray(item?.highlights) ? item.highlights.join(' ') : ''),
    published_at: item?.publishedDate || item?.date,
    metadata: item
  }, index)).slice(0, maxResults);
}

async function searchJina(query, maxResults, options) {
  const baseUrl = String(options?.jina_base_url || 'https://s.jina.ai').replace(/\/+$/, '');
  const url = `${baseUrl}/${encodeURIComponent(query)}`;
  const headers = { Accept: 'text/plain', 'User-Agent': 'Chatea LM/1.0' };
  if (options?.jina_api_key) {
    headers.Authorization = `Bearer ${options.jina_api_key}`;
  }
  const resp = await fetchWithRetry(url, {
    headers,
    timeout_ms: 20000
  });
  const text = await resp.text();
  return parseSearchResultsFromText('jina', text, maxResults, url);
}

async function searchYouCom(query, maxResults, options) {
  if (!options?.youcom_api_key) throw new Error('No You.com API key');
  const url = new URL('https://api.ydc-index.io/search');
  url.searchParams.set('q', query);
  url.searchParams.set('query', query);
  url.searchParams.set('num_web_results', String(maxResults));
  url.searchParams.set('max_num_results', String(maxResults));
  const resp = await fetchWithRetry(url.toString(), {
    headers: { 'X-API-Key': options.youcom_api_key, Accept: 'application/json' },
    timeout_ms: 20000
  });
  const data = await resp.json();
  const items = Array.isArray(data?.hits)
    ? data.hits
    : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.web_results)
        ? data.web_results
        : [];
  return items.map((item, index) => normalizeSearchItem('youcom', {
    title: item?.title || item?.name,
    url: item?.url || item?.link,
    snippet: item?.snippet || item?.description || item?.summary || '',
    full_content: item?.snippet || item?.description || item?.summary || '',
    published_at: item?.published_at || item?.publishedDate,
    metadata: item
  }, index)).slice(0, maxResults);
}

async function searchPerplexity(query, maxResults, options) {
  if (!options?.perplexity_api_key) throw new Error('No Perplexity API key');
  const baseUrl = String(options?.perplexity_api_url || 'https://api.perplexity.ai').replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const model = options?.perplexity_model || 'sonar';
  const conversationContext = compactSearchContext(options?.conversation_context, 1400);
  const resp = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.perplexity_api_key}`,
      Accept: 'application/json'
    },
    timeout_ms: 25000,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a web search assistant. Return concise findings with URLs when possible.'
        },
        {
          role: 'user',
          content: [
            conversationContext ? `Conversation context:\n${conversationContext}` : '',
            `Search the web for: ${query}`,
            `Return at most ${maxResults} short markdown bullets with title, URL, and one sentence snippet.`,
            'If you cannot find exact URLs, still provide the most useful answer with citations.'
          ].filter(Boolean).join('\n\n')
        }
      ],
      temperature: 0.1,
      max_tokens: 1000
    })
  });
  const data = await resp.json();
  const message = data?.choices?.[0]?.message || data?.choices?.[0]?.delta || {};
  const text = cleanText(message?.content || data?.output?.text || data?.answer || '');
  const citations = Array.isArray(data?.citations)
    ? data.citations
    : Array.isArray(message?.citations)
      ? message.citations
      : Array.isArray(data?.sources)
        ? data.sources
        : [];

  const parsed = parseSearchResultsFromText('perplexity', text, maxResults, 'https://www.perplexity.ai');
  if (parsed.length) return parsed;

  if (citations.length) {
    return citations.slice(0, maxResults).map((citation, index) => normalizeSearchItem('perplexity', {
      title: text.split(/\r?\n/).find(Boolean) || `Perplexity result ${index + 1}`,
      url: typeof citation === 'string' ? citation : citation?.url || citation?.link || '',
      snippet: text.slice(0, 1200),
      full_content: text.slice(0, 4000),
      metadata: citation
    }, index));
  }

  if (text) {
    return [normalizeSearchItem('perplexity', {
      title: `Perplexity result for ${query}`,
      url: 'https://www.perplexity.ai',
      snippet: text.slice(0, 1200),
      full_content: text.slice(0, 4000),
      metadata: data
    }, 0)];
  }

  return [];
}

async function searchDuckDuckGo(query, maxResults) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Chatea LM/1.0)' },
    timeout_ms: 12000
  });
  const html = await resp.text();

  const results = [];
  const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([^<]*)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) && results.length < maxResults) {
    const rawUrl = match[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '');
    const urlValue = rawUrl.startsWith('http') ? decodeURIComponent(rawUrl.split('&')[0]) : decodeURIComponent(rawUrl);
    results.push(normalizeSearchItem('duckduckgo', {
      title: normalizeWhitespace(match[2].replace(/<[^>]+>/g, '')),
      url: urlValue,
      snippet: normalizeWhitespace(match[3].replace(/<[^>]+>/g, '')),
      full_content: normalizeWhitespace(match[3].replace(/<[^>]+>/g, '')),
      metadata: { rawUrl: match[1] }
    }, results.length));
  }

  return results;
}

let electronSearchWindow = null;

async function searchElectron(query, maxResults) {
  try {
    if (!electronSearchWindow || electronSearchWindow.isDestroyed()) {
      electronSearchWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true
        }
      });
    }

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await electronSearchWindow.loadURL(url, { waitUntil: 'domcontentloaded' });

    await new Promise(resolve => setTimeout(resolve, 1500));

    const results = await electronSearchWindow.webContents.executeJavaScript(`
      (function() {
        const items = [];
        const resultLinks = document.querySelectorAll('a.result__a');
        const resultSnippets = document.querySelectorAll('a.result__snippet');
        
        for (let i = 0; i < Math.min(resultLinks.length, ${maxResults}); i++) {
          const link = resultLinks[i];
          const snippet = resultSnippets[i];
          
          let href = link.getAttribute('href') || '';
          if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
            try {
              href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]);
            } catch (e) {}
          }
          
          items.push({
            title: link.textContent.trim(),
            url: href,
            snippet: snippet ? snippet.textContent.trim() : ''
          });
        }
        
        return items;
      })()
    `);

    return results.map((item, index) => normalizeSearchItem('electron', {
      title: item.title || `Result ${index + 1}`,
      url: item.url || '',
      snippet: item.snippet || '',
      full_content: item.snippet || '',
      metadata: { source: 'electron_browser' }
    }, index));
  } catch (err: unknown) {
    if (electronSearchWindow && !electronSearchWindow.isDestroyed()) {
      electronSearchWindow.close();
      electronSearchWindow = null;
    }
    throw err;
  }
}

function providerSearchError(provider, err) {
  const info = classifyNetworkError(err);
  const message = err?.message || String(err || 'Search failed');
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

async function runProviderSearch(provider, query, maxResults, options) {
  switch (provider) {
    case 'tavily':
      return searchTavily(query, maxResults, options);
    case 'brave':
      return searchBrave(query, maxResults, options);
    case 'google_cse':
      return searchGoogleCse(query, maxResults, options);
    case 'serpapi':
      return searchSerpApi(query, maxResults, options);
    case 'searxng':
      return searchSearxng(query, maxResults, options);
    case 'electron':
      return searchElectron(query, maxResults);
    case 'bing':
      return searchBing(query, maxResults, options);
    case 'serper':
      return searchSerper(query, maxResults, options);
    case 'exa':
      return searchExa(query, maxResults, options);
    case 'jina':
      return searchJina(query, maxResults, options);
    case 'youcom':
      return searchYouCom(query, maxResults, options);
    case 'perplexity':
      return searchPerplexity(query, maxResults, options);
    case 'duckduckgo':
      return searchDuckDuckGo(query, maxResults, options);
    default:
      throw new Error(`Unsupported search provider: ${provider}`);
  }
}

async function fetchPageContent(url, options = {}) {
  try {
    const readerUrl = buildJinaReaderUrl(url, 'https://r.jina.ai');
    if (!readerUrl) return null;
    const headers = { Accept: 'text/plain', 'X-Return-Format': 'markdown', 'User-Agent': 'Chatea LM/1.0' };
    if (options.jina_api_key) {
      headers.Authorization = `Bearer ${options.jina_api_key}`;
    }
    const resp = await fetchWithRetry(readerUrl, {
      headers,
      timeout_ms: 22000
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    return text.slice(0, 10000);
  } catch {
    return null;
  }
}

async function enrichWithDeepContent(results, limit, emit, options = {}) {
  const items = results.slice(0, limit);
  const fetched = await Promise.allSettled(
    items.map(async (result, index) => {
      if (!result.url) return null;
      emit('fetching_page', `Reading page ${index + 1}: ${result.url}`);
      const content = await fetchPageContent(result.url, options);
      return content ? { ...result, full_content: content } : result;
    })
  );

  return results.map((result, index) => {
    if (index >= limit) return result;
    const entry = fetched[index];
    if (!entry || entry.status !== 'fulfilled' || !entry.value) return result;
    return entry.value;
  });
}

export async function webSearch({ query, context, deep, mode, options }, win = null) {
  const normalizedQuery = normalizeWhitespace(query);
  const conversationContext = compactSearchContext(context || options?.conversation_context || '');
  const effectiveQuery = buildEffectiveSearchQuery(normalizedQuery, conversationContext);
  const searchMode = mode === 'max' ? 'max' : deep ? 'deep' : 'search';
  const explicitProvider = normalizeProviderName(options?.provider || 'auto');
  const maxResults = Math.max(1, Math.min(Number(options?.max_results) || 6, 20));
  const contextBudget = Math.max(500, Number(options?.context_budget_chars) || DEFAULT_CONTEXT_BUDGET[searchMode] || DEFAULT_CONTEXT_BUDGET.search);
  const searchOptions = {
    ...(options || {}),
    conversation_context: conversationContext
  };
  const emit = (step, detail) => {
    try {
      win?.webContents?.send('search-progress', { step, detail });
    } catch {
      // ignore renderer channel errors
    }
  };

  emit('searching', `Searching for: ${effectiveQuery || normalizedQuery}`);

  if (!normalizedQuery) {
    return { query: normalizedQuery, results: [], context: '', provider_used: 'none', search_mode: searchMode };
  }

  const cacheKey = getCacheKey(effectiveQuery, searchMode, explicitProvider);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    emit('results', `Using cached results from ${cached.provider_used}`);
    return { ...cached, query: normalizedQuery, effective_query: effectiveQuery, search_mode: searchMode, cached: true };
  }

  const configuredProviders = providerCandidates(explicitProvider, searchOptions, searchMode);
  let providerResults = [];
  let providerUsed = 'none';
  let lastError = null;
  const providerAttempts = [];
  const minimumUsefulResults = searchMode === 'search' ? 1 : Math.min(3, maxResults);

  if (explicitProvider !== 'auto') {
    if (!providerHasCredentials(explicitProvider, searchOptions) && explicitProvider !== 'duckduckgo' && explicitProvider !== 'jina' && explicitProvider !== 'electron') {
      const credHint = explicitProvider === 'google_cse'
        ? 'Google CSE requires an API key and Search Engine ID — configure them in Settings > Search'
        : `Missing credentials for ${providerDisplayName(explicitProvider)} — add an API key in Settings > Search`;
      const error = providerSearchError(explicitProvider, new Error(credHint));
      return {
        ...error,
        query: normalizedQuery,
        effective_query: effectiveQuery,
        search_mode: searchMode,
        provider_attempts: [{ provider: explicitProvider, success: false, resultCount: 0, error: credHint }]
      };
    }

    try {
      providerResults = await runProviderSearch(explicitProvider, effectiveQuery, searchMode === 'max' ? Math.max(maxResults * 2, maxResults + 4) : maxResults, searchOptions);
      providerUsed = explicitProvider;
      providerAttempts.push({ provider: explicitProvider, success: providerResults.length > 0, resultCount: providerResults.length });
    } catch (err: unknown) {
      providerAttempts.push({ provider: explicitProvider, success: false, resultCount: 0, error: toErrorMessage(err) });
      const error = providerSearchError(explicitProvider, err);
      return { ...error, query: normalizedQuery, effective_query: effectiveQuery, search_mode: searchMode, provider_attempts: providerAttempts };
    }
  } else if (searchMode === 'max') {
    emit('results', `Querying ${configuredProviders.length} providers...`);
    const settled = await Promise.allSettled(
      configuredProviders.map((provider) => runProviderSearch(provider, effectiveQuery, Math.max(maxResults, 6), searchOptions))
    );

    for (let i = 0; i < settled.length; i += 1) {
      const entry = settled[i];
      const provider = configuredProviders[i];
      if (entry.status === 'fulfilled') {
        providerResults.push(...entry.value);
        providerAttempts.push({ provider, success: entry.value.length > 0, resultCount: entry.value.length });
      } else {
        lastError = entry.reason;
        providerAttempts.push({ provider, success: false, resultCount: 0, error: entry.reason?.message || String(entry.reason || 'Search failed') });
        emit('provider_failed', `${providerDisplayName(provider)} failed: ${classifyNetworkError(entry.reason).hint}`);
      }
    }
    providerUsed = providerResults.length
      ? Array.from(new Set(providerResults.map((result) => result.provider).filter(Boolean))).join('+')
      : 'none';
  } else {
    for (const provider of configuredProviders) {
      try {
        emit('provider_searching', `Searching ${providerDisplayName(provider)}...`);
        const results = await runProviderSearch(provider, effectiveQuery, maxResults, searchOptions);
        providerAttempts.push({ provider, success: results.length > 0, resultCount: results.length });
        if (results.length) {
          providerResults.push(...results);
          providerUsed = providerResults.length
            ? Array.from(new Set(providerResults.map((result) => result.provider || provider).filter(Boolean))).join('+')
            : provider;
          if (results.length >= minimumUsefulResults || searchMode === 'search') break;
          emit('provider_failed', `${providerDisplayName(provider)} returned only ${results.length} result(s); trying another provider...`);
        }
      } catch (err: unknown) {
        lastError = err;
        providerAttempts.push({ provider, success: false, resultCount: 0, error: toErrorMessage(err) });
        emit('provider_failed', `${providerDisplayName(provider)} failed: ${classifyNetworkError(err).hint}`);
      }
    }
  }

  if (!providerResults.length) {
    const info = classifyNetworkError(lastError || new Error('No results'));
    return {
      query: normalizedQuery,
      effective_query: effectiveQuery,
      results: [],
      context: '',
      provider_used: providerUsed,
      search_mode: searchMode,
      error: lastError?.message || 'No search results were returned.',
      error_type: info.error_type,
      retryable: info.retryable,
      provider_attempts: providerAttempts
    };
  }

  const responseLimit = searchMode === 'max'
    ? Math.min(24, Math.max(maxResults * 2, 12))
    : searchMode === 'deep'
      ? Math.max(maxResults, 8)
      : maxResults;

  let mergedResults = mergeAndRankResults(providerResults, effectiveQuery, responseLimit);

  if (searchMode !== 'search') {
    const deepLimit = Math.min(
      mergedResults.length,
      searchMode === 'max' ? 6 : 3
    );
    emit('deep_fetching', `Fetching full content from top ${deepLimit} pages...`);
    const enriched = await enrichWithDeepContent(mergedResults, deepLimit, emit, searchOptions);
    mergedResults = mergeAndRankResults(enriched, effectiveQuery, responseLimit);
    emit('deep_done', 'Deep content ready');
  }

  const searchContext = buildContext(mergedResults, contextBudget);
  emit('results', `Found ${mergedResults.length} results via ${providerUsed}`);

  const result = {
    query: normalizedQuery,
    effective_query: effectiveQuery,
    results: mergedResults,
    context: searchContext,
    provider_used: providerUsed,
    search_mode: searchMode,
    provider_attempts: providerAttempts
  };

  setCachedResult(cacheKey, result);
  return result;
}

export async function ingestSearchContext(chatId, context, sources) {
  const ragEngine = await import('./rag-engine.js');
  const normalizedChatId = String(chatId || '').trim();
  if (!normalizedChatId) throw new Error('chatId is required for search context ingestion');
  const entries = Array.isArray(sources) ? sources : [];

  const sourceText = entries
    .map((source, index) => {
      const lines = [
        `# Source ${index + 1}`,
        source?.title ? `Title: ${source.title}` : null,
        source?.url ? `URL: ${source.url}` : null,
        source?.provider ? `Provider: ${source.provider}` : null,
        source?.snippet ? `Snippet: ${source.snippet}` : null,
        source?.full_content ? `Content: ${String(source.full_content).slice(0, 4000)}` : null
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n\n---\n\n');

  const fullText = String(context || '').trim() || sourceText;
  const ingest = typeof ragEngine.ingestTextFast === 'function' ? ragEngine.ingestTextFast : ragEngine.ingestText;
  await ingest({
    source: 'web_search',
    text: fullText,
    chat_id: normalizedChatId,
    file_type: 'search'
  });
  return entries.length;
}

export async function fetchModelCatalog() {
  return {
    llm: LOCAL_GGUF_CATALOG,
    tts: TTS_MODEL_CATALOG,
    whisper: WHISPER_QUALITY_CATALOG,
    embeddings: EMBEDDING_MODEL_CATALOG
  };
}

export async function searchHfModels(query, sort = 'trending', limit = 20) {
  try {
    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=${encodeURIComponent(sort)}&limit=${limit}`;
    const resp = await fetchWithRetry(url, { timeout_ms: 15000 });
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

export async function hfRepoGguf(repoId) {
  try {
    const url = `https://huggingface.co/api/models/${repoId}`;
    const resp = await fetchWithRetry(url, { timeout_ms: 15000 });
    if (!resp.ok) return null;
    const data = await resp.json();
    const siblings = Array.isArray(data?.siblings) ? data.siblings : [];
    const ggufFiles = siblings
      .filter((item) => item?.rfilename?.endsWith('.gguf'))
      .map((item) => ({
        name: item.rfilename,
        size: item.size || 0
      }));
    return { repo_id: repoId, model_id: data.modelId, files: ggufFiles };
  } catch {
    return null;
  }
}
