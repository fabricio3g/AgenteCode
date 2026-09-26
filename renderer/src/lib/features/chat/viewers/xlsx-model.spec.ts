import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { columnName, formatValue, parseAddress, selectionToTsv, sheetToGrid, summarize } from './xlsx-model';

describe('columnName / parseAddress', () => {
  it('names columns like Excel', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(parseAddress('AB12')).toEqual({ row: 11, col: 27 });
  });
});

describe('formatValue', () => {
  it('applies common number formats', () => {
    expect(formatValue(1234.5, '#,##0.00')).toBe('1,234.50');
    expect(formatValue(0.256, '0.0%')).toBe('25.6%');
    expect(formatValue(-42, '$#,##0')).toBe('-$42');
    expect(formatValue(45000, 'yyyy-mm-dd')).toBe('2023-03-15');
    expect(formatValue(3, 'General')).toBe('3');
    expect(formatValue(true, undefined)).toBe('TRUE');
  });
});

describe('sheetToGrid', () => {
  it('keeps styles, merges, widths, frozen panes and formulas', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Budget', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [{ width: 20 }, { width: 12 }];
    sheet.addRow(['Item', 'Cost']);
    sheet.addRow(['Rent', 1200]);
    sheet.addRow(['Total', { formula: 'SUM(B2:B2)', result: 1200 }]);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FF112233' } };
    sheet.getCell('B2').numFmt = '#,##0';
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
    sheet.mergeCells('A4:B4');

    const grid = sheetToGrid(sheet);
    expect(grid.name).toBe('Budget');
    expect(grid.frozenRows).toBe(1);
    expect(grid.colWidths[0]).toBe(150);
    expect(grid.cells[0][0].style).toMatchObject({ bold: true, color: '#112233', fill: '#eeeeee' });
    expect(grid.cells[1][1]).toMatchObject({ text: '1,200', number: 1200, style: { align: 'right' } });
    expect(grid.cells[2][1]).toMatchObject({ text: '1200', input: '=SUM(B2:B2)' });
    expect(grid.cells[3][0].span).toEqual({ rows: 1, cols: 2 });
    expect(grid.cells[3][1].covered).toBe(true);
  });
});

describe('summarize / selectionToTsv', () => {
  it('sums numbers and copies as TSV', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('S');
    sheet.addRow(['a', 1]);
    sheet.addRow(['b', 3]);
    const grid = sheetToGrid(sheet);
    const stats = summarize([grid.cells[0][0], grid.cells[0][1], grid.cells[1][1]]);
    expect(stats).toEqual({ count: 3, numbers: 2, sum: 4, average: 2 });
    expect(selectionToTsv(grid, 0, 0, 1, 1)).toBe('a\t1\nb\t3');
  });
});

describe('sheetToGrid formulas without results', () => {
  it('computes them through the resolver', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('S');
    sheet.addRow([2, 3, { formula: 'A1*B1' }]);
    const grid = sheetToGrid(sheet, 'en', {}, (formula) => (formula === '=A1*B1' ? 6 : null));
    expect(grid.cells[0][2]).toMatchObject({ text: '6', input: '=A1*B1', number: 6 });
  });
});

describe('text spill', () => {
  it('lets long text run into empty neighbors, like Excel', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('S');
    sheet.addRow(['A very long note that does not fit in one column', null, null, 'x']);
    sheet.addRow([12345678901234567890, null]);
    const grid = sheetToGrid(sheet);
    expect(grid.cells[0][0].span?.cols).toBe(3);
    expect(grid.cells[0][1].covered).toBe(true);
    expect(grid.cells[1][0].span).toBeUndefined();
  });
});
