import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { generateDocx, generateXlsx } from '../../main/generated-documents.ts';
import { tableData } from '../../shared/work-product.ts';

test('table inference preserves columns introduced by later rows', () => {
  assert.deepEqual(tableData({ rows: [{ a: 1 }, { b: 2 }] }), {
    headers: ['a', 'b'], rows: [['1', ''], ['', '2']]
  });
});

test('DOCX export contains real tables with ordered, escaped cells', async () => {
  const generated = await generateDocx({ title: 'Results', tables: [{ name: 'Revenue', columns: ['region', 'total'], rows: [{ total: 42, region: '<Europe>' }] }] });
  const zip = await JSZip.loadAsync(Uint8Array.from(generated.bytes));
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /&lt;Europe&gt;/);
  assert.match(xml, />42</);
  assert.ok(xml.indexOf('&lt;Europe&gt;') < xml.indexOf('>42<'));
});

test('XLSX export accepts sanitized, duplicate sheet names', async () => {
  const generated = await generateXlsx({ sheets: [
    { name: "'Revenue:2026'", rows: [[42]] },
    { name: 'Revenue:2026', rows: [[43]] }
  ] });
  const zip = await JSZip.loadAsync(Uint8Array.from(generated.bytes));
  const xml = await zip.file('xl/workbook.xml').async('string');
  assert.match(xml, /name="Revenue 2026"/);
  assert.match(xml, /name="Revenue 2026 \(2\)"/);
});
