import { BrowserWindow, type IpcMain } from 'electron';
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
  crawlWeb,
  getAggregatorCatalog,
  probeAggregatorEngines,
  toErrorMessage,
}: SearchHandlerDeps): void {
  ipcMain.handle('web_search', (event, args) => webSearch(args, BrowserWindow.fromWebContents(event.sender) ?? getMainWindow()));
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

  ipcMain.handle('crawl_web', (_e, args) => crawlWeb(args));
}
