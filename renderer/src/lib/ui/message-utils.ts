import type { SearchMeta } from '$lib/types/chat';

export interface SearchStatusInfo {
  title: string;
  detail: string;
}

export function providerLabel(provider?: string | null) {
  if (!provider) return '';
  const normalized = String(provider).replace(/[_-]+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function getSearchStatus(meta: SearchMeta | null): SearchStatusInfo | null {
  if (!meta?.searchRequested) return null;
  if (meta.researchSummary) {
    return {
      title: meta.researchStatus === 'completed' ? 'Deep research summary ready' : 'Deep research in progress',
      detail: meta.researchSummary.trim()
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
          ? 'Web search complete'
          : 'No web sources found',
    detail: detailParts.join(' ').trim()
  };
}

export function faviconUrl(url: string) {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return '';
  }
}

export function domainLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
