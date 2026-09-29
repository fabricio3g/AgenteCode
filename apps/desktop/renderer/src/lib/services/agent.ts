/**
 * The Home agent run (runAgentTask), on the shared agent-core loop.
 *
 * Home and the Code agent run the same loop (`$shared/agent-core`); what
 * makes this one Home is what it plugs in:
 *
 * - agent-run-plan            profile, budgets, tools and system prompts
 * - agent-run-context         run state and shared helpers (evidence, fallbacks)
 * - agent-research-bootstrap  the system-owned first search for research runs
 * - agent-home-stream         the StreamFn: transport ladder and reply parsing
 * - agent-home-tools          Home tools as core tools (steps, sources, artifacts)
 * - agent-home-policy         budgets, guards, nudges and final-reply review as hooks
 * - agent-run-finish          forced final answer, fallback and the result
 */

import type { AgentEvent } from '$shared/agent-core/types';
import { runAgentLoop } from '$shared/agent-core/agent-loop';
import type { AgentTaskResult, RunAgentTaskArgs } from '$lib/services/agent-types';
import { loadAppConfig } from '$lib/utils/storage';
import { isElectron } from '$lib/services/bridge';
import { humanizeAgentError } from '$lib/utils/errors';
import { hasEnoughResearchEvidence } from '$lib/services/research-pipeline';
import { debugLog } from '$lib/services/agent-tool-dispatch';
import { resolveAgentRunPlan } from '$lib/services/agent-run-plan';
import { buildWireMessages, createAgentRun, emitSteps, type AgentRun } from '$lib/services/agent-run-context';
import { runResearchBootstrap } from '$lib/services/agent-research-bootstrap';
import { createHomeStreamFn } from '$lib/services/agent-home-stream';
import { createHomeTools } from '$lib/services/agent-home-tools';
import { createHomeHooks, createPolicyState, startThinkStep, type PolicyState } from '$lib/services/agent-home-policy';
import { runPreface } from '$lib/services/agent-preface';
import { buildAgentResult, forceFinalAnswer, settleWithoutAnswer } from '$lib/services/agent-run-finish';

export { INSTANT_TOOL_NAMES } from '$lib/services/agent-run-plan';

const TURN_LIMIT_NOTICE = /^Reached the turn limit \(\d+\)/;

function throwIfAborted(run: AgentRun) {
  if (run.args.signal?.aborted) throw new DOMException('Agent task cancelled by user', 'AbortError');
}

/** The loop's events drive the per-turn activity row. */
function onLoopEvent(run: AgentRun, state: PolicyState, event: AgentEvent) {
  if (event.type === 'turn_start') {
    run.turn = event.turnIndex;
    run.currentStep = startThinkStep(run, state, event.turnIndex);
  } else if (event.type === 'llm_retry' && run.currentStep) {
    run.currentStep.status = 'running';
    run.currentStep.label = 'Retrying';
    run.currentStep.detail = `Temporary provider error — retrying (attempt ${event.attempt + 1})`;
    emitSteps(run);
  }
}

export async function runAgentTask(args: RunAgentTaskArgs): Promise<AgentTaskResult> {
  const config = await loadAppConfig();
  const plan = resolveAgentRunPlan(args, config, { isElectron: isElectron() });
  const run = createAgentRun(args, config, plan);
  debugLog(plan.debugLogs, `[agent] START | profile=${plan.agentProfile} | backend=${plan.backendMode} | provider=${plan.localMode ? 'local' : plan.providerName} | model=${plan.activeModel} | useNativeTools=${plan.nativeTools} | maxIterations=${plan.maxIterations} | maxToolCalls=${plan.maxToolCalls} | maxTimeMs=${plan.maxTimeMs}`);

  // Say what it is about to do before any planning starts.
  await runPreface(run);
  throwIfAborted(run);
  const bootstrapped = await runResearchBootstrap(run);
  const state = createPolicyState(
    run,
    bootstrapped,
    plan.isResearchChat && bootstrapped && hasEnoughResearchEvidence(plan.researchMode, run.sources)
  );
  const { tools, enabled } = createHomeTools(run);

  const loop = await runAgentLoop({
    messages: run.transcript,
    config: { maxTurns: plan.maxIterations },
    tools,
    enabledTools: enabled,
    streamFn: createHomeStreamFn(run),
    // The StreamFn picks the native / XML / direct prompt itself.
    systemPrompt: plan.prompts.native,
    emit: (event) => onLoopEvent(run, state, event),
    signal: args.signal ?? new AbortController().signal,
    hooks: createHomeHooks(run, state),
    drainSteered: () => [],
    drainFollowUps: () => []
  });
  throwIfAborted(run);

  // The core's own turn-limit notice is not an answer; forced synthesis writes one.
  const last = run.transcript[run.transcript.length - 1];
  if (last?.role === 'assistant' && TURN_LIMIT_NOTICE.test(last.content)) run.transcript.pop();

  if (loop.stopReason === 'error' && !run.settled) {
    const failed = [...run.transcript].reverse().find((message) => message.role === 'assistant' && message.stopReason === 'error');
    run.errorReason = humanizeAgentError(failed?.role === 'assistant' ? failed.errorMessage : 'The model request failed.');
    run.requestFailed = true;
  }

  run.messages = buildWireMessages(run);
  await forceFinalAnswer(run);
  await settleWithoutAnswer(run);
  return buildAgentResult(run);
}
