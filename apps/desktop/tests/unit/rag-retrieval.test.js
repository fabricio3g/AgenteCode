import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { anchorOf, chunkMarkdown, rowRangeOf, searchableText } from '../../main/rag/chunking.ts';
import { Bm25, blendScores, buildContext, citationOf, selectDiverse, tokenize } from '../../main/rag/ranking.ts';

describe('chunkMarkdown', () => {
  it('keeps the heading trail and source lines on every chunk', () => {
    const md = '# Report\n\nIntro text.\n\n## Page 3\n\nResults are good.\n';
    const chunks = chunkMarkdown(md, { size: 200 });
    assert.deepEqual(chunks.map((c) => c.heading), ['Report', 'Report › Page 3']);
    assert.equal(chunks[1].text, 'Results are good.');
    assert.equal(chunks[1].lineStart, 7);
    assert.equal(chunks[1].lineEnd, 7);
  });

  it('normalizes CRLF so Windows paragraphs still split', () => {
    const chunks = chunkMarkdown('alpha one\r\n\r\nbeta two', { size: 128, overlap: 0 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, 'alpha one\n\nbeta two');
  });

  it('splits code on lines, never on sentence punctuation, and re-fences each part', () => {
    const body = Array.from({ length: 40 }, (_, i) => `throw new Error("step ${i}. failed!"); // line ${i}`);
    const md = ['```js', ...body, '```'].join('\n');
    const chunks = chunkMarkdown(md, { size: 300 });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.text.startsWith('```js\n'), chunk.text);
      assert.ok(chunk.text.endsWith('\n```'), chunk.text);
      for (const line of chunk.text.split('\n').slice(1, -1)) {
        assert.match(line, /^throw new Error\("step \d+\. failed!"\); \/\/ line \d+$/);
      }
    }
    const lines = chunks.flatMap((c) => c.text.split('\n').slice(1, -1));
    assert.deepEqual(lines, body);
  });

  it('repeats the header row when a table is split', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| North ${i} | ${i * 10} |`);
    const md = ['## Sales', '', '| Region | Q1 |', '| --- | --- |', ...rows].join('\n');
    const chunks = chunkMarkdown(md, { size: 200, overlap: 0 });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.text.startsWith('| Region | Q1 |\n| --- | --- |\n'), chunk.text);
      assert.equal(chunk.heading, 'Sales');
    }
  });

  it('overlaps consecutive chunks of one section with whole paragraphs', () => {
    const paras = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ${'word '.repeat(12).trim()}.`);
    const chunks = chunkMarkdown(paras.join('\n\n'), { size: 200, overlap: 80 });
    assert.ok(chunks.length > 1);
    for (let i = 1; i < chunks.length; i++) {
      const lastOfPrevious = chunks[i - 1].text.split('\n\n').pop();
      assert.ok(chunks[i].text.startsWith(lastOfPrevious), `chunk ${i} should start with the tail of chunk ${i - 1}`);
    }
  });

  it('keeps a heading whose section has no body', () => {
    // A title-only slide used to vanish: its section produced no pieces, so no
    // chunk was emitted and the deck's outline never reached the index.
    const chunks = chunkMarkdown('# Deck\n\n## Slide 1: Roadmap\n\n## Slide 2: Costs\n');
    assert.deepEqual(chunks, [
      { text: '', heading: 'Deck', lineStart: 1, lineEnd: 1 },
      { text: '', heading: 'Deck › Slide 1: Roadmap', lineStart: 3, lineEnd: 3 },
      { text: '', heading: 'Deck › Slide 2: Costs', lineStart: 5, lineEnd: 5 }
    ]);
  });

  it('reports a fenced file in its own line numbers, not the fence\u2019s', () => {
    const md = ['```js', 'const a = 1;', 'const b = 2;', '```'].join('\n');
    const [chunk] = chunkMarkdown(md, { size: 200 });
    // The fence sits on line 1, so line 1 of the file is `const a = 1;`.
    assert.equal(chunk.lineStart, 2);
    assert.equal(chunk.lineEnd, 3);
  });

  it('prefixes the heading trail for search', () => {
    assert.equal(searchableText({ text: 'body', heading: 'A › B' }), 'A › B\n\nbody');
    assert.equal(searchableText({ text: 'body', heading: '' }), 'body');
  });
});

describe('ranking', () => {
  it('tokenizes accented and non-Latin words', () => {
    assert.deepEqual(tokenize('Diseño, AÑO 2026 — 東京'), ['diseño', 'año', '2026', '東京']);
  });

  it('ranks with BM25: rare terms outweigh common ones', () => {
    const scores = new Bm25([
      'the cat sat',
      'the dog ran',
      'the the the the bird',
      'quarterly invoice reconciliation'
    ]).scores('the invoice');
    assert.ok(scores[3] > scores[2], 'one rare term beats a common term repeated');
    assert.ok(scores[2] > scores[0], 'term frequency still counts');
  });

  it('blends normalized keyword score with vector similarity', () => {
    const candidates = [
      { item: 0, docId: 'a', text: '', keyword: 4, vector: 0.1, score: 0 },
      { item: 1, docId: 'b', text: '', keyword: 0, vector: 0.9, score: 0 }
    ];
    blendScores(candidates, 0.65);
    assert.ok(Math.abs(candidates[0].score - (0.35 + 0.065)) < 1e-9);
    assert.ok(Math.abs(candidates[1].score - 0.585) < 1e-9);
  });

  it('selects diverse results and caps chunks per document', () => {
    const make = (docId, text, score) => ({ item: text, docId, text, keyword: score, vector: null, score });
    const ranked = [
      make('a', 'refund policy thirty days receipt', 1),
      make('a', 'refund policy thirty days receipt required', 0.99),
      make('b', 'shipping takes five business days', 0.6),
      make('a', 'refund exceptions for sale items', 0.5)
    ];
    const picked = selectDiverse(ranked, 2, { lambda: 0.5, perDoc: 3 }).map((c) => c.item);
    assert.deepEqual(picked, ['refund policy thirty days receipt', 'shipping takes five business days']);

    const capped = selectDiverse(ranked, 4, { perDoc: 1 });
    assert.deepEqual(capped.map((c) => c.docId), ['a', 'b']);
  });

  it('drops zero-score candidates', () => {
    const picked = selectDiverse([{ item: 0, docId: 'a', text: 'x', keyword: 0, vector: null, score: 0 }], 3);
    assert.equal(picked.length, 0);
  });

  it('reads the locator a converter stamped into the heading', () => {
    assert.deepEqual(anchorOf('Report › Page 3'), { kind: 'page', index: 3, title: '' });
    assert.deepEqual(anchorOf('Slide 12: Roadmap'), { kind: 'slide', index: 12, title: 'Roadmap' });
    assert.deepEqual(anchorOf('Sheet 2: Q3'), { kind: 'sheet', index: 2, title: 'Q3' });
    assert.equal(anchorOf('Setup › Install'), null);

    const table = '| # | Region |\n| --- | --- |\n| 7 | North |\n| 9 | South |';
    assert.deepEqual(rowRangeOf(table), { first: 7, last: 9 });
    assert.equal(rowRangeOf('no table here'), null);
  });

  it('formats citations', () => {
    assert.equal(
      citationOf({ source: 'r.pdf', heading: 'Report › Page 3', lineStart: 40, lineEnd: 58, text: 'results' }),
      'r.pdf · page 3'
    );
    assert.equal(
      citationOf({ source: 'd.pptx', heading: 'Slide 2: Roadmap', text: 'body' }),
      'd.pptx · slide 2: Roadmap'
    );
    assert.equal(
      citationOf({ source: 'b.xlsx', heading: 'Sheet 1: Sales', text: '| # | Region |\n| --- | --- |\n| 4 | North |\n| 5 | South |' }),
      'b.xlsx · sheet Sales · rows 4–5'
    );
    assert.equal(citationOf({ source: 'a.md', heading: 'Setup', lineStart: 2, lineEnd: 2, text: 'x' }), 'a.md · Setup · line 2');
    assert.equal(citationOf({ source: 'app.ts', lineStart: 12, lineEnd: 30, text: 'x' }), 'app.ts · lines 12–30');
  });

  it('numbers context and never exceeds the budget', () => {
    const chunks = Array.from({ length: 10 }, (_, i) => ({ source: `f${i}.md`, text: 'x'.repeat(500) }));
    const { context, included } = buildContext(chunks, { maxChars: 1500, maxChunkChars: 400 });
    assert.ok(context.length <= 1500, `context was ${context.length}`);
    assert.ok(context.startsWith('[1] f0.md\n'));
    assert.ok(included >= 2 && included < 10);
    assert.ok(!context.includes(`[${included + 1}]`));
  });
});
