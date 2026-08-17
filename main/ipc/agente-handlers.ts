// ── agente_* IPC handlers ──────────────────────────────────────────────
// The renderer's control surface for Agente Coding sessions. Events flow
// back over the `code_agent_event` push channel (see event-bridge).

import type { IpcMain, BrowserWindow } from 'electron';
import {
  startSession,
  closeSession,
  disposeAllSessions,
  prompt,
  steer,
  followUp,
  abort,
  compact,
  setModel,
  cycleModel,
  setRuntimeMode,
  respondApproval,
  listCheckpoints,
  rollback,
  newSession,
  listSessions,
  listExtensions,
  setExtensionEnabled
} from '../agente/runtime.ts';
import { setMainWindowGetter } from '../agente/event-bridge.ts';
import type { AgenteRuntimeMode, AgenteStartSessionArgs, ApprovalDecision } from '../../shared/agente-protocol.ts';

type AgenteHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
};

export function registerAgenteHandlers({ ipcMain, getMainWindow }: AgenteHandlerDeps): void {
  setMainWindowGetter(getMainWindow);

  ipcMain.handle('agente_detect', () => Promise.resolve({ status: 'ready' as const }));

  ipcMain.handle('agente_start_session', (_e, args: AgenteStartSessionArgs) => startSession(args));

  ipcMain.handle('agente_prompt', (_e, args: { chatId: string; text: string; images?: Array<{ data: string; mimeType: string }> }) =>
    prompt(args.chatId, args.text, args.images)
  );

  ipcMain.handle('agente_steer', (_e, args: { chatId: string; text: string }) => steer(args.chatId, args.text));
  ipcMain.handle('agente_follow_up', (_e, args: { chatId: string; text: string }) => followUp(args.chatId, args.text));
  ipcMain.handle('agente_abort', (_e, args: { chatId: string }) => abort(args.chatId));
  ipcMain.handle('agente_compact', (_e, args: { chatId: string; customInstructions?: string }) => compact(args.chatId, args.customInstructions));

  ipcMain.handle('agente_set_model', (_e, args: { chatId: string; provider: string; model: string; thinkingLevel?: string }) =>
    setModel(args.chatId, args.provider, args.model, args.thinkingLevel)
  );

  ipcMain.handle('agente_set_runtime_mode', (_e, args: { chatId: string; mode: AgenteRuntimeMode }) =>
    setRuntimeMode(args.chatId, args.mode)
  );

  ipcMain.handle('agente_respond_approval', (_e, args: { chatId: string; requestId: string; decision: ApprovalDecision }) =>
    respondApproval(args.chatId, args.requestId, args.decision)
  );

  ipcMain.handle('agente_list_checkpoints', (_e, args: { chatId: string }) => listCheckpoints(args.chatId));
  ipcMain.handle('agente_rollback', (_e, args: { chatId: string; turnIndex: number }) => rollback(args.chatId, args.turnIndex));
  ipcMain.handle('agente_close', (_e, args: { chatId: string }) => closeSession(args.chatId));
  ipcMain.handle('agente_new_session', (_e, args: { chatId: string }) => newSession(args.chatId));
  ipcMain.handle('agente_cycle_model', () => cycleModel());
  ipcMain.handle('agente_list_sessions', (_e, args: { projectRoot: string }) => listSessions(args.projectRoot));
  ipcMain.handle('agente_list_extensions', () => listExtensions());
  ipcMain.handle('agente_set_extension_enabled', (_e, args: { extensionId: string; enabled: boolean }) =>
    setExtensionEnabled(args.extensionId, args.enabled)
  );
}

export { disposeAllSessions };
