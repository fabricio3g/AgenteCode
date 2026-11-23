import { APP_USER_AGENT } from '../shared/brand.ts';
import { createHash } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  fetchWithRetry, normalizeWhitespace, compactSearchContext, buildEffectiveSearchQuery,
  normalizeProviderName, providerHasCredentials, providerDisplayName, providerCandidates,
  getCacheKey, getCachedResult, setCachedResult, mergeAndRankResults, buildContext,
  buildJinaReaderUrl, toErrorMessage, classifyNetworkError, providerSearchError,
  REMOVED_SEARCH_PROVIDERS
} from './search-providers/shared.ts';
import type { SearchResult } from './search-providers/shared.ts';
import {
  searchTavily, searchBrave, searchSearxng, searchExa, searchJina, searchYouCom, searchPerplexity
} from './search-providers/providers.ts';
import { searchAggregator } from './search-providers/aggregator.ts';
import { isSafePublicUrl, scrapeUrlStructured } from './web-scraper.ts';

async function runProviderSearch(provider: string, query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  switch (provider) {
    case 'aggregator': return searchAggregator(query, maxResults, options);
    case 'tavily': return searchTavily(query, maxResults, options);
    case 'brave': return searchBrave(query, maxResults, options);
    case 'searxng': return searchSearxng(query, maxResults, options);
    case 'exa': return searchExa(query, maxResults, options);
    case 'jina': return searchJina(query, maxResults, options);
    case 'youcom': return searchYouCom(query, maxResults, options);
    case 'perplexity': return searchPerplexity(query, maxResults, options);
    default: throw new Error(`Unsupported search provider: ${provider}`);
  }
}

type FetchedPage = {
  content: string;
  title?: string;
  site_name?: string;
  author?: string;
  published_at?: string;
  quality?: string;
  warning?: string;
};

/** A result's whole page, read through Reader View — no character budget. */
async function fetchPageContent(url: string, options: Record<string, unknown> = {}): Promise<FetchedPage | null> {
  if (!isSafePublicUrl(url)) return null;
  try {
    if (options?.use_local_readability !== false) {
      const scraped = await scrapeUrlStructured({
        url,
        timeoutMs: 18000,
        maxLinks: 80,
      }) as {
        content?: string;
        title?: string;
        site_name?: string;
        author?: string;
        published_at?: string;
        quality?: string;
        warning?: string;
        error?: string;
      };
      const content = String(scraped?.content || '').trim();
      if (content) {
        return {
          content,
          title: scraped?.title,
          site_name: scraped?.site_name,
          author: scraped?.author,
          published_at: scraped?.published_at,
          quality: scraped?.quality,
          warning: scraped?.warning
        };
      }
    }

    if (!isSafePublicUrl(url)) return null;
    const readerUrl = buildJinaReaderUrl(url, 'https://r.jina.ai');
    if (!readerUrl) return null;
    const headers: Record<string, string> = { Accept: 'text/plain', 'X-Return-Format': 'markdown', 'User-Agent': APP_USER_AGENT };
    if (options.jina_api_key) {
      headers.Authorization = `Bearer ${options.jina_api_key as string}`;
    }
    const resp = await fetchWithRetry(readerUrl, { headers, timeout_ms: 22000 });
    if (!resp.ok) return null;
    return { content: (await resp.text()).trim(), quality: 'ok' };
  } catch {
    return null;
  }
}

/** Prefer pages with more query-relevant title/snippet before scraping. */
function scoreResultForDeepFetch(result: SearchResult, query: string): number {
  const terms = normalizeWhitespace(query).toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 2).slice(0, 12) || [];
  const title = normalizeWhitespace(result.title || '').toLowerCase();
  const snippet = normalizeWhitespace(result.snippet || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 3;
    if (snippet.includes(term)) score += 1;
  }
  // Prefer https and known content domains slightly
  try {
    const host = new URL(result.url || '').hostname.replace(/^www\./, '');
    if (host.endsWith('.edu') || host.endsWith('.gov') || host.endsWith('.org')) score += 1.5;
    if (result.url?.startsWith('https://')) score += 0.5;
  } catch { /* ignore */ }
  if (result.full_content && String(result.full_content).length > 800) score += 2;
  return score;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));

  async function runOne() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runOne()));
  return results;
}

async function enrichWithDeepContent(results: SearchResult[], limit: number, emit: (step: string, detail: string) => void, options: Record<string, unknown> = {}): Promise<SearchResult[]> {
  const query = String(options?.search_query || '');
  // Rank candidates before scrape; deprioritize empty URLs
  const ranked = [...results]
    .map((r, index) => ({ r, index, score: scoreResultForDeepFetch(r, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const pick = ranked.slice(0, limit).filter((x) => x.r.url);
  const concurrency = Math.max(1, Math.min(Number(options?.scrape_concurrency) || 3, 4));

  emit('deep_fetching', `Reading up to ${pick.length} pages (concurrency ${concurrency})…`);

  const fetched = await mapWithConcurrency(pick, concurrency, async (item, i) => {
    emit('fetching_page', `Reading page ${i + 1}/${pick.length}: ${item.r.url}`);
    try {
      const page = await fetchPageContent(item.r.url, {
        ...options,
        search_query: options?.search_query || item.r.title || item.r.snippet || ''
      });
      const content = page?.content || '';
      const meta = {
        ...(item.r.metadata || {}),
        site_name: page?.site_name || (item.r.metadata as Record<string, unknown> | undefined)?.site_name,
        author: page?.author || (item.r.metadata as Record<string, unknown> | undefined)?.author,
        quality: page?.quality || (normalizeWhitespace(content).length < 200 ? 'thin' : 'ok'),
        warning: page?.warning,
        scrape_quality: normalizeWhitespace(content).length < 200 ? 'thin' : 'ok'
      };
      if (!content || normalizeWhitespace(content).length < 200) {
        return {
          ...item.r,
          title: page?.title || item.r.title,
          full_content: content || undefined,
          published_at: page?.published_at || item.r.published_at,
          metadata: meta,
          scrape_quality: 'thin' as const
        };
      }
      return {
        ...item.r,
        title: page?.title || item.r.title,
        full_content: content,
        published_at: page?.published_at || item.r.published_at,
        metadata: meta,
        scrape_quality: 'ok' as const
      };
    } catch {
      return {
        ...item.r,
        scrape_quality: 'blocked' as const,
        metadata: { ...(item.r.metadata || {}), quality: 'blocked', scrape_quality: 'blocked' }
      };
    }
  });

  const byUrl = new Map<string, SearchResult>();
  for (let i = 0; i < pick.length; i += 1) {
    const entry = fetched[i];
    if (entry?.status === 'fulfilled' && entry.value?.url) {
      byUrl.set(entry.value.url, entry.value);
    }
  }

  // Prefer results with good full_content when re-ranking
  return results.map((result) => {
    if (!result.url) return result;
    return byUrl.get(result.url) || result;
  });
}

export async function webSearch({ query, context, deep, mode, options }: { query: string; context?: string; deep?: boolean; mode?: string; options?: Record<string, unknown> }, win: BrowserWindow | null = null) {
  const normalizedQuery = normalizeWhitespace(query);
  const conversationContext = compactSearchContext(context || options?.conversation_context || '');
  const effectiveQuery = buildEffectiveSearchQuery(normalizedQuery, conversationContext);
  const searchMode = mode === 'max' ? 'max' : deep ? 'deep' : 'search';
  const requestedProvider = normalizeProviderName(options?.provider || 'auto');
  // A saved choice of a removed provider (a scraper or reseller) searches with auto.
  const explicitProvider = REMOVED_SEARCH_PROVIDERS.includes(requestedProvider) ? 'auto' : requestedProvider;
  const maxResults = Math.max(1, Math.min(Number(options?.max_results) || 6, 20));
  const searchOptions = { ...(options || {}), conversation_context: conversationContext, search_query: effectiveQuery || normalizedQuery };

  const emit = (step: string, detail: string) => {
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

  // Search config arrives as flat options, plus the ordered list of aggregator engines.
  // Digest it so a changed credential partitions the cache without storing the raw key.
  const cacheOptions = Object.entries(options ?? {})
    .filter(([key, value]) => key !== 'provider' && key !== 'max_results' && (
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      || (key === 'aggregator_engines' && Array.isArray(value) && value.every((engine) => typeof engine === 'string'))
    ))
    .sort(([left], [right]) => left.localeCompare(right));
  const cacheDiscriminator = createHash('sha256')
    .update(JSON.stringify([maxResults, conversationContext, cacheOptions]))
    .digest('hex');
  const cacheKey = getCacheKey(effectiveQuery, searchMode, explicitProvider, cacheDiscriminator);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    const cachedResult = cached as { provider_used: string };
    emit('results', `Using cached results from ${cachedResult.provider_used}`);
    return { ...cached, query: normalizedQuery, effective_query: effectiveQuery, search_mode: searchMode, cached: true };
  }

  const configuredProviders = providerCandidates(explicitProvider, searchOptions, searchMode);
  let providerResults: SearchResult[] = [];
  let providerUsed = 'none';
  let lastError: unknown = null;
  const providerAttempts: Array<{ provider: string; success: boolean; resultCount: number; error?: string }> = [];
  const minimumUsefulResults = searchMode === 'search' ? 1 : Math.min(3, maxResults);

  if (explicitProvider !== 'auto') {
    if (!providerHasCredentials(explicitProvider, searchOptions)) {
      const credHint = `Missing credentials for ${providerDisplayName(explicitProvider)} — add an API key in Settings > Search`;
      const error = providerSearchError(explicitProvider, new Error(credHint));
      return { ...error, query: normalizedQuery, effective_query: effectiveQuery, search_mode: searchMode, provider_attempts: [{ provider: explicitProvider, success: false, resultCount: 0, error: credHint }] };
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
      error: (lastError instanceof Error ? lastError.message : 'No search results were returned.'),
      error_type: info.error_type,
      retryable: info.retryable,
      provider_attempts: providerAttempts,
      engine_attempts: (searchOptions.aggregator_diagnostics as { engine_attempts?: unknown[] } | undefined)?.engine_attempts || [],
      aggregation_elapsed_ms: (searchOptions.aggregator_diagnostics as { elapsed_ms?: number } | undefined)?.elapsed_ms,
      aggregation_deadline_reached: (searchOptions.aggregator_diagnostics as { deadline_reached?: boolean } | undefined)?.deadline_reached,
    };
  }

  const responseLimit = searchMode === 'max'
    ? Math.min(40, Math.max(maxResults * 2, 18))
    : searchMode === 'deep'
      ? Math.max(maxResults, 12)
      : maxResults;

  let mergedResults = mergeAndRankResults(providerResults, effectiveQuery, responseLimit);

  // All research product modes scrape pages so synthesis uses real text, not SERP titles alone.
  // Search = light (top 4); deep = 8; max = 12.
  {
    const deepLimit = Math.min(
      mergedResults.length,
      searchMode === 'max' ? 12 : searchMode === 'deep' ? 8 : 4
    );
    const enriched = await enrichWithDeepContent(mergedResults, deepLimit, emit, {
      ...searchOptions,
      scrape_concurrency: searchMode === 'max' ? 4 : 3
    });
    // Prefer pages with full_content after enrich
    const withContent = enriched.filter((r) => r.full_content && String(r.full_content).length > 400);
    const without = enriched.filter((r) => !r.full_content || String(r.full_content).length <= 400);
    mergedResults = mergeAndRankResults([...withContent, ...without], effectiveQuery, responseLimit);
    const okCount = withContent.length;
    emit('deep_done', okCount
      ? `Page content ready (${okCount} readable page${okCount === 1 ? '' : 's'})`
      : 'Page fetch finished but little readable content was extracted');
  }

  const searchedAt = new Date().toISOString();
  const searchContext = [
    `Search performed at: ${searchedAt}`,
    `Search query: ${effectiveQuery || normalizedQuery}`,
    buildContext(mergedResults)
  ].filter(Boolean).join('\n\n');
  emit('results', `Found ${mergedResults.length} results via ${providerUsed}`);

  const result = {
    query: normalizedQuery,
    effective_query: effectiveQuery,
    results: mergedResults,
    context: searchContext,
    provider_used: providerUsed,
    search_mode: searchMode,
    searched_at: searchedAt,
    provider_attempts: providerAttempts,
    engine_attempts: (searchOptions.aggregator_diagnostics as { engine_attempts?: unknown[] } | undefined)?.engine_attempts || [],
    aggregation_elapsed_ms: (searchOptions.aggregator_diagnostics as { elapsed_ms?: number } | undefined)?.elapsed_ms,
    aggregation_deadline_reached: (searchOptions.aggregator_diagnostics as { deadline_reached?: boolean } | undefined)?.deadline_reached,
  };

  setCachedResult(cacheKey, result);
  return result;
}

export async function ingestSearchContext(chatId: string, context: string, sources: unknown[]) {
  const ragEngine = await import('./rag-engine.js');
  const normalizedChatId = String(chatId || '').trim();
  if (!normalizedChatId) throw new Error('chatId is required for search context ingestion');
  const entries = Array.isArray(sources) ? sources : [];

  const sourceText = entries
    .map((source, index) => {
      const src = source as { title?: string; url?: string; provider?: string; snippet?: string; full_content?: string };
      const lines = [
        `# Source ${index + 1}`,
        src?.title ? `Title: ${src.title}` : null,
        src?.url ? `URL: ${src.url}` : null,
        src?.provider ? `Provider: ${src.provider}` : null,
        src?.snippet ? `Snippet: ${src.snippet}` : null,
        src?.full_content ? `Content: ${String(src.full_content)}` : null
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
