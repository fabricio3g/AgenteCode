import { describe, expect, it, vi } from 'vitest';
import { extractPdfContent } from './pdf-ingestion';
import { parseIngestedDocument, selectUnits } from './agent-doc-reader';

describe('mixed PDF ingestion', () => {
  it('uses OCR only on scanned pages and keeps real page numbers', async () => {
    const recognizePage = vi.fn(async () => 'Scanned second page total 42');
    const result = await extractPdfContent({ pages: 3, readPage: async (page) => page === 2 ? '' : `Digital page ${page}`, recognizePage });
    expect(recognizePage).toHaveBeenCalledExactlyOnceWith(2);
    expect(result.method).toBe('ocr');
    const parsed = parseIngestedDocument(result.text, 'pdf');
    expect(parsed.units.map((unit) => unit.label)).toEqual(['page 1', 'page 2', 'page 3']);
    expect(parsed.units[selectUnits(parsed.units, '2')[0]].text).toContain('total 42');
  });

  it('accepts a short digital page without unnecessary OCR', async () => {
    const recognizePage = vi.fn(async () => 'unused');
    expect((await extractPdfContent({ pages: 1, readPage: async () => 'Invoice 42', recognizePage })).method).toBe('parser');
    expect(recognizePage).not.toHaveBeenCalled();
  });

  it('records unreadable pages without renumbering or declaring an empty scan ready', async () => {
    const result = await extractPdfContent({ pages: 3, readPage: async (page) => page === 2 ? '' : 'text', recognizePage: async () => '' });
    expect(result.warning).toContain('page 2');
    expect(result.text).toContain('## Page 3');
    await expect(extractPdfContent({ pages: 2, readPage: async () => '', recognizePage: async () => '' })).rejects.toThrow('No readable text');
  });

  it('does not hide OCR engine failures as missing text', async () => {
    await expect(extractPdfContent({ pages: 2, readPage: async (page) => page === 1 ? 'Digital' : '',
      recognizePage: async () => { throw new Error('Worker unavailable'); } })).rejects.toThrow('Worker unavailable');
  });
});

describe('canonical document reader', () => {
  it('keeps positioned PDF columns available as tables', () => {
    const doc = parseIngestedDocument('## Page 1\n\nRegion\tUSD\nNorth\t42\nSouth\t58', 'pdf');
    expect(doc.units[0].tables).toEqual([[['Region', 'USD'], ['North', '42'], ['South', '58']]]);
  });
  it('preserves sheet selection and tables, including escaped pipes', () => {
    const doc = parseIngestedDocument('## Sheet 1: Sales\n\n| # | Item | Total |\n| --- | --- | --- |\n| 2 | A\\|B | 42 |\n\n## Sheet 2: Costs\n\n| Item | Cost |\n| --- | --- |\n| Paper | 10 |', 'xlsx');
    expect(doc.units.map((unit) => unit.label)).toEqual(['Sales', 'Costs']);
    expect(selectUnits(doc.units, 'Costs')).toEqual([1]);
    expect(doc.units[0].tables[0][1]).toEqual(['2', 'A|B', '42']);
  });

  it('does not treat fenced pipe text as a table', () => {
    const doc = parseIngestedDocument('```\n| command | value |\n| --- | --- |\n| a | b |\n```', 'text');
    expect(doc.units[0].tables).toEqual([]);
  });
});
