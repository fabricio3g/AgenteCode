import type { IpcMain, BrowserWindow } from 'electron';
import type { ErrorMessageFn } from './types.ts';

type SearchHandlerDeps = {
  ipcMain: IpcMain;
  shell: { openExternal: (url: string) => unknown };
  getMainWindow: () => BrowserWindow | null;
  webSearch: (args: unknown, win: BrowserWindow | null) => unknown;
  ingestSearchContext: (chatId: string, context: string, sources: unknown) => unknown;
  fetchModelCatalog: () => unknown;
  searchHfModels: (query: string, sort: string, limit: number) => unknown;
  hfRepoGguf: (repoId: string) => unknown;
  createWebviewerWindow: (url: string, title?: string) => unknown;
  scrapeUrlStructured: (args: { url: string; maxLength?: number; timeoutMs?: number; maxLinks?: number }) => Promise<unknown>;
  crawlWeb: (args: unknown) => unknown;
  toErrorMessage: ErrorMessageFn;
};

export function registerSearchHandlers({
  ipcMain,
  shell,
  getMainWindow,
  webSearch,
  ingestSearchContext,
  fetchModelCatalog,
  searchHfModels,
  hfRepoGguf,
  createWebviewerWindow,
  scrapeUrlStructured,
  crawlWeb,
  toErrorMessage,
}: SearchHandlerDeps): void {
  ipcMain.handle('web_search', (_e, args) => webSearch(args, getMainWindow()));
  ipcMain.handle('ingest_search_context', (_e, { chatId, context, sources }) => ingestSearchContext(chatId, context, sources));
  ipcMain.handle('fetch_model_catalog', () => fetchModelCatalog());
  ipcMain.handle('search_hf_models', (_e, { query, sort, limit }) => searchHfModels(query, sort, limit));
  ipcMain.handle('hf_repo_gguf', (_e, { repoId }) => hfRepoGguf(repoId));
  ipcMain.handle('open_url_window', (_e, { url }) => shell.openExternal(String(url || '')));

  ipcMain.handle('open_webviewer', (_e, { url, title }) => {
    if (!url || typeof url !== 'string') return { error: 'Invalid URL' };
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { error: 'Invalid URL scheme' };
    }
    try {
      createWebviewerWindow(url, title || 'Web Viewer');
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

  ipcMain.handle('crawl_web', (_e, args) => crawlWeb(args));
}
