import { normalizeReportDocument, reportSections, reportEndmatter } from '../shared/report-document.ts';
import { createWordMarkdown, wordInline, wordTable } from './document-rich-text.ts';
import {
  escapeHtml,
  tableData,
  text,
  type SectionInput,
  type SheetInput
} from '../shared/work-product.ts';
import { ARTIFACT_BRAND } from '../shared/artifact-theme.ts';
import { artifactDocumentHtml } from '../shared/artifact-theme.ts';
import { marked, Renderer } from 'marked';

function bufferToBytes(buffer: Buffer | Uint8Array | ArrayBuffer): number[] {
  return Array.from(buffer instanceof Buffer ? buffer : Buffer.from(buffer));
}

export async function generateDocx(data: Record<string, unknown>) {
  const docx = await import('docx') as any;
  const report = normalizeReportDocument(data);
  const { title, subtitle, author, date } = report;
  const sections = reportSections(report, true, false);
  const markdown = createWordMarkdown();
  const children: any[] = [
    new docx.Paragraph({
      text: title,
      heading: docx.HeadingLevel.TITLE,
      spacing: { after: 220 }
    }),
    ...(subtitle ? [new docx.Paragraph({
      children: [new docx.TextRun({ text: subtitle, italics: true, color: '475569', size: 26 })],
      spacing: { after: 180 }
    })] : []),
    new docx.Paragraph({
      children: [new docx.TextRun({ text: `${author} · ${date}`, color: '64748B', size: 18 })],
      spacing: { after: 360 }
    }),
  ];

  function addSection(section: SectionInput) {
    const heading = section.title || section.heading;
    if (heading) {
      children.push(new docx.Paragraph({
        text: heading,
        heading: docx.HeadingLevel.HEADING_1,
        keepNext: true, spacing: { before: 240, after: 120 }
      }));
    }
    if (section.content) children.push(...markdown.render(section.content));
    for (const bullet of section.bullets || []) {
      children.push(new docx.Paragraph({ children: wordInline(bullet), bullet: { level: 0 }, spacing: { after: 80 } }));
    }
    if (section.citations?.length) {
      children.push(new docx.Paragraph({
        children: [new docx.TextRun({ text: `Sources: ${section.citations.join(', ')}`, italics: true, color: '64748B', size: 18 })],
        spacing: { after: 100 }
      }));
    }
  }

  for (const section of sections) addSection(section);

  for (const table of report.tables || []) {
    const { headers, rows } = tableData(table);
    if (!headers.length) continue;
    children.push(new docx.Paragraph({ text: text(table.title || table.name, 'Table'), heading: docx.HeadingLevel.HEADING_1 }));
    if (table.description) children.push(new docx.Paragraph({ text: table.description }));
    children.push(wordTable(headers, rows));
  }

  for (const section of reportEndmatter(report)) addSection(section);

  const document = new docx.Document({
    creator: author,
    title,
    numbering: { config: markdown.numbering },
    styles: {
      default: {
        document: { run: { font: 'Inter', size: 22 }, paragraph: { spacing: { line: 276 } } },
        title: { run: { font: 'Inter', size: 40, bold: true, color: '1F2937' } },
        heading1: { run: { font: 'Inter', size: 28, bold: true, color: '1F2937' }, paragraph: { keepNext: true } },
        heading2: { run: { font: 'Inter', size: 25, bold: true, color: '1F2937' }, paragraph: { keepNext: true } },
        heading3: { run: { font: 'Inter', size: 23, bold: true, color: '1F2937' } },
        heading4: { run: { font: 'Inter', size: 22, bold: true, color: '1F2937' } },
        heading5: { run: { font: 'Inter', size: 22, bold: true, color: '1F2937' } },
        heading6: { run: { font: 'Inter', size: 22, bold: true, color: '1F2937' } },
      }
    },
    sections: [{
      properties: {
        page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } }
      },
      footers: {
        default: new docx.Footer({
          children: [new docx.Paragraph({
            alignment: docx.AlignmentType.RIGHT,
            children: [
              new docx.TextRun({ children: [docx.PageNumber.CURRENT, ' / ', docx.PageNumber.TOTAL_PAGES], color: '64748B', size: 18 })
            ]
          })]
        })
      },
      children
    }]
  });
  const buffer = await docx.Packer.toBuffer(document);
  return {
    bytes: bufferToBytes(buffer),
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };
}

/** Excel sheet names must be unique and ≤ 31 chars. */
export function uniqueWorksheetName(raw: string, used: Set<string>): string {
  let base = text(raw, 'Sheet').slice(0, 31) || 'Sheet';
  // Excel also forbids colons and leading/trailing apostrophes.
  base = base.replace(/[\\/:?*[\]\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').slice(0, 31) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = (base.slice(0, Math.max(1, 31 - suffix.length)) + suffix).slice(0, 31);
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function generateXlsx(data: Record<string, unknown>) {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = ARTIFACT_BRAND;
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const sheets = Array.isArray(data.sheets) ? data.sheets as SheetInput[] : [];
  const normalizedSheets = sheets.length ? sheets : [{
    name: text(data.title, 'Sheet 1'),
    columns: Array.isArray(data.columns) ? data.columns as SheetInput['columns'] : undefined,
    rows: Array.isArray(data.rows) ? data.rows as SheetInput['rows'] : []
  }];

  const usedSheetNames = new Set<string>();
  for (const rawSheet of normalizedSheets) {
    const sheetName = uniqueWorksheetName(String(rawSheet.name || 'Sheet'), usedSheetNames);
    const worksheet = workbook.addWorksheet(sheetName, { properties: { defaultRowHeight: 20 }, pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const rows = Array.isArray(rawSheet.rows) ? rawSheet.rows : [];
    let columns = Array.isArray(rawSheet.columns) ? rawSheet.columns : [];

    if (!columns.length) {
      columns = [...new Set(rows.flatMap((row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : []))];
    }

    if (columns.length) {
      worksheet.columns = columns.map((column) => {
        if (typeof column === 'string') {
          return { header: column, key: column, width: Math.max(12, Math.min(36, column.length + 4)) };
        }
        const header = text(column?.header || column?.key, 'Column');
        const key = text(column?.key || column?.header, header);
        return { header, key, width: Number(column?.width) || Math.max(12, Math.min(36, header.length + 4)) };
      });
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
      worksheet.getRow(1).height = 22;
      worksheet.views = [{ state: 'frozen', ySplit: 1 }];
      worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(1, rows.length + 1), column: columns.length }
      };
    }

    for (const row of rows) {
      worksheet.addRow(row as any);
    }

    worksheet.eachRow((row, rowIndex) => {
      row.eachCell((cell) => {
        cell.font = { ...cell.font, name: 'Inter', size: 11 };
        const numeric = typeof cell.value === 'number' || (cell.value && typeof cell.value === 'object' && 'result' in cell.value && typeof cell.value.result === 'number');
        cell.alignment = { vertical: 'top', wrapText: true, horizontal: numeric ? 'right' : 'left' };
        if (cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd';
        const format = typeof columns[cell.col - 1] === 'object' ? (columns[cell.col - 1] as { numFmt?: string }).numFmt : undefined;
        if (rowIndex > 1 && format) cell.numFmt = format;
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E7EB' } } };

      });
    });

    if (columns.length) worksheet.pageSetup.printTitlesRow = '1:1';
    worksheet.headerFooter.oddFooter = '&L' + ARTIFACT_BRAND + '&RPage &P of &N';
    worksheet.columns?.forEach((column: any, index: number) => {
      const supplied = columns[index];
      if (typeof supplied === 'object' && supplied?.width) return;
      let max = Number(column.width) || 12;
      column.eachCell?.({ includeEmpty: true }, (cell: any) => {
        max = Math.max(max, Math.min(48, String(cell.text || cell.value || '').length + 3));
      });
      column.width = max;
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    bytes: bufferToBytes(buffer),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

/** A real print layout for every PDF path, including direct IPC calls. */
export async function generatePdf(data: Record<string, unknown>) {
  const report = normalizeReportDocument(data);
  const renderer = new Renderer();
  renderer.html = (token) => escapeHtml(token.text);
  renderer.link = function (token) {
    const label = this.parser.parseInline(token.tokens);
    return /^(https?:|mailto:)/i.test(token.href) ? `<a href="${escapeHtml(token.href)}">${label}</a>` : label;
  };
  const markdown = (value: string) => marked.parse(value, { renderer, async: false }) as string;
  const renderSection = (section: SectionInput) =>
    `<section>${section.title || section.heading ? `<h2>${escapeHtml(section.title || section.heading)}</h2>` : ''}${section.content ? markdown(section.content) : ''}${section.bullets?.length ? `<ul>${section.bullets.map((bullet) => `<li>${markdown(bullet)}</li>`).join('')}</ul>` : ''}${section.citations?.length ? `<p class="citations">${section.citations.map(escapeHtml).join(' · ')}</p>` : ''}</section>`
  ;
  const body = reportSections(report, true, false).map(renderSection).join('') + (report.tables || []).map((table) => {
    const { headers, rows } = tableData(table);
    return `<section><h2>${escapeHtml(table.title || table.name || 'Table')}</h2><table><thead><tr>${headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`;
  }).join('') + reportEndmatter(report).map(renderSection).join('');
  const html = text(data.html) || artifactDocumentHtml({ title: report.title, subtitle: report.subtitle, meta: [report.author, report.date].filter(Boolean).join(' · '), body });
  const { createArtifactWindow, loadArtifactHtml, withArtifactTimeout } = await import('./artifact-preview.ts');
  const win = createArtifactWindow();
  try {
    const buffer = await withArtifactTimeout((async () => {
      await loadArtifactHtml(win, html);
      return win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true });
    })());
    return { bytes: bufferToBytes(buffer), mime: 'application/pdf' };
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
