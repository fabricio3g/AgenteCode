/**
 * Retrieval scoring: BM25 over chunk text, blended with vector similarity when
 * there is one, then a maximal-marginal-relevance pass so the top results are
 * not five near-copies of the same paragraph, then a context string that fits
 * a hard character budget and labels every chunk with a citation.
 */

import { anchorOf, rowRangeOf } from './chunking.ts';

/** Unicode-aware: `[a-z0-9]` used to drop every accented or non-Latin word. */
export function tokenize(text: string): string[] {
  return String(text || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) || [];
}

export class Bm25 {
  private readonly docs: Map<string, number>[];
  private readonly lengths: number[];
  private readonly avgLength: number;
  private readonly df = new Map<string, number>();

  constructor(texts: string[], private readonly k1 = 1.2, private readonly b = 0.75) {
    this.docs = texts.map((text) => {
      const counts = new Map<string, number>();
      for (const token of tokenize(text)) counts.set(token, (counts.get(token) || 0) + 1);
      for (const token of counts.keys()) this.df.set(token, (this.df.get(token) || 0) + 1);
      return counts;
    });
    this.lengths = this.docs.map((counts) => [...counts.values()].reduce((sum, n) => sum + n, 0));
    this.avgLength = this.lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, this.lengths.length) || 1;
  }

  /** One score per indexed text, in input order. */
  scores(query: string): number[] {
    const terms = [...new Set(tokenize(query))];
    const n = this.docs.length;
    return this.docs.map((counts, i) => {
      let score = 0;
      for (const term of terms) {
        const tf = counts.get(term);
        if (!tf) continue;
        const df = this.df.get(term) || 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * this.lengths[i] / this.avgLength));
      }
      return score;
    });
  }
}

export type Candidate<T> = {
  item: T;
  docId: string;
  text: string;
  keyword: number;
  /** Cosine similarity in [0, 1] when vector search ran, else null. */
  vector: number | null;
  score: number;
};

/**
 * Blend keyword and vector evidence. BM25 is unbounded, so it is normalized
 * against the best keyword hit of this query first.
 */
export function blendScores<T>(candidates: Candidate<T>[], vectorWeight = 0.65): void {
  const maxKeyword = Math.max(0, ...candidates.map((c) => c.keyword));
  for (const candidate of candidates) {
    const keyword = maxKeyword > 0 ? candidate.keyword / maxKeyword : 0;
    candidate.score = candidate.vector == null
      ? keyword
      : (1 - vectorWeight) * keyword + vectorWeight * candidate.vector;
  }
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Maximal marginal relevance over token overlap: each pick trades relevance
 * against similarity to what is already picked. Also caps chunks per document
 * so one long file cannot crowd out the rest.
 */
export function selectDiverse<T>(ranked: Candidate<T>[], k: number, { lambda = 0.75, perDoc = 3 } = {}): Candidate<T>[] {
  const pool = ranked.filter((c) => c.score > 0).slice(0, Math.max(k * 4, 20));
  const tokens = new Map(pool.map((c) => [c, new Set(tokenize(c.text))]));
  const maxScore = Math.max(0, ...pool.map((c) => c.score)) || 1;
  const perDocCount = new Map<string, number>();
  const picked: Candidate<T>[] = [];

  while (picked.length < k && pool.length) {
    let bestIndex = -1;
    let bestValue = -Infinity;
    pool.forEach((candidate, index) => {
      if ((perDocCount.get(candidate.docId) || 0) >= perDoc) return;
      const redundancy = Math.max(0, ...picked.map((p) => jaccard(tokens.get(candidate)!, tokens.get(p)!)));
      const value = lambda * (candidate.score / maxScore) - (1 - lambda) * redundancy;
      if (value > bestValue) { bestValue = value; bestIndex = index; }
    });
    if (bestIndex < 0) break;
    const [chosen] = pool.splice(bestIndex, 1);
    perDocCount.set(chosen.docId, (perDocCount.get(chosen.docId) || 0) + 1);
    picked.push(chosen);
  }
  return picked;
}

export type CitedChunk = {
  source: string;
  heading?: string;
  lineStart?: number;
  lineEnd?: number;
  text: string;
  warning?: string;
};

/**
 * `report.pdf · page 3`, `deck.pptx · slide 2: Roadmap`, `book.xlsx · sheet Sales · rows 4–9`,
 * `notes.md · Setup › Install · lines 12–30`. A locator the converter stamped —
 * page, slide, sheet — replaces the Markdown line range, which means nothing
 * inside a PDF or a slide deck and would send the reader to the wrong place.
 */
export function citationOf(chunk: CitedChunk): string {
  const parts = [chunk.source || 'Document'];
  const anchor = anchorOf(chunk.heading || '');

  if (anchor?.kind === 'page') parts.push(`page ${anchor.index}`);
  else if (anchor?.kind === 'slide') parts.push(`slide ${anchor.index}${anchor.title ? `: ${anchor.title}` : ''}`);
  else if (anchor?.kind === 'sheet') {
    parts.push(`sheet ${anchor.title || anchor.index}`);
    const rows = rowRangeOf(chunk.text);
    if (rows) parts.push(rows.first === rows.last ? `row ${rows.first}` : `rows ${rows.first}–${rows.last}`);
  } else {
    if (chunk.heading) parts.push(chunk.heading);
    if (chunk.lineStart) {
      parts.push(chunk.lineEnd && chunk.lineEnd !== chunk.lineStart
        ? `lines ${chunk.lineStart}–${chunk.lineEnd}`
        : `line ${chunk.lineStart}`);
    }
  }
  return parts.join(' · ');
}

/**
 * Numbered context that never exceeds `maxChars`: chunks go in by rank, each
 * clipped to `maxChunkChars`; the first that would overflow is clipped to the
 * remaining room (if any is worth keeping) and nothing after it is added.
 */
export function buildContext(chunks: CitedChunk[], { maxChars = 120_000, maxChunkChars = 4_000 } = {}): { context: string; included: number } {
  const separator = '\n\n---\n\n';
  const sections: string[] = [];
  let used = 0;

  for (let i = 0; i < chunks.length; i++) {
    const header = `[${i + 1}] ${citationOf(chunks[i])}\n${chunks[i].warning ? `Reading limitation: ${chunks[i].warning.slice(0, 800)}\n` : ''}`;
    const room = maxChars - used - (sections.length ? separator.length : 0) - header.length;
    if (room < 200) break;
    const limit = Math.min(maxChunkChars, room);
    const body = chunks[i].text.length > limit ? `${chunks[i].text.slice(0, limit - 1)}…` : chunks[i].text;
    sections.push(header + body);
    used += (sections.length > 1 ? separator.length : 0) + header.length + body.length;
    if (body.length < chunks[i].text.length && limit === room) break;
  }
  return { context: sections.join(separator), included: sections.length };
}
