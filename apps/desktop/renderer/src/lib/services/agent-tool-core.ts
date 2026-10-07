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
  fetchUrlContent: (url: string, maxChars: number) => Promise<{
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
      // Cap extract length for model tokens; scraper still uses Readability / PDF / DOCX extractors.
      const result = await params.fetchUrlContent(url, 24000);
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

export function handleCalculator(params: {
  args: Record<string, unknown>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): ToolResult {
  const expression = String(params.args.expression || '');
  if (!expression) return params.fail('Missing expression');
  try {
    const sanitized = expression.replace(/[^0-9+\-*/().%\sMath\.\w,]/g, '');
    const result = Function(`"use strict"; return (${sanitized})`)();
    return params.ok({ expression, result: Number.isFinite(result) ? result : String(result) });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}
