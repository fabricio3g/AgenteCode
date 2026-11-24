import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { crawlWeb } from '../../main/web-crawler.ts';
import { scoreLinksForQuery } from '../../main/link-scorer.ts';
import { setEmbeddingStatus } from '../../main/embedding-state.ts';
import { clearEmbeddingCache, cosineSimilarity } from '../../main/embedding-client.ts';

const scoreAll = async ({ links }) => links.map((link) => ({ ...link, relevance_score: 1 }));

test('failed reads count toward a hard attempt cap', async () => {
  const site = {};
  for (let i = 0; i < 10; i += 1) {
    site[`https://seed.test/${i}`] = {
      title: `Seed ${i}`,
      content: `Readable seed page ${i} with text.`,
      links: Array.from({ length: 7 }, (_, j) => ({ text: 'dead', url: `https://dead.test/${i}-${j}` }))
    };
  }
  let reads = 0;
  const result = await crawlWeb({
    query: 'seed', mode: 'deep', seed_urls: Object.keys(site)
  }, {
    scrapeFn: async ({ url }) => {
      reads += 1;
      return site[url] ? { ...site[url], url } : { error: 'not found', content: '' };
    },
    scoreFn: scoreAll
  });
  assert.ok(reads <= 36, `bounded network reads (${reads})`);
  assert.equal(result.stats.pages_attempted, reads);
  assert.equal(result.stats.pages_failed, reads - result.stats.pages_crawled);
  assert.equal(result.stats.pages_crawled, 10, 'collected pages are kept');
});

test('a trailing slash is requested as written', async () => {
  const requested = [];
  const result = await crawlWeb({ query: 'guide', seed_urls: ['https://docs.test/guide/'] }, {
    scrapeFn: async ({ url }) => {
      requested.push(url);
      return url === 'https://docs.test/guide/'
        ? { title: 'Guide', content: 'The guide article.', links: [] }
        : { error: 'not found', content: '' };
    },
    scoreFn: scoreAll
  });
  assert.deepEqual(requested, ['https://docs.test/guide/']);
  assert.equal(result.results.length, 1);
});

test('a relevant late paragraph survives a small context budget', async () => {
  const intro = Array.from({ length: 30 }, (_, i) => `Introductory paragraph ${i} about general topics and background material.`).join('\n\n');
  const content = `${intro}\n\nUnique reimbursement deadline: claims are due within 30 days.`;
  const result = await crawlWeb({
    query: 'reimbursement deadline', seed_urls: ['https://policy.test/'], context_budget_chars: 1000
  }, {
    scrapeFn: async () => ({ title: 'Policy', content, links: [] }),
    scoreFn: scoreAll
  });
  assert.ok(result.context.includes('Unique reimbursement deadline'), result.context);
  assert.ok(result.results[0].full_content.includes('\n\n'), 'paragraph breaks kept');
  assert.equal(result.stats.truncated, true);
});

test('a source that does not fit is excerpted or reported, never silently dropped', async () => {
  const site = {
    'https://s.test/first': 'text '.repeat(24),
    'https://s.test/second': 'second '.repeat(78),
    'https://s.test/third': 'text '.repeat(24) + 'third',
  };
  const result = await crawlWeb({
    query: 'text', seed_urls: Object.keys(site), context_budget_chars: 1000
  }, {
    scrapeFn: async ({ url }) => ({ title: url, content: site[url], links: [] }),
    scoreFn: scoreAll
  });
  assert.equal(result.results.length, 3);
  assert.ok(result.context.includes('https://s.test/third'), result.context);
  if (!result.context.includes('URL: https://s.test/third')) {
    assert.equal(result.stats.truncated, true);
  }
});

test('semantic link scoring runs when embeddings are ready', async () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);

  const vectorFor = (text) => (/reimbursement|repayment/i.test(text) ? [1, 0] : [0, 1]);
  let requests = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests += 1;
      const input = JSON.parse(body).input;
      const inputs = Array.isArray(input) ? input : [input];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: vectorFor(text) })) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  setEmbeddingStatus({ state: 'ready', port: server.address().port });
  clearEmbeddingCache();
  try {
    const scored = await scoreLinksForQuery({
      query: 'reimbursement',
      links: [
        { text: 'expense repayment policy', url: 'https://hr.test/policy' },
        { text: 'office map', url: 'https://hr.test/map' },
      ],
    });
    assert.ok(requests > 0, 'the embedding endpoint was asked');
    const policy = scored.find((link) => link.url.endsWith('/policy'));
    assert.ok(policy.relevance.semantic > 0.9, JSON.stringify(policy.relevance));
    assert.equal(scored[0].url, 'https://hr.test/policy');
  } finally {
    setEmbeddingStatus({ state: 'stopped', port: null });
    clearEmbeddingCache();
    server.close();
  }
});
