import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { convertFileToMarkdown } from '../../main/document-markdown.ts';
import { extractIngestionText } from '../../main/document-ingestion.ts';
import { rtfToText } from '../../main/document-formats.ts';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-formats-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
async function zipped(name, entries) {
  const zip = new JSZip();
  for (const [key, value] of Object.entries(entries)) zip.file(key, value);
  const filename = path.join(dir, name);
  fs.writeFileSync(filename, await zip.generateAsync({ type: 'nodebuffer' }));
  return filename;
}

describe('extended document formats', () => {
  it('reads ODT headings and actual table structure', async () => {
    const filename = await zipped('report.odt', { 'content.xml': '<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="b"><office:body><office:text><text:h text:outline-level="1">Report</text:h><text:p>Revenue <text:span>rose</text:span> this quarter.</text:p><table:table><table:table-row><table:table-cell><text:p>Region</text:p></table:table-cell><table:table-cell><text:p>Total</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>North</text:p></table:table-cell><table:table-cell office:value="42"/></table:table-row></table:table></office:text></office:body></office:document-content>' });
    const result = await convertFileToMarkdown(filename);
    assert.equal(result.fileType, 'odt');
    assert.match(result.markdown, /^# Report/m);
    assert.match(result.markdown, /Revenue rose this quarter/);
    assert.match(result.markdown, /\| North \| 42 \|/);
  });

  it('reads ODS sheets and repeated populated rows', async () => {
    const filename = await zipped('sales.ods', { 'content.xml': '<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="b"><office:body><office:spreadsheet><table:table table:name="Sales"><table:table-row><table:table-cell><text:p>Region</text:p></table:table-cell><table:table-cell><text:p>Total</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="2"><table:table-cell><text:p>North</text:p></table:table-cell><table:table-cell office:value="42"/></table:table-row><table:table-row table:number-rows-repeated="10000"><table:table-cell/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>' });
    const result = await convertFileToMarkdown(filename);
    assert.match(result.markdown, /## Sheet 1: Sales/);
    assert.equal(result.markdown.match(/North/g).length, 2);
    assert.ok(result.markdown.length < 200, 'empty repeated sheet space is not allocated');
  });

  it('reads ODP slide boundaries', async () => {
    const filename = await zipped('deck.odp', { 'content.xml': '<office:document-content xmlns:office="o" xmlns:text="t" xmlns:draw="d"><office:body><office:presentation><draw:page draw:name="Costs"><text:p>Costs 42</text:p></draw:page><draw:page draw:name="Risks"><text:p>Supply delays</text:p></draw:page></office:presentation></office:body></office:document-content>' });
    assert.match((await convertFileToMarkdown(filename)).markdown, /## Slide 2: Risks\n\nSupply delays/);
  });

  it('keeps PowerPoint tables available to the canonical document reader', async () => {
    const filename = await zipped('table.pptx', { 'ppt/slides/slide1.xml': '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Sales</a:t><a:tbl><a:tr><a:tc><a:t>Region</a:t></a:tc><a:tc><a:t>Total</a:t></a:tc></a:tr><a:tr><a:tc><a:t>North</a:t></a:tc><a:tc><a:t>42</a:t></a:tc></a:tr></a:tbl></p:sld>' });
    const { markdown } = await convertFileToMarkdown(filename);
    assert.match(markdown, /\| Region \| Total \|/);
    assert.match(markdown, /\| North \| 42 \|/);
    assert.equal(markdown.match(/North/g).length, 1);
  });

  it('reads EPUB chapters in spine order and strips scripts', async () => {
    const filename = await zipped('book.epub', {
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
      'OPS/book.opf': '<package><manifest><item id="a" href="a.xhtml"/><item id="z" href="z.xhtml"/></manifest><spine><itemref idref="z"/><itemref idref="a"/></spine></package>',
      'OPS/a.xhtml': '<html><body><h1>Second</h1><p>Costs 42</p></body></html>',
      'OPS/z.xhtml': '<html><body><h1>First</h1><p>Revenue 100</p><script>never read me</script></body></html>',
    });
    const result = await convertFileToMarkdown(filename);
    assert.equal(result.fileType, 'epub');
    assert.ok(result.markdown.indexOf('First') < result.markdown.indexOf('Second'));
    assert.ok(!result.markdown.includes('never read me'));
  });

  it('reads RTF text and Unicode without leaking formatting or binary pictures', () => {
    assert.equal(rtfToText(String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}Hello \b world\b0\par Caf\'e9 \u8212? done{\pict hidden-bytes}}`), 'Hello world\nCafé — done');
    assert.throws(() => rtfToText('ordinary text'), /valid RTF/);
  });

  it('reads UTF-16 CSV exports and rejects undecodable unknown binary', async () => {
    const csv = path.join(dir, 'unicode.csv');
    fs.writeFileSync(csv, Buffer.concat([Buffer.from([255, 254]), Buffer.from('Region,Total\nNorte,42', 'utf16le')]));
    assert.match((await convertFileToMarkdown(csv)).markdown, /\| Norte \| 42 \|/);
    const binary = path.join(dir, 'undecodable.unknown');
    fs.writeFileSync(binary, Buffer.from([255, 254, 253, 252]));
    // A BOM signals valid UTF-16; use invalid UTF-8 without a BOM here.
    fs.writeFileSync(binary, Buffer.from([255, 253, 252]));
    await assert.rejects(convertFileToMarkdown(binary), /Unsupported file type/);
  });

  it('keeps Excel rich text, dates, cached formula results, and uncached formula warnings', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Sales');
    sheet.addRow(['Label', 'Date', 'Total', 'Missing']);
    sheet.addRow([{ richText: [{ text: 'North' }, { text: ' region' }] }, new Date('2026-01-02T00:00:00Z'), { formula: '21*2', result: 42 }, { formula: '7*6' }]);
    const filename = path.join(dir, 'types.xlsx');
    await book.xlsx.writeFile(filename);
    const { markdown } = await convertFileToMarkdown(filename);
    assert.match(markdown, /North region/);
    assert.match(markdown, /2026-01-02/);
    assert.match(markdown, /42/);
    assert.match(markdown, /=7\*6 \[result not stored\]/);
  });

  it('does not silently drop mixed HTML text and preserves real links', async () => {
    const filename = path.join(dir, 'mixed.html');
    fs.writeFileSync(filename, '<body><div>Hello <strong>world</strong> tail</div><p>Read <a href="https://example.com/source">source</a>.</p><script>ignore</script></body>');
    const { markdown } = await convertFileToMarkdown(filename);
    assert.match(markdown, /Hello world tail/);
    assert.match(markdown, /\[source\]\(https:\/\/example.com\/source\)/);
    assert.ok(!markdown.includes('ignore'));
  });

  it('rejects empty native and supplied text instead of indexing it', async () => {
    const filename = path.join(dir, 'empty.txt');
    fs.writeFileSync(filename, '   ');
    await assert.rejects(extractIngestionText(filename), /No readable content/);
    await assert.rejects(extractIngestionText(filename, { extracted_text: ' ', extraction_method: 'ocr' }), /No readable content/);
    await assert.rejects(extractIngestionText(filename, { extracted_text: 'words' }), /extraction_method/);
  });

  it('gives an actionable legacy Office error', async () => {
    const filename = path.join(dir, 'old.xls'); fs.writeFileSync(filename, Buffer.of(0));
    await assert.rejects(convertFileToMarkdown(filename), /export as .xlsx/);
  });
});
