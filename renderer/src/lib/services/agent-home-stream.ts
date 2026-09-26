/**
 * Home's StreamFn for the shared agent-core loop: everything about talking to
 * the model lives here, so the loop only ever sees core AssistantMessages.
 *
 * Per call: build the provider request from history + transcript, keep it
 * inside budget, inject evidence, run the transport ladder (native → XML →
 * direct), recover empty replies within the turn, and turn the reply —
 * whatever dialect it came in — into core tool calls.
 */

import type { AgentStep } from '$lib/types/chat';
import type { AssistantMessage, StreamFn, ToolCall as CoreToolCall } from '$shared/agent-core/types';
import type { ToolCall } from '$lib/services/agent-types';
import { isElectron, invoke } from '$lib/services/bridge';
import { sanitizeAgentVisibleText } from '$lib/services/agent-parsing';
import { synthesizeArtifactCompletion } from '$lib/services/agent-artifact';
import { trimContext, ensureToolCallPairs } from '$lib/services/agent-message-context';
import { enforceTokenBudget } from '$lib/services/agent-token-budget';
import { displayToolLabel } from '$lib/services/agent-tool-result';
import { debugLog, uid } from '$lib/services/agent-tool-dispatch';
import { callModel } from '$lib/services/agent-model-call';
import { extractToolCalls, normalizeMapCalls, websiteWritesFromCodeblocks } from '$lib/services/agent-tool-calls';
import {
  buildWireMessages,
  emitSteps,
  injectLiveEvidence,
  mergeCompletionUsage,
  nativeActive as isNativeActive,
  pushStep,
  useSystemPrompt,
  type AgentRun
} from '$lib/services/agent-run-context';

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

function closeThinkStep(run: AgentRun, step: AgentStep, toolCalls: ToolCall[], cleanContent: string) {
  const research = run.plan.isResearchChat;
  const labels = toolCalls.map((toolCall) => displayToolLabel(toolCall.name)).join(', ');
  step.status = 'done';
  step.detail = toolCalls.length
    ? (research ? labels : `Next: ${labels}`)
    : (research ? 'Writing report' : 'Preparing the answer');
  // The first turn's text before its tool calls is the agent talking to the
  // user ("Let me check…"): keep it as the bubble's opening line.
  if (toolCalls.length && cleanContent.trim() && run.turn === 1 && !research && !run.steps.some((s) => s.preface)) {
    run.steps.unshift({ id: uid('step'), type: 'done', label: 'Preface', status: 'done', preface: true, detail: cleanContent.trim().slice(0, 600) });
  } else if (toolCalls.length && cleanContent && cleanContent.length > 10 && !run.transport.directMode) {
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
 * An empty reply: finish from files the run already built, or step down the
 * transport ladder and ask again. Returns false when the run has to end.
 */
function recoverEmptyReply(run: AgentRun, step: AgentStep, nativeActive: boolean, consecutiveEmpty: number): boolean {
  const { transport } = run;
  const synthesized = synthesizeArtifactCompletion(run.ctx.files);
  if (synthesized && run.totalToolCalls > 0) {
    run.finalContent = synthesized;
    run.settled = true;
    return false;
  }
  // A second empty reply in a row: tools are not working for this model.
  if (consecutiveEmpty >= 2) {
    transport.directMode = true;
    step.detail = 'Switching to direct mode (tools unavailable)';
    emitSteps(run);
    return true;
  }
  if (!transport.nativeFailed && nativeActive) {
    transport.nativeFailed = true;
    step.detail = 'Falling back to XML mode';
    emitSteps(run);
    return true;
  }
  console.error('[agent] HARD FAIL: Empty response - model may not support tool calling');
  pushStep(run, {
    type: 'error', label: 'Empty response', status: 'error',
    detail: 'The model returned an empty response. The model may not support tool calling.'
  });
  run.errorReason = 'The model returned an empty response.';
  run.settled = true;
  return false;
}

function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
  return { role: 'assistant', content: '', ts: Date.now(), ...fields };
}

/** Core tool calls need ids; text dialects do not always carry one. */
function withIds(toolCalls: ToolCall[], turn: number): CoreToolCall[] {
  return toolCalls.map((call, index) => ({
    id: call.id || `text-${turn}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    name: call.name,
    arguments: call.arguments
  }));
}

export function createHomeStreamFn(run: AgentRun): StreamFn {
  return async (request) => {
    const { plan, transport, args } = run;
    const step = run.currentStep!;
    step.status = 'running';

    for (let attempt = 1; ; attempt++) {
      run.messages = buildWireMessages(run);
      await prepareContext(run);
      const nativeActive = isNativeActive(run);
      useSystemPrompt(run, transport.directMode ? 'direct' : nativeActive ? 'native' : 'xml');
      debugLog(plan.debugLogs, `[agent] turn=${run.turn} via ${transport.directMode ? 'direct' : nativeActive ? 'native' : 'xml'} | messages=${run.messages.length}`);

      const reasoningBefore = run.finalReasoning;
      const outcome = await callModel(run, { iter: run.turn - 1, step, nativeActive, callbacks: request.callbacks });
      if ('error' in outcome) return assistant({ stopReason: 'error', errorMessage: outcome.error });
      const { completion } = outcome;

      run.usage = mergeCompletionUsage(run.usage, completion.usage);
      // Parse the protocol before sanitizing display text: sanitizing first erased
      // XML calls (including llama.cpp fallbacks) before any executor saw them.
      const rawContent = String(completion.content || '');
      const reasoning = sanitizeAgentVisibleText(String(completion.reasoning || ''));
      run.maxDraftChars = Math.max(run.maxDraftChars, rawContent.length);
      if (reasoning) {
        run.finalReasoning = [reasoningBefore, reasoning].filter(Boolean).join('\n\n');
        args.onReasoning?.(run.finalReasoning);
      }

      if (!rawContent && !completion.toolCalls?.length && !transport.directMode) {
        if (recoverEmptyReply(run, step, nativeActive, attempt)) continue;
        return assistant({ content: run.finalContent, stopReason: 'stop' });
      }

      // ── The reply as tool calls ──
      let toolCalls: ToolCall[] = [];
      let cleanContent = rawContent;
      let historyContent = rawContent;
      if (transport.directMode) {
        const site = plan.wantsWebsiteArtifact ? websiteWritesFromCodeblocks(rawContent) : null;
        if (site) {
          toolCalls = site.toolCalls;
          cleanContent = site.cleanContent;
          historyContent = cleanContent || 'Files generated.';
        }
      } else {
        const extracted = extractToolCalls({
          rawContent,
          completion,
          iter: run.turn - 1,
          nativeInUse: nativeActive && !transport.nativeFailed,
          wantsWebsiteArtifact: plan.wantsWebsiteArtifact
        });
        toolCalls = extracted.toolCalls;
        cleanContent = extracted.cleanContent;
        if (extracted.textDialect) {
          historyContent = String(extracted.assistantMessage?.content || '');
          if (nativeActive) transport.nativeFailed = true;
        }
      }
      const native = nativeActive && !transport.nativeFailed && !!completion.toolCalls?.length;
      const calls = withIds(normalizeMapCalls(toolCalls, nativeActive && !transport.nativeFailed), run.turn);
      if (native) for (const call of calls) run.nativeCallIds.add(call.id);
      closeThinkStep(run, step, calls, sanitizeAgentVisibleText(cleanContent));

      return assistant({
        content: calls.length ? historyContent : rawContent,
        reasoning: completion.reasoning || undefined,
        ...(native && completion.reasoning ? { reasoning_content: completion.reasoning } : {}),
        ...(completion.providerState ? { providerState: completion.providerState } : {}),
        toolCalls: calls.length ? calls : undefined,
        stopReason: calls.length ? 'toolUse' : 'stop'
      });
    }
  };
}
