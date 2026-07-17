#!/usr/bin/env node
/**
 * Opt-in live smoke test for free-path search + scrape.
 * Network required. Not wired into CI — engines may rate-limit.
 *
 *   npm run smoke:search
 *   npx tsx scripts/smoke-doc-scrape.mjs   # PDF + Readability HTML
 */
import { searchAggregator } from '../main/search-providers/aggregator/index.ts';
import { scrapeUrlStructured } from '../main/web-scraper.ts';

const QUERY = process.env.SMOKE_QUERY || 'Mozilla Readability web scraping';
const SCRAPE_URL =
  process.env.SMOKE_SCRAPE_URL || 'https://en.wikipedia.org/wiki/Web_scraping';

function log(section, detail) {
  console.log(`\n=== ${section} ===`);
  console.log(detail);
}

async function smokeSearch() {
  log('Search aggregator', `query="${QUERY}" engines=duckduckgo,wikipedia`);
  const results = await searchAggregator(QUERY, 8, {
    aggregator_engines: ['duckduckgo', 'wikipedia']
  });
  const titles = results.slice(0, 5).map((r, i) => `${i + 1}. ${r.title || '(no title)'} — ${r.url}`);
  log('Search results', `count=${results.length}\n${titles.join('\n') || '(none)'}`);

  if (!results.length) {
    throw new Error('Aggregator returned zero results for free engines');
  }
  return results;
}

async function smokeScrape(url) {
  log('Scrape', url);
  const page = await scrapeUrlStructured({
    url,
    maxLength: 20000,
    timeoutMs: 15000,
    maxLinks: 30
  });
  if (page?.error && !page?.content) {
    throw new Error(`Scrape failed: ${page.error}`);
  }
  log(
    'Scrape result',
    [
      `title=${page.title || ''}`,
      `status=${page.status ?? 'n/a'}`,
      `quality=${page.quality || 'n/a'}`,
      `length=${page.length ?? page.content?.length ?? 0}`,
      `links=${Array.isArray(page.links) ? page.links.length : 0}`,
      `warning=${page.warning || ''}`,
      `excerpt=${String(page.excerpt || '').slice(0, 160)}`
    ].join('\n')
  );
  if (page.quality === 'blocked' && !(page.content && page.content.length > 200)) {
    throw new Error(`Scrape quality blocked with little content: ${page.warning || page.error}`);
  }
  return page;
}

async function main() {
  const results = await smokeSearch();
  const candidate =
    results.find((r) => /^https?:\/\//i.test(r.url || ''))?.url || SCRAPE_URL;
  await smokeScrape(SCRAPE_URL);
  // Also try first search hit if different (soft — ignore failure)
  if (candidate && candidate !== SCRAPE_URL) {
    try {
      await smokeScrape(candidate);
    } catch (err) {
      console.warn(`\n[warn] scrape of search hit failed (non-fatal): ${err.message}`);
    }
  }
  console.log('\nSmoke OK: search + scrape path functional.\n');
}

main().catch((err) => {
  console.error('\nSmoke FAILED:', err?.message || err);
  process.exitCode = 1;
});
