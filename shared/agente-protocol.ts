// ── Agente wire protocol (main ⇄ renderer) ─────────────────────────────
// The single definition of what crosses the Electron IPC boundary for
// Agente Coding: a flat CodeAgentEvent stream pushed over the
// `code_agent_event` channel, and the argument/result shapes of the
// `agente_*` invoke channels.
//
// Both processes import this file — main by relative path, the renderer
// through the `$shared/*` alias — so a change to the contract is a compile
// error on the side that has not caught up, instead of a silent drift
// between two hand-synced copies.

/** How much autonomy the runtime has: plan-first, per-action approval, or free rein. */
export type AgenteRuntimeMode = 'full' | 'supervised' | 'plan';

/** Answer to an `approval_request`. */
export type ApprovalDecision = 'allow' | 'deny';

export type CodeAgentEvent =
  | { type: 'agent_start'; chatId: string }
  | { type: 'agent_end'; chatId: string }
  | { type: 'turn_start'; chatId: string; turnIndex: number }
  | { type: 'turn_end'; chatId: string; turnIndex: number }
  | { type: 'text_delta'; chatId: string; delta: string }
  | { type: 'thinking_delta'; chatId: string; delta: string }
  | { type: 'tool_start'; chatId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_update'; chatId: string; toolCallId: string; partialResult: unknown }
  | { type: 'tool_end'; chatId: string; toolCallId: string; result: unknown; isError: boolean }
  | { type: 'compaction_start'; chatId: string; reason: string }
  | { type: 'compaction_end'; chatId: string; reason: string; success: boolean }
  | { type: 'approval_request'; chatId: string; requestId: string; toolName: string; args: unknown; diff?: string; kind?: 'action' | 'plan' }
  | { type: 'approval_resolved'; chatId: string; requestId: string; decision: ApprovalDecision }
  | { type: 'checkpoint_captured'; chatId: string; turnIndex: number; fileCount: number }
  | {
      type: 'checkpoint_finalized';
      chatId: string;
      turnIndex: number;
      files: Array<{ path: string; additions: number; deletions: number; kind: string }>;
    }
  | {
      /** Real token accounting from the last model call; promptTokens is the context footprint. */
      type: 'usage';
      chatId: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      contextWindow: number;
    }
  | { type: 'error'; chatId: string; message: string };

export interface AgenteStartSessionArgs {
  chatId: string;
  projectRoot: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
  runtimeMode: AgenteRuntimeMode;
  systemPromptOverride?: string;
  resumeSessionId?: string;
  checkpointsEnabled?: boolean;
}

export interface AgenteSessionInfo {
  sessionId: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  entryCount: number;
  title: string;
}

/** One turn's checkpoint, as returned by `agente_list_checkpoints`. */
export interface AgenteCheckpointSummary {
  turnIndex: number;
  createdAt: number;
  fileCount: number;
  additions: number;
  deletions: number;
}
