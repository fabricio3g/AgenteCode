/**
 * One model call for the Home agent loop, with the transport fallback ladder:
 *
 *   native tools ──(no result / tool rejection)──▶ XML tool contract
 *   any mode ──(unpaired tool_calls error)──▶ repair pairs, retry, then strip
 *   early turns ──(content error)──▶ direct mode (no tools)
 *
 * Streams reasoning and visible text to the caller as they arrive. A failure
 * no rung can recover marks the turn's step as errored and comes back as
 * `{ error }` (the raw message, so the core can tell a transient failure from
 * a fatal one and retry it).
 */

import type { AgentStep } from '$lib/types/chat';
import type { StreamCallbacks } from '$shared/agent-core/types';
import type { CompletionResult, RequestMessage } from '$lib/services/chat-api';
import { completeAssistantReply, setToolSupportCache } from '$lib/services/chat-api';
import { agentStreamComplete } from '$lib/services/agent-llm';
import { isElectron } from '$lib/services/bridge';
import { sanitizeAgentVisibleText } from '$lib/services/agent-parsing';
import { ensureToolCallPairs } from '$lib/services/agent-message-context';
import { toErrorMessage, isAbortError, humanizeAgentError } from '$lib/utils/errors';
import { debugLog } from '$lib/services/agent-tool-dispatch';
import { checkAbort, emitSteps, useSystemPrompt, type AgentRun } from '$lib/services/agent-run-context';

export type ModelCallOutcome = { completion: CompletionResult } | { error: string };

export async function callModel(
  run: AgentRun,
  turn: { iter: number; step: AgentStep; nativeActive: boolean; callbacks?: StreamCallbacks }
): Promise<ModelCallOutcome> {
  const { args, plan, messages, transport, config } = run;
  const { step, nativeActive, iter } = turn;
  const reasoningBeforeTurn = run.finalReasoning;
  let streamedReasoning = '';
  let streamedContent = '';
  // Captured so the fallback can report *why* native tools failed.
  let nativeStreamError = '';
  args.onContent?.('');

  const runStream = (msgs: RequestMessage[], tools?: typeof plan.toolDefs) => {
    streamedReasoning = '';
    streamedContent = '';
    return agentStreamComplete({
      messages: msgs,
      tools,
      signal: args.signal,
      config,
      reasoningLevel: args.reasoningLevel,
      omitMaxTokens: plan.omitMaxTokens,
      onError: (message) => { nativeStreamError = message; },
      onReasoning: (text) => {
        streamedReasoning += text;
        turn.callbacks?.onThinkingDelta?.(text);
        run.finalReasoning = [reasoningBeforeTurn, sanitizeAgentVisibleText(streamedReasoning)].filter(Boolean).join('\n\n');
        args.onReasoning?.(run.finalReasoning);
      },
      onContent: (text) => {
        streamedContent += text;
        turn.callbacks?.onTextDelta?.(text);
        const visible = sanitizeAgentVisibleText(streamedContent);
        args.onContent?.(visible);
        const preview = visible.slice(0, 120).trim();
        if (preview) {
          step.detail = preview.length < visible.length ? `${preview}…` : preview;
          emitSteps(run);
        }
      }
    });
  };
  const runComplete = async (msgs: RequestMessage[]): Promise<CompletionResult> => {
    ensureToolCallPairs(msgs, 'fill');
    if (isElectron()) {
      const result = await runStream(msgs);
      if (!result) throw new Error(nativeStreamError || 'The model did not return a response.');
      return result;
    }
    return completeAssistantReply({
      messages: msgs,
      signal: args.signal,
      reasoningLevel: args.reasoningLevel,
      omitMaxTokens: plan.omitMaxTokens
    });
  };
  /** Last rung: show the failure on the turn's step. */
  const fail = (err: unknown): ModelCallOutcome => {
    step.status = 'error';
    step.label = 'Error';
    step.detail = humanizeAgentError(err);
    emitSteps(run);
    return { error: toErrorMessage(err) || 'The model request failed.' };
  };
  const complete = async (): Promise<ModelCallOutcome> => {
    const completion = await runComplete(messages);
    checkAbort(run);
    return { completion };
  };
  /** Try once more; an abort always propagates, anything else fails the turn. */
  const lastTry = async (): Promise<ModelCallOutcome> => {
    try {
      return await complete();
    } catch (err) {
      if (isAbortError(err)) throw err;
      return fail(err);
    }
  };

  try {
    if (transport.directMode) {
      useSystemPrompt(run, 'direct');
      return await complete();
    }
    if (nativeActive) {
      const streamResult = await runStream(messages, plan.toolDefs);
      checkAbort(run);
      // null (and a missing result) mean the native stream produced nothing usable.
      if (streamResult) return { completion: streamResult };
      transport.nativeFailed = true;
      debugLog(plan.debugLogs, `[agent] native stream returned no result | reason="${nativeStreamError.slice(0, 200) || 'unreported'}"`);
      // Only poison the cache on a known tool rejection: null also covers clone,
      // network and missing base_url errors, and bare 400s cover auth failures
      // and context overflows, which say nothing about tool support.
      if (/tool/i.test(nativeStreamError) && /unsupport|not support|400|422|requires.*jinja/i.test(nativeStreamError)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setToolSupportCache(config as any, false);
      }
      useSystemPrompt(run, 'xml');
      return await complete();
    }
    return await complete();
  } catch (err: unknown) {
    if (isAbortError(err)) throw err;
    const errMsg = toErrorMessage(err);
    debugLog(plan.debugLogs, `[agent] LLM ERROR | msg="${errMsg.slice(0, 200)}" | nativeActive=${nativeActive} | iter=${iter}`);

    if (/tool_calls|tool_call_id|insufficient tool messages/i.test(errMsg)) {
      // Repair unpaired tool_calls and retry once; then strip them and continue as plain chat.
      ensureToolCallPairs(messages, 'fill');
      try {
        useSystemPrompt(run, nativeActive ? 'native' : 'xml');
        return await complete();
      } catch (repairErr: unknown) {
        if (isAbortError(repairErr)) throw repairErr;
        ensureToolCallPairs(messages, 'strip');
        return lastTry();
      }
    }

    if (nativeActive && /tool|400|422|unsupported/i.test(errMsg)) {
      debugLog(plan.debugLogs, '[agent] -> falling back to XML (tool/400/422/unsupported error)');
      transport.nativeFailed = true;
      // Only poison the cache when the error names tools — a bare 400 also covers
      // context overflows and malformed params.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (/tool/i.test(errMsg)) setToolSupportCache(config as any, false);
      ensureToolCallPairs(messages, 'fill');
      useSystemPrompt(run, 'xml');
      return lastTry();
    }

    if (iter < 2 && errMsg.includes('content')) {
      debugLog(plan.debugLogs, '[agent] -> switching to direct mode (content error, iter < 2)');
      transport.directMode = true;
      useSystemPrompt(run, 'direct');
      return lastTry();
    }

    console.error('[agent] model call failed', errMsg);
    return fail(err);
  }
}
