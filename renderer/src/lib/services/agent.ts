/**
 * Agent – self-contained autonomous task runner.
 *
 * All tool logic lives here. No external "cowork" dependencies.
 */

import type { AgentStep, AgentArtifact, WorkspaceFile } from '$lib/types/chat';
import type { SearchResult } from '$lib/types/tauri';
import type { RequestMessage, ToolDefinition, NativeToolCall } from '$lib/services/chat-api';
import { completeAssistantReply, completeWithTools, supportsNativeTools } from '$lib/services/chat-api';
import { webSearch, fetchUrlContent } from '$lib/services/search';
import { queryDocuments } from '$lib/services/rag';
import { sandboxExec } from '$lib/services/sandbox';
import { loadAppConfig } from '$lib/utils/storage';
import { isTauri } from '$lib/services/tauri';
import { sandboxStore } from '$lib/stores/sandbox.svelte';
import {
  browserNavigate, browserSnapshot, browserClick, browserTypeText, formatPageInfo
} from '$lib/services/browser';
import {
  readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceFile,
  renameWorkspaceFile, workspaceExec, createWorkspaceFolder
} from '$lib/services/files';

// ── Types ──────────────────────────────────────────────────────────────────

type ToolCall = { id?: string; name: string; arguments: Record<string, unknown> };

type ToolResult = {
  success: boolean;
  output?: unknown;
  error?: string;
  note?: string;          // guidance for the LLM when a tool fails gracefully
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

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 20;
const MAX_TIME_MS = 3 * 60 * 1000;
const KEEP_TOOL_PAIRS = 6;
const MAX_TOOL_CALLS = 8;

// ── Helpers ────────────────────────────────────────────────────────────────

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

// ── Preview builder ────────────────────────────────────────────────────────

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

// ── Report builders ────────────────────────────────────────────────────────

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

// ── Workspace helpers ──────────────────────────────────────────────────────

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

function applyUnifiedPatch(original: string, patch: string): string {
  const lines = original.split('\n');
  const hunks: Array<{ start: number; rem: string[]; add: string[] }> = [];
  let cur: (typeof hunks)[0] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      if (cur) hunks.push(cur);
      const m = line.match(/@@ -(\d+)/);
      cur = { start: m ? Math.max(+m[1] - 1, 0) : 0, rem: [], add: [] };
    } else if (cur) {
      if (line.startsWith('-') && !line.startsWith('---')) cur.rem.push(line.slice(1));
      else if (line.startsWith('+') && !line.startsWith('+++')) cur.add.push(line.slice(1));
    }
  }
  if (cur) hunks.push(cur);
  for (const h of hunks.reverse()) {
    lines.splice(0, lines.length, ...lines.slice(0, h.start), ...h.add, ...lines.slice(h.start + h.rem.length));
  }
  return lines.join('\n');
}

// ── safeEval ───────────────────────────────────────────────────────────────

function safeEval(code: string): { result: unknown; logs: string[] } {
  const logs: string[] = [];
  const con = {
    log: (...a: unknown[]) => logs.push(a.map(x => JSON.stringify(x)).join(' ')),
    error: (...a: unknown[]) => logs.push('[ERR] ' + a.map(x => JSON.stringify(x)).join(' ')),
    warn: (...a: unknown[]) => logs.push('[WARN] ' + a.map(x => JSON.stringify(x)).join(' ')),
    info: (...a: unknown[]) => logs.push(a.map(x => JSON.stringify(x)).join(' ')),
  };
  try {
    const fn = new Function('console', code.includes('return') ? code : `return (${code})`);
    return { result: fn(con), logs };
  } catch (e) {
    return { result: undefined, logs: [...logs, `[THROW] ${e instanceof Error ? e.message : e}`] };
  }
}

// ── Tool definitions (for the LLM) ─────────────────────────────────────────

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
        name: 'move_file',
        description: 'Move or rename a file.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Current path' },
            destination: { type: 'string', description: 'New path' }
          },
          required: ['source', 'destination']
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
        name: 'apply_patch',
        description: 'Apply a unified diff patch to a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File to patch' },
            patch: { type: 'string', description: 'Unified diff' }
          },
          required: ['path', 'patch']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'run_code',
        description: 'Execute JavaScript code in a sandboxed evaluator. Good for calculations and data processing.',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string', description: 'JavaScript code to run' } },
          required: ['code']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'execute_command',
        description: 'Run a shell command (desktop app only).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command' },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments' },
            timeout: { type: 'number', description: 'Timeout ms (default 30000)' }
          },
          required: ['command']
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
        name: 'browser_navigate',
        description: 'Navigate browser to a URL and return page content (desktop only).',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'URL to navigate to' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_snapshot',
        description: 'Get current browser page state (desktop only).',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_click',
        description: 'Click an element on the current browser page (desktop only).',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string', description: 'CSS selector or visible text' } },
          required: ['selector']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_type',
        description: 'Type text into a field on the browser page (desktop only).',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Field selector' },
            text: { type: 'string', description: 'Text to type' }
          },
          required: ['selector', 'text']
        }
      }
    },
  ];
}

// ── Tool step type map ─────────────────────────────────────────────────────

const STEP_TYPE: Record<string, AgentStep['type']> = {
  web_search: 'searching', fetch_url: 'searching',
  browser_navigate: 'searching', browser_snapshot: 'reading',
  browser_click: 'searching', browser_type: 'writing',
  query_knowledge: 'reading',
  read_file: 'reading', list_files: 'reading', search_files: 'reading',
  write_file: 'writing', delete_file: 'writing', move_file: 'writing',
  apply_patch: 'coding', run_code: 'executing', execute_command: 'executing',
  preview_project: 'preview', create_report: 'writing',
};

// ── Tool executor ──────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (name) {

    // ── Web ──────────────────────────────────────────────────────────────

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

    // ── Files ─────────────────────────────────────────────────────────────

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

    case 'move_file': {
      const src = normPath(args.source);
      const dst = normPath(args.destination);
      if (!src || !dst) return fail('source and destination required');
      if (isWorkspace(ctx)) {
        if (!ctx.workspaceRoot) return fail('No workspace root');
        await renameWorkspaceFile(ctx.workspaceRoot, src, dst);
        if (src in ctx.files) { ctx.files[dst] = ctx.files[src]; delete ctx.files[src]; }
        if (ctx.workspaceFiles) ctx.workspaceFiles = ctx.workspaceFiles.filter(f => f.path !== src);
        upsertWsFile(ctx, dst);
        return ok({ source: src, destination: dst }, { modifiedFiles: [dst], deletedFiles: [src] });
      }
      if (!(src in ctx.files)) return fail(`File not found: ${src}`);
      ctx.files[dst] = ctx.files[src]; delete ctx.files[src];
      return ok({ source: src, destination: dst }, { modifiedFiles: [dst], deletedFiles: [src] });
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
        try {
          const lines = (isWorkspace(ctx) ? await readWsText(file, ctx) : ctx.files[file]).split('\n');
          lines.forEach((l, i) => { re.lastIndex = 0; if (re.test(l)) results.push({ file, line: i + 1, content: l.trim().slice(0, 200) }); });
        } catch { /* skip */ }
      }
      return ok({ query, results: results.slice(0, 100), totalMatches: results.length });
    }

    case 'apply_patch': {
      const path = normPath(args.path);
      const patch = String(args.patch || '');
      if (!path || !patch) return fail('path and patch required');
      if (isWorkspace(ctx)) {
        if (!ctx.workspaceRoot) return fail('No workspace root');
        const original = await readWsText(path, ctx);
        const patched = applyUnifiedPatch(original, patch);
        await writeWorkspaceFile(ctx.workspaceRoot, path, patched);
        ctx.files[path] = patched;
        return ok({ path, patched: true }, { modifiedFiles: [path] });
      }
      if (!(path in ctx.files)) return fail(`File not found: ${path}`);
      ctx.files[path] = applyUnifiedPatch(ctx.files[path], patch);
      return ok({ path, patched: true }, { modifiedFiles: [path] });
    }

    // ── Code ──────────────────────────────────────────────────────────────

    case 'run_code': {
      const code = String(args.code || '');
      const res = safeEval(code);
      return ok({ result: res.result, logs: res.logs });
    }

    case 'execute_command': {
      if (!isTauri()) return fail('Shell commands require the desktop app.');
      try {
        if (isWorkspace(ctx) && ctx.workspaceRoot) {
          const result = await workspaceExec({
            workspace_root: ctx.workspaceRoot,
            command: String(args.command || ''),
            args: Array.isArray(args.args) ? args.args.map(String) : [],
            cwd: normPath(args.cwd),
            shell: true,
            timeout_ms: Math.min(Number(args.timeout) || 30000, 120000)
          });
          return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exit_code, timedOut: result.timed_out });
        }
        const result = await sandboxExec({
          project_name: ctx.chatId,
          files: ctx.files,
          command: String(args.command || ''),
          args: Array.isArray(args.args) ? args.args.map(String) : [],
          shell: true,
          timeout_ms: Math.min(Number(args.timeout) || 30000, 120000),
          preserve: true
        });
        if (result.files) Object.assign(ctx.files, result.files);
        return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exit_code, timedOut: result.timed_out });
      } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    }

    // ── Project & Documents ───────────────────────────────────────────────

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

    // ── Browser ───────────────────────────────────────────────────────────

    case 'browser_navigate': {
      if (!isTauri()) return fail('Browser tools require the desktop app.');
      try { return ok(formatPageInfo(await browserNavigate(String(args.url || '')))); }
      catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    }
    case 'browser_snapshot': {
      if (!isTauri()) return fail('Browser tools require the desktop app.');
      try { return ok(formatPageInfo(await browserSnapshot())); }
      catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    }
    case 'browser_click': {
      if (!isTauri()) return fail('Browser tools require the desktop app.');
      try { return ok(formatPageInfo(await browserClick(String(args.selector || '')))); }
      catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    }
    case 'browser_type': {
      if (!isTauri()) return fail('Browser tools require the desktop app.');
      try { return ok(await browserTypeText(String(args.selector || ''), String(args.text || ''))); }
      catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

// ── Artifact builder ───────────────────────────────────────────────────────

function buildArtifact(ctx: ToolContext): AgentArtifact | null {
  const visible = Object.keys(ctx.files).filter(f => !f.startsWith('__'));
  if (!visible.length) return null;
  return {
    title: `Agent workspace (${visible.length} file${visible.length === 1 ? '' : 's'})`,
    files: { ...ctx.files },
    previewHtml: ctx.files['__preview__.html'] ?? null
  };
}

// ── Context trimmer ────────────────────────────────────────────────────────

function trimContext(messages: RequestMessage[], nativeMode: boolean) {
  // Keep system + recent user + last N tool pairs to avoid token blowup
  const sys = messages.filter(m => m.role === 'system');
  const user = messages.filter(m => m.role === 'user');
  const rest = messages.filter(m => m.role !== 'system' && m.role !== 'user');

  const pairMultiplier = nativeMode ? 2 : 2;
  const keepCount = KEEP_TOOL_PAIRS * pairMultiplier;
  const keepUser = KEEP_TOOL_PAIRS; // cap user messages too (tool results in XML mode)

  let trimmed = rest;
  if (rest.length > keepCount) {
    trimmed = rest.slice(rest.length - keepCount);
  }

  let trimmedUser = user;
  if (user.length > keepUser) {
    trimmedUser = user.slice(user.length - keepUser);
  }

  messages.splice(0, messages.length, ...sys, ...trimmedUser, ...trimmed);
}

// ── XML fallback parser ───────────────────────────────────────────────────

function parseXmlToolCall(content: string): { toolCall: ToolCall | null; cleanContent: string } {
  const tagMatch = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!tagMatch) return { toolCall: null, cleanContent: content.trim() };
  const inner = tagMatch[1];
  // Find balanced JSON object between { and }
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

// ── Tool-call codeblock parser ──────────────────────────────────────────
// Models like Gemma 3 output ```tool_call\n{JSON}\n``` instead of <tool_call> XML.
// This detects those and returns the tool call + cleaned content.

function parseToolCallCodeblocks(content: string): { toolCalls: ToolCall[]; cleanContent: string } {
  // Find ```tool_call ... ``` blocks and extract JSON from them
  const fenceRegex = /```tool_call\s*\n([\s\S]*?)\n```/gi;
  let match;
  let clean = content;
  const allCalls: ToolCall[] = [];
  while ((match = fenceRegex.exec(content)) !== null) {
    const inner = match[1].trim();
    // Extract JSON (object or array) with balanced brackets
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

// ── Tool-call artifact stripper ─────────────────────────────────────────
// Removes any remaining <tool_call> tags or ```tool_call``` fences from content
// so they never leak to the user.

function stripToolCallArtifacts(content: string): string {
  return content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '')
    .trim();
}

// ── Codeblock auto-extraction ────────────────────────────────────────────
// When non-tool models output markdown codeblocks, auto-extract them as files.

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

// ── System prompts ────────────────────────────────────────────────────────

function getNativeSystemPrompt(extra?: string): string {
  const base = [
    'You are an autonomous AI agent with tools for web search, file management, coding, and more.',
    'Use the MINIMUM number of tool calls needed. Batch related work. Avoid unnecessary exploration.',
    'You may call at most ' + MAX_TOOL_CALLS + ' tools total. After that, you MUST provide your final answer.',
    'After all tool calls are done, produce a clear, complete final answer in plain text.',
    'For research tasks: use web_search, then create_report to produce a structured artifact.',
    'For web projects: write HTML/CSS/JS files, then call preview_project.',
    'For calculations: use run_code.',
    'If a tool fails, adapt: answer from knowledge or try an alternative approach. Do not retry the same failing call.',
    'NEVER call the same tool more than twice with similar arguments. If results are insufficient, answer with what you have.',
  ].join('\n');
  return extra ? `${extra}\n\n${base}` : base;
}

function getXmlSystemPrompt(extra?: string): string {
  const tools = getToolDefinitions().map(t => {
    const params = Object.keys(t.function.parameters.properties || {});
    return `${t.function.name}(${params.join(', ')}) — ${t.function.description}`;
  }).join('\n');
  const base = [
    'You are an autonomous AI agent. Call ONE tool at a time using this XML format:',
    '<tool_call>',
    '{"name":"tool_name","arguments":{"key":"value"}}',
    '</tool_call>',
    '',
    'Available tools:',
    tools,
    '',
    'You may call at most ' + MAX_TOOL_CALLS + ' tools total. After that, you MUST provide your final answer in plain text with NO tool_call block.',
    'After a tool result, call the next tool OR write your final answer (plain text, no tool_call block).',
    'If a tool fails, adapt or answer from knowledge. Do not loop on the same failing call.',
    'NEVER call the same tool more than twice with similar arguments. If results are insufficient, answer with what you have.',
  ].join('\n');
  return extra ? `${extra}\n\n${base}` : base;
}

// ── Main agent loop ───────────────────────────────────────────────────────

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
  const isApiMode = config.llm?.backend_mode !== 'local' || !isTauri();
  const providerName = config.llm?.provider || 'openai';
  const providerModel = config.llm?.providers?.[providerName]?.model || '';
  let useNativeTools = isApiMode && supportsNativeTools(providerModel, providerName);
  let nativeFailed = false;

  const toolDefs = getToolDefinitions();
  const modeNote = executionMode === 'workspace'
    ? 'You are attached to a real workspace folder. File operations are persistent.'
    : 'You are in sandbox mode. Files exist only within this session unless exported.';
  const nativeSys = getNativeSystemPrompt([modeNote, args.systemPrompt].filter(Boolean).join('\n\n'));
  const xmlSys = getXmlSystemPrompt([modeNote, args.systemPrompt].filter(Boolean).join('\n\n'));

  const messages: RequestMessage[] = [
    { role: 'system', content: useNativeTools ? nativeSys : xmlSys },
    ...args.messages
  ];

  let finalContent = '';
  let finalReasoning = '';
  let errorReason: string | undefined;
  const startTime = Date.now();
  const recentSigs: string[] = [];
  let totalToolCalls = 0;

  const checkAbort = () => {
    if (args.signal?.aborted) {
      const err = new DOMException('Agent task cancelled by user', 'AbortError');
      throw err;
    }
  };

  const throwIfAborted = () => {
    args.signal?.throwIfAborted?.();
  };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
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
      args.onProgress?.(`Planning how to approach this…`);
    }

    trimContext(messages, useNativeTools && !nativeFailed);

    const nativeActive = useNativeTools && !nativeFailed;
    let completion;

    try {
      if (nativeActive) {
        const res = await completeWithTools({ messages, tools: toolDefs, signal: args.signal });
        checkAbort();
        if (res === null) {
          nativeFailed = true;
          messages[0] = { role: 'system', content: xmlSys };
          completion = await completeAssistantReply({ messages, signal: args.signal });
          checkAbort();
        } else {
          completion = res;
        }
      } else {
        completion = await completeAssistantReply({ messages, signal: args.signal });
        checkAbort();
      }
    } catch (e) {
      // Re-throw abort errors immediately — don't treat them as recoverable tool errors
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      const errMsg = e instanceof Error ? e.message : String(e);
      if (nativeActive && /tool|400|422|unsupported/i.test(errMsg)) {
        nativeFailed = true;
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
      } else {
        thinkStep.status = 'error';
        thinkStep.label = 'Error';
        thinkStep.detail = errMsg;
        args.onStep([...steps]);
        errorReason = errMsg;
        break;
      }
    }

    const rawContent = String(completion.content || '').trim();
    const reasoning = String(completion.reasoning || '').trim();
    if (reasoning) {
      finalReasoning = finalReasoning ? `${finalReasoning}\n${reasoning}` : reasoning;
      args.onReasoning?.(finalReasoning);
    }

    console.log(`[agent] iter=${iter + 1} content_len=${rawContent.length} nativeFailed=${nativeFailed}`);

    // Resolve tool calls
    let toolCalls: ToolCall[] = [];
    let cleanContent = rawContent;

    if (nativeActive && !nativeFailed && completion.toolCalls?.length) {
      toolCalls = completion.toolCalls.map((tc: NativeToolCall) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }));
      messages.push({
        role: 'assistant',
        content: rawContent || null,
        tool_calls: toolCalls.map(tc => ({ id: tc.id!, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }))
      });
    } else {
      // Fallback — parse content for tool calls when native API didn't provide them:
      //   1. <tool_call> XML tags
      //   2. ```tool_call code fences (Gemma 3, etc.)
      //   3. ```html / ```css / ```js codeblocks → auto write_file
      const xmlResult = parseXmlToolCall(rawContent);
      if (xmlResult.toolCall) {
        toolCalls = [xmlResult.toolCall];
        cleanContent = stripToolCallArtifacts(xmlResult.cleanContent);
        messages.push({ role: 'assistant', content: cleanContent || 'Preparing to use tools…' });
        if (nativeActive && !nativeFailed) nativeFailed = true;
      } else {
        const cbResult = parseToolCallCodeblocks(rawContent);
        if (cbResult.toolCalls.length) {
          toolCalls = cbResult.toolCalls;
          cleanContent = stripToolCallArtifacts(cbResult.cleanContent);
          messages.push({ role: 'assistant', content: cleanContent || 'Preparing to use tools…' });
          if (nativeActive && !nativeFailed) nativeFailed = true;
        } else {
          // No XML or codeblock tool calls — try extracting code blocks as file writes
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

    thinkStep.status = 'done';
    thinkStep.detail = toolCalls.length ? `Using: ${toolCalls.map(t => t.name).join(', ')}` : 'Producing answer';

    // If content exists alongside tool calls, show it as intermediate reasoning
    if (toolCalls.length && cleanContent && cleanContent.length > 10) {
      steps.push({
        id: uid('step'), type: 'thinking', label: 'Reasoning',
        status: 'done',
        detail: cleanContent.length > 240 ? cleanContent.slice(0, 240) + '…' : cleanContent
      });
    }

    args.onStep([...steps]);

    // No tools → final answer
    if (!toolCalls.length) {
      args.onProgress?.('Producing final answer…');
      if (rawContent) {
        finalContent = stripToolCallArtifacts(rawContent);
        console.log(`[agent] iter=${iter + 1} final answer (no tools)`);
        break;
      }

      // Empty response on first step → retry with simpler prompt
      if (iter === 0) {
        console.log('[agent] first step empty, retrying with simpler prompt');
        thinkStep.detail = 'Retrying with simpler prompt…';
        try {
          const simpleMessages: RequestMessage[] = [
            { role: 'system', content: 'You are a helpful assistant. Answer the user\'s question directly and concisely.' },
            ...args.messages
          ];
          const retry = await completeAssistantReply({ messages: simpleMessages, signal: args.signal });
          const retryContent = String(retry.content || '').trim();
          if (retryContent) {
            thinkStep.detail = 'Producing answer';
            thinkStep.status = 'done';
            args.onStep([...steps]);
            // Retry succeeded — try to extract codeblocks as file writes
            const codeblockFiles = parseCodeblockWrites(retryContent);
            if (codeblockFiles.length) {
              args.onProgress?.('Writing files from retry response…');
              for (const f of codeblockFiles) {
                const writeResult = await executeTool('write_file', { path: f.path, content: f.code }, ctx);
                const toolStep: AgentStep = {
                  id: uid('step'), type: 'coding', label: 'write file',
                  status: writeResult.success ? 'done' : 'error',
                  detail: f.path,
                  output: writeResult.success ? `Wrote ${f.path} (${f.code.length} chars)` : writeResult.error
                };
                steps.push(toolStep);
                args.onStep([...steps]);
              }
              // If HTML among files, auto preview
              const hasHtml = codeblockFiles.some(f => f.path === 'index.html' || f.path.endsWith('.html'));
              if (hasHtml) {
                args.onProgress?.('Building preview…');
                const previewResult = await executeTool('preview_project', { entryPoint: 'index.html' }, ctx);
                const previewStep: AgentStep = {
                  id: uid('step'), type: 'preview', label: 'preview project',
                  status: previewResult.success ? 'done' : 'error',
                  detail: previewResult.success ? 'Preview ready' : previewResult.error
                };
                steps.push(previewStep);
                args.onStep([...steps]);
              }
              const artifact = buildArtifact(ctx);
              args.onArtifact(artifact);
              // Set final content from retry text (strip code fences so user sees clean text)
              finalContent = stripToolCallArtifacts(retryContent.replace(/```[\s\S]*?```/g, '').trim()) || 'Project files have been written.';
              console.log('[agent] retry succeeded (codeblocks)');
              break;
            } else {
              finalContent = stripToolCallArtifacts(retryContent);
              console.log('[agent] retry succeeded (no codeblocks)');
              break;
            }
          }
        } catch (retryErr) {
          console.warn('[agent] retry failed:', retryErr);
        }
      }

      // Empty response without tool calls — likely a model/context issue
      steps.push({
        id: uid('step'), type: 'error', label: 'Empty response',
        status: 'error', detail: 'The model returned an empty response. Context may be too long.'
      });
      args.onStep([...steps]);
      errorReason = 'The model returned an empty response.';
      console.log(`[agent] iter=${iter + 1} empty response error`);
      break;
    }

    totalToolCalls += toolCalls.length;
    console.log(`[agent] iter=${iter + 1} tools=${toolCalls.length} total_tools=${totalToolCalls}`);

    // Hard limit on total tool calls
    if (totalToolCalls >= MAX_TOOL_CALLS) {
      steps.push({
        id: uid('step'), type: 'error', label: 'Tool limit reached',
        status: 'error', detail: `Used ${totalToolCalls} tools. Forcing final answer.`
      });
      args.onStep([...steps]);
      messages.push({ role: 'user', content: `You have used ${totalToolCalls} tools. You MUST stop using tools and provide your final answer now based on everything gathered.` });
      try {
        const fallback = await completeAssistantReply({ messages, signal: args.signal });
        finalContent = String(fallback.content || '').trim() || 'The agent used many tools but could not synthesize a final answer.';
      } catch {
        finalContent = 'The agent used many tools but could not synthesize a final answer.';
      }
      if (!finalContent) finalContent = 'The agent used many tools but could not synthesize a final answer.';
      errorReason = errorReason || `Agent reached the tool call limit (${MAX_TOOL_CALLS}) without a clear final answer.`;
      break;
    }

    // Iteration-aware urgency: after iteration 8, remind model to answer soon
    if (iter >= 8) {
      messages.push({ role: 'user', content: 'You are running out of steps. Provide your final answer in the next response. Do NOT call any more tools.' });
    }

    // Stuck-loop detection (same tool 3 of last 5 calls)
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
    // Also detect 2-tool cycles (e.g., A→B→A→B→A)
    if (!stuckTool && recentNames.length >= 6) {
      const last6 = recentNames.slice(-6);
      const isTwoToolCycle = last6.length === 6 && new Set(last6).size === 2 &&
        last6[0] === last6[2] && last6[2] === last6[4] &&
        last6[1] === last6[3] && last6[3] === last6[5];
      if (isTwoToolCycle) {
        stuckTool = `${last6[0]} ↔ ${last6[1]}`;
      }
    }
    if (stuckTool) {
      steps.push({
        id: uid('step'), type: 'error', label: 'Loop detected — stopping',
        status: 'error', detail: `Repeated calls to ${stuckTool}`
      });
      args.onStep([...steps]);
      messages.push({ role: 'user', content: `You have called "${stuckTool}" multiple times without making progress. Stop using tools and provide your best answer now based on what you know.` });
      try {
        const fallback = await completeAssistantReply({ messages, signal: args.signal });
        finalContent = String(fallback.content || '').trim() || 'The agent encountered a loop and could not complete the task.';
      } catch {
        finalContent = 'The agent encountered a loop and could not complete the task.';
      }
      errorReason = 'Agent encountered a loop and could not complete the task.';
      console.log(`[agent] loop detected: ${stuckTool}`);
      break;
    }

    // Execute tool calls
    for (const tc of toolCalls) {
      args.onProgress?.(`Running ${tc.name.replace(/_/g, ' ')}…`);

      const toolStep: AgentStep = {
        id: uid('step'),
        type: STEP_TYPE[tc.name] || 'tool',
        label: tc.name.replace(/_/g, ' '),
        status: 'running',
        detail: Object.keys(tc.arguments).length
          ? Object.entries(tc.arguments).slice(0, 3).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(', ')
          : undefined
      };
      steps.push(toolStep);
      args.onStep([...steps]);

      const result = await executeTool(tc.name, tc.arguments, ctx);
      checkAbort();

      // Process next-turn modifications
      if (result.nextTurnMods?.disableNativeTools) {
        nativeFailed = true;
      }
      if (result.nextTurnMods?.instructions) {
        messages[0] = { role: 'system', content: result.nextTurnMods.instructions };
      }
      if (result.nextTurnMods?.injectMessages) {
        messages.push(...result.nextTurnMods.injectMessages);
      }

      // Collect web_search results as sources for display
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
        toolStep.detail = `${result.error} — ${result.note.slice(0, 120)}`;
        toolStep.output = result.error;
      } else if (!result.success) {
        toolStep.detail = result.error?.slice(0, 200);
        toolStep.output = result.error || '';
      } else {
        toolStep.detail = undefined; // keep it clean on success
        // Populate output with human-readable execution result
        if (tc.name === 'run_code') {
          const out = result.output as { result?: unknown; logs?: string[] };
          const parts: string[] = [];
          if (out.logs?.length) parts.push(out.logs.join('\n'));
          if (out.result !== undefined) parts.push(`> ${JSON.stringify(out.result, null, 2)}`);
          toolStep.output = parts.join('\n');
          // Sync to sandbox terminal
          sandboxStore.addEntry({ cmd: `python`, stdout: out.logs?.join('\n') || '', stderr: '', exitCode: result.success ? 0 : 1 });
        } else if (tc.name === 'execute_command') {
          const out = result.output as { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean };
          const parts: string[] = [];
          if (out.stdout) parts.push(out.stdout);
          if (out.stderr) parts.push(out.stderr);
          if (out.exitCode === 0) parts.push('Command completed successfully');
          else if (out.exitCode !== undefined) parts.push(`Exit code: ${out.exitCode}`);
          if (out.timedOut) parts.push('⚠ Command timed out');
          toolStep.output = parts.join('\n');
          // Sync to sandbox terminal
          sandboxStore.addEntry({ cmd: out.stdout?.split('\n')[0] || 'command', stdout: out.stdout || '', stderr: out.stderr || '', exitCode: out.exitCode, timedOut: out.timedOut });
        } else {
          // Generic fallback: show key fields from output
          const out = result.output as Record<string, unknown> | undefined;
          if (out && typeof out === 'object') {
            const lines: string[] = [];
            for (const [k, v] of Object.entries(out)) {
              if (typeof v === 'string') lines.push(`${k}: ${v.slice(0, 200)}`);
            }
            toolStep.output = lines.join('\n') || JSON.stringify(out, null, 2);
          }
        }
      }

      // Update artifact whenever files change
      const artifact = buildArtifact(ctx);
      args.onArtifact(artifact);
      args.onStep([...steps]);

      // Push result into history
      const resultPayload = result.success
        ? (result.note ? { ...result.output as object, _note: result.note } : result.output)
        : { error: result.error, ...(result.note ? { note: result.note } : {}) };

      if (nativeActive && !nativeFailed && tc.id) {
        messages.push({ role: 'tool', content: JSON.stringify(resultPayload), tool_call_id: tc.id, name: tc.name });
      } else {
        messages.push({ role: 'user', content: `Tool result for ${tc.name}:\n${JSON.stringify(resultPayload, null, 2)}` });
      }
    }
  }

  // If we exhausted iterations without a final answer, ask for one explicitly
  if (!finalContent) {
    args.onProgress?.('Asking for final answer (iteration limit reached)…');
    try {
      messages.push({ role: 'user', content: 'You have reached the iteration limit. Provide your final answer now based on everything gathered so far.' });
      const fallback = await completeAssistantReply({ messages, signal: args.signal });
    finalContent = stripToolCallArtifacts(String(fallback.content || '').trim());
  } catch { /* ignore */ }
  }

  // Second fallback: strip context to essentials and ask again
  if (!finalContent) {
    try {
      const lastUser = messages.filter(m => m.role === 'user').pop();
      const strippedMessages: RequestMessage[] = [
        messages[0], // system
        ...(lastUser ? [lastUser] : []),
        { role: 'user', content: 'Provide your final answer concisely.' }
      ];
      const fallback2 = await completeAssistantReply({ messages: strippedMessages, signal: args.signal });
      finalContent = stripToolCallArtifacts(String(fallback2.content || '').trim());
    } catch { /* ignore */ }
  }

  // Third fallback: use reasoning or partial data as answer
  if (!finalContent && finalReasoning) {
    finalContent = finalReasoning;
    errorReason = errorReason || 'Agent could not synthesize a structured final answer, but produced reasoning.';
    console.log('[agent] used reasoning as fallback answer');
  }

  if (!finalContent) {
    finalContent = 'The agent completed all steps but did not produce a final answer.';
    errorReason = errorReason || 'Agent reached iteration limit without producing a final answer.';
  }

  console.log(`[agent] done content_len=${finalContent.length} error=${errorReason || 'none'} steps=${steps.length}`);

  return {
    content: finalContent,
    reasoning: finalReasoning,
    steps,
    artifact: buildArtifact(ctx),
    sources,
    ...(errorReason ? { error: errorReason } : {})
  };
}
