import type { ToolContext, ToolResult } from '$lib/services/agent-types';
import type { SearchResult } from '$lib/types/bridge';

export async function handleWebSearch(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  webSearch: (args: { query: string; context?: string; deep: boolean; mode: 'search' | 'deep' | 'max'; options?: Record<string, unknown> }) => Promise<{ error?: string; results: SearchResult[]; context?: string }>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const query = String(params.args.query || '');
  const mode = (['search', 'deep', 'max'] as const).includes(params.args.mode as 'search' | 'deep' | 'max')
    ? (params.args.mode as 'search' | 'deep' | 'max')
    : params.ctx.searchMode || 'search';
  try {
    const resultBudget = mode === 'max' ? 18 : mode === 'deep' ? 12 : 8;
    const result = await params.webSearch({
      query,
      context: params.ctx.conversationContext,
      deep: mode !== 'search',
      mode,
      options: {
        max_results: resultBudget
      }
    });
    if (result.error) {
      return params.fail(
        result.error,
        'Web search is unavailable right now. Do not invent current facts; report that live search failed and use only already gathered evidence.'
      );
    }
    // Cap per-result body for the tool message; evidence pack carries deeper excerpts later.
    const excerptCap = mode === 'max' ? 2400 : mode === 'deep' ? 1800 : 900;
    const results = result.results.slice(0, resultBudget).map((entry, index) => {
      const full = String(entry.full_content || '');
      const snippet = String(entry.snippet || '');
      return {
        rank: index + 1,
        title: entry.title,
        url: entry.url,
        snippet: snippet.slice(0, 600),
        // Prefer readable full content when deep/max already scraped the page.
        ...(full.length > 200
          ? { full_content: full.slice(0, excerptCap) }
          : {}),
        provider: entry.provider,
        providers: entry.providers,
        published_at: entry.published_at,
        metadata: entry.metadata
      };
    });

    const hasDeepBodies = results.some((entry) => entry.full_content && entry.full_content.length > 200);

    return params.ok({
      query,
      searched_at: new Date().toISOString(),
      mode,
      results,
      urls_to_consider: results.map((entry) => ({ rank: entry.rank, title: entry.title, url: entry.url })),
      next_step: hasDeepBodies
        ? 'Page text is already attached on results[].full_content when available. fetch_url only if a key URL still needs more text or was thin. Prefer writing the final APA report when sources are sufficient.'
        : 'Prefer fetch_url on the most authoritative URLs before finalizing. If results are thin, run another distinct web_search query, then write the APA report.'
      // Intentionally omit result.context — it duplicates results and bloats the tool turn.
    });
  } catch (err: unknown) {
    return params.failFromError(
      err,
      'Web search threw an exception. Do not invent current facts; report that live search failed and use only already gathered evidence.'
    );
  }
}

export async function handleFetchUrl(params: {
  args: Record<string, unknown>;
  webSearch: (args: { query: string; deep: boolean; mode: 'deep' }) => Promise<{ results?: Array<{ url?: string; snippet?: string }>; context?: string }>;
  fetchUrlContent: (url: string) => Promise<{
    error?: string;
    url?: string;
    title?: string;
    excerpt?: string;
    content?: string;
    links?: Array<unknown>;
    site_name?: string;
    og_image?: string;
    file_type?: string;
    document_kind?: string;
    status?: number;
    truncated?: boolean;
    warning?: string;
    quality?: string;
    pages?: number;
    extraction?: string;
  }>;
  isElectron: () => boolean;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const url = String(params.args.url || '');
  if (!url) return params.fail('Missing url');
  try {
    if (params.isElectron()) {
      // The whole page: Reader View for HTML, text extraction for PDF / DOCX — no length budget.
      const result = await params.fetchUrlContent(url);
      if (result.error) return params.fail(result.error);
      const content = String(result.content || '');
      return params.ok({
        url: result.url,
        title: result.title,
        excerpt: result.excerpt,
        content,
        links: (result.links || []).slice(0, 40),
        site_name: result.site_name,
        og_image: result.og_image,
        file_type: result.file_type || result.document_kind,
        document_kind: result.document_kind,
        extraction: result.extraction,
        pages: result.pages,
        status: result.status,
        truncated: result.truncated,
        warning: result.warning,
        quality: result.quality
      });
    }

    const result = await params.webSearch({ query: url, deep: true, mode: 'deep' });
    const content = (result.results || [])
      .filter((entry) => entry.url === url || entry.snippet)
      .map((entry) => entry.snippet || '')
      .filter(Boolean)
      .join('\n\n')
      .trim();

    return params.ok({ url, content: content || result.context || 'Could not extract content' });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

export async function handleQueryKnowledge(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  queryDocuments: (args: { query: string; chat_id: string; top_k: number; scope?: string; file_type?: string; files?: string[] }) => Promise<{
    results: Array<{ ref?: number; chunk: { text: string }; score: number; citation?: string }>;
    context?: string;
    retrieval?: string;
    notice?: string;
  }>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  try {
    // The main process clips chunks and enforces the context budget; results only
    // carry the citation so the model can name the source next to each `[n]`.
    const topK = Math.min(Math.max(Number(params.args.topK) || 16, 1), 40);
    const scope = String(params.args.scope || '').toLowerCase() === 'library' ? 'library' : 'chat';
    const result = await params.queryDocuments({
      query: String(params.args.query || ''),
      chat_id: params.ctx.chatId,
      top_k: topK,
      scope,
      file_type: params.args.file_type ? String(params.args.file_type) : undefined,
      files: Array.isArray(params.args.files) ? params.args.files.map((entry) => String(entry)) : undefined
    });
    return params.ok({
      results: result.results.map((entry, index) => ({
        ref: entry.ref ?? index + 1,
        citation: entry.citation,
        score: entry.score
      })),
      context: result.context || undefined,
      retrieval: result.retrieval,
      notice: result.notice
    });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

const MAX_MATH_EXPRESSION_LENGTH = 10_000;
const MAX_MATH_RECURSION_DEPTH = 64;

const MATH_CONSTANTS: Record<string, number> = Object.assign(Object.create(null), {
  PI: Math.PI,
  E: Math.E,
});

const MATH_FUNCTIONS: Record<string, { fn: (...args: number[]) => number; minArgs: number; maxArgs: number }> = Object.assign(Object.create(null), {
  abs: { fn: Math.abs, minArgs: 1, maxArgs: 1 },
  ceil: { fn: Math.ceil, minArgs: 1, maxArgs: 1 },
  floor: { fn: Math.floor, minArgs: 1, maxArgs: 1 },
  round: { fn: Math.round, minArgs: 1, maxArgs: 1 },
  sqrt: { fn: Math.sqrt, minArgs: 1, maxArgs: 1 },
  cbrt: { fn: Math.cbrt, minArgs: 1, maxArgs: 1 },
  pow: { fn: Math.pow, minArgs: 2, maxArgs: 2 },
  min: { fn: Math.min, minArgs: 1, maxArgs: Infinity },
  max: { fn: Math.max, minArgs: 1, maxArgs: Infinity },
  log: { fn: Math.log, minArgs: 1, maxArgs: 1 },
  log2: { fn: Math.log2, minArgs: 1, maxArgs: 1 },
  log10: { fn: Math.log10, minArgs: 1, maxArgs: 1 },
  exp: { fn: Math.exp, minArgs: 1, maxArgs: 1 },
  sin: { fn: Math.sin, minArgs: 1, maxArgs: 1 },
  cos: { fn: Math.cos, minArgs: 1, maxArgs: 1 },
  tan: { fn: Math.tan, minArgs: 1, maxArgs: 1 },
  asin: { fn: Math.asin, minArgs: 1, maxArgs: 1 },
  acos: { fn: Math.acos, minArgs: 1, maxArgs: 1 },
  atan: { fn: Math.atan, minArgs: 1, maxArgs: 1 },
  atan2: { fn: Math.atan2, minArgs: 2, maxArgs: 2 },
  hypot: { fn: Math.hypot, minArgs: 1, maxArgs: Infinity },
  sign: { fn: Math.sign, minArgs: 1, maxArgs: 1 },
  trunc: { fn: Math.trunc, minArgs: 1, maxArgs: 1 },
});

type MathToken =
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '%' | '**' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' }
  | { type: 'eof' };

function tokenizeMathExpression(input: string): MathToken[] {
  if (input.length > MAX_MATH_EXPRESSION_LENGTH) {
    throw new Error('Expression is too long');
  }
  const tokens: MathToken[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < input.length && input[i + 1]! >= '0' && input[i + 1]! <= '9')) {
      const start = i;
      let hasDot = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c >= '0' && c <= '9') {
          i += 1;
        } else if (c === '.' && !hasDot) {
          hasDot = true;
          i += 1;
        } else {
          break;
        }
      }
      if (i < input.length && (input[i] === 'e' || input[i] === 'E')) {
        let expIdx = i + 1;
        if (expIdx < input.length && (input[expIdx] === '+' || input[expIdx] === '-')) expIdx += 1;
        const digitStart = expIdx;
        while (expIdx < input.length && input[expIdx]! >= '0' && input[expIdx]! <= '9') expIdx += 1;
        if (expIdx === digitStart) {
          throw new Error(`Invalid exponent in number near position ${i}`);
        }
        i = expIdx;
      }
      if (i < input.length && (input[i] === '.' || /[A-Za-z_$]/.test(input[i]!))) {
        throw new Error(`Invalid number syntax near position ${start}`);
      }
      const raw = input.slice(start, i);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`Invalid number: ${raw}`);
      tokens.push({ type: 'number', value });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i]!)) i += 1;
      let ident = input.slice(start, i);
      if (ident === 'Math' && input[i] === '.') {
        i += 1;
        const propStart = i;
        while (i < input.length && /[A-Za-z0-9_]/.test(input[i]!)) i += 1;
        if (i === propStart) throw new Error('Expected property name after Math.');
        ident = `Math.${input.slice(propStart, i)}`;
      }
      tokens.push({ type: 'ident', value: ident });
      continue;
    }

    if (ch === '*' && input[i + 1] === '*') {
      tokens.push({ type: 'op', value: '**' });
      i += 2;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i += 1;
      continue;
    }

    throw new Error(`Unsupported character in expression: ${JSON.stringify(ch)}`);
  }

  tokens.push({ type: 'eof' });
  return tokens;
}

export function evaluateMathExpression(expression: string): number {
  const trimmed = String(expression || '').trim();
  if (!trimmed) throw new Error('Missing expression');

  const tokens = tokenizeMathExpression(trimmed);
  let pos = 0;

  const peek = (): MathToken => tokens[pos]!;
  const consume = (): MathToken => tokens[pos++]!;

  function parseExpression(depth: number): number {
    if (depth > MAX_MATH_RECURSION_DEPTH) throw new Error('Expression nesting too deep');
    let left = parseTerm(depth + 1);
    while (true) {
      const tok = peek();
      if (tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
        consume();
        const right = parseTerm(depth + 1);
        left = tok.value === '+' ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  function parseTerm(depth: number): number {
    if (depth > MAX_MATH_RECURSION_DEPTH) throw new Error('Expression nesting too deep');
    let left = parseUnary(depth + 1);
    while (true) {
      const tok = peek();
      if (tok.type === 'op' && (tok.value === '*' || tok.value === '/' || tok.value === '%')) {
        consume();
        const right = parseUnary(depth + 1);
        if (tok.value === '*') left = left * right;
        else if (tok.value === '/') left = left / right;
        else left = left % right;
      } else {
        break;
      }
    }
    return left;
  }

  function parseUnary(depth: number): number {
    if (depth > MAX_MATH_RECURSION_DEPTH) throw new Error('Expression nesting too deep');
    const tok = peek();
    if (tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      consume();
      const val = parseUnary(depth + 1);
      return tok.value === '-' ? -val : +val;
    }
    return parsePower(depth + 1);
  }

  function parsePower(depth: number): number {
    if (depth > MAX_MATH_RECURSION_DEPTH) throw new Error('Expression nesting too deep');
    const base = parsePrimary(depth + 1);
    const tok = peek();
    if (tok.type === 'op' && tok.value === '**') {
      consume();
      const exponent = parseUnary(depth + 1);
      return base ** exponent;
    }
    return base;
  }

  function parsePrimary(depth: number): number {
    if (depth > MAX_MATH_RECURSION_DEPTH) throw new Error('Expression nesting too deep');
    const tok = peek();

    if (tok.type === 'number') {
      consume();
      return tok.value;
    }

    if (tok.type === 'lparen') {
      consume();
      const value = parseExpression(depth + 1);
      if (peek().type !== 'rparen') throw new Error('Expected closing parenthesis');
      consume();
      return value;
    }

    if (tok.type === 'ident') {
      consume();
      const rawName = tok.value;
      const member = rawName.startsWith('Math.') ? rawName.slice(5) : rawName;

      if (peek().type === 'lparen') {
        const entry = MATH_FUNCTIONS[member];
        if (!entry) throw new Error(`Unsupported function: ${rawName}`);
        consume();
        const args: number[] = [];
        if (peek().type !== 'rparen') {
          args.push(parseExpression(depth + 1));
          while (peek().type === 'comma') {
            consume();
            args.push(parseExpression(depth + 1));
          }
        }
        if (peek().type !== 'rparen') throw new Error(`Expected ')' after arguments to ${rawName}`);
        consume();
        if (args.length < entry.minArgs || args.length > entry.maxArgs) {
          throw new Error(`Invalid argument count for ${rawName}`);
        }
        return entry.fn(...args);
      }

      if (member in MATH_CONSTANTS) {
        return MATH_CONSTANTS[member]!;
      }

      throw new Error(`Unsupported identifier: ${rawName}`);
    }

    throw new Error('Unexpected token in expression');
  }

  const result = parseExpression(0);
  if (peek().type !== 'eof') {
    throw new Error('Unexpected trailing tokens in expression');
  }
  return result;
}

export function handleCalculator(params: {
  args: Record<string, unknown>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): ToolResult {
  const expression = String(params.args.expression || '');
  if (!expression) return params.fail('Missing expression');
  try {
    const result = evaluateMathExpression(expression);
    return params.ok({ expression, result: Number.isFinite(result) ? result : String(result) });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}
