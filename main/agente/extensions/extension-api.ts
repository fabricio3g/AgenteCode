// ── Agente extension API ───────────────────────────────────────────────
// pi-shaped: an extension is a `setup(pi)` factory receiving a capability
// object. Tools, hooks and commands registered here are indistinguishable
// from the built-ins — the built-ins themselves are plain AgentTools, not
// privileged code. When external loading (~/.flaxeo/agente/extensions)
// lands, the same definitions load from disk unchanged.

import type { AgentMessage, ToolResult } from '../core/types.ts';

/** A tool contributed by an extension (JSON Schema in, ToolResult out). */
export interface AgenteExtensionTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  mutating?: boolean;
  executionMode?: 'sequential' | 'parallel';
  execute(args: Record<string, unknown>, ctx: AgenteExtensionToolContext): Promise<ToolResult>;
}

export interface AgenteExtensionToolContext {
  projectRoot: string;
  signal: AbortSignal;
  /** Streaming progress (surfaces as tool_update events). */
  onUpdate?(partial: unknown): void;
}

/** Slash command surfaced in the composer (renderer reads them via IPC). */
export interface AgenteExtensionCommand {
  description: string;
  /** Returns the text injected as the next user message. */
  handler(args: string, ctx: AgenteExtensionContext): Promise<string>;
}

export interface AgenteExtensionContext {
  extensionId: string;
  projectRoot: string;
  sessionId: string;
  runtimeMode: 'full' | 'supervised';
  /** Persist extension state into the session JSONL (not sent to the LLM). */
  appendEntry(type: string, data: unknown): void;
}

export type AgenteHookEvent =
  | 'before_agent_start'
  | 'turn_start'
  | 'turn_end'
  | 'message_end'
  | 'tool_call'
  | 'tool_result'
  | 'context';

export interface AgenteHookPayload {
  event: AgenteHookEvent;
  turnIndex?: number;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: ToolResult;
  /** Only for `context`: the message list, mutable copy. */
  messages?: AgentMessage[];
}

/** Hooks return values, never exceptions — cancellation is data (pi rule 5). */
export interface AgenteHookResult {
  /** tool_call: fail the call with this reason instead of executing it. */
  block?: string;
  /** tool_call/tool_result: end the run after this tool's batch. */
  terminate?: boolean;
  /** tool_result: override result fields. */
  content?: string;
  isError?: boolean;
  details?: unknown;
  /** context: the rewritten message list. */
  rewritten?: AgentMessage[];
}

export type AgenteHookHandler = (payload: AgenteHookPayload, ctx: AgenteExtensionContext) => Promise<AgenteHookResult | void> | AgenteHookResult | void;

export interface AgenteExtensionAPI {
  registerTool(tool: AgenteExtensionTool): void;
  registerCommand(name: string, command: AgenteExtensionCommand): void;
  on(event: AgenteHookEvent, handler: AgenteHookHandler): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface AgenteExtensionDefinition {
  id: string;
  name: string;
  description: string;
  icon?: string;
  defaultEnabled?: boolean;
  setup(pi: AgenteExtensionAPI): void | Promise<void>;
}
