import { BrowserWindow } from 'electron';
import { LOCAL_GGUF_CATALOG, TTS_MODEL_CATALOG, WHISPER_QUALITY_CATALOG } from './config.ts';
import { EMBEDDING_MODEL_CATALOG } from './rag/embedding-catalog.ts';
import {
  fetchWithRetry, normalizeWhitespace, compactSearchContext, buildEffectiveSearchQuery,
  normalizeProviderName, providerHasCredentials, providerDisplayName, providerCandidates,
  getCacheKey, getCachedResult, setCachedResult, mergeAndRankResults, buildContext,
  buildJinaReaderUrl, toErrorMessage, classifyNetworkError, providerSearchError,
  DEFAULT_CONTEXT_BUDGET,
  REMOVED_SEARCH_PROVIDERS
} from './search-providers/shared.ts';
import type { SearchResult } from './search-providers/shared.ts';
import {
  searchTavily, searchBrave, searchSearxng, searchExa, searchJina, searchYouCom, searchPerplexity
} from './search-providers/providers.ts';
import { searchAggregator } from './search-providers/aggregator.ts';
import { scrapeUrlStructured } from './web-scraper.ts';

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

async function fetchPageContent(url: string, options: Record<string, unknown> = {}): Promise<FetchedPage | null> {
  try {
    if (options?.use_local_readability !== false) {
      const scraped = await scrapeUrlStructured({
        url,
        maxLength: 30000,
        timeoutMs: 18000,
        maxLinks: 80,
      }) as {
        content?: string;
        excerpt?: string;
        title?: string;
        site_name?: string;
        author?: string;
        published_at?: string;
        quality?: string;
        warning?: string;
        error?: string;
      };
      const readable = compactPageContent(scraped?.content || '', String(options?.search_query || ''), 9000);
      const header = [scraped?.title, scraped?.excerpt].map(normalizeWhitespace).filter(Boolean).join('\n\n');
      const content = [header, readable].filter(Boolean).join('\n\n');
      if (content) {
        return {
          content: content.slice(0, 10000),
          title: scraped?.title,
          site_name: scraped?.site_name,
          author: scraped?.author,
          published_at: scraped?.published_at,
          quality: scraped?.quality,
          warning: scraped?.warning
        };
      }
    }

    const readerUrl = buildJinaReaderUrl(url, 'https://r.jina.ai');
    if (!readerUrl) return null;
    const headers: Record<string, string> = { Accept: 'text/plain', 'X-Return-Format': 'markdown', 'User-Agent': 'FlaxeoChat/1.0' };
    if (options.jina_api_key) {
      headers.Authorization = `Bearer ${options.jina_api_key as string}`;
    }
    const resp = await fetchWithRetry(readerUrl, { headers, timeout_ms: 22000 });
    if (!resp.ok) return null;
    const text = await resp.text();
    return { content: text.slice(0, 10000), quality: 'ok' };
  } catch {
    return null;
  }
}

function scoreParagraph(text: string, terms: string[]): number {
  const haystack = normalizeWhitespace(text).toLowerCase();
  if (!haystack || !terms.length) return 0;
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (haystack.includes(term)) score += 1;
    const hits = haystack.match(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) || [];
    score += Math.min(hits.length, 3) * 0.25;
  }
  return score;
}

function compactPageContent(content: string, query: string, maxChars: number): string {
  const normalized = String(content || '').trim();
  if (!normalized) return '';
  const budget = Math.max(1200, Math.min(Number(maxChars) || 6000, 12000));
  if (normalizeWhitespace(normalized).length <= budget) return normalized;

  const terms = normalizeWhitespace(query).toLowerCase().match(/[a-z0-9]+/g)?.filter((term) => term.length > 2).slice(0, 12) || [];
  const rawBlocks = normalized.split(/\n\s*\n+/);

  let currentHeading = '';
  const paragraphs: Array<{ paragraph: string; index: number; score: number; heading: string }> = [];
  for (let i = 0; i < rawBlocks.length; i += 1) {
    const block = rawBlocks[i].trim();
    if (!block) continue;
    if (/^#{1,4}\s+/.test(block)) {
      currentHeading = block;
    } else if (block.length > 80) {
      paragraphs.push({ paragraph: block, index: i, score: scoreParagraph(block, terms), heading: currentHeading });
    }
  }

  if (!paragraphs.length) return normalizeWhitespace(normalized).slice(0, budget);

  const ranked = [...paragraphs].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });

  const selected: typeof paragraphs = [];
  const includedHeadings = new Set<string>();
  let used = 0;
  for (const item of ranked) {
    if (used >= budget) break;
    const headingCost = item.heading && !includedHeadings.has(item.heading) ? item.heading.length + 4 : 0;
    if (used + item.paragraph.length + headingCost > budget * 1.15) continue;
    selected.push(item);
    used += item.paragraph.length + 2 + headingCost;
    if (headingCost) includedHeadings.add(item.heading);
  }

  selected.sort((left, right) => left.index - right.index);
  const result: string[] = [];
  let lastHeading = '';
  for (const item of selected) {
    if (item.heading && item.heading !== lastHeading) {
      result.push(item.heading);
      lastHeading = item.heading;
    }
    result.push(item.paragraph);
  }

  return result.join('\n\n').slice(0, budget);
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
  const contextBudget = Math.max(500, Number(options?.context_budget_chars) || DEFAULT_CONTEXT_BUDGET[searchMode as keyof typeof DEFAULT_CONTEXT_BUDGET] || DEFAULT_CONTEXT_BUDGET.search);
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

  const cacheDiscriminator = explicitProvider === 'aggregator' || explicitProvider === 'auto'
    ? JSON.stringify([options?.aggregator_engines || [], options?.safe_search ?? 2])
    : '';
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
    buildContext(mergedResults, contextBudget)
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
        src?.full_content ? `Content: ${String(src.full_content).slice(0, 4000)}` : null
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

function hfHeaders(hfToken?: string): Record<string, string> | undefined {
  const token = String(hfToken || '').trim();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function hfFileName(file: { rfilename?: string; path?: string }) {
  return String(file?.rfilename || file?.path || '').trim();
}

function isHfModelGgufFile(file: { rfilename?: string; path?: string }) {
  const filename = hfFileName(file).toLowerCase();
  return filename.endsWith('.gguf') && !filename.includes('mmproj');
}

function hfFileSize(file: { size?: number; lfs?: { size?: number } }) {
  return Number(file?.size || file?.lfs?.size || 0);
}

function normalizeGgufFile(file: { rfilename?: string; path?: string; size?: number; lfs?: { size?: number } }) {
  const filename = hfFileName(file);
  const size = hfFileSize(file);
  return {
    filename,
    name: filename,
    size,
    size_human: formatBytes(size),
  };
}

async function fetchHfTreeSizes(repoId: string, hfToken?: string): Promise<Map<string, number>> {
  try {
    const url = `https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`;
    const resp = await fetchWithRetry(url, { headers: hfHeaders(hfToken), timeout_ms: 15000 });
    if (!resp.ok) return new Map();
    const data = await resp.json() as Array<{ path?: string; size?: number; lfs?: { size?: number } }>;
    if (!Array.isArray(data)) return new Map();
    return new Map(
      data
        .map((item) => [hfFileName(item), hfFileSize(item)] as const)
        .filter(([path, size]) => isHfModelGgufFile({ path }) && size > 0)
    );
  } catch {
    return new Map();
  }
}

function isLikelyLlmHfModel(item: Record<string, unknown>): boolean {
  const repoId = String(item.id || item.modelId || '').toLowerCase();
  const pipeline = String(item.pipeline_tag || '').toLowerCase();
  const tags = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).toLowerCase()) : [];
  const haystack = `${repoId} ${pipeline} ${tags.join(' ')}`;

  if (pipeline === 'text-generation' || tags.includes('text-generation')) return true;
  return /(llm|llama|qwen|gemma|mistral|mixtral|phi|deepseek|codellama|starcoder|falcon|chatglm|baichuan|internlm|gpt-?oss|gpt-?neo|tinyllama|vicuna|dolphin|orca|hermes|openchat)/i.test(haystack);
}

function normalizeHfModel(item: Record<string, unknown>): Record<string, unknown> {
  const repoId = String(item.id || item.modelId || '').trim();
  const siblings = Array.isArray(item.siblings) ? item.siblings as Array<{ rfilename?: string; size?: number; lfs?: { size?: number } }> : [];
  const ggufFiles = siblings.filter(isHfModelGgufFile);
  const normalizedGgufFiles = ggufFiles.map(normalizeGgufFile);
  const largest = normalizedGgufFiles.reduce((max, file) => Math.max(max, Number(file.size || 0)), 0);
  const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
  const name = repoId.split('/').pop() || repoId;
  const sizeMatch = name.match(/(?:^|[-_])([0-9]+(?:\.[0-9]+)?\s*[bB])(?:[-_]|$)/);

  const cardLicense = (item.cardData as { license?: unknown } | undefined)?.license;
  const license = String(tags.find((tag) => tag.startsWith('license:'))?.slice(8) || (typeof cardLicense === 'string' ? cardLicense : '') || '');

  return {
    ...item,
    repo_id: repoId,
    label: name,
    license,
    author: repoId.split('/')[0] || 'Hugging Face',
    size_label: sizeMatch ? sizeMatch[1].replace(/\s+/g, '').toUpperCase() : undefined,
    has_vision: /vision|vl|mmproj/i.test(`${repoId} ${tags.join(' ')}`),
    has_tools: /tool|function/i.test(tags.join(' ')),
    downloads: Number(item.downloads || 0),
    likes: Number(item.likes || 0),
    gguf_files_count: ggufFiles.length || undefined,
    gguf_files: normalizedGgufFiles,
    files: normalizedGgufFiles,
    largest_gguf_human: largest ? formatBytes(largest) : undefined,
  };
}

export async function searchHfModels(
  query: string,
  sort = 'trending',
  limit = 20,
  hfToken?: string,
  cursor?: string,
  paged = false,
) {
  try {
    const params = new URLSearchParams({
      search: query,
      sort,
      limit: String(limit),
      full: 'true',
      blobs: 'true',
    });
    params.append('filter', 'gguf');
    params.append('filter', 'text-generation');
    const requestedCursor = String(cursor || '');
    const url = requestedCursor.startsWith('https://huggingface.co/api/models?')
      ? requestedCursor
      : `https://huggingface.co/api/models?${params.toString()}`;
    const resp = await fetchWithRetry(url, { headers: hfHeaders(hfToken), timeout_ms: 15000 });
    if (!resp.ok) {
      if (!paged) return [];
      const errorCode = resp.status === 401 || resp.status === 403
        ? 'authentication'
        : resp.status === 429 ? 'rate_limit' : 'network';
      const error = errorCode === 'authentication'
        ? 'This repository or search requires a valid Hugging Face token.'
        : errorCode === 'rate_limit'
          ? 'Hugging Face rate limit reached. Wait a moment and try again.'
          : `Hugging Face search failed (${resp.status}).`;
      return { items: [], nextCursor: null, error, errorCode };
    }
    const data = await resp.json();
    const items = Array.isArray(data)
      ? data.filter((item) => isLikelyLlmHfModel(item as Record<string, unknown>)).map((item) => normalizeHfModel(item as Record<string, unknown>))
      : [];
    if (!paged) return items;
    const link = resp.headers.get('link') || '';
    const nextCursor = link
      .split(',')
      .map((part) => part.trim())
      .find((part) => /rel="?next"?/i.test(part))
      ?.match(/<([^>]+)>/)?.[1] ?? null;
    return { items, nextCursor };
  } catch (error) {
    if (!paged) return [];
    return {
      items: [],
      nextCursor: null,
      error: String((error as Error)?.message || error || 'Hugging Face search failed.'),
      errorCode: 'network',
    };
  }
}

export async function hfRepoGguf(repoId: string, hfToken?: string) {
  try {
    const url = `https://huggingface.co/api/models/${repoId}?blobs=true`;
    const resp = await fetchWithRetry(url, { headers: hfHeaders(hfToken), timeout_ms: 15000 });
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, unknown>;
    const siblings = Array.isArray(data?.siblings) ? data.siblings as Array<{ rfilename?: string; size?: number; lfs?: { size?: number } }> : [];
    let ggufFiles = siblings
      .filter(isHfModelGgufFile)
      .map(normalizeGgufFile);

    if (ggufFiles.some((file) => !file.size)) {
      const treeSizes = await fetchHfTreeSizes(repoId, hfToken);
      ggufFiles = ggufFiles.map((file) => {
        const size = file.size || treeSizes.get(file.filename) || 0;
        return { ...file, size, size_human: formatBytes(size) };
      });
    }
    const projectorFiles = siblings
      .filter((file) => /(?:^|[/_-])mmproj[^/]*\.gguf$/i.test(String(file.rfilename || '')))
      .map(normalizeGgufFile);
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
    return {
      repo_id: repoId,
      model_id: data.modelId as string | undefined,
      gguf_files: ggufFiles,
      files: ggufFiles,
      projector_files: projectorFiles,
      gated: data.gated,
      license: tags.find((tag) => tag.startsWith('license:'))?.slice('license:'.length),
    };
  } catch {
    return null;
  }
}

const HF_README_MAX_CHARS = 40000;

export async function fetchHfReadme(repoId: string, hfToken?: string) {
  try {
    if (!repoId || typeof repoId !== 'string' || repoId.includes('..')) {
      return { repo_id: repoId, readme: '', error: 'Invalid repository id.' };
    }
    const url = `https://huggingface.co/${repoId}/resolve/main/README.md`;
    const resp = await fetchWithRetry(url, { headers: hfHeaders(hfToken), timeout_ms: 15000 });
    if (!resp.ok) return { repo_id: repoId, readme: '' };
    const text = await resp.text();
    const trimmed = text.length > HF_README_MAX_CHARS
      ? text.slice(0, HF_README_MAX_CHARS) + '\n\n… (truncated)'
      : text;
    return { repo_id: repoId, readme: trimmed };
  } catch (error) {
    return { repo_id: repoId, readme: '', error: String((error as Error)?.message || error) };
  }
}
