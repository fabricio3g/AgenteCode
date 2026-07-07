import { invoke } from '$lib/services/tauri';

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

export interface ChateaAgentDetectArgs {
  provider: string;
  model: string;
}

export interface ChateaAgentDetectResult {
  status: 'ready' | 'login' | 'missing';
}

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

export function detectChateaAgent(args: ChateaAgentDetectArgs): Promise<ChateaAgentDetectResult> {
  return invoke<ChateaAgentDetectResult>('chatea_agent_detect', args as unknown as Record<string, unknown>);
}

export function startChateaAgentSession(args: ChateaAgentStartSessionArgs): Promise<ChateaAgentStartSessionResult> {
  return invoke<ChateaAgentStartSessionResult>('chatea_agent_start_session', args as unknown as Record<string, unknown>);
}

export function promptChateaAgent(chatId: string, text: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_prompt', { chatId, text, images });
}

export function steerChateaAgent(chatId: string, text: string): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_steer', { chatId, text });
}

export function followUpChateaAgent(chatId: string, text: string): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_follow_up', { chatId, text });
}

export function abortChateaAgent(chatId: string): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_abort', { chatId });
}

export function compactChateaAgent(chatId: string, customInstructions?: string): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_compact', { chatId, customInstructions });
}

export function setChateaAgentModel(chatId: string, provider: string, model: string, thinkingLevel?: string): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_set_model', { chatId, provider, model, thinkingLevel });
}

export function setChateaAgentRuntimeMode(chatId: string, mode: 'full' | 'supervised'): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_set_runtime_mode', { chatId, mode });
}

export function setChateaAgentThinkingLevel(chatId: string, level: string): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_set_thinking_level', { chatId, level });
}

export function respondToApproval(chatId: string, requestId: string, decision: 'allow' | 'deny'): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_respond_approval', { chatId, requestId, decision });
}

export interface ChateaAgentCheckpointSummary {
  turnIndex: number;
  createdAt: number;
  fileCount: number;
  additions: number;
  deletions: number;
}

export function listCheckpoints(chatId: string): Promise<ChateaAgentCheckpointSummary[]> {
  return invoke<ChateaAgentCheckpointSummary[]>('chatea_agent_list_checkpoints', { chatId });
}

export function rollbackChateaAgent(chatId: string, turnIndex: number): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_rollback', { chatId, turnIndex });
}

export function forkChateaAgent(chatId: string, entryId: string, position?: 'before' | 'at'): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_fork', { chatId, entryId, position });
}

export function closeChateaAgentSession(chatId: string): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_close', { chatId });
}

export function newChateaAgentSession(chatId: string): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_new_session', { chatId });
}

export function cycleChateaAgentModel(chatId: string, direction: 1 | -1): Promise<{ ok: boolean }> {
  return invoke('chatea_agent_cycle_model', { chatId, direction });
}
