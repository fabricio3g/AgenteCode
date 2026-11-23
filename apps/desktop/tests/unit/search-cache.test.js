import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { webSearch } from '../../main/search-engine.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('keeps cached results separate across result counts, endpoints, and reading policies', async () => {
  const searches = [];
  const reads = [];
  globalThis.fetch = async (url) => {
    const target = new URL(url);
    if (target.pathname === '/search') {
      searches.push(target.host);
      const topics = ['Albatross', 'Badger', 'Cheetah', 'Dolphin', 'Elephant', 'Flamingo'];
      return Response.json({ results: topics.map((topic, index) => ({
        title: `${topic} result from ${target.host}`,
        url: `https://article-${index}.example/`,
        content: 'Synthetic search result'
      })) });
    }
    reads.push(target.host);
    return new Response('Readable text. '.repeat(50), { headers: { 'content-type': 'text/plain' } });
  };

  const query = 'cache partition regression';
  const search = (max_results, searxng_base_url, use_local_readability = false) =>
    webSearch({ query, options: { provider: 'searxng', max_results, searxng_base_url, use_local_readability } });

  const first = await search(1, 'https://search-a.example');
  assert.equal(first.results.length, 1);

  const more = await search(6, 'https://search-a.example');
  assert.equal(more.results.length, 6);

  const changedEndpoint = await search(6, 'https://search-b.example');
  assert.equal(changedEndpoint.results.length, 6);
  assert.ok(changedEndpoint.results.every(({ title }) => title.includes('search-b.example')));

  const same = await search(6, 'https://search-b.example');
  assert.equal(same.cached, true);

  reads.length = 0;
  await search(6, 'https://search-b.example', true);
  assert.ok(reads.some((host) => host.startsWith('article-')));
  assert.deepEqual(searches, ['search-a.example', 'search-a.example', 'search-b.example', 'search-b.example']);
});
