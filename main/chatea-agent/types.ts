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

export interface ChateaAgentStartSessionArgs {
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

export interface ChateaAgentStartSessionResult {
  sessionId: string;
}

export interface ChateaAgentPromptArgs {
  chatId: string;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface ChateaAgentDetectArgs {
  provider: string;
  model: string;
}

export interface ChateaAgentDetectResult {
  status: 'ready' | 'login' | 'missing';
}

export interface ChateaAgentSteerArgs {
  chatId: string;
  text: string;
}

export interface ChateaAgentFollowUpArgs {
  chatId: string;
  text: string;
}

export interface ChateaAgentAbortArgs {
  chatId: string;
}

export interface ChateaAgentCompactArgs {
  chatId: string;
  customInstructions?: string;
}

export interface ChateaAgentSetModelArgs {
  chatId: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
}

export interface ChateaAgentSetRuntimeModeArgs {
  chatId: string;
  mode: 'full' | 'supervised';
}

export interface ChateaAgentSetThinkingLevelArgs {
  chatId: string;
  level: string;
}

export interface ChateaAgentRespondApprovalArgs {
  chatId: string;
  requestId: string;
  decision: 'allow' | 'deny';
}

export interface ChateaAgentListCheckpointsArgs {
  chatId: string;
}

export interface ChateaAgentCheckpointSummary {
  turnIndex: number;
  createdAt: number;
  fileCount: number;
  additions: number;
  deletions: number;
}

export interface ChateaAgentRollbackArgs {
  chatId: string;
  turnIndex: number;
}

export interface ChateaAgentForkArgs {
  chatId: string;
  entryId: string;
  position?: 'before' | 'at';
}

export interface ChateaAgentCloseArgs {
  chatId: string;
}

export interface ChateaAgentNewSessionArgs {
  chatId: string;
}

export interface ChateaAgentCycleModelArgs {
  chatId: string;
  direction: 1 | -1;
}

export interface ChateaAgentSessionEntry {
  chatId: string;
  sessionId: string;
  createdAt: number;
  disposed: boolean;
}
