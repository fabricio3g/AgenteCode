import { describe, expect, it } from 'vitest';
import { createFormulaEvaluator, type CellInput } from './xlsx-formula';

function workbook(cells: Record<string, CellInput>) {
  return createFormulaEvaluator((sheet, row, col) => cells[`${sheet}!${String.fromCharCode(65 + col)}${row + 1}`]);
}

describe('createFormulaEvaluator', () => {
  const book = workbook({
    'P&L!A1': 10,
    'P&L!A2': 20,
    'P&L!A3': { formula: 'SUM(A1:A2)' },
    'P&L!B1': { formula: '=A3*2' },
    'P&L!B2': { formula: '(A2-A1)/A1' },
    'P&L!B3': { formula: "Inputs!A1*100" },
    'P&L!C1': { formula: 'IF(A1>5,"big","small")' },
    'P&L!C2': { formula: 'A1/0' },
    'P&L!C3': { formula: 'C3+1' },
    'P&L!D1': { formula: 'ROUND(AVERAGE(A1:A2)/3,2)' },
    'P&L!D2': { formula: 'NOPE(A1)' },
    'Inputs!A1': 0.25
  });
  const at = (formula: string, cell: string) => book.evaluateCell(formula, 'P&L', Number(cell.slice(1)) - 1, cell.charCodeAt(0) - 65);

  it('evaluates ranges, nested formulas and cross-sheet references', () => {
    expect(at('SUM(A1:A2)', 'A3')).toBe(30);
    expect(at('=A3*2', 'B1')).toBe(60);
    expect(at('(A2-A1)/A1', 'B2')).toBe(1);
    expect(at('Inputs!A1*100', 'B3')).toBe(25);
    expect(at('ROUND(AVERAGE(A1:A2)/3,2)', 'D1')).toBe(5);
  });

  it('handles logic and Excel errors', () => {
    expect(at('IF(A1>5,"big","small")', 'C1')).toBe('big');
    expect(at('A1/0', 'C2')).toBe('#DIV/0!');
    expect(at('C3+1', 'C3')).toBe('#CIRC!');
    expect(at('NOPE(A1)', 'D2')).toBe('#NAME?');
  });
});
