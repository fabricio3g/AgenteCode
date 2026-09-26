/**
 * Home's run policy, expressed as shared agent-core loop hooks.
 *
 * - beforeToolBatch   tool budget, loop and explore guards — before tools run
 * - beforeToolCall    research write phase: no more searching
 * - prepareNextTurn   time budget, research write switch, step-limit nudges
 * - reviewFinalReply  a reply without tool calls is the answer — unless it is
 *                     missing a website, a readable tool call, a visual or a
 *                     requested file, which earns one targeted retry
 *
 * Every hook that ends the run settles it: `run.finalContent` holds the
 * answer or fallback, or `errorReason` says why there is none.
 */

import type { AgentStep } from '$lib/types/chat';
import type { AgentLoopHooks } from '$shared/agent-core/agent-loop';
import type { AssistantMessage, ToolCall, UserMessage } from '$shared/agent-core/types';
import { hasToolIntent, sanitizeAgentVisibleText, stripToolCallArtifacts } from '$lib/services/agent-parsing';
import { activityLabel } from '$lib/utils/tool-ui';
import { FINAL_ANSWER_CONTRACT_REMINDER } from '$lib/services/agent-prompts';
import { hasVisibleArtifact, visibleFileCount } from '$lib/services/agent-flow';
import { VISUAL_ARTIFACT_TOOL } from '$lib/services/agent-evidence';
import { synthesizeArtifactCompletion } from '$lib/services/agent-artifact';
import { shouldForceResearchSynthesis } from '$lib/services/research-pipeline';
import { debugLog, uid } from '$lib/services/agent-tool-dispatch';
import { createExploreGuard, createLoopGuard } from '$lib/services/agent-loop-guard';
import {
  emitSteps,
  enforceRequestedArtifacts,
  evidenceOnlyFallback,
  missingRequestedVisuals,
  pushStep,
  pushUser,
  userMessage,
  type AgentRun
} from '$lib/services/agent-run-context';

/** Per-run policy state that is not part of the result. */
export interface PolicyState {
  researchBootstrapped: boolean;
  researchForceWrite: boolean;
  /** The model talked about tools without a parseable call: remind it of the format once. */
  toolFormatRetryDone: boolean;
  /** The model answered a visual request in prose: name the exact tool once. */
  visualNudgeDone: boolean;
  /** Nudge the Code profile to act instead of exploring, before the next turn. */
  exploreNudgeDue: boolean;
  loopGuard: ReturnType<typeof createLoopGuard>;
  exploreGuard: ReturnType<typeof createExploreGuard>;
}

export function createPolicyState(run: AgentRun, researchBootstrapped: boolean, researchForceWrite: boolean): PolicyState {
  return {
    researchBootstrapped,
    researchForceWrite,
    toolFormatRetryDone: false,
    visualNudgeDone: false,
    exploreNudgeDue: false,
    loopGuard: createLoopGuard({ localMode: run.plan.localMode, isResearchChat: run.plan.isResearchChat }),
    exploreGuard: createExploreGuard()
  };
}

/** The activity row for a new turn (turn is 1-based). */
export function startThinkStep(run: AgentRun, state: PolicyState, turn: number): AgentStep {
  const { plan, args } = run;
  const first = turn === 1;
  const research = plan.isResearchChat;
  const step: AgentStep = {
    id: uid('step'),
    type: research ? (state.researchForceWrite ? 'writing' : 'thinking') : 'thinking',
    label: research
      ? state.researchForceWrite
        ? activityLabel('writing')
        : first && !state.researchBootstrapped
          ? activityLabel('searching')
          : activityLabel(null)
      : activityLabel(first ? 'planning' : null),
    status: 'running',
    detail: research
      ? (state.researchForceWrite ? 'Synthesizing research report' : (run.sources.length ? `${run.sources.length} sources` : 'Gathering sources'))
      : `Step ${turn} of ${plan.maxIterations}`
  };
  run.steps.push(step);
  emitSteps(run);
  if (first) {
    args.onProgress?.(research
      ? (state.researchForceWrite ? 'Writing research report…' : 'Searching…')
      : 'Planning how to approach this…');
  }
  return step;
}

// ── Stopping ───────────────────────────────────────────────────────────

/** The tool budget ran out. Research leaves the answer to forced synthesis. */
async function stopAtToolBudget(run: AgentRun, reason: string) {
  const { plan } = run;
  // No raw-evidence answer here: the forced final answer writes one from what
  // was gathered (settleWithoutAnswer remains the last resort).
  if (!plan.isResearchChat) {
    run.warningReason = run.warningReason || `Agent reached the tool call limit (${plan.maxToolCalls}) — ${reason}.`;
  }
  run.stopReason = 'tool_limit';
}

/** Code profile: stop endless read/list/search streaks that never write anything. */
async function exploreGuardStops(run: AgentRun, state: PolicyState, toolCalls: ToolCall[]): Promise<boolean> {
  const verdict = state.exploreGuard.observe(toolCalls);
  if (verdict === 'ok') return false;
  if (verdict === 'nudge') {
    state.exploreNudgeDue = true;
    return false;
  }
  pushStep(run, {
    type: 'error',
    label: 'Explore limit — finishing',
    status: 'error',
    detail: `Stopped after ${state.exploreGuard.streak} explore-only tool calls without file changes`
  });
  run.finalContent = await evidenceOnlyFallback(run, 'too many explore-only tool calls without applying changes');
  run.warningReason = 'Agent explored the codebase extensively without finishing changes; returned a partial summary.';
  run.stopReason = 'loop';
  run.settled = true;
  return true;
}

async function loopGuardStops(run: AgentRun, state: PolicyState, toolCalls: ToolCall[]): Promise<boolean> {
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
  if (!verdict.stuckTool) return false;
  pushStep(run, {
    type: plan.isResearchChat ? 'writing' : 'error',
    label: plan.isResearchChat ? 'Writing report' : 'Loop detected — stopping',
    status: plan.isResearchChat ? 'running' : 'error',
    detail: plan.isResearchChat ? 'Synthesizing research report from gathered sources' : `Repeated calls to ${verdict.stuckTool}`
  });
  // Leave finalContent empty either way: research gets forced report
  // synthesis, anything else a forced answer told why the loop stopped. The
  // raw-evidence fallback stays the last resort (settleWithoutAnswer) — a
  // pasted search snippet is not an answer to "what's the weather?".
  if (!plan.isResearchChat) {
    run.stuckTool = verdict.stuckTool;
    run.warningReason = `Stopped after repeated calls to ${verdict.stuckTool}.`;
  }
  run.stopReason = 'loop';
  return true;
}

function nearEndNudge(run: AgentRun, state: PolicyState): string {
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

function researchWantsWrite(run: AgentRun): boolean {
  return run.plan.isResearchChat
    && shouldForceResearchSynthesis({ mode: run.plan.researchMode, sources: run.sources, observations: run.observations });
}

// ── Final reply review ─────────────────────────────────────────────────

/** Direct mode answered in prose: enforce requested deliverables, then finish. */
async function settleDirectReply(run: AgentRun, rawContent: string) {
  run.settled = true;
  if (run.plan.wantsWebsiteArtifact && !hasVisibleArtifact(run.ctx.files)) {
    pushStep(run, {
      type: 'error', label: 'Missing website files', status: 'error',
      detail: 'The model described the website but did not provide code blocks or files.'
    });
    run.errorReason = 'The model did not produce website files.';
    return;
  }
  if (!run.plan.isInstant) {
    const finished = await enforceRequestedArtifacts(run, {
      draft: rawContent,
      reason: 'direct mode tried to finish without creating the requested files',
      includeVisuals: true
    });
    if (!finished) return;
  }
  run.finalContent = stripToolCallArtifacts(rawContent);
}

/** Retry messages for a reply that is not the answer yet; undefined when it settles the run. */
async function reviewDraft(run: AgentRun, state: PolicyState, step: AgentStep, rawContent: string): Promise<UserMessage[] | undefined> {
  const { plan, transport, args } = run;
  const settle = () => {
    run.settled = true;
    return undefined;
  };

  if (!rawContent) {
    const synthesized = synthesizeArtifactCompletion(run.ctx.files);
    if (synthesized && run.totalToolCalls > 0) {
      run.finalContent = synthesized;
      return settle();
    }
    pushStep(run, {
      type: 'error', label: 'Empty response', status: 'error',
      detail: 'The model returned an empty response. The model may be temporarily unavailable or the prompt may exceed context capacity.'
    });
    run.errorReason = 'The model returned an empty response.';
    return settle();
  }

  if (plan.wantsWebsiteArtifact && !hasVisibleArtifact(run.ctx.files)) {
    if (!transport.directMode) {
      transport.directMode = true;
      step.detail = 'Switching to direct website build mode';
      emitSteps(run);
      return [userMessage('You must actually create the website files now. Output complete code blocks for index.html and any needed style.css or script.js. Do not say the work is done unless you provide the file contents.')];
    }
    pushStep(run, {
      type: 'error', label: 'Missing website files', status: 'error',
      detail: 'The model answered without creating previewable website files.'
    });
    run.errorReason = 'The model answered without creating website files.';
    return settle();
  }

  // The model described tool use instead of emitting a call: show it the exact format once.
  if (!state.toolFormatRetryDone && !transport.directMode && run.totalToolCalls === 0 && hasToolIntent(rawContent)) {
    state.toolFormatRetryDone = true;
    debugLog(plan.debugLogs, '[agent] -> tool-format retry (draft talked about tools, retrying with exact format)');
    step.detail = 'Clarifying the tool format and retrying';
    emitSteps(run);
    return [userMessage(`The tool call could not be read. Use an available tool name and its real arguments: <tool_call>{"name":"TOOL_NAME","arguments":{}}</tool_call>. Available tools: ${plan.toolDefs.map((tool) => tool.function.name).join(', ')}. For a map, use create_map with {"place":"City, Country","zoom":12}. Do not use label or parameters attributes.`)];
  }
  // A visual deliverable answered in prose: name the exact tool once. A second miss fails visibly.
  if (!state.visualNudgeDone && !transport.directMode) {
    const missing = missingRequestedVisuals(run);
    if (missing.length) {
      state.visualNudgeDone = true;
      const toolList = missing.map((kind) => VISUAL_ARTIFACT_TOOL[kind]).join(', ');
      debugLog(plan.debugLogs, `[agent] -> visual-artifact nudge (missing: ${missing.join(', ')})`);
      step.detail = 'Requesting the missing visual artifact';
      emitSteps(run);
      return [userMessage(`You answered in prose, but the user asked for a visual deliverable. Call the matching tool now with real arguments (${toolList}) — do not describe it, create it. If no visual was actually requested, answer normally without tools.`)];
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
    return settle();
  }

  const finished = await enforceRequestedArtifacts(run, {
    draft: rawContent,
    reason: 'the model tried to finish without creating the requested files',
    includeVisuals: false
  });
  if (finished) {
    args.onProgress?.('Producing final answer…');
    run.finalContent = stripToolCallArtifacts(rawContent);
  }
  return settle();
}

// ── Hooks ──────────────────────────────────────────────────────────────

export function createHomeHooks(run: AgentRun, state: PolicyState): AgentLoopHooks {
  const { plan } = run;
  return {
    async beforeToolBatch(toolCalls: ToolCall[]) {
      if (run.settled) return { stop: true };
      if (run.totalToolCalls >= plan.maxToolCalls) {
        pushStep(run, {
          type: plan.isResearchChat ? 'writing' : 'error',
          label: plan.isResearchChat ? 'Writing report' : 'Tool limit reached',
          status: plan.isResearchChat ? 'running' : 'error',
          detail: plan.isResearchChat
            ? 'Synthesizing final research report from gathered sources'
            : `Used ${run.totalToolCalls} tools across ${plan.maxIterations} steps. Returning gathered evidence only.`
        });
        await stopAtToolBudget(run, 'the tool budget was reached');
        return { stop: true };
      }
      if (researchWantsWrite(run)) state.researchForceWrite = true;
      if (plan.isCodeProfile && await exploreGuardStops(run, state, toolCalls)) return { stop: true };
      if (await loopGuardStops(run, state, toolCalls)) return { stop: true };
      // Research write phase: a batch of nothing but searches ends the gathering.
      if (plan.isResearchChat && state.researchForceWrite && toolCalls.every((call) => call.name === 'web_search')) {
        return { stop: true };
      }
    },

    async beforeToolCall(_id: string, toolName: string) {
      if (plan.isResearchChat && state.researchForceWrite && toolName === 'web_search') {
        return { block: 'Enough sources have been gathered. Write the report from the evidence pack instead of searching again.' };
      }
    },

    async prepareNextTurn(turn: number) {
      if (run.settled) return { stop: true };
      if (researchWantsWrite(run)) state.researchForceWrite = true;
      if (run.transport.directMode && hasVisibleArtifact(run.ctx.files)) {
        run.finalContent = synthesizeArtifactCompletion(run.ctx.files) || 'Website files created and preview is ready.';
        run.settled = true;
        return { stop: true };
      }
      if (run.totalToolCalls >= plan.maxToolCalls) {
        await stopAtToolBudget(run, 'the available tool budget was reached');
        return { stop: true };
      }
      if (turn >= plan.maxIterations) return { stop: true };
      if (Date.now() - run.startTime > plan.maxTimeMs) {
        run.stopReason = 'timeout';
        // Research delivers the report from its sources rather than hard-failing.
        if (!(plan.isResearchChat && run.sources.length)) {
          run.errorReason = run.errorReason || 'Agent timed out before completing the requested depth.';
        }
        return { stop: true };
      }
      if (state.exploreNudgeDue) {
        state.exploreNudgeDue = false;
        pushUser(run, 'You have explored enough. Stop calling read/list/search tools. Either make the code change now with edit_file/write_file, or finish with a clear summary of findings. No more exploratory tool calls.');
      }
      // The next turn is the last one.
      if (state.researchForceWrite || turn >= plan.maxIterations - 1) pushUser(run, nearEndNudge(run, state));
    },

    async reviewFinalReply(message: AssistantMessage) {
      if (run.settled) return;
      const step = run.currentStep!;
      if (run.transport.directMode) {
        await settleDirectReply(run, message.content);
        return;
      }
      const retry = await reviewDraft(run, state, step, message.content);
      return retry ? { retry } : undefined;
    }
  };
}
