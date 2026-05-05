import type { AgentStep, AgentArtifact, AgentOutcome, AgentStopReason, WorkspaceFile } from '$lib/types/chat';
import type { SearchResult } from '$lib/types/tauri';
import type { RequestMessage, ToolDefinition, NativeToolCall } from '$lib/services/chat-api';
import { completeAssistantReply, setToolSupportCache } from '$lib/services/chat-api';
import { agentComplete, agentStreamComplete, supportsNativeTools as agentSupportsNativeTools } from '$lib/services/agent-llm';
import { webSearch, fetchUrlContent } from '$lib/services/search';
import { queryDocuments } from '$lib/services/rag';
import { loadAppConfig } from '$lib/utils/storage';
import { isTauri, invoke } from '$lib/services/tauri';
import {
  createDocxArtifactFile, createPdfArtifactFile, createPptxArtifactFile, createXlsxArtifactFile,
  createWorkProductArtifactFiles,
  validateGeneratedDocumentArgs,
  type GeneratedArtifactFile
} from '$lib/services/generated-documents';
import { viewerPathFor } from '$lib/utils/artifact-files';
import {
  readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceFile,
} from '$lib/services/files';

type ToolCall = { id?: string; name: string; arguments: Record<string, unknown> };

type AgentTaskResult = {
  content: string;
  reasoning: string;
  steps: AgentStep[];
  artifact: AgentArtifact | null;
  sources: SearchResult[];
  outcome: AgentOutcome;
  stopReason: AgentStopReason;
  publicFallback?: boolean;
  diagnosticsRedacted?: boolean;
  error?: string;
  warning?: string;
};

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

type ToolObservation = {
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  summary: string;
  sources?: SearchResult[];
  createdFiles?: string[];
};

type ToolContext = {
  chatId: string;
  files: Record<string, string>;
  conversationContext?: string;
  workspaceRoot?: string;
  workspaceFiles?: WorkspaceFile[];
  executionMode: 'sandbox' | 'workspace';
  debugLogs?: boolean;
  signal?: AbortSignal;
  onArtifact: (a: AgentArtifact | null) => void;
  workProduct?: AgentArtifact['workProduct'];
};

const DEFAULT_MAX_ITERATIONS = 10;
const LOCAL_DEFAULT_MAX_ITERATIONS = 7;
const MAX_TIME_MS = 2 * 60 * 1000;
const KEEP_TOOL_PAIRS = 6;
const TOOL_CALLS_PER_STEP = 3;
const LOCAL_TOOL_CALLS_PER_STEP = 2;
const MAX_TOOL_RESULT_CHARS = 12000;
const TOOL_TIMEOUT_MS = 30000;
const MAX_TOOL_RETRIES = 1;
const LOOP_STAGNATION_MIN_DRAFT_GROWTH = 120;
const LOW_IMPACT_LOOP_TOOLS = new Set(['list_files', 'read_file', 'search_files']);

type ProgressSnapshot = {
  sourceCount: number;
  visibleFileCount: number;
  draftChars: number;
};

function shouldDebugAgentLogs(config: any): boolean {
  return !!config?.ui?.agent_debug_logs;
}

function debugLog(enabled: boolean, message: string) {
  if (enabled) console.log(message);
}

function getToolCallLimit(maxIterations: number, localMode = false): number {
  return Math.max(maxIterations, maxIterations * (localMode ? LOCAL_TOOL_CALLS_PER_STEP : TOOL_CALLS_PER_STEP));
}

function countBudgetedToolCalls(toolCalls: ToolCall[]): number {
  return toolCalls.filter((toolCall) => toolCall.name !== 'preview_project').length;
}

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

function addGeneratedArtifactFile(ctx: ToolContext, file: GeneratedArtifactFile): ToolResult {
  if (isWorkspace(ctx)) {
    return fail('Office/PDF artifact generation is currently available in chat sandbox mode only.');
  }
  ctx.files[file.path] = file.dataUrl;
  if (file.previewHtml) {
    ctx.files[viewerPathFor(file.path)] = file.previewHtml;
    ctx.files['__preview__.html'] = file.previewHtml;
  }
  return ok(
    { path: file.path, mime: file.mime, size: file.dataUrl.length, preview: !!file.previewHtml },
    { createdFiles: [file.path] }
  );
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
        description: 'Search the web for up-to-date information. The tool automatically receives recent conversation context, so write a focused query and include key entities when helpful.',
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
        description: 'Read a file from the chat sandbox.',
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
        description: 'Create or overwrite a chat sandbox file.',
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
        description: 'Delete a chat sandbox file.',
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
        description: 'List all files in the chat sandbox.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string', description: 'Glob filter (optional)' } }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'search_files',
        description: 'Search for text across chat sandbox files.',
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
        description: 'Build an HTML preview from chat sandbox files. Call after writing HTML/CSS/JS files.',
        parameters: {
          type: 'object',
          properties: { entryPoint: { type: 'string', description: 'Entry HTML file (default: index.html)' } }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_work_product',
        description: 'Create a professional evidence-aware work product from one shared report schema. Use this for multi-format deliverables such as report + DOCX + XLSX + PPTX + PDF.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Work product title' },
            subtitle: { type: 'string', description: 'Optional subtitle' },
            executiveSummary: { type: 'string', description: 'Short evidence-based summary' },
            sections: { type: 'array', description: 'Array of {title, content, bullets, citations}', items: { type: 'object' } },
            tables: { type: 'array', description: 'Optional data tables {name, columns, rows}', items: { type: 'object' } },
            sources: { type: 'array', description: 'Sources used {id,title,url,provider,snippet}', items: { type: 'object' } },
            limitations: { type: 'array', description: 'Known limits, blocked pages, thin evidence, or missing data', items: { type: 'string' } },
            formats: { type: 'array', description: 'Formats to create: md, html, docx, xlsx, pptx, pdf', items: { type: 'string' } },
            path: { type: 'string', description: 'Base output path without extension' }
          },
          required: ['title', 'sections', 'formats']
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
        name: 'create_document',
        description: 'Create a real DOCX document with a built-in preview. Use for reports, research writeups, briefs, essays, and formatted text documents.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Document title' },
            sections: { type: 'array', description: 'Array of {title or heading, content, bullets}', items: { type: 'object' } },
            content: { type: 'string', description: 'Fallback document body when sections are not provided' },
            path: { type: 'string', description: 'Output path ending in .docx' }
          },
          required: ['title']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_spreadsheet',
        description: 'Create a real XLSX workbook with a built-in table viewer. Use for tables, datasets, comparisons, budgets, analysis, and spreadsheet deliverables.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Workbook title' },
            sheets: { type: 'array', description: 'Array of {name, columns, rows}; rows can be objects or arrays', items: { type: 'object' } },
            columns: { type: 'array', description: 'Fallback columns for a single-sheet workbook', items: { type: 'string' } },
            rows: { type: 'array', description: 'Fallback rows for a single-sheet workbook', items: { type: 'object' } },
            path: { type: 'string', description: 'Output path ending in .xlsx' }
          },
          required: ['title']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_presentation',
        description: 'Create a real PPTX slide deck with a built-in slide viewer. Use when the user asks for slides, a deck, or a presentation.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Deck title' },
            slides: { type: 'array', description: 'Array of {title, content or bullets, notes}', items: { type: 'object' } },
            path: { type: 'string', description: 'Output path ending in .pptx' }
          },
          required: ['title', 'slides']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_pdf',
        description: 'Create a PDF document with a built-in PDF viewer. Use when the user explicitly wants a PDF export.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'PDF title' },
            sections: { type: 'array', description: 'Array of {title or heading, content, bullets}', items: { type: 'object' } },
            content: { type: 'string', description: 'Fallback PDF body when sections are not provided' },
            path: { type: 'string', description: 'Output path ending in .pdf' }
          },
          required: ['title']
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
  create_work_product: 'writing', create_document: 'writing', create_spreadsheet: 'writing', create_presentation: 'writing', create_pdf: 'writing',
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
        const res = await webSearch({ query, context: ctx.conversationContext, deep: mode !== 'search', mode });
        if (res.error) {
          return fail(res.error,
            'Web search is unavailable right now. Do not invent current facts; report that live search failed and use only already gathered evidence.');
        }
        return ok({ query, results: res.results.slice(0, 10).map(r => ({ title: r.title, url: r.url, snippet: r.snippet?.slice(0, 250) })), context: res.context?.slice(0, 2000) });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e),
          'Web search threw an exception. Do not invent current facts; report that live search failed and use only already gathered evidence.');
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
            warning: res.warning,
            quality: res.quality
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
      const validation = validateGeneratedDocumentArgs({ title, sections }, [format === 'html' ? 'html' : 'md']);
      if (!validation.ok) {
        return fail(validation.error || 'Document content is too thin.', 'Rebuild the report using gathered evidence. Include real body content, bullets, sources, and limitations instead of only section titles.');
      }
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

    case 'create_work_product': {
      if (!isTauri()) return fail('Professional work product generation requires the desktop app.');
      if (isWorkspace(ctx)) return fail('Professional work products are currently available in chat sandbox mode only.');
      try {
        const formats = Array.isArray(args.formats) ? args.formats.map((format) => String(format)) : ['md'];
        const validation = validateGeneratedDocumentArgs(args, formats);
        if (!validation.ok) {
          return fail(validation.error || 'Document content is too thin.', 'Rebuild the work product from gathered evidence. Include meaningful body content, populated tables/slides, sources, and limitations instead of only titles.');
        }
        const generated = await createWorkProductArtifactFiles(args);
        const createdFiles: string[] = [];
        for (const file of generated.files) {
          ctx.files[file.path] = file.dataUrl;
          createdFiles.push(file.path);
          if (file.previewHtml) ctx.files[viewerPathFor(file.path)] = file.previewHtml;
        }
        const firstPreview = generated.files.find((file) => file.previewHtml)?.previewHtml || generated.html || '';
        if (firstPreview) ctx.files['__preview__.html'] = firstPreview;
        const sourceIds = Array.isArray(args.sources)
          ? args.sources
              .map((source: any, index: number) => String(source?.id || source?.url || source?.title || `source-${index + 1}`).trim())
              .filter(Boolean)
          : [];
        const fileKinds = new Set(generated.files.map((file) => file.path.split('.').pop()?.toLowerCase()).filter(Boolean));
        const workProductKind =
          generated.files.length > 1 ? 'bundle'
          : fileKinds.has('xlsx') ? 'spreadsheet'
          : fileKinds.has('pptx') ? 'presentation'
          : 'report';
        ctx.workProduct = {
          id: uid('work-product'),
          title: String(args.title || 'Work product'),
          kind: workProductKind,
          status: generated.warnings.length ? 'partial' : 'ready',
          files: generated.files.map((file) => ({
            path: file.path,
            title: file.path.split('/').pop() || file.path,
            mime: file.mime,
            kind: file.path.split('.').pop()?.toLowerCase() as any,
            previewPath: file.previewHtml ? viewerPathFor(file.path) : undefined
          })),
          sourceIds,
          evidenceMap: Object.fromEntries(generated.files.map((file) => [file.path, sourceIds])),
          warnings: generated.warnings,
          createdAt: Date.now()
        };
        ctx.onArtifact(buildArtifact(ctx));
        return ok({ title: ctx.workProduct.title, files: createdFiles, warnings: generated.warnings }, { createdFiles });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }

    case 'create_document': {
      if (!isTauri()) return fail('DOCX generation requires the desktop app.');
      try {
        const validation = validateGeneratedDocumentArgs(args, ['docx']);
        if (!validation.ok) return fail(validation.error || 'Document content is too thin.', 'Rebuild the document from gathered evidence with meaningful body content, sources, and limitations.');
        const file = await createDocxArtifactFile(args);
        return addGeneratedArtifactFile(ctx, file);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }

    case 'create_spreadsheet': {
      if (!isTauri()) return fail('XLSX generation requires the desktop app.');
      try {
        const validation = validateGeneratedDocumentArgs(args, ['xlsx']);
        if (!validation.ok) return fail(validation.error || 'Spreadsheet content is too thin.', 'Rebuild the spreadsheet with actual rows from gathered evidence or source rows with limitations.');
        const file = await createXlsxArtifactFile(args);
        return addGeneratedArtifactFile(ctx, file);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }

    case 'create_presentation': {
      if (!isTauri()) return fail('PPTX generation requires the desktop app.');
      try {
        const validation = validateGeneratedDocumentArgs(args, ['pptx']);
        if (!validation.ok) return fail(validation.error || 'Presentation content is too thin.', 'Rebuild the deck with at least one content slide populated from gathered evidence.');
        const file = await createPptxArtifactFile(args);
        return addGeneratedArtifactFile(ctx, file);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }

    case 'create_pdf': {
      if (!isTauri()) return fail('PDF generation requires the desktop app.');
      try {
        const validation = validateGeneratedDocumentArgs(args, ['pdf']);
        if (!validation.ok) return fail(validation.error || 'Document content is too thin.', 'Rebuild the PDF from gathered evidence with meaningful body content, sources, and limitations.');
        const file = await createPdfArtifactFile(args);
        return addGeneratedArtifactFile(ctx, file);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
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

  const onAbort = () => { if (timeoutId) clearTimeout(timeoutId); };

  const toolArgsStr = JSON.stringify(args).slice(0, 120);
  const t0 = performance.now();

  for (let attempt = 1; attempt <= MAX_TOOL_RETRIES + 1; attempt++) {
    const timeoutPromise = new Promise<ToolResult>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS / 1000}s`));
      }, TOOL_TIMEOUT_MS);
    });

    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });

    debugLog(!!ctx.debugLogs, `[agent] tool START | name=${name} | args=${toolArgsStr} | attempt=${attempt}`);
    try {
      const result = await Promise.race([executeTool(name, args, ctx), timeoutPromise]);
      const duration = Math.round(performance.now() - t0);
      if (result.success) {
        debugLog(!!ctx.debugLogs, `[agent] tool DONE | name=${name} | success=true | duration=${duration}ms`);
        return result;
      }
      if (!isRetryableToolFailure(result.error) || attempt > MAX_TOOL_RETRIES) {
        debugLog(!!ctx.debugLogs, `[agent] tool FAIL | name=${name} | attempt=${attempt} | error=${(result.error || '').slice(0, 100)}`);
        return result;
      }
      debugLog(!!ctx.debugLogs, `[agent] tool RETRY | name=${name} | attempt=${attempt}/${MAX_TOOL_RETRIES} | error=${(result.error || '').slice(0, 100)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const duration = Math.round(performance.now() - t0);
      if (msg.includes('timed out')) {
        debugLog(!!ctx.debugLogs, `[agent] tool TIMEOUT | name=${name} | duration=${duration}ms | attempt=${attempt}`);
      }
      if (!isRetryableToolFailure(msg) || attempt > MAX_TOOL_RETRIES) return fail(msg);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      ctx.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  return fail('Tool execution failed after retries');
}

function isRetryableToolFailure(error?: string): boolean {
  const message = String(error || '').toLowerCase();
  if (!message) return false;
  if (
    message.includes('missing ') ||
    message.includes('not found') ||
    message.includes('already exists') ||
    message.includes('invalid ') ||
    message.includes('unsupported')
  ) {
    return false;
  }
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('temporar') ||
    message.includes('unavailable') ||
    message.includes('rate')
  );
}

function buildArtifact(ctx: ToolContext): AgentArtifact | null {
  const visible = Object.keys(ctx.files).filter(f => !f.startsWith('__'));
  if (!visible.length) return null;
  return {
    title: ctx.workProduct?.title || (visible.length === 1 ? visible[0] : 'Generated documents'),
    files: { ...ctx.files },
    previewHtml: ctx.files['__preview__.html'] ?? null,
    workProduct: ctx.workProduct || null
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

function compactText(value: unknown, max = 900): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sourceRows(sources: SearchResult[]): Array<Record<string, string>> {
  return sources.map((source, index) => ({
    '#': String(index + 1),
    title: source.title || source.url,
    url: source.url,
    snippet: source.snippet || ''
  }));
}

function summarizeToolObservation(name: string, args: Record<string, unknown>, result: ToolResult): ToolObservation {
  const createdFiles = [
    ...(result.createdFiles || []),
    ...(result.modifiedFiles || [])
  ];

  if (!result.success) {
    return {
      name,
      args,
      success: false,
      summary: `${name} failed: ${compactText(result.error || 'Unknown error', 500)}`
    };
  }

  const output = result.output as Record<string, unknown> | undefined;
  if (name === 'web_search' && output && typeof output === 'object') {
    const rawSources = Array.isArray(output.results)
      ? output.results as Array<{ title?: string; url?: string; snippet?: string }>
      : [];
    const foundSources: SearchResult[] = rawSources
      .filter((source) => source.url)
      .map((source) => ({
        title: source.title || source.url || 'Source',
        url: source.url || '',
        snippet: source.snippet || ''
      }));
    const lines = [
      `Search query: ${compactText(output.query || args.query, 180)}`,
      ...foundSources.slice(0, 8).map((source, index) =>
        `${index + 1}. ${source.title} - ${source.url}${source.snippet ? ` - ${compactText(source.snippet, 220)}` : ''}`
      )
    ];
    const context = compactText(output.context, 900);
    return {
      name,
      args,
      success: true,
      summary: `${lines.join('\n')}${context ? `\nContext excerpt: ${context}` : ''}`,
      sources: foundSources,
      createdFiles
    };
  }

  if (name === 'fetch_url' && output && typeof output === 'object') {
    return {
      name,
      args,
      success: true,
      summary: [
        `Fetched URL: ${compactText(output.url || args.url, 220)}`,
        output.title ? `Title: ${compactText(output.title, 180)}` : '',
        output.quality ? `Scrape quality: ${compactText(output.quality, 80)}${output.warning ? ` (${compactText(output.warning, 220)})` : ''}` : '',
        output.excerpt ? `Excerpt: ${compactText(output.excerpt, 350)}` : '',
        output.content ? `Content excerpt: ${compactText(output.content, 900)}` : ''
      ].filter(Boolean).join('\n'),
      createdFiles
    };
  }

  if (createdFiles.length) {
    return {
      name,
      args,
      success: true,
      summary: `${name} created/updated: ${createdFiles.join(', ')}`,
      createdFiles
    };
  }

  return {
    name,
    args,
    success: true,
    summary: `${name} result: ${compactText(JSON.stringify(result.output ?? {}), 900)}`,
    createdFiles
  };
}

function evidenceSources(observations: ToolObservation[], liveSources: SearchResult[]): SearchResult[] {
  const byUrl = new Map<string, SearchResult>();
  for (const source of liveSources) {
    if (source.url) byUrl.set(source.url, source);
  }
  for (const observation of observations) {
    for (const source of observation.sources || []) {
      if (source.url && !byUrl.has(source.url)) byUrl.set(source.url, source);
    }
  }
  return Array.from(byUrl.values());
}

function buildEvidenceText(observations: ToolObservation[], liveSources: SearchResult[]): string {
  const successful = observations.filter((observation) => observation.success && observation.summary);
  const failed = observations.filter((observation) => !observation.success && observation.summary);
  const sources = evidenceSources(observations, liveSources);
  const parts: string[] = [];

  if (sources.length) {
    parts.push('## Sources found');
    parts.push(...sources.slice(0, 12).map((source, index) => {
      const title = source.title || source.url;
      const url = source.url;
      const snippet = source.snippet ? `\n   ${compactText(source.snippet, 350)}` : '';
      return `${index + 1}. [${title}](${url})${snippet}`;
    }));
  }

  if (successful.length) {
    parts.push('## Tool evidence');
    parts.push(...successful.slice(0, 10).map((observation, index) =>
      `${index + 1}. ${observation.summary}`
    ));
  }

  if (failed.length) {
    parts.push('## Tool failures');
    parts.push(...failed.slice(-5).map((observation, index) =>
      `${index + 1}. ${observation.summary}`
    ));
  }

  return parts.join('\n\n').trim();
}

function requestedArtifactKinds(prompt: string): { docx: boolean; xlsx: boolean; pptx: boolean; pdf: boolean } {
  const text = String(prompt || '').toLowerCase();
  return {
    docx: /\b(document|docx|word|report|informe|documento)\b/.test(text),
    xlsx: /\b(excel|xlsx|spreadsheet|workbook|sheet|planilla|hoja de calculo|hoja de cálculo)\b/.test(text),
    pptx: /\b(slide|slides|ppt|pptx|presentation|deck|diapositiva|presentacion|presentación)\b/.test(text),
    pdf: /\b(pdf)\b/.test(text)
  };
}

function requestedArtifactExtensions(prompt: string): string[] {
  const kinds = requestedArtifactKinds(prompt);
  return Object.entries(kinds)
    .filter(([, requested]) => requested)
    .map(([kind]) => kind);
}

function missingRequestedArtifactExtensions(ctx: ToolContext, prompt: string): string[] {
  const visible = Object.keys(ctx.files).filter((path) => !path.startsWith('__')).map((path) => path.toLowerCase());
  return requestedArtifactExtensions(prompt).filter((ext) => !visible.some((path) => path.endsWith(`.${ext}`)));
}

function hasAllRequestedArtifacts(ctx: ToolContext, prompt: string): boolean {
  return missingRequestedArtifactExtensions(ctx, prompt).length === 0;
}

function hasGatheredEvidence(ctx: ToolContext, observations: ToolObservation[], sources: SearchResult[], content = ''): boolean {
  return !!(
    content.trim() ||
    sources.length ||
    observations.some((observation) => observation.success && observation.summary) ||
    hasVisibleArtifact(ctx)
  );
}

function classifyStopReason(reason?: string): AgentStopReason {
  const text = String(reason || '').toLowerCase();
  if (!text) return 'none';
  if (text.includes('timed out') || text.includes('timeout')) return 'timeout';
  if (text.includes('loop') || text.includes('repeated')) return 'loop';
  if (text.includes('tool') && (text.includes('limit') || text.includes('budget'))) return 'tool_limit';
  if (text.includes('iteration')) return 'iteration_limit';
  if (text.includes('requested file') || text.includes('missing requested') || text.includes('artifact')) return 'missing_artifacts';
  return 'error';
}

function stoppedWarning(stopReason: AgentStopReason, reason: string): string {
  switch (stopReason) {
    case 'timeout':
      return 'Agent timed out and returned only gathered evidence.';
    case 'loop':
      return 'Agent encountered a loop and returned only gathered evidence.';
    case 'tool_limit':
      return 'Agent reached the tool limit and returned only gathered evidence.';
    case 'iteration_limit':
      return 'Agent reached the iteration limit and returned only gathered evidence.';
    case 'missing_artifacts':
      return 'Agent stopped because requested files could not all be created.';
    default:
      return reason || 'Agent stopped before normal completion.';
  }
}

function fallbackTitle(prompt: string): string {
  const cleaned = compactText(prompt, 80).replace(/[^\w\s-]/g, '').trim();
  return cleaned || 'Agent evidence summary';
}

async function ensureRequestedArtifactsFromEvidence(params: {
  prompt: string;
  reason: string;
  ctx: ToolContext;
  observations: ToolObservation[];
  sources: SearchResult[];
}): Promise<string[]> {
  const requestedKinds = requestedArtifactKinds(params.prompt);
  const missing = new Set(missingRequestedArtifactExtensions(params.ctx, params.prompt));
  const kinds = {
    docx: requestedKinds.docx && missing.has('docx'),
    xlsx: requestedKinds.xlsx && missing.has('xlsx'),
    pptx: requestedKinds.pptx && missing.has('pptx'),
    pdf: requestedKinds.pdf && missing.has('pdf')
  };
  if (!kinds.docx && !kinds.xlsx && !kinds.pptx && !kinds.pdf) return [];

  const evidence = buildEvidenceText(params.observations, params.sources);
  if (!evidence) return [];

  const title = fallbackTitle(params.prompt);
  const sections = [
    {
      title: 'Summary',
      content: [
        `The agent stopped because ${params.reason}.`,
        'This artifact only includes information gathered during the agent loop.'
      ].join('\n')
    },
    { title: 'Evidence gathered', content: evidence }
  ];
  const created: string[] = [];
  const formats = [
    kinds.docx ? 'docx' : '',
    kinds.xlsx ? 'xlsx' : '',
    kinds.pptx ? 'pptx' : '',
    kinds.pdf ? 'pdf' : ''
  ].filter(Boolean);

  if (formats.length) {
    const result = await executeTool('create_work_product', {
      title,
      path: title,
      executiveSummary: `The agent stopped because ${params.reason}. This partial work product uses only gathered evidence.`,
      sections,
      sources: evidenceSources(params.observations, params.sources).map((source, index) => ({
        id: String(index + 1),
        title: source.title,
        url: source.url,
        provider: source.provider,
        snippet: source.snippet
      })),
      limitations: ['The agent stopped before normal completion.', 'Unverified or unavailable facts were not added.'],
      formats
    }, params.ctx);
    if (result.success) {
      created.push(...(result.createdFiles || []));
      params.ctx.onArtifact(buildArtifact(params.ctx));
      return Array.from(new Set(created));
    }
  }

  const addFile = async (toolName: string, fileArgs: Record<string, unknown>) => {
    const result = await executeTool(toolName, fileArgs, params.ctx);
    if (result.success) {
      created.push(...(result.createdFiles || []));
      return;
    }
    const fallbackPath = normPath(fileArgs.path) || `${title}.md`;
    params.ctx.files[fallbackPath.replace(/\.(docx|xlsx|pptx|pdf)$/i, '.md')] =
      buildMarkdownReport(title, sections);
    created.push(fallbackPath.replace(/\.(docx|xlsx|pptx|pdf)$/i, '.md'));
  };

  if (kinds.docx) {
    await addFile('create_document', {
      title,
      path: `${title}.docx`,
      sections
    });
  }

  if (kinds.xlsx) {
    const rows = sourceRows(evidenceSources(params.observations, params.sources));
    await addFile('create_spreadsheet', {
      title: `${title} - sources`,
      path: `${title}.xlsx`,
      sheets: [{
        name: 'Sources',
        columns: ['#', 'title', 'url', 'snippet'],
        rows: rows.length ? rows : [{ '#': '1', title: 'Evidence', url: '', snippet: compactText(evidence, 500) }]
      }]
    });
  }

  if (kinds.pptx) {
    await addFile('create_presentation', {
      title,
      path: `${title}.pptx`,
      slides: [
        { title: 'What was gathered', content: evidence.split('\n').filter(Boolean).slice(0, 5) },
        { title: 'Sources', content: evidenceSources(params.observations, params.sources).slice(0, 6).map((source) => source.title || source.url) }
      ]
    });
  }

  if (kinds.pdf) {
    await addFile('create_pdf', {
      title,
      path: `${title}.pdf`,
      sections
    });
  }

  params.ctx.onArtifact(buildArtifact(params.ctx));
  return Array.from(new Set(created));
}

async function buildStrictFallbackContent(params: {
  prompt: string;
  reason: string;
  ctx: ToolContext;
  observations: ToolObservation[];
  sources: SearchResult[];
}): Promise<string> {
  const created = await ensureRequestedArtifactsFromEvidence(params);
  const sources = evidenceSources(params.observations, params.sources);
  const visibleFiles = Object.keys(params.ctx.files)
    .filter((path) => !path.startsWith('__'))
    .sort((a, b) => a.localeCompare(b));
  const missing = missingRequestedArtifactExtensions(params.ctx, params.prompt);

  const completedSegments: string[] = [];
  if (sources.length) {
    completedSegments.push(`${sources.length} source${sources.length === 1 ? '' : 's'} gathered`);
  }
  if (visibleFiles.length) {
    completedSegments.push(`${visibleFiles.length} file${visibleFiles.length === 1 ? '' : 's'} available (${visibleFiles.slice(0, 4).join(', ')}${visibleFiles.length > 4 ? ', ...' : ''})`);
  }
  if (created.length) {
    completedSegments.push(`created from evidence: ${Array.from(new Set(created)).join(', ')}`);
  }
  if (!completedSegments.length) {
    completedSegments.push('no reliable evidence was gathered');
  }

  const missingLine = missing.length
    ? `missing requested file type${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
    : 'none';

  return [
    `Agent stopped because ${params.reason}.`,
    `What was completed: ${completedSegments.join('; ')}.`,
    `What is missing: ${missingLine}.`
  ].join('\n');
}

function hasVisibleArtifact(ctx: ToolContext): boolean {
  return Object.keys(ctx.files).some((path) => !path.startsWith('__')) || !!ctx.files['__preview__.html'];
}

function visibleFileCount(ctx: ToolContext): number {
  return Object.keys(ctx.files).filter((path) => !path.startsWith('__')).length;
}

function hasProgressSince(snapshots: ProgressSnapshot[]): boolean {
  if (snapshots.length < 2) return true;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  return (
    last.sourceCount > first.sourceCount ||
    last.visibleFileCount > first.visibleFileCount ||
    (last.draftChars - first.draftChars) >= LOOP_STAGNATION_MIN_DRAFT_GROWTH
  );
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
      step.detail = 'Response ready';
    }
  }
}

function injectEvidenceSummary(messages: RequestMessage[], observations: ToolObservation[], liveSources: SearchResult[]) {
  // Remove any previously injected evidence summary
  const evidenceIdx = messages.findIndex(m => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('=== EVIDENCE SUMMARY ==='));
  if (evidenceIdx >= 0) {
    messages.splice(evidenceIdx, 1);
  }

  const successful = observations.filter(o => o.success && o.summary);
  if (!successful.length && !liveSources.length) return;

  const lines: string[] = ['=== EVIDENCE SUMMARY ==='];
  lines.push('The following facts have been gathered from tool results. Use ONLY this data when creating artifacts or answering:');

  for (const obs of successful.slice(0, 15)) {
    lines.push(`- [${obs.name}] ${compactText(obs.summary, 400)}`);
  }

  for (const src of liveSources.slice(0, 10)) {
    lines.push(`- [source] ${src.title || src.url}: ${compactText(src.snippet || '', 250)}`);
  }

  lines.push('=== END EVIDENCE ===');

  messages.push({ role: 'system', content: lines.join('\n') });
}

function trimContext(messages: RequestMessage[], nativeMode: boolean, keepCount = KEEP_TOOL_PAIRS) {
  const sys = messages.filter(m => m.role === 'system');
  const nonSys = messages.filter(m => m.role !== 'system');

  if (nonSys.length <= keepCount) return;

  // Keep the first user message for long-running context, the newest user
  // message for the active instruction, plus the most recent tool chatter.
  const firstUserIndex = nonSys.findIndex(m => m.role === 'user');
  const firstUser = firstUserIndex >= 0 ? nonSys[firstUserIndex] : null;
  const lastUserIndex = (() => {
    for (let i = nonSys.length - 1; i >= 0; i--) {
      if (nonSys[i].role === 'user') return i;
    }
    return -1;
  })();
  const lastUser = lastUserIndex >= 0 ? nonSys[lastUserIndex] : null;

  const tail = nonSys.slice(-keepCount);

  const result = [...sys];
  if (firstUser && !tail.includes(firstUser)) {
    result.push(firstUser);
  }
  if (lastUser && lastUser !== firstUser && !tail.includes(lastUser)) {
    result.push(lastUser);
  }
  result.push(...tail);

  messages.splice(0, messages.length, ...result);
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
        debugLog(!!config?.ui?.agent_debug_logs, `[agent] Token budget: trimmed ${messages.length} → ${truncated.length} messages (${budget.usagePercent}% used)`);
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
    .filter((line) => !/^\s*\|\s*$/.test(line))
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

function isPublicFallbackContent(content: string): boolean {
  return /^Agent stopped because\b/i.test((content || '').trim());
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

function getNativeSystemPrompt(extra: string | undefined, maxToolCalls: number, maxIterations: number): string {
  const base = [
    'You are an AI agent working inside a chat-scoped sandbox. Use tools to complete tasks; never output code or file contents in chat text.',
    `You have up to ${maxIterations} reasoning steps and a dynamic tool budget of ${maxToolCalls} tool uses. Let the task decide how many tools are needed, then write your final answer in plain text.`,
    'Stop after you have enough information. Do not over-search or over-verify.',
    'If a tool fails twice, stop using that tool and work only from evidence already gathered. Do not invent current facts.',
    'Do not repeat the same tool with similar arguments. After a web_search succeeds, use those results to answer or create the requested artifact instead of searching the same thing again.',
    'If stuck, summarize only the gathered tool results and clearly say what is missing.',
    'Files are not on the host filesystem unless a tool says so. Treat sandbox files as conversation artifacts saved with this chat.',
    '',
    'Workflow: inspect context -> use the smallest useful tool set -> create_work_product for professional reports/files, or create_report/create_document/create_spreadsheet/create_presentation/create_pdf/write_file for simple single-format tasks -> preview_project when useful.',
    'When the user asks for multiple deliverables, research reports, slides, documents, spreadsheets, Excel workbooks, or PDFs, prefer create_work_product so every file is generated from the same evidence-aware report schema.',
    'A professional work product must include an executive summary, structured sections, sources when search was used, and limitations for blocked/thin/partial evidence.',
    'When creating spreadsheets, include actual rows from tool/search evidence. If no rows exist, include a limitations/methodology sheet instead of inventing data.',
    'CRITICAL: When creating spreadsheets, documents, reports, or presentations, you MUST populate them with data from your tool results and web searches. Never fabricate data or create unrelated content. Use the actual facts, numbers, and details from your search results.',
    'If a document/spreadsheet/presentation/PDF tool says content is too thin, do not finalize. Retry once with meaningful body content from gathered evidence, plus sources and limitations when evidence is partial.',
    'For final answer, write plain text with no tool calls and cite only facts found in tool results or user-provided context.',
  ].join('\n');
  return extra ? `${base}\n\n${extra}` : base;
}

function getXmlSystemPrompt(extra: string | undefined, maxToolCalls: number, maxIterations: number): string {
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
    `1. You have up to ${maxIterations} reasoning steps and ${maxToolCalls} tool calls total. Use the tools the task actually needs, then give final answer in plain text.`,
    '2. Never dump code or file content in chat. Use write_file, create_report, create_document, create_spreadsheet, create_presentation, or create_pdf tools.',
    '3. If a tool fails twice, stop retrying and use only evidence already gathered. Do not invent current facts.',
    '4. Chain tools logically: search \u2192 read \u2192 create_work_product/create requested artifact \u2192 final answer. After web_search returns results, use them; do not loop on the same search.',
    '5. CRITICAL: When creating spreadsheets, documents, reports, or presentations, you MUST populate them with data from your tool results and web searches. Never fabricate data or create unrelated content. Include limitations for blocked/thin evidence.',
    '6. If a file creation tool rejects thin content, call the tool again once with real body sections, data rows, or slide bullets from gathered evidence before finalizing.',
    '7. For final answer, write plain text with NO tool_call tag.',
    '8. Files live in the chat sandbox unless a tool explicitly reports a persistent workspace path.',
    '9. If you cannot finish, final answer must say what was actually found and what could not be verified.',
  ].join('\n');
  return extra ? `${base}\n\n${extra}` : base;
}

function buildCurrentRequestReminder(rawPrompt?: string): string {
  const prompt = compactText(rawPrompt, 2000);
  if (!prompt) return '';
  return [
    'CURRENT USER REQUEST (highest priority after system/developer safety):',
    prompt,
    'Keep this request central. If tool results, older chat history, or fallback modes add noise, continue serving this request and the user-supplied instructions.'
  ].join('\n');
}

function buildDirectSystemPrompt(extra: string | undefined): string {
  const base = [
    'You are a helpful assistant. Respond directly to the user\'s request.',
    'When building websites, output HTML, CSS, and JS inside markdown code blocks with language labels (```html, ```css, ```js).',
    'For website or page-building requests, your work is not complete until you provide code blocks that can be written to files and previewed.',
    'Produce complete, well-formatted content.'
  ].join(' ');
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
  conversationContext?: string;
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
  maxIterations?: number;
  maxToolCalls?: number;
}): Promise<AgentTaskResult> {

  const config = await loadAppConfig();
  const debugLogs = shouldDebugAgentLogs(config);
  const steps: AgentStep[] = [];
  const sources: SearchResult[] = [];
  const toolObservations: ToolObservation[] = [];
  const seenUrls = new Set<string>();
  const executionMode = args.executionMode || 'sandbox';
  const ctx: ToolContext = {
    chatId: args.chatId,
    files: {},
    conversationContext: args.conversationContext,
    workspaceRoot: args.workspaceRoot,
    workspaceFiles: args.workspaceFiles ? [...args.workspaceFiles] : undefined,
    executionMode,
    debugLogs,
    signal: args.signal,
    onArtifact: args.onArtifact,
  };

  const backendMode = config.llm?.backend_mode || (isTauri() ? 'local' : 'api');
  const localMode = backendMode === 'local';
  const defaultMaxIterations = localMode ? LOCAL_DEFAULT_MAX_ITERATIONS : DEFAULT_MAX_ITERATIONS;
  const maxIterations = Math.max(1, Math.floor(args.maxIterations ?? defaultMaxIterations));
  const maxToolCalls = Math.max(maxIterations, Math.floor(args.maxToolCalls ?? getToolCallLimit(maxIterations, localMode)));
  const providerName = config.llm?.provider || 'openai';
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || {};
  const activeModel = localMode ? (config.llm?.local?.model || 'local-model') : (provider.model || '');
  let useNativeTools = isTauri() && agentSupportsNativeTools(config);
  debugLog(debugLogs, `[agent] START | backend=${backendMode} | provider=${localMode ? 'local' : providerName} | model=${activeModel} | isTauri=${isTauri()} | useNativeTools=${useNativeTools} | maxIterations=${maxIterations} | maxToolCalls=${maxToolCalls}`);
  debugLog(debugLogs, `[agent] supportsNativeTools check: providerName=${localMode ? 'local' : providerName} modelId=${activeModel} result=${agentSupportsNativeTools(config)}`);
  let nativeFailed = false;
  let directMode = false;
  let consecutiveEmptyResponses = 0;
  const wantsWebsiteArtifact = isWebsiteBuildRequest(
    args.rawPrompt || [...args.messages].reverse().find((message) => message.role === 'user')?.content?.toString?.() || ''
  );

  const toolDefs = getToolDefinitions();
  const modeNote = executionMode === 'workspace'
    ? 'You are attached to a real workspace folder. Only use persistent file operations when the app explicitly enables workspace mode.'
    : 'You are in chat sandbox mode. Files exist only inside this conversation artifact unless the user exports them.';
  const requestReminder = buildCurrentRequestReminder(args.rawPrompt);
  const agentExtra = [modeNote, args.systemPrompt, requestReminder].filter(Boolean).join('\n\n');
  const nativeSys = getNativeSystemPrompt(agentExtra, maxToolCalls, maxIterations);
  const xmlSys = getXmlSystemPrompt(agentExtra, maxToolCalls, maxIterations);
  const directSys = buildDirectSystemPrompt(agentExtra);

  const messages: RequestMessage[] = [
    { role: 'system', content: useNativeTools ? nativeSys : xmlSys },
    ...args.messages
  ];

  let finalContent = '';
  let finalReasoning = '';
  let errorReason: string | undefined;
  let warningReason: string | undefined;
  let stopReason: AgentStopReason = 'none';
  const startTime = Date.now();
  const recentSigs: string[] = [];
  const recentProgress: ProgressSnapshot[] = [];
  let totalToolCalls = 0;
  let maxObservedDraftChars = 0;

  const checkAbort = () => {
    if (args.signal?.aborted) {
      throw new DOMException('Agent task cancelled by user', 'AbortError');
    }
  };

  const throwIfAborted = () => {
    args.signal?.throwIfAborted?.();
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    debugLog(debugLogs, `[agent] iter=${iter} | nativeActive=${useNativeTools && !nativeFailed && !directMode} | nativeFailed=${nativeFailed} | directMode=${directMode} | messageCount=${messages.length}`);
    checkAbort();
    throwIfAborted();
    if (Date.now() - startTime > MAX_TIME_MS) {
      errorReason = errorReason || 'Agent timed out after 3 minutes.';
      stopReason = 'timeout';
      break;
    }

    const thinkStep: AgentStep = {
      id: uid('step'), type: 'thinking',
      label: iter === 0 ? 'Planning' : 'Thinking',
      status: 'running',
      detail: `Step ${iter + 1} of ${maxIterations}`
    };
    steps.push(thinkStep);
    args.onStep([...steps]);
    if (iter === 0) {
      args.onProgress?.(`Planning how to approach this\u2026`);
    }

    trimContext(messages, useNativeTools && !nativeFailed, localMode ? 4 : KEEP_TOOL_PAIRS);
    await enforceTokenBudget(messages, config);

    // Inject evidence summary so the LLM always knows what it has found
    injectEvidenceSummary(messages, toolObservations, sources);

    const sysCount = messages.filter(m => m.role === 'system').length;
    const userCount = messages.filter(m => m.role === 'user').length;
    const otherCount = messages.filter(m => m.role !== 'system' && m.role !== 'user').length;
    debugLog(debugLogs, `[agent] after trim: messageCount=${messages.length} | sysCount=${sysCount} | userCount=${userCount} | otherCount=${otherCount}`);

    const nativeActive = useNativeTools && !nativeFailed && !directMode;
    const callMode = directMode ? 'direct' : nativeActive ? 'native' : 'xml';
    debugLog(debugLogs, `[agent] calling LLM via: ${callMode} | toolDefs=${nativeActive ? toolDefs.length : 0} | messages=${messages.length}`);
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
      debugLog(debugLogs, `[agent] LLM ERROR | msg="${errMsg.slice(0, 200)}" | nativeActive=${nativeActive} | iter=${iter}`);
      if (nativeActive && /tool|400|422|unsupported/i.test(errMsg)) {
        debugLog(debugLogs, '[agent] -> falling back to XML (tool/400/422/unsupported error)');
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
        debugLog(debugLogs, '[agent] -> switching to direct mode (content error, iter < 2)');
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
        console.error('[agent] HARD FAIL (non-recoverable LLM error)', errMsg);
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
    maxObservedDraftChars = Math.max(maxObservedDraftChars, rawContent.length);
    debugLog(debugLogs, `[agent] LLM result | contentLen=${rawContent.length} | reasoningLen=${reasoning.length} | toolCalls=${completion.toolCalls?.length ?? 0} | mode=${resultMode}`);
    if (reasoning) {
      finalReasoning = finalReasoning ? `${finalReasoning}\n${reasoning}` : reasoning;
      args.onReasoning?.(finalReasoning);
    }

    if (!rawContent && !completion.toolCalls?.length && !directMode) {
      consecutiveEmptyResponses++;
      debugLog(debugLogs, `[agent] EMPTY RESPONSE | consecutiveEmpty=${consecutiveEmptyResponses} | nativeFailed=${nativeFailed} | nativeActive=${useNativeTools && !nativeFailed} | directMode=${directMode} | totalToolCalls=${totalToolCalls} | completionToolCalls=${completion.toolCalls?.length ?? 0}`);
      const synthesized = synthesizeArtifactCompletion(ctx);
      if (synthesized && totalToolCalls > 0) {
        debugLog(debugLogs, '[agent] -> synthesizing artifact from file outputs');
        finalContent = synthesized;
        break;
      }
      if (consecutiveEmptyResponses >= 2) {
        debugLog(debugLogs, '[agent] -> switching to directMode (2 consecutive empty responses)');
        directMode = true;
        messages[0] = { role: 'system', content: directSys };
        thinkStep.detail = 'Switching to direct mode (tools unavailable)';
        args.onStep([...steps]);
        continue;
      }
      if (!nativeFailed && nativeActive) {
        debugLog(debugLogs, '[agent] -> falling back to XML mode (native returned empty)');
        nativeFailed = true;
        messages[0] = { role: 'system', content: xmlSys };
        thinkStep.detail = 'Falling back to XML mode';
        args.onStep([...steps]);
        continue;
      }
      console.error('[agent] HARD FAIL: Empty response - model may not support tool calling');
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
        if (!hasAllRequestedArtifacts(ctx, args.rawPrompt || '')) {
          const finalObservation: ToolObservation = {
            name: 'assistant_draft',
            args: {},
            success: true,
            summary: `Assistant draft before artifact enforcement: ${compactText(rawContent, 1400)}`
          };
          const created = await ensureRequestedArtifactsFromEvidence({
            prompt: args.rawPrompt || '',
            reason: 'direct mode tried to finish without creating the requested files',
            ctx,
            observations: [...toolObservations, finalObservation],
            sources
          });
          if (!hasAllRequestedArtifacts(ctx, args.rawPrompt || '')) {
            steps.push({
              id: uid('step'),
              type: 'error',
              label: 'Missing requested files',
              status: 'error',
              detail: `Could not create: ${missingRequestedArtifactExtensions(ctx, args.rawPrompt || '').map((ext) => `.${ext}`).join(', ')}`
            });
            args.onStep([...steps]);
            finalContent = await buildStrictFallbackContent({
              prompt: args.rawPrompt || '',
              reason: 'direct mode tried to finish without creating the requested files',
              ctx,
              observations: [...toolObservations, finalObservation],
              sources
            });
            stopReason = 'missing_artifacts';
            errorReason = 'The agent answered without creating the requested files.';
            break;
          }
          if (created.length) {
            steps.push({
              id: uid('step'),
              type: 'writing',
              label: 'Created requested files',
              status: 'done',
              detail: created.join(', ')
            });
            args.onStep([...steps]);
          }
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
    debugLog(debugLogs, `[agent] parsed ${toolCalls.length} toolCalls from ${parseMode} mode${toolCalls.length ? ': ' + toolCalls.map(t => t.name).join(', ') : ''}`);
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
        if (!hasAllRequestedArtifacts(ctx, args.rawPrompt || '')) {
          const finalObservation: ToolObservation = {
            name: 'assistant_draft',
            args: {},
            success: true,
            summary: `Assistant draft before artifact enforcement: ${compactText(rawContent, 1400)}`
          };
          const created = await ensureRequestedArtifactsFromEvidence({
            prompt: args.rawPrompt || '',
            reason: 'the model tried to finish without creating the requested files',
            ctx,
            observations: [...toolObservations, finalObservation],
            sources
          });
          if (!hasAllRequestedArtifacts(ctx, args.rawPrompt || '')) {
            steps.push({
              id: uid('step'),
              type: 'error',
              label: 'Missing requested files',
              status: 'error',
              detail: `Could not create: ${missingRequestedArtifactExtensions(ctx, args.rawPrompt || '').map((ext) => `.${ext}`).join(', ')}`
            });
            args.onStep([...steps]);
            finalContent = await buildStrictFallbackContent({
              prompt: args.rawPrompt || '',
              reason: 'the model tried to finish without creating the requested files',
              ctx,
              observations: [...toolObservations, finalObservation],
              sources
            });
            stopReason = 'missing_artifacts';
            errorReason = 'The agent answered without creating the requested files.';
            break;
          }
          if (created.length) {
            steps.push({
              id: uid('step'),
              type: 'writing',
              label: 'Created requested files',
              status: 'done',
              detail: created.join(', ')
            });
            args.onStep([...steps]);
          }
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

    const budgetedToolCalls = countBudgetedToolCalls(toolCalls);

    if (totalToolCalls >= maxToolCalls) {
      steps.push({
        id: uid('step'), type: 'error', label: 'Tool limit reached',
        status: 'error', detail: `Used ${totalToolCalls} tools across ${maxIterations} steps. Forcing final answer.`
      });
      args.onStep([...steps]);
      messages.push({ role: 'user', content: `You have used ${totalToolCalls} tools. You MUST stop using tools and provide your final answer now based on everything gathered.` });
      try {
        finalContent = await buildStrictFallbackContent({
          prompt: args.rawPrompt || '',
          reason: `the tool budget was reached (${totalToolCalls}/${maxToolCalls})`,
          ctx,
          observations: toolObservations,
          sources
        });
      } catch {
        finalContent = await buildStrictFallbackContent({
          prompt: args.rawPrompt || '',
          reason: `the tool budget was reached (${totalToolCalls}/${maxToolCalls})`,
          ctx,
          observations: toolObservations,
          sources
        });
      }
      warningReason = warningReason || `Agent reached the dynamic tool call limit (${maxToolCalls}) and returned only gathered evidence.`;
      stopReason = 'tool_limit';
      break;
    }

    if (iter >= Math.max(0, maxIterations - 2)) {
      messages.push({ role: 'user', content: 'You are running out of steps. If you need to create a spreadsheet, document, or other artifact, create it NOW using the data from your search results. Otherwise provide your final answer.' });
    }

    const sig = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.arguments)}`).join('|');
    recentSigs.push(sig);
    if (recentSigs.length > 10) recentSigs.shift();
    recentProgress.push({
      sourceCount: sources.length,
      visibleFileCount: visibleFileCount(ctx),
      draftChars: maxObservedDraftChars
    });
    if (recentProgress.length > 10) recentProgress.shift();

    // Extract full individual calls (name + args) for exact-match detection
    const recentFullCalls = recentSigs.flatMap(s => s.split('|')).filter(Boolean);
    // Extract just names for name-only counting and cycle detection
    const recentNames = recentFullCalls.map(c => c.split(':')[0]);
    const recentWindow = Math.min(recentSigs.length, 6);
    const progressWindow = recentProgress.slice(-Math.max(2, recentWindow));
    const isStagnating = !hasProgressSince(progressWindow);

    let stuckTool: string | null = null;

    // 1. Exact same call (name + identical args) repeated 3+ times = real loop
    const exactCounts = new Map<string, number>();
    for (const call of recentFullCalls) {
      exactCounts.set(call, (exactCounts.get(call) || 0) + 1);
    }
    for (const [call, count] of exactCounts) {
      if (count >= 3) {
        const toolName = call.split(':')[0];
        if (!LOW_IMPACT_LOOP_TOOLS.has(toolName) || isStagnating) {
          stuckTool = toolName;
          break;
        }
      }
    }

    // Only trigger loop stops when repeated calls coincide with stagnation.
    if (!isStagnating) {
      if (stuckTool) {
        debugLog(debugLogs, `[agent] loop guard suppressed for ${stuckTool} because progress is still being made.`);
      }
      stuckTool = null;
    }

    // 2. Same tool name only (different args) repeated enough times = likely stuck.
    // Local models get a tighter guard because each extra loop is much more expensive.
    if (!stuckTool && isStagnating) {
      const repeatedNameLimit = localMode ? 4 : 6;
      const nameCounts = new Map<string, number>();
      for (const name of recentNames) {
        if (name === 'fetch_url' || LOW_IMPACT_LOOP_TOOLS.has(name)) continue;
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      }
      for (const [name, count] of nameCounts) {
        if (count >= repeatedNameLimit) {
          stuckTool = name;
          break;
        }
      }
    }

    // 3. Two-tool alternating cycle (A-B-A-B-A-B)
    if (!stuckTool && isStagnating && recentNames.length >= 6) {
      const last6 = recentNames.slice(-6);
      const isTwoToolCycle = last6.length === 6 && new Set(last6).size === 2 &&
        last6[0] === last6[2] && last6[2] === last6[4] &&
        last6[1] === last6[3] && last6[3] === last6[5];
      if (isTwoToolCycle) {
        const cycleTools = new Set(last6);
        const onlyLowImpact = [...cycleTools].every((name) => LOW_IMPACT_LOOP_TOOLS.has(name));
        if (!onlyLowImpact) {
          stuckTool = `${last6[0]} \u2194 ${last6[1]}`;
        }
      }
    }
    if (stuckTool) {
      steps.push({
        id: uid('step'), type: 'error', label: 'Loop detected \u2014 stopping',
        status: 'error', detail: `Repeated calls to ${stuckTool}`
      });
      args.onStep([...steps]);
      finalContent = await buildStrictFallbackContent({
        prompt: args.rawPrompt || '',
        reason: `it detected repeated calls to ${stuckTool}`,
        ctx,
        observations: toolObservations,
        sources
      });
      warningReason = 'Agent encountered a loop and returned only gathered evidence.';
      stopReason = 'loop';
      break;
    }

    // Execute tool calls with parallel grouping
    const groups = groupParallelAndSequential(toolCalls);
    for (const group of groups) {
      if (group.length === 1) {
        // Single tool — execute directly
        const tc = group[0];
        nativeFailed = await executeSingleTool(tc, steps, ctx, args, messages, sources, seenUrls, toolObservations, nativeActive, nativeFailed);
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

          toolObservations.push(summarizeToolObservation(tc.name, tc.arguments, result));

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

    totalToolCalls += budgetedToolCalls;

    if (directMode && hasVisibleArtifact(ctx)) {
      finalContent = synthesizeArtifactCompletion(ctx) || 'Website files created and preview is ready.';
      break;
    }

    if (totalToolCalls >= maxToolCalls) {
      finalContent = await buildStrictFallbackContent({
        prompt: args.rawPrompt || '',
        reason: `the available tool budget was reached (${totalToolCalls}/${maxToolCalls})`,
        ctx,
        observations: toolObservations,
        sources
      });
      warningReason = warningReason || `Agent reached the dynamic tool call limit (${maxToolCalls}) and returned only gathered evidence.`;
      stopReason = 'tool_limit';
      break;
    }
  }

  if (!finalContent) {
    const reason = stopReason !== 'none' && errorReason
      ? errorReason
      : 'it reached the iteration limit before producing a final answer';
    finalContent = await buildStrictFallbackContent({
      prompt: args.rawPrompt || '',
      reason,
      ctx,
      observations: toolObservations,
      sources
    });
    if (stopReason === 'none') stopReason = 'iteration_limit';
    errorReason = errorReason || 'Agent reached iteration limit without producing a final answer.';
  }

  finalContent = sanitizeAgentVisibleText(finalContent);
  finalReasoning = sanitizeAgentVisibleText(finalReasoning);
  const artifact = buildArtifact(ctx);
  const usefulResult = hasGatheredEvidence(ctx, toolObservations, sources, finalContent);
  const effectiveStopReason = stopReason !== 'none' ? stopReason : classifyStopReason(errorReason || warningReason);
  const outcome: AgentOutcome = errorReason
    ? (usefulResult ? 'stopped' : 'failed')
    : warningReason
      ? 'partial'
      : 'completed';
  const fatalError = outcome === 'failed';
  const effectiveWarning = !fatalError && (warningReason || (effectiveStopReason !== 'none' ? stoppedWarning(effectiveStopReason, errorReason || '') : undefined));

  finalizeAgentSteps(steps, fatalError);

  const exitNotice = effectiveWarning && !fatalError ? effectiveWarning : 'none';
  console.log(`[agent] EXIT | contentLen=${finalContent.length} | steps=${steps.length} | outcome=${outcome} | stopReason=${effectiveStopReason} | error=${fatalError ? (errorReason || 'unknown') : 'none'} | notice=${exitNotice}`);
  const publicFallback = isPublicFallbackContent(finalContent);

  return {
    content: finalContent,
    reasoning: finalReasoning,
    steps,
    artifact,
    sources,
    outcome,
    stopReason: effectiveStopReason,
    publicFallback,
    diagnosticsRedacted: publicFallback,
    ...(fatalError && errorReason ? { error: errorReason } : {}),
    ...(effectiveWarning ? { warning: effectiveWarning } : {})
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
  observations: ToolObservation[],
  nativeActive: boolean,
  nativeFailed: boolean
): Promise<boolean> {
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
  observations.push(summarizeToolObservation(tc.name, tc.arguments, result));

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

  return nativeFailed;
}
