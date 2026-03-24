import type { ElementNode, ParseResult, ValidationError } from './types';

export interface LibraryJSONSchema {
  $defs?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
}

type ParamDef = { name: string; required: boolean };
type ParamMap = Map<string, ParamDef[]>;

type ASTNode =
  | { k: 'Comp'; name: string; args: ASTNode[] }
  | { k: 'Str'; v: string }
  | { k: 'Num'; v: number }
  | { k: 'Bool'; v: boolean }
  | { k: 'Null' }
  | { k: 'Arr'; els: ASTNode[] }
  | { k: 'Obj'; entries: [string, ASTNode][] }
  | { k: 'Ref'; n: string }
  | { k: 'Ph'; n: string };

const enum T {
  Newline = 0,
  LParen = 1,
  RParen = 2,
  LBrack = 3,
  RBrack = 4,
  LBrace = 5,
  RBrace = 6,
  Comma = 7,
  Colon = 8,
  Equals = 9,
  True = 10,
  False = 11,
  Null = 12,
  EOF = 13,
  Str = 14,
  Num = 15,
  Ident = 16,
  Type = 17
}

type Token = { t: T; v?: string | number };

function autoClose(input: string): { text: string; wasIncomplete: boolean } {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const c of input) {
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\' && inStr) {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' && stack.at(-1) === '(') stack.pop();
    else if (c === ']' && stack.at(-1) === '[') stack.pop();
    else if (c === '}' && stack.at(-1) === '{') stack.pop();
  }
  const wasIncomplete = inStr || stack.length > 0;
  if (!wasIncomplete) return { text: input, wasIncomplete: false };
  let out = input;
  if (inStr) {
    if (esc) out += '\\';
    out += '"';
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    out += stack[i] === '(' ? ')' : stack[i] === '[' ? ']' : '}';
  }
  return { text: out, wasIncomplete: true };
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r')) i += 1;
    if (i >= n) break;
    const c = src[i];
    if (c === '\n') {
      tokens.push({ t: T.Newline });
      i += 1;
      continue;
    }
    if (c === '(') { tokens.push({ t: T.LParen }); i += 1; continue; }
    if (c === ')') { tokens.push({ t: T.RParen }); i += 1; continue; }
    if (c === '[') { tokens.push({ t: T.LBrack }); i += 1; continue; }
    if (c === ']') { tokens.push({ t: T.RBrack }); i += 1; continue; }
    if (c === '{') { tokens.push({ t: T.LBrace }); i += 1; continue; }
    if (c === '}') { tokens.push({ t: T.RBrace }); i += 1; continue; }
    if (c === ',') { tokens.push({ t: T.Comma }); i += 1; continue; }
    if (c === ':') { tokens.push({ t: T.Colon }); i += 1; continue; }
    if (c === '=') { tokens.push({ t: T.Equals }); i += 1; continue; }

    if (c === '"') {
      const start = i;
      i += 1;
      let closed = false;
      while (i < n) {
        if (src[i] === '\\') i += 2;
        else if (src[i] === '"') { i += 1; closed = true; break; }
        else i += 1;
      }
      const raw = src.slice(start, i);
      try {
        tokens.push({ t: T.Str, v: JSON.parse(closed ? raw : `${raw}"`) });
      } catch {
        tokens.push({ t: T.Str, v: raw.replace(/^"|"$/g, '') });
      }
      continue;
    }

    const isDigit = c >= '0' && c <= '9';
    const isNegDigit = c === '-' && i + 1 < n && src[i + 1] >= '0' && src[i + 1] <= '9';
    if (isDigit || isNegDigit) {
      const start = i;
      if (src[i] === '-') i += 1;
      while (i < n && src[i] >= '0' && src[i] <= '9') i += 1;
      if (i < n && src[i] === '.') {
        i += 1;
        while (i < n && src[i] >= '0' && src[i] <= '9') i += 1;
      }
      if (i < n && (src[i] === 'e' || src[i] === 'E')) {
        i += 1;
        if (i < n && (src[i] === '+' || src[i] === '-')) i += 1;
        while (i < n && src[i] >= '0' && src[i] <= '9') i += 1;
      }
      tokens.push({ t: T.Num, v: +src.slice(start, i) });
      continue;
    }

    const isAlpha = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
    if (isAlpha) {
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) i += 1;
      const word = src.slice(start, i);
      if (word === 'true') { tokens.push({ t: T.True }); continue; }
      if (word === 'false') { tokens.push({ t: T.False }); continue; }
      if (word === 'null') { tokens.push({ t: T.Null }); continue; }
      tokens.push({ t: c >= 'A' && c <= 'Z' ? T.Type : T.Ident, v: word });
      continue;
    }
    i += 1;
  }
  tokens.push({ t: T.EOF });
  return tokens;
}

interface RawStmt {
  id: string;
  tokens: Token[];
}

function split(tokens: Token[]): RawStmt[] {
  const stmts: RawStmt[] = [];
  let pos = 0;
  while (pos < tokens.length) {
    while (pos < tokens.length && tokens[pos].t === T.Newline) pos += 1;
    if (pos >= tokens.length || tokens[pos].t === T.EOF) break;
    const idTok = tokens[pos];
    if (idTok.t !== T.Ident) {
      while (pos < tokens.length && tokens[pos].t !== T.Newline && tokens[pos].t !== T.EOF) pos += 1;
      continue;
    }
    pos += 1;
    if (tokens[pos]?.t !== T.Equals) {
      while (pos < tokens.length && tokens[pos].t !== T.Newline && tokens[pos].t !== T.EOF) pos += 1;
      continue;
    }
    pos += 1;
    const expr: Token[] = [];
    let depth = 0;
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.t === T.LParen || t.t === T.LBrack || t.t === T.LBrace) depth += 1;
      if (t.t === T.RParen || t.t === T.RBrack || t.t === T.RBrace) depth -= 1;
      if ((t.t === T.Newline && depth <= 0) || t.t === T.EOF) break;
      expr.push(t);
      pos += 1;
    }
    stmts.push({ id: String(idTok.v), tokens: expr });
    while (pos < tokens.length && tokens[pos].t === T.Newline) pos += 1;
  }
  return stmts;
}

class ParserCursor {
  constructor(private readonly tokens: Token[], private pos = 0) {}
  peek() { return this.tokens[this.pos] ?? { t: T.EOF } as Token; }
  next() { const token = this.peek(); this.pos += 1; return token; }
  eat(type: T) { if (this.peek().t === type) { this.pos += 1; return true; } return false; }
  parseValue(): ASTNode | null {
    const tok = this.next();
    switch (tok.t) {
      case T.Str: return { k: 'Str', v: String(tok.v ?? '') };
      case T.Num: return { k: 'Num', v: Number(tok.v ?? 0) };
      case T.True: return { k: 'Bool', v: true };
      case T.False: return { k: 'Bool', v: false };
      case T.Null: return { k: 'Null' };
      case T.Ident: return { k: 'Ref', n: String(tok.v) };
      case T.Type: {
        const name = String(tok.v);
        if (!this.eat(T.LParen)) return { k: 'Ref', n: name };
        const args: ASTNode[] = [];
        while (this.peek().t !== T.RParen && this.peek().t !== T.EOF) {
          const value = this.parseValue();
          if (value) args.push(value);
          if (!this.eat(T.Comma)) break;
        }
        this.eat(T.RParen);
        return { k: 'Comp', name, args };
      }
      case T.LBrack: {
        const els: ASTNode[] = [];
        while (this.peek().t !== T.RBrack && this.peek().t !== T.EOF) {
          const value = this.parseValue();
          if (value) els.push(value);
          if (!this.eat(T.Comma)) break;
        }
        this.eat(T.RBrack);
        return { k: 'Arr', els };
      }
      case T.LBrace: {
        const entries: [string, ASTNode][] = [];
        while (this.peek().t !== T.RBrace && this.peek().t !== T.EOF) {
          const keyTok = this.next();
          if (keyTok.t !== T.Ident && keyTok.t !== T.Type && keyTok.t !== T.Str) break;
          const key = String(keyTok.v ?? '');
          this.eat(T.Colon);
          const value = this.parseValue();
          if (value) entries.push([key, value]);
          if (!this.eat(T.Comma)) break;
        }
        this.eat(T.RBrace);
        return { k: 'Obj', entries };
      }
      default:
        return null;
    }
  }
}

function toParamMap(schema: LibraryJSONSchema): ParamMap {
  const map: ParamMap = new Map();
  for (const [name, def] of Object.entries(schema.$defs || {})) {
    const properties = def.properties || {};
    const required = new Set(def.required || []);
    map.set(name, Object.keys(properties).map((key) => ({ name: key, required: required.has(key) })));
  }
  return map;
}

function parseStatements(input: string): { env: Map<string, ASTNode>; incomplete: boolean; statementCount: number } {
  const normalized = autoClose(input);
  const tokens = tokenize(normalized.text);
  const rawStmts = split(tokens);
  const env = new Map<string, ASTNode>();
  for (const stmt of rawStmts) {
    const cursor = new ParserCursor(stmt.tokens);
    const ast = cursor.parseValue();
    if (ast) env.set(stmt.id, ast);
  }
  return { env, incomplete: normalized.wasIncomplete, statementCount: rawStmts.length };
}

function resolveAst(input: ASTNode, env: Map<string, ASTNode>, paramMap: ParamMap, unresolved: Set<string>, validationErrors: ValidationError[], stack = new Set<string>()): { value: unknown; partial: boolean } {
  switch (input.k) {
    case 'Str': return { value: input.v, partial: false };
    case 'Num': return { value: input.v, partial: false };
    case 'Bool': return { value: input.v, partial: false };
    case 'Null': return { value: null, partial: false };
    case 'Ph': unresolved.add(input.n); return { value: null, partial: true };
    case 'Ref': {
      if (stack.has(input.n)) {
        unresolved.add(input.n);
        return { value: null, partial: true };
      }
      const next = env.get(input.n);
      if (!next) {
        unresolved.add(input.n);
        return { value: null, partial: true };
      }
      const nextStack = new Set(stack);
      nextStack.add(input.n);
      return resolveAst(next, env, paramMap, unresolved, validationErrors, nextStack);
    }
    case 'Arr': {
      const values = input.els.map((item) => resolveAst(item, env, paramMap, unresolved, validationErrors, stack));
      return { value: values.map((item) => item.value), partial: values.some((item) => item.partial) };
    }
    case 'Obj': {
      const result: Record<string, unknown> = {};
      let partial = false;
      for (const [key, value] of input.entries) {
        const resolved = resolveAst(value, env, paramMap, unresolved, validationErrors, stack);
        result[key] = resolved.value;
        partial ||= resolved.partial;
      }
      return { value: result, partial };
    }
    case 'Comp': {
      const defs = paramMap.get(input.name) || [];
      const props: Record<string, unknown> = {};
      let partial = false;
      input.args.forEach((arg, index) => {
        const resolved = resolveAst(arg, env, paramMap, unresolved, validationErrors, stack);
        const key = defs[index]?.name || `arg${index + 1}`;
        props[key] = resolved.value;
        partial ||= resolved.partial;
      });
      for (const def of defs) {
        if (def.required && props[def.name] === undefined) {
          validationErrors.push({ component: input.name, path: `/${def.name}`, message: `Missing required prop ${def.name}` });
          partial = true;
        }
      }
      const node: ElementNode = { type: 'element', typeName: input.name, props, partial };
      return { value: node, partial };
    }
  }
}

function parseWithSchema(schema: LibraryJSONSchema, input: string): ParseResult {
  const paramMap = toParamMap(schema);
  const { env, incomplete, statementCount } = parseStatements(input);
  const unresolved = new Set<string>();
  const validationErrors: ValidationError[] = [];
  const rootAst = env.get('root');
  const resolved = rootAst ? resolveAst(rootAst, env, paramMap, unresolved, validationErrors) : { value: null, partial: false };
  return {
    root: (resolved.value as ElementNode | null) ?? null,
    meta: {
      incomplete: incomplete || resolved.partial,
      unresolved: [...unresolved],
      statementCount,
      validationErrors
    }
  };
}

export function createParser(schema: LibraryJSONSchema) {
  return { parse(input: string) { return parseWithSchema(schema, input); } };
}

export function createStreamingParser(schema: LibraryJSONSchema) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      return parseWithSchema(schema, buffer);
    },
    parse(input: string) {
      buffer = input;
      return parseWithSchema(schema, buffer);
    },
    reset() {
      buffer = '';
    }
  };
}
