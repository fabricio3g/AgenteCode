import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateGeneratedDocumentArgs } from '../../renderer/src/lib/services/generated-documents.ts';

describe('generated document validation', () => {
  it('rejects title-only report sections', () => {
    const result = validateGeneratedDocumentArgs({
      title: 'Market report',
      sections: [{ title: 'Executive summary' }, { title: 'Findings' }]
    }, ['docx']);

    assert.equal(result.ok, false);
    assert.match(result.error || '', /too thin/i);
  });

  it('accepts meaningful narrative sections', () => {
    const result = validateGeneratedDocumentArgs({
      title: 'Market report',
      sections: [{
        title: 'Findings',
        content: 'The gathered sources show several relevant market signals, including pricing pressure, customer demand changes, and operational constraints that should be tracked before making a final recommendation.'
      }]
    }, ['pdf']);

    assert.equal(result.ok, true);
  });

  it('accepts spreadsheets with data rows', () => {
    const result = validateGeneratedDocumentArgs({
      title: 'Research workbook',
      columns: ['Source', 'Finding'],
      rows: [{ Source: 'Example', Finding: 'Evidence-backed row' }]
    }, ['xlsx']);

    assert.equal(result.ok, true);
  });

  it('rejects empty presentations', () => {
    const result = validateGeneratedDocumentArgs({
      title: 'Deck',
      slides: [{ title: 'Only a title', content: [] }]
    }, ['pptx']);

    assert.equal(result.ok, false);
  });
});
