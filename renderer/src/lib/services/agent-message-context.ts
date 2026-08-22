import type { RequestMessage } from '$lib/services/chat-api';
import type { SearchResult } from '$lib/types/bridge';
import type { ToolObservation } from '$lib/services/agent-types';

export function injectEvidenceSummary(
  messages: RequestMessage[],
  observations: ToolObservation[],
  liveSources: SearchResult[],
  compactText: (value: unknown, max?: number) => string,
  options: {
    observationLimit?: number;
    observationChars?: number;
    sourceLimit?: number;
    sourceChars?: number;
    instruction?: string;
  } = {}
): void {
  const evidenceIdx = messages.findIndex(
    (message) => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('=== EVIDENCE SUMMARY ===')
  );
  if (evidenceIdx >= 0) {
    messages.splice(evidenceIdx, 1);
  }

  const successful = observations.filter((observation) => observation.success && observation.summary);
  if (!successful.length && !liveSources.length) return;

  const observationLimit = Math.max(1, options.observationLimit ?? 15);
  const observationChars = Math.max(120, options.observationChars ?? 400);
  const sourceLimit = Math.max(1, options.sourceLimit ?? 10);
  const sourceChars = Math.max(120, options.sourceChars ?? 250);
  const lines: string[] = ['=== EVIDENCE SUMMARY ==='];
  lines.push(options.instruction || 'The following facts have been gathered from tool results. Use ONLY this data when creating artifacts or answering:');

  for (const observation of successful.slice(0, observationLimit)) {
    lines.push(`- [${observation.name}] ${compactText(observation.summary, observationChars)}`);
  }

  for (const source of liveSources.slice(0, sourceLimit)) {
    const title = source.title || source.url;
    const url = source.url && source.title ? ` (${source.url})` : '';
    const excerpt = source.full_content || source.snippet || '';
    lines.push(`- [source] ${title}${url}: ${compactText(excerpt, sourceChars)}`);
  }

  lines.push('=== END EVIDENCE ===');
  messages.push({ role: 'system', content: lines.join('\n') });
}

export type TrimContextOptions = {
  /**
   * Number of non-system messages that came from the chat transcript
   * (fixed history). These are never dropped by structural trim.
   */
  historyCount: number;
  /**
   * Max non-system messages allowed after history (tool-loop growth).
   * Oldest loop messages are dropped first.
   */
  maxLoopMessages?: number;
};

const DEFAULT_MAX_LOOP_MESSAGES = 16;

/**
 * Ensure every assistant tool_calls block is followed by tool results for each id.
 * Prevents OpenAI 400: "assistant message with tool_calls must be followed by tool messages".
 * Mode 'fill' injects synthetic tool errors for missing ids; 'strip' removes incomplete tool_calls.
 */
export function ensureToolCallPairs(
  messages: RequestMessage[],
  mode: 'fill' | 'strip' = 'fill'
): void {
  const out: RequestMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (msg.role !== 'assistant' || !toolCalls.length) {
      // Drop orphan tool messages with no preceding assistant tool_calls in output
      if (msg.role === 'tool') {
        // Look back for parent assistant with matching tool_call id
        let j = out.length - 1;
        while (j >= 0 && out[j].role === 'tool') j -= 1;
        const parent = j >= 0 ? out[j] : null;
        const parentIds = new Set(
          parent?.role === 'assistant' && Array.isArray(parent.tool_calls)
            ? parent.tool_calls.map((c) => c.id)
            : []
        );
        if (msg.tool_call_id && parentIds.has(msg.tool_call_id)) {
          out.push(msg);
        }
        // else drop orphan tool message
        i += 1;
        continue;
      }
      out.push(msg);
      i += 1;
      continue;
    }

    // Collect following tool messages until non-tool
    const following: RequestMessage[] = [];
    let k = i + 1;
    while (k < messages.length && messages[k].role === 'tool') {
      following.push(messages[k]);
      k += 1;
    }
    const present = new Set(following.map((m) => m.tool_call_id).filter(Boolean) as string[]);
    const missing = toolCalls.filter((tc) => tc.id && !present.has(tc.id));

    if (missing.length && mode === 'strip') {
      const { tool_calls: _drop, ...rest } = msg;
      out.push({ ...rest, content: rest.content ?? '' });
      // skip following tools that belonged to this incomplete set
      i = k;
      continue;
    }

    out.push(msg);
    out.push(...following);
    if (missing.length && mode === 'fill') {
      for (const tc of missing) {
        out.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function?.name || 'tool',
          content: JSON.stringify({ error: 'Tool result unavailable', cancelled: true })
        });
      }
    }
    i = k;
  }
  messages.splice(0, messages.length, ...out);
}

/**
 * Preserve full conversation history; only cap agent tool-loop growth.
 *
 * Message shape: [system…, ...history(non-sys), ...loopGrowth(non-sys)]
 * Legacy call: trimContext(messages, keepCount) still works as “keep last N”
 * for callers that do not pass history options (treated as pure tail trim).
 */
export function trimContext(
  messages: RequestMessage[],
  keepCountOrOptions: number | TrimContextOptions
): void {
  if (typeof keepCountOrOptions === 'number') {
    trimContextLegacy(messages, keepCountOrOptions);
    ensureToolCallPairs(messages, 'fill');
    return;
  }

  const historyCount = Math.max(0, Math.floor(keepCountOrOptions.historyCount || 0));
  const maxLoopMessages = Math.max(
    2,
    Math.floor(keepCountOrOptions.maxLoopMessages ?? DEFAULT_MAX_LOOP_MESSAGES)
  );

  const sys = messages.filter((message) => message.role === 'system');
  const nonSys = messages.filter((message) => message.role !== 'system');

  if (nonSys.length <= historyCount + maxLoopMessages) {
    ensureToolCallPairs(messages, 'fill');
    return;
  }

  const history = nonSys.slice(0, historyCount);
  const loop = nonSys.slice(historyCount);
  // Prefer cutting at safe boundaries: don't start loop tail mid-tool results
  let cut = Math.max(0, loop.length - maxLoopMessages);
  while (cut < loop.length && loop[cut].role === 'tool') cut += 1;
  // If cut lands on assistant with tool_calls, include following tools by extending start earlier
  if (cut > 0 && loop[cut - 1]?.role === 'assistant' && loop[cut - 1]?.tool_calls?.length) {
    // keep from this assistant
    cut -= 1;
  }
  const loopTail = loop.slice(cut);

  messages.splice(0, messages.length, ...sys, ...history, ...loopTail);
  ensureToolCallPairs(messages, 'fill');
}

/** Legacy: keep last keepCount non-system (+ first/last user). Prefer options API. */
function trimContextLegacy(messages: RequestMessage[], keepCount: number): void {
  const sys = messages.filter((message) => message.role === 'system');
  const nonSys = messages.filter((message) => message.role !== 'system');

  if (nonSys.length <= keepCount) return;

  const firstUserIndex = nonSys.findIndex((message) => message.role === 'user');
  const firstUser = firstUserIndex >= 0 ? nonSys[firstUserIndex] : null;
  const lastUserIndex = (() => {
    for (let i = nonSys.length - 1; i >= 0; i--) {
      if (nonSys[i].role === 'user') return i;
    }
    return -1;
  })();
  const lastUser = lastUserIndex >= 0 ? nonSys[lastUserIndex] : null;

  const tail = nonSys.slice(-keepCount);

  const result = [...sys];
  if (firstUser && !tail.includes(firstUser)) {
    result.push(firstUser);
  }
  if (lastUser && lastUser !== firstUser && !tail.includes(lastUser)) {
    result.push(lastUser);
  }
  result.push(...tail);

  messages.splice(0, messages.length, ...result);
}
