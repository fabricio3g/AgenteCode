import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  resetAggregatorCircuitBreakers,
  searchAggregator,
} from '../../main/search-providers/aggregator.ts';
import {
  buildEffectiveSearchQuery,
  fetchWithRetry,
  mergeAndRankResults,
  normalizeSearchItem,
  tokenize,
} from '../../main/search-providers/shared.ts';
import { searchPerplexity, searchSearxng } from '../../main/search-providers/providers.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAggregatorCircuitBreakers();
});

describe('aggregator health', () => {
  it('keeps querying an engine that answers with no matches', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const body = calls <= 3 ? [] : [{ Title: 'Match', URL: 'https://match.example/', Snippet: 'found' }];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    for (const query of ['one', 'two', 'three']) {
      await searchAggregator(query, 3, { aggregator_engines: ['wiby'] });
    }
    const options = { aggregator_engines: ['wiby'] };
    const results = await searchAggregator('four', 3, options);
    assert.equal(calls, 4, 'the engine is not in cooldown');
    assert.equal(results.length, 1);
    const attempt = options.aggregator_diagnostics.engine_attempts[0];
    assert.equal(attempt.success, true);
    assert.equal(attempt.result_count, 1);
  });
});

describe('SearXNG base URL', () => {
  for (const base of ['https://search.example/searx/', 'https://search.example/searx', 'https://search.example']) {
    it(`keeps the path of ${base}`, async () => {
      let requested = '';
      globalThis.fetch = async (url) => {
        requested = String(url);
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };
      await searchSearxng('rust', 3, { searxng_base_url: base });
      const url = new URL(requested);
      const prefix = new URL(base).pathname.replace(/\/+$/, '');
      assert.equal(url.pathname, `${prefix}/search`);
      assert.equal(url.searchParams.get('q'), 'rust');
      assert.equal(url.searchParams.get('format'), 'json');
    });
  }
});

describe('Perplexity citations', () => {
  it('returns the structured citations instead of the homepage', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'The answer comes from the original source.[1][2]' } }],
      citations: ['https://docs.example/actual-source', 'https://other.example/page', 'https://docs.example/actual-source'],
    }), { status: 200 });
    const results = await searchPerplexity('q', 5, { perplexity_api_key: 'test' });
    assert.deepEqual(results.map((r) => r.url), ['https://docs.example/actual-source', 'https://other.example/page']);
    assert.ok(!results.some((r) => r.url.includes('perplexity.ai')));
  });
});

describe('fetchWithRetry body deadline', () => {
  it('times out a body that stalls after the headers', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const started = Date.now();
    await assert.rejects(fetchWithRetry(`http://127.0.0.1:${port}/`, { timeout_ms: 150, retries: 0 }));
    assert.ok(Date.now() - started < 2000, 'the deadline covered the body');
    server.closeAllConnections();
    server.close();
  });

  it('a caller abort stops the body read', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first bytes');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(fetchWithRetry(`http://127.0.0.1:${port}/`, { timeout_ms: 10_000, retries: 0, signal: controller.signal }));
    server.closeAllConnections();
    server.close();
  });
});

describe('ranking identity', () => {
  it('keeps same-title pages on different hosts apart', () => {
    const ranked = mergeAndRankResults([
      normalizeSearchItem('exa', { title: 'Official installation and setup guide', url: 'https://first.example/install', content: 'first host text' }, 0),
      normalizeSearchItem('exa', { title: 'Official installation and setup guide', url: 'https://second.example/install', content: 'second host text that is longer' }, 1),
    ], 'installation guide', 5);
    assert.equal(ranked.length, 2);
    for (const result of ranked) {
      const host = new URL(result.url).hostname.split('.')[0];
      assert.ok(result.full_content.startsWith(host), `${result.url} kept its own text`);
    }
  });

  it('keeps versioned docs with different numbers apart', () => {
    const ranked = mergeAndRankResults([
      normalizeSearchItem('exa', { title: 'Node 18 docs', url: 'https://nodejs.example/v18' }, 0),
      normalizeSearchItem('exa', { title: 'Node 20 docs', url: 'https://nodejs.example/v20' }, 1),
    ], 'node docs', 5);
    assert.equal(ranked.length, 2);
  });
});

describe('effective query', () => {
  const context = 'User: compare PostgreSQL and PostGIS for spatial data';

  it('sends an explicit freshness query as typed', () => {
    assert.equal(buildEffectiveSearchQuery('latest Node.js releases', context), 'latest Node.js releases');
    assert.equal(buildEffectiveSearchQuery('"exact phrase" news', context), '"exact phrase" news');
  });

  it('resolves a reference from the conversation', () => {
    const effective = buildEffectiveSearchQuery('what changed in that release?', context);
    assert.notEqual(effective, 'what changed in that release?');
    assert.ok(effective.endsWith('what changed in that release?'));
  });
});

describe('unicode terms', () => {
  it('tokenizes Japanese, Arabic and accented Latin', () => {
    assert.ok(tokenize('日本語の検索 東京').length > 0);
    assert.deepEqual(tokenize('البحث العربي'), ['البحث', 'العربي']);
    assert.deepEqual(tokenize('Café Zürich 2024'), ['café', 'zürich', '2024']);
    assert.deepEqual(tokenize('Rust 1.80 release'), ['rust', '1', '80', 'release']);
  });

  it('ranks relevant Japanese, Arabic and accented Latin pages ahead of unrelated pages', () => {
    const ja = mergeAndRankResults([
      normalizeSearchItem('exa', { title: 'Unrelated news', url: 'https://a.example/other', snippet: 'weather today' }, 0),
      normalizeSearchItem('exa', { title: '東京の日本語の検索ガイド', url: 'https://b.example/ja', snippet: '日本語の検索エンジン比較' }, 1),
    ], '日本語の検索 東京', 5);
    assert.equal(ja[0].url, 'https://b.example/ja');

    const ar = mergeAndRankResults([
      normalizeSearchItem('exa', { title: 'Unrelated page', url: 'https://a.example/other', snippet: 'sports' }, 0),
      normalizeSearchItem('exa', { title: 'دليل البحث العربي', url: 'https://b.example/ar', snippet: 'محركات البحث العربي' }, 1),
    ], 'البحث العربي', 5);
    assert.equal(ar[0].url, 'https://b.example/ar');

    const latin = mergeAndRankResults([
      normalizeSearchItem('exa', { title: 'Plain cafe', url: 'https://a.example/other', snippet: 'coffee menu' }, 0),
      normalizeSearchItem('exa', { title: 'Café Zürich guide', url: 'https://b.example/ch', snippet: 'best café in zürich' }, 1),
    ], 'Café Zürich', 5);
    assert.equal(latin[0].url, 'https://b.example/ch');
  });

  it('retains non-ASCII terms from conversation context for follow-up queries', () => {
    const jaEffective = buildEffectiveSearchQuery('what about that?', 'User: 東京 天気 予報');
    assert.notEqual(jaEffective, 'what about that?');
    assert.match(jaEffective, /東京/);

    const arEffective = buildEffectiveSearchQuery('what about that?', 'User: البحث العربي الحديث');
    assert.notEqual(arEffective, 'what about that?');
    assert.match(arEffective, /البحث/);
  });
});
