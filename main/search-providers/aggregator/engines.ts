import { fetchWithRetry, mapSearchResults } from '../shared.ts';
import type { SearchResult } from '../shared.ts';
import { searchDuckDuckGo, searchSearxng } from '../providers.ts';
import { AGGREGATOR_USER_AGENT } from './constants.ts';
import type { AggregatorEngineId } from './constants.ts';
import { fetchAggregatorHtml, fetchAggregatorJson } from './http.ts';
import { parseHtmlResults } from './html-parser.ts';
import { safeSearchLevel } from './options.ts';

async function searchWikipedia(query: string, maxResults: number): Promise<SearchResult[]> {
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

  const resp = await fetchWithRetry(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': AGGREGATOR_USER_AGENT },
    timeout_ms: 12000,
  });
  const data = await resp.json() as Record<string, unknown>;
  const pages = Object.values((data?.query as Record<string, unknown> | undefined)?.pages || {}) as Record<string, unknown>[];

  return mapSearchResults('wikipedia', pages, (item) => ({
    title: item?.title,
    url: item?.fullurl || (item?.pageid ? `https://en.wikipedia.org/?curid=${item.pageid}` : ''),
    snippet: item?.extract || '',
    full_content: item?.extract || '',
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
  url.searchParams.set('displayed', 'true');

  const json = await fetchAggregatorJson(url.toString());
  const mainline = (((json?.data as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined)?.items as Record<string, unknown> | undefined)?.mainline;
  const items: Record<string, unknown>[] = [];
  for (const group of Array.isArray(mainline) ? mainline as Record<string, unknown>[] : []) {
    if (group?.type !== 'web') continue;
    const webItems = Array.isArray(group?.items) ? group.items as Record<string, unknown>[] : [];
    items.push(...webItems);
  }

  return mapSearchResults('qwant', items, (item) => ({
    title: item?.title,
    url: item?.url,
    snippet: item?.desc,
    full_content: item?.desc,
    metadata: item,
  }), maxResults);
}

async function searchSepiaSearch(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const nsfw = safeSearchLevel(options) === 0 ? 'both' : 'false';
  const url = `https://sepiasearch.org/api/v1/search/videos?search=${encodeURIComponent(query)}&start=0&count=${Math.min(maxResults, 10)}&sort=-match&nsfw=${nsfw}`;
  const json = await fetchAggregatorJson(url);
  const items = Array.isArray(json?.data) ? json.data as Record<string, unknown>[] : [];
  return mapSearchResults('sepiasearch', items, (item) => ({
    title: item?.name,
    url: item?.url,
    snippet: item?.description,
    full_content: item?.description,
    metadata: item,
  }), maxResults);
}

function parseYahooRedirectUrl(rawUrl: string): string {
  const ruIdx = rawUrl.indexOf('/RU=');
  if (ruIdx === -1) return rawUrl;
  const encoded = rawUrl.substring(ruIdx + 4);
  let endIdx = encoded.length;
  for (const marker of ['/RS', '/RK']) {
    const markerIdx = encoded.indexOf(marker);
    if (markerIdx !== -1 && markerIdx < endIdx) endIdx = markerIdx;
  }
  try {
    return decodeURIComponent(encoded.substring(0, endIdx));
  } catch {
    return rawUrl;
  }
}

async function searchHtmlEngine(engine: AggregatorEngineId, query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const safe = safeSearchLevel(options);
  switch (engine) {
    case 'bing': {
      const html = await fetchAggregatorHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { Referer: 'https://www.bing.com/' });
      return parseHtmlResults({ html, baseUrl: 'https://www.bing.com', engine, resultSelector: '.b_algo', titleSelector: 'h2 a', urlSelector: 'h2 a', snippetSelector: '.b_caption p', maxResults });
    }
    case 'brave': {
      const level = safe === 0 ? 'off' : safe === 1 ? 'moderate' : 'strict';
      const html = await fetchAggregatorHtml(`https://search.brave.com/search?q=${encodeURIComponent(query)}&offset=0`, { Referer: 'https://search.brave.com/', Cookie: `safe_search=${level}` });
      return parseHtmlResults({ html, baseUrl: 'https://search.brave.com', engine, resultSelector: '#results [data-pos]', titleSelector: 'a > .url', urlSelector: 'a', snippetSelector: '.snippet-description', maxResults });
    }
    case 'startpage': {
      const html = await fetchAggregatorHtml(`https://startpage.com/do/dsearch?q=${encodeURIComponent(query)}&num=10&start=0`, { Referer: 'https://startpage.com/' });
      return parseHtmlResults({ html, baseUrl: 'https://startpage.com', engine, resultSelector: '.w-gl__result__main', titleSelector: '.w-gl__result-second-line-container>.w-gl__result-title>h3', urlSelector: '.w-gl__result-url', snippetSelector: '.w-gl__description', maxResults });
    }
    case 'mojeek': {
      const safeParam = safe !== 0 ? 1 : 0;
      const url = `https://www.mojeek.com/search?q=${encodeURIComponent(query)}&t=10&theme=dark&arc=none&date=1&cdate=1&tlen=100&ref=1&hp=minimal&lb=en&safe=${safeParam}`;
      const html = await fetchAggregatorHtml(url, { Referer: 'https://www.mojeek.com/' });
      return parseHtmlResults({ html, baseUrl: 'https://www.mojeek.com', engine, resultSelector: '.results-standard li', titleSelector: 'h2 > a.title', urlSelector: 'a.ob', snippetSelector: 'p.s', maxResults });
    }
    case 'yahoo': {
      const html = await fetchAggregatorHtml(`https://search.yahoo.com/search/?p=${encodeURIComponent(query)}`, { Referer: 'https://search.yahoo.com/' });
      return parseHtmlResults({ html, baseUrl: 'https://search.yahoo.com', engine, resultSelector: 'div.algo', titleSelector: 'h3.title a', urlSelector: 'h3 a', snippetSelector: '.compText', maxResults, urlTransform: parseYahooRedirectUrl });
    }
    case 'librex': {
      const html = await fetchAggregatorHtml(`https://search.davidovski.xyz/search.php?q=${encodeURIComponent(query)}&p=0&t=10`, { Referer: 'https://search.davidovski.xyz/' });
      return parseHtmlResults({ html, baseUrl: 'https://search.davidovski.xyz', engine, resultSelector: '.text-result-wrapper', titleSelector: 'a>h2', urlSelector: 'a', snippetSelector: 'span', maxResults });
    }
    default:
      return [];
  }
}

export async function runAggregatorEngine(engine: AggregatorEngineId, query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  switch (engine) {
    case 'duckduckgo':
      return searchDuckDuckGo(query, maxResults);
    case 'wikipedia':
      return searchWikipedia(query, maxResults);
    case 'qwant':
      return searchQwant(query, maxResults, options);
    case 'sepiasearch':
      return searchSepiaSearch(query, maxResults, options);
    case 'searxng':
      return searchSearxng(query, maxResults, options);
    case 'bing':
    case 'brave':
    case 'startpage':
    case 'mojeek':
    case 'yahoo':
    case 'librex':
      return searchHtmlEngine(engine, query, maxResults, options);
    default:
      return [];
  }
}
