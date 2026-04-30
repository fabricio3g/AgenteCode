import type { AgentStep, AgentArtifact, WorkspaceFile } from '$lib/types/chat';
import type { SearchResult } from '$lib/types/tauri';
import type { RequestMessage, ToolDefinition, NativeToolCall } from '$lib/services/chat-api';
import { completeAssistantReply, setToolSupportCache } from '$lib/services/chat-api';
import { agentComplete, agentStreamComplete, supportsNativeTools as agentSupportsNativeTools } from '$lib/services/agent-llm';
import { webSearch, fetchUrlContent } from '$lib/services/search';
import { queryDocuments } from '$lib/services/rag';
import { loadAppConfig } from '$lib/utils/storage';
import { isTauri, invoke } from '$lib/services/tauri';
import {
  readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceFile,
  createWorkspaceFolder
} from '$lib/services/files';

type ToolCall = { id?: string; name: string; arguments: Record<string, unknown> };

type ToolResult = {
  success: boolean;
  output?: unknown;
  error?: string;
  note?: string;
  createdFiles?: string[];
  modifiedFiles?: string[];
  deletedFiles?: string[];
  nextTurnMods?: {
    instructions?: string;
    temperature?: number;
    injectMessages?: RequestMessage[];
    disableNativeTools?: boolean;
  };
};

type ToolContext = {
  chatId: string;
  files: Record<string, string>;
  workspaceRoot?: string;
  workspaceFiles?: WorkspaceFile[];
  executionMode: 'sandbox' | 'workspace';
  signal?: AbortSignal;
  onArtifact: (a: AgentArtifact | null) => void;
};

const MAX_ITERATIONS = 12;
const MAX_TIME_MS = 2 * 60 * 1000;
const KEEP_TOOL_PAIRS = 6;
const MAX_TOOL_CALLS = 12;
const MAX_TOOL_RESULT_CHARS = 4000;
const TOOL_TIMEOUT_MS = 30000;

function uid(prefix: string) {
  return crypto?.randomUUID
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(output: unknown, extra?: Partial<ToolResult>): ToolResult {
  return { success: true, output, ...extra };
}

function fail(error: string, note?: string): ToolResult {
  return { success: false, error, ...(note ? { note } : {}) };
}

function isWorkspace(ctx: ToolContext) {
  return ctx.executionMode === 'workspace' && !!ctx.workspaceRoot;
}

function normPath(p: unknown): string {
  return String(p || '').replace(/^\/+/, '').replace(/\\/g, '/').trim();
}

function buildPreviewHtml(files: Record<string, string>, entry = 'index.html'): string | null {
  const html = files[entry] || files['index.html'] || files['index.htm'];
  if (!html) {
    const js = Object.entries(files).filter(([f]) => f.endsWith('.js') && !f.startsWith('__'));
    const css = Object.entries(files).filter(([f]) => f.endsWith('.css') && !f.startsWith('__'));
    if (!js.length && !css.length) return null;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
${css.map(([f, c]) => `<style>/* ${f} */\n${c}</style>`).join('\n')}
</head><body>
${js.map(([f, c]) => `<script>/* ${f} */\n${c}</script>`).join('\n')}
</body></html>`;
  }
  let result = html;
  for (const [file, content] of Object.entries(files)) {
    if (file.startsWith('__')) continue;
    const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (file.endsWith('.css')) {
      result = result.replace(
        new RegExp(`<link[^>]+href=["']${esc}["'][^>]*/?>`, 'i'),
        `<style>/* ${file} */\n${content}</style>`
      );
    }
    if (file.endsWith('.js')) {
      result = result.replace(
        new RegExp(`<script([^>]+)src=["']${esc}["'][^>]*>\\s*</script>`, 'i'),
        (_, attrs) => `<script${attrs.replace(/\s*src=["'][^"']*["']/, '') || ''}>\n${content}</script>`
      );
    }
  }
  return result;
}

function buildHtmlReport(
  title: string,
  sections: Array<{ title?: string; heading?: string; content?: string }>,
  opts: { theme?: 'light' | 'dark' } = {}
): string {
  const dark = opts.theme === 'dark';
  const bg = dark ? '#111827' : '#ffffff';
  const fg = dark ? '#f3f4f6' : '#111827';
  const accent = dark ? '#60a5fa' : '#2563eb';
  const cardBg = dark ? '#1f2937' : '#f9fafb';
  const body = sections.map((s, i) => {
    const heading = s.title || s.heading || `Section ${i + 1}`;
    const content = (s.content || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<section style="margin:2rem 0;padding:1.5rem;background:${cardBg};border-radius:10px;border-left:4px solid ${accent}">
      <h2 style="color:${accent};margin:0 0 1rem">${heading}</h2>
      <div style="line-height:1.75;white-space:pre-wrap">${content}</div>
    </section>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:${bg};color:${fg};max-width:900px;margin:0 auto;padding:2rem}
h1{color:${accent};font-size:2rem;margin-bottom:2rem;border-bottom:2px solid ${accent};padding-bottom:0.5rem}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}

function buildMarkdownReport(
  title: string,
  sections: Array<{ title?: string; heading?: string; content?: string }>
): string {
  return `# ${title}\n\n` + sections.map(s => {
    const heading = s.title || s.heading || 'Section';
    return `## ${heading}\n\n${s.content || ''}\n`;
  }).join('\n');
}

function getWsFiles(ctx: ToolContext): WorkspaceFile[] {
  if (!ctx.workspaceFiles) ctx.workspaceFiles = [];
  return ctx.workspaceFiles;
}

function upsertWsFile(ctx: ToolContext, path: string, size = 0) {
  const files = getWsFiles(ctx);
  const idx = files.findIndex(f => f.path === path);
  const entry: WorkspaceFile = {
    path, name: path.split('/').pop() || path,
    size, type: path.split('.').pop()?.toLowerCase() || 'text', status: 'ready'
  };
  if (idx >= 0) files[idx] = entry; else files.unshift(entry);
}

async function readWsText(path: string, ctx: ToolContext): Promise<string> {
  if (!ctx.workspaceRoot) throw new Error('No workspace root');
  if (path in ctx.files) return ctx.files[path];
  const content = await readWorkspaceFile(ctx.workspaceRoot, path);
  ctx.files[path] = content;
  upsertWsFile(ctx, path, content.length);
  return content;
}

function globToRegex(pat: string): RegExp {
  const esc = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  return new RegExp(`^${esc}$`);
}

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function', function: {
        name: 'web_search',
        description: 'Search the web for up-to-date information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            mode: { type: 'string', description: 'Depth mode: "search" (fast), "deep" (thorough), or "max" (exhaustive)' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'fetch_url',
        description: 'Fetch and read content from a URL.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'URL to fetch' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'read_file',
        description: 'Read a file from the sandbox or workspace.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'write_file',
        description: 'Create or overwrite a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'File content' },
            mode: { type: 'string', description: 'Write mode: "overwrite" (default), "append", or "create" (fails if exists)' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'delete_file',
        description: 'Delete a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'list_files',
        description: 'List all files in the sandbox or workspace.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string', description: 'Glob filter (optional)' } }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'search_files',
        description: 'Search for text across files.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text or regex' },
            caseSensitive: { type: 'boolean' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'preview_project',
        description: 'Build an HTML preview of project files. Call after writing HTML/CSS/JS files.',
        parameters: {
          type: 'object',
          properties: { entryPoint: { type: 'string', description: 'Entry HTML file (default: index.html)' } }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_report',
        description: 'Create a formatted report document (HTML or Markdown) as an artifact.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Report title' },
            sections: {
              type: 'array',
              description: 'Array of {title, content} objects',
              items: { type: 'object' }
            },
            format: { type: 'string', description: 'Output format: "html" or "markdown"' },
            path: { type: 'string', description: 'Output file path' },
            theme: { type: 'string', description: 'Color theme for HTML reports: "light" or "dark"' }
          },
          required: ['title', 'sections']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'query_knowledge',
        description: 'Search indexed documents attached to the conversation.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            topK: { type: 'number', description: 'Max results (default 5)' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'calculator',
        description: 'Evaluate a mathematical expression safely.',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Math expression to evaluate (e.g., "123 * 456 + 789", "Math.sqrt(144) + Math.pow(2, 10)")' }
          },
          required: ['expression']
        }
      }
    },
  ];
}

const STEP_TYPE: Record<string, AgentStep['type']> = {
  web_search: 'searching', fetch_url: 'searching',
  query_knowledge: 'reading',
  read_file: 'reading', list_files: 'reading', search_files: 'reading',
  write_file: 'writing', delete_file: 'writing',
  preview_project: 'preview', create_report: 'writing',
  calculator: 'tool',
};

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  ctx.signal?.throwIfAborted?.();

  switch (name) {

    case 'web_search': {
      const query = String(args.query || '');
      const mode = (['search', 'deep', 'max'] as const).includes(args.mode as 'search' | 'deep' | 'max')
        ? (args.mode as 'search' | 'deep' | 'max') : 'search';
      try {
        const res = await webSearch({ query, deep: mode !== 'search', mode });
        if (res.error) {
          return fail(res.error,
            'Web search is unavailable right now. Answer from your training knowledge and note you could not search the web.');
        }
        return ok({ query, results: res.results.slice(0, 10).map(r => ({ title: r.title, url: r.url, snippet: r.snippet?.slice(0, 300) })), context: res.context?.slice(0, 3000) });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e),
          'Web search threw an exception. Answer from training knowledge and note you could not search the web.');
      }
    }

    case 'fetch_url': {
      const url = String(args.url || '');
      if (!url) return fail('Missing url');
      try {
        if (isTauri()) {
          const res = await fetchUrlContent(url, 50000);
          if (res.error) return fail(res.error);
          const content = String(res.content || '').slice(0, 12000);
          return ok({
            url: res.url,
            title: res.title,
            excerpt: res.excerpt,
            content,
            links: (res.links || []).slice(0, 80),
            site_name: res.site_name,
            og_image: res.og_image,
            status: res.status,
            truncated: res.truncated,
            warning: res.warning
          });
        }
        const res = await webSearch({ query: url, deep: true, mode: 'deep' });
        const content = (res.results || []).filter(r => r.url === url || r.snippet)
          .map(r => r.snippet || '').filter(Boolean).join('\n\n').slice(0, 8000);
        return ok({ url, content: content || res.context || 'Could not extract content' });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }

    case 'read_file': {
      const path = normPath(args.path);
      if (!path) return fail('Missing path');
      if (isWorkspace(ctx)) {
        try {
          const content = await readWsText(path, ctx);
          return ok({ path, content, size: content.length });
        } catch (e) { return fail(String((e as Error)?.message || e)); }
      }
      if (!(path in ctx.files)) return fail(`File not found: ${path}`);
      return ok({ path, content: ctx.files[path], size: ctx.files[path].length });
    }

    case 'write_file': {
      const path = normPath(args.path);
      const content = String(args.content || '');
      const mode = String(args.mode || 'overwrite');
      if (!path) return fail('Missing path');
      if (isWorkspace(ctx)) {
        if (!ctx.workspaceRoot) return fail('No workspace root');
        let finalContent = content;
        if (mode === 'append') {
          try { finalContent = (await readWsText(path, ctx)) + '\n' + content; } catch { /* new file */ }
        }
        await writeWorkspaceFile(ctx.workspaceRoot, path, finalContent);
        ctx.files[path] = finalContent;
        upsertWsFile(ctx, path, finalContent.length);
        const existed = getWsFiles(ctx).some(f => f.path === path);
        return ok({ path, size: finalContent.length, mode }, { [existed ? 'modifiedFiles' : 'createdFiles']: [path] });
      }
      const existed = path in ctx.files;
      if (mode === 'create' && existed) return fail(`File already exists: ${path}. Use mode overwrite.`);
      ctx.files[path] = mode === 'append' && existed ? ctx.files[path] + '\n' + content : content;
      return ok({ path, size: ctx.files[path].length, mode }, { [existed ? 'modifiedFiles' : 'createdFiles']: [path] });
    }

    case 'delete_file': {
      const path = normPath(args.path);
      if (!path) return fail('Missing path');
      if (isWorkspace(ctx)) {
        if (!ctx.workspaceRoot) return fail('No workspace root');
        await deleteWorkspaceFile(ctx.workspaceRoot, path);
        delete ctx.files[path];
        if (ctx.workspaceFiles) ctx.workspaceFiles = ctx.workspaceFiles.filter(f => f.path !== path);
        return ok({ path }, { deletedFiles: [path] });
      }
      if (!(path in ctx.files)) return fail(`File not found: ${path}`);
      delete ctx.files[path];
      return ok({ path }, { deletedFiles: [path] });
    }

    case 'list_files': {
      if (isWorkspace(ctx)) {
        let files = [...getWsFiles(ctx)];
        const pattern = String(args.pattern || '');
        if (pattern) { const re = globToRegex(pattern); files = files.filter(f => re.test(f.path)); }
        files.sort((a, b) => a.path.localeCompare(b.path));
        return ok({ files: files.map(f => ({ path: f.path, size: f.size, type: f.type })), count: files.length });
      }
      let paths = Object.keys(ctx.files).filter(p => !p.startsWith('__')).sort();
      const pattern = String(args.pattern || '');
      if (pattern) { const re = globToRegex(pattern); paths = paths.filter(p => re.test(p)); }
      return ok({ files: paths.map(p => ({ path: p, size: ctx.files[p].length, type: p.split('.').pop() || 'unknown' })), count: paths.length });
    }

    case 'search_files': {
      const query = String(args.query || '');
      if (!query) return fail('query required');
      const cs = args.caseSensitive === true;
      const re = new RegExp(query, cs ? 'g' : 'gi');
      const targets = isWorkspace(ctx)
        ? getWsFiles(ctx).map(f => f.path)
        : Object.keys(ctx.files).filter(p => !p.startsWith('__'));
      const results: Array<{ file: string; line: number; content: string }> = [];
      for (const file of targets.slice(0, 120)) {
        ctx.signal?.throwIfAborted?.();
        try {
          const lines = (isWorkspace(ctx) ? await readWsText(file, ctx) : ctx.files[file]).split('\n');
          lines.forEach((l, i) => { re.lastIndex = 0; if (re.test(l)) results.push({ file, line: i + 1, content: l.trim().slice(0, 200) }); });
        } catch { /* skip */ }
      }
      return ok({ query, results: results.slice(0, 100), totalMatches: results.length });
    }

    case 'preview_project': {
      const entry = String(args.entryPoint || 'index.html');
      const html = buildPreviewHtml(ctx.files, entry);
      if (!html) return ok({ message: 'No HTML entry point found', files: Object.keys(ctx.files).filter(f => !f.startsWith('__')) });
      ctx.files['__preview__.html'] = html;
      return ok({ preview: true, entryPoint: entry });
    }

    case 'create_report': {
      const title = String(args.title || 'Report');
      const sections = Array.isArray(args.sections) ? args.sections as Array<{ title?: string; heading?: string; content?: string }> : [];
      const format = String(args.format || 'markdown');
      const theme = (args.theme === 'dark' ? 'dark' : 'light') as 'light' | 'dark';
      const path = normPath(args.path) || (format === 'html' ? 'report.html' : 'report.md');
      const content = format === 'html'
        ? buildHtmlReport(title, sections, { theme })
        : buildMarkdownReport(title, sections);
      if (isWorkspace(ctx) && ctx.workspaceRoot) {
        await writeWorkspaceFile(ctx.workspaceRoot, path, content);
        ctx.files[path] = content;
      } else {
        ctx.files[path] = content;
        if (format === 'html') ctx.files['__preview__.html'] = content;
      }
      return ok({ title, format, path, sections: sections.length }, { createdFiles: [path] });
    }

    case 'query_knowledge': {
      try {
        const result = await queryDocuments({ query: String(args.query || ''), chat_id: ctx.chatId, top_k: Math.min(Number(args.topK) || 5, 20) });
        return ok({ results: result.results.map(r => ({ text: r.chunk.text.slice(0, 500), score: r.score })), context: result.context?.slice(0, 3000) });
      } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    }

    case 'calculator': {
      const expression = String(args.expression || '');
      if (!expression) return fail('Missing expression');
      try {
        // Safe eval: allow only math operators, numbers, functions, and whitespace
        const sanitized = expression.replace(/[^0-9+\-*/().%\sMath\.\w,]/g, '');
        const result = Function(`"use strict"; return (${sanitized})`)();
        return ok({ expression, result: Number.isFinite(result) ? result : String(result) });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

async function executeToolWithTimeout(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ToolResult>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS / 1000}s`));
    }, TOOL_TIMEOUT_MS);
  });

  // Cancel timeout on abort
  const onAbort = () => { if (timeoutId) clearTimeout(timeoutId); };
  ctx.signal?.addEventListener?.('abort', onAbort, { once: true });

  const toolArgsStr = JSON.stringify(args).slice(0, 120);
  console.log(`[agent] tool START | name=${name} | args=${toolArgsStr}`);
  const t0 = performance.now();

  try {
    const result = await Promise.race([executeTool(name, args, ctx), timeoutPromise]);
    const duration = Math.round(performance.now() - t0);
    console.log(`[agent] tool DONE | name=${name} | success=${result.success} | duration=${duration}ms`);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const duration = Math.round(performance.now() - t0);
    if (msg.includes('timed out')) {
      console.log(`[agent] tool TIMEOUT | name=${name} | duration=${duration}ms`);
    }
    return fail(msg);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    ctx.signal?.removeEventListener?.('abort', onAbort);
  }
}

function buildArtifact(ctx: ToolContext): AgentArtifact | null {
  const visible = Object.keys(ctx.files).filter(f => !f.startsWith('__'));
  if (!visible.length) return null;
  return {
    title: `Agent workspace (${visible.length} file${visible.length === 1 ? '' : 's'})`,
    files: { ...ctx.files },
    previewHtml: ctx.files['__preview__.html'] ?? null
  };
}

function synthesizeArtifactCompletion(ctx: ToolContext): string {
  const visible = Object.keys(ctx.files)
    .filter((path) => !path.startsWith('__'))
    .sort((a, b) => a.localeCompare(b));
  if (!visible.length) return '';

  const previewable = visible.some((path) => path.endsWith('.html')) || !!ctx.files['__preview__.html'];
  const listed = visible.slice(0, 4).join(', ');
  const extra = visible.length > 4 ? ` and ${visible.length - 4} more` : '';

  if (previewable) {
    return `Done. I created ${listed}${extra} and prepared a preview.`;
  }
  return `Done. I created ${listed}${extra}.`;
}

function hasVisibleArtifact(ctx: ToolContext): boolean {
  return Object.keys(ctx.files).some((path) => !path.startsWith('__')) || !!ctx.files['__preview__.html'];
}

function isWebsiteBuildRequest(prompt: string): boolean {
  const normalized = String(prompt || '');
  if (!normalized) return false;
  return /\b(website|web\s*site|webpage|web\s*page|landing\s*page|landing|site|homepage|index\.html|html|css|javascript|script\.js)\b/i.test(normalized);
}

function finalizeAgentSteps(steps: AgentStep[], hasError: boolean) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.status !== 'running') continue;
    if (hasError) {
      step.status = 'error';
      if (!step.detail) step.detail = 'Stopped before completion';
      continue;
    }
    step.status = 'done';
    if (index === steps.length - 1 && step.type === 'thinking') {
      step.label = 'Completed';
      step.detail = 'Response ready';
    }
  }
}

function trimContext(messages: RequestMessage[], nativeMode: boolean) {
  const sys = messages.filter(m => m.role === 'system');
  const users = messages.filter(m => m.role === 'user');
  const rest = messages.filter(m => m.role !== 'system' && m.role !== 'user');

  const keepCount = KEEP_TOOL_PAIRS;
  const keepUsers = 3;
  const keepFirstUser = 1;

  let trimmed = rest;
  if (rest.length > keepCount) {
    trimmed = rest.slice(rest.length - keepCount);
  }

  let trimmedUsers = users;
  if (users.length > keepUsers) {
    trimmedUsers = [
      ...users.slice(0, keepFirstUser),
      ...users.slice(users.length - (keepUsers - keepFirstUser))
    ];
  }

  messages.splice(0, messages.length, ...sys, ...trimmedUsers, ...trimmed);
}

async function enforceTokenBudget(messages: RequestMessage[], config: any) {
  // Skip if there are very few messages — no risk of overflow
  if (messages.length <= 6) return;

  const contextLength = config?.llm?.providers?.[config?.llm?.provider]?.context_length
    || config?.llm?.local?.context_length
    || 8192;

  if (!isTauri()) {
    // Non-Tauri: use rough heuristic to check if trim is needed
    const totalChars = messages.reduce((sum, m) =>
      sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
    if (totalChars <= contextLength * 2.5) return;
  }

  try {
    const budget = await invoke<any>('build_context_budget', {
      config: { context_length: contextLength, max_tokens: contextLength },
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : ''),
        ...(m.name ? { name: m.name } : {})
      }))
    });

    if (budget?.isOverflow || (budget?.usagePercent ?? 0) > 80) {
      const truncated = await invoke<any>('truncate_messages', {
        messages: budget.isOverflow
          ? messages.map(m => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : ''),
              ...(m.name ? { name: m.name } : {})
            }))
          : [],
        budget
      });

      if (Array.isArray(truncated) && truncated.length > 0 && truncated.length < messages.length) {
        console.log(`[agent] Token budget: trimmed ${messages.length} → ${truncated.length} messages (${budget.usagePercent}% used)`);
        messages.splice(0, messages.length, ...truncated);
      }
    }
  } catch (err) {
    console.warn('[agent] Token budget enforcement failed, continuing with structural trim only:', err);
  }
}

function parseXmlToolCall(content: string): { toolCall: ToolCall | null; cleanContent: string } {
  const tagMatch = content.match(/<tool_call[\s\S]*?>([\s\S]*?)<\/tool_call>/i);
  if (!tagMatch) return { toolCall: null, cleanContent: content.trim() };
  const inner = tagMatch[1];
  const jsonStart = inner.indexOf('{');
  if (jsonStart === -1) return { toolCall: null, cleanContent: content.trim() };
  let depth = 0;
  let jsonEnd = -1;
  let inString = false;
  let escaped = false;
  for (let i = jsonStart; i < inner.length; i++) {
    const c = inner[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }
  if (jsonEnd === -1) return { toolCall: null, cleanContent: content.trim() };
  const jsonStr = inner.slice(jsonStart, jsonEnd + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed.name !== 'string') throw new Error('missing name');
    return {
      toolCall: { name: parsed.name, arguments: parsed.arguments || parsed.args || {} },
      cleanContent: content.replace(tagMatch[0], '').trim()
    };
  } catch {
    return { toolCall: null, cleanContent: content.trim() };
  }
}

function parseToolCallCodeblocks(content: string): { toolCalls: ToolCall[]; cleanContent: string } {
  const fenceRegex = /```tool_call\s*\n([\s\S]*?)\n```/gi;
  let match;
  let clean = content;
  const allCalls: ToolCall[] = [];
  while ((match = fenceRegex.exec(content)) !== null) {
    const inner = match[1].trim();
    const json = extractBalancedJson(inner);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item.name === 'string') {
            allCalls.push({ name: item.name, arguments: item.arguments || item.args || {} });
          }
        }
      } else if (typeof parsed.name === 'string') {
        allCalls.push({ name: parsed.name, arguments: parsed.arguments || parsed.args || {} });
      }
    } catch { /* ignore */ }
  }
  if (allCalls.length) {
    clean = content.replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '').trim();
  }
  return { toolCalls: allCalls, cleanContent: clean };
}

function extractBalancedJson(str: string): string | null {
  let start = -1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{' || str[i] === '[') { start = i; break; }
  }
  if (start === -1) return null;
  const opener = str[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === opener) depth++;
    else if (c === closer) { depth--; if (depth === 0) { return str.slice(start, i + 1); } }
  }
  return null;
}

const DEBUG_LINE_RE = /^\[(?:agent|chat-api|agent-llm|TTS|OcrEngine|onboarding)\][\s\S]*$/gm;

function stripAgentDebugLines(content: string): string {
  return content.replace(DEBUG_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function stripInternalAgentChatter(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/tool call limit|over the limit|preparing to use tools|i will need to provide the answer|❌|used \d+ tools/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripToolPayloads(content: string): string {
  return content
    .replace(/Tool call for\s+[a-z_]+:\s*\{[\s\S]*?\}\s*(?=\n[A-Z]|\n[a-zA-Z][^\n]*:|$)/gi, '')
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeAgentVisibleText(content: string): string {
  return stripToolPayloads(stripInternalAgentChatter(stripAgentDebugLines(content)));
}

function stripToolCallArtifacts(content: string): string {
  return content
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '')
    .trim();
}

const CODEBLOCK_EXT_MAP: Record<string, string> = {
  html: 'index.html', css: 'style.css', js: 'script.js', ts: 'script.ts',
  svg: 'icon.svg', json: 'data.json', xml: 'config.xml',
  py: 'script.py', bash: 'run.sh', sh: 'run.sh',
  yaml: 'config.yaml', yml: 'config.yml', toml: 'config.toml',
  txt: 'readme.txt', md: 'readme.md'
};

function parseCodeblockWrites(content: string): Array<{ path: string; code: string }> {
  const matches = content.matchAll(/```(\w+)\s*\n([\s\S]*?)```/g);
  const files: Array<{ path: string; code: string }> = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const lang = m[1].toLowerCase();
    const code = m[2].trim();
    if (!code) continue;
    const ext = CODEBLOCK_EXT_MAP[lang];
    if (ext && !seen.has(ext)) {
      seen.add(ext);
      files.push({ path: ext, code });
    }
  }
  return files;
}

function getNativeSystemPrompt(extra?: string): string {
  const base = [
    'You are an AI agent. Use tools to complete tasks; never output code or file contents in chat text.',
    `You have ${MAX_TOOL_CALLS} tool uses maximum. After that, write your final answer in plain text.`,
    'Stop after you have enough information. Do not over-search or over-verify.',
    'If a tool fails twice, stop using that tool and work around it or answer from knowledge.',
    'Do not repeat the same tool with similar arguments. If stuck, give your best answer.',
    '',
    'Workflow: web_search \u2192 gather info \u2192 create_report OR write_file \u2192 preview_project.',
    'For final answer, write plain text with no tool calls.',
  ].join('\n');
  return extra ? `${base}\n\n${extra}` : base;
}

function getXmlSystemPrompt(extra?: string): string {
  const essentialTools = getToolDefinitions()
    .map(t => {
      const params = Object.keys(t.function.parameters.properties || {});
      return `${t.function.name}(${params.join(', ')}) - ${t.function.description}`;
    }).join('\n');

  const base = [
    'You are an AI agent. Call tools using this XML format (one per response):',
    '',
    '<tool_call',
    '{"name":"web_search","arguments":{"query":"your search"}}',
    '</tool_call',
    '',
    'Tools:',
    essentialTools,
    '',
    'RULES:',
    `1. Max ${MAX_TOOL_CALLS} tool calls total. Then give final answer in plain text.`,
    '2. Never dump code or file content in chat. Use write_file or create_report tools.',
    '3. If a tool fails twice, stop retrying and answer from knowledge.',
    '4. Chain tools logically: search \u2192 read \u2192 write \u2192 preview.',
    '5. For final answer, write plain text with NO tool_call tag.',
  ].join('\n');
  return extra ? `${base}\n\n${extra}` : base;
}

const DEPENDENT_TOOLS: Set<string> = new Set(['preview_project']);

function groupParallelAndSequential(toolCalls: ToolCall[]): ToolCall[][] {
  const groups: ToolCall[][] = [];
  let currentBatch: ToolCall[] = [];

  for (const tc of toolCalls) {
    if (DEPENDENT_TOOLS.has(tc.name)) {
      if (currentBatch.length) groups.push(currentBatch);
      groups.push([tc]);
      currentBatch = [];
    } else {
      currentBatch.push(tc);
    }
  }
  if (currentBatch.length) groups.push(currentBatch);

  return groups.length ? groups : [toolCalls];
}

export async function runAgentTask(args: {
  chatId: string;
  systemPrompt?: string;
  messages: RequestMessage[];
  rawPrompt?: string;
  executionMode?: 'workspace' | 'sandbox';
  workspaceRoot?: string;
  workspaceName?: string;
  workspaceFiles?: WorkspaceFile[];
  onStep: (steps: AgentStep[]) => void;
  onProgress?: (text: string) => void;
  onReasoning?: (value: string) => void;
  onArtifact: (artifact: AgentArtifact | null) => void;
  onSources?: (sources: SearchResult[]) => void;
  signal?: AbortSignal;
}): Promise<{ content: string; reasoning: string; steps: AgentStep[]; artifact: AgentArtifact | null; sources: SearchResult[]; error?: string; warning?: string }> {

  const steps: AgentStep[] = [];
  const sources: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const executionMode = args.executionMode || 'sandbox';
  const ctx: ToolContext = {
    chatId: args.chatId,
    files: {},
    workspaceRoot: args.workspaceRoot,
    workspaceFiles: args.workspaceFiles ? [...args.workspaceFiles] : undefined,
    executionMode,
    signal: args.signal,
    onArtifact: args.onArtifact,
  };

  const config = await loadAppConfig();
  const providerName = config.llm?.provider || 'openai';
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || {};
  let useNativeTools = isTauri() && agentSupportsNativeTools(config);
  console.log(`[agent] START | provider=${providerName} | model=${provider.model || ''} | isTauri=${isTauri()} | useNativeTools=${useNativeTools}`);
  console.log(`[agent] supportsNativeTools check: providerName=${providerName} modelId=${provider.model || ''} result=${agentSupportsNativeTools(config)}`);
  let nativeFailed = false;
  let directMode = false;
  let consecutiveEmptyResponses = 0;
  const wantsWebsiteArtifact = isWebsiteBuildRequest(
    args.rawPrompt || [...args.messages].reverse().find((message) => message.role === 'user')?.content?.toString?.() || ''
  );

  const toolDefs = getToolDefinitions();
  const modeNote = executionMode === 'workspace'
    ? 'You are attached to a real workspace folder. File operations are persistent.'
    : 'You are in sandbox mode. Files exist only within this session unless exported.';
  const nativeSys = getNativeSystemPrompt([modeNote, args.systemPrompt].filter(Boolean).join('\n\n'));
  const xmlSys = getXmlSystemPrompt([modeNote, args.systemPrompt].filter(Boolean).join('\n\n'));
  const directSys = `You are a helpful assistant. Respond directly to the user's request. When building websites, output HTML, CSS, and JS inside markdown code blocks with language labels (\`\`\`html, \`\`\`css, \`\`\`js). For website or page-building requests, your work is not complete until you provide code blocks that can be written to files and previewed. Produce complete, well-formatted content.${modeNote ? '\n\n' + modeNote : ''}`;

  const messages: RequestMessage[] = [
    { role: 'system', content: useNativeTools ? nativeSys : xmlSys },
    ...args.messages
  ];

  let finalContent = '';
  let finalReasoning = '';
  let errorReason: string | undefined;
  let warningReason: string | undefined;
  const startTime = Date.now();
  const recentSigs: string[] = [];
  let totalToolCalls = 0;

  const checkAbort = () => {
    if (args.signal?.aborted) {
      throw new DOMException('Agent task cancelled by user', 'AbortError');
    }
  };

  const throwIfAborted = () => {
    args.signal?.throwIfAborted?.();
  };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    console.log(`[agent] iter=${iter} | nativeActive=${useNativeTools && !nativeFailed && !directMode} | nativeFailed=${nativeFailed} | directMode=${directMode} | messageCount=${messages.length}`);
    checkAbort();
    throwIfAborted();
    if (Date.now() - startTime > MAX_TIME_MS) {
      errorReason = errorReason || 'Agent timed out after 3 minutes.';
      break;
    }

    const thinkStep: AgentStep = {
      id: uid('step'), type: 'thinking',
      label: iter === 0 ? 'Planning' : 'Thinking',
      status: 'running',
      detail: `Step ${iter + 1} of ${MAX_ITERATIONS}`
    };
    steps.push(thinkStep);
    args.onStep([...steps]);
    if (iter === 0) {
      args.onProgress?.(`Planning how to approach this\u2026`);
    }

    trimContext(messages, useNativeTools && !nativeFailed);
    await enforceTokenBudget(messages, config);

    const sysCount = messages.filter(m => m.role === 'system').length;
    const userCount = messages.filter(m => m.role === 'user').length;
    const otherCount = messages.filter(m => m.role !== 'system' && m.role !== 'user').length;
    console.log(`[agent] after trim: messageCount=${messages.length} | sysCount=${sysCount} | userCount=${userCount} | otherCount=${otherCount}`);

    const nativeActive = useNativeTools && !nativeFailed && !directMode;
    const callMode = directMode ? 'direct' : nativeActive ? 'native' : 'xml';
    console.log(`[agent] calling LLM via: ${callMode} | toolDefs=${nativeActive ? toolDefs.length : 0} | messages=${messages.length}`);
    let completion;

    const streamingReasoningParts: string[] = [];

    try {
      if (directMode) {
        messages[0] = { role: 'system', content: directSys };
        completion = await completeAssistantReply({ messages, signal: args.signal });
        checkAbort();
      } else if (nativeActive) {
        const streamResult = await agentStreamComplete({
          messages,
          tools: toolDefs,
          signal: args.signal,
          config,
          onReasoning: (text) => {
            streamingReasoningParts.push(text);
            finalReasoning = finalReasoning ? `${finalReasoning}${text}` : text;
            args.onReasoning?.(finalReasoning);
          },
          onContent: (text) => {
            const preview = text.slice(0, 120).trim();
            if (preview) {
              thinkStep.detail = preview.length < text.length ? `${preview}\u2026` : preview;
              args.onStep([...steps]);
            }
          }
        });
        checkAbort();
        if (streamResult === null) {
          nativeFailed = true;
          // Only poison the cache when we know it's a tool rejection —
          // null here can also mean clone errors, network errors, no base_url, etc.
          // The error catch block below handles tool rejections with proper pattern matching.
          messages[0] = { role: 'system', content: xmlSys };
          completion = await completeAssistantReply({ messages, signal: args.signal });
          checkAbort();
        } else {
          completion = streamResult;
        }
      } else {
        completion = await completeAssistantReply({ messages, signal: args.signal });
        checkAbort();
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[agent] LLM ERROR | msg="${errMsg.slice(0, 200)}" | nativeActive=${nativeActive} | iter=${iter}`);
      if (nativeActive && /tool|400|422|unsupported/i.test(errMsg)) {
        console.log('[agent] -> falling back to XML (tool/400/422/unsupported error)');
        nativeFailed = true;
        setToolSupportCache(config, false);
        messages[0] = { role: 'system', content: xmlSys };
        try {
          completion = await completeAssistantReply({ messages, signal: args.signal });
          checkAbort();
        } catch (e2) {
          if (e2 instanceof DOMException && e2.name === 'AbortError') throw e2;
          thinkStep.status = 'error';
          thinkStep.label = 'Error';
          thinkStep.detail = e2 instanceof Error ? e2.message : String(e2);
          args.onStep([...steps]);
          errorReason = thinkStep.detail;
          break;
        }
      } else if (iter < 2 && errMsg.includes('content')) {
        console.log('[agent] -> switching to direct mode (content error, iter < 2)');
        directMode = true;
        messages[0] = { role: 'system', content: directSys };
        try {
          completion = await completeAssistantReply({ messages, signal: args.signal });
          checkAbort();
        } catch (e3) {
          thinkStep.status = 'error';
          thinkStep.label = 'Error';
          thinkStep.detail = e3 instanceof Error ? e3.message : String(e3);
          args.onStep([...steps]);
          errorReason = thinkStep.detail;
          break;
        }
      } else {
        console.log('[agent] -> HARD FAIL (non-recoverable LLM error)');
        thinkStep.status = 'error';
        thinkStep.label = 'Error';
        thinkStep.detail = errMsg;
        args.onStep([...steps]);
        errorReason = errMsg;
        break;
      }
    }

    const rawContent = sanitizeAgentVisibleText(String(completion.content || ''));
    const reasoning = sanitizeAgentVisibleText(String(completion.reasoning || ''));
    const resultMode = directMode ? 'direct' : (useNativeTools && !nativeFailed) ? 'native' : 'xml';
    console.log(`[agent] LLM result | contentLen=${rawContent.length} | reasoningLen=${reasoning.length} | toolCalls=${completion.toolCalls?.length ?? 0} | mode=${resultMode}`);
    if (reasoning) {
      finalReasoning = finalReasoning ? `${finalReasoning}\n${reasoning}` : reasoning;
      args.onReasoning?.(finalReasoning);
    }

    if (!rawContent && !completion.toolCalls?.length && !directMode) {
      consecutiveEmptyResponses++;
      console.log(`[agent] EMPTY RESPONSE | consecutiveEmpty=${consecutiveEmptyResponses} | nativeFailed=${nativeFailed} | nativeActive=${useNativeTools && !nativeFailed} | directMode=${directMode} | totalToolCalls=${totalToolCalls} | completionToolCalls=${completion.toolCalls?.length ?? 0}`);
      const synthesized = synthesizeArtifactCompletion(ctx);
      if (synthesized && totalToolCalls > 0) {
        console.log('[agent] -> synthesizing artifact from file outputs');
        finalContent = synthesized;
        break;
      }
      if (consecutiveEmptyResponses >= 2) {
        console.log('[agent] -> switching to directMode (2 consecutive empty responses)');
        directMode = true;
        messages[0] = { role: 'system', content: directSys };
        thinkStep.detail = 'Switching to direct mode (tools unavailable)';
        args.onStep([...steps]);
        continue;
      }
      if (!nativeFailed && nativeActive) {
        console.log('[agent] -> falling back to XML mode (native returned empty)');
        nativeFailed = true;
        messages[0] = { role: 'system', content: xmlSys };
        thinkStep.detail = 'Falling back to XML mode';
        args.onStep([...steps]);
        continue;
      }
      console.log('[agent] -> HARD FAIL: Empty response - model may not support tool calling');
      steps.push({
        id: uid('step'), type: 'error', label: 'Empty response',
        status: 'error', detail: 'The model returned an empty response. The model may not support tool calling.'
      });
      args.onStep([...steps]);
      errorReason = 'The model returned an empty response.';
      break;
    }
    consecutiveEmptyResponses = 0;

    let toolCalls: ToolCall[] = [];
    let cleanContent = rawContent;

    if (directMode) {
      const codeblockFiles = parseCodeblockWrites(rawContent);
      if (codeblockFiles.length) {
        toolCalls = codeblockFiles.map((f, i) => ({
          id: `auto-write-${i}`,
          name: 'write_file',
          arguments: { path: f.path, content: f.code }
        }));
        const hasHtml = codeblockFiles.some(f => f.path === 'index.html' || f.path.endsWith('.html'));
        if (hasHtml) {
          toolCalls.push({
            id: 'auto-preview',
            name: 'preview_project',
            arguments: { entryPoint: 'index.html' }
          });
        }
        cleanContent = stripToolCallArtifacts(rawContent.replace(/```[\s\S]*?```/g, '').trim());
        messages.push({ role: 'assistant', content: cleanContent || 'Files generated.' });
        totalToolCalls = MAX_TOOL_CALLS;
      } else {
        if (wantsWebsiteArtifact && !hasVisibleArtifact(ctx)) {
          steps.push({
            id: uid('step'),
            type: 'error',
            label: 'Missing website files',
            status: 'error',
            detail: 'The model described the website but did not provide code blocks or files.'
          });
          args.onStep([...steps]);
          errorReason = 'The model did not produce website files.';
          break;
        }
        messages.push({ role: 'assistant', content: rawContent });
        finalContent = stripToolCallArtifacts(rawContent);
        break;
      }
    } else if (nativeActive && !nativeFailed && completion.toolCalls?.length) {
      toolCalls = completion.toolCalls.map((tc: NativeToolCall) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }));
      messages.push({
        role: 'assistant',
        content: rawContent || null,
        tool_calls: toolCalls.map(tc => ({ id: tc.id!, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }))
      });
    } else {
      const xmlResult = parseXmlToolCall(rawContent);
      if (xmlResult.toolCall) {
        toolCalls = [xmlResult.toolCall];
        cleanContent = stripToolCallArtifacts(xmlResult.cleanContent);
        messages.push({ role: 'assistant', content: cleanContent || 'Preparing to use tools\u2026' });
        if (nativeActive && !nativeFailed) nativeFailed = true;
      } else {
        const cbResult = parseToolCallCodeblocks(rawContent);
        if (cbResult.toolCalls.length) {
          toolCalls = cbResult.toolCalls;
          cleanContent = stripToolCallArtifacts(cbResult.cleanContent);
          messages.push({ role: 'assistant', content: cleanContent || 'Preparing to use tools\u2026' });
          if (nativeActive && !nativeFailed) nativeFailed = true;
        } else {
          const codeblockFiles = parseCodeblockWrites(rawContent);
          if (codeblockFiles.length) {
            toolCalls = codeblockFiles.map((f, i) => ({
              id: `auto-write-${i}`,
              name: 'write_file',
              arguments: { path: f.path, content: f.code }
            }));
            const hasHtml = codeblockFiles.some(f => f.path === 'index.html' || f.path.endsWith('.html'));
            if (hasHtml) {
              toolCalls.push({
                id: `auto-preview`,
                name: 'preview_project',
                arguments: { entryPoint: 'index.html' }
              });
            }
            cleanContent = stripToolCallArtifacts(rawContent.replace(/```[\s\S]*?```/g, '').trim());
            messages.push({ role: 'assistant', content: cleanContent || 'Files have been written and are ready for preview.' });
            if (nativeActive && !nativeFailed) nativeFailed = true;
          }
        }
      }
    }

    const parseMode = directMode ? 'codeblocks' : (nativeActive && !nativeFailed) ? 'native' : 'xml/codeblocks';
    console.log(`[agent] parsed ${toolCalls.length} toolCalls from ${parseMode} mode${toolCalls.length ? ': ' + toolCalls.map(t => t.name).join(', ') : ''}`);
    thinkStep.status = 'done';
    thinkStep.detail = toolCalls.length ? `Using: ${toolCalls.map(t => t.name).join(', ')}` : 'Producing answer';

    if (toolCalls.length && cleanContent && cleanContent.length > 10 && !directMode) {
      const trimmed = cleanContent.slice(0, 240).replace(/\|+$/g, '').trim();
      if (trimmed) {
        steps.push({
          id: uid('step'), type: 'thinking', label: 'Reasoning',
          status: 'done',
          detail: trimmed.length < cleanContent.length ? trimmed + '\u2026' : trimmed
        });
      }
    }

    args.onStep([...steps]);

    if (!toolCalls.length) {
      if (rawContent) {
        if (wantsWebsiteArtifact && !hasVisibleArtifact(ctx)) {
          if (!directMode) {
            directMode = true;
            messages[0] = { role: 'system', content: directSys };
            messages.push({
              role: 'user',
              content: 'You must actually create the website files now. Output complete code blocks for index.html and any needed style.css or script.js. Do not say the work is done unless you provide the file contents.'
            });
            thinkStep.detail = 'Switching to direct website build mode';
            args.onStep([...steps]);
            continue;
          }
          steps.push({
            id: uid('step'),
            type: 'error',
            label: 'Missing website files',
            status: 'error',
            detail: 'The model answered without creating previewable website files.'
          });
          args.onStep([...steps]);
          errorReason = 'The model answered without creating website files.';
          break;
        }
        args.onProgress?.('Producing final answer\u2026');
        finalContent = stripToolCallArtifacts(rawContent);
        break;
      }
      const synthesized = synthesizeArtifactCompletion(ctx);
      if (synthesized && totalToolCalls > 0) {
        finalContent = synthesized;
        break;
      }
      steps.push({
        id: uid('step'), type: 'error', label: 'Empty response',
        status: 'error', detail: 'The model returned an empty response. The model may be temporarily unavailable or the prompt may exceed context capacity.'
      });
      args.onStep([...steps]);
      errorReason = 'The model returned an empty response.';
      break;
    }

    totalToolCalls += toolCalls.filter((toolCall) => toolCall.name !== 'preview_project').length;

    if (totalToolCalls >= MAX_TOOL_CALLS) {
      steps.push({
        id: uid('step'), type: 'error', label: 'Tool limit reached',
        status: 'error', detail: `Used ${totalToolCalls} tools. Forcing final answer.`
      });
      args.onStep([...steps]);
      messages.push({ role: 'user', content: `You have used ${totalToolCalls} tools. You MUST stop using tools and provide your final answer now based on everything gathered.` });
      try {
        const fallback = await completeAssistantReply({ messages, signal: args.signal });
        finalContent = String(fallback.content || '').trim() || synthesizeArtifactCompletion(ctx) || 'The agent used many tools but could not synthesize a final answer.';
      } catch {
        finalContent = synthesizeArtifactCompletion(ctx) || 'The agent used many tools but could not synthesize a final answer.';
      }
      if (!finalContent) finalContent = 'The agent used many tools but could not synthesize a final answer.';
      warningReason = warningReason || `Agent reached the tool call limit (${MAX_TOOL_CALLS}) and returned the best available result.`;
      break;
    }

    if (iter >= 8) {
      messages.push({ role: 'user', content: 'You are running out of steps. Provide your final answer in the next response. Do NOT call any more tools.' });
    }

    const sig = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.arguments)}`).join('|');
    const toolNames = toolCalls.map(tc => tc.name);
    recentSigs.push(sig);
    if (recentSigs.length > 6) recentSigs.shift();
    const recentNames = recentSigs.flatMap(s => {
      const parts = s.split('|');
      return parts.map(p => p.split(':')[0]);
    });
    const nameCounts = new Map<string, number>();
    for (const name of recentNames) {
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }
    let stuckTool: string | null = null;
    for (const [name, count] of nameCounts) {
      if (count >= 3 && recentNames.length >= 3) {
        stuckTool = name;
        break;
      }
    }
    if (!stuckTool && recentNames.length >= 6) {
      const last6 = recentNames.slice(-6);
      const isTwoToolCycle = last6.length === 6 && new Set(last6).size === 2 &&
        last6[0] === last6[2] && last6[2] === last6[4] &&
        last6[1] === last6[3] && last6[3] === last6[5];
      if (isTwoToolCycle) {
        stuckTool = `${last6[0]} \u2194 ${last6[1]}`;
      }
    }
    if (stuckTool) {
      steps.push({
        id: uid('step'), type: 'error', label: 'Loop detected \u2014 stopping',
        status: 'error', detail: `Repeated calls to ${stuckTool}`
      });
      args.onStep([...steps]);
      messages.push({ role: 'user', content: `You have called "${stuckTool}" multiple times without making progress. Stop using tools and provide your best answer now based on what you know.` });
      try {
        const fallback = await completeAssistantReply({ messages, signal: args.signal });
        finalContent = String(fallback.content || '').trim() || synthesizeArtifactCompletion(ctx) || 'The agent encountered a loop and could not complete the task.';
      } catch {
        finalContent = synthesizeArtifactCompletion(ctx) || 'The agent encountered a loop and could not complete the task.';
      }
      warningReason = 'Agent encountered a loop and returned the best available result.';
      break;
    }

    // Execute tool calls with parallel grouping
    const groups = groupParallelAndSequential(toolCalls);
    for (const group of groups) {
      if (group.length === 1) {
        // Single tool — execute directly
        const tc = group[0];
        await executeSingleTool(tc, steps, ctx, args, messages, sources, seenUrls, nativeActive, nativeFailed);
      } else {
        // Multiple independent tools — execute in parallel
        args.onProgress?.(`Running ${group.length} tools in parallel\u2026`);
        const results = await Promise.allSettled(
          group.map(async (tc) => {
            const toolStep: AgentStep = {
              id: uid('step'),
              type: STEP_TYPE[tc.name] || 'tool',
              label: tc.name.replace(/_/g, ' '),
              status: 'running',
              detail: tc.name === 'write_file'
                ? `path: ${String(tc.arguments.path || '').slice(0, 120)}`
                : Object.keys(tc.arguments).length
                  ? Object.entries(tc.arguments).slice(0, 3).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(', ')
                  : undefined
            };
            return { tc, toolStep, result: await executeToolWithTimeout(tc.name, tc.arguments, ctx) };
          })
        );

        // Process all results
        for (const entry of results) {
          if (entry.status === 'rejected') continue;
          const { tc, toolStep, result } = entry.value;

          if (result.nextTurnMods?.disableNativeTools) nativeFailed = true;
          if (result.nextTurnMods?.instructions) {
            messages[0] = { role: 'system', content: result.nextTurnMods.instructions };
          }
          if (result.nextTurnMods?.injectMessages) {
            messages.push(...result.nextTurnMods.injectMessages);
          }

          if (tc.name === 'web_search' && result.success) {
            const output = result.output as { results?: Array<{ title: string; url: string; snippet?: string }> } | undefined;
            let added = false;
            for (const r of output?.results ?? []) {
              if (r.url && !seenUrls.has(r.url)) {
                seenUrls.add(r.url);
                sources.push({ title: r.title || r.url, url: r.url, snippet: r.snippet || '' });
                added = true;
              }
            }
            if (added) args.onSources?.([...sources]);
          }

          toolStep.status = result.success ? 'done' : 'error';
          if (!result.success && result.note) {
            toolStep.detail = `${result.error} \u2014 ${result.note.slice(0, 120)}`;
            toolStep.output = result.error;
          } else if (!result.success) {
            toolStep.detail = result.error?.slice(0, 200);
            toolStep.output = result.error || '';
          } else {
            toolStep.detail = undefined;
            const out = result.output as Record<string, unknown> | undefined;
            if (out && typeof out === 'object') {
              const lines: string[] = [];
              for (const [k, v] of Object.entries(out)) {
                if (typeof v === 'string') lines.push(`${k}: ${v.slice(0, 200)}`);
              }
              toolStep.output = lines.join('\n') || JSON.stringify(out, null, 2);
            }
          }

          steps.push(toolStep);

          const artifact = buildArtifact(ctx);
          args.onArtifact(artifact);

          let resultPayload = result.success
            ? (result.note ? { ...result.output as object, _note: result.note } : result.output)
            : { error: result.error, ...(result.note ? { note: result.note } : {}) };
          const rawResultJson = JSON.stringify(resultPayload);
          if (rawResultJson.length > MAX_TOOL_RESULT_CHARS) {
            resultPayload = { _truncated: true, _summary: rawResultJson.slice(0, MAX_TOOL_RESULT_CHARS) + '\u2026(truncated)', _result: 'ok' };
          }

          if (nativeActive && !nativeFailed && tc.id) {
            messages.push({ role: 'tool', content: JSON.stringify(resultPayload), tool_call_id: tc.id, name: tc.name });
          } else {
            messages.push({ role: 'user', content: `Tool result for ${tc.name}:\n${JSON.stringify(resultPayload, null, 2)}` });
          }
        }
        args.onStep([...steps]);
      }
    }
  }

  if (!finalContent) {
    if (finalReasoning) {
      finalContent = finalReasoning;
      errorReason = errorReason || 'Agent could not synthesize a structured final answer, but produced reasoning.';
    } else {
      finalContent = 'The agent reached the iteration limit without producing a final answer. Try a more specific prompt or a model with better tool-calling capabilities.';
      errorReason = errorReason || 'Agent reached iteration limit without producing a final answer.';
    }
  }

  finalContent = sanitizeAgentVisibleText(finalContent);
  finalReasoning = sanitizeAgentVisibleText(finalReasoning);
  finalizeAgentSteps(steps, !!errorReason);

  console.log(`[agent] EXIT | contentLen=${finalContent.length} | steps=${steps.length} | error=${errorReason || 'none'} | warning=${warningReason || 'none'}`);

  return {
    content: finalContent,
    reasoning: finalReasoning,
    steps,
    artifact: buildArtifact(ctx),
    sources,
    ...(errorReason ? { error: errorReason } : {}),
    ...(warningReason ? { warning: warningReason } : {})
  };
}

async function executeSingleTool(
  tc: ToolCall,
  steps: AgentStep[],
  ctx: ToolContext,
  args: any,
  messages: RequestMessage[],
  sources: SearchResult[],
  seenUrls: Set<string>,
  nativeActive: boolean,
  nativeFailed: boolean
) {
  args.onProgress?.(`Running ${tc.name.replace(/_/g, ' ')}\u2026`);

  const toolStep: AgentStep = {
    id: uid('step'),
    type: STEP_TYPE[tc.name] || 'tool',
    label: tc.name.replace(/_/g, ' '),
    status: 'running',
    detail: tc.name === 'write_file'
      ? `path: ${String(tc.arguments.path || '').slice(0, 120)}`
      : Object.keys(tc.arguments).length
        ? Object.entries(tc.arguments).slice(0, 3).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(', ')
        : undefined
  };
  steps.push(toolStep);
  args.onStep([...steps]);

  const result = await executeToolWithTimeout(tc.name, tc.arguments, ctx);
  ctx.signal?.throwIfAborted?.();

  if (result.nextTurnMods?.disableNativeTools) {
    nativeFailed = true;
  }
  if (result.nextTurnMods?.instructions) {
    messages[0] = { role: 'system', content: result.nextTurnMods.instructions };
  }
  if (result.nextTurnMods?.injectMessages) {
    messages.push(...result.nextTurnMods.injectMessages);
  }

  if (tc.name === 'web_search' && result.success) {
    const output = result.output as { results?: Array<{ title: string; url: string; snippet?: string }> } | undefined;
    let added = false;
    for (const r of output?.results ?? []) {
      if (r.url && !seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        sources.push({ title: r.title || r.url, url: r.url, snippet: r.snippet || '' });
        added = true;
      }
    }
    if (added) args.onSources?.([...sources]);
  }

  toolStep.status = result.success ? 'done' : 'error';
  if (!result.success && result.note) {
    toolStep.detail = `${result.error} \u2014 ${result.note.slice(0, 120)}`;
    toolStep.output = result.error;
  } else if (!result.success) {
    toolStep.detail = result.error?.slice(0, 200);
    toolStep.output = result.error || '';
  } else {
    toolStep.detail = undefined;
    const out = result.output as Record<string, unknown> | undefined;
    if (out && typeof out === 'object') {
      const lines: string[] = [];
      for (const [k, v] of Object.entries(out)) {
        if (typeof v === 'string') lines.push(`${k}: ${v.slice(0, 200)}`);
      }
      toolStep.output = lines.join('\n') || JSON.stringify(out, null, 2);
    }
  }

  const artifact = buildArtifact(ctx);
  args.onArtifact(artifact);
  args.onStep([...steps]);

  let resultPayload = result.success
    ? (result.note ? { ...result.output as object, _note: result.note } : result.output)
    : { error: result.error, ...(result.note ? { note: result.note } : {}) };
  const rawResultJson = JSON.stringify(resultPayload);
  if (rawResultJson.length > MAX_TOOL_RESULT_CHARS) {
    resultPayload = { _truncated: true, _summary: rawResultJson.slice(0, MAX_TOOL_RESULT_CHARS) + '\u2026(truncated)', _result: 'ok' };
  }

  if (nativeActive && !nativeFailed && tc.id) {
    messages.push({ role: 'tool', content: JSON.stringify(resultPayload), tool_call_id: tc.id, name: tc.name });
  } else {
    messages.push({ role: 'user', content: `Tool result for ${tc.name}:\n${JSON.stringify(resultPayload, null, 2)}` });
  }
}
