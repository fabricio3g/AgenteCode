import type { IpcMain, BrowserWindow } from 'electron';
import {
  detectChateaAgent,
  startChateaAgentSession,
  closeChateaAgentSession,
  disposeAllChateaAgentSessions,
  emitCodeAgentEvent,
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
  ipcMain.handle('chatea_agent_detect', (_e, args: ChateaAgentDetectArgs): Promise<ChateaAgentDetectResult> => {
    return detectChateaAgent(args);
  });

  ipcMain.handle('chatea_agent_start_session', async (_e, args: ChateaAgentStartSessionArgs): Promise<ChateaAgentStartSessionResult> => {
    const result = await startChateaAgentSession(args);
    emitCodeAgentEvent(getMainWindow(), { type: 'agent_start', chatId: args.chatId });
    return result;
  });

  ipcMain.handle('chatea_agent_prompt', async (_e, _args: ChateaAgentPromptArgs): Promise<{ ok: boolean }> => {
    // Stub: commit 2 will run the real agent loop.
    return { ok: false };
  });

  ipcMain.handle('chatea_agent_steer', (_e, _args: ChateaAgentSteerArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_follow_up', (_e, _args: ChateaAgentFollowUpArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_abort', (_e, _args: ChateaAgentAbortArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_compact', (_e, _args: ChateaAgentCompactArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_set_model', (_e, _args: ChateaAgentSetModelArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_set_runtime_mode', (_e, _args: ChateaAgentSetRuntimeModeArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_set_thinking_level', (_e, _args: ChateaAgentSetThinkingLevelArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_respond_approval', (_e, _args: ChateaAgentRespondApprovalArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
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

  ipcMain.handle('chatea_agent_new_session', (_e, _args: ChateaAgentNewSessionArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });

  ipcMain.handle('chatea_agent_cycle_model', (_e, _args: ChateaAgentCycleModelArgs): Promise<{ ok: boolean }> => {
    return Promise.resolve({ ok: false });
  });
}

export { disposeAllChateaAgentSessions };
