import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { convertFileToMarkdown, looksBinary } from '../../main/document-markdown.ts';

let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-md-'));

  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sales');
  sheet.addRow(['Region', 'Q1']);
  sheet.addRow(['North', 100]);
  await workbook.xlsx.writeFile(path.join(dir, 'book.xlsx'));

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

  it('renders each spreadsheet sheet as a titled markdown table', async () => {
    const { markdown, fileType } = await convertFileToMarkdown(path.join(dir, 'book.xlsx'));

    assert.equal(fileType, 'xlsx');
    assert.match(markdown, /^## Sales/m);
    assert.match(markdown, /\| Region \| Q1 \|/);
    assert.match(markdown, /\| North \| 100 \|/);
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
