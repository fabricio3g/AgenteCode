// Agente Coding wire protocol — renderer copy of main/agente/types.ts.
// Kept in sync by hand; the shapes are frozen behind the `code_agent_event`
// channel and the `agente_*` invoke channels.

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
  | { type: 'approval_request'; chatId: string; requestId: string; toolName: string; args: unknown; diff?: string }
  | { type: 'approval_resolved'; chatId: string; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'checkpoint_captured'; chatId: string; turnIndex: number; fileCount: number }
  | {
      type: 'checkpoint_finalized';
      chatId: string;
      turnIndex: number;
      files: Array<{ path: string; additions: number; deletions: number; kind: string }>;
    }
  | { type: 'error'; chatId: string; message: string };

export interface AgenteStartSessionArgs {
  chatId: string;
  projectRoot: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
  runtimeMode: 'full' | 'supervised';
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

export interface AgenteCheckpointSummary {
  turnIndex: number;
  createdAt: number;
  fileCount: number;
  additions: number;
  deletions: number;
}
