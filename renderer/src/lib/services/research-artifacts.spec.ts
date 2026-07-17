import { describe, expect, it } from 'vitest';
import type { SearchResult } from '$lib/types/tauri';
import {
  buildApaReferences,
  buildBibTeX,
  buildEvidenceMatrixCsv,
  buildResearchCitations,
  buildResearchExportFiles,
  buildRis,
  buildSourceShortlistMarkdown,
  parseExportKinds,
  suggestedExportKinds
} from '$lib/services/research-artifacts';

const sources: SearchResult[] = [
  {
    title: 'Clinical practice guideline for example disease',
    url: 'https://www.nih.gov/example-guideline',
    snippet: 'First-line therapy is selected by severity and comorbidities. Monitoring is required.',
    full_content:
      'First-line therapy is selected by severity and comorbidities. Monitoring is required for adverse effects.',
    published_at: '2023-04-12',
    metadata: { site_name: 'NIH', author: 'National Institutes of Health' }
  },
  {
    title: 'News overview of treatments',
    url: 'https://www.reuters.com/example',
    snippet: 'Experts say staged care improves outcomes.',
    metadata: { quality: 'snippet' }
  }
];

describe('research-artifacts', () => {
  it('builds citations without inventing missing years for weak sources', () => {
    const citations = buildResearchCitations(sources);
    expect(citations).toHaveLength(2);
    expect(citations[0].year).toBe('2023');
    expect(citations[0].author).toContain('National Institutes of Health');
    expect(citations[0].type).toBe('government');
    expect(citations[1].year).toBe('n.d.');
    expect(citations[1].type).toBe('news');
  });

  it('builds APA, BibTeX, and RIS exports', () => {
    const citations = buildResearchCitations(sources);
    const apa = buildApaReferences(citations);
    expect(apa).toContain('References');
    expect(apa).toContain('2023');
    expect(apa).toContain('https://www.nih.gov/example-guideline');

    const bib = buildBibTeX(citations);
    expect(bib).toContain('@misc{');
    expect(bib).toContain('title = {');

    const ris = buildRis(citations);
    expect(ris).toContain('TY  - ELEC');
    expect(ris).toContain('TI  - Clinical practice guideline');
    expect(ris).toContain('ER  -');
  });

  it('builds shortlist and matrix files', () => {
    const citations = buildResearchCitations(sources);
    const shortlist = buildSourceShortlistMarkdown(citations, { query: 'example disease' });
    expect(shortlist).toContain('# Source shortlist');
    expect(shortlist).toContain('First-line therapy');

    const csv = buildEvidenceMatrixCsv(citations);
    expect(csv.split('\n')[0]).toContain('ID,Title');
    expect(csv).toContain('https://www.reuters.com/example');
  });

  it('buildResearchExportFiles respects kinds', () => {
    const files = buildResearchExportFiles({
      sources,
      kinds: ['citations', 'matrix', 'shortlist'],
      title: 'Example Disease',
      query: 'example disease treatment'
    });
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith('.bib'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.ris'))).toBe(true);
    expect(paths.some((p) => p.includes('apa'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.csv'))).toBe(true);
    expect(paths.some((p) => p.includes('shortlist'))).toBe(true);
  });

  it('suggests kinds by search mode', () => {
    expect(suggestedExportKinds('search')).toEqual(['shortlist', 'citations']);
    expect(suggestedExportKinds('deep')).toContain('matrix');
    expect(suggestedExportKinds('max')).toContain('protocol');
  });

  it('parseExportKinds filters unknown values', () => {
    expect(parseExportKinds(['citations', 'faq', 'matrix'])).toEqual(['citations', 'matrix']);
    expect(parseExportKinds('shortlist,bibliography')).toEqual(['shortlist', 'bibliography']);
  });
});
