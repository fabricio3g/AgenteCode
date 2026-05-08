import { BrowserWindow } from 'electron';
import { LOCAL_GGUF_CATALOG, TTS_MODEL_CATALOG, WHISPER_QUALITY_CATALOG } from './config.ts';
import { EMBEDDING_MODEL_CATALOG } from './rag/embedding-catalog.ts';
import {
  fetchWithRetry, normalizeWhitespace, compactSearchContext, buildEffectiveSearchQuery,
  normalizeProviderName, providerHasCredentials, providerDisplayName, providerCandidates,
  getCacheKey, getCachedResult, setCachedResult, mergeAndRankResults, buildContext,
  buildJinaReaderUrl, toErrorMessage, classifyNetworkError, providerSearchError,
  DEFAULT_CONTEXT_BUDGET
} from './search-providers/shared.ts';
import type { SearchResult } from './search-providers/shared.ts';
import {
  searchTavily, searchBrave, searchGoogleCse, searchSerpApi, searchSearxng,
  searchBing, searchSerper, searchExa, searchJina, searchYouCom, searchPerplexity, searchDuckDuckGo
} from './search-providers/providers.ts';

let electronSearchWindow: BrowserWindow | null = null;

async function searchElectron(query: string, maxResults: number): Promise<SearchResult[]> {
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

    return results.map((item: { title?: string; url?: string; snippet?: string }, index: number) => ({
      title: item.title || `Result ${index + 1}`,
      url: item.url || '',
      snippet: item.snippet || '',
      full_content: item.snippet || '',
      provider: 'electron',
      providers: ['electron'],
      source_rank: index + 1,
      published_at: null,
      metadata: { source: 'electron_browser' }
    }));
  } catch (err: unknown) {
    if (electronSearchWindow && !electronSearchWindow.isDestroyed()) {
      electronSearchWindow.close();
      electronSearchWindow = null;
    }
    throw err;
  }
}

async function runProviderSearch(provider: string, query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  switch (provider) {
    case 'tavily': return searchTavily(query, maxResults, options);
    case 'brave': return searchBrave(query, maxResults, options);
    case 'google_cse': return searchGoogleCse(query, maxResults, options);
    case 'serpapi': return searchSerpApi(query, maxResults, options);
    case 'searxng': return searchSearxng(query, maxResults, options);
    case 'electron': return searchElectron(query, maxResults);
    case 'bing': return searchBing(query, maxResults, options);
    case 'serper': return searchSerper(query, maxResults, options);
    case 'exa': return searchExa(query, maxResults, options);
    case 'jina': return searchJina(query, maxResults, options);
    case 'youcom': return searchYouCom(query, maxResults, options);
    case 'perplexity': return searchPerplexity(query, maxResults, options);
    case 'duckduckgo': return searchDuckDuckGo(query, maxResults);
    default: throw new Error(`Unsupported search provider: ${provider}`);
  }
}

async function fetchPageContent(url: string, options: Record<string, unknown> = {}): Promise<string | null> {
  try {
    const readerUrl = buildJinaReaderUrl(url, 'https://r.jina.ai');
    if (!readerUrl) return null;
    const headers: Record<string, string> = { Accept: 'text/plain', 'X-Return-Format': 'markdown', 'User-Agent': 'Chatea LM/1.0' };
    if (options.jina_api_key) {
      headers.Authorization = `Bearer ${options.jina_api_key as string}`;
    }
    const resp = await fetchWithRetry(readerUrl, { headers, timeout_ms: 22000 });
    if (!resp.ok) return null;
    const text = await resp.text();
    return text.slice(0, 10000);
  } catch {
    return null;
  }
}

async function enrichWithDeepContent(results: SearchResult[], limit: number, emit: (step: string, detail: string) => void, options: Record<string, unknown> = {}): Promise<SearchResult[]> {
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

export async function webSearch({ query, context, deep, mode, options }: { query: string; context?: string; deep?: boolean; mode?: string; options?: Record<string, unknown> }, win: BrowserWindow | null = null) {
  const normalizedQuery = normalizeWhitespace(query);
  const conversationContext = compactSearchContext(context || options?.conversation_context || '');
  const effectiveQuery = buildEffectiveSearchQuery(normalizedQuery, conversationContext);
  const searchMode = mode === 'max' ? 'max' : deep ? 'deep' : 'search';
  const explicitProvider = normalizeProviderName(options?.provider || 'auto');
  const maxResults = Math.max(1, Math.min(Number(options?.max_results) || 6, 20));
  const contextBudget = Math.max(500, Number(options?.context_budget_chars) || DEFAULT_CONTEXT_BUDGET[searchMode as keyof typeof DEFAULT_CONTEXT_BUDGET] || DEFAULT_CONTEXT_BUDGET.search);
  const searchOptions = { ...(options || {}), conversation_context: conversationContext };

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

  const cacheKey = getCacheKey(effectiveQuery, searchMode, explicitProvider);
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
    if (!providerHasCredentials(explicitProvider, searchOptions) && explicitProvider !== 'duckduckgo' && explicitProvider !== 'jina' && explicitProvider !== 'electron') {
      const credHint = explicitProvider === 'google_cse'
        ? 'Google CSE requires an API key and Search Engine ID — configure them in Settings > Search'
        : `Missing credentials for ${providerDisplayName(explicitProvider)} — add an API key in Settings > Search`;
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
    const deepLimit = Math.min(mergedResults.length, searchMode === 'max' ? 6 : 3);
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

export async function searchHfModels(query: string, sort = 'trending', limit = 20) {
  try {
    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=${encodeURIComponent(sort)}&limit=${limit}`;
    const resp = await fetchWithRetry(url, { timeout_ms: 15000 });
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

export async function hfRepoGguf(repoId: string) {
  try {
    const url = `https://huggingface.co/api/models/${repoId}`;
    const resp = await fetchWithRetry(url, { timeout_ms: 15000 });
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, unknown>;
    const siblings = Array.isArray(data?.siblings) ? data.siblings as Array<{ rfilename?: string; size?: number }> : [];
    const ggufFiles = siblings
      .filter((item) => item?.rfilename?.endsWith('.gguf'))
      .map((item) => ({ name: item.rfilename!, size: item.size || 0 }));
    return { repo_id: repoId, model_id: data.modelId as string | undefined, files: ggufFiles };
  } catch {
    return null;
  }
}
