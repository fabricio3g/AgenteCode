import type { ToolContext, ToolResult } from '$lib/services/agent-types';
import type { SearchResult } from '$lib/types/tauri';

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
    const results = result.results.slice(0, resultBudget).map((entry, index) => ({
      ...entry,
      rank: index + 1,
      title: entry.title,
      url: entry.url,
      snippet: entry.snippet
    }));

    return params.ok({
      query,
      searched_at: new Date().toISOString(),
      mode,
      results,
      urls_to_consider: results.map((entry) => ({ rank: entry.rank, title: entry.title, url: entry.url })),
      next_step: 'If the answer needs source text, choose the most authoritative/relevant URL from urls_to_consider and call fetch_url before finalizing. If results are thin, run another distinct web_search query.',
      context: result.context
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
  isTauri: () => boolean;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const url = String(params.args.url || '');
  if (!url) return params.fail('Missing url');
  try {
    if (params.isTauri()) {
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
  queryDocuments: (args: { query: string; chat_id: string; top_k: number }) => Promise<{ results: Array<{ chunk: { text: string }; score: number }>; context?: string }>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  try {
    // No tight token budget on attached knowledge — return full chunks (hard safety only).
    const topK = Math.min(Math.max(Number(params.args.topK) || 16, 1), 40);
    const result = await params.queryDocuments({
      query: String(params.args.query || ''),
      chat_id: params.ctx.chatId,
      top_k: topK
    });
    const MAX_CHUNK = 4000;
    const MAX_CONTEXT = 120_000;
    return params.ok({
      results: result.results.map((entry) => ({
        text: String(entry.chunk.text || '').slice(0, MAX_CHUNK),
        score: entry.score
      })),
      context: result.context ? String(result.context).slice(0, MAX_CONTEXT) : undefined
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
