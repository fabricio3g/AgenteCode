// Typed client for the agente_* IPC surface.

import { invoke } from '$lib/services/tauri';
import type { AgenteCheckpointSummary, AgenteRuntimeMode, AgenteSessionInfo, AgenteStartSessionArgs, ApprovalDecision } from '$shared/agente-protocol';

export function detectAgente(): Promise<{ status: 'ready' | 'login' | 'missing' }> {
  return invoke('agente_detect', {});
}

export function startAgenteSession(args: AgenteStartSessionArgs): Promise<{ sessionId: string; resumed: boolean }> {
  return invoke('agente_start_session', args as unknown as Record<string, unknown>);
}

export function promptAgente(chatId: string, text: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ ok: boolean; error?: string }> {
  return invoke('agente_prompt', { chatId, text, images });
}

export function steerAgente(chatId: string, text: string): Promise<{ ok: boolean }> {
  return invoke('agente_steer', { chatId, text });
}

export function followUpAgente(chatId: string, text: string): Promise<{ ok: boolean }> {
  return invoke('agente_follow_up', { chatId, text });
}

export function abortAgente(chatId: string): Promise<{ ok: boolean }> {
  return invoke('agente_abort', { chatId });
}

export function compactAgente(chatId: string, customInstructions?: string): Promise<{ ok: boolean; error?: string }> {
  return invoke('agente_compact', { chatId, customInstructions });
}

export function setAgenteModel(chatId: string, provider: string, model: string, thinkingLevel?: string): Promise<{ ok: boolean }> {
  return invoke('agente_set_model', { chatId, provider, model, thinkingLevel });
}

export function setAgenteRuntimeMode(chatId: string, mode: AgenteRuntimeMode): Promise<{ ok: boolean }> {
  return invoke('agente_set_runtime_mode', { chatId, mode });
}

export function respondToAgenteApproval(chatId: string, requestId: string, decision: ApprovalDecision): Promise<{ ok: boolean }> {
  return invoke('agente_respond_approval', { chatId, requestId, decision });
}

export function listAgenteCheckpoints(chatId: string): Promise<AgenteCheckpointSummary[]> {
  return invoke('agente_list_checkpoints', { chatId });
}

export function rollbackAgente(chatId: string, turnIndex: number): Promise<{ ok: boolean; restored?: number; error?: string }> {
  return invoke('agente_rollback', { chatId, turnIndex });
}

export function closeAgenteSession(chatId: string): Promise<void> {
  return invoke('agente_close', { chatId });
}

export function newAgenteSession(chatId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  return invoke('agente_new_session', { chatId });
}

export function listAgenteSessions(projectRoot: string): Promise<AgenteSessionInfo[]> {
  return invoke('agente_list_sessions', { projectRoot });
}

export interface AgenteExtensionInfo {
  id: string;
  name: string;
  description: string;
  icon?: string;
  enabled: boolean;
  defaultEnabled: boolean;
}

export function listAgenteExtensions(): Promise<AgenteExtensionInfo[]> {
  return invoke('agente_list_extensions', {});
}

export function setAgenteExtensionEnabled(extensionId: string, enabled: boolean): Promise<{ ok: boolean }> {
  return invoke('agente_set_extension_enabled', { extensionId, enabled });
}
