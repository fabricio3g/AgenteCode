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
  ToolResult,
  ToolResultMessage,
  UserMessage
} from './types.ts';

export interface AgentLoopHooks {
  /** Pre-execution gate (approvals, extension blocks). Return a string to fail the call. */
  beforeToolCall?(toolCallId: string, toolName: string, args: Record<string, unknown>): Promise<{ block?: string } | void>;
  /** Post-execution observer (extensions may override result fields). */
  afterToolCall?(toolCallId: string, toolName: string, result: ToolResult): Promise<Partial<ToolResult> | void>;
  /** Called between turns; return { stop: true } to end the run. */
  prepareNextTurn?(turnIndex: number): Promise<{ stop?: boolean } | void>;
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
      onUpdate: (partial) => argsEmitter({ type: 'tool_update', toolCallId, toolName: tool.name, partial })
    });
    return result;
  } catch (err: unknown) {
    // Tools throw; the loop converts throws into error results — the model
    // sees the failure and can correct itself on the next turn.
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}`, isError: true };
  }
}

export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const { messages, tools, enabledTools, streamFn, emit, signal, hooks } = args;
  const maxTurns = Math.max(1, args.config.maxTurns | 0);
  let turns = 0;
  // Every break assigns stopReason; only the turn budget expiring mid-flight
  // leaves it null. That distinction drives the limit notice below.
  let stopReason: AssistantMessage['stopReason'] | null = null;

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

    const assistant = await streamFn({
      systemPrompt: args.systemPrompt,
      messages,
      tools: wireTools,
      signal,
      callbacks: {
        onTextDelta: (delta) => emit({ type: 'text_delta', delta }),
        onThinkingDelta: (delta) => emit({ type: 'thinking_delta', delta })
      }
    });

    messages.push(assistant);
    emit({ type: 'message_end', message: assistant });

    if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
      stopReason = assistant.stopReason;
      emit({ type: 'turn_end', turnIndex: turns });
      break;
    }

    const toolCalls = assistant.toolCalls ?? [];

    if (assistant.stopReason === 'length') {
      // Truncated arguments are unsafe to execute — fail every pending call.
      for (const call of toolCalls) {
        const blocked = toolResultMessage(call.id, call.name, {
          content: 'Error: the response hit the length limit before this tool call completed. Re-issue the call with shorter arguments.',
          isError: true
        });
        messages.push(blocked);
        emit({ type: 'tool_end', toolCallId: call.id, toolName: call.name, result: blocked.content, isError: true });
      }
      stopReason = 'length';
      emit({ type: 'turn_end', turnIndex: turns });
      break;
    }

    if (!toolCalls.length) {
      // Natural stop — unless a follow-up was queued while we were streaming.
      const followUps = args.drainFollowUps();
      if (followUps.length && !signal.aborted) {
        messages.push(...followUps);
        emit({ type: 'turn_end', turnIndex: turns });
        continue;
      }
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

    emit({ type: 'turn_end', turnIndex: turns });

    if (terminate) {
      stopReason = 'stop';
      break;
    }

    // Steering: course-correct after the tools landed, before the next stream.
    const steered = args.drainSteered();
    if (steered.length) messages.push(...steered);

    const prepared = await hooks?.prepareNextTurn?.(turns);
    if (prepared?.stop) {
      stopReason = 'stop';
      break;
    }
  }

  // The loop can also fall out of the while without any break — that is the
  // turn budget expiring mid-flight.
  if (stopReason === null) {
    stopReason = 'stop';
    if (turns >= maxTurns) {
      messages.push({
        role: 'assistant',
        content: `Reached the turn limit (${maxTurns}). Ask me to continue if there is more to do.`,
        stopReason: 'stop',
        ts: Date.now()
      });
    }
  }

  emit({ type: 'agent_end', stopReason });
  return { messages, stopReason, turns };
}
