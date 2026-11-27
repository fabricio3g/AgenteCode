import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { withBrowserScope } from '../browser-panel.ts';
import type { ErrorMessageFn } from './types.ts';

type SearchHandlerDeps = {
  ipcMain: IpcMain;
  shell: { openExternal: (url: string) => unknown };
  getMainWindow: () => BrowserWindow | null;
  webSearch: (args: unknown, win: BrowserWindow | null) => unknown;
  searchHfModels: (query: string, sort: string, limit: number, hfToken?: string, cursor?: string, paged?: boolean) => unknown;
  hfRepoGguf: (repoId: string, hfToken?: string) => unknown;
  fetchHfReadme: (repoId: string, hfToken?: string) => unknown;
  createWebviewerWindow: (url: string, title?: string) => unknown;
  scrapeUrlStructured: (args: { url: string; maxLength?: number; timeoutMs?: number; maxLinks?: number }) => Promise<unknown>;
  fetchLinkPreview: (url: string) => Promise<unknown>;
  crawlWeb: (args: unknown) => unknown;
  getAggregatorCatalog: () => unknown;
  probeAggregatorEngines: (engineIds: unknown, options?: Record<string, unknown>, query?: string) => unknown;
  toErrorMessage: ErrorMessageFn;
};

export function registerSearchHandlers({
  ipcMain,
  shell,
  getMainWindow,
  webSearch,
  searchHfModels,
  hfRepoGguf,
  fetchHfReadme,
  createWebviewerWindow,
  scrapeUrlStructured,
  fetchLinkPreview,
  crawlWeb,
  getAggregatorCatalog,
  probeAggregatorEngines,
  toErrorMessage,
}: SearchHandlerDeps): void {
  const activeOperations = new Map<string, { controller: AbortController; senderId: number }>();
  const trackedSenders = new Set<number>();

  const trackSender = (sender: WebContents) => {
    const senderId = sender.id;
    if (trackedSenders.has(senderId)) return;
    trackedSenders.add(senderId);
    const cleanup = () => {
      trackedSenders.delete(senderId);
      for (const [id, entry] of activeOperations) {
        if (entry.senderId === senderId) {
          activeOperations.delete(id);
          entry.controller.abort();
        }
      }
    };
    sender.once('destroyed', cleanup);
    sender.once('render-process-gone', cleanup);
  };

  const beginOperation = (event: IpcMainInvokeEvent, args: unknown) => {
    const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const operationId = typeof record.operationId === 'string' && record.operationId.trim()
      ? record.operationId.trim()
      : undefined;
    const controller = new AbortController();
    if (operationId) {
      trackSender(event.sender);
      activeOperations.get(operationId)?.controller.abort();
      activeOperations.set(operationId, { controller, senderId: event.sender.id });
    }
    return {
      record,
      operationId,
      controller,
      finish: () => {
        if (operationId && activeOperations.get(operationId)?.controller === controller) {
          activeOperations.delete(operationId);
        }
      }
    };
  };

  ipcMain.handle('web_search', async (event, args) => {
    const op = beginOperation(event, args);
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    try {
      return await webSearch({
        ...op.record,
        ...(op.operationId ? { operationId: op.operationId } : {}),
        signal: op.controller.signal
      }, win);
    } finally {
      op.finish();
    }
  });
  ipcMain.handle('search_cancel', (_event, args: { operationId?: unknown; operationIds?: unknown } = {}) => {
    const ids: string[] = [];
    if (typeof args?.operationId === 'string' && args.operationId.trim()) ids.push(args.operationId.trim());
    if (Array.isArray(args?.operationIds)) {
      for (const id of args.operationIds) {
        if (typeof id === 'string' && id.trim()) ids.push(id.trim());
      }
    }
    let cancelled = 0;
    for (const id of ids) {
      const entry = activeOperations.get(id);
      if (!entry) continue;
      activeOperations.delete(id);
      entry.controller.abort();
      cancelled += 1;
    }
    return { cancelled };
  });
  ipcMain.handle('search:get-catalog', () => getAggregatorCatalog());
  ipcMain.handle('search:probe-engines', (_e, args: { engine_ids?: unknown; options?: Record<string, unknown>; query?: string } = {}) =>
    probeAggregatorEngines(args.engine_ids, args.options || {}, args.query));
  ipcMain.handle('search_hf_models', (_e, { query, sort, limit, hfToken, cursor, paged }) =>
    searchHfModels(query, sort, limit, hfToken, cursor, paged));
  ipcMain.handle('hf_repo_gguf', (_e, { repoId, hfToken }) => hfRepoGguf(repoId, hfToken));
  ipcMain.handle('fetch_hf_readme', (_e, { repoId, hfToken }) => fetchHfReadme(repoId, hfToken));
  ipcMain.handle('open_url_window', (_e, { url }) => {
    try {
      const parsed = new URL(String(url || ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: 'Invalid URL scheme' };
      }
      return shell.openExternal(parsed.toString());
    } catch {
      return { error: 'Invalid URL' };
    }
  });

  ipcMain.handle('open_webviewer', (_e, { url, title, scope }) => {
    if (!url || typeof url !== 'string') return { error: 'Invalid URL' };
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { error: 'Invalid URL scheme' };
    }
    try {
      withBrowserScope(scope, () => createWebviewerWindow(url, title || 'Web Viewer'));
      return { success: true };
    } catch (err: unknown) {
      return { error: toErrorMessage(err) };
    }
  });

  ipcMain.handle('fetch_url_content', async (_e, { url, maxBytes }) => {
    try {
      return await scrapeUrlStructured({
        url,
        maxLength: maxBytes,
        timeoutMs: 15000,
        maxLinks: 150,
      });
    } catch (err: unknown) {
      return { url: String(url), content: '', error: toErrorMessage(err), status: 0 };
    }
  });

  ipcMain.handle('link_preview', (_e, args: { url?: string } = {}) =>
    fetchLinkPreview(String(args?.url ?? '')));

  ipcMain.handle('crawl_web', async (event, args) => {
    const op = beginOperation(event, args);
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    try {
      return await crawlWeb({
        ...op.record,
        signal: op.controller.signal,
        emit: (step: string, detail: string) => {
          if (op.controller.signal.aborted) return;
          try {
            win?.webContents?.send('search-progress', {
              step,
              detail,
              ...(op.operationId ? { operationId: op.operationId } : {})
            });
          } catch {
            // ignore renderer channel errors
          }
        }
      });
    } finally {
      op.finish();
    }
  });
}
