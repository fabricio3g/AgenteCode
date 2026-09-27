import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAggregatorCatalog, getSupportedAggregatorEngines, normalizeAggregatorEngines } from '../../main/search-providers/aggregator.ts';
import { providerCandidates, providerDisplayName, providerHasCredentials } from '../../main/search-providers/shared.ts';

describe('search aggregator provider', () => {
  it('is available without credentials', () => {
    assert.equal(providerHasCredentials('aggregator', {}), true);
    assert.equal(providerDisplayName('aggregator'), 'Agente Aggregator');
  });

  it('is included in auto provider candidates', () => {
    const candidates = providerCandidates('auto', {}, 'search');
    assert.deepEqual(candidates, ['aggregator']);
    assert.deepEqual(providerCandidates('auto', { tavily_api_key: 't' }, 'search'), ['tavily', 'aggregator']);
  });

  it('normalizes default aggregator engines', () => {
    assert.deepEqual(normalizeAggregatorEngines(undefined), ['wikipedia', 'arxiv', 'crossref', 'pubmed']);
  });

  it('preserves explicitly selected configurable engines', () => {
    assert.deepEqual(normalizeAggregatorEngines(['wikipedia', 'searxng']), ['wikipedia', 'searxng']);
  });

  it('drops removed scrapers and falls back to the defaults when nothing is left', () => {
    assert.deepEqual(normalizeAggregatorEngines(['google', 'wikipedia']), ['wikipedia']);
    assert.deepEqual(normalizeAggregatorEngines(['duckduckgo', 'mojeek']), ['wikipedia', 'arxiv', 'crossref', 'pubmed']);
  });

  it('never routes to a removed scraper or reseller', () => {
    for (const removed of ['duckduckgo', 'electron', 'serpapi', 'serper', 'google_cse', 'bing']) {
      assert.deepEqual(providerCandidates(removed, {}, 'search'), ['aggregator']);
    }
  });

  it('offers only API-based engines, no result-page scrapers', () => {
    const engines = getSupportedAggregatorEngines();
    for (const engine of ['wikipedia', 'wiby', 'arxiv', 'crossref', 'semantic_scholar', 'pubmed', 'openalex', 'stackexchange', 'hackernews', 'searxng', 'kagi']) {
      assert.ok(engines.includes(engine), `${engine} should be supported`);
    }
    for (const scraper of ['duckduckgo', 'mojeek', 'google', 'bing', 'brave', 'yahoo', 'startpage', 'yandex', 'baidu', 'qwant', 'openserp', 'searchapi']) {
      assert.ok(!engines.includes(scraper), `${scraper} must not be offered`);
    }
    assert.ok(getAggregatorCatalog().every((item) => item.transport === 'json' || item.transport === 'xml'));
  });

  it('exposes registry metadata and recommended defaults', () => {
    const catalog = getAggregatorCatalog();
    assert.equal(catalog.length, getSupportedAggregatorEngines().length);
    assert.deepEqual(catalog.filter((item) => item.recommended).map((item) => item.id), ['wikipedia', 'arxiv', 'crossref', 'pubmed']);
    assert.ok(catalog.every((item) => item.label && item.category && item.transport));
  });
});
