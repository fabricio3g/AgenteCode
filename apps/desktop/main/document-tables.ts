/** Deterministic Markdown table formatting shared by document readers. */
export function escapeTableCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * `options.rowNumbers` prepends a `#` column holding each row's own number — the
 * coordinate a reader of a spreadsheet actually uses, and what lets a retrieved
 * chunk be cited as `sheet Sales · rows 4–9`.
 */
export function toMarkdownTable(rows: unknown[][], options: { rowNumbers?: number[] } = {}): string {
  const numbers = options.rowNumbers;
  const cleaned = rows
    .map((cells, index) => ({ cells, number: numbers?.[index] }))
    .filter((entry) => entry.cells.some((cell) => String(cell ?? '').trim() !== ''));
  if (!cleaned.length) return '';

  const width = cleaned.reduce((max, entry) => Math.max(max, entry.cells.length), 0) + (numbers ? 1 : 0);
  const pad = (cells: string[]) => {
    const padded = [...cells];
    while (padded.length < width) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };
  const body = (entry: { cells: unknown[]; number?: number }) => pad([
    ...(numbers ? [String(entry.number ?? '')] : []),
    ...entry.cells.map(escapeTableCell)
  ]);

  const [header, ...rest] = cleaned;
  return [
    pad([...(numbers ? ['#'] : []), ...header.cells.map(escapeTableCell)]),
    pad(Array.from({ length: width }, () => '---')),
    ...rest.map(body)
  ].join('\n');
}

