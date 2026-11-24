// Desktop-only HTTP search providers (Tavily, Brave, Exa, DuckDuckGo live in Rust `agente-core` via `web.search`).
import { APP_USER_AGENT } from '../../shared/brand.ts';
import {
  fetchWithRetry, normalizeSearchItem, parseSearchResultsFromText,
  cleanText, compactSearchContext,
  requireOption, pickFirstArray, mapSearchResults
} from './shared.ts';
import type { SearchResult } from './shared.ts';

export async function searchSearxng(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const baseUrl = requireOption(options, 'searxng_base_url', 'No SearXNG base URL');
  // Relative to the configured base, so a path prefix (`/searx/`) is kept.
  const url = new URL('search', baseUrl.replace(/\/+$/, '') + '/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en');
  url.searchParams.set('safesearch', '1');
  url.searchParams.set('categories', 'general');
  const resp = await fetchWithRetry(url.toString(), { timeout_ms: Number(options?.timeout_ms) || 15000, signal: options?.signal });
  const data = await resp.json() as Record<string, unknown>;
  return mapSearchResults('searxng', pickFirstArray(data, ['results']), (item) => ({
    title: item?.title,
    url: item?.url,
    snippet: item?.content || item?.snippet || item?.description || '',
    full_content: item?.content || item?.snippet || item?.description || '',
    published_at: item?.publishedDate || item?.pubdate,
    metadata: item
  }), maxResults);
}

export async function searchJina(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const baseUrl = String(options?.jina_base_url || 'https://s.jina.ai').replace(/\/+$/, '');
  const url = `${baseUrl}/${encodeURIComponent(query)}`;
  const headers: Record<string, string> = { Accept: 'text/plain', 'User-Agent': APP_USER_AGENT };
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
  const apiKey = requireOption(options, 'youcom_api_key', 'No You.com API key');
  const url = new URL('https://api.ydc-index.io/search');
  url.searchParams.set('q', query);
  url.searchParams.set('query', query);
  url.searchParams.set('num_web_results', String(maxResults));
  url.searchParams.set('max_num_results', String(maxResults));
  const resp = await fetchWithRetry(url.toString(), {
    headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
    timeout_ms: 20000
  });
  const data = await resp.json() as Record<string, unknown>;
  const items = pickFirstArray(data, ['hits', 'results', 'web_results']);
  return mapSearchResults('youcom', items, (item) => ({
    title: item?.title || item?.name,
    url: item?.url || item?.link,
    snippet: item?.snippet || item?.description || item?.summary || '',
    full_content: item?.snippet || item?.description || item?.summary || '',
    published_at: item?.published_at || item?.publishedDate,
    metadata: item
  }), maxResults);
}

export async function searchPerplexity(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const apiKey = requireOption(options, 'perplexity_api_key', 'No Perplexity API key');
  const baseUrl = String(options?.perplexity_api_url || 'https://api.perplexity.ai').replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const model = (options?.perplexity_model as string) || 'sonar';
  const conversationContext = compactSearchContext(options?.conversation_context, 1400);
  const resp = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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

  // Structured citations are the real sources: prefer them to anything read
  // out of the answer text, whose last resort is the Perplexity homepage.
  const inline = parseSearchResultsFromText('perplexity', text, maxResults)
    .filter((result) => /^https?:\/\//i.test(result.url));
  const cited = citationResults(citations, inline, text, maxResults);
  if (cited.length) return cited;
  if (inline.length) return inline;

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

/** One result per distinct citation URL, titled from the citation or a matching inline link. */
function citationResults(citations: unknown[], inline: SearchResult[], text: string, maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const citation of citations) {
    if (results.length >= maxResults) break;
    const record = (citation && typeof citation === 'object' ? citation : {}) as Record<string, unknown>;
    const url = String(typeof citation === 'string' ? citation : record.url || record.link || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const linked = inline.find((result) => result.url === url);
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep the URL */ }
    results.push(normalizeSearchItem('perplexity', {
      title: String(record.title || linked?.title || host),
      url,
      snippet: linked?.snippet || text.slice(0, 1200),
      full_content: text.slice(0, 4000),
      metadata: typeof citation === 'string' ? { citation_index: results.length + 1 } : record
    }, results.length));
  }
  return results;
}
