// ── The pure agent loop ────────────────────────────────────────────────
// A plain async function over (messages, config, tools, streamFn, emit):
// no state of its own, no imports of providers or storage. Everything the
// loop needs is injected; everything it does is announced through `emit`.
// (Same contract as pi's runLoop, scaled to what this app needs.)

import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AssistantMessage,
  StreamFn,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  WireTool
} from './types.ts';

export interface AgentLoopHooks {
  /** Pre-execution gate (approvals, extension blocks). Return a string to fail the call. */
  beforeToolCall?(toolCallId: string, toolName: string, args: Record<string, unknown>): Promise<{ block?: string } | void>;
  /** Post-execution observer (extensions may override result fields). */
  afterToolCall?(toolCallId: string, toolName: string, result: ToolResult): Promise<Partial<ToolResult> | void>;
  /** Called between turns; return { stop: true } to end the run. */
  prepareNextTurn?(turnIndex: number): Promise<{ stop?: boolean } | void>;
  /**
   * Called with a turn's tool calls before any of them run (budgets, loop
   * guards). Return { stop: true } to end the run without executing them.
   */
  beforeToolBatch?(toolCalls: ToolCall[], turnIndex: number): Promise<{ stop?: boolean } | void>;
  /**
   * Called when the model stops without tool calls. Return { retry } to reject
   * the reply and give the model another turn with those messages appended
   * (a missing deliverable, an unreadable tool call).
   */
  reviewFinalReply?(message: AssistantMessage, turnIndex: number): Promise<{ retry?: UserMessage[] } | void>;
}

export interface AgentLoopConfig {
  maxTurns: number;
}

export interface AgentLoopArgs {
  messages: AgentMessage[];
  config: AgentLoopConfig;
  tools: Map<string, AgentTool>;
  enabledTools: Set<string>;
  streamFn: StreamFn;
  systemPrompt: string;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  hooks?: AgentLoopHooks;
  /**
   * Messages queued mid-run. `steer` injects after the current turn's tools
   * (course correction); `followUp` only when the agent would otherwise stop.
   * Drained by the caller-supplied getters so the loop stays stateless.
   */
  drainSteered: () => UserMessage[];
  drainFollowUps: () => UserMessage[];
}

export interface AgentLoopResult {
  messages: AgentMessage[];
  stopReason: AssistantMessage['stopReason'];
  turns: number;
}

// ── Run resilience (dsh-inspired) ──────────────────────────────────────

/** Total stream attempts per turn: one live try + two retries. */
const MAX_STREAM_ATTEMPTS = 3;
/** Backoff schedule between attempts. */
const RETRY_DELAYS_MS = [1_000, 2_000];
/**
 * Consecutive length-truncated turns tolerated before the run gives up —
 * each continuation costs a full request, so the cap prevents burn loops.
 */
const MAX_LENGTH_CONTINUES = 3;
/** Identical-call streaks that trigger a change-approach note. */
const REPEAT_NOTE_THRESHOLDS = [3, 5, 8];
/** Tail of call signatures kept for repeat detection. */
const REPEAT_WINDOW = 8;

/** Error codes an automatic retry can plausibly fix (provider protocol). */
const RETRYABLE_ERROR_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']);

/**
 * Whether a stream failure looks transient and is worth an automatic retry.
 * The provider protocol classifies errors into stable codes; the text
 * heuristic remains as a fallback for unclassified failures.
 */
export function isTransientStreamError(message: string, code?: string): boolean {
  if (code) return RETRYABLE_ERROR_CODES.has(code);
  return /\b(429|rate.?limit|502|503|504|505|gateway|timeout|timed?.?out|overloaded|econn(refused|reset|aborted)?|socket hang up|network|fetch failed)\b/i
    .test(message);
}

/** Stable stringify with sorted object keys, so argument order cannot defeat repeat detection. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  result: ToolResult
): ToolResultMessage {
  return {
    role: 'tool',
    toolCallId,
    toolName,
    content: result.content,
    isError: !!result.isError,
    details: result.details,
    ts: Date.now()
  };
}

async function executeTool(
  tool: AgentTool,
  toolCallId: string,
  args: Record<string, unknown>,
  argsEmitter: (event: AgentEvent) => void,
  signal: AbortSignal
): Promise<ToolResult> {
  argsEmitter({ type: 'tool_start', toolCallId, toolName: tool.name, args });
  try {
    const result = await tool.execute(toolCallId, args, {
      signal,
      onUpdate: (partial) => argsEmitter({ type: 'tool_update', toolCallId, toolName: tool.name, partial }),
      emit: argsEmitter
    });
    return result;
  } catch (err: unknown) {
    // Tools throw; the loop converts throws into error results — the model
    // sees the failure and can correct itself on the next turn.
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}`, isError: true };
  }
}

/**
 * One model request with transient-failure retries (dsh's llm/retry pattern).
 * Only a failure that produced zero deltas retries — once content shipped to
 * the transcript, a replay would duplicate it.
 */
async function callStreamWithRetry(
  args: AgentLoopArgs,
  wireTools: WireTool[],
  emit: (event: AgentEvent) => void
): Promise<AssistantMessage> {
  const { signal } = args;
  let sawDelta = false;
  for (let attempt = 1; ; attempt += 1) {
    sawDelta = false;
    const assistant = await args.streamFn({
      systemPrompt: args.systemPrompt,
      messages: args.messages,
      tools: wireTools,
      signal,
      callbacks: {
        onTextDelta: (delta) => {
          sawDelta = true;
          emit({ type: 'text_delta', delta });
        },
        onThinkingDelta: (delta) => {
          sawDelta = true;
          emit({ type: 'thinking_delta', delta });
        }
      }
    });
    const retryable =
      assistant.stopReason === 'error'
      && !sawDelta
      && !assistant.content
      && !(assistant.toolCalls?.length)
      && !!assistant.errorMessage
      && isTransientStreamError(assistant.errorMessage, assistant.errorCode);
    if (!retryable || attempt >= MAX_STREAM_ATTEMPTS || signal.aborted) return assistant;
    const delayMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!;
    emit({ type: 'llm_retry', attempt, delayMs });
    await sleepAbortable(delayMs, signal);
    if (signal.aborted) return assistant;
  }
}

export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const { messages, tools, enabledTools, emit, signal, hooks } = args;
  const maxTurns = Math.max(1, args.config.maxTurns | 0);
  let turns = 0;
  // Every break assigns stopReason; only the turn budget expiring mid-flight
  // leaves it null. That distinction drives the limit notice below.
  let stopReason: AssistantMessage['stopReason'] | null = null;
  // Consecutive length-truncated turns — each one auto-continues until the cap.
  let lengthStreak = 0;
  // Recent (tool, canonical-args) signatures for repeat-call detection.
  const repeatWindow: string[] = [];

  const wireTools = Array.from(enabledTools)
    .map((name) => tools.get(name))
    .filter((t): t is AgentTool => !!t)
    .map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));

  emit({ type: 'agent_start' });

  while (turns < maxTurns) {
    if (signal.aborted) {
      stopReason = 'aborted';
      break;
    }
    turns += 1;
    emit({ type: 'turn_start', turnIndex: turns });

    const assistant = await callStreamWithRetry(args, wireTools, emit);

    messages.push(assistant);
    emit({ type: 'message_end', message: assistant });

    if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
      stopReason = assistant.stopReason;
      emit({ type: 'turn_end', turnIndex: turns });
      break;
    }

    const toolCalls = assistant.toolCalls ?? [];

    if (assistant.stopReason === 'length') {
      // Truncated arguments are unsafe to execute — fail every pending call
      // with a re-issue hint, then keep going (dsh treats a cap hit as a
      // reason to continue, not a reason to abandon the task).
      for (const call of toolCalls) {
        const blocked = toolResultMessage(call.id, call.name, {
          content: 'Error: the response hit the length limit before this tool call completed. Re-issue the call with shorter arguments.',
          isError: true
        });
        messages.push(blocked);
        emit({ type: 'tool_end', toolCallId: call.id, toolName: call.name, result: blocked.content, isError: true });
      }
      lengthStreak += 1;
      emit({ type: 'turn_end', turnIndex: turns });
      if (lengthStreak >= MAX_LENGTH_CONTINUES) {
        stopReason = 'length';
        break;
      }
      emit({ type: 'length_continue', turnIndex: turns });
      continue;
    }
    lengthStreak = 0;

    if (!toolCalls.length) {
      // Natural stop — unless the user queued a steer or follow-up while we
      // were streaming: queued input vetoes the stop (dsh keeps the turn
      // alive whenever next-step input is waiting).
      const queued = [...args.drainSteered(), ...args.drainFollowUps()];
      if (queued.length && !signal.aborted) {
        messages.push(...queued);
        emit({ type: 'input_injected', messages: queued });
        emit({ type: 'turn_end', turnIndex: turns });
        continue;
      }
      const review = await hooks?.reviewFinalReply?.(assistant, turns);
      if (review?.retry?.length && !signal.aborted) {
        messages.push(...review.retry);
        emit({ type: 'turn_end', turnIndex: turns });
        continue;
      }
      stopReason = 'stop';
      emit({ type: 'turn_end', turnIndex: turns });
      break;
    }

    const batch = await hooks?.beforeToolBatch?.(toolCalls, turns);
    if (batch?.stop) {
      stopReason = 'stop';
      emit({ type: 'turn_end', turnIndex: turns });
      break;
    }

    let terminate = false;

    // Results are produced in the model's original call order (parallel
    // batches run together, sequential tools interleave in place) so the
    // transcript reads back deterministically.
    const indexed = toolCalls.map((call, index) => ({ call, index }));

    const outcomes = new Array<ToolResultMessage | null>(indexed.length).fill(null);
    const runSequential: Array<(typeof indexed)[number]> = [];
    const runParallel: Array<(typeof indexed)[number]> = [];

    for (const entry of indexed) {
      const tool = tools.get(entry.call.name);
      const known = !!tool && enabledTools.has(entry.call.name);
      if (known && tool!.executionMode === 'sequential') runSequential.push(entry);
      else if (known) runParallel.push(entry);
      else runSequential.push(entry); // unknown tools resolve inline, in order
    }

    const runOne = async (entry: (typeof indexed)[number]) => {
      const { call, index } = entry;
      const tool = tools.get(call.name);
      if (!tool || !enabledTools.has(call.name)) {
        const missing = toolResultMessage(call.id, call.name, {
          content: `Error: unknown tool "${call.name}". Available: ${Array.from(enabledTools).join(', ')}`,
          isError: true
        });
        emit({ type: 'tool_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
        outcomes[index] = missing;
        emit({ type: 'tool_end', toolCallId: call.id, toolName: call.name, result: missing.content, isError: true });
        return;
      }
      const gate = await hooks?.beforeToolCall?.(call.id, call.name, call.arguments);
      if (gate?.block) {
        outcomes[index] = toolResultMessage(call.id, call.name, {
          content: `Blocked: ${gate.block}`,
          isError: true
        });
        emit({ type: 'tool_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
        emit({ type: 'tool_end', toolCallId: call.id, toolName: call.name, result: outcomes[index]!.content, isError: true });
        return;
      }
      const raw = await executeTool(tool, call.id, call.arguments, emit, signal);
      const override = await hooks?.afterToolCall?.(call.id, call.name, raw);
      const merged: ToolResult = override ? { ...raw, ...override } : raw;
      if (merged.terminate) terminate = true;
      outcomes[index] = toolResultMessage(call.id, call.name, merged);
      emit({ type: 'tool_end', toolCallId: call.id, toolName: call.name, result: merged.content, isError: !!merged.isError });
    };

    // Parallel batch first…
    await Promise.all(runParallel.map((entry) => runOne(entry)));
    // …then anything that must not interleave (bash, write, edit).
    for (const entry of runSequential) {
      await runOne(entry);
    }

    for (const outcome of outcomes) {
      if (outcome) messages.push(outcome);
    }

    // ── Repeat-call guard (dsh repeat-tool-reminder) ────────────────────
    // A model stuck in a loop re-issues the identical call; at the dsh
    // thresholds we inject a note telling it to change approach instead of
    // burning turns silently.
    for (const call of toolCalls) {
      repeatWindow.push(`${call.name}:${canonicalJson(call.arguments ?? {})}`);
    }
    if (repeatWindow.length > REPEAT_WINDOW) {
      repeatWindow.splice(0, repeatWindow.length - REPEAT_WINDOW);
    }
    const lastSignature = repeatWindow[repeatWindow.length - 1];
    if (lastSignature !== undefined) {
      let consecutive = 0;
      for (let i = repeatWindow.length - 1; i >= 0 && repeatWindow[i] === lastSignature; i -= 1) {
        consecutive += 1;
      }
      if (REPEAT_NOTE_THRESHOLDS.includes(consecutive)) {
        const repeatName = toolCalls[toolCalls.length - 1]?.name ?? 'tool';
        const note: UserMessage = {
          role: 'user',
          content:
            `[note] You have made the identical ${repeatName} call ${consecutive} times in a row with the same arguments. ` +
            'The repeated calls are not making progress. Change the approach: read the tool output again, adjust the arguments, or explain what is blocking you instead of repeating the call.',
          ts: Date.now()
        };
        messages.push(note);
      }
    }

    emit({ type: 'turn_end', turnIndex: turns });

    if (terminate) {
      stopReason = 'stop';
      break;
    }

    // Steering: course-correct after the tools landed, before the next stream.
    const steered = args.drainSteered();
    if (steered.length) {
      messages.push(...steered);
      emit({ type: 'input_injected', messages: steered });
    }

    const prepared = await hooks?.prepareNextTurn?.(turns);
    if (prepared?.stop) {
      stopReason = 'stop';
      break;
    }
  }

  // The loop can also fall out of the while without any break — that is the
  // turn budget expiring mid-flight.
  let hitTurnLimit = false;
  if (stopReason === null) {
    stopReason = 'stop';
    if (turns >= maxTurns) {
      hitTurnLimit = true;
      messages.push({
        role: 'assistant',
        content: `Reached the turn limit (${maxTurns}). Ask me to continue if there is more to do.`,
        stopReason: 'stop',
        ts: Date.now()
      });
    }
  }

  emit({ type: 'agent_end', stopReason, ...(hitTurnLimit ? { hitTurnLimit } : {}) });
  return { messages, stopReason, turns };
}
