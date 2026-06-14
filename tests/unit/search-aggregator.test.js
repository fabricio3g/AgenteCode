import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSupportedAggregatorEngines, normalizeAggregatorEngines } from '../../main/search-providers/aggregator.ts';
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
    assert.deepEqual(normalizeAggregatorEngines(undefined), ['duckduckgo', 'wikipedia']);
  });

  it('includes searxng only when configured', () => {
    assert.deepEqual(normalizeAggregatorEngines(['duckduckgo', 'searxng']), ['duckduckgo']);
    assert.deepEqual(
      normalizeAggregatorEngines(['duckduckgo', 'searxng'], { searxng_base_url: 'https://searx.example' }),
      ['duckduckgo', 'searxng']
    );
  });

  it('ports the websearch aggregator engine set into the project', () => {
    const engines = getSupportedAggregatorEngines();
    for (const engine of ['duckduckgo', 'wikipedia', 'qwant', 'sepiasearch', 'bing', 'brave', 'startpage', 'mojeek', 'yahoo', 'librex', 'searxng']) {
      assert.ok(engines.includes(engine), `${engine} should be supported`);
    }
  });
});
