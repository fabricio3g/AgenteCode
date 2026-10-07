import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { convertFileToMarkdown, looksBinary } from '../../main/document-markdown.ts';
import { chunkMarkdown } from '../../main/rag/chunking.ts';
import { citationOf } from '../../main/rag/ranking.ts';

let dir;

/**
 * Smallest PDF pdf.js will read: catalog, page tree, one font, one content
 * stream per page. Built by hand because nothing in the dependency set writes
 * PDFs and the page headings need a real multi-page file to prove themselves.
 */
function buildPdf(pageTexts) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  for (const [i, text] of pageTexts.entries()) {
    const stream = `BT /F1 14 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-md-'));

  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sales');
  sheet.addRow(['Region', 'Q1']);
  sheet.addRow(['North', 100]);
  sheet.addRow(['South', 80]);
  await workbook.xlsx.writeFile(path.join(dir, 'book.xlsx'));

  const PptxGenJS = (await import('pptxgenjs')).default;
  const deck = new PptxGenJS();
  deck.addSlide().addText('Roadmap', { x: 0.5, y: 0.5, w: 4, h: 1 });
  deck.addSlide().addText('Costs', { x: 0.5, y: 0.5, w: 4, h: 1 });
  await deck.writeFile({ fileName: path.join(dir, 'deck.pptx') });

  fs.writeFileSync(path.join(dir, 'twopage.pdf'), buildPdf([
    'Quarterly revenue rose twelve percent across the northern region while costs stayed flat.',
    'The southern region grew more slowly and shipped fewer units than the plan assumed.'
  ]));

  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell } =
    await import('docx');
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'Project Report', heading: HeadingLevel.HEADING_1 }),
        new Paragraph('Intro paragraph text.'),
        new Table({
          rows: [
            new TableRow({ children: [
              new TableCell({ children: [new Paragraph('Name')] }),
              new TableCell({ children: [new Paragraph('Value')] })
            ] }),
            new TableRow({ children: [
              new TableCell({ children: [new Paragraph('Alpha')] }),
              new TableCell({ children: [new Paragraph('42')] })
            ] })
          ]
        })
      ]
    }]
  });
  fs.writeFileSync(path.join(dir, 'report.docx'), await Packer.toBuffer(doc));

  fs.writeFileSync(path.join(dir, 'page.html'),
    '<html><body><h1>Title</h1><p>Hello world</p><ul><li>one</li></ul></body></html>');
  fs.writeFileSync(path.join(dir, 'data.csv'), 'name,qty\n"Widget, large",3\nBolt,10\n');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x: number = 1;\n');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 3]));
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nbody\n');
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('document → markdown conversion', () => {
  it('refuses binary files instead of indexing decoded garbage', async () => {
    // The previous ingestion path read any unknown extension as UTF-8, so a
    // spreadsheet or slide deck landed in RAG as replacement characters.
    assert.equal(looksBinary(Buffer.from([0x00, 0x41, 0x42])), true);
    assert.equal(looksBinary(Buffer.from('plain text here', 'utf8')), false);

    await assert.rejects(
      () => convertFileToMarkdown(path.join(dir, 'blob.bin')),
      /Unsupported file type/
    );
  });

  it('keeps DOCX headings, prose and tables', async () => {
    const { markdown, fileType } = await convertFileToMarkdown(path.join(dir, 'report.docx'));

    assert.equal(fileType, 'docx');
    assert.match(markdown, /^# Project Report/m);
    assert.match(markdown, /Intro paragraph text/);
    // mammoth's own convertToMarkdown flattens tables into loose paragraphs;
    // routing through HTML is what preserves the row structure.
    assert.match(markdown, /\| Name \| Value \|/);
    assert.match(markdown, /\| Alpha \| 42 \|/);
  });

  it('renders each spreadsheet sheet with its row numbers', async () => {
    const { markdown, fileType } = await convertFileToMarkdown(path.join(dir, 'book.xlsx'));

    assert.equal(fileType, 'xlsx');
    // The sheet name alone gives a reader nowhere to look; the `#` column and the
    // `Sheet N:` marker are what let a chunk be cited as `sheet Sales · rows 2–3`.
    assert.match(markdown, /^## Sheet 1: Sales/m);
    assert.match(markdown, /\| # \| Region \| Q1 \|/);
    assert.match(markdown, /\| 2 \| North \| 100 \|/);
    assert.match(markdown, /\| 3 \| South \| 80 \|/);
  });

  it('marks every page of a PDF', async () => {
    const { markdown, fileType, warning } = await convertFileToMarkdown(path.join(dir, 'twopage.pdf'));

    assert.equal(fileType, 'pdf');
    assert.equal(warning, undefined);
    // pdf-parse 1.1.x separates pages with a blank line, so without a marker in
    // `pagerender` both pages merged and neither was citable.
    assert.match(markdown, /^## Page 1$/m);
    assert.match(markdown, /^## Page 2$/m);
    assert.match(markdown, /northern region/);
    assert.match(markdown, /southern region/);
  });

  it('titles each slide with its number', async () => {
    const { markdown, fileType } = await convertFileToMarkdown(path.join(dir, 'deck.pptx'));

    assert.equal(fileType, 'pptx');
    assert.match(markdown, /^## Slide 1: Roadmap$/m);
    assert.match(markdown, /^## Slide 2: Costs$/m);
  });

  it('cites the page, slide and sheet each chunk came from', async () => {
    const pdf = await convertFileToMarkdown(path.join(dir, 'twopage.pdf'));
    const pages = chunkMarkdown(pdf.markdown, { size: 400 });
    assert.deepEqual(pages.map((chunk) => chunk.heading), ['Page 1', 'Page 2']);
    assert.equal(citationOf({ ...pages[1], source: 'twopage.pdf' }), 'twopage.pdf · page 2');

    const deck = await convertFileToMarkdown(path.join(dir, 'deck.pptx'));
    const slides = chunkMarkdown(deck.markdown, { size: 400 });
    assert.deepEqual(slides.map((chunk) => chunk.heading), ['Slide 1: Roadmap', 'Slide 2: Costs']);
    assert.equal(citationOf({ ...slides[1], source: 'deck.pptx' }), 'deck.pptx · slide 2: Costs');

    const book = await convertFileToMarkdown(path.join(dir, 'book.xlsx'));
    const sheets = chunkMarkdown(book.markdown, { size: 400 });
    assert.deepEqual(sheets.map((chunk) => chunk.heading), ['Sheet 1: Sales']);
    assert.equal(citationOf({ ...sheets[0], source: 'book.xlsx' }), 'book.xlsx · sheet Sales · rows 2–3');
  });

  it('converts HTML block structure', async () => {
    const { markdown } = await convertFileToMarkdown(path.join(dir, 'page.html'));

    assert.match(markdown, /^# Title/m);
    assert.match(markdown, /Hello world/);
    assert.match(markdown, /^- one/m);
  });

  it('parses quoted CSV fields without splitting on the comma inside them', async () => {
    const { markdown } = await convertFileToMarkdown(path.join(dir, 'data.csv'));

    assert.match(markdown, /\| name \| qty \|/);
    assert.match(markdown, /\| Widget, large \| 3 \|/);
  });

  it('fences source files with their language', async () => {
    const { markdown, fileType } = await convertFileToMarkdown(path.join(dir, 'app.ts'));

    assert.equal(fileType, 'code');
    assert.match(markdown, /^```typescript/m);
  });

  it('passes markdown through untouched', async () => {
    const { markdown, fileType } = await convertFileToMarkdown(path.join(dir, 'notes.md'));

    assert.equal(fileType, 'markdown');
    assert.match(markdown, /^# Notes/m);
  });
});
