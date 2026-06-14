import { scrapeUrlStructured } from './web-scraper.ts';
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

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(num, max));
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return '';
  }
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

function buildCrawlContext(pages, budgetChars) {
  const budget = Math.max(500, Number(budgetChars) || 7000);
  const blocks = [];
  let used = 0;
  for (let i = 0; i < pages.length; i += 1) {
    if (used >= budget) break;
    const page = pages[i];
    const content = normalizeWhitespace(page.content || '');
    if (!content) continue;

    const block = [
      `## [C${i + 1}] ${page.title || page.url || 'Untitled page'}`,
      `URL: ${page.url}`,
      `Depth: ${page.depth}`,
      content.slice(0, Math.min(4200, budget))
    ].join('\n\n');

    if (blocks.length > 0 && used + block.length > budget) break;
    blocks.push(block);
    used += block.length + 24;
  }
  return blocks.join('\n\n---\n\n');
}

export async function crawlWeb({
  query,
  mode = 'deep',
  seed_urls,
  context_budget_chars,
  emit
} = {}, deps = {}) {
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
        truncated: false,
        max_depth_reached: 0
      }
    };
  }

  const queue = [];
  const queued = new Set();
  const visited = new Set();
  const pages = [];
  let maxDepthReached = 0;

  for (const url of seeds) {
    enqueue(queue, { url, depth: 0, parentUrl: '', priority: 1.0 });
    queued.add(url);
  }

  while (queue.length && pages.length < modeConfig.maxPages) {
    const next = queue.shift();
    if (!next) break;
    queued.delete(next.url);
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    maxDepthReached = Math.max(maxDepthReached, next.depth);

    emit?.('crawl_page', `Crawling page ${pages.length + 1}/${modeConfig.maxPages}: ${next.url}`);

    const scraped = await scrapeFn({
      url: next.url,
      maxLength: modeConfig.maxCharsPerPage,
      timeoutMs: 18000,
      maxLinks: 120
    });

    if (!scraped || scraped.error || !normalizeWhitespace(scraped.content)) {
      continue;
    }

    pages.push({
      url: next.url,
      title: scraped.title || next.url,
      content: normalizeWhitespace(scraped.content),
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

  const contextRaw = buildCrawlContext(pages, budgetChars);
  const summary = summarizeCrawledPages({
    pages,
    query,
    targetChars: budgetChars
  });

  const shouldSummarize = contextRaw.length > budgetChars || summary.truncated;
  const finalContext = shouldSummarize
    ? summary.text || contextRaw.slice(0, budgetChars)
    : contextRaw;

  const results = pages.map((page, index) => ({
    title: page.title,
    url: page.url,
    snippet: page.excerpt || page.content.slice(0, 280),
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
      truncated: shouldSummarize,
      max_depth_reached: maxDepthReached
    }
  };
}
