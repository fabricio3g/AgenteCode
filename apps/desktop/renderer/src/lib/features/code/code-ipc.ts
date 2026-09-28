// Typed client for the agente_* IPC surface.

import { invoke } from '$lib/services/bridge';
import type { CodeCheckpointSummary, AgenteStartSessionArgs } from '$shared/agente-protocol';

export function startCodeAgentSession(args: AgenteStartSessionArgs): Promise<{ sessionId: string; resumed: boolean }> {
  return invoke('agente_start_session', args as unknown as Record<string, unknown>);
}

export function promptCodeAgent(chatId: string, text: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ ok: boolean; error?: string }> {
  return invoke('agente_prompt', { chatId, text, images });
}

export function steerCodeAgent(chatId: string, text: string): Promise<{ ok: boolean }> {
  return invoke('agente_steer', { chatId, text });
}

export function followUpCodeAgent(chatId: string, text: string): Promise<{ ok: boolean }> {
  return invoke('agente_follow_up', { chatId, text });
}

export function abortCodeAgent(chatId: string): Promise<{ ok: boolean }> {
  return invoke('agente_abort', { chatId });
}

export function compactCodeAgent(chatId: string, customInstructions?: string): Promise<{ ok: boolean; error?: string }> {
  return invoke('agente_compact', { chatId, customInstructions });
}

export function setAgenteModel(chatId: string, provider: string, model: string, thinkingLevel?: string): Promise<{ ok: boolean }> {
  return invoke('agente_set_model', { chatId, provider, model, thinkingLevel });
}

export function setCodeAgentRuntimeMode(chatId: string, mode: 'full' | 'supervised' | 'plan'): Promise<{ ok: boolean }> {
  return invoke('agente_set_runtime_mode', { chatId, mode });
}

export function respondToCodeAgentApproval(chatId: string, requestId: string, decision: 'allow' | 'deny'): Promise<{ ok: boolean }> {
  return invoke('agente_respond_approval', { chatId, requestId, decision });
}

export function listCodeAgentCheckpoints(chatId: string, sessionId?: string): Promise<CodeCheckpointSummary[]> {
  return invoke('agente_list_checkpoints', { chatId, sessionId });
}

/** Restore the project to before `turnIndex`; works without a live session. */
export function rollbackCodeAgent(
  chatId: string,
  turnIndex: number,
  options: { sessionId?: string; projectRoot?: string } = {}
): Promise<{ ok: boolean; restored?: number; files?: string[]; error?: string }> {
  return invoke('agente_rollback', { chatId, turnIndex, ...options });
}

/** Chats whose engine run is still going (a renderer reload does not stop it). */
export function listLiveCodeAgentChats(): Promise<string[]> {
  return invoke('agente_live_chats', {});
}

/** Close live sessions and delete their logs + checkpoints (never project files). */
export function deleteCodeAgentSessionData(args: { chatIds?: string[]; sessionIds?: string[] }): Promise<{ ok: boolean; removed: number }> {
  return invoke('agente_delete_session_data', args);
}
