import type { ClientToolCall, ClientToolDefinition, ClientToolResult, HomeTurnPolicy, Message, RuntimeEventEnvelope, SessionSnapshot, TurnOutcome } from './agente-protocol.gen.ts';

export interface HomeRuntimeMeta {
  sessionId: string;
  revision: number;
  provider: string;
  model: string;
  contextWindow: number;
  contextTokens?: number;
  estimated?: boolean;
  /** Visible message IDs, not model/tool messages; detects edits and branches. */
  historyIds: string[];
  files?: Record<string, string>;
}
export interface HomeStartArgs {
  runId: string;
  sessionId?: string;
  forkIndex?: number;
  conversation?: Message[];
  prompt?: Message;
  systemPrompt: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
  policy: HomeTurnPolicy;
  tools: ClientToolDefinition[];
}
export type HomeRuntimeEvent =
  | { runId: string; type: 'event'; envelope: RuntimeEventEnvelope }
  | { runId: string; type: 'call' | 'cancel'; call: ClientToolCall }
  | { runId: string; type: 'outcome'; outcome: TurnOutcome; snapshot: SessionSnapshot }
  | { runId: string; type: 'error'; message: string };
export type HomeToolReply = { runId: string; result: ClientToolResult };
