// Formula results for cells that arrive without one. Excel caches every
// formula's value in the file, but files written by libraries (openpyxl,
// ExcelJS, most scripts) often don't, and Excel only fills them in on open.
// This evaluates the everyday subset — arithmetic, comparisons, references
// and ranges (also across sheets), and the common functions — so those
// sheets don't show blanks. Anything else yields an Excel-style error.

export type CellInput = number | string | boolean | Date | null | undefined | { formula: string };
export type FormulaValue = number | string | boolean | null;
export type ErrorValue = '#DIV/0!' | '#NAME?' | '#VALUE!' | '#REF!' | '#CIRC!';

/** Reads a cell's raw content: a value, or `{ formula }` for a formula without a result. */
export type CellReader = (sheet: string, row: number, col: number) => CellInput;

interface Ref { sheet: string; row: number; col: number }
type Operand = FormulaValue | FormulaValue[];

class FormulaError extends Error {
  constructor(readonly code: ErrorValue) {
    super(code);
  }
}

function colIndex(letters: string): number {
  let col = 0;
  for (const char of letters.toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
  return col - 1;
}

const TOKEN = /\s*(?:(?<num>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|"(?<str>(?:[^"]|"")*)"|(?<ref>(?:(?:'[^']+'|[A-Za-z_][\w.]*)!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)|(?<fn>[A-Za-z_][\w.]*)\s*\(|(?<bool>TRUE|FALSE)\b|(?<op><>|<=|>=|[-+*/^&=<>%(),:]))/iy;

type Token = { kind: 'num' | 'str' | 'ref' | 'fn' | 'bool' | 'op'; text: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  let rest = source.trim();
  while (rest.length) {
    TOKEN.lastIndex = 0;
    const match = TOKEN.exec(rest);
    if (!match || !match.groups) throw new FormulaError('#NAME?');
    const g = match.groups;
    if (g.num !== undefined) tokens.push({ kind: 'num', text: g.num });
    else if (g.str !== undefined) tokens.push({ kind: 'str', text: g.str.replace(/""/g, '"') });
    else if (g.ref !== undefined) tokens.push({ kind: 'ref', text: g.ref });
    else if (g.fn !== undefined) tokens.push({ kind: 'fn', text: g.fn.toUpperCase() });
    else if (g.bool !== undefined) tokens.push({ kind: 'bool', text: g.bool.toUpperCase() });
    else tokens.push({ kind: 'op', text: g.op });
    rest = rest.slice(match[0].length).trimStart();
  }
  return tokens;
}

function toNumber(value: FormulaValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === '') return 0;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new FormulaError('#VALUE!');
  return parsed;
}

function scalar(value: Operand): FormulaValue {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function numbersIn(args: Operand[]): number[] {
  const out: number[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) for (const item of arg) { if (typeof item === 'number') out.push(item); }
    else if (arg !== null && arg !== '') out.push(toNumber(arg));
  }
  return out;
}

function roundTo(value: number, digits: number, mode: 'round' | 'up' | 'down' = 'round'): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const rounded = mode === 'up' ? Math.sign(scaled) * Math.ceil(Math.abs(scaled) - 1e-9)
    : mode === 'down' ? Math.sign(scaled) * Math.floor(Math.abs(scaled) + 1e-9)
      : Math.sign(scaled) * Math.round(Math.abs(scaled));
  return rounded / factor;
}

const FUNCTIONS: Record<string, (args: Operand[]) => FormulaValue> = {
  SUM: (args) => numbersIn(args).reduce((a, b) => a + b, 0),
  AVERAGE: (args) => {
    const values = numbersIn(args);
    if (!values.length) throw new FormulaError('#DIV/0!');
    return values.reduce((a, b) => a + b, 0) / values.length;
  },
  MIN: (args) => (numbersIn(args).length ? Math.min(...numbersIn(args)) : 0),
  MAX: (args) => (numbersIn(args).length ? Math.max(...numbersIn(args)) : 0),
  COUNT: (args) => numbersIn(args.map((arg) => (Array.isArray(arg) ? arg : typeof arg === 'number' ? arg : null))).length,
  COUNTA: (args) => args.flat().filter((value) => value !== null && value !== '').length,
  ROUND: ([value, digits]) => roundTo(toNumber(scalar(value)), toNumber(scalar(digits ?? 0))),
  ROUNDUP: ([value, digits]) => roundTo(toNumber(scalar(value)), toNumber(scalar(digits ?? 0)), 'up'),
  ROUNDDOWN: ([value, digits]) => roundTo(toNumber(scalar(value)), toNumber(scalar(digits ?? 0)), 'down'),
  ABS: ([value]) => Math.abs(toNumber(scalar(value))),
  IF: ([test, yes, no]) => (toNumber(scalar(test)) ? scalar(yes ?? true) : scalar(no ?? false)),
  AND: (args) => args.flat().every((value) => !!toNumber(value)),
  OR: (args) => args.flat().some((value) => !!toNumber(value)),
  NOT: ([value]) => !toNumber(scalar(value)),
  CONCAT: (args) => args.flat().map((value) => (value === null ? '' : String(value))).join(''),
  CONCATENATE: (args) => args.flat().map((value) => (value === null ? '' : String(value))).join(''),
  LEN: ([value]) => String(scalar(value) ?? '').length,
  UPPER: ([value]) => String(scalar(value) ?? '').toUpperCase(),
  LOWER: ([value]) => String(scalar(value) ?? '').toLowerCase()
};

/** Evaluates formulas against a workbook, memoizing each cell once. */
export function createFormulaEvaluator(read: CellReader) {
  const cache = new Map<string, FormulaValue | ErrorValue>();
  const inProgress = new Set<string>();

  function cellValue(ref: Ref): FormulaValue {
    const raw = read(ref.sheet, ref.row, ref.col);
    if (raw instanceof Date) return (raw.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
    if (raw && typeof raw === 'object' && 'formula' in raw) {
      const result = evaluate(raw.formula, ref.sheet, ref);
      if (typeof result === 'string' && result.startsWith('#')) throw new FormulaError(result as ErrorValue);
      return result;
    }
    return (raw ?? null) as FormulaValue;
  }

  function parseRef(text: string, sheet: string): { from: Ref; to: Ref } {
    let target = sheet;
    let body = text;
    const bang = text.lastIndexOf('!');
    if (bang >= 0) {
      target = text.slice(0, bang).replace(/^'|'$/g, '');
      body = text.slice(bang + 1);
    }
    const [a, b = a] = body.replace(/\$/g, '').split(':');
    const cell = (part: string): Ref => {
      const m = /^([A-Za-z]+)(\d+)$/.exec(part);
      if (!m) throw new FormulaError('#REF!');
      return { sheet: target, row: Number(m[2]) - 1, col: colIndex(m[1]) };
    };
    return { from: cell(a), to: cell(b) };
  }

  function evaluate(formula: string, sheet: string, at?: Ref): FormulaValue | ErrorValue {
    const key = at ? `${at.sheet}!${at.row},${at.col}` : '';
    if (key && cache.has(key)) return cache.get(key)!;
    if (key && inProgress.has(key)) return '#CIRC!';
    if (key) inProgress.add(key);
    let result: FormulaValue | ErrorValue;
    try {
      const tokens = tokenize(formula.replace(/^=/, ''));
      let pos = 0;
      const peek = () => tokens[pos];
      const take = (text?: string) => {
        const token = tokens[pos];
        if (!token || (text && token.text !== text)) throw new FormulaError('#NAME?');
        pos += 1;
        return token;
      };

      const primary = (): Operand => {
        const token = take();
        if (token.kind === 'num') return Number(token.text);
        if (token.kind === 'str') return token.text;
        if (token.kind === 'bool') return token.text === 'TRUE';
        if (token.kind === 'ref') {
          const { from, to } = parseRef(token.text, sheet);
          if (from.row === to.row && from.col === to.col) return cellValue(from);
          const values: FormulaValue[] = [];
          for (let r = Math.min(from.row, to.row); r <= Math.max(from.row, to.row); r += 1) {
            for (let c = Math.min(from.col, to.col); c <= Math.max(from.col, to.col); c += 1) values.push(cellValue({ sheet: from.sheet, row: r, col: c }));
          }
          return values;
        }
        if (token.kind === 'fn') {
          const fn = FUNCTIONS[token.text.replace(/^_XLFN\./, '')];
          const args: Operand[] = [];
          if (peek()?.text !== ')') {
            args.push(comparison());
            while (peek()?.text === ',') {
              take(',');
              args.push(comparison());
            }
          }
          take(')');
          if (!fn) throw new FormulaError('#NAME?');
          return fn(args);
        }
        if (token.text === '(') {
          const value = comparison();
          take(')');
          return value;
        }
        if (token.text === '-') return -toNumber(scalar(unary()));
        if (token.text === '+') return toNumber(scalar(unary()));
        throw new FormulaError('#NAME?');
      };
      const unary = (): Operand => {
        let value = primary();
        while (peek()?.text === '%') {
          take('%');
          value = toNumber(scalar(value)) / 100;
        }
        return value;
      };
      const power = (): Operand => {
        let left = unary();
        while (peek()?.text === '^') {
          take('^');
          left = toNumber(scalar(left)) ** toNumber(scalar(unary()));
        }
        return left;
      };
      const product = (): Operand => {
        let left = power();
        while (peek()?.text === '*' || peek()?.text === '/') {
          const op = take().text;
          const right = toNumber(scalar(power()));
          if (op === '/' && right === 0) throw new FormulaError('#DIV/0!');
          left = op === '*' ? toNumber(scalar(left)) * right : toNumber(scalar(left)) / right;
        }
        return left;
      };
      const sum = (): Operand => {
        let left = product();
        while (peek()?.text === '+' || peek()?.text === '-') {
          const op = take().text;
          const right = toNumber(scalar(product()));
          left = op === '+' ? toNumber(scalar(left)) + right : toNumber(scalar(left)) - right;
        }
        return left;
      };
      const concat = (): Operand => {
        let left = sum();
        while (peek()?.text === '&') {
          take('&');
          left = `${scalar(left) ?? ''}${scalar(sum()) ?? ''}`;
        }
        return left;
      };
      const comparison = (): Operand => {
        let left = concat();
        while (['=', '<>', '<', '>', '<=', '>='].includes(peek()?.text ?? '')) {
          const op = take().text;
          const a = scalar(left);
          const b = scalar(concat());
          const cmp = typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''));
          left = op === '=' ? cmp === 0 : op === '<>' ? cmp !== 0 : op === '<' ? cmp < 0 : op === '>' ? cmp > 0 : op === '<=' ? cmp <= 0 : cmp >= 0;
        }
        return left;
      };

      const value = comparison();
      if (pos !== tokens.length) throw new FormulaError('#NAME?');
      result = scalar(value);
    } catch (err) {
      result = err instanceof FormulaError ? err.code : '#VALUE!';
    }
    if (key) {
      inProgress.delete(key);
      cache.set(key, result);
    }
    return result;
  }

  return {
    /** The value of the formula in `sheet` at (row, col), zero-based. */
    evaluateCell: (formula: string, sheet: string, row: number, col: number) => evaluate(formula, sheet, { sheet, row, col })
  };
}
