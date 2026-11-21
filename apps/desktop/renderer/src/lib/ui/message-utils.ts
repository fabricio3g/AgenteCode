import type { SearchMeta } from '$lib/types/chat';

export interface SearchStatusInfo {
  title: string;
  detail: string;
}

export function getSearchStatus(meta: SearchMeta | null): SearchStatusInfo | null {
  if (!meta?.searchRequested) return null;
  if (meta.researchSummary) {
    const crawl = meta.researchStats;
    const crawlDetail = crawl?.pagesCrawled
      ? ` Crawled ${crawl.pagesCrawled} pages` + (crawl.maxDepthReached != null ? ` (depth ${crawl.maxDepthReached})` : '') + '.'
      : '';
    return {
      title: meta.researchStatus === 'completed' ? 'Deep research summary ready' : 'Deep research in progress',
      detail: `${meta.researchSummary.trim()}${crawlDetail}`.trim()
    };
  }
  const failed = meta.searchSucceeded === false;
  const hasFallback = !!meta.searchFallbackReason || !!meta.providerWarnings?.length;
  const sourceCount = Number(meta.sourceCount || 0);
  const detailParts: string[] = [];

  if (meta.searchError) detailParts.push(meta.searchError);
  if (meta.searchFallbackReason) detailParts.push(meta.searchFallbackReason);
  if (meta.providerWarnings?.length) detailParts.push(meta.providerWarnings.join(' '));
  if (meta.contextAvailable === false) {
    detailParts.push(
      sourceCount > 0
        ? 'Sources were found, but readable page context was limited.'
        : 'No live web sources were found for this query.'
    );
  }

  return {
    title: failed
      ? 'Web search unavailable'
      : hasFallback
        ? 'Web search fallback'
        : sourceCount > 0
          ? 'Searched the web'
          : 'No web sources found',
    detail: detailParts.join(' ').trim()
  };
}

export function domainLabel(url: string, fallback = url): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return fallback;
  }
}
