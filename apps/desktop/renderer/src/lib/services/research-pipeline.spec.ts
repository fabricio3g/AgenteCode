import { describe, expect, it } from 'vitest';
import {
  hasEnoughResearchEvidence,
  isResearchProductPath,
  resolveResearchMode,
  shouldForceResearchSynthesis,
  researchThinSourcesNotice
} from '$lib/services/research-pipeline';

describe('research-pipeline', () => {
  it('treats search / deep / max and search_chat as research product paths', () => {
    expect(isResearchProductPath({ toolMode: 'search_chat', searchMode: 'chat' })).toBe(true);
    expect(isResearchProductPath({ searchMode: 'search' })).toBe(true);
    expect(isResearchProductPath({ searchMode: 'deep' })).toBe(true);
    expect(isResearchProductPath({ searchMode: 'max' })).toBe(true);
    expect(isResearchProductPath({ isCodeProfile: true, searchMode: 'deep' })).toBe(false);
    expect(isResearchProductPath({ toolMode: 'agent', searchMode: 'chat' })).toBe(false);
  });

  it('resolves research modes', () => {
    expect(resolveResearchMode('max')).toBe('max');
    expect(resolveResearchMode('search')).toBe('search');
    expect(resolveResearchMode('deep')).toBe('deep');
    expect(resolveResearchMode(undefined)).toBe('search');
  });

  it('detects enough evidence for synthesis', () => {
    const sources = [
      { title: 'A', url: 'https://a.test', snippet: 'x'.repeat(130) },
      { title: 'B', url: 'https://b.test', snippet: 'y'.repeat(130) },
      { title: 'C', url: 'https://c.test', snippet: 'short' },
      { title: 'D', url: 'https://d.test', snippet: 'short' }
    ];
    expect(hasEnoughResearchEvidence('search', sources)).toBe(true);
    expect(hasEnoughResearchEvidence('search', sources.slice(0, 1))).toBe(false);
  });

  it('forces synthesis after a successful search with enough sources', () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      title: `S${i}`,
      url: `https://s${i}.test`,
      snippet: 'body '.repeat(40)
    }));
    expect(shouldForceResearchSynthesis({
      mode: 'search',
      sources,
      observations: [{ name: 'web_search', args: {}, success: true, summary: 'ok' }]
    })).toBe(true);
  });

  it('uses soft thin-source notices without step-limit language', () => {
    expect(researchThinSourcesNotice(0, 0)).toMatch(/No live sources/i);
    expect(researchThinSourcesNotice(5, 0)).toMatch(/could not be fully read/i);
    expect(researchThinSourcesNotice(5, 0)).not.toMatch(/step limit/i);
    expect(researchThinSourcesNotice(8, 4)).toBeUndefined();
  });
});
