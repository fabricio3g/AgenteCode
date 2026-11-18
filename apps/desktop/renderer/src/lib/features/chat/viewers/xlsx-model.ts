// A workbook turned into what a spreadsheet grid needs to draw it the way
// Excel does: sizes, styles, formatted values, merges and frozen panes.
// Pure (no DOM), so it is unit tested without a browser.

export type CellAlign = 'left' | 'center' | 'right';

export interface GridCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  fill?: string;
  align?: CellAlign;
  valign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  fontSize?: number;
  borderBottom?: boolean;
}

export interface GridCell {
  /** What the cell shows, number format applied. */
  text: string;
  /** What the formula bar shows: the formula, or the raw value. */
  input: string;
  /** Numeric value, for the status bar's sum and average. */
  number?: number;
  style: GridCellStyle;
  /** Top-left cell of a merge: how far it spans. */
  span?: { rows: number; cols: number };
  /** Covered by another cell's merge; not drawn. */
  covered?: boolean;
}

export interface GridSheet {
  name: string;
  rows: number;
  cols: number;
  /** Pixel widths per column (index 0 = column A). */
  colWidths: number[];
  /** Pixel heights per row (index 0 = row 1). */
  rowHeights: number[];
  frozenRows: number;
  frozenCols: number;
  cells: GridCell[][];
  /** Rows beyond the display cap that were left out. */
  truncatedRows: number;
}

const MAX_ROWS = 2000;
const MAX_COLS = 80;
const DEFAULT_COL_PX = 72;
const DEFAULT_ROW_PX = 22;

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** "B3" → { row: 2, col: 1 } (zero-based). */
export function parseAddress(address: string): { row: number; col: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(address.trim());
  if (!match) return null;
  let col = 0;
  for (const char of match[1].toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

function argbToCss(argb: unknown): string | undefined {
  if (typeof argb !== 'string' || !/^[0-9a-f]{6,8}$/i.test(argb)) return undefined;
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  return `#${hex.toLowerCase()}`;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

function formatDate(date: Date, format: string, locale: string): string {
  const f = format.toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
  const hasDate = /[dy]/.test(f) || /m{3,}/.test(f);
  const hasTime = /h/.test(f);
  if (!hasDate && !hasTime) return date.toLocaleDateString(locale);
  if (/^y{2,4}-m{1,2}-d{1,2}/.test(f)) {
    const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    return hasTime ? `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : day;
  }
  const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC' };
  if (hasDate) Object.assign(options, { year: 'numeric', month: /m{3,}/.test(f) ? 'short' : '2-digit', day: '2-digit' });
  if (hasTime) Object.assign(options, { hour: '2-digit', minute: '2-digit' });
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * Applies the common Excel number formats: fixed decimals, thousands
 * separators, percentages, currency symbols and dates. Anything exotic falls
 * back to the plain number.
 */
export function formatValue(value: unknown, numFmt: string | undefined, locale = 'en'): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDate(value, numFmt || 'yyyy-mm-dd', locale);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'number') return String(value);
  const format = (numFmt || 'General').split(';')[0];
  if (!format || format === 'General' || format === '@') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)));
  }
  // A number cell with a date format is a serial date.
  if (/[dy]/i.test(format.replace(/"[^"]*"/g, '')) || /h+:m+/i.test(format)) {
    return formatDate(new Date(EXCEL_EPOCH + value * 86_400_000), format, locale);
  }
  const percent = format.includes('%');
  const decimals = (/\.(0+)/.exec(format)?.[1].length) ?? 0;
  const grouping = format.includes(',');
  const currency = /[$€£¥]/.exec(format)?.[0] ?? '';
  const scaled = percent ? value * 100 : value;
  const body = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping
  }).format(Math.abs(scaled));
  const sign = scaled < 0 ? '-' : '';
  const symbolFirst = currency && format.indexOf(currency) < format.search(/[0#]/);
  return `${sign}${symbolFirst ? currency : ''}${body}${percent ? '%' : ''}${!symbolFirst && currency ? ` ${currency}` : ''}`;
}

// ExcelJS is typed loosely here on purpose: only the handful of fields read
// below are relied on, and they have been stable across ExcelJS versions.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyCell = any;
type AnySheet = any;

function cellValue(cell: AnyCell): { value: unknown; formula?: string } {
  const raw = cell?.value;
  if (raw && typeof raw === 'object' && !(raw instanceof Date)) {
    if ('formula' in raw || 'sharedFormula' in raw) return { value: raw.result, formula: `=${raw.formula ?? raw.sharedFormula}` };
    if ('richText' in raw) return { value: raw.richText.map((part: { text: string }) => part.text).join('') };
    if ('text' in raw) return { value: raw.text };
    if ('error' in raw) return { value: raw.error };
  }
  return { value: raw };
}

function cellStyle(cell: AnyCell, isNumber: boolean): GridCellStyle {
  const font = cell?.font || {};
  const alignment = cell?.alignment || {};
  const fill = cell?.fill;
  const horizontal = alignment.horizontal;
  const align: CellAlign | undefined =
    horizontal === 'center' || horizontal === 'centerContinuous' ? 'center'
      : horizontal === 'right' ? 'right'
        : horizontal === 'left' ? 'left'
          : isNumber ? 'right' : undefined;
  const vertical = alignment.vertical;
  return {
    ...(font.bold ? { bold: true } : {}),
    ...(font.italic ? { italic: true } : {}),
    ...(font.underline ? { underline: true } : {}),
    ...(font.strike ? { strike: true } : {}),
    ...(argbToCss(font.color?.argb) ? { color: argbToCss(font.color?.argb) } : {}),
    ...(fill?.type === 'pattern' && fill.pattern !== 'none' && argbToCss(fill.fgColor?.argb) ? { fill: argbToCss(fill.fgColor?.argb) } : {}),
    ...(align ? { align } : {}),
    ...(vertical === 'middle' || vertical === 'top' ? { valign: vertical } : {}),
    ...(alignment.wrapText ? { wrap: true } : {}),
    ...(typeof font.size === 'number' && font.size !== 11 ? { fontSize: font.size } : {}),
    ...(cell?.border?.bottom?.style ? { borderBottom: true } : {})
  };
}

/**
 * One ExcelJS worksheet → a drawable grid. `minRows`/`minCols` pad it with
 * empty cells so the gridlines run past the data, the way Excel looks.
 */
export function sheetToGrid(
  sheet: AnySheet,
  locale = 'en',
  pad: { minRows?: number; minCols?: number } = {},
  /** Computes a formula whose result the file didn't store (row/col zero-based). */
  resolve?: (formula: string, row: number, col: number) => unknown
): GridSheet {
  const totalRows = Math.max(sheet.rowCount || 0, sheet.actualRowCount || 0, 1);
  const rows = Math.min(Math.max(totalRows, pad.minRows ?? 0), MAX_ROWS);
  const cols = Math.min(Math.max(sheet.columnCount || 0, pad.minCols ?? 0, 1), MAX_COLS);

  const colWidths = Array.from({ length: cols }, (_, index) => {
    const width = sheet.getColumn?.(index + 1)?.width;
    return typeof width === 'number' ? Math.round(width * 7 + 10) : DEFAULT_COL_PX;
  });
  const rowHeights = Array.from({ length: rows }, (_, index) => {
    const height = sheet.getRow?.(index + 1)?.height;
    return typeof height === 'number' ? Math.round((height * 4) / 3) : DEFAULT_ROW_PX;
  });

  const cells: GridCell[][] = Array.from({ length: rows }, (_, r) => {
    const row = sheet.getRow?.(r + 1);
    return Array.from({ length: cols }, (_, c) => {
      const cell = row?.getCell?.(c + 1);
      const read = cellValue(cell);
      const formula = read.formula;
      const value = formula && read.value === undefined && resolve ? resolve(formula, r, c) : read.value;
      const number = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      const text = formatValue(value, cell?.numFmt, locale);
      const input = formula ?? (value instanceof Date ? text : value === null || value === undefined ? '' : String(value));
      return { text, input, ...(number !== undefined ? { number } : {}), style: cellStyle(cell, number !== undefined || value instanceof Date) };
    });
  });

  const merges: string[] = Array.isArray(sheet.model?.merges) ? sheet.model.merges : [];
  for (const range of merges) {
    const [from, to] = range.split(':');
    const start = parseAddress(from || '');
    const end = parseAddress(to || '');
    if (!start || !end || start.row >= rows || start.col >= cols) continue;
    const lastRow = Math.min(end.row, rows - 1);
    const lastCol = Math.min(end.col, cols - 1);
    for (let r = start.row; r <= lastRow; r += 1) {
      for (let c = start.col; c <= lastCol; c += 1) {
        if (r === start.row && c === start.col) continue;
        cells[r][c].covered = true;
      }
    }
    cells[start.row][start.col].span = { rows: lastRow - start.row + 1, cols: lastCol - start.col + 1 };
  }

  spillText(cells, colWidths);

  const view = Array.isArray(sheet.views) ? sheet.views.find((v: { state?: string }) => v?.state === 'frozen') : null;
  return {
    name: String(sheet.name || 'Sheet'),
    rows,
    cols,
    colWidths,
    rowHeights,
    frozenRows: Math.min(Number(view?.ySplit) || 0, rows),
    frozenCols: Math.min(Number(view?.xSplit) || 0, cols),
    cells,
    truncatedRows: Math.max(0, totalRows - rows)
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Like Excel, left-aligned text that doesn't fit runs on into the empty cells
 * to its right (numbers never do). Modeled as a one-row span over those cells.
 */
function spillText(cells: GridCell[][], colWidths: number[]) {
  for (const row of cells) {
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (cell.covered || cell.span || cell.number !== undefined || !cell.text || cell.style.wrap) continue;
      if (cell.style.align && cell.style.align !== 'left') continue;
      const needed = cell.text.length * 7.2 * ((cell.style.fontSize ?? 11) / 11) + 8;
      let width = colWidths[c];
      let extra = 0;
      while (width < needed && c + extra + 1 < row.length) {
        const next = row[c + extra + 1];
        if (next.text || next.covered || next.span || next.style.fill) break;
        extra += 1;
        width += colWidths[c + extra];
      }
      if (!extra) continue;
      cell.span = { rows: 1, cols: extra + 1 };
      for (let k = 1; k <= extra; k += 1) row[c + k].covered = true;
      c += extra;
    }
  }
}

/** Sum, average and count of the numbers in a selection. */
export function summarize(values: GridCell[]): { count: number; numbers: number; sum: number; average: number } {
  const filled = values.filter((cell) => cell.text !== '');
  const numbers = filled.map((cell) => cell.number).filter((value): value is number => value !== undefined);
  const sum = numbers.reduce((total, value) => total + value, 0);
  return { count: filled.length, numbers: numbers.length, sum, average: numbers.length ? sum / numbers.length : 0 };
}

/** A rectangular selection as tab-separated text, the way Excel copies. */
export function selectionToTsv(sheet: GridSheet, top: number, left: number, bottom: number, right: number): string {
  const lines: string[] = [];
  for (let r = top; r <= bottom; r += 1) {
    const line: string[] = [];
    for (let c = left; c <= right; c += 1) line.push(sheet.cells[r]?.[c]?.text ?? '');
    lines.push(line.join('\t'));
  }
  return lines.join('\n');
}

/**
 * What a formula evaluator needs to read a worksheet cell: its value, or
 * `{ formula }` when the file stored a formula without its result.
 */
export function rawCell(sheet: AnySheet, row: number, col: number): unknown {
  const cell = sheet?.getRow?.(row + 1)?.getCell?.(col + 1);
  const { value, formula } = cellValue(cell);
  if (formula && value === undefined) return { formula };
  return value;
}
