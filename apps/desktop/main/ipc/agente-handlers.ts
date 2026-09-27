// ── agente_* IPC handlers ──────────────────────────────────────────────
// The renderer's control surface for Code space agent sessions. Events flow
// back over the `code_agent_event` push channel (see event-bridge).

import type { IpcMain, BrowserWindow } from 'electron';
import {
  startSession,
  disposeAllSessions as disposeTsSessions,
  prompt,
  steer,
  followUp,
  abort,
  compact,
  setModel,
  setRuntimeMode,
  respondApproval,
  listCheckpoints,
  rollback,
  listExtensions,
  deleteSessionData,
  liveChatIds,
  setExtensionEnabled
} from '../agente/runtime.ts';
import { rustEngine } from '../agente/rust-engine.ts';
import { setMainWindowGetter } from '../agente/event-bridge.ts';
import type { AgenteRuntimeMode, AgenteStartSessionArgs, ApprovalDecision } from '../../shared/agente-protocol.ts';

type AgenteHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
};

/** The TypeScript engine (main/agente/runtime.ts). */
const tsEngine = {
  startSession,
  prompt,
  steer,
  followUp,
  abort,
  compact,
  setModel,
  setRuntimeMode,
  respondApproval,
  listCheckpoints,
  rollback
};

type Engine = typeof tsEngine;

/**
 * Which engine runs each Code chat: chosen when its session starts
 * (`agente.engine: "rust"` selects the Rust runtime) and kept for the chat's
 * life, so flipping the setting never splits a live chat across engines.
 */
const chatEngines = new Map<string, Engine>();

function engineFor(chatId: string): Engine {
  return chatEngines.get(chatId) ?? tsEngine;
}

export function registerAgenteHandlers({ ipcMain, getMainWindow }: AgenteHandlerDeps): void {
  setMainWindowGetter(getMainWindow);

  ipcMain.handle('agente_start_session', (_e, args: AgenteStartSessionArgs) => {
    const engine: Engine = rustEngine.selected() ? rustEngine : tsEngine;
    chatEngines.set(args.chatId, engine);
    return engine.startSession(args);
  });

  ipcMain.handle('agente_prompt', (_e, args: { chatId: string; text: string; images?: Array<{ data: string; mimeType: string }> }) =>
    engineFor(args.chatId).prompt(args.chatId, args.text, args.images)
  );

  ipcMain.handle('agente_steer', (_e, args: { chatId: string; text: string }) => engineFor(args.chatId).steer(args.chatId, args.text));
  ipcMain.handle('agente_follow_up', (_e, args: { chatId: string; text: string }) => engineFor(args.chatId).followUp(args.chatId, args.text));
  ipcMain.handle('agente_abort', (_e, args: { chatId: string }) => engineFor(args.chatId).abort(args.chatId));
  ipcMain.handle('agente_compact', (_e, args: { chatId: string; customInstructions?: string }) => engineFor(args.chatId).compact(args.chatId, args.customInstructions));

  ipcMain.handle('agente_set_model', (_e, args: { chatId: string; provider: string; model: string; thinkingLevel?: string }) =>
    engineFor(args.chatId).setModel(args.chatId, args.provider, args.model, args.thinkingLevel)
  );

  ipcMain.handle('agente_set_runtime_mode', (_e, args: { chatId: string; mode: AgenteRuntimeMode }) =>
    engineFor(args.chatId).setRuntimeMode(args.chatId, args.mode)
  );

  ipcMain.handle('agente_respond_approval', (_e, args: { chatId: string; requestId: string; decision: ApprovalDecision }) =>
    engineFor(args.chatId).respondApproval(args.chatId, args.requestId, args.decision)
  );

  ipcMain.handle('agente_list_checkpoints', (_e, args: { chatId: string; sessionId?: string }) =>
    engineFor(args.chatId).listCheckpoints(args.chatId, args.sessionId)
  );
  ipcMain.handle('agente_rollback', (_e, args: { chatId: string; turnIndex: number; sessionId?: string; projectRoot?: string }) =>
    engineFor(args.chatId).rollback(args.chatId, args.turnIndex, { sessionId: args.sessionId, projectRoot: args.projectRoot })
  );
  ipcMain.handle('agente_live_chats', () => [...liveChatIds(), ...rustEngine.liveChatIds()]);
  ipcMain.handle('agente_delete_session_data', (_e, args: { chatIds?: string[]; sessionIds?: string[] }) =>
    Promise.all([deleteSessionData(args ?? {}), rustEngine.deleteSessionData(args ?? {})]).then(([ts, rust]) => ({
      ok: ts.ok && rust.ok,
      removed: ts.removed + rust.removed
    }))
  );
  ipcMain.handle('agente_list_extensions', () => listExtensions());
  ipcMain.handle('agente_set_extension_enabled', (_e, args: { extensionId: string; enabled: boolean }) =>
    setExtensionEnabled(args.extensionId, args.enabled)
  );
}

export function disposeAgenteSessions(): void {
  disposeTsSessions();
  rustEngine.disposeAllSessions();
  chatEngines.clear();
}
