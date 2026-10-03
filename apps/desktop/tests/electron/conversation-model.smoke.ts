/** Real renderer selection changes plus real SQLite restart persistence. */
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveChatSession, saveChatDraft, loadAllChats, closeDb } from '../../main/chat-db';

const root = mkdtempSync(join(tmpdir(), 'agente-conversation-model-'));
process.env.TALAMOLM_HOME = root;
app.setPath('userData', root);
app.disableHardwareAcceleration();
async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.showInactive();
  try {
    await win.loadURL(process.env.AGENTE_RENDERER_URL ?? 'http://127.0.0.1:5173/?mock=1');
    const sessions = await win.webContents.executeJavaScript(`(async () => {
      const storeUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => new URL(url).pathname === '/src/lib/stores/app.svelte.ts');
      const { appStore } = await import(storeUrl || '/src/lib/stores/app.svelte.ts');
      for (let i = 0; !appStore.ready && i < 300; i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (!appStore.ready) throw new Error('Initialization did not finish');
      appStore.currentChatId = null;
      appStore.config = { llm: { backend_mode: 'api', provider: 'opencode-go',
        providers: { 'opencode-go': { model: 'fixture-default', has_api_key: true, base_url: 'https://opencode.ai/zen/go/v1' } },
        local: { model: 'local-fixture', selected_model_path: '/synthetic/local.gguf', base_url: 'http://localhost:11435/v1' } } };
      const ids = [];
      for (const [i, mode] of ['home', 'code', 'roleplay'].entries()) {
        const chat = appStore.createChat(mode); ids.push(chat.id);
        await appStore.updateProvider({ provider: 'opencode-go', model: 'fixture-' + i });
        appStore.setReasoningLevel('high');
        chat.homeRuntime = { sessionId: 'runtime-' + i, revision: 1, provider: 'opencode-go', model: 'fixture-' + i,
          contextWindow: 20000 + i * 10000, contextTokens: 100 + i, historyIds: [] };
      }
      for (const [i, id] of ids.entries()) {
        appStore.selectChat(id);
        if (appStore.activeModelLabel !== 'fixture-' + i) throw new Error('Model leaked across conversations');
        if (appStore.reasoningLevel !== 'high') throw new Error('Reasoning choice leaked');
        await appStore.refreshContextBudgetPreview();
        if (appStore.contextBudget?.maxContext !== 20000 + i * 10000) throw new Error('Context reading leaked across conversations');
      }
      appStore.selectChat(ids[1]);
      await appStore.setBackendMode('local');
      if (appStore.activeModelLabel !== 'local-fixture') throw new Error('Local choice lost');
      appStore.selectChat(ids[0]);
      if (appStore.backendMode !== 'api') throw new Error('Local backend leaked to API chat');
      appStore.selectChat(ids[1]);
      if (appStore.backendMode !== 'local') throw new Error('Local chat did not restore');
      await appStore.setBackendMode('api');
      if (appStore.activeModelLabel !== 'fixture-1') throw new Error('Cloud choice did not restore');
      await appStore.refreshContextBudgetPreview();
      if (appStore.contextBudget?.maxContext !== 30000) throw new Error('Cloud context reading did not restore');
      appStore.updateComposer('persisted draft');
      await new Promise(resolve => setTimeout(resolve, 50));
      const originalInvoke = window.electronAPI.invoke;
      const pending = new Map();
      const first = appStore.chats.find(chat => chat.id === ids[0]);
      const second = appStore.chats.find(chat => chat.id === ids[1]);
      appStore.config = { ...appStore.config, llm: { ...appStore.config.llm, providers: {
        ...appStore.config.llm.providers,
        'race-a': { model: 'a', base_url: 'https://a.test/v1', has_api_key: true },
        'race-b': { model: 'b', base_url: 'https://b.test/v1', has_api_key: true }
      } } };
      const firstSelection = first.modelSelection;
      const secondSelection = second.modelSelection;
      first.modelSelection = { ...firstSelection, provider: 'race-a' };
      second.modelSelection = { ...secondSelection, provider: 'race-b' };
      window.electronAPI.invoke = (channel, ...args) => channel === 'fetch_provider_models'
        ? new Promise(resolve => pending.set(args[0].providerName, resolve))
        : originalInvoke(channel, ...args);
      try {
        appStore.currentChatId = first.id;
        const slow = appStore.refreshModels(true);
        appStore.selectChat(second.id);
        if (!pending.has('race-a') || !pending.has('race-b')) throw new Error('Missing model-list race requests');
        pending.get('race-b')(['new-chat-model']);
        await new Promise(resolve => setTimeout(resolve, 20));
        pending.get('race-a')(['stale-model']);
        await slow;
        if (appStore.models[0]?.id !== 'new-chat-model' || appStore.modelsRefreshing) {
          throw new Error('Stale model-list response overwrote the current conversation');
        }
      } finally {
        window.electronAPI.invoke = originalInvoke;
        first.modelSelection = firstSelection;
        second.modelSelection = secondSelection;
      }
      return JSON.parse(JSON.stringify(ids.map(id => appStore.chats.find(chat => chat.id === id))));
    })()`);
    sessions[1].messages = [{ id: 'draft-fixture-message', role: 'assistant', content: 'Retain this transcript', createdAt: 1000,
      attachments: [{ id: 'draft-fixture-attachment', name: 'fixture.txt', kind: 'file', data: 'retained data' }],
      versions: [{ content: 'Earlier version', createdAt: 900 }] }];
    sessions[1].pendingPrompts = [{ id: "queue-restart", content: "Retained editable prompt", codeAttachments: [{ kind: "image", name: "evidence.png", mime: "image/png", path: "/synthetic/evidence.png" }] }];
    for (const session of sessions) saveChatSession(session);
    const beforeDraft = loadAllChats().find(chat => chat.id === sessions[1].id).messages;
    assert.equal(saveChatDraft(sessions[1].id, 'updated draft', null, Date.now()), true);
    closeDb();
    const restored = loadAllChats();
    for (const [index, session] of sessions.entries()) {
      const chat = restored.find(chat => chat.id === session.id);
      assert.equal(chat.modelSelection.model, `fixture-${index}`);
      assert.equal(chat.reasoningLevel, 'high');
    }
    assert.equal(restored.find(chat => chat.id === sessions[1].id).draft, 'updated draft');
    assert.deepEqual(restored.find(chat => chat.id === sessions[1].id).messages, beforeDraft);
    assert.deepEqual(restored.find(chat => chat.id === sessions[1].id).pendingPrompts, sessions[1].pendingPrompts);
    console.log('PASS: Home, Code and Roleplay model/reasoning isolation, cloud/local context restoration, model-list race, SQLite reopen and draft-only save retaining messages/attachments/versions');
  } finally { closeDb(); win.destroy(); app.quit(); }
}
run().catch(error => { console.error(error); app.exit(1); });
