import { describe, expect, it } from 'vitest';
import type { SearchResult } from '$lib/types/bridge';
import { renumberEvidence } from './deep-research.svelte';

const result = (url: string, title: string) => ({ url, title, snippet: '' } as unknown as SearchResult);
const block = (n: string, title: string, url: string) => `## [${n}] ${title}\n\nURL: ${url}\n\ntext about ${title}`;

describe('deep research evidence numbering', () => {
  it('gives each source the id it has in the merged source index', () => {
    const alpha = result('https://alpha.test/', 'Alpha');
    const beta = result('https://beta.test/', 'Beta');
    const merged = [alpha, beta];
    const used = new Set<number>();
    const first = renumberEvidence(block('1', 'Alpha', alpha.url), [alpha], merged, 24, used);
    const second = renumberEvidence(block('1', 'Beta', beta.url), [beta], merged, 24, used);
    expect(first).toContain('## [1] Alpha');
    expect(second).toContain('## [2] Beta');
    expect(second).not.toContain('## [1]');
  });

  it('keeps one block for a URL found under different ranks and maps crawler ids', () => {
    const alpha = result('https://alpha.test/', 'Alpha');
    const gamma = result('https://gamma.test/', 'Gamma');
    const merged = [alpha, gamma];
    const used = new Set<number>();
    renumberEvidence(block('1', 'Alpha', alpha.url), [alpha], merged, 24, used);
    const again = renumberEvidence(
      [block('1', 'Gamma', gamma.url), block('2', 'Alpha', alpha.url)].join('\n\n---\n\n'),
      [gamma, alpha], merged, 24, used,
    );
    expect(again).toContain('## [2] Gamma');
    expect(again).not.toContain('Alpha');
    const crawl = renumberEvidence(block('C1', 'Gamma', gamma.url), [gamma], merged, 24, new Set());
    expect(crawl).toContain('## [2] Gamma');
  });
});
