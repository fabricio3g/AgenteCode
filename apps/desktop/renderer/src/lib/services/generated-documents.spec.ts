import { describe, expect, it, vi } from 'vitest';
import { createWorkProductArtifactFiles, validateGeneratedDocumentArgs, reportToSlides } from './generated-documents';
import { normalizeReportDocument } from '$shared/report-document';
import { invoke } from './bridge';

vi.mock('./bridge', () => ({ invoke: vi.fn(async (command: string) => command === 'generate_pptx' ? [80, 75] : { bytes: [80, 75], mime: '' }) }));

describe('generated document validation', () => {
  it('retains late sections, decimal values, tables and appendix in slide conversion', () => {
    const report = normalizeReportDocument({ title: 'Annual report',
      sections: Array.from({ length: 14 }, (_, i) => ({ title: `Section ${i}`, content: `Revenue grew 12.5% in section ${i}.` })),
      tables: [{ name: 'Ledger', columns: ['USD'], rows: [[12.5]] }], appendix: [{ title: 'Appendix', content: 'Final evidence.' }] });
    const slides = reportToSlides(report);
    expect(JSON.stringify(slides)).toContain('12.5%'); expect(JSON.stringify(slides)).toContain('Section 13');
    expect(slides).toContainEqual(expect.objectContaining({ title: 'Ledger', layout: 'table' }));
    expect(slides).toContainEqual(expect.objectContaining({ title: 'Appendix' }));
  });
  it('reports when a workbook contains only a narrative summary', async () => {
    const output = await createWorkProductArtifactFiles({ title: 'Summary', executiveSummary: 'A useful narrative summary without any extracted data rows. It describes the available evidence and the scope of this document clearly.', formats: ['xlsx'] });
    expect(output.warnings).toHaveLength(1);
  });
  it('preserves raw spreadsheet rows and slides through multi-format dispatch', async () => {
    await createWorkProductArtifactFiles({ title: 'Data', formats: ['xlsx'], columns: ['amount'], rows: [[42]] });
    expect(invoke).toHaveBeenCalledWith('generate_xlsx', { data: expect.objectContaining({ sheets: expect.arrayContaining([expect.objectContaining({ columns: ['amount'], rows: [[42]] })]) }) });
    await createWorkProductArtifactFiles({ title: 'Deck', formats: ['pptx'], slides: [{ title: 'Results', content: ['These findings contain meaningful evidence.'] }] });
    expect(invoke).toHaveBeenCalledWith('generate_pptx', { data: expect.objectContaining({ slides: [expect.objectContaining({ title: 'Results', content: ['These findings contain meaningful evidence.'] })] }) });
  });
  it('preserves table cells and ordering in Markdown and HTML exports', async () => {
    const result = await createWorkProductArtifactFiles({
      title: 'Results', formats: ['md', 'html'],
      tables: [{ name: 'Revenue', columns: [{ key: 'region', header: 'Region' }, 'total'], rows: [{ total: 42, region: '<Europe> | West' }] }]
    });
    expect(result.files.map((file) => file.path)).toEqual(['Results.md', 'Results.html']);
    expect(result.markdown).toContain('| Region | total |');
    expect(result.markdown).toContain('| <Europe> \\| West | 42 |');
    expect(result.html).toContain('<td>&lt;Europe&gt; | West</td><td>42</td>');
  });

  it('rejects unsupported formats instead of succeeding with no files', async () => {
    await expect(createWorkProductArtifactFiles({ title: 'Report', formats: ['odt'] })).rejects.toThrow(/Unsupported document format/);
  });
  it('rejects title-only report sections', () => {
    const result = validateGeneratedDocumentArgs({
      title: 'Market report',
      sections: [{ title: 'Executive summary' }, { title: 'Findings' }]
    }, ['docx']);

    expect(result.ok).toBe(false);
    expect(result.error || '').toMatch(/too thin/i);
  });

  it('accepts meaningful narrative sections', () => {
    const result = validateGeneratedDocumentArgs({
      title: 'Market report',
      sections: [{
        title: 'Findings',
        content: 'The gathered sources show several relevant market signals, including pricing pressure, customer demand changes, and operational constraints that should be tracked before making a final recommendation.'
      }]
    }, ['pdf']);

    expect(result.ok).toBe(true);
  });

  it('accepts spreadsheets with data rows', () => {
    const result = validateGeneratedDocumentArgs({
      title: 'Research workbook',
      columns: ['Source', 'Finding'],
      rows: [{ Source: 'Example', Finding: 'Evidence-backed row' }]
    }, ['xlsx']);

    expect(result.ok).toBe(true);
  });

  it('rejects empty presentations', () => {
    const result = validateGeneratedDocumentArgs({
      title: 'Deck',
      slides: [{ title: 'Only a title', content: [] }]
    }, ['pptx']);

    expect(result.ok).toBe(false);
  });
});
