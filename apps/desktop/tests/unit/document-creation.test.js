import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { generateDocx, generateXlsx } from '../../main/generated-documents.ts';
import { normalizeDeck } from '../../shared/deck.ts';

test('Word preserves semantic Markdown, links, code, numbering and report metadata', async () => {
  const result = await generateDocx({ title: 'Métricas', executiveSummary: 'Revenue rose by **12.5%** this quarter.',
    metrics: [{ label: 'Units', value: 250 }],
    sections: [{ title: 'Findings', content: '## Detail\n\nA **bold** and *italic* finding with `code`.\n\n1. First\n2. Second\n\n[Evidence](https://example.com/source)\n\n> A quoted conclusion.\n\n```sql\nSELECT 42;\n```' }],
    sources: [{ title: 'financials.xlsx', snippet: 'Revenue is 42' }], limitations: ['Forecast unavailable'] });
  const zip = await JSZip.loadAsync(Uint8Array.from(result.bytes));
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(!xml.includes('**bold**'));
  assert.match(xml, /<w:b\/>/); assert.match(xml, /<w:i\/>/); assert.match(xml, /<w:numPr>/);
  assert.match(xml, /IBM Plex Mono/); assert.match(xml, /Executive summary/); assert.match(xml, /Units: 250/);
  assert.match(xml, /financials.xlsx/); assert.match(xml, /Forecast unavailable/);
  const links = await zip.file('word/_rels/document.xml.rels').async('string');
  assert.match(links, /https:\/\/example.com\/source/);
  assert.match(await zip.file('word/footer1.xml').async('string'), /NUMPAGES/);
});

test('Excel preserves late columns, numeric/date/formula values and chosen formats', async () => {
  const generated = await generateXlsx({ sheets: [
    { name: 'Inference', rows: [{ a: 1 }, { b: 2 }] },
    { name: 'Financials', columns: [{ key: 'usd', header: 'USD', width: 22, numFmt: '$#,##0.00' }, 'date', 'total'],
      rows: [{ usd: 12.5, date: new Date('2026-10-09T00:00:00Z'), total: { formula: '5+7.5', result: 12.5 } }] },
  ] });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Uint8Array.from(generated.bytes));
  assert.equal(workbook.worksheets[0].getCell('B3').value, 2);
  const sheet = workbook.worksheets[1];
  assert.equal(sheet.getCell('A2').value, 12.5); assert.equal(sheet.getCell('A2').numFmt, '$#,##0.00');
  assert.equal(sheet.getColumn(1).width, 22); assert.ok(sheet.getCell('B2').value instanceof Date);
  assert.equal(sheet.getCell('C2').value.result, 12.5);
  assert.equal(sheet.pageSetup.printTitlesRow, '1:1');
});

test('presentation pagination preserves every row and metric, with column keys intact', () => {
  const deck = normalizeDeck({ title: 'Data', slides: [
    { title: 'Table', table: { columns: [{ key: 'usd', header: 'USD' }], rows: Array.from({ length: 27 }, (_, i) => ({ usd: i })) } },
    { title: 'Figures', stats: Array.from({ length: 9 }, (_, i) => ({ value: i, label: `Metric ${i}` })) },
  ] });
  assert.deepEqual(deck.slides.filter((slide) => slide.table).flatMap((slide) => slide.table.rows), Array.from({ length: 27 }, (_, i) => [String(i)]));
  assert.equal(deck.slides.filter((slide) => slide.stats).flatMap((slide) => slide.stats).length, 9);
  assert.throws(() => normalizeDeck({ slides: [{ title: 'Invalid', chart: { labels: ['A', 'B'], series: [{ values: [1, NaN] }] } }] }), /finite number/);
});
