// ── Design space IPC ───────────────────────────────────────────────────
// The renderer asks; main owns the workspace. Every file tool lands in
// main/design/workspace.ts, which jails paths to <app data>/designs/<chatId>.

import fs from 'node:fs/promises';
import { runBlenderRequest } from '../design/blender.ts';
import path from 'node:path';
import { dialog, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { getAppPaths } from '../paths.ts';
import { renderDesign, renderPdf } from '../design/render.ts';
import { clampExportWidth, exportImageName, pngBytes } from '../design/export.ts';
import { setFlows } from '../design/flows.ts';
import { isDesignFileTool, runDesignFileTool } from '../design/tools.ts';
import { checkExportHtml, collectFiles, DesignPathError, ensureWorkspace, exportFileName, listVersions, promoteVariant, removePage, restore, snapshot, workspaceRoot } from '../design/workspace.ts';
import { buildHandoffBundle, checkHandoffPages, checkHandoffText, deliverToProject, designSlug } from '../design/handoff.ts';
import { runDesignSystemRequest } from '../design/systems.ts';
import { addReference, addReferenceFile, removeReference } from '../design/references.ts';
import type { DesignChangedEvent, DesignHandoffRequest, DesignHandoffResult, DesignManageRequest, DesignRenderRequest, DesignSystemRequest, DesignToolResult } from '../../shared/design.ts';

const designsRoot = () => path.join(getAppPaths().appData, 'designs');
const rootFor = (chatId: unknown) => ensureWorkspace(workspaceRoot(designsRoot(), chatId));

function changed(event: IpcMainInvokeEvent, chatId: string, paths: string[]) {
  if (!paths.length || event.sender.isDestroyed()) return;
  const payload: DesignChangedEvent = { chatId, paths };
  event.sender.send('design_changed', payload);
}

export function registerDesignHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('design_3d', runBlenderRequest);
  ipcMain.handle('design_tool', (event, args: { chatId?: unknown; name?: unknown; args?: Record<string, unknown> } = {}): DesignToolResult => {
    if (!isDesignFileTool(args.name)) return { ok: false, content: `Unknown design tool: ${String(args.name)}` };
    try {
      const result = runDesignFileTool(rootFor(args.chatId), args.name, args.args ?? {});
      if (result.changed) changed(event, args.chatId as string, result.changed);
      return result;
    } catch (error) {
      return { ok: false, content: error instanceof DesignPathError ? error.message : String(error) };
    }
  });

  ipcMain.handle('design_files', (_event, args: { chatId?: unknown } = {}) => collectFiles(rootFor(args.chatId)));

  ipcMain.handle('design_render', (_event, request: DesignRenderRequest) => renderDesign(request));

  ipcMain.handle('design_manage', async (event, request: DesignManageRequest) => {
    const root = rootFor(request?.chatId);
    switch (request.action) {
      case 'versions': return listVersions(root);
      case 'snapshot': return snapshot(root, request.label, request.auto);
      case 'restore': {
        const result = restore(root, request.version);
        changed(event, request.chatId, result.paths);
        return result;
      }
      case 'promote': {
        const result = promoteVariant(root, request.variant);
        changed(event, request.chatId, result.paths);
        return result;
      }
      case 'remove': {
        // A page or variant deleted from the board; removePage saves a version first.
        const result = removePage(root, request.page);
        changed(event, request.chatId, result.paths);
        return result;
      }
      case 'reveal': return shell.openPath(root);
      case 'add_reference': {
        // An image the user attached to a design message; main checks its bytes and the workspace limits.
        const result = addReference(root, request.name, request.data);
        if (!result.existed) changed(event, request.chatId, [result.path]);
        return result;
      }
      case 'pick_references': {
        const picked = await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
        });
        if (picked.canceled) return { added: [] as string[] };
        const added: string[] = [];
        let failed = 0;
        for (const file of picked.filePaths.slice(0, 8)) {
          try {
            const result = addReferenceFile(root, file);
            added.push(result.path);
          } catch { failed += 1; }
        }
        if (added.length) changed(event, request.chatId, added);
        return { added, failed };
      }
      case 'remove_reference': {
        const removed = removeReference(root, request.path);
        changed(event, request.chatId, [removed]);
        return { path: removed };
      }
      case 'set_flows': {
        const result = setFlows(root, request.links);
        changed(event, request.chatId, [result.path]);
        return result;
      }
      case 'export_png': {
        const html = checkExportHtml(request.html);
        const width = clampExportWidth(request.width);
        const shot = await renderDesign({ html, mode: 'screenshot', width, fullPage: true });
        if (!shot.ok) throw new Error(shot.error || 'The page could not be rendered.');
        const bytes = pngBytes(shot.png);
        const result = await dialog.showSaveDialog({ defaultPath: exportImageName(request.page, 'png', width), filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (result.canceled || !result.filePath) return { saved: false };
        await fs.writeFile(result.filePath, bytes);
        return { saved: true, path: result.filePath };
      }
      case 'export_pdf': {
        const html = checkExportHtml(request.html);
        const bytes = await renderPdf(html, request.width);
        const result = await dialog.showSaveDialog({ defaultPath: exportImageName(request.page, 'pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (result.canceled || !result.filePath) return { saved: false };
        await fs.writeFile(result.filePath, bytes);
        return { saved: true, path: result.filePath };
      }
      case 'export': {
        const html = checkExportHtml(request.html);
        const result = await dialog.showSaveDialog({
          defaultPath: exportFileName(request.page),
          filters: [{ name: 'HTML', extensions: ['html'] }]
        });
        if (result.canceled || !result.filePath) return { saved: false };
        await fs.writeFile(result.filePath, html, 'utf8');
        return { saved: true, path: result.filePath };
      }
      case 'open_external': {
        // One file per design, overwritten on each open, kept out of the workspace so the agent never sees it.
        const html = checkExportHtml(request.html);
        const dir = path.join(getAppPaths().appData, 'design-exports', request.chatId.replace(/[^A-Za-z0-9_-]/g, ''));
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, exportFileName(request.page));
        await fs.writeFile(file, html, 'utf8');
        const error = await shell.openPath(file);
        if (error) throw new Error(error);
        return { saved: true, path: file };
      }
      default: throw new Error('Unknown design action.');
    }
  });

  // Handoff: a bundle goes through a save dialog; a delivery writes into a project the user confirmed.
  ipcMain.handle('design_handoff', async (_event, request: DesignHandoffRequest): Promise<DesignHandoffResult> => {
    const root = rootFor(request?.chatId);
    const title = typeof request.title === 'string' ? request.title.slice(0, 120) : '';
    const handoff = checkHandoffText(request.handoff);
    if (request.action === 'deliver') return deliverToProject(root, request.projectRoot, title, handoff);
    if (request.action === 'bundle') {
      const pages = checkHandoffPages(request.pages);
      const result = await dialog.showSaveDialog({
        defaultPath: `${designSlug(title)}-handoff.zip`,
        filters: [{ name: 'Zip', extensions: ['zip'] }]
      });
      if (result.canceled || !result.filePath) return { saved: false };
      await fs.writeFile(result.filePath, await buildHandoffBundle(root, handoff, pages));
      return { saved: true, path: result.filePath };
    }
    throw new Error('Unknown handoff action.');
  });

  // Design systems: a library under app data. The renderer names a system or a design; main resolves every path.
  ipcMain.handle('design_systems', (event, request: DesignSystemRequest) => runDesignSystemRequest(request, {
    systemsRoot: path.join(getAppPaths().appData, 'design-systems'),
    designsRoot: designsRoot(),
    changed: (chatId, paths) => changed(event, chatId, paths),
    pickFolder: async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  }));
}
