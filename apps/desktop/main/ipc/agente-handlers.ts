// ── agente_* IPC handlers ──────────────────────────────────────────────
// The renderer's control surface for Code space agent sessions. Events flow
// back over the `code_agent_event` push channel (see event-bridge). Every
// Code chat runs on the Rust runtime (`agente serve`, see rust-engine).

import type { IpcMain, BrowserWindow } from 'electron';
import { rustEngine as engine } from '../agente/rust-engine.ts';
import { setMainWindowGetter } from '../agente/event-bridge.ts';
import type { AgenteRuntimeMode, AgenteStartSessionArgs, ApprovalDecision } from '../../shared/agente-protocol.ts';

type AgenteHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
};

export function registerAgenteHandlers({ ipcMain, getMainWindow }: AgenteHandlerDeps): void {
  setMainWindowGetter(getMainWindow);

  ipcMain.handle('agente_start_session', (_e, args: AgenteStartSessionArgs) => engine.startSession(args));

  ipcMain.handle('agente_prompt', (_e, args: { chatId: string; text: string; images?: Array<{ data: string; mimeType: string }> }) =>
    engine.prompt(args.chatId, args.text, args.images)
  );

  ipcMain.handle('agente_steer', (_e, args: { chatId: string; text: string }) => engine.steer(args.chatId, args.text));
  ipcMain.handle('agente_follow_up', (_e, args: { chatId: string; text: string }) => engine.followUp(args.chatId, args.text));
  ipcMain.handle('agente_abort', (_e, args: { chatId: string }) => engine.abort(args.chatId));
  ipcMain.handle('agente_compact', (_e, args: { chatId: string; customInstructions?: string }) => engine.compact(args.chatId, args.customInstructions));

  ipcMain.handle('agente_set_model', (_e, args: { chatId: string; provider: string; model: string; thinkingLevel?: string }) =>
    engine.setModel(args.chatId, args.provider, args.model, args.thinkingLevel)
  );

  ipcMain.handle('agente_set_runtime_mode', (_e, args: { chatId: string; mode: AgenteRuntimeMode }) =>
    engine.setRuntimeMode(args.chatId, args.mode)
  );

  ipcMain.handle('agente_respond_approval', (_e, args: { chatId: string; requestId: string; decision: ApprovalDecision }) =>
    engine.respondApproval(args.chatId, args.requestId, args.decision)
  );

  ipcMain.handle('agente_list_checkpoints', (_e, args: { chatId: string; sessionId?: string }) =>
    engine.listCheckpoints(args.chatId, args.sessionId)
  );
  ipcMain.handle('agente_rollback', (_e, args: { chatId: string; turnIndex: number; sessionId?: string; projectRoot?: string }) =>
    engine.rollback(args.chatId, args.turnIndex, { sessionId: args.sessionId, projectRoot: args.projectRoot })
  );
  ipcMain.handle('agente_live_chats', () => engine.liveChatIds());
  ipcMain.handle('agente_delete_session_data', (_e, args: { chatIds?: string[]; sessionIds?: string[] }) => engine.deleteSessionData(args ?? {}));
}

export function disposeAgenteSessions(): void {
  engine.disposeAllSessions();
}
