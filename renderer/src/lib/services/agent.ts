import type { AgentStep, AgentArtifact, AgentOutcome, AgentStopReason, WorkspaceFile } from '$lib/types/chat';
import type { SearchResult } from '$lib/types/tauri';
import type { CompletionResult, RequestMessage, NativeToolCall } from '$lib/services/chat-api';
import type { AgentTaskResult, RunAgentTaskArgs, ToolCall, ToolContext, ToolObservation, ToolResult } from '$lib/services/agent-types';
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
import {
  isWorkspace, normPath, getWsFiles, upsertWsFile, readWsText, globToRegex
} from '$lib/services/agent-workspace';
import { toErrorMessage, isAbortError, humanizeAgentError } from '$lib/utils/errors';
import {
  parseXmlToolCall, parseToolCallCodeblocks, sanitizeAgentVisibleText,
  isPublicFallbackContent, stripToolCallArtifacts, parseCodeblockWrites
} from '$lib/services/agent-parsing';
import { buildPreviewHtml, buildHtmlReport, buildMarkdownReport } from '$lib/services/agent-content';
import {
  getNativeSystemPrompt, getXmlSystemPrompt, buildDirectSystemPrompt, buildCurrentRequestReminder,
  buildResearchReportInstruction, isMedicalResearchQuery, getFlaxeoCodeSystemPrompt, getFlaxeoChatSystemPrompt
} from '$lib/services/agent-prompts';

import {
  classifyStopReason, stoppedWarning, hasVisibleArtifact, visibleFileCount,
  hasProgressSince, isWebsiteBuildRequest, finalizeAgentSteps,
  type ProgressSnapshot
} from '$lib/services/agent-flow';
import {
  compactText, sourceRows, summarizeToolObservation, evidenceSources, buildEvidenceText,
  requestedArtifactKinds, missingRequestedArtifactExtensions as missingRequestedArtifactExts, fallbackTitle,
  hasAllRequestedArtifacts as hasAllRequestedArtifactsForFiles,
  hasGatheredEvidence as hasGatheredEvidenceForContext
} from '$lib/services/agent-evidence';
import { executeWithTimeoutAndRetries } from '$lib/services/agent-tool-runtime';
import {
  buildArtifactFromContext,
  synthesizeArtifactCompletion as synthesizeArtifactCompletionText,
  addGeneratedArtifactFile as addGeneratedArtifactFileEntry
} from '$lib/services/agent-artifact';
import { getToolDefinitions, STEP_TYPE } from '$lib/services/agent-tooling';
import {
  injectEvidenceSummary as injectEvidenceSummaryMessage,
  trimContext as trimContextMessages,
  ensureToolCallPairs
} from '$lib/services/agent-message-context';
import { injectResearchEvidencePack } from '$lib/services/agent-evidence-pack';
import {
  hasEnoughResearchEvidence,
  isResearchProductPath,
  researchEvidenceThreshold,
  researchSynthesisUserNudge,
  researchThinSourcesNotice,
  resolveResearchMode,
  shouldForceResearchSynthesis
} from '$lib/services/research-pipeline';
import {
  handleReadFile, handleWriteFile, handleEditFile, handleDeleteFile, handleListFiles,
  handleSearchFiles, handlePreviewProject
} from '$lib/services/agent-tool-fileops';
import { handleGetWeather, handleConvertCurrency, handleGetQuote } from '$lib/services/agent-tool-livedata';
import { handleWebSearch, handleFetchUrl, handleQueryKnowledge, handleCalculator } from '$lib/services/agent-tool-core';
import { handleGetDiagnostics } from '$lib/services/agent-tool-diagnostics';
import { dispatchArtifactTool } from '$lib/services/agent-artifact-dispatch';
import { enforceTokenBudget as enforceTokenBudgetMessages } from '$lib/services/agent-token-budget';
import { groupParallelAndSequential } from '$lib/services/agent-tool-scheduler';
import {
  ensureRequestedArtifactsFromEvidence as ensureRequestedArtifactsFromEvidenceCore,
  buildStrictFallbackContent as buildStrictFallbackContentCore
} from '$lib/services/agent-strict-fallback';
import { executeSingleTool as executeSingleToolCore } from '$lib/services/agent-tool-execution';
import {
  applyNextTurnMods,
  appendToolResultMessage,
  createRunningToolStep,
  displayToolLabel,
  finalizeToolStep,
  mergeWebSearchSources,
  publishArtifact,
  recoverOptionalPresentationFailure
} from '$lib/services/agent-tool-result';

function mergeCompletionUsage(
  current: CompletionResult['usage'],
  next: CompletionResult['usage']
): CompletionResult['usage'] {
  if (!next) return current || null;
  if (!current) return next;

  const sum = (left?: number, right?: number) => {
    const total = (Number(left) || 0) + (Number(right) || 0);
    return total > 0 ? total : undefined;
  };
  const leftTimings = current.timings || {};
  const rightTimings = next.timings || {};
  const timings = {
    prompt_n: sum(leftTimings.prompt_n, rightTimings.prompt_n),
    prompt_ms: sum(leftTimings.prompt_ms, rightTimings.prompt_ms),
    predicted_n: sum(leftTimings.predicted_n, rightTimings.predicted_n),
    predicted_ms: sum(leftTimings.predicted_ms, rightTimings.predicted_ms),
    total_ms: sum(leftTimings.total_ms, rightTimings.total_ms)
  };
  const predictedMs = Number(timings.predicted_ms || 0);
  const outputTokens = sum(
    current.output_tokens ?? current.completion_tokens ?? current.eval_count,
    next.output_tokens ?? next.completion_tokens ?? next.eval_count
  );

  return {
    ...current,
    ...next,
    input_tokens: sum(
      current.input_tokens ?? current.prompt_tokens ?? current.prompt_eval_count,
      next.input_tokens ?? next.prompt_tokens ?? next.prompt_eval_count
    ),
    output_tokens: outputTokens,
    total_tokens: sum(
      current.total_tokens ?? ((current.input_tokens || current.prompt_tokens || current.prompt_eval_count || 0) + (current.output_tokens || current.completion_tokens || current.eval_count || 0)),
      next.total_tokens ?? ((next.input_tokens || next.prompt_tokens || next.prompt_eval_count || 0) + (next.output_tokens || next.completion_tokens || next.eval_count || 0))
    ),
    timings: {
      ...leftTimings,
      ...rightTimings,
      ...timings,
      ...(predictedMs > 0 && outputTokens
        ? { predicted_per_second: outputTokens / (predictedMs / 1000) }
        : {})
    }
  };
}

const DEFAULT_MAX_ITERATIONS = 14;
const LOCAL_DEFAULT_MAX_ITERATIONS = 10;
/** Flaxeo Agent (code) needs more room than chat sandbox agents. */
const CODE_MAX_ITERATIONS = 28;
const CODE_LOCAL_MAX_ITERATIONS = 18;
const CODE_MAX_TIME_MS = 8 * 60 * 1000;
/** Simple Chat Agent budgets (long-horizon lite). */
const CHAT_MAX_ITERATIONS = 12;
const CHAT_LOCAL_MAX_ITERATIONS = 8;
const CHAT_MAX_TIME_MS = 5 * 60 * 1000;
const MAX_TIME_MS = 2 * 60 * 1000;
const SEARCH_TOOL_NAMES = new Set([
  'web_search',
  'fetch_url',
  'calculator',
  'get_weather',
  'convert_currency',
  'get_quote',
  'create_chart',
  'create_dashboard',
  'create_info_card',
  'create_html_card',
  'create_diagram',
  'create_map',
  'export_research_package'
]);
/** Max tool-loop messages after chat history (structural cap only; budget still applies). */
const MAX_LOOP_MESSAGES_LOCAL = 12;
const MAX_LOOP_MESSAGES_API = 16;
const TOOL_CALLS_PER_STEP = 3;
const LOCAL_TOOL_CALLS_PER_STEP = 2;
const CODE_TOOL_CALLS_PER_STEP = 4;
const MAX_TOOL_RESULT_CHARS = 12000;
const TOOL_TIMEOUT_MS = 30000;
const MAX_TOOL_RETRIES = 1;
const MAX_FORCED_FINAL_ANSWER_ATTEMPTS = 2;
/** Deep/max research gets extra synthesis retries after tool budget ends. */
const MAX_RESEARCH_FORCED_SYNTHESIS_ATTEMPTS = 3;
const LOOP_STAGNATION_MIN_DRAFT_GROWTH = 120;
const LOW_IMPACT_LOOP_TOOLS = new Set(['list_files', 'read_file', 'search_files', 'query_knowledge']);
/** Stop exploring if this many consecutive steps are only browse tools with no write/bash. */
const CODE_MAX_CONSECUTIVE_EXPLORE = 8;

function shouldDebugAgentLogs(config: unknown): boolean {
  return !!(config as { ui?: { agent_debug_logs?: boolean } })?.ui?.agent_debug_logs;
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

function failFromError(err: unknown, note?: string): ToolResult {
  return fail(toErrorMessage(err), note);
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

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  ctx.signal?.throwIfAborted?.();

  const artifactResult = await dispatchArtifactTool(name, args, ctx, {
    normPath,
    isTauri,
    isWorkspace,
    uid,
    viewerPathFor,
    buildHtmlReport,
    buildMarkdownReport,
    writeWorkspaceFile,
    validateGeneratedDocumentArgs,
    createWorkProductArtifactFiles,
    buildArtifact,
    createDocxArtifactFile,
    createXlsxArtifactFile,
    createPptxArtifactFile,
    createPdfArtifactFile,
    addGeneratedArtifactFile,
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
        isTauri,
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

    case 'write_file': {
      return handleWriteFile({
        args,
        ctx,
        normPath,
        isWorkspace,
        readWsText: (path, workspaceCtx) => readWsText(path, workspaceCtx, readWorkspaceFile),
        writeWorkspaceFile,
        getWsFiles,
        upsertWsFile,
        ok,
        fail
      }) as Promise<ToolResult>;
    }

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

    case 'edit_file': {
      return handleEditFile({
        args,
        ctx,
        normPath,
        isWorkspace,
        readWsText: (path, workspaceCtx) => readWsText(path, workspaceCtx, readWorkspaceFile),
        writeWorkspaceFile,
        getWsFiles,
        upsertWsFile,
        ok,
        fail
      }) as Promise<ToolResult>;
    }

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
          const { addPendingApproval } = await import('$lib/stores/approvals.svelte');
          const approved = await addPendingApproval(
            `bash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            command,
            ctx.workspaceRoot || ''
          );
          if (!approved) {
            return fail('Command blocked by user');
          }
        } catch {
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

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

async function executeToolWithTimeout(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return executeWithTimeoutAndRetries<ToolResult>({
    name,
    args,
    signal: ctx.signal,
    timeoutMs: TOOL_TIMEOUT_MS,
    maxRetries: MAX_TOOL_RETRIES,
    debug: !!ctx.debugLogs,
    onDebug: debugLog,
    runTool: () => executeTool(name, args, ctx),
    makeFailure: (message) => fail(message),
    toErrorMessage
  });
}

function buildArtifact(ctx: ToolContext): AgentArtifact | null {
  return buildArtifactFromContext({
    files: ctx.files,
    workProduct: ctx.workProduct
  });
}

function synthesizeArtifactCompletion(ctx: ToolContext): string {
  return synthesizeArtifactCompletionText(ctx.files);
}


function hasAllRequestedArtifacts(ctx: ToolContext, prompt: string): boolean {
  return hasAllRequestedArtifactsForFiles(ctx.files, prompt);
}

function hasGatheredEvidence(ctx: ToolContext, observations: ToolObservation[], sources: SearchResult[], content = ''): boolean {
  return hasGatheredEvidenceForContext({
    files: ctx.files,
    observations,
    sources,
    content,
    hasVisibleArtifact
  });
}

async function ensureRequestedArtifactsFromEvidence(params: {
  prompt: string;
  reason: string;
  ctx: ToolContext;
  observations: ToolObservation[];
  sources: SearchResult[];
}): Promise<string[]> {
  return ensureRequestedArtifactsFromEvidenceCore({
    ...params,
    requestedArtifactKinds,
    missingRequestedArtifactExtensions: missingRequestedArtifactExts,
    buildEvidenceText,
    fallbackTitle,
    evidenceSources,
    sourceRows,
    compactText,
    executeTool,
    buildArtifact,
    normPath,
    buildMarkdownReport
  });
}

async function buildStrictFallbackContent(params: {
  prompt: string;
  reason: string;
  ctx: ToolContext;
  observations: ToolObservation[];
  sources: SearchResult[];
  mode?: 'research' | 'chat';
  notice?: string | null;
}): Promise<string> {
  return buildStrictFallbackContentCore({
    ...params,
    mode: params.mode || 'research',
    notice: params.notice,
    ensureRequestedArtifactsFromEvidence: (args) => ensureRequestedArtifactsFromEvidence(args),
    evidenceSources,
    missingRequestedArtifactExtensions: missingRequestedArtifactExts
  });
}

function pushMissingRequestedFilesStep(steps: AgentStep[], ctx: ToolContext, rawPrompt?: string): void {
  steps.push({
    id: uid('step'),
    type: 'error',
    label: 'Missing requested files',
    status: 'error',
    detail: `Could not create: ${missingRequestedArtifactExts(ctx.files, rawPrompt || '').map((ext) => `.${ext}`).join(', ')}`
  });
}

function summarizeCodeObservations(observations: ToolObservation[]): string {
  const writes = observations.filter((o) => o.success && (o.name === 'write_file' || o.name === 'edit_file' || o.name === 'delete_file'));
  const bash = observations.filter((o) => o.success && o.name === 'bash');
  const reads = observations.filter((o) => o.success && (o.name === 'read_file' || o.name === 'list_files' || o.name === 'search_files'));
  const paths = new Set<string>();
  for (const o of writes) {
    const p = o.args?.path || o.createdFiles?.[0];
    if (typeof p === 'string' && p) paths.add(p);
  }
  const lines: string[] = [];
  if (paths.size) {
    lines.push('Files touched:');
    for (const p of [...paths].slice(0, 20)) lines.push(`- ${p}`);
  }
  if (bash.length) lines.push(`Shell commands run: ${bash.length}`);
  if (reads.length && !paths.size) lines.push(`Explored the codebase (${reads.length} read/list/search actions) but did not finish applying changes.`);
  if (!lines.length) lines.push('No successful file changes were recorded before the limit.');
  return lines.join('\n');
}

function buildWorkspaceStoppedContent(reason: string, observations: ToolObservation[]): string {
  const latest = [...observations].reverse().find((observation) => observation.name);
  const target = latest?.args?.path || latest?.args?.command || latest?.args?.query || latest?.args?.url;
  const lastAction = latest
    ? ` Last completed action: ${latest.name.replace(/_/g, ' ')}${target ? ` (${compactText(target, 120)})` : ''}.`
    : '';
  const summary = summarizeCodeObservations(observations);
  return [
    `I stopped before finishing because ${reason}.${lastAction}`,
    '',
    summary,
    '',
    'You can ask me to continue from here, or open the workspace panel for step details.'
  ].join('\n');
}

export async function runAgentTask(args: RunAgentTaskArgs): Promise<AgentTaskResult> {

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
    searchMode: args.searchMode,
    sources,
    rawPrompt: args.rawPrompt,
    workspaceRoot: args.workspaceRoot,
    workspaceFiles: args.workspaceFiles ? [...args.workspaceFiles] : undefined,
    executionMode,
    runtimeMode: args.runtimeMode,
    debugLogs,
    signal: args.signal,
    onArtifact: args.onArtifact,
  };

  const backendMode = config.llm?.backend_mode || (isTauri() ? 'local' : 'api');
  const publishArtifacts = executionMode !== 'workspace';
  const localMode = backendMode === 'local';
  const toolMode = args.toolMode || 'agent';
  const agentProfile = args.agentProfile
    || (toolMode === 'search_chat' ? 'search' : (executionMode === 'workspace' ? 'code' : 'work'));
  const isCodeProfile = agentProfile === 'code';
  const isChatProfile = agentProfile === 'chat';
  const defaultMaxIterations = isCodeProfile
    ? (localMode ? CODE_LOCAL_MAX_ITERATIONS : CODE_MAX_ITERATIONS)
    : isChatProfile
      ? (localMode ? CHAT_LOCAL_MAX_ITERATIONS : CHAT_MAX_ITERATIONS)
      : (localMode ? LOCAL_DEFAULT_MAX_ITERATIONS : DEFAULT_MAX_ITERATIONS);
  const maxIterations = Math.max(1, Math.floor(args.maxIterations ?? defaultMaxIterations));
  const defaultToolLimit = isCodeProfile
    ? Math.max(maxIterations, maxIterations * (localMode ? LOCAL_TOOL_CALLS_PER_STEP : CODE_TOOL_CALLS_PER_STEP))
    : isChatProfile
      ? Math.max(maxIterations, maxIterations * 2)
      : getToolCallLimit(maxIterations, localMode);
  const maxToolCalls = Math.max(maxIterations, Math.floor(args.maxToolCalls ?? defaultToolLimit));
  const maxTimeMs = Math.max(
    30_000,
    Math.floor(args.maxTimeMs ?? (isCodeProfile ? CODE_MAX_TIME_MS : isChatProfile ? CHAT_MAX_TIME_MS : MAX_TIME_MS))
  );
  const providerName = config.llm?.provider || 'openai';
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || {};
  const activeModel = localMode ? (config.llm?.local?.model || 'local-model') : (provider.model || '');
  let useNativeTools = isTauri() && agentSupportsNativeTools(config as any);
  debugLog(debugLogs, `[agent] START | profile=${agentProfile} | backend=${backendMode} | provider=${localMode ? 'local' : providerName} | model=${activeModel} | isTauri=${isTauri()} | useNativeTools=${useNativeTools} | maxIterations=${maxIterations} | maxToolCalls=${maxToolCalls} | maxTimeMs=${maxTimeMs}`);
  debugLog(debugLogs, `[agent] supportsNativeTools check: providerName=${localMode ? 'local' : providerName} modelId=${activeModel} result=${agentSupportsNativeTools(config as any)}`);
  let nativeFailed = false;
  let directMode = false;
  let consecutiveEmptyResponses = 0;
  let consecutiveExploreOnly = 0;
  const wantsWebsiteArtifact = isWebsiteBuildRequest(
    args.rawPrompt || [...args.messages].reverse().find((message) => message.role === 'user')?.content?.toString?.() || ''
  );
  const artifactToggles = config.ui?.artifact_toggles || {};
  const toolDefs = toolMode === 'search_chat'
    ? getToolDefinitions(executionMode, artifactToggles, 'search').filter((tool) => SEARCH_TOOL_NAMES.has(tool.function.name))
    : getToolDefinitions(executionMode, artifactToggles, agentProfile);
  const modeNote = isCodeProfile || (executionMode === 'workspace' && !isChatProfile)
    ? [
      isCodeProfile ? getFlaxeoCodeSystemPrompt() : '',
      `You are attached to a real workspace folder at ${args.workspaceRoot || 'the project root'}.`,
      'Files and bash commands run on the host filesystem, confined to the workspace root.',
      '',
      'Available tools:',
      '- read_file (path, offset?, limit?): Read a file. Use offset/limit for large files.',
      '- write_file (path, content, mode?): Create or overwrite a file.',
      '- edit_file (path, edits[]): Make precise text replacements. Each edit has {oldText, newText}. Prefer this over write_file for modifying existing files.',
      '- delete_file (path): Delete a file.',
      '- list_files (pattern?): List files in the workspace.',
      '- search_files (query, caseSensitive?, path?, maxResults?): Search file contents.',
      '- bash (command, timeout?): Run any shell command with full shell access. Output is streamed back.',
      '',
      'Use bash for running tests, installing dependencies, git operations, building, and other CLI tasks.',
      'Use edit_file for precise changes to existing files instead of rewriting the whole file with write_file.',
      'For reading large files, use read_file with offset to paginate.',
      'Diffs and file changes auto-render in the chat as a changed-files overview.',
    ].filter(Boolean).join('\n')
    : isChatProfile
      ? [
        getFlaxeoChatSystemPrompt(),
        'You are in chat sandbox mode. Files exist only inside this conversation unless the user exports them.',
      ].join('\n')
      : 'You are in chat sandbox mode. Files exist only inside this conversation artifact unless the user exports them.';
  const requestReminder = buildCurrentRequestReminder(args.rawPrompt, compactText);
  const searchModeNote = toolMode === 'search_chat'
    ? [
      `Selected search depth: ${args.searchMode || 'search'}.`,
      args.searchMode === 'max'
        ? 'Max search means keep broadening and deepening with additional searches/source reads until the answer is strongly supported or the tool/time budget is exhausted.'
        : args.searchMode === 'deep'
          ? 'Deep search means use multiple high-signal searches and source reads to improve accuracy before answering.'
          : 'Search mode means use web search for current information and follow up if the first search is insufficient.'
    ].join(' ')
    : '';
  const agentExtra = (isCodeProfile || isChatProfile)
    ? [modeNote, searchModeNote, args.systemPrompt, requestReminder].filter(Boolean).join('\n\n')
    : [modeNote, searchModeNote, args.systemPrompt, requestReminder].filter(Boolean).join('\n\n');
  const promptSearchMode = args.searchMode === 'max' || args.searchMode === 'deep' || args.searchMode === 'search'
    ? args.searchMode
    : 'search';
  const nativeSys = getNativeSystemPrompt(agentExtra, maxToolCalls, maxIterations, toolMode, executionMode, promptSearchMode);
  const xmlSys = getXmlSystemPrompt(agentExtra, maxToolCalls, maxIterations, toolDefs, toolMode, executionMode, promptSearchMode);
  const directSys = buildDirectSystemPrompt(agentExtra, { toolMode, searchMode: promptSearchMode });

  // Normalize history to pure role/content rows so trim can protect them.
  // Preserve reasoning_content when present (DeepSeek tool+thinking echo).
  const historyMessages: RequestMessage[] = (args.messages || [])
    .map((message) => {
      const row: RequestMessage = {
        role: message.role,
        content: typeof message.content === 'string' ? message.content : (message.content ? JSON.stringify(message.content) : ''),
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {})
      };
      const rc = (message as RequestMessage).reasoning_content;
      if (typeof rc === 'string' && rc.trim()) {
        row.reasoning_content = rc;
      }
      return row;
    })
    .filter((message) => message.role === 'system' || String(message.content || '').trim() || message.tool_calls?.length || message.reasoning_content);

  const historyCount = historyMessages.filter((message) => message.role !== 'system').length;

  const messages: RequestMessage[] = [
    { role: 'system', content: useNativeTools ? nativeSys : xmlSys },
    ...historyMessages
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
  let aggregateUsage: CompletionResult['usage'] = null;

  const checkAbort = () => {
    if (args.signal?.aborted) {
      throw new DOMException('Agent task cancelled by user', 'AbortError');
    }
  };

  const throwIfAborted = () => {
    args.signal?.throwIfAborted?.();
  };

  // Search / Deep / Max product path (composer search modes + search_chat) — not Code profile.
  const isResearchChat = isResearchProductPath({
    isCodeProfile,
    toolMode,
    searchMode: args.searchMode
  });
  /** Search / Deep / Max: no completion max_tokens budget (long professional reports). */
  const omitResearchMaxTokens =
    toolMode === 'search_chat'
    || args.searchMode === 'search'
    || args.searchMode === 'deep'
    || args.searchMode === 'max';
  const researchMode = resolveResearchMode(args.searchMode);
  const researchEvidenceOptions = isResearchChat ? {
    // No tight char budgets — research needs full usable evidence for professional reports.
    observationLimit: researchMode === 'max' ? 80 : 50,
    observationChars: researchMode === 'max' ? 4000 : 3000,
    sourceLimit: researchMode === 'max' ? 48 : 36,
    sourceChars: researchMode === 'max' ? 3500 : 2500,
    instruction: 'The following evidence was gathered during Search/Deep/Max research. Use these source-specific facts, URLs, and excerpts as the primary source of truth for the final answer. Do not answer generically when evidence is present. Write a polished APA 7 synthesized report — never dump raw evidence or title a section "Gathered Evidence". Never mention tools or step limits.'
  } : undefined;
  const injectLiveEvidence = () => {
    if (isResearchChat || (toolMode === 'search_chat' && (args.searchMode === 'search' || args.searchMode === 'deep' || args.searchMode === 'max'))) {
      // Dense pack with query-relevant excerpts — primary synthesis fuel for search/deep/max.
      // No token-budget truncation of the pack itself.
      injectResearchEvidencePack(messages, toolObservations, sources, {
        query: args.rawPrompt || '',
        mode: researchMode,
        // Explicitly unbounded relative to old char budgets — pack builder uses high research defaults.
        maxSources: researchMode === 'max' ? 40 : researchMode === 'deep' ? 28 : 16,
        maxExcerptChars: researchMode === 'max' ? 4000 : researchMode === 'deep' ? 3000 : 1800,
        maxTotalChars: researchMode === 'max' ? 120_000 : researchMode === 'deep' ? 80_000 : 40_000,
        maxFacts: researchMode === 'max' ? 60 : researchMode === 'deep' ? 40 : 24
      });
      return;
    }
    injectEvidenceSummaryMessage(messages, toolObservations, sources, compactText, researchEvidenceOptions);
  };
  const fallbackMode: 'research' | 'chat' =
    isResearchChat
    || toolMode === 'search_chat'
    || args.searchMode === 'search'
    || args.searchMode === 'deep'
    || args.searchMode === 'max'
      ? 'research'
      : 'chat';
  const buildEvidenceOnlyFallback = async (reason: string): Promise<string> => executionMode === 'workspace'
    ? buildWorkspaceStoppedContent(reason, toolObservations)
    : buildStrictFallbackContent({
      prompt: args.rawPrompt || '',
      reason,
      ctx,
      observations: toolObservations,
      sources,
      mode: fallbackMode
    });

  // --- Research product: system-owned first gather (competitor pipeline: search → read → write) ---
  let researchBootstrapDone = false;
  if (isResearchChat && String(args.rawPrompt || '').trim()) {
    const budget = researchEvidenceThreshold(researchMode);
    const gatherStep: AgentStep = {
      id: uid('step'),
      type: 'searching',
      label: 'Searching',
      status: 'running',
      detail: String(args.rawPrompt || '').slice(0, 160)
    };
    steps.push(gatherStep);
    args.onStep([...steps]);
    args.onProgress?.('Searching…');
    try {
      const searchResponse = await webSearch({
        query: String(args.rawPrompt || ''),
        context: args.conversationContext,
        deep: researchMode !== 'search',
        mode: researchMode,
        options: { max_results: budget.resultBudget }
      });
      if (!searchResponse.error && Array.isArray(searchResponse.results) && searchResponse.results.length) {
        for (const entry of searchResponse.results) {
          if (!entry?.url) continue;
          if (seenUrls.has(entry.url)) {
            const existing = sources.find((s) => s.url === entry.url);
            if (existing && ((entry.full_content || '').length > (existing.full_content || '').length)) {
              Object.assign(existing, entry);
            }
            continue;
          }
          seenUrls.add(entry.url);
          sources.push({
            ...entry,
            title: entry.title || entry.url,
            url: entry.url,
            snippet: entry.snippet || ''
          });
        }
        toolObservations.push({
          name: 'web_search',
          args: { query: args.rawPrompt, mode: researchMode },
          success: true,
          summary: [
            `Search query: ${compactText(args.rawPrompt, 180)}`,
            ...sources.slice(0, 12).map((s, i) =>
              `${i + 1}. ${s.title} - ${s.url}${s.snippet ? ` - ${compactText(s.snippet, 280)}` : ''}`
            )
          ].join('\n'),
          sources: [...sources]
        });
        researchBootstrapDone = true;
        gatherStep.status = 'done';
        gatherStep.detail = `${sources.length} source${sources.length === 1 ? '' : 's'}`;
        injectLiveEvidence();
        messages.push({
          role: 'user',
          content: [
            `System already ran an initial ${researchMode} web search for the user query and collected ${sources.length} sources (with page text when available).`,
            hasEnoughResearchEvidence(researchMode, sources)
              ? 'Evidence is sufficient. Write the final APA 7 research report now. Do NOT call tools unless a critical source is clearly missing full text — then fetch_url once.'
              : 'If sources look thin or off-topic, you may run at most one more focused web_search, then write the final APA 7 research report. Prefer fetch_url only for the most important thin URLs.',
            'Never mention tools, step limits, or agent status in the report.'
          ].join('\n')
        });
        args.onSources?.([...sources]);
      } else {
        gatherStep.status = 'done';
        gatherStep.detail = searchResponse.error ? 'Search unavailable — will retry' : 'No results — will refine';
      }
    } catch (err) {
      gatherStep.status = 'done';
      gatherStep.detail = 'Search failed — agent will retry';
      debugLog(debugLogs, `[agent] research bootstrap search failed: ${toErrorMessage(err)}`);
    }
    args.onStep([...steps]);
  }

  let researchForceWrite = isResearchChat && researchBootstrapDone && hasEnoughResearchEvidence(researchMode, sources);

  for (let iter = 0; iter < maxIterations; iter++) {
    debugLog(debugLogs, `[agent] iter=${iter} | nativeActive=${useNativeTools && !nativeFailed && !directMode} | nativeFailed=${nativeFailed} | directMode=${directMode} | messageCount=${messages.length}`);
    checkAbort();
    throwIfAborted();
    if (Date.now() - startTime > maxTimeMs) {
      if (isResearchChat && sources.length) {
        // Deliver report from sources rather than hard-failing research.
        stopReason = 'timeout';
        warningReason = undefined;
      } else {
        errorReason = errorReason || 'Agent timed out before completing the requested depth.';
        stopReason = 'timeout';
      }
      break;
    }

    const thinkStep: AgentStep = {
      id: uid('step'),
      type: isResearchChat ? (researchForceWrite ? 'writing' : 'thinking') : 'thinking',
      label: isResearchChat
        ? (researchForceWrite ? 'Writing' : (iter === 0 && !researchBootstrapDone ? 'Searching' : 'Working'))
        : (iter === 0 ? 'Planning' : 'Thinking'),
      status: 'running',
      detail: isResearchChat
        ? (researchForceWrite ? 'Synthesizing research report' : (sources.length ? `${sources.length} sources` : 'Gathering sources'))
        : `Step ${iter + 1} of ${maxIterations}`
    };
    steps.push(thinkStep);
    args.onStep([...steps]);
    if (iter === 0) {
      args.onProgress?.(isResearchChat
        ? (researchForceWrite ? 'Writing research report…' : 'Searching…')
        : `Planning how to approach this\u2026`);
    }

    // Never drop chat history — only cap tool-loop growth after the transcript.
    // Research + attached docs: no token budgets that discard evidence / uploads.
    const preserveDocs =
      isResearchChat
      || toolMode === 'search_chat'
      || !!args.preserveDocumentContext
      || (typeof args.conversationContext === 'string' && args.conversationContext.includes('<documents>'));
    if (!preserveDocs) {
      trimContextMessages(messages, {
        historyCount,
        maxLoopMessages: localMode ? MAX_LOOP_MESSAGES_LOCAL : MAX_LOOP_MESSAGES_API
      });
      await enforceTokenBudgetMessages({
        messages,
        config,
        isTauri,
        invoke,
        debugLog
      });
    } else if (!isResearchChat) {
      // Soft loop-only trim for search/doc chats (never token-budget truncate).
      trimContextMessages(messages, {
        historyCount,
        maxLoopMessages: Math.max(MAX_LOOP_MESSAGES_API * 3, 48)
      });
    }

    injectLiveEvidence();
    // Never send unpaired tool_calls to the provider (fixes 400 tool_call_id errors).
    ensureToolCallPairs(messages, 'fill');

    const sysCount = messages.filter(m => m.role === 'system').length;
    const userCount = messages.filter(m => m.role === 'user').length;
    const otherCount = messages.filter(m => m.role !== 'system' && m.role !== 'user').length;
    debugLog(debugLogs, `[agent] after trim: messageCount=${messages.length} | sysCount=${sysCount} | userCount=${userCount} | otherCount=${otherCount}`);

    const nativeActive = useNativeTools && !nativeFailed && !directMode;
    const callMode = directMode ? 'direct' : nativeActive ? 'native' : 'xml';
    debugLog(debugLogs, `[agent] calling LLM via: ${callMode} | toolDefs=${nativeActive ? toolDefs.length : 0} | messages=${messages.length}`);
    let completion;

    const streamingReasoningParts: string[] = [];

    const runComplete = async (msgs: typeof messages) => {
      ensureToolCallPairs(msgs, 'fill');
      return completeAssistantReply({
        messages: msgs,
        signal: args.signal,
        reasoningLevel: args.reasoningLevel,
        omitMaxTokens: omitResearchMaxTokens
      });
    };

    try {
      if (directMode) {
        messages[0] = { role: 'system', content: directSys };
        completion = await runComplete(messages);
        checkAbort();
      } else if (nativeActive) {
        const streamResult = await agentStreamComplete({
          messages,
          tools: toolDefs,
          signal: args.signal,
          config,
          reasoningLevel: args.reasoningLevel,
          omitMaxTokens: omitResearchMaxTokens,
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
          completion = await runComplete(messages);
          checkAbort();
        } else {
          completion = streamResult;
        }
      } else {
        completion = await runComplete(messages);
        checkAbort();
      }
    } catch (e: unknown) {
      if (isAbortError(e)) throw e;
      const errMsg = toErrorMessage(e);
      debugLog(debugLogs, `[agent] LLM ERROR | msg="${errMsg.slice(0, 200)}" | nativeActive=${nativeActive} | iter=${iter}`);
      // Repair unpaired tool_calls and retry once
      if (/tool_calls|tool_call_id|insufficient tool messages/i.test(errMsg)) {
        ensureToolCallPairs(messages, 'fill');
        try {
          messages[0] = { role: 'system', content: nativeActive ? nativeSys : xmlSys };
          completion = await runComplete(messages);
          checkAbort();
        } catch (eRepair: unknown) {
          if (isAbortError(eRepair)) throw eRepair;
          // Last resort: strip incomplete tool_calls and continue as plain chat
          ensureToolCallPairs(messages, 'strip');
          try {
            completion = await runComplete(messages);
            checkAbort();
          } catch (e3: unknown) {
            if (isAbortError(e3)) throw e3;
            thinkStep.status = 'error';
            thinkStep.label = 'Error';
            thinkStep.detail = humanizeAgentError(e3);
            args.onStep([...steps]);
            errorReason = humanizeAgentError(e3);
            break;
          }
        }
      } else if (nativeActive && /tool|400|422|unsupported/i.test(errMsg)) {
        debugLog(debugLogs, '[agent] -> falling back to XML (tool/400/422/unsupported error)');
        nativeFailed = true;
        setToolSupportCache(config as any, false);
        // Keep tool role results; fill any gaps so XML path still has valid history
        ensureToolCallPairs(messages, 'fill');
        messages[0] = { role: 'system', content: xmlSys };
        try {
          completion = await runComplete(messages);
          checkAbort();
        } catch (e2: unknown) {
          if (isAbortError(e2)) throw e2;
          thinkStep.status = 'error';
          thinkStep.label = 'Error';
          thinkStep.detail = humanizeAgentError(e2);
          args.onStep([...steps]);
          errorReason = humanizeAgentError(e2);
          break;
        }
      } else if (iter < 2 && errMsg.includes('content')) {
        debugLog(debugLogs, '[agent] -> switching to direct mode (content error, iter < 2)');
        directMode = true;
        messages[0] = { role: 'system', content: directSys };
        try {
          completion = await runComplete(messages);
          checkAbort();
        } catch (e3: unknown) {
          thinkStep.status = 'error';
          thinkStep.label = 'Error';
          thinkStep.detail = humanizeAgentError(e3);
          args.onStep([...steps]);
          errorReason = humanizeAgentError(e3);
          break;
        }
      } else {
        console.error('[agent] HARD FAIL (non-recoverable LLM error)', errMsg);
        thinkStep.status = 'error';
        thinkStep.label = 'Error';
        thinkStep.detail = humanizeAgentError(e);
        args.onStep([...steps]);
        errorReason = humanizeAgentError(e);
        break;
      }
    }

    aggregateUsage = mergeCompletionUsage(aggregateUsage, completion.usage);
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
        if (wantsWebsiteArtifact && !hasVisibleArtifact(ctx.files)) {
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
            pushMissingRequestedFilesStep(steps, ctx, args.rawPrompt);
            args.onStep([...steps]);
            finalContent = await buildStrictFallbackContent({
              prompt: args.rawPrompt || '',
              reason: 'direct mode tried to finish without creating the requested files',
              ctx,
              observations: [...toolObservations, finalObservation],
              sources,
              mode: fallbackMode
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
              detail: created.join(', '),
              fileChanges: created.map((path) => ({ path, kind: 'created' as const }))
            });
            args.onStep([...steps]);
          }
        }
        messages.push({ role: 'assistant', content: rawContent });
        finalContent = stripToolCallArtifacts(rawContent);
        break;
      }
    } else if (nativeActive && !nativeFailed && completion.toolCalls?.length) {
      toolCalls = completion.toolCalls.map((tc: NativeToolCall, index: number) => ({
        id: tc.id || `call_${iter}_${index}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name,
        arguments: tc.arguments
      }));
      // DeepSeek (and similar) require reasoning_content on tool-using assistant turns
      // to be echoed on all subsequent requests — omitting it yields HTTP 400.
      const assistantToolMsg: RequestMessage = {
        role: 'assistant',
        content: rawContent || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id!,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        }))
      };
      if (reasoning) {
        assistantToolMsg.reasoning_content = reasoning;
      }
      messages.push(assistantToolMsg);
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
    thinkStep.detail = toolCalls.length
      ? (isResearchChat
        ? toolCalls.map((toolCall) => displayToolLabel(toolCall.name)).join(', ')
        : `Next: ${toolCalls.map((toolCall) => displayToolLabel(toolCall.name)).join(', ')}`)
      : (isResearchChat ? 'Writing report' : 'Preparing the answer');

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
        if (wantsWebsiteArtifact && !hasVisibleArtifact(ctx.files)) {
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
            pushMissingRequestedFilesStep(steps, ctx, args.rawPrompt);
            args.onStep([...steps]);
            finalContent = await buildStrictFallbackContent({
              prompt: args.rawPrompt || '',
              reason: 'the model tried to finish without creating the requested files',
              ctx,
              observations: [...toolObservations, finalObservation],
              sources,
              mode: fallbackMode
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
              detail: created.join(', '),
              fileChanges: created.map((path) => ({ path, kind: 'created' as const }))
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
        id: uid('step'),
        type: isResearchChat ? 'writing' : 'error',
        label: isResearchChat ? 'Writing report' : 'Tool limit reached',
        status: isResearchChat ? 'running' : 'error',
        detail: isResearchChat
          ? 'Synthesizing final research report from gathered sources'
          : `Used ${totalToolCalls} tools across ${maxIterations} steps. Returning gathered evidence only.`
      });
      args.onStep([...steps]);
      // Research: leave finalContent empty so forced synthesis can write a real report.
      if (!isResearchChat) finalContent = await buildEvidenceOnlyFallback(`the tool budget was reached (${totalToolCalls}/${maxToolCalls})`);
      if (!isResearchChat) {
        warningReason = warningReason || `Agent reached the dynamic tool call limit (${maxToolCalls}) and returned only gathered evidence.`;
      }
      stopReason = 'tool_limit';
      break;
    }

    // Research: force write once evidence is good enough (don't thrash on more searches).
    if (isResearchChat && shouldForceResearchSynthesis({ mode: researchMode, sources, observations: toolObservations })) {
      researchForceWrite = true;
    }

    if (researchForceWrite || iter >= Math.max(0, maxIterations - 2)) {
      messages.push({
        role: 'user',
        content: isCodeProfile
          ? 'You are almost out of steps. STOP exploring. Apply any remaining critical edits now (edit_file/write_file), or if done, respond with a plain-text summary of files changed and how to verify. Do NOT call list_files/read_file unless required for one final fix.'
          : isResearchChat
            ? [
              researchForceWrite
                ? 'Enough sources have been gathered. Do NOT call more tools.'
                : 'You are almost out of research steps. Do NOT call more tools unless one critical source is missing.',
              'Write the final polished APA 7 research report now using the RESEARCH EVIDENCE PACK.',
              'Required skeleton: # Title (the user search topic); spaced body sections (no Summary / Executive Summary); ## Limitations; ## References (APA 7).',
              'Never title a section "Gathered Evidence" or "Summary". Never mention tools or step limits. Use blank lines between paragraphs and headings. Cite with APA author–date and/or [n].',
              buildResearchReportInstruction(researchMode, isMedicalResearchQuery(args.rawPrompt || ''))
            ].join('\n\n')
            : 'You are running out of steps. If you need to create a spreadsheet, document, or other artifact, create it NOW using the data from your search results. Otherwise provide your final answer.'
      });
    }

    // Code: stop endless explore-only loops (read/list/search without write/bash)
    if (isCodeProfile && toolCalls.length) {
      const onlyExplore = toolCalls.every((tc) => LOW_IMPACT_LOOP_TOOLS.has(tc.name) || tc.name === 'web_search' || tc.name === 'fetch_url' || tc.name === 'get_diagnostics');
      const hasMutation = toolCalls.some((tc) => tc.name === 'write_file' || tc.name === 'edit_file' || tc.name === 'delete_file' || tc.name === 'bash');
      if (hasMutation) consecutiveExploreOnly = 0;
      else if (onlyExplore) consecutiveExploreOnly += toolCalls.length;
      if (consecutiveExploreOnly >= CODE_MAX_CONSECUTIVE_EXPLORE) {
        messages.push({
          role: 'user',
          content: 'You have explored enough. Stop calling read/list/search tools. Either make the code change now with edit_file/write_file, or finish with a clear summary of findings. No more exploratory tool calls.'
        });
      }
      if (consecutiveExploreOnly >= CODE_MAX_CONSECUTIVE_EXPLORE + 4) {
        steps.push({
          id: uid('step'),
          type: 'error',
          label: 'Explore limit — finishing',
          status: 'error',
          detail: `Stopped after ${consecutiveExploreOnly} explore-only tool calls without file changes`
        });
        args.onStep([...steps]);
        finalContent = await buildEvidenceOnlyFallback('too many explore-only tool calls without applying changes');
        warningReason = 'Agent explored the codebase extensively without finishing changes; returned a partial summary.';
        stopReason = 'loop';
        break;
      }
    }

    const sig = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.arguments)}`).join('|');
    recentSigs.push(sig);
    if (recentSigs.length > 10) recentSigs.shift();
    recentProgress.push({
      sourceCount: sources.length,
      visibleFileCount: visibleFileCount(ctx.files),
      draftChars: maxObservedDraftChars,
      observationCount: toolObservations.filter((o) => o.success).length
    });
    if (recentProgress.length > 10) recentProgress.shift();

    // Extract full individual calls (name + args) for exact-match detection
    const recentFullCalls = recentSigs.flatMap(s => s.split('|')).filter(Boolean);
    // Extract just names for name-only counting and cycle detection
    const recentNames = recentFullCalls.map(c => c.split(':')[0]);
    const recentWindow = Math.min(recentSigs.length, 6);
    const progressWindow = recentProgress.slice(-Math.max(2, recentWindow));
    const isStagnating = !hasProgressSince(progressWindow, LOOP_STAGNATION_MIN_DRAFT_GROWTH);

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
        if (isResearchChat && name === 'web_search') continue;
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
        id: uid('step'),
        type: isResearchChat ? 'writing' : 'error',
        label: isResearchChat ? 'Writing report' : 'Loop detected \u2014 stopping',
        status: isResearchChat ? 'running' : 'error',
        detail: isResearchChat
          ? 'Synthesizing research report from gathered sources'
          : `Repeated calls to ${stuckTool}`
      });
      args.onStep([...steps]);
      // Research: leave finalContent empty for forced report synthesis from the pack.
      if (!isResearchChat) finalContent = await buildEvidenceOnlyFallback(`it detected repeated calls to ${stuckTool}`);
      if (!isResearchChat) {
        warningReason = 'Agent encountered a loop and returned only gathered evidence.';
      }
      stopReason = 'loop';
      break;
    }

    // Research: drop extra web_search once evidence is enough (prefer write path).
    if (isResearchChat && researchForceWrite && toolCalls.length) {
      const filtered = toolCalls.filter((tc) => tc.name !== 'web_search');
      if (filtered.length !== toolCalls.length) {
        toolCalls = filtered;
        if (!toolCalls.length) {
          // Model only wanted another search — exit loop and force APA synthesis.
          injectLiveEvidence();
          break;
        }
      }
    }

    // Execute tool calls with parallel grouping
    const groups = groupParallelAndSequential(toolCalls);
    for (const group of groups) {
      if (group.length === 1) {
        // Single tool — execute directly
        const tc = group[0];
        nativeFailed = await executeSingleTool(tc, steps, ctx, args, messages, sources, seenUrls, toolObservations, nativeActive, nativeFailed, publishArtifacts);
      } else {
        // Multiple independent tools — execute in parallel
        args.onProgress?.(`Running ${group.length} tools in parallel\u2026`);
        const results = await Promise.allSettled(
          group.map(async (tc) => {
            const toolStep = createRunningToolStep(tc, STEP_TYPE, uid);
            return { tc, toolStep, result: await executeToolWithTimeout(tc.name, tc.arguments, ctx) };
          })
        );

        // Process all results
        for (const entry of results) {
          if (entry.status === 'rejected') continue;
          const { tc, toolStep } = entry.value;
          const result = recoverOptionalPresentationFailure(tc, entry.value.result);

          if (applyNextTurnMods(messages, result)) nativeFailed = true;
          toolObservations.push(summarizeToolObservation(tc.name, tc.arguments, result));
          mergeWebSearchSources({ toolCall: tc, result, sources, seenUrls, onSources: args.onSources });
          finalizeToolStep(toolStep, result, tc.name);
          steps.push(toolStep);
          if (publishArtifacts) publishArtifact(args.onArtifact, () => buildArtifact(ctx));
          appendToolResultMessage({ toolCall: tc, result, messages, nativeActive, nativeFailed, maxToolResultChars: MAX_TOOL_RESULT_CHARS });
        }
        args.onStep([...steps]);
      }
    }

    totalToolCalls += budgetedToolCalls;

    if (isResearchChat && shouldForceResearchSynthesis({ mode: researchMode, sources, observations: toolObservations })) {
      researchForceWrite = true;
      injectLiveEvidence();
    }

    if (directMode && hasVisibleArtifact(ctx.files)) {
      finalContent = synthesizeArtifactCompletion(ctx) || 'Website files created and preview is ready.';
      break;
    }

    if (totalToolCalls >= maxToolCalls) {
      if (!isResearchChat) {
        finalContent = await buildEvidenceOnlyFallback(`the available tool budget was reached (${totalToolCalls}/${maxToolCalls})`);
        warningReason = warningReason || `Agent reached the dynamic tool call limit (${maxToolCalls}) and returned only gathered evidence.`;
      }
      stopReason = 'tool_limit';
      break;
    }
  }

  if (!finalContent) {
    const forcedAttempts = isResearchChat
      ? MAX_RESEARCH_FORCED_SYNTHESIS_ATTEMPTS
      : MAX_FORCED_FINAL_ANSWER_ATTEMPTS;
    const medicalResearch = isResearchChat && isMedicalResearchQuery(args.rawPrompt || '');
    for (let attempt = 1; attempt <= forcedAttempts; attempt++) {
      try {
        injectLiveEvidence();
        messages[0] = { role: 'system', content: directSys };
        const researchNudge = isResearchChat
          ? [
            researchSynthesisUserNudge(researchMode, medicalResearch, attempt, forcedAttempts),
            buildResearchReportInstruction(researchMode, medicalResearch)
          ].join('\n\n')
          : null;
        const codeNudge = isCodeProfile
          ? [
            'You have reached the coding step limit. Do NOT call tools.',
            'Write a concise plain-text summary of: (1) what you changed or found, (2) file paths touched, (3) how to verify, (4) what remains unfinished.',
            summarizeCodeObservations(toolObservations)
          ].join('\n\n')
          : null;
        const researchRetryNudge = isResearchChat
          ? [
            'Previous synthesis was empty or unusable. Write the complete APA 7 professional research report in markdown now.',
            'Start with # Title naming the user search topic, then spaced topical body sections (no Summary heading), then ## Limitations and ## References (APA 7).',
            'Put one blank line before/after headings and between paragraphs. Do not produce a dense wall of text or a short summary.',
            medicalResearch
              ? 'Medical structure: brief disclaimer; Definition; Diagnosis/presentation; Treatment/management; Prognosis; Limitations; References. Title the report with the medical topic from the search. Include a brief non-advice medical disclaimer.'
              : 'Structure for professionals who work with this topic. Use APA author–date citations and [n] when sources are numbered.',
            buildResearchReportInstruction(researchMode, medicalResearch)
          ].join('\n\n')
          : null;
        messages.push({
          role: 'user',
          content: attempt === 1
            ? (researchNudge || codeNudge || 'You have reached the step limit. Do NOT call tools. Using only gathered evidence, provide the best possible final answer now. If something is uncertain, state it explicitly.')
            : (isCodeProfile
              ? 'Final attempt: no tools. Summarize file changes and next steps in plain text only.'
              : (researchRetryNudge || 'Final attempt: no tools, no extra reasoning. Return the final answer now in plain text using only gathered evidence.'))
        });
        args.onProgress?.(isResearchChat
          ? `Writing research report (attempt ${attempt}/${forcedAttempts})\u2026`
          : 'Producing final answer\u2026');
        const forced = await completeAssistantReply({
          messages,
          signal: args.signal,
          omitMaxTokens: omitResearchMaxTokens
        });
        aggregateUsage = mergeCompletionUsage(aggregateUsage, forced.usage);
        const forcedContent = stripToolCallArtifacts(String(forced?.content || '')).trim();
        if (!forcedContent) continue;
        // Reject pure evidence-dump outputs for research; retry synthesis.
        // Reject pure evidence dumps that never open as a real topical report.
        if (
          isResearchChat
          && /#{0,6}\s*Gathered Evidence\b/i.test(forcedContent)
          && !/^#\s+(?!Gathered Evidence\b).+/im.test(forcedContent)
        ) {
          continue;
        }
        finalContent = forcedContent;
        if (forced.reasoning) finalReasoning = finalReasoning || String(forced.reasoning);
        if (isResearchChat) {
          stopReason = 'none';
          warningReason = undefined;
        } else if (isCodeProfile) {
          if (stopReason === 'none') stopReason = 'iteration_limit';
          warningReason = warningReason || 'Agent reached the step limit and returned a partial coding summary.';
        } else {
          if (stopReason === 'none') stopReason = 'iteration_limit';
          warningReason = warningReason || 'Agent reached the iteration limit and produced a final answer from gathered evidence.';
        }
        break;
      } catch {
        // continue to next forced attempt, then fall through to strict fallback
      }
    }
  }

  if (!finalContent) {
    const reason = stopReason !== 'none' && errorReason
      ? errorReason
      : 'it reached the iteration limit before producing a final answer';
    const richCount = sources.filter((s) => String(s.full_content || s.snippet || '').length >= 120).length;
    finalContent = executionMode === 'workspace'
      ? buildWorkspaceStoppedContent(reason, toolObservations)
      : await buildStrictFallbackContent({
        prompt: args.rawPrompt || '',
        reason,
        ctx,
        observations: toolObservations,
        sources,
        mode: fallbackMode,
        // Research: product-facing report without "step limit" language
        ...(isResearchChat
          ? { notice: researchThinSourcesNotice(sources.length, richCount) }
          : {})
      });
    if (stopReason === 'none') stopReason = 'iteration_limit';
    if (isResearchChat && hasGatheredEvidence(ctx, toolObservations, sources, finalContent)) {
      // Sourced research report is a completed product deliverable.
      warningReason = undefined;
      errorReason = undefined;
      stopReason = 'none';
    } else if (!isResearchChat) {
      errorReason = errorReason || 'Agent reached iteration limit without producing a final answer.';
    } else {
      errorReason = undefined;
      warningReason = researchThinSourcesNotice(sources.length, richCount);
      stopReason = sources.length ? 'none' : stopReason;
    }
  }

  finalContent = sanitizeAgentVisibleText(finalContent);
  finalReasoning = sanitizeAgentVisibleText(finalReasoning);
  const artifact = publishArtifacts ? buildArtifact(ctx) : null;
  const finalSources = evidenceSources(toolObservations, sources);

  // Research product rule: sources + body → completed report (never step-limit Error UI).
  if (isResearchChat && finalContent?.trim() && finalSources.length > 0) {
    stopReason = 'none';
    warningReason = undefined;
    errorReason = undefined;
  }

  const usefulResult = hasGatheredEvidence(ctx, toolObservations, finalSources, finalContent);
  const effectiveStopReason = stopReason !== 'none' ? stopReason : classifyStopReason(errorReason || warningReason);
  const outcome: AgentOutcome = errorReason
    ? (usefulResult ? 'stopped' : 'failed')
    : warningReason
      ? 'partial'
      : 'completed';
  const fatalError = outcome === 'failed';
  const rawWarning = !fatalError && (
    warningReason
    || (effectiveStopReason !== 'none'
      ? stoppedWarning(effectiveStopReason, errorReason || '', {
        workspace: executionMode === 'workspace' || isCodeProfile,
        research: isResearchChat
      })
      : undefined)
  );
  const effectiveWarning = rawWarning ? String(rawWarning).trim() || undefined : undefined;

  finalizeAgentSteps(steps, fatalError && !isResearchChat);

  const exitNotice = effectiveWarning && !fatalError ? effectiveWarning : 'none';
  console.log(`[agent] EXIT | contentLen=${finalContent.length} | steps=${steps.length} | outcome=${outcome} | stopReason=${effectiveStopReason} | error=${fatalError ? (errorReason || 'unknown') : 'none'} | notice=${exitNotice}`);
  const publicFallback = isPublicFallbackContent(finalContent);

  return {
    content: finalContent,
    reasoning: finalReasoning,
    steps,
    artifact,
    sources: finalSources,
    outcome,
    stopReason: effectiveStopReason,
    publicFallback,
    diagnosticsRedacted: publicFallback,
    ...(aggregateUsage ? { usage: aggregateUsage } : {}),
    ...(fatalError && errorReason ? { error: errorReason } : {}),
    ...(effectiveWarning ? { warning: effectiveWarning } : {})
  };
}

async function executeSingleTool(
  tc: ToolCall,
  steps: AgentStep[],
  ctx: ToolContext,
  args: RunAgentTaskArgs,
  messages: RequestMessage[],
  sources: SearchResult[],
  seenUrls: Set<string>,
  observations: ToolObservation[],
  nativeActive: boolean,
  nativeFailed: boolean,
  publishArtifacts: boolean
): Promise<boolean> {
  return executeSingleToolCore({
    tc,
    steps,
    ctx,
    args,
    messages,
    sources,
    seenUrls,
    observations,
    nativeActive,
    nativeFailed,
    stepTypeMap: STEP_TYPE,
    uid,
    executeToolWithTimeout: (name, toolArgs) => executeToolWithTimeout(name, toolArgs, ctx),
    summarizeToolObservation,
    buildArtifact: () => publishArtifacts ? buildArtifact(ctx) : null,
    maxToolResultChars: MAX_TOOL_RESULT_CHARS
  });
}
