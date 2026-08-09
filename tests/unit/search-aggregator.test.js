import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAggregatorCatalog, getSupportedAggregatorEngines, normalizeAggregatorEngines } from '../../main/search-providers/aggregator.ts';
import { providerCandidates, providerDisplayName, providerHasCredentials } from '../../main/search-providers/shared.ts';

describe('search aggregator provider', () => {
  it('is available without credentials', () => {
    assert.equal(providerHasCredentials('aggregator', {}), true);
    assert.equal(providerDisplayName('aggregator'), 'Chatea Aggregator');
  });

  it('is included in auto provider candidates', () => {
    const candidates = providerCandidates('auto', {}, 'search');
    assert.equal(candidates[0], 'aggregator');
    assert.ok(candidates.includes('duckduckgo'));
  });

  it('normalizes default aggregator engines', () => {
    assert.deepEqual(normalizeAggregatorEngines(undefined), ['duckduckgo', 'wikipedia', 'wiby', 'mojeek']);
  });

  it('preserves explicitly selected configurable engines', () => {
    assert.deepEqual(normalizeAggregatorEngines(['duckduckgo', 'searxng']), ['duckduckgo', 'searxng']);
  });

  it('ports the websearch aggregator engine set into the project', () => {
    const engines = getSupportedAggregatorEngines();
    for (const engine of [
      'duckduckgo', 'wikipedia', 'wiby', 'mojeek', 'qwant', 'sepiasearch',
      'bing', 'brave', 'startpage', 'yahoo', 'librex', 'searxng',
      'yep', 'mwmbl', 'marginalia', 'yandex', 'baidu', 'google', 'ghostery',
      'yacy', 'fourget', 'openserp', 'kagi', 'firecrawl', 'searchapi',
      'linkup', 'ollama_web', 'perplexity_search', 'arxiv', 'openalex',
      'crossref', 'stackexchange', 'hackernews'
    ]) {
      assert.ok(engines.includes(engine), `${engine} should be supported`);
    }
  });

  it('exposes registry metadata and recommended defaults', () => {
    const catalog = getAggregatorCatalog();
    assert.equal(catalog.length, getSupportedAggregatorEngines().length);
    assert.deepEqual(catalog.filter((item) => item.recommended).map((item) => item.id), ['duckduckgo', 'wikipedia', 'wiby', 'mojeek']);
    assert.ok(catalog.every((item) => item.label && item.category && item.transport));
  });
});
