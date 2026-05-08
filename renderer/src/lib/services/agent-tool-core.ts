type ToolResultLike = {
  success: boolean;
  output?: unknown;
  error?: string;
  note?: string;
};

type ToolContextLike = {
  chatId: string;
  conversationContext?: string;
};

export async function handleWebSearch(params: {
  args: Record<string, unknown>;
  ctx: ToolContextLike;
  webSearch: (args: { query: string; context?: string; deep: boolean; mode: 'search' | 'deep' | 'max' }) => Promise<{ error?: string; results: Array<{ title: string; url: string; snippet?: string }>; context?: string }>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
  fail: (error: string, note?: string) => ToolResultLike;
  failFromError: (err: unknown, note?: string) => ToolResultLike;
}): Promise<ToolResultLike> {
  const query = String(params.args.query || '');
  const mode = (['search', 'deep', 'max'] as const).includes(params.args.mode as 'search' | 'deep' | 'max')
    ? (params.args.mode as 'search' | 'deep' | 'max')
    : 'search';
  try {
    const result = await params.webSearch({ query, context: params.ctx.conversationContext, deep: mode !== 'search', mode });
    if (result.error) {
      return params.fail(
        result.error,
        'Web search is unavailable right now. Do not invent current facts; report that live search failed and use only already gathered evidence.'
      );
    }
    return params.ok({
      query,
      results: result.results.slice(0, 10).map((entry) => ({ title: entry.title, url: entry.url, snippet: entry.snippet?.slice(0, 250) })),
      context: result.context?.slice(0, 2000)
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
    links?: string[];
    site_name?: string;
    og_image?: string;
    status?: number;
    truncated?: boolean;
    warning?: string;
    quality?: string;
  }>;
  isTauri: () => boolean;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
  fail: (error: string, note?: string) => ToolResultLike;
  failFromError: (err: unknown, note?: string) => ToolResultLike;
}): Promise<ToolResultLike> {
  const url = String(params.args.url || '');
  if (!url) return params.fail('Missing url');
  try {
    if (params.isTauri()) {
      const result = await params.fetchUrlContent(url, 50000);
      if (result.error) return params.fail(result.error);
      const content = String(result.content || '').slice(0, 12000);
      return params.ok({
        url: result.url,
        title: result.title,
        excerpt: result.excerpt,
        content,
        links: (result.links || []).slice(0, 80),
        site_name: result.site_name,
        og_image: result.og_image,
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
      .slice(0, 8000);

    return params.ok({ url, content: content || result.context || 'Could not extract content' });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

export async function handleQueryKnowledge(params: {
  args: Record<string, unknown>;
  ctx: ToolContextLike;
  queryDocuments: (args: { query: string; chat_id: string; top_k: number }) => Promise<{ results: Array<{ chunk: { text: string }; score: number }>; context?: string }>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
  failFromError: (err: unknown, note?: string) => ToolResultLike;
}): Promise<ToolResultLike> {
  try {
    const result = await params.queryDocuments({
      query: String(params.args.query || ''),
      chat_id: params.ctx.chatId,
      top_k: Math.min(Number(params.args.topK) || 5, 20)
    });
    return params.ok({
      results: result.results.map((entry) => ({ text: entry.chunk.text.slice(0, 500), score: entry.score })),
      context: result.context?.slice(0, 3000)
    });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

export function handleCalculator(params: {
  args: Record<string, unknown>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
  fail: (error: string, note?: string) => ToolResultLike;
  failFromError: (err: unknown, note?: string) => ToolResultLike;
}): ToolResultLike {
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
