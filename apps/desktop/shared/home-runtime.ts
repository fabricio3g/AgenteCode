import type { ContextBreakdown, LocalModelSelection } from './agente-protocol.ts';
import type { ClientToolCall, ClientToolDefinition, ClientToolResult, HomeTurnPolicy, Message, RuntimeEventEnvelope, SessionSnapshot, TurnOutcome } from './agente-protocol.gen.ts';

export interface HomeRuntimeMeta {
  sessionId: string;
  /** A goal was set before this session's first model turn. */
  goalPending?: boolean;
  revision: number;
  provider: string;
  model: string;
  contextWindow: number;
  contextTokens?: number;
  contextBreakdown?: ContextBreakdown;
  estimated?: boolean;
  /** Visible message IDs, not model/tool messages; detects edits and branches. */
  historyIds: string[];
  files?: Record<string, string>;
}
export interface HomeStartArgs {
  chatId?: string;
  computerEnabled?: boolean;
  computerRequested?: boolean;
  localSelection?: LocalModelSelection;
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
  | { runId: string; type: 'event'; envelope: RuntimeEventEnvelope; serviceName?: string }
  | { runId: string; type: 'call' | 'cancel'; call: ClientToolCall }
  | { runId: string; type: 'outcome'; outcome: TurnOutcome; snapshot: SessionSnapshot }
  | { runId: string; type: 'error'; message: string };
export type HomeToolReply = { runId: string; result: ClientToolResult };
