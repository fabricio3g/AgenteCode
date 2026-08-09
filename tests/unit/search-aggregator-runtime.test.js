import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetAggregatorCircuitBreakers,
  searchAggregator,
} from '../../main/search-providers/aggregator.ts';
import {
  coerceSearchText,
  mergeAndRankResults,
  normalizeSearchItem,
  textFromInvertedIndex,
} from '../../main/search-providers/shared.ts';
import { parseHtmlResults } from '../../main/search-providers/aggregator/html-parser.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAggregatorCircuitBreakers();
});

describe('aggregator execution', () => {
  it('does not query disabled engines', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('should not fetch');
    };
    const options = { aggregator_engines: [] };
    const results = await searchAggregator('test', 5, options);
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
    assert.deepEqual(options.aggregator_diagnostics.enabled_engines, []);
  });

  it('skips engines with missing required configuration', async () => {
    const options = { aggregator_engines: ['kagi'] };
    const results = await searchAggregator('test', 5, options);
    assert.deepEqual(results, []);
    assert.deepEqual(options.aggregator_diagnostics.engine_attempts[0].missing, ['api_key']);
    assert.equal(options.aggregator_diagnostics.engine_attempts[0].skipped, true);
  });

  it('opens the circuit after three consecutive engine failures', async () => {
    globalThis.fetch = async () => new Response('broken', { status: 500 });
    for (let index = 0; index < 3; index += 1) {
      await searchAggregator('test', 3, { aggregator_engines: ['wiby'] });
    }
    const options = { aggregator_engines: ['wiby'] };
    await searchAggregator('test', 3, options);
    const attempt = options.aggregator_diagnostics.engine_attempts[0];
    assert.equal(attempt.skipped, true);
    assert.ok(attempt.cooldown_until);
  });
});

describe('research text coercion', () => {
  it('reconstructs OpenAlex inverted-index abstracts', () => {
    const abstract = textFromInvertedIndex({
      Climate: [0],
      policy: [1],
      affects: [2],
      outcomes: [3],
    });
    assert.equal(abstract, 'Climate policy affects outcomes');
    assert.equal(coerceSearchText({ word: [1], first: [0] }), 'first word');
    assert.equal(coerceSearchText({ nested: true }), '');
    const item = normalizeSearchItem('openalex', {
      title: 'Paper',
      url: 'https://openalex.org/W1',
      snippet: { The: [0], abstract: [1], text: [2] },
    }, 0);
    assert.equal(item.snippet, 'The abstract text');
    assert.ok(!item.snippet.includes('[object Object]'));
  });
});

describe('aggregator parsing and ranking', () => {
  it('parses a representative HTML result fixture', () => {
    const results = parseHtmlResults({
      html: '<article><h2><a href="/page">Example title</a></h2><p>Useful example snippet.</p></article>',
      baseUrl: 'https://example.com',
      engine: 'mwmbl',
      resultSelector: 'article',
      titleSelector: 'h2 a',
      urlSelector: 'h2 a',
      snippetSelector: 'p',
      maxResults: 3,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://example.com/page');
    assert.equal(results[0].provider, 'mwmbl');
  });

  it('merges consensus results and limits repeated domains', () => {
    const make = (provider, rank, title, url) => normalizeSearchItem(provider, {
      title, url, snippet: `${title} about search aggregation`,
    }, rank - 1);
    const ranked = mergeAndRankResults([
      make('wiby', 1, 'Shared result', 'https://shared.example/article?utm_source=test'),
      make('mojeek', 2, 'Shared result', 'https://shared.example/article'),
      make('wiby', 2, 'Second', 'https://shared.example/second'),
      make('wiby', 3, 'Third', 'https://shared.example/third'),
      make('wikipedia', 1, 'Diverse source', 'https://different.example/page'),
    ], 'search aggregation', 4);
    const shared = ranked.find((item) => item.title === 'Shared result');
    assert.ok(shared);
    assert.ok(shared.providers.includes('wiby'));
    assert.ok(shared.providers.includes('mojeek'));
    assert.ok(ranked.some((item) => item.url.includes('different.example')));
    assert.ok(ranked.filter((item) => item.url.includes('shared.example')).length <= 3);
  });
});
