import {
  coerceSearchText,
  fetchWithRetry,
  mapSearchResults,
  normalizeSearchItem,
  normalizeWhitespace,
} from '../shared.ts';
import type { SearchResult } from '../shared.ts';
import { searchSearxng } from '../providers.ts';
import { AGGREGATOR_USER_AGENT } from './constants.ts';
import type { AggregatorEngineId } from './constants.ts';
import { fetchAggregatorJson } from './http.ts';
import { getEngineDefinition, getEngineOption, safeSearchLevel } from './options.ts';

function requestOptions(engine: AggregatorEngineId, options: Record<string, unknown>): Record<string, unknown> {
  return {
    signal: options.aggregator_signal,
    timeout_ms: getEngineDefinition(engine)?.timeout_ms || 8000,
    retries: 1,
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

async function searchSepiaSearch(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const nsfw = safeSearchLevel(options) === 0 ? 'both' : 'false';
  const url = `https://sepiasearch.org/api/v1/search/videos?search=${encodeURIComponent(query)}&start=0&count=${Math.min(maxResults, 10)}&sort=-match&nsfw=${nsfw}`;
  const json = await fetchAggregatorJson(url, requestOptions('sepiasearch', options));
  const items = Array.isArray(json?.data) ? json.data as Record<string, unknown>[] : [];
  return mapSearchResults('sepiasearch', items, (item) => ({
    title: item?.name, url: item?.url, snippet: item?.description, metadata: item,
  }), maxResults);
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
    // Crossref spells these DOI / URL; OpenAlex doi / id; the rest link / url.
    const urlValue = item?.doi || item?.DOI || item?.URL || item?.id || item?.link || item?.url || item?.story_url;
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

async function searchSemanticScholar(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(Math.min(maxResults, 20)));
  url.searchParams.set('fields', 'title,url,abstract,year,venue,authors,externalIds,publicationDate');
  const apiKey = configuredApiKey('semantic_scholar', options);
  const data = apiKey
    ? await (async () => {
      const resp = await fetchWithRetry(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': AGGREGATOR_USER_AGENT, 'x-api-key': apiKey }, ...requestOptions('semantic_scholar', options) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json() as Record<string, unknown>;
    })()
    : await fetchAggregatorJson(url.toString(), requestOptions('semantic_scholar', options));
  const items = Array.isArray(data?.data) ? data.data as Record<string, unknown>[] : [];
  return mapSearchResults('semantic_scholar', items, (item) => {
    const doi = (item?.externalIds as Record<string, unknown> | undefined)?.DOI;
    const authors = Array.isArray(item?.authors) ? (item.authors as Array<{ name?: string }>).map((a) => a?.name).filter(Boolean).slice(0, 4).join(', ') : '';
    return {
      title: item?.title,
      url: typeof doi === 'string' && doi ? `https://doi.org/${doi}` : item?.url,
      snippet: item?.abstract || [item?.venue, item?.year, authors].filter(Boolean).join(' · '),
      published_at: item?.publicationDate || (item?.year ? String(item.year) : null),
      metadata: { venue: item?.venue, year: item?.year, authors, source: 'Semantic Scholar' },
    };
  }, maxResults);
}

/** PubMed via NCBI E-utilities: search for ids, then fetch their summaries. */
async function searchPubMed(query: string, maxResults: number, options: Record<string, unknown>): Promise<SearchResult[]> {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const tool = 'tool=AgenteDesktop';
  const search = await fetchAggregatorJson(`${base}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${Math.min(maxResults, 20)}&term=${encodeURIComponent(query)}&${tool}`, requestOptions('pubmed', options));
  const ids = ((search?.esearchresult as Record<string, unknown> | undefined)?.idlist as string[] | undefined) ?? [];
  if (!ids.length) return [];
  const summary = await fetchAggregatorJson(`${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}&${tool}`, requestOptions('pubmed', options));
  const result = (summary?.result ?? {}) as Record<string, Record<string, unknown>>;
  const items = ids.map((id) => result[id]).filter(Boolean);
  return mapSearchResults('pubmed', items, (item) => {
    const authors = Array.isArray(item?.authors) ? (item.authors as Array<{ name?: string }>).map((a) => a?.name).filter(Boolean).slice(0, 4).join(', ') : '';
    return {
      title: item?.title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${item?.uid}/`,
      snippet: [item?.fulljournalname || item?.source, item?.pubdate, authors].filter(Boolean).join(' · '),
      published_at: item?.sortpubdate || item?.pubdate,
      metadata: { journal: item?.fulljournalname || item?.source, authors, source: 'PubMed' },
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
  if (engine === 'wikipedia') return searchWikipedia(query, maxResults, options);
  if (engine === 'wiby') return searchWiby(query, maxResults, options);
  if (engine === 'sepiasearch') return searchSepiaSearch(query, maxResults, options);
  if (engine === 'searxng') return searchSearxng(query, maxResults, { ...options, signal: options.aggregator_signal });
  if (engine === 'arxiv') return searchArxiv(query, maxResults, options);
  if (engine === 'semantic_scholar') return searchSemanticScholar(query, maxResults, options);
  if (engine === 'pubmed') return searchPubMed(query, maxResults, options);
  if (['openalex', 'crossref', 'stackexchange', 'hackernews'].includes(engine)) return searchResearchJson(engine, query, maxResults, options);
  if (['yacy', 'fourget'].includes(engine)) return searchSelfHosted(engine, query, maxResults, options);
  if (['kagi', 'firecrawl', 'linkup', 'ollama_web', 'perplexity_search'].includes(engine)) return searchApiEngine(engine, query, maxResults, options);
  return [];
}
