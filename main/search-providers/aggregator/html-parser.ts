import { parseHTML } from 'linkedom';
import { cleanText, normalizeSearchItem, normalizeWhitespace } from '../shared.ts';
import type { SearchResult } from '../shared.ts';
import type { AggregatorEngineId } from './constants.ts';

function absoluteUrl(rawUrl: string, baseUrl: string): string {
  const value = normalizeWhitespace(rawUrl);
  if (!value || value === 'No Link Found') return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function htmlText(value: Element | null | undefined): string {
  return cleanText(value?.textContent || '').replace(/<[^>]+>/g, '');
}

function htmlAttr(value: Element | null | undefined, attr: string): string {
  return normalizeWhitespace(value?.getAttribute(attr) || '');
}

export function parseHtmlResults({
  html,
  baseUrl,
  engine,
  resultSelector,
  titleSelector,
  urlSelector,
  snippetSelector,
  maxResults,
  urlTransform,
}: {
  html: string;
  baseUrl: string;
  engine: AggregatorEngineId;
  resultSelector: string;
  titleSelector: string;
  urlSelector: string;
  snippetSelector: string;
  maxResults: number;
  urlTransform?: (url: string) => string;
}): SearchResult[] {
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];

  for (const item of Array.from(document.querySelectorAll(resultSelector))) {
    if (results.length >= maxResults) break;
    const titleEl = item.querySelector(titleSelector);
    const urlEl = item.querySelector(urlSelector);
    const snippetEl = item.querySelector(snippetSelector);
    const title = htmlAttr(titleEl, 'aria-label') || htmlText(titleEl);
    const rawUrl = htmlAttr(urlEl, 'href') || htmlText(urlEl);
    const url = urlTransform ? urlTransform(rawUrl) : absoluteUrl(rawUrl, baseUrl);
    const snippet = htmlText(snippetEl);
    if (!title || !url || !snippet) continue;

    results.push(normalizeSearchItem(engine, {
      title,
      url,
      snippet,
      full_content: snippet,
      metadata: { aggregator_engine: engine },
    }, results.length));
  }

  return results;
}
