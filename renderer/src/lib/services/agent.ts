import type { AgentStep, AgentArtifact, AgentOutcome, AgentStopReason, WorkspaceFile } from '$lib/types/chat';
import type { SearchResult } from '$lib/types/tauri';
import type { RequestMessage, NativeToolCall } from '$lib/services/chat-api';
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
import { toErrorMessage, isAbortError } from '$lib/utils/errors';
import {
  parseXmlToolCall, parseToolCallCodeblocks, sanitizeAgentVisibleText,
  isPublicFallbackContent, stripToolCallArtifacts, parseCodeblockWrites
} from '$lib/services/agent-parsing';
import { buildPreviewHtml, buildHtmlReport, buildMarkdownReport } from '$lib/services/agent-content';
import {
  getNativeSystemPrompt, getXmlSystemPrompt, buildDirectSystemPrompt, buildCurrentRequestReminder
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
  trimContext as trimContextMessages
} from '$lib/services/agent-message-context';
import {
  handleReadFile, handleWriteFile, handleDeleteFile, handleListFiles,
  handleSearchFiles, handlePreviewProject
} from '$lib/services/agent-tool-fileops';
import { handleCreateReport, handleCreateWorkProduct } from '$lib/services/agent-tool-artifacts';
import { handleWebSearch, handleFetchUrl, handleQueryKnowledge, handleCalculator } from '$lib/services/agent-tool-core';
import {
  handleCreateDocument,
  handleCreateSpreadsheet,
  handleCreatePresentation,
  handleCreatePdf
} from '$lib/services/agent-tool-generators';
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
  finalizeToolStep,
  mergeWebSearchSources,
  publishArtifact
} from '$lib/services/agent-tool-result';

const DEFAULT_MAX_ITERATIONS = 14;
const LOCAL_DEFAULT_MAX_ITERATIONS = 10;
const MAX_TIME_MS = 2 * 60 * 1000;
const SEARCH_TOOL_NAMES = new Set(['web_search', 'fetch_url', 'calculator']);
const KEEP_TOOL_PAIRS = 6;
const TOOL_CALLS_PER_STEP = 3;
const LOCAL_TOOL_CALLS_PER_STEP = 2;
const MAX_TOOL_RESULT_CHARS = 12000;
const TOOL_TIMEOUT_MS = 30000;
const MAX_TOOL_RETRIES = 1;
const MAX_FORCED_FINAL_ANSWER_ATTEMPTS = 2;
const LOOP_STAGNATION_MIN_DRAFT_GROWTH = 120;
const LOW_IMPACT_LOOP_TOOLS = new Set(['list_files', 'read_file', 'search_files']);

function shouldDebugAgentLogs(config: unknown): boolean {
  return !!(config as { ui?: { agent_debug_logs?: boolean } })?.ui?.agent_debug_logs;
}

function debugLog(enabled: boolean, message: string) {
  if (enabled) console.log(message);
}

function getToolCallLimit(maxIterations: number, localMode = false): number {
  return Math.max(maxIterations, maxIterations * (localMode ? LOCAL_TOOL_CALLS_PER_STEP : TOOL_CALLS_PER_STEP));
}

function buildResearchSynthesisInstruction(params: { prompt?: string; searchMode?: 'search' | 'deep' | 'max'; sourceCount: number; toolCalls: number }): string {
  const mode = params.searchMode || 'search';
  return [
    `Tool gathering has reached the configured research budget after ${params.toolCalls} tool calls and ${params.sourceCount} gathered source${params.sourceCount === 1 ? '' : 's'}.`,
    'Do not call any more tools. Continue by writing the final answer now from the gathered evidence.',
    mode === 'max'
      ? 'This is MAX research: produce a complete, polished report with methodology/evidence-quality notes, deep synthesis, tables where useful, unresolved gaps, and a full references section.'
      : mode === 'deep'
        ? 'This is DEEP research: produce a thorough, polished report with synthesis, evidence-quality notes, practical takeaways, caveats, and references.'
        : 'Produce a complete answer using the gathered evidence.',
    'Follow APA 7 report norms: clear heading hierarchy, formal objective tone, evidence-based synthesis, in-text citations where metadata allows, and a References section.',
    'Format references as APA 7 web references using available metadata only: author/organization when present, year/date when present, title, site/publisher when distinct, and URL. Use (n.d.) when no date is available. Never invent authors, dates, titles, or facts.',
    params.prompt ? `Current user request: ${params.prompt}` : ''
  ].filter(Boolean).join('\n');
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

    case 'preview_project': {
      return handlePreviewProject({
        args,
        files: ctx.files,
        buildPreviewHtml,
        ok
      }) as ToolResult;
    }

    case 'create_report': {
      return handleCreateReport({
        args,
        ctx,
        normPath,
        isWorkspace,
        buildHtmlReport,
        buildMarkdownReport,
        writeWorkspaceFile,
        validateGeneratedDocumentArgs,
        ok,
        fail
      }) as Promise<ToolResult>;
    }

    case 'create_work_product': {
      return handleCreateWorkProduct({
        args,
        ctx,
        isTauri,
        isWorkspace,
        uid,
        viewerPathFor,
        createWorkProductArtifactFiles,
        validateGeneratedDocumentArgs,
        buildArtifact,
        ok,
        fail,
        failFromError
      }) as Promise<ToolResult>;
    }

    case 'create_document': {
      return handleCreateDocument({
        isTauri,
        ctx,
        args,
        createDocxArtifactFile,
        addGeneratedArtifactFile,
        validateGeneratedDocumentArgs,
        fail,
        failFromError
      }) as Promise<ToolResult>;
    }

    case 'create_spreadsheet': {
      return handleCreateSpreadsheet({
        isTauri,
        ctx,
        args,
        createXlsxArtifactFile,
        addGeneratedArtifactFile,
        validateGeneratedDocumentArgs,
        fail,
        failFromError
      }) as Promise<ToolResult>;
    }

    case 'create_presentation': {
      return handleCreatePresentation({
        isTauri,
        ctx,
        args,
        createPptxArtifactFile,
        addGeneratedArtifactFile,
        validateGeneratedDocumentArgs,
        fail,
        failFromError
      }) as Promise<ToolResult>;
    }

    case 'create_pdf': {
      return handleCreatePdf({
        isTauri,
        ctx,
        args,
        createPdfArtifactFile,
        addGeneratedArtifactFile,
        validateGeneratedDocumentArgs,
        fail,
        failFromError
      }) as Promise<ToolResult>;
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
}): Promise<string> {
  return buildStrictFallbackContentCore({
    ...params,
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
  let useNativeTools = isTauri() && agentSupportsNativeTools(config as any);
  debugLog(debugLogs, `[agent] START | backend=${backendMode} | provider=${localMode ? 'local' : providerName} | model=${activeModel} | isTauri=${isTauri()} | useNativeTools=${useNativeTools} | maxIterations=${maxIterations} | maxToolCalls=${maxToolCalls}`);
  debugLog(debugLogs, `[agent] supportsNativeTools check: providerName=${localMode ? 'local' : providerName} modelId=${activeModel} result=${agentSupportsNativeTools(config as any)}`);
  let nativeFailed = false;
  let directMode = false;
  let consecutiveEmptyResponses = 0;
  const wantsWebsiteArtifact = isWebsiteBuildRequest(
    args.rawPrompt || [...args.messages].reverse().find((message) => message.role === 'user')?.content?.toString?.() || ''
  );

  const toolMode = args.toolMode || 'agent';
  const toolDefs = toolMode === 'search_chat'
    ? getToolDefinitions().filter((tool) => SEARCH_TOOL_NAMES.has(tool.function.name))
    : getToolDefinitions();
  const modeNote = executionMode === 'workspace'
    ? 'You are attached to a real workspace folder. Only use persistent file operations when the app explicitly enables workspace mode.'
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
  const agentExtra = [modeNote, searchModeNote, args.systemPrompt, requestReminder].filter(Boolean).join('\n\n');
  const nativeSys = getNativeSystemPrompt(agentExtra, maxToolCalls, maxIterations, toolMode);
  const xmlSys = getXmlSystemPrompt(agentExtra, maxToolCalls, maxIterations, toolDefs, toolMode);
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

  const isResearchChat = toolMode === 'search_chat' && (args.searchMode === 'deep' || args.searchMode === 'max');
  const forceResearchSynthesis = async (reason: string): Promise<string> => {
    steps.push({
      id: uid('step'),
      type: 'thinking',
      label: 'Synthesizing final research report',
      status: 'running',
      detail: reason
    });
    args.onStep([...steps]);
    args.onProgress?.('Synthesizing final research report…');
    injectEvidenceSummaryMessage(messages, toolObservations, sources, compactText);
    messages[0] = { role: 'system', content: directSys };
    messages.push({
      role: 'user',
      content: buildResearchSynthesisInstruction({
        prompt: args.rawPrompt,
        searchMode: args.searchMode,
        sourceCount: sources.length,
        toolCalls: totalToolCalls
      })
    });
    const completion = await completeAssistantReply({ messages, signal: args.signal });
    checkAbort();
    const content = stripToolCallArtifacts(String(completion?.content || '')).trim();
    if (completion?.reasoning) finalReasoning = finalReasoning || String(completion.reasoning);
    const lastStep = steps[steps.length - 1];
    if (lastStep?.label === 'Synthesizing final research report') {
      lastStep.status = content ? 'done' : 'error';
      lastStep.detail = content ? 'Final research report ready' : 'The model did not return final report text';
      args.onStep([...steps]);
    }
    return content;
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    debugLog(debugLogs, `[agent] iter=${iter} | nativeActive=${useNativeTools && !nativeFailed && !directMode} | nativeFailed=${nativeFailed} | directMode=${directMode} | messageCount=${messages.length}`);
    checkAbort();
    throwIfAborted();
    if (Date.now() - startTime > (args.maxTimeMs || MAX_TIME_MS)) {
      errorReason = errorReason || 'Agent timed out before completing the requested depth.';
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

    trimContextMessages(messages, localMode ? 4 : KEEP_TOOL_PAIRS);
    await enforceTokenBudgetMessages({
      messages,
      config,
      isTauri,
      invoke,
      debugLog
    });

    injectEvidenceSummaryMessage(messages, toolObservations, sources, compactText);

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
    } catch (e: unknown) {
      if (isAbortError(e)) throw e;
      const errMsg = toErrorMessage(e);
      debugLog(debugLogs, `[agent] LLM ERROR | msg="${errMsg.slice(0, 200)}" | nativeActive=${nativeActive} | iter=${iter}`);
      if (nativeActive && /tool|400|422|unsupported/i.test(errMsg)) {
        debugLog(debugLogs, '[agent] -> falling back to XML (tool/400/422/unsupported error)');
        nativeFailed = true;
        setToolSupportCache(config as any, false);
        messages[0] = { role: 'system', content: xmlSys };
        try {
          completion = await completeAssistantReply({ messages, signal: args.signal });
          checkAbort();
        } catch (e2: unknown) {
          if (isAbortError(e2)) throw e2;
          thinkStep.status = 'error';
          thinkStep.label = 'Error';
          thinkStep.detail = toErrorMessage(e2);
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
        } catch (e3: unknown) {
          thinkStep.status = 'error';
          thinkStep.label = 'Error';
          thinkStep.detail = toErrorMessage(e3);
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
      if (isResearchChat) {
        try {
          finalContent = await forceResearchSynthesis(`Research budget reached (${totalToolCalls}/${maxToolCalls}); writing final report from gathered evidence.`);
          if (finalContent) {
            stopReason = 'none';
            warningReason = undefined;
            break;
          }
        } catch (e: unknown) {
          if (isAbortError(e)) throw e;
          debugLog(debugLogs, `[agent] research synthesis after tool limit failed: ${toErrorMessage(e).slice(0, 200)}`);
        }
      }
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
      visibleFileCount: visibleFileCount(ctx.files),
      draftChars: maxObservedDraftChars
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
            const toolStep = createRunningToolStep(tc, STEP_TYPE, uid);
            return { tc, toolStep, result: await executeToolWithTimeout(tc.name, tc.arguments, ctx) };
          })
        );

        // Process all results
        for (const entry of results) {
          if (entry.status === 'rejected') continue;
          const { tc, toolStep, result } = entry.value;

          if (applyNextTurnMods(messages, result)) nativeFailed = true;
          toolObservations.push(summarizeToolObservation(tc.name, tc.arguments, result));
          mergeWebSearchSources({ toolCall: tc, result, sources, seenUrls, onSources: args.onSources });
          finalizeToolStep(toolStep, result);
          steps.push(toolStep);
          publishArtifact(args.onArtifact, () => buildArtifact(ctx));
          appendToolResultMessage({ toolCall: tc, result, messages, nativeActive, nativeFailed, maxToolResultChars: MAX_TOOL_RESULT_CHARS });
        }
        args.onStep([...steps]);
      }
    }

    totalToolCalls += budgetedToolCalls;

    if (directMode && hasVisibleArtifact(ctx.files)) {
      finalContent = synthesizeArtifactCompletion(ctx) || 'Website files created and preview is ready.';
      break;
    }

    if (totalToolCalls >= maxToolCalls) {
      if (isResearchChat) {
        try {
          finalContent = await forceResearchSynthesis(`Research budget reached (${totalToolCalls}/${maxToolCalls}); writing final report from gathered evidence.`);
          if (finalContent) {
            stopReason = 'none';
            warningReason = undefined;
            break;
          }
        } catch (e: unknown) {
          if (isAbortError(e)) throw e;
          debugLog(debugLogs, `[agent] research synthesis after tool limit failed: ${toErrorMessage(e).slice(0, 200)}`);
        }
      }
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

  if (!finalContent && isResearchChat) {
    try {
      finalContent = await forceResearchSynthesis('Research step budget reached; writing final report from gathered evidence.');
      if (finalContent) {
        stopReason = 'none';
        warningReason = undefined;
        errorReason = undefined;
      }
    } catch (e: unknown) {
      if (isAbortError(e)) throw e;
      debugLog(debugLogs, `[agent] research synthesis after iteration limit failed: ${toErrorMessage(e).slice(0, 200)}`);
    }
  }

  if (!finalContent) {
    for (let attempt = 1; attempt <= MAX_FORCED_FINAL_ANSWER_ATTEMPTS; attempt++) {
      try {
        injectEvidenceSummaryMessage(messages, toolObservations, sources, compactText);
        messages[0] = { role: 'system', content: directSys };
        messages.push({
          role: 'user',
          content: attempt === 1
            ? 'You have reached the step limit. Do NOT call tools. Using only gathered evidence, provide the best possible final answer now. If something is uncertain, state it explicitly.'
            : 'Final attempt: no tools, no extra reasoning. Return the final answer now in plain text using only gathered evidence.'
        });
        const forced = await completeAssistantReply({ messages, signal: args.signal });
        const forcedContent = stripToolCallArtifacts(String(forced?.content || '')).trim();
        if (!forcedContent) continue;
        finalContent = forcedContent;
        if (forced.reasoning) finalReasoning = finalReasoning || String(forced.reasoning);
        if (stopReason === 'none') stopReason = 'iteration_limit';
        warningReason = warningReason || 'Agent reached the iteration limit and produced a final answer from gathered evidence.';
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
  args: RunAgentTaskArgs,
  messages: RequestMessage[],
  sources: SearchResult[],
  seenUrls: Set<string>,
  observations: ToolObservation[],
  nativeActive: boolean,
  nativeFailed: boolean
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
    buildArtifact: () => buildArtifact(ctx),
    maxToolResultChars: MAX_TOOL_RESULT_CHARS
  });
}
