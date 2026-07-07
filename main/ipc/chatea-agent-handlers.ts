import type { IpcMain, BrowserWindow } from 'electron';
import {
  detectChateaAgent,
  startChateaAgentSession,
  sendCommand,
  closeChateaAgentSession,
  disposeAllChateaAgentSessions,
  emitCodeAgentEvent,
  setMainWindowGetter,
} from '../chatea-agent/index.ts';
import type {
  ChateaAgentDetectArgs,
  ChateaAgentDetectResult,
  ChateaAgentStartSessionArgs,
  ChateaAgentStartSessionResult,
  ChateaAgentPromptArgs,
  ChateaAgentSteerArgs,
  ChateaAgentFollowUpArgs,
  ChateaAgentAbortArgs,
  ChateaAgentCompactArgs,
  ChateaAgentSetModelArgs,
  ChateaAgentSetRuntimeModeArgs,
  ChateaAgentSetThinkingLevelArgs,
  ChateaAgentRespondApprovalArgs,
  ChateaAgentListCheckpointsArgs,
  ChateaAgentCheckpointSummary,
  ChateaAgentRollbackArgs,
  ChateaAgentForkArgs,
  ChateaAgentCloseArgs,
  ChateaAgentNewSessionArgs,
  ChateaAgentCycleModelArgs,
} from '../chatea-agent/types.ts';

type ChateaAgentHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
};

export function registerChateaAgentHandlers({ ipcMain, getMainWindow }: ChateaAgentHandlerDeps): void {
  setMainWindowGetter(getMainWindow);

  ipcMain.handle('chatea_agent_detect', (_e, args: ChateaAgentDetectArgs): Promise<ChateaAgentDetectResult> => {
    return detectChateaAgent(args);
  });

  ipcMain.handle('chatea_agent_start_session', async (_e, args: ChateaAgentStartSessionArgs): Promise<ChateaAgentStartSessionResult> => {
    const result = await startChateaAgentSession(args);
    emitCodeAgentEvent(getMainWindow(), { type: 'agent_start', chatId: args.chatId });
    return result;
  });

  ipcMain.handle('chatea_agent_prompt', async (_e, args: ChateaAgentPromptArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'prompt', chatId: args.chatId, text: args.text, images: args.images });
    return { ok: true };
  });

  ipcMain.handle('chatea_agent_steer', (_e, args: ChateaAgentSteerArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'steer', chatId: args.chatId, text: args.text });
    return Promise.resolve({ ok: true });
  });

  ipcMain.handle('chatea_agent_follow_up', (_e, args: ChateaAgentFollowUpArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'follow_up', chatId: args.chatId, text: args.text });
    return Promise.resolve({ ok: true });
  });

  ipcMain.handle('chatea_agent_abort', (_e, args: ChateaAgentAbortArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'abort', chatId: args.chatId });
    return Promise.resolve({ ok: true });
  });

  ipcMain.handle('chatea_agent_compact', (_e, args: ChateaAgentCompactArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'compact', chatId: args.chatId, customInstructions: args.customInstructions });
    return Promise.resolve({ ok: true });
  });

  ipcMain.handle('chatea_agent_set_model', (_e, args: ChateaAgentSetModelArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'set_model', chatId: args.chatId, provider: args.provider, model: args.model, thinkingLevel: args.thinkingLevel });
    return Promise.resolve({ ok: true });
  });

  ipcMain.handle('chatea_agent_set_runtime_mode', (_e, args: ChateaAgentSetRuntimeModeArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'set_runtime_mode', chatId: args.chatId, mode: args.mode });
    return Promise.resolve({ ok: true });
  });

  ipcMain.handle('chatea_agent_set_thinking_level', (_e, args: ChateaAgentSetThinkingLevelArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'set_thinking_level', chatId: args.chatId, level: args.level });
    return Promise.resolve({ ok: true });
  });

  ipcMain.handle('chatea_agent_respond_approval', (_e, args: ChateaAgentRespondApprovalArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'respond_approval', chatId: args.chatId, requestId: args.requestId, decision: args.decision });
    return Promise.resolve({ ok: true });
  });

  ipcMain.handle('chatea_agent_list_checkpoints', (_e, _args: ChateaAgentListCheckpointsArgs): Promise<ChateaAgentCheckpointSummary[]> => {
    return Promise.resolve([]);
  });

  ipcMain.handle('chatea_agent_rollback', (_e, _args: ChateaAgentRollbackArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_fork', (_e, _args: ChateaAgentForkArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_close', async (_e, args: ChateaAgentCloseArgs): Promise<{ ok: boolean }> => {
    await closeChateaAgentSession(args.chatId);
    return { ok: true };
  });

  ipcMain.handle('chatea_agent_new_session', (_e, args: ChateaAgentNewSessionArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'new_session', chatId: args.chatId });
    return Promise.resolve({ ok: true });
  });

  ipcMain.handle('chatea_agent_cycle_model', (_e, args: ChateaAgentCycleModelArgs): Promise<{ ok: boolean }> => {
    sendCommand(args.chatId, { type: 'cycle_model', chatId: args.chatId, direction: args.direction });
    return Promise.resolve({ ok: true });
  });
}

export { disposeAllChateaAgentSessions };
