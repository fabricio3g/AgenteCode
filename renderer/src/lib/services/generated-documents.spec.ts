import { describe, expect, it } from 'vitest';
import { validateGeneratedDocumentArgs } from './generated-documents';

describe('generated document validation', () => {
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
