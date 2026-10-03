/** Actual picker -> Electron IPC -> mutable HTTP catalogs, in an isolated profile. */
import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerProviderHandlers } from '../../main/ipc/provider-handlers';
import { resolveProvider } from '../../main/providers/registry';

app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-model-discovery-')));
app.disableHardwareAcceleration();
async function run() {
  await app.whenReady();
  let generation = 'retired';
  const requests = { go: 0, router: 0 };
  const server = createServer((request, reply) => {
    const provider = request.url?.startsWith('/go/') ? 'go' : 'router';
    requests[provider]++;
    reply.writeHead(200, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify({ data: [{ id: `${provider}-${generation}` }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  registerProviderHandlers({ ipcMain, resolveProvider, resolveApiKey: () => 'fixture-key' });
  const win = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { preload: resolve('tests/electron/model-discovery-preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.showInactive();
  try {
    await win.loadURL(process.env.AGENTE_RENDERER_URL ?? 'http://127.0.0.1:5173/?mock=1');
    await win.webContents.executeJavaScript(`(async () => {
      const moduleUrl = path => performance.getEntriesByType('resource').map(entry => entry.name).find(url => new URL(url).pathname === path) || path;
      const { appStore } = await import(moduleUrl('/src/lib/stores/app.svelte.ts'));
      for (let i = 0; !appStore.ready && i < 300; i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (!appStore.ready) throw new Error('Initialization did not finish');
      const original = window.electronAPI.invoke;
      window.electronAPI.invoke = (channel, ...args) => channel === 'fetch_provider_models' ? window.modelListTest.read(args[0]) : original(channel, ...args);
      appStore.currentChatId = null;
      appStore.config = { llm: { backend_mode: 'api', provider: 'opencode-go', providers: {
        'opencode-go': { model: 'go-selected', base_url: ${JSON.stringify(base + '/go/v1')}, has_api_key: true },
        'openrouter': { model: 'router-selected', base_url: ${JSON.stringify(base + '/router/v1')}, has_api_key: true }
      } } };
      appStore.createChat('home');
      await new Promise(resolve => setTimeout(resolve, 100));
      const { providerModels } = await import(moduleUrl('/src/lib/stores/provider-models.svelte.ts'));
      await Promise.all([appStore.refreshModels(true), providerModels.load('opencode-go')]);
      await providerModels.load('openrouter');
      await appStore.updateProvider({ provider: 'opencode-go', model: 'go-retired' });
      window.modelDiscoveryFixture = { appStore, providerModels };
      appStore.modelMenuOpen = true;
      await new Promise(resolve => setTimeout(resolve, 100));
      for (const head of document.querySelectorAll('.model-modal-root .group-head')) head.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const rows = [...document.querySelectorAll('[data-model-option]')].map(row => row.textContent);
      if (!rows.some(row => row.includes('go-retired')) || !rows.some(row => row.includes('router-retired'))) throw new Error('Initial API models missing from actual picker');
    })()`);
    assert.deepEqual(requests, { go: 1, router: 1 });
    generation = 'new';
    const refreshed = await win.webContents.executeJavaScript(`(async () => {
      const refresh = document.querySelector('.model-modal-root .lucide-refresh-cw')?.closest('button');
      if (!refresh) throw new Error('Picker refresh button not found');
      refresh.click();
      const { appStore, providerModels } = window.modelDiscoveryFixture;
      for (let i = 0; i < 300 && (!providerModels.models('opencode-go').some(m => m.id === 'go-new') || !providerModels.models('openrouter').some(m => m.id === 'router-new')); i++) await new Promise(resolve => setTimeout(resolve, 20));
      await new Promise(resolve => setTimeout(resolve, 100));
      const rows = [...document.querySelectorAll('[data-model-option]')].map(row => row.textContent);
      if (rows.some(row => row.includes('-retired')) || !rows.some(row => row.includes('go-new')) || !rows.some(row => row.includes('router-new'))) throw new Error('Refresh did not replace both visible provider catalogs');
      if (appStore.activeModelLabel !== 'go-retired') throw new Error('Refreshing changed the conversation model choice');
      return rows;
    })()`);
    assert.deepEqual(requests, { go: 2, router: 2 });
    assert.equal(refreshed.length, 2);
    console.log('PASS: actual picker Refresh updates active and inactive providers, removes retired rows, shares requests with chat, and preserves selected conversation model');
  } finally {
    win.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.quit();
  }
}
run().catch(error => { console.error(error); app.exit(1); });
