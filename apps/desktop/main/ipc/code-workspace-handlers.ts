// ── Code space panes: terminal, background processes, changes ──────────

import { BrowserWindow, type IpcMain } from 'electron';
import { createTerminal, killAllTerminals, killTerminal, resizeTerminal, writeTerminal } from '../terminal.ts';
import { processRegistry, type ProcessEvent } from '../agente/processes.ts';
import { fileDiff, listChanges, revertFile } from '../agente/changes.ts';
import { branchState, switchBranch } from '../agente/git-branches.ts';
import { openInEditor } from '../agente/open-editor.ts';
import { revealPath, trashPath } from '../agente/reveal.ts';
import { rustProcesses } from '../agente/rust-engine.ts';
import { isRustProcessId } from '../agente/rust-processes.ts';

function broadcast(event: ProcessEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('code_process_event', event);
  }
}

type ChangesArgs = { chatId: string; projectRoot: string };

export function registerCodeWorkspaceHandlers(ipcMain: IpcMain): void {
  processRegistry.onEvent(broadcast);
  rustProcesses.onEvent(broadcast);

  ipcMain.handle('terminal_create', (event, args: { cwd?: string; cols?: number; rows?: number }) =>
    createTerminal(event.sender, args ?? {})
  );
  ipcMain.handle('terminal_write', (_e, args: { id: string; data: string }) => writeTerminal(args.id, args.data));
  ipcMain.handle('terminal_resize', (_e, args: { id: string; cols: number; rows: number }) => resizeTerminal(args.id, args.cols, args.rows));
  ipcMain.handle('terminal_kill', (_e, args: { id: string }) => killTerminal(args.id));

  // Processes of Rust-engine chats live in the runtime (rs- ids).
  ipcMain.handle('agente_process_list', (_e, args: { chatId?: string }) => [
    ...processRegistry.list(args?.chatId),
    ...rustProcesses.list(args?.chatId)
  ]);
  ipcMain.handle('agente_process_output', (_e, args: { id: string }) =>
    isRustProcessId(args.id) ? rustProcesses.output(args.id) : (processRegistry.output(args.id) ?? '')
  );
  ipcMain.handle('agente_process_start', (_e, args: { chatId: string; command: string; cwd: string }) => processRegistry.start(args));
  ipcMain.handle('agente_process_stop', (_e, args: { id: string }) =>
    isRustProcessId(args.id) ? rustProcesses.stop(args.id) : processRegistry.stop(args.id)
  );
  ipcMain.handle('agente_process_clear', (_e, args: { chatId?: string }) => processRegistry.prune(args?.chatId));

  ipcMain.handle('agente_changes', (_e, args: ChangesArgs) =>
    listChanges(args.projectRoot)
  );
  ipcMain.handle('agente_file_diff', (_e, args: ChangesArgs & { path: string }) =>
    fileDiff(args.projectRoot, args.path)
  );
  ipcMain.handle('agente_revert_file', async (_e, args: ChangesArgs & { path: string }) => {
    try {
      await revertFile(args.projectRoot, args.path);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agente_git_branches', (_e, args: { projectRoot: string }) =>
    branchState(args.projectRoot)
  );
  ipcMain.handle('agente_git_switch_branch', (_e, args: { projectRoot: string; name: string; create?: boolean }) =>
    switchBranch(args.projectRoot, args.name, args.create === true)
  );
  ipcMain.handle('agente_open_in_editor', (_e, args: { projectRoot: string; path: string; line?: number; editor?: string }) =>
    openInEditor(args)
  );
  ipcMain.handle('agente_reveal_path', (_e, args: { projectRoot: string; path: string }) =>
    revealPath(args.projectRoot, args.path)
  );
  ipcMain.handle('agente_trash_path', (_e, args: { projectRoot: string; path: string }) =>
    trashPath(args.projectRoot, args.path)
  );
}

export function disposeCodeWorkspace(): void {
  killAllTerminals();
  processRegistry.killAll();
}
