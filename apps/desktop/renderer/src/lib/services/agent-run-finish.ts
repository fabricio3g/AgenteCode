/**
 * How a Home agent run ends once the loop has stopped.
 *
 * 1. `forceFinalAnswer` — no answer yet: ask the model, tools off, to answer
 *    from what it gathered (a few attempts; research gets a report nudge).
 * 2. `settleWithoutAnswer` — still nothing: the strict evidence fallback.
 * 3. `buildAgentResult` — publish a forgotten website, classify the outcome
 *    (completed / partial / stopped / failed) and assemble the result.
 */

import type { AgentOutcome } from '$lib/types/chat';
import type { AgentTaskResult } from '$lib/services/agent-types';
import { completeAssistantReply } from '$lib/services/chat-api';
import { sanitizeAgentVisibleText, isPublicFallbackContent, stripToolCallArtifacts } from '$lib/services/agent-parsing';
import { FINAL_ANSWER_CONTRACT_REMINDER, isMedicalResearchQuery } from '$lib/services/agent-prompts';
import { classifyStopReason, stoppedWarning, finalizeAgentSteps } from '$lib/services/agent-flow';
import { evidenceSources } from '$lib/services/agent-evidence';
import { ensureToolCallPairs } from '$lib/services/agent-message-context';
import { researchSynthesisUserNudge, researchThinSourcesNotice } from '$lib/services/research-pipeline';
import { toErrorMessage, isAbortError } from '$lib/utils/errors';
import { debugLog } from '$lib/services/agent-tool-dispatch';
import {
  codeObservationSummary,
  evidenceOnlyFallback,
  hasGatheredEvidence,
  injectLiveEvidence,
  mergeCompletionUsage,
  prompt,
  publishToolArtifact,
  useSystemPrompt,
  type AgentRun
} from '$lib/services/agent-run-context';

const MAX_FORCED_FINAL_ANSWER_ATTEMPTS = 2;
/** Deep/max research gets extra synthesis retries after the tool budget ends. */
const MAX_RESEARCH_FORCED_SYNTHESIS_ATTEMPTS = 3;

function forcedNudge(run: AgentRun, attempt: number, attempts: number): string {
  const { plan } = run;
  if (attempt === 1) {
    if (plan.isResearchChat) {
      const medical = isMedicalResearchQuery(prompt(run));
      return [researchSynthesisUserNudge(plan.researchMode, medical, attempt, attempts), FINAL_ANSWER_CONTRACT_REMINDER].join('\n\n');
    }
    if (plan.isCodeProfile) {
      return [
        'You have reached the coding step limit. Do NOT call tools.',
        'Write a concise plain-text summary of: (1) what you changed or found, (2) file paths touched, (3) how to verify, (4) what remains unfinished.',
        codeObservationSummary(run)
      ].join('\n\n');
    }
    // Say why the run stopped: a failed request is not a step limit, and the
    // model will repeat whatever reason it is given to the user.
    if (run.stuckTool) {
      const lastFailure = [...run.observations].reverse().find((o) => o.name === run.stuckTool && !o.success);
      return [
        `Stop: ${run.stuckTool} was called repeatedly${lastFailure ? ` and kept failing (${lastFailure.summary.slice(0, 200)})` : ''}. Do NOT call tools.`,
        'Answer the user now from what you already know and what was gathered. Say plainly, in one sentence, what could not be done and that they can try again. Do not paste raw search results.'
      ].join(' ');
    }
    if (run.requestFailed) {
      return `The model request failed before the task was finished (${run.errorReason}). Do NOT call tools. Tell the user plainly what was completed and what was not, and that they can send the request again. Do not describe this as a step or time limit.`;
    }
    return 'You have reached the step limit. Do NOT call tools. Using only gathered evidence, provide the best possible final answer now. If something is uncertain, state it explicitly.';
  }
  if (plan.isCodeProfile) return 'Final attempt: no tools. Summarize file changes and next steps in plain text only.';
  if (plan.isResearchChat) {
    // The previous attempt produced nothing usable: restate only the shape, at
    // the depth the user asked for. Search mode gets an answer, not a report.
    return [
      plan.researchMode === 'search'
        ? 'The previous answer was empty or unusable. Answer the question directly in markdown now, at whatever length it needs, citing the sources you used.'
        : 'The previous synthesis was empty or unusable. Write the complete professional research report in markdown now — spaced topical sections, then Limitations and References.',
      FINAL_ANSWER_CONTRACT_REMINDER
    ].join('\n\n');
  }
  return 'Final attempt: no tools, no extra reasoning. Return the final answer now in plain text using only gathered evidence.';
}

/** Research output that is only an evidence dump, never a real topical report. */
function isEvidenceDump(content: string): boolean {
  return /#{0,6}\s*Gathered Evidence\b/i.test(content) && !/^#\s+(?!Gathered Evidence\b).+/im.test(content);
}

export async function forceFinalAnswer(run: AgentRun): Promise<void> {
  if (run.finalContent) return;
  const { plan, args, messages } = run;
  // Instant gets one shot: the strict fallback already answers honestly from
  // evidence, and every extra call costs the immediacy Instant exists for.
  const attempts = plan.isInstant ? 1 : plan.isResearchChat ? MAX_RESEARCH_FORCED_SYNTHESIS_ATTEMPTS : MAX_FORCED_FINAL_ANSWER_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      injectLiveEvidence(run);
      useSystemPrompt(run, 'direct');
      messages.push({ role: 'user', content: forcedNudge(run, attempt, attempts) });
      args.onProgress?.(plan.isResearchChat ? `Writing research report (attempt ${attempt}/${attempts})…` : 'Producing final answer…');
      // Mandatory: every early loop break leaves the last assistant `tool_calls`
      // unanswered, and providers reject that history with a 400.
      ensureToolCallPairs(messages, 'fill');
      const forced = await completeAssistantReply({ messages, signal: args.signal, omitMaxTokens: plan.omitMaxTokens });
      run.usage = mergeCompletionUsage(run.usage, forced.usage);
      const content = stripToolCallArtifacts(String(forced?.content || '')).trim();
      if (!content) continue;
      if (plan.isResearchChat && isEvidenceDump(content)) continue;
      run.finalContent = content;
      if (forced.reasoning) run.finalReasoning = run.finalReasoning || String(forced.reasoning);
      if (plan.isResearchChat) {
        run.stopReason = 'none';
        run.warningReason = undefined;
      } else if (run.requestFailed) {
        // The loop ended on a failed model request, not on its step budget.
        run.warningReason = run.errorReason || 'The model request failed before the task was finished.';
      } else {
        if (run.stopReason === 'none') run.stopReason = 'iteration_limit';
        run.warningReason = run.warningReason || (plan.isCodeProfile
          ? 'Agent reached the step limit and returned a partial coding summary.'
          : 'Agent reached the iteration limit and produced a final answer from gathered evidence.');
      }
      return;
    } catch (err: unknown) {
      // Abort is the user's decision, not a failed attempt.
      if (isAbortError(err)) throw err;
      debugLog(plan.debugLogs, `[agent] forced synthesis attempt ${attempt}/${attempts} failed: ${toErrorMessage(err)}`);
    }
  }
}

export async function settleWithoutAnswer(run: AgentRun): Promise<void> {
  if (run.finalContent) return;
  const { plan, sources } = run;
  const reason = run.stopReason !== 'none' && run.errorReason
    ? run.errorReason
    : 'it reached the iteration limit before producing a final answer';
  const richCount = sources.filter((s) => String(s.full_content || s.snippet || '').length >= 120).length;
  // Research: product-facing report without "step limit" language.
  run.finalContent = await evidenceOnlyFallback(run, reason, plan.isResearchChat
    ? { notice: researchThinSourcesNotice(sources.length, richCount) }
    : {});
  if (run.stopReason === 'none') run.stopReason = 'iteration_limit';
  if (plan.isResearchChat && hasGatheredEvidence(run, sources, run.finalContent)) {
    // A sourced research report is a completed deliverable.
    run.warningReason = undefined;
    run.errorReason = undefined;
    run.stopReason = 'none';
  } else if (!plan.isResearchChat) {
    // A loop or tool-budget stop already carries its warning: the evidence
    // answer is partial, not a failure.
    if (!run.stuckTool && run.stopReason !== 'tool_limit') {
      run.errorReason = run.errorReason || 'Agent reached iteration limit without producing a final answer.';
    }
  } else {
    run.errorReason = undefined;
    run.warningReason = researchThinSourcesNotice(sources.length, richCount);
    run.stopReason = sources.length ? 'none' : run.stopReason;
  }
}

/**
 * Safety net for website builds: preview_project publishes the artifact, but a
 * native-tool model can write index.html and never call it — then the site
 * would vanish with the run.
 */
function publishForgottenWebsite(run: AgentRun) {
  const { plan, ctx, artifacts } = run;
  if (!plan.artifactsEnabled || !plan.wantsWebsiteArtifact || artifacts.some((entry) => entry.manifest?.kind === 'web')) return;
  const entryPath = ctx.files['index.html'] !== undefined
    ? 'index.html'
    : Object.keys(ctx.files).find((path) => !path.startsWith('__') && /\.html?$/i.test(path));
  if (!entryPath) return;
  publishToolArtifact(run, {
    success: true,
    createdFiles: Object.keys(ctx.files).filter((path) => !path.startsWith('__')),
    artifactManifest: { schemaVersion: 1, kind: 'web', presentation: 'web', entryPath, status: 'ready' }
  });
}

export async function buildAgentResult(run: AgentRun): Promise<AgentTaskResult> {
  const { plan, steps, artifacts } = run;
  publishForgottenWebsite(run);

  const content = sanitizeAgentVisibleText(run.finalContent);
  const reasoning = sanitizeAgentVisibleText(run.finalReasoning);
  const sources = evidenceSources(run.observations, run.sources);

  // Research product rule: sources + body → completed report (never step-limit Error UI).
  if (plan.isResearchChat && content.trim() && sources.length > 0) {
    run.stopReason = 'none';
    run.warningReason = undefined;
    run.errorReason = undefined;
  }
  const { errorReason, warningReason } = run;

  const publicFallback = isPublicFallbackContent(content);
  // Generic fallback text is not evidence: a run that gathered nothing and has
  // only that to show failed, even though it has something to display.
   // An explanation of a failed request is not a delivered result.
   const useful = hasGatheredEvidence(run, sources, publicFallback || run.requestFailed ? '' : content);
  const stopReason = run.stopReason !== 'none' ? run.stopReason : classifyStopReason(errorReason || warningReason);
  const outcome: AgentOutcome = errorReason ? (useful ? 'stopped' : 'failed') : warningReason ? 'partial' : 'completed';
  const fatal = outcome === 'failed';
  const rawWarning = !fatal && (
    warningReason
    || (stopReason !== 'none'
      ? stoppedWarning(stopReason, errorReason || '', {
        workspace: plan.executionMode === 'workspace' || plan.isCodeProfile,
        research: plan.isResearchChat
      })
      : undefined)
  );
  const warning = rawWarning ? String(rawWarning).trim() || undefined : undefined;

  finalizeAgentSteps(steps, fatal && !plan.isResearchChat);

  try {
    const { browserPanelStore } = await import('$lib/stores/browser-panel.svelte');
    browserPanelStore.agentDriving = false;
  } catch { /* store unavailable in tests */ }

  console.log(`[agent] EXIT | contentLen=${content.length} | steps=${steps.length} | outcome=${outcome} | stopReason=${stopReason} | error=${fatal ? (errorReason || 'unknown') : 'none'} | notice=${warning && !fatal ? warning : 'none'}`);
  return {
    content,
    reasoning,
    steps,
    artifact: artifacts.length ? artifacts[artifacts.length - 1] : null,
    artifacts,
    sources,
    outcome,
    stopReason,
    publicFallback,
    diagnosticsRedacted: publicFallback,
    ...(run.usage ? { usage: run.usage } : {}),
    ...(fatal && errorReason ? { error: errorReason } : {}),
    ...(warning ? { warning } : {})
  };
}
