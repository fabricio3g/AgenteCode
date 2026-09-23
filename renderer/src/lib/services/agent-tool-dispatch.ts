/**
 * Tool dispatch for the Home agent run: routes a tool call to its handler,
 * and wraps it with the per-tool timeout and retry policy.
 *
 * Handlers live in the agent-tool-* modules; this file only wires each tool
 * name to one, plus the two tools small enough to live inline (bash with its
 * approval gate, and the agent browser).
 */

import type { ToolContext, ToolResult } from '$lib/services/agent-types';
import { webSearch, fetchUrlContent } from '$lib/services/search';
import { queryDocuments } from '$lib/services/rag';
import { isElectron, invoke } from '$lib/services/bridge';
import {
  createDocxArtifactFile, createPdfArtifactFile, createPptxArtifactFile, createXlsxArtifactFile,
  createWorkProductArtifactFiles,
  validateGeneratedDocumentArgs,
  type GeneratedArtifactFile
} from '$lib/services/generated-documents';
import { viewerPathFor } from '$lib/utils/artifact-files';
import { readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceFile } from '$lib/services/files';
import { isWorkspace, normPath, getWsFiles, upsertWsFile, readWsText, globToRegex } from '$lib/services/agent-workspace';
import { toErrorMessage, isAbortError } from '$lib/utils/errors';
import { buildPreviewHtml, buildHtmlReport, buildMarkdownReport } from '$lib/services/agent-content';
import { executeWithTimeoutAndRetries } from '$lib/services/agent-tool-runtime';
import { addGeneratedArtifactFile as addGeneratedArtifactFileEntry } from '$lib/services/agent-artifact';
import {
  handleReadFile, handleWriteFile, handleEditFile, handleDeleteFile, handleListFiles,
  handleSearchFiles, handlePreviewProject
} from '$lib/services/agent-tool-fileops';
import { handleGetWeather, handleConvertCurrency, handleGetQuote } from '$lib/services/agent-tool-livedata';
import { liveGeocodePlace } from '$lib/services/live-data';
import { handleWebSearch, handleFetchUrl, handleQueryKnowledge, handleCalculator } from '$lib/services/agent-tool-core';
import { handleGetDiagnostics } from '$lib/services/agent-tool-diagnostics';
import { dispatchArtifactTool } from '$lib/services/agent-artifact-dispatch';

const TOOL_TIMEOUT_MS = 30000;
/** Ceiling for a tool blocked on a human answer — see `executeToolWithTimeout`. */
const APPROVAL_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TOOL_RETRIES = 1;

export function debugLog(enabled: boolean, message: string) {
  if (enabled) console.log(message);
}

export function uid(prefix: string) {
  return crypto?.randomUUID
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(output: unknown, extra?: Partial<ToolResult>): ToolResult {
  return { success: true, output, ...extra };
}

export function fail(error: string, note?: string): ToolResult {
  return { success: false, error, ...(note ? { note } : {}) };
}

function failFromError(err: unknown, note?: string): ToolResult {
  return fail(toErrorMessage(err), note);
}

/** Keep panel snapshots inside LLM context: full text rides the panel UI. */
function summariseBrowserSnapshot(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const snap = snapshot as Record<string, unknown>;
  const text = String(snap['text'] || '');
  return {
    ...snap,
    text: text.length > 4000 ? text.slice(0, 4000) + '\n... (truncated)' : text,
    links: Array.isArray(snap['links']) ? (snap['links'] as unknown[]).slice(0, 20) : snap['links'],
    buttons: Array.isArray(snap['buttons']) ? (snap['buttons'] as unknown[]).slice(0, 20) : snap['buttons']
  };
}

function addGeneratedArtifactFile(ctx: ToolContext, file: GeneratedArtifactFile): ToolResult {
  return addGeneratedArtifactFileEntry({
    executionMode: ctx.executionMode,
    files: ctx.files,
    file,
    viewerPathFor,
    ok,
    fail
  }) as ToolResult;
}

/** What the file-writing handlers (write_file, edit_file) need. */
function writeDeps(args: Record<string, unknown>, ctx: ToolContext) {
  return {
    args,
    ctx,
    normPath,
    isWorkspace,
    readWsText: (path: string, workspaceCtx: ToolContext) => readWsText(path, workspaceCtx, readWorkspaceFile),
    writeWorkspaceFile,
    getWsFiles,
    upsertWsFile,
    ok,
    fail
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  ctx.signal?.throwIfAborted?.();

  const artifactResult = await dispatchArtifactTool(name, args, ctx, {
    normPath,
    isElectron,
    isWorkspace,
    uid,
    viewerPathFor,
    buildHtmlReport,
    buildMarkdownReport,
    writeWorkspaceFile,
    validateGeneratedDocumentArgs,
    createWorkProductArtifactFiles,
    createDocxArtifactFile,
    createXlsxArtifactFile,
    createPptxArtifactFile,
    createPdfArtifactFile,
    addGeneratedArtifactFile,
    geocodePlace: liveGeocodePlace,
    ok,
    fail,
    failFromError
  });
  if (artifactResult) return artifactResult;

  switch (name) {

    case 'web_search': {
      return handleWebSearch({
        args,
        ctx,
        webSearch,
        ok,
        fail,
        failFromError
      }) as Promise<ToolResult>;
    }

    case 'fetch_url': {
      return handleFetchUrl({
        args,
        webSearch: (searchArgs) => webSearch(searchArgs),
        fetchUrlContent,
        isElectron,
        ok,
        fail,
        failFromError
      }) as Promise<ToolResult>;
    }

    case 'read_file': {
      return handleReadFile({
        args,
        ctx,
        normPath,
        isWorkspace,
        readWsText: (path, workspaceCtx) => readWsText(path, workspaceCtx, readWorkspaceFile),
        ok,
        fail
      }) as Promise<ToolResult>;
    }

    case 'write_file':
      return handleWriteFile(writeDeps(args, ctx)) as Promise<ToolResult>;

    case 'delete_file': {
      return handleDeleteFile({
        args,
        ctx,
        normPath,
        isWorkspace,
        deleteWorkspaceFile,
        ok,
        fail
      }) as Promise<ToolResult>;
    }

    case 'edit_file':
      return handleEditFile(writeDeps(args, ctx)) as Promise<ToolResult>;

    case 'list_files': {
      return handleListFiles({
        args,
        ctx,
        isWorkspace,
        getWsFiles,
        globToRegex,
        ok
      }) as ToolResult;
    }

    case 'search_files': {
      return handleSearchFiles({
        args,
        ctx,
        isWorkspace,
        getWsFiles,
        readWsText: (path, workspaceCtx) => readWsText(path, workspaceCtx, readWorkspaceFile),
        ok,
        fail
      }) as Promise<ToolResult>;
    }

    case 'get_diagnostics': {
      return handleGetDiagnostics({ args, ctx, ok, fail }) as Promise<ToolResult>;
    }

    case 'bash': {
      if (!isWorkspace(ctx)) return fail('bash is only available in workspace mode');
      const command = String(args.command || '');
      if (!command) return fail('Missing command');
      const timeoutMs = Number(args.timeout_ms) || 30000;

      // In supervised mode, request user approval before executing
      if (ctx.runtimeMode === 'supervised') {
        try {
          const { approvalsStore } = await import('$lib/stores/approvals.svelte');
          const approved = await approvalsStore.request({
            id: `bash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            chatId: ctx.chatId,
            command,
            cwd: ctx.workspaceRoot || ''
          });
          if (!approved) {
            return fail('Command blocked by user');
          }
        } catch (err: unknown) {
          if (isAbortError(err)) throw err;
          debugLog(!!ctx.debugLogs, `[agent] approval gate unavailable: ${toErrorMessage(err)}`);
          return fail('Approval mechanism unavailable');
        }
      }

      try {
        const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>('workspace_exec', {
          workspace_root: ctx.workspaceRoot,
          command,
          args: [],
          shell: true,
          timeout_ms: timeoutMs
        });
        const output = (result.stdout || '') + (result.stderr ? `\n[stderr]\n${result.stderr}` : '');
        const truncated = output.length > 8000 ? output.slice(0, 8000) + '\n... (truncated)' : output;
        if (result.exit_code === 0) {
          return ok({ exitCode: result.exit_code, output: truncated });
        }
        return fail(`Command failed (exit ${result.exit_code}): ${truncated.slice(0, 500)}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(message);
      }
    }

    case 'preview_project': {
      return handlePreviewProject({
        args,
        files: ctx.files,
        buildPreviewHtml,
        ok
      }) as ToolResult;
    }

    case 'query_knowledge': {
      return handleQueryKnowledge({
        args,
        ctx,
        queryDocuments,
        ok,
        failFromError
      }) as Promise<ToolResult>;
    }

    case 'calculator': {
      return handleCalculator({
        args,
        ok,
        fail,
        failFromError
      }) as ToolResult;
    }

    case 'get_weather': {
      return handleGetWeather({ args, ctx, ok, fail, failFromError }) as Promise<ToolResult>;
    }

    case 'convert_currency': {
      return handleConvertCurrency({ args, ctx, ok, fail, failFromError }) as Promise<ToolResult>;
    }

    case 'get_quote': {
      return handleGetQuote({ args, ctx, ok, fail, failFromError }) as Promise<ToolResult>;
    }

    case 'browser_open':
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_click':
    case 'browser_type':
    case 'browser_screenshot': {
      if (!isElectron()) return fail('Agent browser requires the desktop app');
      try {
        const { browserPanelStore } = await import('$lib/stores/browser-panel.svelte');
        browserPanelStore.agentDriving = true;
        browserPanelStore.userTakeover = false;
        browserPanelStore.init();
      } catch { /* store unavailable in tests */ }
      try {
        if (name === 'browser_open') {
          const url = String(args.url || '');
          if (!url) return fail('Missing url');
          const snapshot = await invoke<unknown>('browser_navigate', { url });
          return ok({ snapshot: summariseBrowserSnapshot(snapshot) });
        }
        if (name === 'browser_navigate') {
          const url = String(args.url || '');
          if (!url) return fail('Missing url');
          const snapshot = await invoke<unknown>('browser_navigate', { url });
          return ok({ snapshot: summariseBrowserSnapshot(snapshot) });
        }
        if (name === 'browser_snapshot') {
          const snapshot = await invoke<unknown>('browser_snapshot', {});
          return ok({ snapshot: summariseBrowserSnapshot(snapshot) });
        }
        if (name === 'browser_click') {
          const text = String(args.text || '');
          if (!text) return fail('Missing text');
          const snapshot = await invoke<unknown>('browser_click', { text });
          return ok({ snapshot: summariseBrowserSnapshot(snapshot) });
        }
        if (name === 'browser_type') {
          const selector = String(args.selector || '');
          const text = String(args.text || '');
          if (!selector || !text) return fail('Missing selector or text');
          await invoke('browser_type_text', { selector, text });
          return ok({ typed: true, selector });
        }
        const shot = await invoke<string>('browser_screenshot', {});
        return ok({ screenshot: String(shot).slice(0, 200000) });
      } catch (err: unknown) {
        return failFromError(err, 'Agent browser action failed');
      }
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

export async function executeToolWithTimeout(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  /*
   * A supervised `bash` call blocks on a human pressing Allow, so the ordinary 30s
   * tool timeout is wrong for it: the timeout fired while the approval card was
   * still on screen, turning the call into a timeout failure and stranding the
   * approval with a resolver nobody awaited — then the retry raised a *second* card
   * for the same command. Approval waits get a long ceiling and no retry. Aborting
   * still cuts it short, because abort now rejects the race.
   */
  const awaitsApproval = name === 'bash' && ctx.runtimeMode === 'supervised';
  return executeWithTimeoutAndRetries<ToolResult>({
    name,
    args,
    signal: ctx.signal,
    timeoutMs: awaitsApproval ? APPROVAL_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS,
    maxRetries: awaitsApproval ? 0 : MAX_TOOL_RETRIES,
    debug: !!ctx.debugLogs,
    onDebug: debugLog,
    runTool: () => executeTool(name, args, ctx),
    makeFailure: (message) => fail(message),
    toErrorMessage
  });
}
