// ── agente_* IPC handlers ──────────────────────────────────────────────
// The renderer's control surface for Code space agent sessions. Events flow
// back over the `code_agent_event` push channel (see event-bridge). Every
// Code chat runs on the Rust runtime (`agente serve`, see rust-engine).

import { nativeImage, type IpcMain, type BrowserWindow } from 'electron';
import { registerHomeRuntimeHandlers } from '../agente/home-runtime.ts';
import { registerComplementsHandlers } from '../agente/complements.ts';
import { registerCalendarSyncHandlers } from '../calendar/sync.ts';
import { registerSessionGoals } from '../session-goals.ts';
import { modelSeesImages, rustEngine as engine } from '../agente/rust-engine.ts';
import { setMainWindowGetter } from '../agente/event-bridge.ts';
import { historyTurns } from '../agente/bot-history.ts';
import type { Attachment, DriverInstanceConfig, SessionSnapshot, SessionWorktree } from '../../shared/agente-protocol.gen.ts';
import type { AgenteRuntimeMode, AgenteStartSessionArgs, ApprovalDecision, SubagentSettings } from '../../shared/agente-protocol.ts';

type AgenteHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
};

export function registerAgenteHandlers({ ipcMain, getMainWindow }: AgenteHandlerDeps): void {
  setMainWindowGetter(getMainWindow);
  registerHomeRuntimeHandlers(ipcMain);
  registerComplementsHandlers(ipcMain);
  registerCalendarSyncHandlers(ipcMain);

  ipcMain.handle('agente_start_session', (event, args: AgenteStartSessionArgs) => engine.startSession(args, event.sender));

  ipcMain.handle('agente_prompt', (event, args: { chatId: string; text: string; images?: Array<{ data: string; mimeType: string }>; attachments?: Attachment[] }) =>
    engine.prompt(args.chatId, args.text, args.images, args.attachments, event.sender)
  );

  ipcMain.handle('agente_steer', (_e, args: { chatId: string; text: string; attachments?: Attachment[] }) => engine.steer(args.chatId, args.text, args.attachments));
  ipcMain.handle('agente_follow_up', (_e, args: { chatId: string; text: string; attachments?: Attachment[] }) => engine.followUp(args.chatId, args.text, args.attachments));
  ipcMain.handle('agente_abort', (_e, args: { chatId: string }) => engine.abort(args.chatId));
  ipcMain.handle('agente_compact', (_e, args: { chatId: string; smart?: boolean }) => engine.compact(args.chatId, args.smart));
  ipcMain.handle('model_sees_images', (_e, args: { providerName: string; model: string }) => modelSeesImages(args.providerName, args.model));

  ipcMain.handle('agente_set_model', (_e, args: { chatId: string; provider: string; model: string; thinkingLevel?: string; localSelection?: import('../../shared/agente-protocol.ts').LocalModelSelection }) =>
    engine.setModel(args.chatId, args.provider, args.model, args.thinkingLevel, args.localSelection)
  );

  ipcMain.handle('agente_set_runtime_mode', (_e, args: { chatId: string; mode: AgenteRuntimeMode }) =>
    engine.setRuntimeMode(args.chatId, args.mode)
  );

  ipcMain.handle('agente_respond_approval', (_e, args: { chatId: string; requestId: string; decision: ApprovalDecision; optionId?: string }) =>
    engine.respondApproval(args.chatId, args.requestId, args.decision, args.optionId)
  );
  ipcMain.handle('agente_respond_input', (_e, args: { chatId: string; requestId: string; action: import('../../shared/agente-protocol.ts').InputResponseAction; content?: Record<string, unknown> }) =>
    engine.respondInput(args.chatId, args.requestId, args.action, args.content)
  );

  ipcMain.handle('agente_list_checkpoints', (_e, args: { chatId: string; sessionId?: string }) =>
    engine.listCheckpoints(args.chatId, args.sessionId)
  );
  ipcMain.handle('agente_rollback', (_e, args: { chatId: string; turnIndex: number; sessionId?: string; projectRoot?: string }) =>
    engine.rollback(args.chatId, args.turnIndex, { sessionId: args.sessionId, projectRoot: args.projectRoot })
  );
  ipcMain.handle('agente_exec', (_e, args: { chatId: string; command: string }) => engine.exec(args.chatId, args.command));
  ipcMain.handle('agente_undo', (_e, args: { chatId: string }) => engine.edits(args.chatId, 'undo'));
  ipcMain.handle('agente_redo', (_e, args: { chatId: string }) => engine.edits(args.chatId, 'redo'));
  ipcMain.handle('agente_project_info', (_e, args: { projectRoot: string }) => engine.runtimeRequest('project.info', { project_dir: args.projectRoot }));
  ipcMain.handle('agente_project_init', (_e, args: { projectRoot: string }) => engine.runtimeRequest('project.init', { project_dir: args.projectRoot }));
  ipcMain.handle('agente_mcp_status', (_e, args?: { projectRoot?: string }) => engine.runtimeRequest('mcp.status', args?.projectRoot ? { project_dir: args.projectRoot } : {}));
  ipcMain.handle('agente_mcp_control', async (_e, args: { projectRoot: string; name: string; action: string }) => {
    const result = await engine.runtimeRequest('mcp.control', { project_dir: args.projectRoot, name: args.name, action: args.action });
    if (args.action === 'approve') {
      const settings = await engine.runtimeRequest<{ approved_mcp_servers: string[] }>('runtime.settings');
      await engine.configureSettings({ approved_mcp_servers: settings.approved_mcp_servers });
    }
    return result;
  });
  ipcMain.handle('agente_project_files', async (_e, args: { projectRoot: string }) => {
    const res = await engine.runtimeRequest<{ files?: string[] }>('project.files', { project_dir: args.projectRoot });
    return Array.isArray(res?.files) ? res.files : [];
  });
  ipcMain.handle('agente_message_action', (_e, args: { chatId: string; action: 'fork' | 'rewind'; conversationIndex: number }) => engine.messageAction(args.chatId, args.action, args.conversationIndex));
  ipcMain.handle('agente_session_snapshot', (_e, args: { sessionId: string }) => engine.runtimeRequest('session.get', { session_id: args.sessionId }));
  registerSessionGoals(ipcMain, async () => { const { runtimeConnection } = await import('../agente/rust-engine.ts'); return runtimeConnection(); });
  ipcMain.handle('agente_session_list', () => engine.runtimeRequest('session.list'));
  ipcMain.handle('agente_session_history', async (_e, args: { sessionId: string; chatId: string }) => {
    const { snapshot } = await engine.runtimeRequest<{ snapshot: SessionSnapshot }>('session.get', { session_id: args.sessionId });
    return historyTurns(snapshot.conversation, args.chatId);
  });
  ipcMain.handle('agente_subagent_settings', (_e, args: SubagentSettings) => engine.subagentSettings(args));
  // Swarm mode: the session's board and its switch (`agente_core::swarm`).
  ipcMain.handle('agente_board', (_e, args: { sessionId: string; action: 'get' | 'enable' | 'disable' | 'clear' }) => {
    const session_id = args.sessionId;
    if (args.action === 'get') return engine.runtimeRequest('board.get', { session_id });
    if (args.action === 'clear') return engine.runtimeRequest('board.clear', { session_id });
    return engine.runtimeRequest('board.enable', { session_id, enabled: args.action === 'enable' });
  });
  ipcMain.handle('agente_runtime_configure', (_e, args: Record<string, unknown>) => engine.configureSettings(args));
  const previews = new Map<string, string>();
  ipcMain.handle('agente_media_preview', async (_e, args: { path: string; maxSize?: number }) => {
    const maxSize = Math.max(16, Math.min(4096, Math.trunc(args.maxSize) || 112));
    const cacheKey = `${args.path}:${maxSize}`;
    if (previews.has(cacheKey)) return previews.get(cacheKey);
    const { path } = await engine.runtimeRequest<{ path: string }>('media.preview_path', args);
    const source = nativeImage.createFromPath(path);
    if (source.isEmpty()) return null;
    const { width, height } = source.getSize();
    // Attachment chips want a 112px thumbnail; the canvas panel annotates on the
    // real bitmap and asks for the largest edge it needs.
    const thumbnail = source.resize(width >= height ? { width: maxSize } : { height: maxSize }).toDataURL();
    if (previews.size >= 128) previews.delete(previews.keys().next().value!);
    previews.set(cacheKey, thumbnail);
    return thumbnail;
  });
  ipcMain.handle('agente_media_import' , (_e, args: Record<string, unknown>) => engine.runtimeRequest('media.import', args));
  ipcMain.handle('agente_runtime_settings', () => engine.runtimeRequest('runtime.settings'));
  ipcMain.handle('agente_model_inputs', (_e, args: { provider: string; model: string }) => engine.modelInputs(args.provider, args.model));
  ipcMain.handle('agente_child_cancel', (_e, args: { runId: string }) => engine.runtimeRequest('children.cancel', { run_id: args.runId }));
  ipcMain.handle('agente_live_chats', () => engine.liveChatIds());
  ipcMain.handle('agente_delete_session_data', (_e, args: { chatIds?: string[]; sessionIds?: string[] }) => engine.deleteSessionData(args ?? {}));

  ipcMain.handle('agente_drivers_list', (_e, args?: { probe?: boolean }) =>
    engine.runtimeRequest('drivers.list', { probe: !!args?.probe })
  );
  ipcMain.handle('agente_drivers_probe', (_e, args?: { instanceId?: string }) =>
    engine.runtimeRequest('drivers.probe', args?.instanceId ? { instance_id: args.instanceId } : {})
  );
  ipcMain.handle('agente_drivers_save', (_e, args: { instanceId: string; config: DriverInstanceConfig }) =>
    engine.runtimeRequest('drivers.instances.save', { instance_id: args.instanceId, config: args.config })
  );
  ipcMain.handle('agente_drivers_delete', (_e, args: { instanceId: string }) =>
    engine.runtimeRequest('drivers.instances.delete', { instance_id: args.instanceId })
  );

  ipcMain.handle('agente_worktree_create', (_e, args: { projectRoot: string; label?: string; sessionId?: string }) =>
    engine.runtimeRequest('worktree.create', {
      project_dir: args.projectRoot,
      ...(args.label ? { label: args.label } : {}),
      ...(args.sessionId ? { session_id: args.sessionId } : {})
    })
  );
  ipcMain.handle('agente_worktree_list', (_e, args: { projectRoot: string }) =>
    engine.runtimeRequest('worktree.list', { project_dir: args.projectRoot })
  );
  ipcMain.handle('agente_worktree_merge', (_e, args: {
    repoRoot: string;
    path: string;
    branch?: string;
    baseCommit?: string;
    commitMessage?: string;
    removeAfter?: boolean;
  }) =>
    engine.runtimeRequest('worktree.merge', {
      repo_root: args.repoRoot,
      path: args.path,
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.baseCommit ? { base_commit: args.baseCommit } : {}),
      ...(args.commitMessage ? { commit_message: args.commitMessage } : {}),
      remove_after: !!args.removeAfter
    })
  );
  ipcMain.handle('agente_worktree_remove', (_e, args: {
    repoRoot: string;
    path: string;
    branch?: string;
    baseCommit?: string;
    sessionId?: string;
  }) =>
    engine.runtimeRequest('worktree.remove', {
      repo_root: args.repoRoot,
      path: args.path,
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.baseCommit ? { base_commit: args.baseCommit } : {}),
      ...(args.sessionId ? { session_id: args.sessionId } : {})
    })
  );
  ipcMain.handle('agente_set_worktree', (_e, args: { chatId: string; worktree: SessionWorktree | null }) =>
    engine.setWorktree(args.chatId, args.worktree)
  );

  ipcMain.handle('agente_orchestrator_status', () => engine.runtimeRequest('orchestrator.status', {}));
  ipcMain.handle('agente_orchestrator_tasks', (_e, args?: { parentSessionId?: string }) =>
    engine.runtimeRequest('orchestrator.tasks', args?.parentSessionId ? { parent_session_id: args.parentSessionId } : {})
  );
}

export function disposeAgenteSessions(): void {
  engine.disposeAllSessions();
}
