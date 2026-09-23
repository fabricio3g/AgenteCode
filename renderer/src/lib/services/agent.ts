/**
 * The Home agent run (runAgentTask): a tool loop over one model.
 *
 * This file is the driver. Each iteration asks the model for its next move,
 * turns the reply into tool calls, applies the stop guards and runs the
 * tools; the phases live in their own modules:
 *
 * - agent-run-plan       profile, budgets, tools and system prompts
 * - agent-run-context    run state and shared helpers (evidence, fallbacks)
 * - agent-research-bootstrap  the system-owned first search for research runs
 * - agent-model-call     one model call and its transport fallback ladder
 * - agent-tool-calls     parsing tool calls out of a reply
 * - agent-loop-guard     loop / stagnation / explore-only guards
 * - agent-tool-dispatch  tool name → handler, with timeouts
 * - agent-run-finish     forced final answer, fallback and the result
 */

import type { AgentStep } from '$lib/types/chat';
import type { AgentTaskResult, RunAgentTaskArgs, ToolCall, ToolResult } from '$lib/services/agent-types';
import { loadAppConfig } from '$lib/utils/storage';
import { isElectron, invoke } from '$lib/services/bridge';
import { toErrorMessage } from '$lib/utils/errors';
import { hasToolIntent, sanitizeAgentVisibleText, stripToolCallArtifacts } from '$lib/services/agent-parsing';
import { activityLabel } from '$lib/utils/tool-ui';
import { FINAL_ANSWER_CONTRACT_REMINDER } from '$lib/services/agent-prompts';
import { hasVisibleArtifact, visibleFileCount } from '$lib/services/agent-flow';
import { summarizeToolObservation, VISUAL_ARTIFACT_TOOL } from '$lib/services/agent-evidence';
import { synthesizeArtifactCompletion } from '$lib/services/agent-artifact';
import { STEP_TYPE } from '$lib/services/agent-tooling';
import { trimContext, ensureToolCallPairs } from '$lib/services/agent-message-context';
import { enforceTokenBudget } from '$lib/services/agent-token-budget';
import { groupParallelAndSequential } from '$lib/services/agent-tool-scheduler';
import { executeSingleTool } from '$lib/services/agent-tool-execution';
import { hasEnoughResearchEvidence, shouldForceResearchSynthesis } from '$lib/services/research-pipeline';
import {
  appendToolResultMessage,
  createRunningToolStep,
  displayToolLabel,
  finalizeToolStep,
  mergeWebSearchSources,
  recoverOptionalPresentationFailure
} from '$lib/services/agent-tool-result';
import { debugLog, executeToolWithTimeout, fail, uid } from '$lib/services/agent-tool-dispatch';
import { resolveAgentRunPlan } from '$lib/services/agent-run-plan';
import {
  checkAbort,
  createAgentRun,
  emitSteps,
  enforceRequestedArtifacts,
  evidenceOnlyFallback,
  injectLiveEvidence,
  mergeCompletionUsage,
  missingRequestedVisuals,
  nativeActive as isNativeActive,
  publishToolArtifact,
  pushStep,
  throwIfAborted,
  useSystemPrompt,
  type AgentRun
} from '$lib/services/agent-run-context';
import { runResearchBootstrap } from '$lib/services/agent-research-bootstrap';
import { callModel } from '$lib/services/agent-model-call';
import { extractToolCalls, normalizeMapCalls, websiteWritesFromCodeblocks } from '$lib/services/agent-tool-calls';
import { createExploreGuard, createLoopGuard } from '$lib/services/agent-loop-guard';
import { buildAgentResult, forceFinalAnswer, settleWithoutAnswer } from '$lib/services/agent-run-finish';

export { INSTANT_TOOL_NAMES } from '$lib/services/agent-run-plan';

const MAX_TOOL_RESULT_CHARS = 12000;

/** What an iteration phase tells the loop. */
type Flow = 'next' | 'continue' | 'stop';

/** Per-run loop state that is not part of the result. */
interface LoopState {
  researchBootstrapped: boolean;
  researchForceWrite: boolean;
  consecutiveEmptyReplies: number;
  /** The model talked about tools without a parseable call: remind it of the format once. */
  toolFormatRetryDone: boolean;
  /** The model answered a visual request in prose: name the exact tool once. */
  visualNudgeDone: boolean;
  loopGuard: ReturnType<typeof createLoopGuard>;
  exploreGuard: ReturnType<typeof createExploreGuard>;
}

export async function runAgentTask(args: RunAgentTaskArgs): Promise<AgentTaskResult> {
  const config = await loadAppConfig();
  const plan = resolveAgentRunPlan(args, config, { isElectron: isElectron() });
  const run = createAgentRun(args, config, plan);
  debugLog(plan.debugLogs, `[agent] START | profile=${plan.agentProfile} | backend=${plan.backendMode} | provider=${plan.localMode ? 'local' : plan.providerName} | model=${plan.activeModel} | isElectron=${isElectron()} | useNativeTools=${plan.nativeTools} | maxIterations=${plan.maxIterations} | maxToolCalls=${plan.maxToolCalls} | maxTimeMs=${plan.maxTimeMs}`);

  const researchBootstrapped = await runResearchBootstrap(run);
  const state: LoopState = {
    researchBootstrapped,
    researchForceWrite: plan.isResearchChat && researchBootstrapped && hasEnoughResearchEvidence(plan.researchMode, run.sources),
    consecutiveEmptyReplies: 0,
    toolFormatRetryDone: false,
    visualNudgeDone: false,
    loopGuard: createLoopGuard({ localMode: plan.localMode, isResearchChat: plan.isResearchChat }),
    exploreGuard: createExploreGuard()
  };

  for (let iter = 0; iter < plan.maxIterations; iter++) {
    if (await runIteration(run, state, iter) === 'stop') break;
  }

  await forceFinalAnswer(run);
  await settleWithoutAnswer(run);
  return buildAgentResult(run);
}

async function runIteration(run: AgentRun, state: LoopState, iter: number): Promise<Flow> {
  const { plan, args, transport } = run;
  debugLog(plan.debugLogs, `[agent] iter=${iter} | nativeActive=${isNativeActive(run)} | nativeFailed=${transport.nativeFailed} | directMode=${transport.directMode} | messageCount=${run.messages.length}`);
  throwIfAborted(run);
  if (Date.now() - run.startTime > plan.maxTimeMs) {
    run.stopReason = 'timeout';
    if (plan.isResearchChat && run.sources.length) {
      // Deliver the report from sources rather than hard-failing research.
      run.warningReason = undefined;
    } else {
      run.errorReason = run.errorReason || 'Agent timed out before completing the requested depth.';
    }
    return 'stop';
  }

  const step = startThinkStep(run, state, iter);
  await prepareContext(run);

  const nativeActive = isNativeActive(run);
  useSystemPrompt(run, transport.directMode ? 'direct' : nativeActive ? 'native' : 'xml');
  debugLog(plan.debugLogs, `[agent] calling LLM via: ${transport.directMode ? 'direct' : nativeActive ? 'native' : 'xml'} | toolDefs=${nativeActive ? plan.toolDefs.length : 0} | messages=${run.messages.length}`);
  const reasoningBeforeTurn = run.finalReasoning;
  const completion = await callModel(run, { iter, step, nativeActive });
  if (!completion) return 'stop';

  run.usage = mergeCompletionUsage(run.usage, completion.usage);
  // Parse the protocol before sanitizing display text: sanitizing first erased
  // XML calls (including llama.cpp fallbacks) before any executor saw them.
  const rawContent = String(completion.content || '');
  const reasoning = sanitizeAgentVisibleText(String(completion.reasoning || ''));
  run.maxDraftChars = Math.max(run.maxDraftChars, rawContent.length);
  debugLog(plan.debugLogs, `[agent] LLM result | contentLen=${rawContent.length} | reasoningLen=${reasoning.length} | toolCalls=${completion.toolCalls?.length ?? 0}`);
  if (reasoning) {
    run.finalReasoning = [reasoningBeforeTurn, reasoning].filter(Boolean).join('\n\n');
    args.onReasoning?.(run.finalReasoning);
  }

  if (!rawContent && !completion.toolCalls?.length && !transport.directMode) {
    return handleEmptyReply(run, state, step, nativeActive);
  }
  state.consecutiveEmptyReplies = 0;

  // ── Parse the reply into tool calls ──
  let toolCalls: ToolCall[] = [];
  let cleanContent = rawContent;
  if (transport.directMode) {
    const site = plan.wantsWebsiteArtifact ? websiteWritesFromCodeblocks(rawContent) : null;
    if (!site) return finishDirectReply(run, rawContent);
    toolCalls = site.toolCalls;
    cleanContent = site.cleanContent;
    run.messages.push({ role: 'assistant', content: cleanContent || 'Files generated.' });
  } else {
    const extracted = extractToolCalls({
      rawContent,
      completion,
      iter,
      nativeInUse: nativeActive && !transport.nativeFailed,
      wantsWebsiteArtifact: plan.wantsWebsiteArtifact
    });
    toolCalls = extracted.toolCalls;
    cleanContent = extracted.cleanContent;
    if (extracted.assistantMessage) run.messages.push(extracted.assistantMessage);
    if (extracted.textDialect && nativeActive) transport.nativeFailed = true;
  }
  toolCalls = normalizeMapCalls(toolCalls, nativeActive && !transport.nativeFailed);
  cleanContent = sanitizeAgentVisibleText(cleanContent);
  debugLog(plan.debugLogs, `[agent] parsed ${toolCalls.length} toolCalls${toolCalls.length ? ': ' + toolCalls.map((t) => t.name).join(', ') : ''}`);
  closeThinkStep(run, step, toolCalls, cleanContent);

  if (!toolCalls.length) return finishDraft(run, state, step, rawContent);

  // ── Stop guards and nudges ──
  if (run.totalToolCalls >= plan.maxToolCalls) {
    pushStep(run, {
      type: plan.isResearchChat ? 'writing' : 'error',
      label: plan.isResearchChat ? 'Writing report' : 'Tool limit reached',
      status: plan.isResearchChat ? 'running' : 'error',
      detail: plan.isResearchChat
        ? 'Synthesizing final research report from gathered sources'
        : `Used ${run.totalToolCalls} tools across ${plan.maxIterations} steps. Returning gathered evidence only.`
    });
    return stopAtToolBudget(run, 'the tool budget was reached');
  }

  // Research: force the write once evidence is good enough (don't thrash on more searches).
  if (plan.isResearchChat && shouldForceResearchSynthesis({ mode: plan.researchMode, sources: run.sources, observations: run.observations })) {
    state.researchForceWrite = true;
  }
  if (state.researchForceWrite || iter >= Math.max(0, plan.maxIterations - 2)) {
    run.messages.push({ role: 'user', content: nearEndNudge(run, state) });
  }

  if (plan.isCodeProfile && await guardExploreOnly(run, state, toolCalls) === 'stop') return 'stop';
  if (await guardLoops(run, state, toolCalls) === 'stop') return 'stop';

  // Research: drop extra web_search once evidence is enough (prefer the write path).
  if (plan.isResearchChat && state.researchForceWrite) {
    const withoutSearch = toolCalls.filter((tc) => tc.name !== 'web_search');
    if (withoutSearch.length !== toolCalls.length) {
      toolCalls = withoutSearch;
      if (!toolCalls.length) {
        // The model only wanted another search: exit and force the report.
        injectLiveEvidence(run);
        return 'stop';
      }
    }
  }

  // ── Run the tools ──
  const budgeted = toolCalls.filter((toolCall) => toolCall.name !== 'preview_project').length;
  await executeToolCalls(run, toolCalls, nativeActive);
  run.totalToolCalls += budgeted;

  if (plan.isResearchChat && shouldForceResearchSynthesis({ mode: plan.researchMode, sources: run.sources, observations: run.observations })) {
    state.researchForceWrite = true;
    injectLiveEvidence(run);
  }
  if (transport.directMode && hasVisibleArtifact(run.ctx.files)) {
    run.finalContent = synthesizeArtifactCompletion(run.ctx.files) || 'Website files created and preview is ready.';
    return 'stop';
  }
  if (run.totalToolCalls >= plan.maxToolCalls) return stopAtToolBudget(run, 'the available tool budget was reached');
  return 'next';
}

/** The tool budget ran out. Research leaves the answer to forced synthesis. */
async function stopAtToolBudget(run: AgentRun, reason: string): Promise<Flow> {
  const { plan } = run;
  if (!plan.isResearchChat) {
    run.finalContent = await evidenceOnlyFallback(run, `${reason} (${run.totalToolCalls}/${plan.maxToolCalls})`);
    run.warningReason = run.warningReason || `Agent reached the dynamic tool call limit (${plan.maxToolCalls}) and returned only gathered evidence.`;
  }
  run.stopReason = 'tool_limit';
  return 'stop';
}

function startThinkStep(run: AgentRun, state: LoopState, iter: number): AgentStep {
  const { plan, args } = run;
  const research = plan.isResearchChat;
  const step: AgentStep = {
    id: uid('step'),
    type: research ? (state.researchForceWrite ? 'writing' : 'thinking') : 'thinking',
    label: research
      ? state.researchForceWrite
        ? activityLabel('writing')
        : iter === 0 && !state.researchBootstrapped
          ? activityLabel('searching')
          : activityLabel(null)
      : activityLabel(iter === 0 ? 'planning' : null),
    status: 'running',
    detail: research
      ? (state.researchForceWrite ? 'Synthesizing research report' : (run.sources.length ? `${run.sources.length} sources` : 'Gathering sources'))
      : `Step ${iter + 1} of ${plan.maxIterations}`
  };
  run.steps.push(step);
  emitSteps(run);
  if (iter === 0) {
    args.onProgress?.(research
      ? (state.researchForceWrite ? 'Writing research report…' : 'Searching…')
      : 'Planning how to approach this…');
  }
  return step;
}

/**
 * Keep the request inside budget without ever dropping chat history — only
 * tool-loop growth after the transcript is capped. Research and attached
 * documents are never token-budget trimmed. Then refresh the evidence and
 * repair any unpaired tool calls (providers reject them).
 */
async function prepareContext(run: AgentRun) {
  const { plan, messages } = run;
  if (!plan.preserveDocs) {
    trimContext(messages, { historyCount: run.historyCount, maxLoopMessages: plan.maxLoopMessages });
    await enforceTokenBudget({ messages, config: run.config, isElectron, invoke, debugLog });
  } else if (!plan.isResearchChat) {
    // Soft loop-only trim for search/doc chats.
    trimContext(messages, { historyCount: run.historyCount, maxLoopMessages: 48 });
  }
  injectLiveEvidence(run);
  ensureToolCallPairs(messages, 'fill');
}

function handleEmptyReply(run: AgentRun, state: LoopState, step: AgentStep, nativeActive: boolean): Flow {
  const { plan, transport } = run;
  state.consecutiveEmptyReplies++;
  debugLog(plan.debugLogs, `[agent] EMPTY RESPONSE | consecutiveEmpty=${state.consecutiveEmptyReplies} | nativeFailed=${transport.nativeFailed} | totalToolCalls=${run.totalToolCalls}`);
  const synthesized = synthesizeArtifactCompletion(run.ctx.files);
  if (synthesized && run.totalToolCalls > 0) {
    run.finalContent = synthesized;
    return 'stop';
  }
  if (state.consecutiveEmptyReplies >= 2) {
    transport.directMode = true;
    useSystemPrompt(run, 'direct');
    step.detail = 'Switching to direct mode (tools unavailable)';
    emitSteps(run);
    return 'continue';
  }
  if (!transport.nativeFailed && nativeActive) {
    transport.nativeFailed = true;
    useSystemPrompt(run, 'xml');
    step.detail = 'Falling back to XML mode';
    emitSteps(run);
    return 'continue';
  }
  console.error('[agent] HARD FAIL: Empty response - model may not support tool calling');
  pushStep(run, {
    type: 'error', label: 'Empty response', status: 'error',
    detail: 'The model returned an empty response. The model may not support tool calling.'
  });
  run.errorReason = 'The model returned an empty response.';
  return 'stop';
}

/** Direct mode answered in prose: enforce requested deliverables, then finish. */
async function finishDirectReply(run: AgentRun, rawContent: string): Promise<Flow> {
  const { plan } = run;
  if (plan.wantsWebsiteArtifact && !hasVisibleArtifact(run.ctx.files)) {
    pushStep(run, {
      type: 'error', label: 'Missing website files', status: 'error',
      detail: 'The model described the website but did not provide code blocks or files.'
    });
    run.errorReason = 'The model did not produce website files.';
    return 'stop';
  }
  if (!plan.isInstant) {
    const finished = await enforceRequestedArtifacts(run, {
      draft: rawContent,
      reason: 'direct mode tried to finish without creating the requested files',
      includeVisuals: true
    });
    if (!finished) return 'stop';
  }
  run.messages.push({ role: 'assistant', content: rawContent });
  run.finalContent = stripToolCallArtifacts(rawContent);
  return 'stop';
}

function closeThinkStep(run: AgentRun, step: AgentStep, toolCalls: ToolCall[], cleanContent: string) {
  const research = run.plan.isResearchChat;
  const labels = toolCalls.map((toolCall) => displayToolLabel(toolCall.name)).join(', ');
  step.status = 'done';
  step.detail = toolCalls.length
    ? (research ? labels : `Next: ${labels}`)
    : (research ? 'Writing report' : 'Preparing the answer');
  if (toolCalls.length && cleanContent && cleanContent.length > 10 && !run.transport.directMode) {
    const trimmed = cleanContent.slice(0, 240).replace(/\|+$/g, '').trim();
    if (trimmed) {
      run.steps.push({
        id: uid('step'), type: 'thinking', label: 'Reasoning', status: 'done',
        detail: trimmed.length < cleanContent.length ? trimmed + '…' : trimmed
      });
    }
  }
  emitSteps(run);
}

/**
 * The model replied without tool calls: this is the answer — unless it is
 * missing the website, the tool call it talked about, or the visual it was
 * asked for, in which case it gets one targeted retry.
 */
async function finishDraft(run: AgentRun, state: LoopState, step: AgentStep, rawContent: string): Promise<Flow> {
  const { plan, transport, messages, args } = run;
  if (!rawContent) {
    const synthesized = synthesizeArtifactCompletion(run.ctx.files);
    if (synthesized && run.totalToolCalls > 0) {
      run.finalContent = synthesized;
      return 'stop';
    }
    pushStep(run, {
      type: 'error', label: 'Empty response', status: 'error',
      detail: 'The model returned an empty response. The model may be temporarily unavailable or the prompt may exceed context capacity.'
    });
    run.errorReason = 'The model returned an empty response.';
    return 'stop';
  }

  if (plan.wantsWebsiteArtifact && !hasVisibleArtifact(run.ctx.files)) {
    if (!transport.directMode) {
      transport.directMode = true;
      useSystemPrompt(run, 'direct');
      messages.push({
        role: 'user',
        content: 'You must actually create the website files now. Output complete code blocks for index.html and any needed style.css or script.js. Do not say the work is done unless you provide the file contents.'
      });
      step.detail = 'Switching to direct website build mode';
      emitSteps(run);
      return 'continue';
    }
    pushStep(run, {
      type: 'error', label: 'Missing website files', status: 'error',
      detail: 'The model answered without creating previewable website files.'
    });
    run.errorReason = 'The model answered without creating website files.';
    return 'stop';
  }

  const retryDraft = () => stripToolCallArtifacts(sanitizeAgentVisibleText(rawContent)) || 'Preparing to use tools…';
  // The model described tool use instead of emitting a call: show it the exact format once.
  if (!state.toolFormatRetryDone && !transport.directMode && run.totalToolCalls === 0 && hasToolIntent(rawContent)) {
    state.toolFormatRetryDone = true;
    debugLog(plan.debugLogs, '[agent] -> tool-format retry (draft talked about tools, retrying with exact format)');
    messages.push({ role: 'assistant', content: retryDraft() });
    messages.push({
      role: 'user',
      content: `The tool call could not be read. Use an available tool name and its real arguments: <tool_call>{"name":"TOOL_NAME","arguments":{}}</tool_call>. Available tools: ${plan.toolDefs.map((tool) => tool.function.name).join(', ')}. For a map, use create_map with {"place":"City, Country","zoom":12}. Do not use label or parameters attributes.`
    });
    step.detail = 'Clarifying the tool format and retrying';
    emitSteps(run);
    return 'continue';
  }
  // A visual deliverable answered in prose: name the exact tool once. A second miss fails visibly.
  if (!state.visualNudgeDone && !transport.directMode) {
    const missing = missingRequestedVisuals(run);
    if (missing.length) {
      state.visualNudgeDone = true;
      const toolList = missing.map((kind) => VISUAL_ARTIFACT_TOOL[kind]).join(', ');
      debugLog(plan.debugLogs, `[agent] -> visual-artifact nudge (missing: ${missing.join(', ')})`);
      messages.push({ role: 'assistant', content: retryDraft() });
      messages.push({
        role: 'user',
        content: `You answered in prose, but the user asked for a visual deliverable. Call the matching tool now with real arguments (${toolList}) — do not describe it, create it. If no visual was actually requested, answer normally without tools.`
      });
      step.detail = 'Requesting the missing visual artifact';
      emitSteps(run);
      return 'continue';
    }
  }

  const missingVisuals = missingRequestedVisuals(run);
  if (missingVisuals.length || (hasToolIntent(rawContent) && !sanitizeAgentVisibleText(rawContent))) {
    run.errorReason = missingVisuals.length
      ? `The model did not create the requested ${missingVisuals.join(', ')} widget.`
      : 'The model returned a tool call that could not be executed.';
    run.stopReason = missingVisuals.length ? 'missing_artifacts' : 'error';
    run.finalContent = `${run.errorReason} Please try again.`;
    pushStep(run, { type: 'error', label: 'Could not complete request', status: 'error', detail: run.errorReason });
    return 'stop';
  }

  const finished = await enforceRequestedArtifacts(run, {
    draft: rawContent,
    reason: 'the model tried to finish without creating the requested files',
    includeVisuals: false
  });
  if (!finished) return 'stop';
  args.onProgress?.('Producing final answer…');
  run.finalContent = stripToolCallArtifacts(rawContent);
  return 'stop';
}

function nearEndNudge(run: AgentRun, state: LoopState): string {
  const { plan } = run;
  if (plan.isCodeProfile) {
    return 'You are almost out of steps. STOP exploring. Apply any remaining critical edits now (edit_file/write_file), or if done, respond with a plain-text summary of files changed and how to verify. Do NOT call list_files/read_file unless required for one final fix.';
  }
  if (plan.isResearchChat) {
    return [
      state.researchForceWrite
        ? 'Enough sources have been gathered. Do NOT call more tools.'
        : 'You are almost out of research steps. Do NOT call more tools unless one critical source is missing.',
      'Write the final answer now using the RESEARCH EVIDENCE PACK. Never title a section "Gathered Evidence". Never mention tools or step limits.',
      FINAL_ANSWER_CONTRACT_REMINDER
    ].join('\n\n');
  }
  return 'You are running out of steps. If you need to create a spreadsheet, document, or other artifact, create it NOW using the data from your search results. Otherwise provide your final answer.';
}

/** Code profile: stop endless read/list/search streaks that never write anything. */
async function guardExploreOnly(run: AgentRun, state: LoopState, toolCalls: ToolCall[]): Promise<Flow> {
  const verdict = state.exploreGuard.observe(toolCalls);
  if (verdict === 'ok') return 'next';
  run.messages.push({
    role: 'user',
    content: 'You have explored enough. Stop calling read/list/search tools. Either make the code change now with edit_file/write_file, or finish with a clear summary of findings. No more exploratory tool calls.'
  });
  if (verdict === 'nudge') return 'next';
  pushStep(run, {
    type: 'error',
    label: 'Explore limit — finishing',
    status: 'error',
    detail: `Stopped after ${state.exploreGuard.streak} explore-only tool calls without file changes`
  });
  run.finalContent = await evidenceOnlyFallback(run, 'too many explore-only tool calls without applying changes');
  run.warningReason = 'Agent explored the codebase extensively without finishing changes; returned a partial summary.';
  run.stopReason = 'loop';
  return 'stop';
}

async function guardLoops(run: AgentRun, state: LoopState, toolCalls: ToolCall[]): Promise<Flow> {
  const { plan } = run;
  const verdict = state.loopGuard.observe(toolCalls, {
    sourceCount: run.sources.length,
    visibleFileCount: visibleFileCount(run.ctx.files),
    draftChars: run.maxDraftChars,
    observationCount: run.observations.filter((o) => o.success).length
  });
  if (verdict.suppressed) {
    debugLog(plan.debugLogs, `[agent] loop guard suppressed for ${verdict.suppressed} because progress is still being made.`);
  }
  if (!verdict.stuckTool) return 'next';
  pushStep(run, {
    type: plan.isResearchChat ? 'writing' : 'error',
    label: plan.isResearchChat ? 'Writing report' : 'Loop detected — stopping',
    status: plan.isResearchChat ? 'running' : 'error',
    detail: plan.isResearchChat ? 'Synthesizing research report from gathered sources' : `Repeated calls to ${verdict.stuckTool}`
  });
  // Research: leave finalContent empty for forced report synthesis from the pack.
  if (!plan.isResearchChat) {
    run.finalContent = await evidenceOnlyFallback(run, `it detected repeated calls to ${verdict.stuckTool}`);
    run.warningReason = 'Agent encountered a loop and returned only gathered evidence.';
  }
  run.stopReason = 'loop';
  return 'stop';
}

/** Run the turn's calls: independent ones in parallel, the rest in order. */
async function executeToolCalls(run: AgentRun, toolCalls: ToolCall[], nativeActive: boolean) {
  const { args, ctx, steps, messages, sources, seenUrls, observations } = run;
  const publish = (result: ToolResult) => publishToolArtifact(run, result);
  for (const group of groupParallelAndSequential(toolCalls)) {
    checkAbort(run);
    if (group.length === 1) {
      run.transport.nativeFailed = await executeSingleTool({
        tc: group[0],
        steps,
        ctx,
        args,
        messages,
        sources,
        seenUrls,
        observations,
        nativeActive,
        nativeFailed: run.transport.nativeFailed,
        stepTypeMap: STEP_TYPE,
        uid,
        executeToolWithTimeout: (name, toolArgs) => executeToolWithTimeout(name, toolArgs, ctx),
        summarizeToolObservation,
        publishToolArtifact: publish,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS
      });
      continue;
    }

    args.onProgress?.(`Running ${group.length} tools in parallel…`);
    checkAbort(run);
    // Steps go up before the work starts, so a multi-tool turn streams its rows.
    const running = group.map((tc) => {
      const toolStep = createRunningToolStep(tc, STEP_TYPE, uid);
      steps.push(toolStep);
      return { tc, toolStep };
    });
    emitSteps(run);

    const results = await Promise.allSettled(running.map(({ tc }) => executeToolWithTimeout(tc.name, tc.arguments, ctx)));
    for (const [index, entry] of results.entries()) {
      const { tc, toolStep } = running[index];
      // A rejection still needs a tool_result, or the assistant's tool_calls stay unpaired.
      const settled: ToolResult = entry.status === 'fulfilled'
        ? entry.value
        : fail(toErrorMessage(entry.reason) || 'Tool execution failed');
      const result = recoverOptionalPresentationFailure(tc, settled);
      observations.push(summarizeToolObservation(tc.name, tc.arguments, result));
      mergeWebSearchSources({ toolCall: tc, result, sources, seenUrls, onSources: args.onSources });
      finalizeToolStep(toolStep, result, tc.name);
      publish(result);
      appendToolResultMessage({ toolCall: tc, result, messages, nativeActive, nativeFailed: run.transport.nativeFailed, maxToolResultChars: MAX_TOOL_RESULT_CHARS });
    }
    emitSteps(run);
  }
}
