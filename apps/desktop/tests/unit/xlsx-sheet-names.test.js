import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { uniqueWorksheetName } from '../../main/generated-documents.ts';

describe('uniqueWorksheetName', () => {
  it('dedupes Sources sheets without exceeding Excel 31-char limit', () => {
    const used = new Set();
    assert.equal(uniqueWorksheetName('Sources', used), 'Sources');
    assert.equal(uniqueWorksheetName('Sources', used), 'Sources (2)');
    assert.equal(uniqueWorksheetName('Sources', used), 'Sources (3)');
    assert.ok([...used].every((n) => n.length <= 31));
  });

  it('sanitizes illegal Excel characters', () => {
    const used = new Set();
    const name = uniqueWorksheetName('Foo/Bar*Baz', used);
    assert.equal(name.includes('/'), false);
    assert.equal(name.includes('*'), false);
  });
});
