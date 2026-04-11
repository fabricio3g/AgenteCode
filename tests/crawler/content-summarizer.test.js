import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCrawledPages } from '../../main/content-summarizer.js';

test('summarizeCrawledPages condenses pages within target budget', () => {
  const pages = [
    {
      title: 'Primary Findings',
      url: 'https://example.com/findings',
      depth: 0,
      score: 1,
      content: 'Rust crawler benchmark shows strong throughput. '.repeat(90)
    },
    {
      title: 'Secondary Notes',
      url: 'https://example.com/notes',
      depth: 1,
      score: 0.7,
      content: 'Latency measurements and indexing caveats are documented here. '.repeat(90)
    }
  ];

  const summary = summarizeCrawledPages({
    pages,
    query: 'rust crawler benchmark throughput latency',
    targetChars: 2200
  });

  assert.ok(summary.text.length <= 2200);
  assert.ok(summary.text.includes('Primary Findings'));
  assert.ok(summary.usedChars <= 2200);
});
