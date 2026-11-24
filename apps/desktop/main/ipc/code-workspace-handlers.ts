// ── Code space panes: terminal, background processes, changes ──────────
// Background processes and git operations live in the Rust daemon (`agente serve`);
// Electron only forwards IPC and native OS actions (terminal, open editor, reveal/trash).

import { BrowserWindow, type IpcMain } from 'electron';
import type { ChangeList, FileDiff, GitBranches, ProcessEvent, PullRequestState, SwitchBranchResult } from '../../shared/code-workspace.ts';
import { createTerminal, killAllTerminals, killTerminal, resizeTerminal, writeTerminal } from '../terminal.ts';
import { openInEditor } from '../agente/open-editor.ts';
import { revealPath, trashPath } from '../agente/reveal.ts';
import { runtimeConnection, rustProcesses } from '../agente/rust-engine.ts';

function broadcast(event: ProcessEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('code_process_event', event);
  }
}

async function daemonGit<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const client = await runtimeConnection();
  return client.request<T>(method, params);
}

type ChangesArgs = { chatId: string; projectRoot: string };

export function registerCodeWorkspaceHandlers(ipcMain: IpcMain): void {
  rustProcesses.onEvent(broadcast);

  ipcMain.handle('terminal_create', (event, args: { cwd?: string; cols?: number; rows?: number }) =>
    createTerminal(event.sender, args ?? {})
  );
  ipcMain.handle('terminal_write', (_e, args: { id: string; data: string }) => writeTerminal(args.id, args.data));
  ipcMain.handle('terminal_resize', (_e, args: { id: string; cols: number; rows: number }) => resizeTerminal(args.id, args.cols, args.rows));
  ipcMain.handle('terminal_kill', (_e, args: { id: string }) => killTerminal(args.id));

  ipcMain.handle('agente_process_list', (_e, args: { chatId?: string }) =>
    rustProcesses.list(args?.chatId)
  );
  ipcMain.handle('agente_process_output', (_e, args: { id: string }) =>
    rustProcesses.output(args.id)
  );
  ipcMain.handle('agente_process_start', async (_e, args: { chatId: string; command: string; cwd: string }) => {
    const started = await rustProcesses.start(args);
    if (!started) throw new Error('Rust runtime is unavailable to start background processes.');
    return started;
  });
  ipcMain.handle('agente_process_stop', (_e, args: { id: string }) =>
    rustProcesses.stop(args.id)
  );
  ipcMain.handle('agente_process_clear', (_e, args: { chatId?: string }) =>
    rustProcesses.prune(args?.chatId)
  );

  ipcMain.handle('agente_changes', async (_e, args: ChangesArgs): Promise<ChangeList> =>
    daemonGit<ChangeList>('git.changes', { project_dir: args.projectRoot }).catch(() => ({ source: 'none', files: [] }))
  );
  ipcMain.handle('agente_file_diff', (_e, args: ChangesArgs & { path: string }): Promise<FileDiff> =>
    daemonGit<FileDiff>('git.diff', { project_dir: args.projectRoot, path: args.path })
  );
  ipcMain.handle('agente_revert_file', async (_e, args: ChangesArgs & { path: string }) => {
    try {
      await daemonGit('git.revert', { project_dir: args.projectRoot, path: args.path });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agente_git_branches', async (_e, args: { projectRoot: string }): Promise<GitBranches> =>
    daemonGit<GitBranches>('git.branches', { project_dir: args.projectRoot })
      .catch(() => ({ source: 'none', current: null, detached: false, dirty: false, branches: [] }))
  );
  ipcMain.handle('agente_git_pull_request', async (_e, args: { projectRoot: string }): Promise<PullRequestState> =>
    daemonGit<PullRequestState>('git.pull_request', { project_dir: args.projectRoot })
      .catch(() => ({ source: 'none', branch: null, base: null, ahead: 0, compareUrl: null, pr: null }))
  );
  ipcMain.handle('agente_git_switch_branch', async (_e, args: { projectRoot: string; name: string; create?: boolean }): Promise<SwitchBranchResult> => {
    try {
      return await daemonGit<SwitchBranchResult>('git.switch_branch', {
        project_dir: args.projectRoot,
        branch: args.name,
        create: args.create === true
      });
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

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
}
