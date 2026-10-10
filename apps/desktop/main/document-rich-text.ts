/** Markdown semantics for editable Word output, using the same parser as chat. */
import { lexer, Lexer, type Token, type Tokens } from 'marked';
import * as docx from 'docx';

const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos|#39|#\d+|#x[\da-f]+);/gi, (entity) => {
  const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
  if (named[entity]) return named[entity];
  const code = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
});

export function wordInline(value: string | Token[], style: docx.IRunOptions = {}): Array<docx.TextRun | docx.ExternalHyperlink> {
  style = { font: 'Inter', ...style };
  const tokens = typeof value === 'string' ? Lexer.lexInline(value) : value;
  return tokens.flatMap((token): Array<docx.TextRun | docx.ExternalHyperlink> => {
    if (token.type === 'strong') return wordInline((token as Tokens.Strong).tokens, { ...style, bold: true });
    if (token.type === 'em') return wordInline((token as Tokens.Em).tokens, { ...style, italics: true });
    if (token.type === 'del') return wordInline((token as Tokens.Del).tokens, { ...style, strike: true });
    if (token.type === 'link') {
      const link = token as Tokens.Link;
      const children = wordInline(link.tokens, style);
      return /^(https?:|mailto:)/i.test(link.href)
        ? [new docx.ExternalHyperlink({ link: decode(link.href), children })] : children;
    }
    if (token.type === 'br') return [new docx.TextRun({ ...style, break: 1 })];
    if (token.type === 'codespan') return [new docx.TextRun({ ...style, text: decode((token as Tokens.Codespan).text), font: 'IBM Plex Mono' })];
    const child = token as Tokens.Text;
    if (child.tokens) return wordInline(child.tokens, style);
    return [new docx.TextRun({ ...style, text: decode('text' in token ? String(token.text) : token.raw) })];
  });
}

export function wordTable(headers: string[], rows: string[][]): docx.Table {
  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    borders: { ...docx.TableBorders.NONE, insideHorizontal: { style: docx.BorderStyle.SINGLE, size: 4, color: 'D1D5DB' }, bottom: { style: docx.BorderStyle.SINGLE, size: 4, color: 'D1D5DB' } },
    rows: [headers, ...rows].map((cells, index) => new docx.TableRow({
      tableHeader: index === 0, cantSplit: true,
      children: headers.map((_header, col) => new docx.TableCell({
        shading: index === 0 ? { fill: 'F3F4F6' } : undefined,
        margins: { top: 100, bottom: 100, left: 120, right: 120 },
        children: [new docx.Paragraph({ children: wordInline(cells[col] || '', { bold: index === 0, size: 20 }), spacing: { after: 40 } })],
      })),
    })),
  });
}

export function createWordMarkdown() {
  const numbering: docx.INumberingOptions['config'] = [];
  let serial = 0;
  const paragraph = (tokens: Token[] | string, options: docx.IParagraphOptions = {}) =>
    new docx.Paragraph({ children: wordInline(tokens), spacing: { after: 140, line: 276 }, ...options });
  function blocks(tokens: Token[], depth = 0): Array<docx.Paragraph | docx.Table> {
    return tokens.flatMap((token): Array<docx.Paragraph | docx.Table> => {
      if (token.type === 'space') return [];
      if (token.type === 'heading') {
        const heading = token as Tokens.Heading;
        const levels = [docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_2, docx.HeadingLevel.HEADING_3, docx.HeadingLevel.HEADING_4, docx.HeadingLevel.HEADING_5, docx.HeadingLevel.HEADING_6];
        return [paragraph(heading.tokens, { heading: levels[Math.min(5, heading.depth - 1)], keepNext: true, spacing: { before: 240, after: 120 } })];
      }
      if (token.type === 'blockquote') {
        return (token as Tokens.Blockquote).text.split(/\n{2,}/).map((text) => new docx.Paragraph({
          children: wordInline(text, { italics: true }), indent: { left: 280 }, spacing: { after: 140 },
          border: { left: { color: '9CA3AF', space: 8, style: docx.BorderStyle.SINGLE, size: 6 } },
        }));
      }
      if (token.type === 'list') {
        const list = token as Tokens.List, reference = `document-list-${serial++}`, level = Math.min(8, depth);
        if (list.ordered) numbering.push({ reference, levels: Array.from({ length: 9 }, (_, i) => ({
          level: i, format: docx.LevelFormat.DECIMAL, text: `%${i + 1}.`, start: Number(list.start) || 1,
          alignment: docx.AlignmentType.LEFT, style: { paragraph: { indent: { left: (i + 1) * 360, hanging: 240 } } },
        })) });
        return list.items.flatMap((item) => {
          let first = true;
          return item.tokens.flatMap((child): Array<docx.Paragraph | docx.Table> => {
            if (child.type === 'list') return blocks([child], depth + 1);
            if (child.type === 'space') return [];
            const content = 'tokens' in child && Array.isArray(child.tokens) ? child.tokens : 'text' in child ? String(child.text) : child.raw;
            const prefix = item.task ? `${item.checked ? '☑' : '☐'} ` : '';
            const children = [...(prefix ? [new docx.TextRun(prefix)] : []), ...wordInline(content)];
            const result = new docx.Paragraph({ children, spacing: { after: 80 },
              ...(first ? list.ordered ? { numbering: { reference, level } } : { bullet: { level } } : { indent: { left: (level + 1) * 360 } }) });
            first = false; return [result];
          });
        });
      }
      if (token.type === 'code') return (token as Tokens.Code).text.split('\n').map((line) => new docx.Paragraph({
        children: [new docx.TextRun({ text: line || ' ', font: 'IBM Plex Mono', size: 19 })],
        shading: { fill: 'F3F4F6' }, spacing: { after: 0, line: 260 },
      }));
      if (token.type === 'table') {
        const table = token as Tokens.Table;
        return [wordTable(table.header.map((cell) => cell.text), table.rows.map((row) => row.map((cell) => cell.text)))];
      }
      if (token.type === 'hr') return [new docx.Paragraph({ border: { bottom: { color: 'D1D5DB', space: 6, style: docx.BorderStyle.SINGLE, size: 4 } } })];
      if ('tokens' in token && Array.isArray(token.tokens)) return [paragraph(token.tokens)];
      return [paragraph('text' in token ? String(token.text) : token.raw)];
    });
  }
  return { render: (markdown: string) => blocks(lexer(markdown)), numbering };
}
