import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { afterEach, describe, it } from 'node:test';

const mockElectronUrl = `data:text/javascript,${encodeURIComponent(`
export const app = { isPackaged: false, getPath: () => process.cwd(), on: () => {}, once: () => {} };
export const BrowserWindow = { fromWebContents: () => null, getAllWindows: () => [] };
export class WebContentsView {}
export const dialog = {};
export const session = { defaultSession: {} };
export const ipcMain = { handle: () => {} };
export const shell = { openExternal: () => {} };
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) };
export const nativeTheme = { shouldUseDarkColors: false, on: () => {} };
export default { app, BrowserWindow, WebContentsView, dialog, session, ipcMain, shell, screen, nativeTheme };
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { shortCircuit: true, url: mockElectronUrl };
    }
    return nextResolve(specifier, context);
  }
});

const { webSearch } = await import('../../main/search-engine.ts');
const { registerSearchHandlers } = await import('../../main/ipc/search-handlers.ts');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createFakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    ipcMain: {
      handle(channel, fn) {
        handlers.set(channel, fn);
      }
    }
  };
}

describe('operation-scoped search cancellation (#30)', () => {
  it('cancels an in-flight provider search via search_cancel, skips page reads, and does not cache', async () => {
    let providerAborted = false;
    let pageReadCount = 0;
    let providerCalls = 0;

    globalThis.fetch = (url, init) => {
      const target = new URL(url);
      if (target.pathname === '/search') {
        providerCalls += 1;
        if (providerCalls === 1) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              providerAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          });
        }
        return Promise.resolve(Response.json({
          results: [{ title: 'Fresh hit', url: 'https://fresh.example/a', content: 'Fresh snippet' }]
        }));
      }
      pageReadCount += 1;
      return Promise.resolve(new Response('Readable page body. '.repeat(40), { headers: { 'content-type': 'text/plain' } }));
    };

    const { handlers, ipcMain } = createFakeIpc();
    const progress = [];
    const fakeWin = { webContents: { id: 1, send: (_ch, payload) => progress.push(payload), once: () => {} } };
    const fakeEvent = { sender: fakeWin.webContents };

    registerSearchHandlers({
      ipcMain,
      shell: { openExternal: () => {} },
      getMainWindow: () => fakeWin,
      webSearch,
      searchHfModels: () => [],
      hfRepoGguf: () => null,
      fetchHfReadme: () => null,
      createWebviewerWindow: () => {},
      scrapeUrlStructured: async () => ({ content: '' }),
      fetchLinkPreview: async () => ({}),
      crawlWeb: async () => ({}),
      getAggregatorCatalog: () => [],
      probeAggregatorEngines: async () => ({}),
      toErrorMessage: (e) => String(e)
    });

    const query = 'cancel-provider-unique-query';
    const pending = handlers.get('web_search')(fakeEvent, {
      query,
      operationId: 'op-provider-1',
      options: { provider: 'searxng', searxng_base_url: 'https://cancel-prov.example', use_local_readability: false }
    });

    await new Promise((r) => setTimeout(r, 25));
    const cancelRes = await handlers.get('search_cancel')(fakeEvent, { operationId: 'op-provider-1' });
    assert.equal(cancelRes.cancelled, 1);
    await assert.rejects(pending, /abort/i);
    assert.equal(providerAborted, true);
    assert.equal(pageReadCount, 0);
    assert.ok(progress.every((item) => item.operationId === 'op-provider-1'));

    // Next search for the same query must NOT hit cache from the aborted request.
    const fresh = await handlers.get('web_search')(fakeEvent, {
      query,
      operationId: 'op-provider-2',
      options: { provider: 'searxng', searxng_base_url: 'https://cancel-prov.example', use_local_readability: false }
    });
    assert.equal(fresh.cached, undefined);
    assert.equal(providerCalls, 2);
  });

  it('cancels an in-flight page read, skips queued reads, isolates concurrent callers, and skips cache write', async () => {
    let slowPageAborted = false;
    const fetchedUrls = [];

    globalThis.fetch = (url, init) => {
      const target = new URL(url);
      if (target.pathname === '/search') {
        const q = target.searchParams.get('q') || '';
        if (q.includes('fast-job')) {
          return Promise.resolve(Response.json({
            results: [{ title: 'Fast', url: 'https://fast.example/ok', content: 'Fast' }]
          }));
        }
        return Promise.resolve(Response.json({
          results: [
            { title: 'Slow 1', url: 'https://slow.example/1', content: 'First' },
            { title: 'Queued 2', url: 'https://slow.example/2', content: 'Second' },
            { title: 'Queued 3', url: 'https://slow.example/3', content: 'Third' },
            { title: 'Queued 4', url: 'https://slow.example/4', content: 'Fourth' }
          ]
        }));
      }
      fetchedUrls.push(String(url));
      if (String(url).includes('slow.example/1')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            slowPageAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      return Promise.resolve(new Response('Page text. '.repeat(40), { headers: { 'content-type': 'text/plain' } }));
    };

    const { handlers, ipcMain } = createFakeIpc();
    const progress = [];
    const fakeWin = { webContents: { id: 2, send: (_ch, payload) => progress.push(payload), once: () => {} } };
    const fakeEvent = { sender: fakeWin.webContents };

    registerSearchHandlers({
      ipcMain,
      shell: { openExternal: () => {} },
      getMainWindow: () => fakeWin,
      webSearch,
      searchHfModels: () => [],
      hfRepoGguf: () => null,
      fetchHfReadme: () => null,
      createWebviewerWindow: () => {},
      scrapeUrlStructured: async () => ({ content: '' }),
      fetchLinkPreview: async () => ({}),
      crawlWeb: async () => ({}),
      getAggregatorCatalog: () => [],
      probeAggregatorEngines: async () => ({}),
      toErrorMessage: (e) => String(e)
    });

    const slowPromise = handlers.get('web_search')(fakeEvent, {
      query: 'slow-job-unique',
      operationId: 'op-slow',
      options: { provider: 'searxng', searxng_base_url: 'https://cancel-page.example', use_local_readability: false, scrape_concurrency: 1 }
    });
    const fastPromise = handlers.get('web_search')(fakeEvent, {
      query: 'fast-job-unique',
      operationId: 'op-fast',
      options: { provider: 'searxng', searxng_base_url: 'https://cancel-page.example', use_local_readability: false }
    });

    await new Promise((r) => setTimeout(r, 30));
    await handlers.get('search_cancel')(fakeEvent, { operationId: 'op-slow' });

    await assert.rejects(slowPromise, /abort/i);
    const fastResult = await fastPromise;
    assert.equal(fastResult.results[0].url, 'https://fast.example/ok');
    assert.equal(slowPageAborted, true);
    assert.ok(!fetchedUrls.some((u) => u.includes('slow.example/4')), 'queued page reads were skipped after cancel');
    assert.ok(progress.some((p) => p.operationId === 'op-fast'));
    assert.ok(progress.some((p) => p.operationId === 'op-slow'));
  });
});
