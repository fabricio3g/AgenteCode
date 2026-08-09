import {
  coerceSearchText,
  fetchWithRetry,
  mapSearchResults,
  normalizeSearchItem,
  normalizeWhitespace,
} from '../shared.ts';
import type { SearchResult } from '../shared.ts';
import { searchDuckDuckGo, searchSearxng } from '../providers.ts';
import { AGGREGATOR_USER_AGENT } from './constants.ts';
import type { AggregatorEngineId } from './constants.ts';
import { fetchAggregatorHtml, fetchAggregatorJson } from './http.ts';
import { parseHtmlResults } from './html-parser.ts';
import { getEngineDefinition, getEngineOption, safeSearchLevel } from './options.ts';

function requestOptions(engine: AggregatorEngineId, options: Record<string, unknown>): Record<string, unknown> {
  return {
    signal: options.aggregator_signal,
    timeout_ms: getEngineDefinition(engine)?.timeout_ms || 8000,
    retries: getEngineDefinition(engine)?.transport === 'html' ? 0 : 1,
  };
}

function configuredBaseUrl(engine: AggregatorEngineId, options: Record<string, unknown>): string {
  const definition = getEngineDefinition(engine);
  return (getEngineOption(options, engine, 'base_url') || definition?.default_base_url || '').replace(/\/+$/, '');
}

function configuredApiKey(engine: AggregatorEngineId, options: Record<string, unknown>): string {
  return getEngineOption(options, engine, 'api_key');
}

async function searchWikipedia(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', query);
  url.searchParams.set('gsrlimit', String(maxResults));
  url.searchParams.set('prop', 'extracts|info');
  url.searchParams.set('exintro', '1');
  url.searchParams.set('explaintext', '1');
  url.searchParams.set('inprop', 'url');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  const data = await fetchAggregatorJson(url.toString(), requestOptions('wikipedia', options));
  const pages = Object.values((data?.query as Record<string, unknown> | undefined)?.pages || {}) as Record<string, unknown>[];
  return mapSearchResults('wikipedia', pages, (item) => ({
    title: item?.title,
    url: item?.fullurl || (item?.pageid ? `https://en.wikipedia.org/?curid=${item.pageid}` : ''),
    snippet: item?.extract || '',
    full_content: item?.extract || '',
    metadata: item,
  }), maxResults);
}

async function searchWiby(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const url = `https://wiby.me/json/?q=${encodeURIComponent(query)}`;
  const data = await fetchAggregatorJson(url, requestOptions('wiby', options));
  const items = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : [];
  return mapSearchResults('wiby', items as Record<string, unknown>[], (item) => ({
    title: item?.Title || item?.title,
    url: item?.URL || item?.url,
    snippet: item?.Snippet || item?.snippet || item?.description,
    metadata: item,
  }), maxResults);
}

async function searchQwant(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const url = new URL('https://api.qwant.com/v3/search/web');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(maxResults, 10)));
  url.searchParams.set('locale', 'en_US');
  url.searchParams.set('offset', '0');
  url.searchParams.set('safesearch', String(safeSearchLevel(options)));
  url.searchParams.set('device', 'desktop');
  url.searchParams.set('tgb', '2');
  const json = await fetchAggregatorJson(url.toString(), requestOptions('qwant', options));
  const mainline = (((json?.data as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined)?.items as Record<string, unknown> | undefined)?.mainline;
  const items: Record<string, unknown>[] = [];
  for (const group of Array.isArray(mainline) ? mainline as Record<string, unknown>[] : []) {
    if (group?.type !== 'web') continue;
    if (Array.isArray(group?.items)) items.push(...group.items as Record<string, unknown>[]);
  }
  return mapSearchResults('qwant', items, (item) => ({
    title: item?.title, url: item?.url, snippet: item?.desc, metadata: item,
  }), maxResults);
}

async function searchSepiaSearch(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const nsfw = safeSearchLevel(options) === 0 ? 'both' : 'false';
  const url = `https://sepiasearch.org/api/v1/search/videos?search=${encodeURIComponent(query)}&start=0&count=${Math.min(maxResults, 10)}&sort=-match&nsfw=${nsfw}`;
  const json = await fetchAggregatorJson(url, requestOptions('sepiasearch', options));
  const items = Array.isArray(json?.data) ? json.data as Record<string, unknown>[] : [];
  return mapSearchResults('sepiasearch', items, (item) => ({
    title: item?.name, url: item?.url, snippet: item?.description, metadata: item,
  }), maxResults);
}

function parseYahooRedirectUrl(rawUrl: string): string {
  const match = rawUrl.match(/\/RU=([^/]+)(?:\/R[SK]=|$)/);
  if (!match) return rawUrl;
  try { return decodeURIComponent(match[1]); } catch { return rawUrl; }
}

type HtmlEngineConfig = {
  url: string;
  baseUrl: string;
  resultSelector: string;
  titleSelector: string;
  urlSelector: string;
  snippetSelector: string;
  headers?: Record<string, string>;
  urlTransform?: (value: string) => string;
};

function htmlEngineConfig(engine: AggregatorEngineId, query: string, options: Record<string, unknown>): HtmlEngineConfig | null {
  const q = encodeURIComponent(query);
  const safe = safeSearchLevel(options);
  switch (engine) {
    case 'bing': return { url: `https://www.bing.com/search?q=${q}`, baseUrl: 'https://www.bing.com', resultSelector: '.b_algo', titleSelector: 'h2 a', urlSelector: 'h2 a', snippetSelector: '.b_caption p' };
    case 'brave': return { url: `https://search.brave.com/search?q=${q}&offset=0`, baseUrl: 'https://search.brave.com', resultSelector: '#results [data-pos]', titleSelector: 'a > .url, .title', urlSelector: 'a', snippetSelector: '.snippet-description', headers: { Cookie: `safe_search=${safe === 0 ? 'off' : safe === 1 ? 'moderate' : 'strict'}` } };
    case 'startpage': return { url: `https://www.startpage.com/do/dsearch?q=${q}&num=10&start=0`, baseUrl: 'https://www.startpage.com', resultSelector: '.w-gl__result__main', titleSelector: 'h3', urlSelector: 'a', snippetSelector: '.w-gl__description' };
    case 'mojeek': return { url: `https://www.mojeek.com/search?q=${q}&safe=${safe === 0 ? 0 : 1}`, baseUrl: 'https://www.mojeek.com', resultSelector: '.results-standard li', titleSelector: 'h2 > a.title', urlSelector: 'a.ob, h2 a', snippetSelector: 'p.s' };
    case 'yahoo': return { url: `https://search.yahoo.com/search/?p=${q}`, baseUrl: 'https://search.yahoo.com', resultSelector: 'div.algo', titleSelector: 'h3.title a', urlSelector: 'h3 a', snippetSelector: '.compText', urlTransform: parseYahooRedirectUrl };
    case 'librex': return { url: `https://search.davidovski.xyz/search.php?q=${q}&p=0&t=10`, baseUrl: 'https://search.davidovski.xyz', resultSelector: '.text-result-wrapper', titleSelector: 'a>h2', urlSelector: 'a', snippetSelector: 'span' };
    case 'yep': return { url: `https://yep.com/web?q=${q}`, baseUrl: 'https://yep.com', resultSelector: '.result, [data-testid="result"]', titleSelector: 'h2, .result__title', urlSelector: 'a', snippetSelector: '.result__snippet, p' };
    case 'mwmbl': return { url: `https://mwmbl.org/?q=${q}`, baseUrl: 'https://mwmbl.org', resultSelector: '.result, article', titleSelector: 'h2, h3', urlSelector: 'a', snippetSelector: 'p, .snippet' };
    case 'marginalia': return { url: `https://search.marginalia.nu/search?query=${q}`, baseUrl: 'https://search.marginalia.nu', resultSelector: '.search-result, article', titleSelector: 'h2, h3', urlSelector: 'a', snippetSelector: '.description, p' };
    case 'yandex': return { url: `https://yandex.com/search/?text=${q}`, baseUrl: 'https://yandex.com', resultSelector: '.serp-item', titleSelector: 'h2 a, .OrganicTitle-Link', urlSelector: 'h2 a, .OrganicTitle-Link', snippetSelector: '.OrganicTextContentSpan, .text-container' };
    case 'baidu': return { url: `https://www.baidu.com/s?wd=${q}`, baseUrl: 'https://www.baidu.com', resultSelector: '.result, .c-container', titleSelector: 'h3 a', urlSelector: 'h3 a', snippetSelector: '.c-abstract, .content-right_8Zs40' };
    case 'google': return { url: `https://www.google.com/search?q=${q}&safe=${safe === 0 ? 'off' : 'active'}&num=10`, baseUrl: 'https://www.google.com', resultSelector: '#search .g', titleSelector: 'h3', urlSelector: 'a', snippetSelector: '.VwiC3b, [data-sncf]' };
    case 'ghostery': return { url: `https://search.ghostery.com/search?q=${q}`, baseUrl: 'https://search.ghostery.com', resultSelector: '.result, article', titleSelector: 'h2, h3', urlSelector: 'a', snippetSelector: '.snippet, p' };
    default: return null;
  }
}

async function searchHtmlEngine(engine: AggregatorEngineId, query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const config = htmlEngineConfig(engine, query, options);
  if (!config) return [];
  const html = await fetchAggregatorHtml(config.url, { Referer: `${config.baseUrl}/`, ...(config.headers || {}) }, requestOptions(engine, options));
  return parseHtmlResults({ html, baseUrl: config.baseUrl, engine, resultSelector: config.resultSelector, titleSelector: config.titleSelector, urlSelector: config.urlSelector, snippetSelector: config.snippetSelector, maxResults, urlTransform: config.urlTransform });
}

async function searchResearchJson(engine: AggregatorEngineId, query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  let url = '';
  if (engine === 'openalex') url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${maxResults}`;
  if (engine === 'crossref') url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${maxResults}`;
  if (engine === 'stackexchange') url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&q=${encodeURIComponent(query)}&pagesize=${maxResults}`;
  if (engine === 'hackernews') url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${maxResults}`;
  const data = await fetchAggregatorJson(url, requestOptions(engine, options));
  let items: Record<string, unknown>[] = [];
  if (engine === 'openalex') items = Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : [];
  if (engine === 'crossref') items = Array.isArray((data?.message as Record<string, unknown> | undefined)?.items) ? (data.message as Record<string, unknown>).items as Record<string, unknown>[] : [];
  if (engine === 'stackexchange') items = Array.isArray(data?.items) ? data.items as Record<string, unknown>[] : [];
  if (engine === 'hackernews') items = Array.isArray(data?.hits) ? data.hits as Record<string, unknown>[] : [];
  return mapSearchResults(engine, items, (item) => {
    const title = Array.isArray(item?.title) ? item.title[0] : item?.title || item?.display_name || item?.story_title;
    const urlValue = item?.doi || item?.id || item?.link || item?.url || item?.story_url;
    const snippet = coerceSearchText(
      item?.abstract
      || item?.abstract_inverted_index
      || item?.content
      || item?.description
      || item?.story_text
    );
    return {
      title,
      url: typeof urlValue === 'string' && urlValue.startsWith('10.') ? `https://doi.org/${urlValue}` : urlValue,
      snippet,
      published_at: item?.publication_date || item?.published || item?.creation_date || item?.created_at,
      metadata: item,
    };
  }, maxResults);
}

async function searchArxiv(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}`;
  const resp = await fetchWithRetry(url, { headers: { 'User-Agent': AGGREGATOR_USER_AGENT }, ...requestOptions('arxiv', options) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();
  const entries = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)).map((match) => match[1]);
  const value = (entry: string, tag: string) => normalizeWhitespace(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.replace(/<[^>]+>/g, '') || '');
  return entries.slice(0, maxResults).map((entry, index) => normalizeSearchItem('arxiv', {
    title: value(entry, 'title'),
    url: value(entry, 'id'),
    snippet: value(entry, 'summary'),
    published_at: value(entry, 'published'),
    metadata: { authors: Array.from(entry.matchAll(/<name>([\s\S]*?)<\/name>/g)).map((m) => normalizeWhitespace(m[1])) },
  }, index));
}

async function searchSelfHosted(engine: AggregatorEngineId, query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const baseUrl = configuredBaseUrl(engine, options);
  let url = '';
  if (engine === 'yacy') url = `${baseUrl}/yacysearch.json?query=${encodeURIComponent(query)}&resource=global&maximumRecords=${maxResults}`;
  if (engine === 'fourget') url = `${baseUrl}/api/v1/web?s=${encodeURIComponent(query)}`;
  if (engine === 'openserp') url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&limit=${maxResults}`;
  const data = await fetchAggregatorJson(url, requestOptions(engine, options));
  const channel = (data?.channels as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  const items = [
    data?.results, data?.organic_results, data?.web, data?.items,
    channel?.items,
  ].find(Array.isArray) as Record<string, unknown>[] | undefined || [];
  return mapSearchResults(engine, items, (item) => ({
    title: item?.title || item?.name,
    url: item?.url || item?.link,
    snippet: item?.description || item?.snippet || item?.content,
    published_at: item?.date || item?.published_at,
    metadata: item,
  }), maxResults);
}

async function searchApiEngine(engine: AggregatorEngineId, query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const apiKey = configuredApiKey(engine, options);
  const baseUrl = configuredBaseUrl(engine, options);
  let endpoint = '';
  let method = 'GET';
  let headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (engine === 'kagi') {
    endpoint = `${baseUrl}/search?q=${encodeURIComponent(query)}&limit=${maxResults}`;
    headers.Authorization = `Bot ${apiKey}`;
  } else if (engine === 'firecrawl') {
    endpoint = `${baseUrl}/search`; method = 'POST'; headers.Authorization = `Bearer ${apiKey}`;
    body = JSON.stringify({ query, limit: maxResults, sources: ['web'], timeout: 10000 });
  } else if (engine === 'searchapi') {
    endpoint = `${baseUrl}/search?engine=google&q=${encodeURIComponent(query)}&num=${maxResults}`;
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (engine === 'linkup') {
    endpoint = `${baseUrl}/search`; method = 'POST'; headers.Authorization = `Bearer ${apiKey}`;
    body = JSON.stringify({ q: query, depth: 'standard', outputType: 'searchResults' });
  } else if (engine === 'ollama_web') {
    endpoint = `${baseUrl}/web_search`; method = 'POST'; headers.Authorization = `Bearer ${apiKey}`;
    body = JSON.stringify({ query, max_results: maxResults });
  } else if (engine === 'perplexity_search') {
    endpoint = `${baseUrl}/search`; method = 'POST'; headers.Authorization = `Bearer ${apiKey}`;
    body = JSON.stringify({ query, max_results: maxResults });
  }
  if (body) headers['Content-Type'] = 'application/json';
  const resp = await fetchWithRetry(endpoint, { method, headers, body, ...requestOptions(engine, options) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json() as Record<string, unknown>;
  const nestedData = data?.data as Record<string, unknown> | undefined;
  const items = [
    data?.results, data?.organic_results, data?.items, data?.sources,
    nestedData?.web, nestedData?.results,
  ].find(Array.isArray) as Record<string, unknown>[] | undefined || [];
  return mapSearchResults(engine, items, (item) => ({
    title: item?.title || item?.name,
    url: item?.url || item?.link,
    snippet: item?.snippet || item?.description || item?.content || item?.markdown,
    full_content: item?.markdown || item?.content || item?.snippet || item?.description,
    published_at: item?.date || item?.published_at,
    metadata: item,
  }), maxResults);
}

export async function runAggregatorEngine(engine: AggregatorEngineId, query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  if (engine === 'duckduckgo') return searchDuckDuckGo(query, maxResults, { signal: options.aggregator_signal, timeout_ms: getEngineDefinition(engine)?.timeout_ms });
  if (engine === 'wikipedia') return searchWikipedia(query, maxResults, options);
  if (engine === 'wiby') return searchWiby(query, maxResults, options);
  if (engine === 'qwant') return searchQwant(query, maxResults, options);
  if (engine === 'sepiasearch') return searchSepiaSearch(query, maxResults, options);
  if (engine === 'searxng') return searchSearxng(query, maxResults, { ...options, signal: options.aggregator_signal });
  if (engine === 'arxiv') return searchArxiv(query, maxResults, options);
  if (['openalex', 'crossref', 'stackexchange', 'hackernews'].includes(engine)) return searchResearchJson(engine, query, maxResults, options);
  if (['yacy', 'fourget', 'openserp'].includes(engine)) return searchSelfHosted(engine, query, maxResults, options);
  if (['kagi', 'firecrawl', 'searchapi', 'linkup', 'ollama_web', 'perplexity_search'].includes(engine)) return searchApiEngine(engine, query, maxResults, options);
  return searchHtmlEngine(engine, query, maxResults, options);
}
