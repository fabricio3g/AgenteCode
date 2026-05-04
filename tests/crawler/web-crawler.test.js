import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlWeb } from '../../main/web-crawler.ts';

const pages = {
  'https://site.test/start': {
    title: 'Start Page',
    content: 'This page introduces rust crawler benchmarks and performance metrics.',
    excerpt: 'Start excerpt',
    links: [
      { text: 'Rust benchmark details', url: 'https://site.test/benchmarks', domain: 'site.test', sameSite: true },
      { text: 'Login', url: 'https://site.test/login', domain: 'site.test', sameSite: true }
    ]
  },
  'https://site.test/benchmarks': {
    title: 'Benchmark Details',
    content: 'Detailed benchmark data for rust and go web crawlers with latency and throughput.',
    excerpt: 'Benchmarks excerpt',
    links: [
      { text: 'Methodology', url: 'https://site.test/methodology', domain: 'site.test', sameSite: true }
    ]
  },
  'https://site.test/methodology': {
    title: 'Methodology',
    content: 'Methodology page with crawl setup and indexing assumptions.',
    excerpt: 'Method excerpt',
    links: []
  }
};

async function scrapeFn({ url }) {
  const page = pages[url];
  if (!page) return { error: 'not found', url, status: 404, content: '' };
  return {
    ...page,
    url,
    status: 200,
    length: page.content.length
  };
}

async function scoreFn({ links }) {
  return (links || [])
    .map((link) => ({
      ...link,
      relevance_score: String(link.url).includes('login') ? 0.01 : 0.8
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score);
}

test('crawlWeb follows high relevance links and builds context', async () => {
  const result = await crawlWeb({
    query: 'rust crawler benchmark',
    mode: 'deep',
    seed_urls: ['https://site.test/start'],
    context_budget_chars: 3200
  }, { scrapeFn, scoreFn });

  assert.ok(result.results.length >= 2);
  assert.equal(result.results[0].url, 'https://site.test/start');
  assert.ok(result.context.includes('Benchmark Details'));
  assert.ok((result.stats?.pages_crawled || 0) >= 2);
});
