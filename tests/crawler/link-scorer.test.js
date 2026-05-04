import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLinksForQuery } from '../../main/link-scorer.ts';

test('scoreLinksForQuery ranks relevant links above noise links', async () => {
  const query = 'best rust web crawler performance benchmark';
  const links = [
    { text: 'Rust web crawler benchmark report', url: 'https://example.com/rust-crawler-benchmark' },
    { text: 'Login', url: 'https://example.com/login' },
    { text: 'Our privacy policy', url: 'https://example.com/privacy' },
    { text: 'Crawler comparison in Rust and Go', url: 'https://docs.example.com/crawler-comparison-rust-go' }
  ];

  const scored = await scoreLinksForQuery({ query, links, baseUrl: 'https://example.com/article' });
  assert.ok(scored.length >= 4);
  assert.equal(scored[0].url, 'https://example.com/rust-crawler-benchmark');
  assert.ok((scored.at(-1)?.url || '').includes('/privacy'));
});
