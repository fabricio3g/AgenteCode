// HTTP-based search provider implementations
import {
  fetchWithRetry, normalizeSearchItem, parseSearchResultsFromText,
  normalizeWhitespace, cleanText, compactSearchContext
} from './shared.ts';
import type { SearchResult } from './shared.ts';

export async function searchTavily(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
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
  const data = await resp.json() as Record<string, unknown>;
  const items = Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : [];
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

export async function searchBrave(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (!options?.brave_api_key) throw new Error('No Brave API key');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const resp = await fetchWithRetry(url, {
    headers: { 'X-Subscription-Token': options.brave_api_key as string, Accept: 'application/json' },
    timeout_ms: 15000
  });
  const data = await resp.json() as Record<string, unknown>;
  const webResults = (data?.web as Record<string, unknown> | undefined)?.results as Record<string, unknown>[] | undefined;
  const items = Array.isArray(webResults) ? webResults : Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : [];
  return items.map((item, index) => normalizeSearchItem('brave', {
    title: item?.title,
    url: item?.url,
    snippet: item?.description || item?.snippet || '',
    full_content: item?.description || item?.snippet || '',
    published_at: item?.age || item?.published_at,
    metadata: item
  }, index)).slice(0, maxResults);
}

export async function searchGoogleCse(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (!options?.google_cse_api_key || !options?.google_cse_id) {
    throw new Error('Google CSE requires an API key and Search Engine ID — configure them in Settings > Search');
  }
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(options.google_cse_api_key as string)}&cx=${encodeURIComponent(options.google_cse_id as string)}&q=${encodeURIComponent(query)}&num=${maxResults}`;
  const resp = await fetchWithRetry(url, { timeout_ms: 15000 });
  const data = await resp.json() as Record<string, unknown>;
  if (!resp.ok) {
    const apiMsg = (data?.error as Record<string, unknown> | undefined)?.message || (data?.error as Record<string, unknown> | undefined)?.status || `HTTP ${resp.status}`;
    if (resp.status === 403) throw new Error(`Google CSE: access denied — check your API key and that Custom Search API is enabled (${apiMsg})`);
    if (resp.status === 429) throw new Error(`Google CSE: quota exceeded — daily limit reached (${apiMsg})`);
    throw new Error(`Google CSE: ${apiMsg}`);
  }
  const items = Array.isArray(data?.items) ? data.items as Record<string, unknown>[] : [];
  if (!items.length && (data?.searchInformation as Record<string, unknown> | undefined)?.totalResults === '0') {
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

export async function searchSerpApi(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (!options?.serpapi_api_key) throw new Error('No SerpAPI key');
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', options.serpapi_api_key as string);
  url.searchParams.set('num', String(maxResults));
  const resp = await fetchWithRetry(url.toString(), { timeout_ms: 15000 });
  const data = await resp.json() as Record<string, unknown>;
  const items = Array.isArray(data?.organic_results) ? data.organic_results as Record<string, unknown>[] : Array.isArray(data?.organic) ? data.organic as Record<string, unknown>[] : Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : [];
  return items.map((item, index) => normalizeSearchItem('serpapi', {
    title: item?.title,
    url: item?.link || item?.url,
    snippet: item?.snippet || item?.description || '',
    full_content: item?.snippet || item?.description || '',
    published_at: item?.date || item?.publication_date,
    metadata: item
  }, index)).slice(0, maxResults);
}

export async function searchSearxng(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (!options?.searxng_base_url) throw new Error('No SearXNG base URL');
  const url = new URL('/search', (options.searxng_base_url as string).replace(/\/+$/, '') + '/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en');
  url.searchParams.set('safesearch', '1');
  url.searchParams.set('categories', 'general');
  const resp = await fetchWithRetry(url.toString(), { timeout_ms: 15000 });
  const data = await resp.json() as Record<string, unknown>;
  const items = Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : [];
  return items.map((item, index) => normalizeSearchItem('searxng', {
    title: item?.title,
    url: item?.url,
    snippet: item?.content || item?.snippet || item?.description || '',
    full_content: item?.content || item?.snippet || item?.description || '',
    published_at: item?.publishedDate || item?.pubdate,
    metadata: item
  }, index)).slice(0, maxResults);
}

export async function searchBing(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (!options?.bing_api_key) throw new Error('No Bing API key');
  const endpoint = String(options?.bing_endpoint || 'https://api.bing.microsoft.com/v7.0/search').replace(/\/+$/, '');
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  url.searchParams.set('mkt', 'en-US');
  url.searchParams.set('safeSearch', 'Moderate');
  const resp = await fetchWithRetry(url.toString(), {
    headers: { 'Ocp-Apim-Subscription-Key': options.bing_api_key as string, Accept: 'application/json' },
    timeout_ms: 15000
  });
  const data = await resp.json() as Record<string, unknown>;
  const webPages = data?.webPages as Record<string, unknown> | undefined;
  const items = Array.isArray(webPages?.value) ? (webPages.value as Record<string, unknown>[]) : Array.isArray(webPages?.results) ? (webPages.results as Record<string, unknown>[]) : [];
  return items.map((item, index) => normalizeSearchItem('bing', {
    title: item?.name,
    url: item?.url,
    snippet: item?.snippet || item?.description || '',
    full_content: item?.snippet || item?.description || '',
    published_at: item?.dateLastCrawled || item?.datePublished,
    metadata: item
  }, index)).slice(0, maxResults);
}

export async function searchSerper(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (!options?.serper_api_key) throw new Error('No Serper API key');
  const resp = await fetchWithRetry('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': options.serper_api_key as string,
      Accept: 'application/json'
    },
    timeout_ms: 15000,
    body: JSON.stringify({ q: query, num: maxResults })
  });
  const data = await resp.json() as Record<string, unknown>;
  const items = Array.isArray(data?.organic) ? data.organic as Record<string, unknown>[] : Array.isArray(data?.organic_results) ? data.organic_results as Record<string, unknown>[] : Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : [];
  return items.map((item, index) => normalizeSearchItem('serper', {
    title: item?.title || item?.name,
    url: item?.link || item?.url,
    snippet: item?.snippet || item?.description || '',
    full_content: item?.snippet || item?.description || '',
    published_at: item?.date,
    metadata: item
  }, index)).slice(0, maxResults);
}

export async function searchExa(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (!options?.exa_api_key) throw new Error('No Exa API key');
  const resp = await fetchWithRetry('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.exa_api_key as string,
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
  const data = await resp.json() as Record<string, unknown>;
  const items = Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : Array.isArray(data?.searchResults) ? data.searchResults as Record<string, unknown>[] : [];
  return items.map((item, index) => normalizeSearchItem('exa', {
    title: item?.title,
    url: item?.url,
    snippet: item?.text || item?.highlight || (Array.isArray(item?.highlights) ? (item.highlights as string[]).join(' ') : ''),
    full_content: item?.text || item?.highlight || (Array.isArray(item?.highlights) ? (item.highlights as string[]).join(' ') : ''),
    published_at: item?.publishedDate || item?.date,
    metadata: item
  }, index)).slice(0, maxResults);
}

export async function searchJina(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const baseUrl = String(options?.jina_base_url || 'https://s.jina.ai').replace(/\/+$/, '');
  const url = `${baseUrl}/${encodeURIComponent(query)}`;
  const headers: Record<string, string> = { Accept: 'text/plain', 'User-Agent': 'Chatea/1.0' };
  if (options?.jina_api_key) {
    headers.Authorization = `Bearer ${options.jina_api_key as string}`;
  }
  const resp = await fetchWithRetry(url, {
    headers,
    timeout_ms: 20000
  });
  const text = await resp.text();
  return parseSearchResultsFromText('jina', text, maxResults, url);
}

export async function searchYouCom(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (!options?.youcom_api_key) throw new Error('No You.com API key');
  const url = new URL('https://api.ydc-index.io/search');
  url.searchParams.set('q', query);
  url.searchParams.set('query', query);
  url.searchParams.set('num_web_results', String(maxResults));
  url.searchParams.set('max_num_results', String(maxResults));
  const resp = await fetchWithRetry(url.toString(), {
    headers: { 'X-API-Key': options.youcom_api_key as string, Accept: 'application/json' },
    timeout_ms: 20000
  });
  const data = await resp.json() as Record<string, unknown>;
  const items = Array.isArray(data?.hits)
    ? data.hits as Record<string, unknown>[]
    : Array.isArray(data?.results)
      ? data.results as Record<string, unknown>[]
      : Array.isArray(data?.web_results)
        ? data.web_results as Record<string, unknown>[]
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

export async function searchPerplexity(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (!options?.perplexity_api_key) throw new Error('No Perplexity API key');
  const baseUrl = String(options?.perplexity_api_url || 'https://api.perplexity.ai').replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const model = (options?.perplexity_model as string) || 'sonar';
  const conversationContext = compactSearchContext(options?.conversation_context, 1400);
  const resp = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.perplexity_api_key as string}`,
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
  const data = await resp.json() as Record<string, unknown>;
  const message = ((data?.choices as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined)?.message ||
                  ((data?.choices as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined)?.delta || {};
  const text = cleanText(message?.content || data?.output?.text || data?.answer || '');
  const citations = Array.isArray(data?.citations)
    ? data.citations as unknown[]
    : Array.isArray(message?.citations)
      ? message.citations as unknown[]
      : Array.isArray(data?.sources)
        ? data.sources as unknown[]
        : [];

  const parsed = parseSearchResultsFromText('perplexity', text, maxResults, 'https://www.perplexity.ai');
  if (parsed.length) return parsed;

  if (citations.length) {
    return citations.slice(0, maxResults).map((citation, index) => normalizeSearchItem('perplexity', {
      title: text.split(/\r?\n/).find(Boolean) || `Perplexity result ${index + 1}`,
      url: typeof citation === 'string' ? citation : (citation as Record<string, unknown>)?.url || (citation as Record<string, unknown>)?.link || '',
      snippet: text.slice(0, 1200),
      full_content: text.slice(0, 4000),
      metadata: citation as Record<string, unknown>
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

export async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Chatea/1.0)' },
    timeout_ms: 12000
  });
  const html = await resp.text();

  const results: SearchResult[] = [];
  const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([^<]*)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
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
