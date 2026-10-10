// ── Design research IPC ────────────────────────────────────────────────
// `design_reference` reads a public page in a private window and answers with
// its tokens; `design_view` hands the agent one image from the workspace. Both
// resolve every path in main, the same way the rest of the Design space does.

import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { getAppPaths } from '../paths.ts';
import { runDesignReference } from '../design/reference.ts';
import { readReferenceImage } from '../design/references.ts';
import { ensureWorkspace, workspaceRoot } from '../design/workspace.ts';
import type { DesignChangedEvent, DesignImageResult, DesignReferenceRequest, DesignReferenceResult } from '../../shared/design.ts';

const designsRoot = () => path.join(getAppPaths().appData, 'designs');
const systemsRoot = () => path.join(getAppPaths().appData, 'design-systems');
const rootFor = (chatId: unknown) => ensureWorkspace(workspaceRoot(designsRoot(), chatId));

export function registerDesignReferenceHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('design_reference', async (event: IpcMainInvokeEvent, request: DesignReferenceRequest): Promise<DesignReferenceResult> => {
    const root = rootFor(request?.chatId);
    const result = await runDesignReference(request, { root, systemsRoot: systemsRoot() });
    if (result.saved && !event.sender.isDestroyed()) {
      const payload: DesignChangedEvent = { chatId: request.chatId, paths: [result.saved] };
      event.sender.send('design_changed', payload);
    }
    return result;
  });

  ipcMain.handle('design_view', (_event, request: { chatId?: unknown; path?: unknown } = {}): DesignImageResult =>
    readReferenceImage(rootFor(request.chatId), request.path)
  );
}
