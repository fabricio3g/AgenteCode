// Typed client for the agente_* IPC surface.

import { invoke } from '$lib/services/bridge';
import type { CodeCheckpointSummary, AgenteStartSessionArgs } from '$shared/agente-protocol';
import type { Attachment } from '$shared/agente-protocol.gen';

export function startCodeAgentSession(args: AgenteStartSessionArgs): Promise<{ sessionId: string; resumed: boolean; conversationIndex?: number }> {
  return invoke('agente_start_session', args as unknown as Record<string, unknown>);
}

export function codeMessageAction(chatId: string, action: 'fork' | 'rewind', conversationIndex: number): Promise<{ sessionId: string; reverted?: number }> {
  return invoke('agente_message_action', { chatId, action, conversationIndex });
}

export function promptCodeAgent(chatId: string, text: string, attachments?: Attachment[]): Promise<{ ok: boolean; error?: string; conversationIndex?: number }> {
  return invoke('agente_prompt', { chatId, text, attachments });
}

export function steerCodeAgent(chatId: string, text: string, attachments?: Attachment[]): Promise<{ ok: boolean }> {
  return invoke('agente_steer', { chatId, text, attachments });
}

export function followUpCodeAgent(chatId: string, text: string, attachments?: Attachment[]): Promise<{ ok: boolean }> {
  return invoke('agente_follow_up', { chatId, text, attachments });
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

// ── TUI parity: !commands, undo/redo, project lookups ──────────────────

/** Run `command` in the project's shell, outside the model (the TUI's `!command`). */
export function execCodeCommand(chatId: string, command: string): Promise<{ ok: boolean; error?: string }> {
  return invoke('agente_exec', { chatId, command });
}

/** Undo or redo the last batch of file edits in the conversation's session. */
export function codeEdits(chatId: string, action: 'undo' | 'redo'): Promise<{ ok: boolean; files?: string[]; error?: string }> {
  return invoke(action === 'undo' ? 'agente_undo' : 'agente_redo', { chatId });
}

export interface ProjectInfo {
  skills: Array<{ name: string; description: string; scope: 'user' | 'project'; source: string }>;
  agents: Array<{ name: string; description: string; builtin: boolean }>;
  commands: Array<{ name: string; description: string; template: string }>;
  agents_md: boolean;
}

export interface McpServer {
  name: string;
  target: string;
  remote: boolean;
  status: 'disabled' | 'needs_approval' | 'connecting' | 'ready' | 'failed';
  error: string | null;
  tools: number;
}

export function projectInfo(projectRoot: string): Promise<ProjectInfo> {
  return invoke('agente_project_info', { projectRoot });
}

/** Write AGENTS.md and the .agente folders (the TUI's /init). */
export function initProject(projectRoot: string): Promise<{ message: string }> {
  return invoke('agente_project_init', { projectRoot });
}

export function mcpStatus(projectRoot?: string): Promise<McpServer[]> {
  return invoke('agente_mcp_status', { projectRoot });
}

/** The project's files (git's view when it is a repository), for @ mentions. */
export function projectFiles(projectRoot: string): Promise<string[]> {
  return invoke('agente_project_files', { projectRoot });
}
