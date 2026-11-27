import { scrapeUrlStructured, clampNumber } from './web-scraper.ts';
import { normalizeWhitespace } from './search-providers/shared.ts';
import { scoreLinksForQuery } from './link-scorer.ts';
import { summarizeCrawledPages } from './content-summarizer.ts';

const MODE_CONFIG = {
  deep: {
    maxDepth: 2,
    maxPages: 24,
    linksPerPage: 7,
    maxCharsPerPage: 7000,
    minLinkScore: 0.08
  },
  max: {
    maxDepth: 4,
    maxPages: 90,
    linksPerPage: 12,
    maxCharsPerPage: 10000,
    minLinkScore: 0.045
  }
};

/**
 * The URL to request: http(s) only, without its fragment. The path is kept
 * as written: `/guide/` and `/guide` can be different documents (one may
 * 404), so a trailing slash is never stripped. Pages read twice under both
 * spellings are deduplicated by their content instead.
 */
function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Page text with its paragraphs kept: spaces collapse within each line and
 * blank-line runs shrink to one, so the summarizer can still pick the
 * paragraph that answers the query.
 */
function tidyPageText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function contentKey(text) {
  const flat = normalizeWhitespace(text).toLowerCase();
  return `${flat.length}:${flat.slice(0, 2000)}`;
}

function enqueue(queue, candidate) {
  queue.push(candidate);
  queue.sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.depth - right.depth;
  });
}

function uniqueSeedUrls(seedUrls) {
  const visited = new Set();
  const items = [];
  for (const value of Array.isArray(seedUrls) ? seedUrls : []) {
    const normalized = normalizeUrl(value);
    if (!normalized || visited.has(normalized)) continue;
    visited.add(normalized);
    items.push(normalized);
  }
  return items;
}

/**
 * Every page whole, in crawl order, while they fit. Reports what it left
 * out (`omitted` pages, `clipped` text) so the caller never mistakes a
 * partial context for the full one.
 */
function buildCrawlContext(pages, budgetChars) {
  const budget = Math.max(500, Number(budgetChars) || 7000);
  const blocks = [];
  let used = 0;
  let omitted = 0;
  let clipped = false;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const content = page.content || '';
    if (!normalizeWhitespace(content)) continue;
    const limit = Math.min(4200, budget);
    if (content.length > limit) clipped = true;

    const block = [
      `## [C${i + 1}] ${page.title || page.url || 'Untitled page'}`,
      `URL: ${page.url}`,
      `Depth: ${page.depth}`,
      content.slice(0, limit)
    ].join('\n\n');

    if (used >= budget || (blocks.length > 0 && used + block.length > budget)) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
    used += block.length + 24;
  }
  return { text: blocks.join('\n\n---\n\n'), omitted, clipped };
}

export async function crawlWeb({
  query,
  mode = 'deep',
  seed_urls,
  context_budget_chars,
  emit,
  signal
} = {}, deps = {}) {
  if (signal?.aborted) {
    throw new DOMException('Crawl aborted', 'AbortError');
  }
  const modeConfig = mode === 'max' ? MODE_CONFIG.max : MODE_CONFIG.deep;
  const budgetChars = clampNumber(
    context_budget_chars,
    1000,
    100000,
    mode === 'max' ? 30000 : 16000
  );

  const scrapeFn = typeof deps.scrapeFn === 'function' ? deps.scrapeFn : scrapeUrlStructured;
  const scoreFn = typeof deps.scoreFn === 'function' ? deps.scoreFn : scoreLinksForQuery;

  const seeds = uniqueSeedUrls(seed_urls).slice(0, mode === 'max' ? 20 : 10);
  if (!seeds.length) {
    return {
      query: normalizeWhitespace(query),
      mode,
      results: [],
      context: '',
      stats: {
        pages_crawled: 0,
        pages_discovered: 0,
        pages_attempted: 0,
        pages_failed: 0,
        pages_omitted: 0,
        truncated: false,
        max_depth_reached: 0
      }
    };
  }

  const queue = [];
  const queued = new Set();
  const visited = new Set();
  const seenContent = new Set();
  const pages = [];
  let maxDepthReached = 0;
  // Network reads have their own hard cap: a failed read (404, timeout)
  // adds no page, and without a cap a burst of dead links kept the crawl
  // going well past the page budget.
  const maxAttempts = Math.ceil(modeConfig.maxPages * 1.5);
  let attempts = 0;
  let failed = 0;

  for (const url of seeds) {
    enqueue(queue, { url, depth: 0, parentUrl: '', priority: 1.0 });
    queued.add(url);
  }

  while (queue.length && pages.length < modeConfig.maxPages && attempts < maxAttempts) {
    if (signal?.aborted) {
      throw new DOMException('Crawl aborted', 'AbortError');
    }
    const next = queue.shift();
    if (!next) break;
    queued.delete(next.url);
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    maxDepthReached = Math.max(maxDepthReached, next.depth);

    emit?.('crawl_page', `Crawling page ${pages.length + 1}/${modeConfig.maxPages}: ${next.url}`);

    attempts += 1;
    let scraped;
    try {
      scraped = await scrapeFn({
        url: next.url,
        maxLength: modeConfig.maxCharsPerPage,
        timeoutMs: 18000,
        maxLinks: 120,
        signal
      });
    } catch {
      if (signal?.aborted) {
        throw new DOMException('Crawl aborted', 'AbortError');
      }
      scraped = null;
    }
    if (signal?.aborted) {
      throw new DOMException('Crawl aborted', 'AbortError');
    }

    if (!scraped || scraped.error || !normalizeWhitespace(scraped.content)) {
      failed += 1;
      continue;
    }

    const content = tidyPageText(scraped.content);
    // The same document under another spelling of its URL (`/guide` and
    // `/guide/`, a redirect): read once, kept once.
    const key = contentKey(content);
    if (seenContent.has(key)) continue;
    seenContent.add(key);

    pages.push({
      url: next.url,
      title: scraped.title || next.url,
      content,
      excerpt: scraped.excerpt || '',
      depth: next.depth,
      parentUrl: next.parentUrl || '',
      score: next.priority,
      linksCount: Array.isArray(scraped.links) ? scraped.links.length : 0
    });

    if (next.depth >= modeConfig.maxDepth) continue;
    if (!Array.isArray(scraped.links) || !scraped.links.length) continue;

    const scoredLinks = await scoreFn({
      query,
      links: scraped.links,
      baseUrl: next.url
    });

    const selected = scoredLinks
      .filter((link) => Number(link.relevance_score || 0) >= modeConfig.minLinkScore)
      .slice(0, modeConfig.linksPerPage);

    for (const link of selected) {
      const normalized = normalizeUrl(link.url);
      if (!normalized || visited.has(normalized) || queued.has(normalized)) continue;
      queued.add(normalized);
      enqueue(queue, {
        url: normalized,
        depth: next.depth + 1,
        parentUrl: next.url,
        priority: Number(link.relevance_score || 0)
      });
    }
  }

  const raw = buildCrawlContext(pages, budgetChars);
  // The whole pages fit: send them. Otherwise condense every page to its
  // most relevant paragraphs, which keeps a short excerpt of each source
  // (and names any that still did not fit) instead of silently dropping
  // the ones at the end.
  const complete = raw.omitted === 0 && !raw.clipped && raw.text.length <= budgetChars;
  const summary = complete ? null : summarizeCrawledPages({
    pages,
    query,
    targetChars: budgetChars
  });
  const finalContext = complete ? raw.text : (summary?.text || raw.text.slice(0, budgetChars));

  const results = pages.map((page, index) => ({
    title: page.title,
    url: page.url,
    snippet: page.excerpt || normalizeWhitespace(page.content).slice(0, 280),
    full_content: page.content.slice(0, modeConfig.maxCharsPerPage),
    provider: 'crawler',
    source_rank: index + 1,
    score: Number(page.score || 0),
    metadata: {
      crawl_depth: page.depth,
      parent_url: page.parentUrl || null,
      links_discovered: page.linksCount
    }
  }));

  return {
    query: normalizeWhitespace(query),
    mode,
    results,
    context: finalContext,
    stats: {
      pages_crawled: pages.length,
      pages_discovered: visited.size,
      pages_attempted: attempts,
      pages_failed: failed,
      pages_omitted: summary ? summary.omitted : raw.omitted,
      truncated: !complete,
      max_depth_reached: maxDepthReached
    }
  };
}
