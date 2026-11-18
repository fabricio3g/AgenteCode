/**
 * A tiny, safe expression evaluator for lesson models.
 *
 * A physics or maths simulation needs a formula, not a program: the model writes
 * `0.5 * g * t ^ 2`, we parse it once and evaluate it on every slider move. No
 * `eval`, no `new Function`, no access to anything outside the variables the
 * model declared, so a lesson cannot run code.
 *
 * Grammar (lowest to highest): `+ -`, `* / %`, unary `+ -`, `^` (right
 * associative), primaries (number, identifier, call, parenthesised expression).
 * Implicit multiplication is accepted — `2x`, `2(x + 1)`, `(a)(b)`, `2 sin t` —
 * because that is how formulas are written by hand.
 *
 * Evaluation fails closed: an unknown identifier, an arity error or a division
 * by zero yields `NaN`/`Infinity`, and every caller renders a dash instead of
 * throwing into the chat.
 */

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; op: '+' | '-'; operand: Node }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '%' | '^'; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

type Token = { kind: 'number'; value: number } | { kind: 'ident'; value: string } | { kind: 'op'; value: string };

const LESSON_FUNCTIONS: Record<string, { arity: number | [number, number]; apply: (args: number[]) => number }> = {
  sin: { arity: 1, apply: ([x]) => Math.sin(x) },
  cos: { arity: 1, apply: ([x]) => Math.cos(x) },
  tan: { arity: 1, apply: ([x]) => Math.tan(x) },
  asin: { arity: 1, apply: ([x]) => Math.asin(x) },
  acos: { arity: 1, apply: ([x]) => Math.acos(x) },
  atan: { arity: 1, apply: ([x]) => Math.atan(x) },
  sqrt: { arity: 1, apply: ([x]) => Math.sqrt(x) },
  abs: { arity: 1, apply: ([x]) => Math.abs(x) },
  exp: { arity: 1, apply: ([x]) => Math.exp(x) },
  ln: { arity: 1, apply: ([x]) => Math.log(x) },
  log: { arity: [1, 2], apply: ([x, base]) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)) },
  log10: { arity: 1, apply: ([x]) => Math.log10(x) },
  floor: { arity: 1, apply: ([x]) => Math.floor(x) },
  ceil: { arity: 1, apply: ([x]) => Math.ceil(x) },
  round: { arity: 1, apply: ([x]) => Math.round(x) },
  sign: { arity: 1, apply: ([x]) => Math.sign(x) },
  min: { arity: [1, 8], apply: (args) => Math.min(...args) },
  max: { arity: [1, 8], apply: (args) => Math.max(...args) },
  pow: { arity: 2, apply: ([x, y]) => x ** y }
};

const LESSON_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2
};

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const text = String(source ?? '');
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (/[0-9.]/.test(char)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (!match) throw new Error(`Unexpected number at ${index}`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index))!;
      tokens.push({ kind: 'ident', value: match[0].toLowerCase() });
      index += match[0].length;
      continue;
    }
    if ('+-*/%^(),'.includes(char)) {
      tokens.push({ kind: 'op', value: char });
      index += 1;
      continue;
    }
    throw new Error(`Unsupported character "${char}"`);
  }
  return tokens;
}

class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private eatOp(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'op' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  parse(): Node {
    const node = this.parseSum();
    if (this.position < this.tokens.length) {
      const token = this.tokens[this.position];
      throw new Error(`Unexpected "${token.kind === 'op' ? token.value : String(token.value)}"`);
    }
    return node;
  }

  private parseSum(): Node {
    let left = this.parseProduct();
    for (;;) {
      if (this.eatOp('+')) left = { kind: 'binary', op: '+', left, right: this.parseProduct() };
      else if (this.eatOp('-')) left = { kind: 'binary', op: '-', left, right: this.parseProduct() };
      else return left;
    }
  }

  private startsPrimary(): boolean {
    const token = this.peek();
    if (!token) return false;
    if (token.kind === 'number' || token.kind === 'ident') return true;
    return token.kind === 'op' && token.value === '(';
  }

  private parseProduct(): Node {
    let left = this.parseUnary();
    for (;;) {
      if (this.eatOp('*')) left = { kind: 'binary', op: '*', left, right: this.parseUnary() };
      else if (this.eatOp('/')) left = { kind: 'binary', op: '/', left, right: this.parseUnary() };
      else if (this.eatOp('%')) left = { kind: 'binary', op: '%', left, right: this.parseUnary() };
      else if (this.startsPrimary()) {
        // Implicit multiplication: 2x, 2(x + 1), (a)(b), 2 sin t.
        left = { kind: 'binary', op: '*', left, right: this.parseUnary() };
      } else return left;
    }
  }

  private parseUnary(): Node {
    if (this.eatOp('-')) return { kind: 'unary', op: '-', operand: this.parseUnary() };
    if (this.eatOp('+')) return { kind: 'unary', op: '+', operand: this.parseUnary() };
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parsePrimary();
    if (this.eatOp('^')) return { kind: 'binary', op: '^', left: base, right: this.parseUnary() };
    return base;
  }

  private parsePrimary(): Node {
    const token = this.peek();
    if (!token) throw new Error('Expression ended early');
    this.position += 1;

    if (token.kind === 'number') return { kind: 'number', value: token.value };

    if (token.kind === 'ident') {
      if (this.eatOp('(')) {
        const args: Node[] = [];
        if (!this.eatOp(')')) {
          for (;;) {
            args.push(this.parseSum());
            if (this.eatOp(',')) continue;
            if (this.eatOp(')')) break;
            throw new Error(`Missing ")" after ${token.value}(`);
          }
        }
        return { kind: 'call', name: token.value, args };
      }
      return { kind: 'variable', name: token.value };
    }

    if (token.value === '(') {
      const inner = this.parseSum();
      if (!this.eatOp(')')) throw new Error('Missing ")"');
      return inner;
    }
    throw new Error(`Unexpected "${token.value}"`);
  }
}

function collectVariables(node: Node, into: Set<string>): void {
  switch (node.kind) {
    case 'variable': into.add(node.name); return;
    case 'unary': collectVariables(node.operand, into); return;
    case 'binary': collectVariables(node.left, into); collectVariables(node.right, into); return;
    case 'call': for (const arg of node.args) collectVariables(arg, into); return;
    default: return;
  }
}

function evaluateNode(node: Node, vars: Record<string, number>): number {
  switch (node.kind) {
    case 'number': return node.value;
    case 'variable': {
      if (node.name in vars) return vars[node.name];
      if (node.name in LESSON_CONSTANTS) return LESSON_CONSTANTS[node.name];
      return Number.NaN;
    }
    case 'unary': {
      const value = evaluateNode(node.operand, vars);
      return node.op === '-' ? -value : value;
    }
    case 'binary': {
      const left = evaluateNode(node.left, vars);
      const right = evaluateNode(node.right, vars);
      switch (node.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return right === 0 ? (left === 0 ? Number.NaN : (left > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)) : left / right;
        case '%': return right === 0 ? Number.NaN : left % right;
        case '^': return left ** right;
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'call': {
      const fn = LESSON_FUNCTIONS[node.name];
      if (!fn) return Number.NaN;
      const args = node.args.map((arg) => evaluateNode(arg, vars));
      const [min, max] = Array.isArray(fn.arity) ? fn.arity : [fn.arity, fn.arity];
      if (args.length < min || args.length > max) return Number.NaN;
      return fn.apply(args);
    }
  }
}

export interface CompiledExpression {
  source: string;
  variables: string[];
  /** NaN/Infinity rather than a throw: a broken model shows a dash, never a broken card. */
  evaluate(vars?: Record<string, number>): number;
}

const cache = new Map<string, CompiledExpression | Error>();
const CACHE_LIMIT = 120;

export function compileExpression(source: string): CompiledExpression {
  const key = String(source ?? '').trim();
  const cached = cache.get(key);
  if (cached) {
    if (cached instanceof Error) throw cached;
    return cached;
  }
  try {
    const ast = new Parser(tokenize(key)).parse();
    const found = new Set<string>();
    collectVariables(ast, found);
    const compiled: CompiledExpression = {
      source: key,
      variables: [...found].filter((name) => !(name in LESSON_CONSTANTS) && !(name in LESSON_FUNCTIONS)).sort(),
      evaluate: (vars = {}) => {
        try {
          const value = evaluateNode(ast, vars);
          return Number.isFinite(value) ? value : Number.NaN;
        } catch {
          return Number.NaN;
        }
      }
    };
    if (cache.size > CACHE_LIMIT) cache.clear();
    cache.set(key, compiled);
    return compiled;
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    cache.set(key, wrapped);
    throw wrapped;
  }
}

/** `null` when the expression is invalid or yields NaN at these values. */
export function evaluateExpression(source: string, vars: Record<string, number> = {}): number | null {
  try {
    const value = compileExpression(source).evaluate(vars);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export interface LessonPoint {
  x: number;
  y: number;
}

/** Samples one expression over a variable range; empty when it is unusable. */
export function sampleSeries(opts: {
  expression: string;
  variable: string;
  from: number;
  to: number;
  samples?: number;
  vars?: Record<string, number>;
}): LessonPoint[] {
  const from = Number.isFinite(opts.from) ? opts.from : 0;
  const to = Number.isFinite(opts.to) ? opts.to : from + 1;
  if (to <= from) return [];
  const count = Math.min(600, Math.max(12, Math.floor(opts.samples ?? 120)));
  let compiled: CompiledExpression;
  try {
    compiled = compileExpression(opts.expression);
  } catch {
    return [];
  }
  const points: LessonPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const x = from + ((to - from) * index) / count;
    const y = compiled.evaluate({ ...(opts.vars || {}), [opts.variable]: x });
    if (Number.isFinite(y)) points.push({ x, y });
  }
  return points;
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** One number formatter for sliders, metrics and messages — never a bare `NaN`. */
export function formatLessonNumber(
  value: number | null,
  format: 'number' | 'percent' | 'currency' | 'compact' = 'number',
  unit?: string
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  let text: string;
  switch (format) {
    case 'percent':
      text = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
      break;
    case 'currency':
      text = new Intl.NumberFormat(undefined, { style: 'currency', currency: unit || 'USD', maximumFractionDigits: 2 }).format(value);
      return text;
    case 'compact':
      text = compact.format(value);
      break;
    default:
      text = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
  return unit ? `${text} ${unit}` : text;
}
