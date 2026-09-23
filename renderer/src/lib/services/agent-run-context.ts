/**
 * The state of one Home agent run, and the helpers every phase shares:
 * evidence injection, the evidence-only and strict fallbacks, artifact
 * publishing and the requested-deliverable checks.
 *
 * Phases (research bootstrap, model call, loop, final answer) receive the
 * run and mutate it; nothing else carries state between them.
 */

import type { AgentArtifact, AgentStep, AgentStopReason, AppConfig } from '$lib/types/chat';
import type { SearchResult } from '$lib/types/bridge';
import type { CompletionResult, RequestMessage } from '$lib/services/chat-api';
import type { RunAgentTaskArgs, ToolContext, ToolObservation, ToolResult } from '$lib/services/agent-types';
import { normalizeHomeRuntimeMode } from '$shared/agente-protocol';
import type { AgentMessage, UserMessage } from '$shared/agent-core/types';
import { normPath } from '$lib/services/agent-workspace';
import { buildMarkdownReport } from '$lib/services/agent-content';
import { sanitizeAgentVisibleText, stripToolCallArtifacts } from '$lib/services/agent-parsing';
import { hasVisibleArtifact } from '$lib/services/agent-flow';
import {
  compactText, sourceRows, evidenceSources, buildEvidenceText,
  requestedArtifactKinds, missingRequestedArtifactExtensions, fallbackTitle,
  requestedVisualArtifacts, VISUAL_ARTIFACT_TOOL, type VisualArtifactKind,
  hasAllRequestedArtifacts as hasAllRequestedArtifactsForFiles,
  hasGatheredEvidence as hasGatheredEvidenceForContext
} from '$lib/services/agent-evidence';
import { buildScopedArtifact } from '$lib/services/agent-artifact';
import { injectEvidenceSummary } from '$lib/services/agent-message-context';
import { injectResearchEvidencePack } from '$lib/services/agent-evidence-pack';
import {
  ensureRequestedArtifactsFromEvidence as ensureRequestedArtifactsFromEvidenceCore,
  buildStrictFallbackContent as buildStrictFallbackContentCore
} from '$lib/services/agent-strict-fallback';
import { publishArtifacts } from '$lib/services/agent-tool-result';
import { executeTool, uid } from '$lib/services/agent-tool-dispatch';
import { normalizeAgentHistory, type AgentRunPlan } from '$lib/services/agent-run-plan';

export interface AgentRun {
  args: RunAgentTaskArgs;
  config: AppConfig;
  plan: AgentRunPlan;
  ctx: ToolContext;
  steps: AgentStep[];
  sources: SearchResult[];
  seenUrls: Set<string>;
  observations: ToolObservation[];
  /** The chat history the run was started with, in provider format. */
  history: RequestMessage[];
  /** The run's own turns in the shared agent-core message model. */
  transcript: AgentMessage[];
  /** Tool-call ids the provider issued natively; the rest came from a text dialect. */
  nativeCallIds: Set<string>;
  /**
   * The last request built from history + transcript, in provider format.
   * Index 0 is always the active system prompt.
   */
  messages: RequestMessage[];
  /** Non-system history rows, which context trimming must never drop. */
  historyCount: number;
  /** The core turn in progress (1-based) and its "thinking" step. */
  turn: number;
  currentStep: AgentStep | null;
  /** The outcome is decided (answer, fallback or failure): no review, no more turns. */
  settled: boolean;
  artifacts: AgentArtifact[];
  transport: {
    /** Native tool calling failed once; the run stays on the XML contract. */
    nativeFailed: boolean;
    /** No tools at all: the model answers (or writes code blocks) directly. */
    directMode: boolean;
  };
  finalContent: string;
  finalReasoning: string;
  errorReason?: string;
  warningReason?: string;
  stopReason: AgentStopReason;
  usage: CompletionResult['usage'];
  totalToolCalls: number;
  maxDraftChars: number;
  startTime: number;
}

export function createAgentRun(args: RunAgentTaskArgs, config: AppConfig, plan: AgentRunPlan): AgentRun {
  const sources: SearchResult[] = [];
  const history = normalizeAgentHistory(args.messages);
  return {
    args,
    config,
    plan,
    ctx: {
      chatId: args.chatId,
      files: {},
      conversationContext: args.conversationContext,
      searchMode: args.searchMode,
      sources,
      rawPrompt: args.rawPrompt,
      workspaceRoot: args.workspaceRoot,
      workspaceFiles: args.workspaceFiles ? [...args.workspaceFiles] : undefined,
      executionMode: plan.executionMode,
      runtimeMode: normalizeHomeRuntimeMode(args.runtimeMode),
      debugLogs: plan.debugLogs,
      signal: args.signal,
      artifactToggles: plan.artifactToggles
    },
    steps: [],
    sources,
    seenUrls: new Set<string>(),
    observations: [],
    history,
    transcript: [],
    nativeCallIds: new Set<string>(),
    messages: [{ role: 'system', content: plan.nativeTools ? plan.prompts.native : plan.prompts.xml }, ...history],
    historyCount: history.filter((message) => message.role !== 'system').length,
    turn: 0,
    currentStep: null,
    settled: false,
    artifacts: [],
    transport: { nativeFailed: false, directMode: false },
    finalContent: '',
    finalReasoning: '',
    stopReason: 'none',
    usage: null,
    totalToolCalls: 0,
    maxDraftChars: 0,
    startTime: Date.now()
  };
}

export const prompt = (run: AgentRun) => run.args.rawPrompt || '';

/** Queue a user-role message (a nudge or instruction) for the next turn. */
export function pushUser(run: AgentRun, content: string) {
  run.transcript.push(userMessage(content));
}

export function userMessage(content: string): UserMessage {
  return { role: 'user', content, ts: Date.now() };
}

/** Structured tool result the Home tools attach to a core ToolResult. */
export interface HomeToolDetails {
  payload: unknown;
}

const PREPARING = 'Preparing to use tools\u2026';

/**
 * Provider request for the next call: system prompt, the chat history, then
 * the transcript. Native calls keep their `tool_calls`/`tool` pairing; calls
 * parsed from a text dialect go back as plain text, because a text-dialect
 * turn has no `tool_calls` block for a `tool` message to answer.
 */
export function buildWireMessages(run: AgentRun): RequestMessage[] {
  const which = run.transport.directMode ? 'direct' : nativeActive(run) ? 'native' : 'xml';
  const wire: RequestMessage[] = [{ role: 'system', content: run.plan.prompts[which] }, ...run.history];
  for (const message of run.transcript) {
    if (message.role === 'user') {
      wire.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      // Failed or aborted calls never go back to the provider.
      if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
      const native = (message.toolCalls || []).filter((call) => run.nativeCallIds.has(call.id));
      if (native.length) {
        wire.push({
          role: 'assistant',
          content: message.content || null,
          ...(message.providerState ? { providerState: message.providerState as RequestMessage['providerState'] } : {}),
          ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
          tool_calls: native.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) }
          }))
        });
      } else {
        wire.push({ role: 'assistant', content: stripToolCallArtifacts(sanitizeAgentVisibleText(message.content)) || PREPARING });
      }
      continue;
    }
    if (run.nativeCallIds.has(message.toolCallId)) {
      wire.push({ role: 'tool', content: message.content, tool_call_id: message.toolCallId, name: message.toolName });
    } else {
      const payload = (message.details as HomeToolDetails | undefined)?.payload ?? message.content;
      wire.push({ role: 'user', content: `Tool result for ${message.toolName}:\n${JSON.stringify(payload, null, 2)}` });
    }
  }
  return wire;
}

export function emitSteps(run: AgentRun) {
  run.args.onStep([...run.steps]);
}

export function pushStep(run: AgentRun, step: Omit<AgentStep, 'id'>) {
  run.steps.push({ id: uid('step'), ...step });
  emitSteps(run);
}

/** Native tool calling is live for the next model call. */
export function nativeActive(run: AgentRun): boolean {
  return run.plan.nativeTools && !run.transport.nativeFailed && !run.transport.directMode;
}

export function useSystemPrompt(run: AgentRun, which: keyof AgentRunPlan['prompts']) {
  run.messages[0] = { role: 'system', content: run.plan.prompts[which] };
}

export function checkAbort(run: AgentRun) {
  if (run.args.signal?.aborted) throw new DOMException('Agent task cancelled by user', 'AbortError');
}

/**
 * Accumulates one artifact per artifact-producing tool call and republishes
 * the whole list, so every visual a turn creates reaches the screen.
 * Re-running the same tool replaces its entry (keyed on `entryPath`).
 */
export function publishToolArtifact(run: AgentRun, result: ToolResult) {
  if (!run.plan.artifactsEnabled) return;
  const built = buildScopedArtifact({
    files: run.ctx.files,
    workProduct: run.ctx.workProduct,
    artifactManifest: result.artifactManifest ?? null
  }, result);
  if (!built) return;
  const key = built.manifest?.entryPath || '';
  const index = key ? run.artifacts.findIndex((entry) => entry.manifest?.entryPath === key) : -1;
  if (index >= 0) run.artifacts[index] = built;
  else run.artifacts.push(built);
  publishArtifacts(run.args.onArtifact, run.artifacts);
}

/** Put the gathered evidence in front of the model (research gets the dense pack). */
export function injectLiveEvidence(run: AgentRun) {
  const { plan, args } = run;
  const depthSearch = args.searchMode === 'search' || args.searchMode === 'deep' || args.searchMode === 'max';
  const mode = plan.researchMode;
  if (plan.isResearchChat || (plan.toolMode === 'search_chat' && depthSearch)) {
    // Dense pack with query-relevant excerpts — primary synthesis fuel; never token-trimmed.
    injectResearchEvidencePack(run.messages, run.observations, run.sources, {
      query: prompt(run),
      mode,
      maxSources: mode === 'max' ? 40 : mode === 'deep' ? 28 : 16,
      maxExcerptChars: mode === 'max' ? 4000 : mode === 'deep' ? 3000 : 1800,
      maxTotalChars: mode === 'max' ? 120_000 : mode === 'deep' ? 80_000 : 40_000,
      maxFacts: mode === 'max' ? 60 : mode === 'deep' ? 40 : 24
    });
    return;
  }
  injectEvidenceSummary(run.messages, run.observations, run.sources, compactText, plan.isResearchChat ? {
    observationLimit: mode === 'max' ? 80 : 50,
    observationChars: mode === 'max' ? 4000 : 3000,
    sourceLimit: mode === 'max' ? 48 : 36,
    sourceChars: mode === 'max' ? 3500 : 2500,
    instruction: 'The following evidence was gathered during Search/Deep/Max research. Use these source-specific facts, URLs, and excerpts as the primary source of truth for the final answer. Do not answer generically when evidence is present. Write a polished APA 7 synthesized report — never dump raw evidence or title a section "Gathered Evidence". Never mention tools or step limits.'
  } : undefined);
}

function hasAllRequestedArtifacts(run: AgentRun): boolean {
  return hasAllRequestedArtifactsForFiles(run.ctx.files, prompt(run));
}

export function hasGatheredEvidence(run: AgentRun, sources: SearchResult[], content = ''): boolean {
  return hasGatheredEvidenceForContext({ files: run.ctx.files, observations: run.observations, sources, content, hasVisibleArtifact });
}

/**
 * Inline visuals the prompt asked for that no tool has created yet. Compared
 * against created artifact manifests (inline visuals leave no extension to
 * match). Website builds are enforced separately, through write_file.
 */
export function missingRequestedVisuals(run: AgentRun): VisualArtifactKind[] {
  if (run.plan.wantsWebsiteArtifact) return [];
  const requested = requestedVisualArtifacts(prompt(run));
  if (!requested.length) return [];
  const created = new Set(run.artifacts.map((entry) => entry.manifest?.kind));
  return requested.filter((kind) =>
    run.plan.toolDefs.some((tool) => tool.function.name === VISUAL_ARTIFACT_TOOL[kind]) && !created.has(kind)
  );
}

function ensureRequestedArtifactsFromEvidence(run: AgentRun, reason: string, observations: ToolObservation[]): Promise<string[]> {
  return ensureRequestedArtifactsFromEvidenceCore({
    prompt: prompt(run),
    reason,
    ctx: run.ctx,
    observations,
    sources: run.sources,
    requestedArtifactKinds,
    missingRequestedArtifactExtensions,
    buildEvidenceText,
    fallbackTitle,
    evidenceSources,
    sourceRows,
    compactText,
    executeTool,
    publishToolArtifact: (result) => publishToolArtifact(run, result),
    normPath,
    buildMarkdownReport
  });
}

/** The honest answer from gathered evidence when the model could not finish. */
function strictFallback(
  run: AgentRun,
  reason: string,
  options: { observations?: ToolObservation[]; notice?: string | null } = {}
): Promise<string> {
  const observations = options.observations || run.observations;
  return buildStrictFallbackContentCore({
    prompt: prompt(run),
    reason,
    ctx: run.ctx,
    observations,
    sources: run.sources,
    mode: run.plan.fallbackMode,
    notice: options.notice,
    ensureRequestedArtifactsFromEvidence: (params) => ensureRequestedArtifactsFromEvidence(run, params.reason, params.observations),
    evidenceSources,
    missingRequestedArtifactExtensions
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

export function codeObservationSummary(run: AgentRun): string {
  return summarizeCodeObservations(run.observations);
}

function workspaceStoppedContent(reason: string, observations: ToolObservation[]): string {
  const latest = [...observations].reverse().find((observation) => observation.name);
  const target = latest?.args?.path || latest?.args?.command || latest?.args?.query || latest?.args?.url;
  const lastAction = latest
    ? ` Last completed action: ${latest.name.replace(/_/g, ' ')}${target ? ` (${compactText(target, 120)})` : ''}.`
    : '';
  return [
    `I stopped before finishing because ${reason}.${lastAction}`,
    '',
    summarizeCodeObservations(observations),
    '',
    'You can ask me to continue from here, or open the workspace panel for step details.'
  ].join('\n');
}

/** Stop-early content: a workspace summary, or the strict evidence fallback. */
export function evidenceOnlyFallback(run: AgentRun, reason: string, options: { notice?: string | null } = {}): Promise<string> {
  if (run.plan.executionMode === 'workspace') return Promise.resolve(workspaceStoppedContent(reason, run.observations));
  return strictFallback(run, reason, options);
}

/**
 * The model tried to finish without the files (and optionally the inline
 * visuals) the prompt asked for. Build them from gathered evidence; if that
 * still leaves something missing, end the run with an honest fallback.
 *
 * Returns true when the run may finalize the draft, false when it ended here.
 */
export async function enforceRequestedArtifacts(
  run: AgentRun,
  params: { draft: string; reason: string; includeVisuals: boolean }
): Promise<boolean> {
  const missing = () => ({
    files: !hasAllRequestedArtifacts(run),
    visuals: params.includeVisuals ? missingRequestedVisuals(run) : []
  });
  const before = missing();
  if (!before.files && !before.visuals.length) return true;

  const observations: ToolObservation[] = [...run.observations, {
    name: 'assistant_draft',
    args: {},
    success: true,
    summary: `Assistant draft before artifact enforcement: ${compactText(params.draft, 1400)}`
  }];
  const created = await ensureRequestedArtifactsFromEvidence(run, params.reason, observations);
  const after = missing();
  if (after.files || after.visuals.length) {
    if (after.files) {
      run.steps.push({
        id: uid('step'),
        type: 'error',
        label: 'Missing requested files',
        status: 'error',
        detail: `Could not create: ${missingRequestedArtifactExtensions(run.ctx.files, prompt(run)).map((ext) => `.${ext}`).join(', ')}`
      });
    }
    if (after.visuals.length) {
      run.steps.push({
        id: uid('step'),
        type: 'error',
        label: 'Missing requested visual',
        status: 'error',
        detail: `Could not create: ${after.visuals.map((kind) => VISUAL_ARTIFACT_TOOL[kind]).join(', ')}`
      });
    }
    emitSteps(run);
    run.finalContent = await strictFallback(run, params.reason, { observations });
    run.stopReason = 'missing_artifacts';
    run.errorReason = 'The agent answered without creating the requested files.';
    return false;
  }
  if (created.length) {
    pushStep(run, {
      type: 'writing',
      label: 'Created requested files',
      status: 'done',
      detail: created.join(', '),
      fileChanges: created.map((path) => ({ path, kind: 'created' as const }))
    });
  }
  return true;
}

export function mergeCompletionUsage(
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
