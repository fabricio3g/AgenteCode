// Isolated renderer integration: real Home/Design tools, fake runtime events, no model requests.
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

app.disableHardwareAcceleration();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-background-profile-')));
async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') console.error(message); });
  const js = <T>(source: string) => win.webContents.executeJavaScript(source) as Promise<T>;
  const waitFor = async (condition: string) => {
    for (let i = 0; i < 100; i++) {
      if (await js(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.error(await js(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      return { space: appStore.activeSpace, chatId: appStore.currentChatId, messages: appStore.currentChat?.messages.length, error: appStore.error, active: appStore.hasAnyGeneration, lastMessage: appStore.currentChat?.messages.at(-1)?.content, turnError: window.__qa?.turnError };
    })()`));
    throw new Error(`Timed out: ${condition}`);
  };
  const pause = async () => {
    win.webContents.invalidate();
    await win.webContents.capturePage();
    await js('new Promise(resolve => { const timer = setTimeout(resolve, 100); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); })');
    await new Promise(resolve => setTimeout(resolve, 200));
  };
  try {
    await win.loadURL(`${process.env.AGENTE_DEV_URL || 'http://127.0.0.1:5179'}/?mock=1`);
    await waitFor("document.documentElement.dataset.desktopReady === 'true'");
    await js(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      const { accessibilityStore } = await import('/src/lib/stores/accessibility.svelte.ts');
      accessibilityStore.update({ reduceMotion: 'on' });
      appStore.sidebarOpen = false; appStore.onboardingOpen = false;
      appStore.currentChatId = null;
      appStore.config = { llm: { backend_mode: 'api', provider: 'openrouter', providers: { openrouter: { base_url: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash', has_api_key: true } } } };
      const api = window.electronAPI, invoke = api.invoke.bind(api), on = api.on.bind(api);
      const listeners = new Set();
      const qa = window.__qa = { starts: [], replies: [], turns: [], emit(event) { for (const listener of listeners) listener(event); } };
      api.on = (name, callback) => name === 'home_runtime_event' ? (listeners.add(callback), () => listeners.delete(callback)) : on(name, callback);
      api.invoke = async (name, args) => {
        if (name === 'home_runtime_start') { qa.starts.push(args); return { sessionId: args.runId, turnId: args.runId, contextWindow: 128000 }; }
        if (name === 'home_runtime_result') { qa.replies.push(args); return {}; }
        return invoke(name, args);
      };
      const chat = appStore.createChat('design'); qa.design = chat.id;
      appStore.composer = 'Create a simple landing page';
      qa.turns.push(appStore.sendCurrentMessage().catch(error => { qa.turnError = String(error); }));
    })()`);
    await waitFor('window.__qa.starts.length === 1');
    await js(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      const chat = appStore.createChat('home'); window.__qa.home = chat.id;
      appStore.composer = 'Write a brief answer';
      window.__qa.turns.push(appStore.sendCurrentMessage());
    })()`);
    await waitFor('window.__qa.starts.length === 2');
    await js(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      appStore.setActiveSpace('code');
      const qa = window.__qa;
      for (const started of qa.starts) qa.emit({ runId: started.runId, type: 'event', envelope: { timestamp: new Date().toISOString(), event: { type: 'assistant_delta', text: 'Still working in the background.' } } });
      const design = qa.starts[0];
      qa.emit({ runId: design.runId, type: 'call', call: { session_id: design.runId, turn_id: design.runId, request_id: 'write-page', call_id: 'write-page', name: 'design_write', arguments: { path: 'index.html', content: '<h1>Background design completed</h1>' } } });
    })()`);
    await waitFor('window.__qa.replies.length === 1');
    assert.equal(await js('window.__qa.replies[0].result.is_error'), false);
    await js(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      const qa = window.__qa;
      for (const [i, started] of qa.starts.entries()) {
        qa.emit({ runId: started.runId, type: 'event', envelope: { event: { type: 'assistant_message', text: i === 0 ? 'Design finished in background.' : 'Home finished in background.' } } });
        qa.emit({ runId: started.runId, type: 'outcome', outcome: { status: 'completed' }, snapshot: { revision: 1 } });
      }
      await Promise.all(qa.turns);
      qa.result = { space: appStore.activeSpace, active: appStore.hasAnyGeneration, design: appStore.findChat(qa.design).messages.at(-1).content, home: appStore.findChat(qa.home).messages.at(-1).content };
    })()`);
    assert.deepEqual(await js('window.__qa.result'), { space: 'code', active: false, design: 'Design finished in background.', home: 'Home finished in background.' });
    assert.equal(await js(`(async () => (await window.electronAPI.invoke('design_files', { chatId: window.__qa.design })).files['index.html'])()`), '<h1>Background design completed</h1>');
    await js(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      const { designStore } = await import('/src/lib/features/design/design.svelte.ts');
      const chat = appStore.findChat(window.__qa.design);
      chat.messages = Array.from({ length: 20 }, (_, i) => ({ id: 'dial-' + i, role: i % 2 ? 'assistant' : 'user', content: 'A readable message beside the conversation dial. '.repeat(2), createdAt: Date.now(), done: true }));
      appStore.selectChat(chat.id); designStore.setPaneWidth('dock', 288);
    })()`);
    await pause();
    const output = mkdtempSync(join(tmpdir(), 'agente-design-layout-'));
    for (const theme of ['light', 'dark']) {
      await js(`(async () => (await import('/src/lib/stores/theme.svelte.ts')).themeStore.set('${theme}'))()`);
    for (const height of [760, 420]) {
      win.setSize(1100, height); await pause();
      await waitFor("!!document.querySelector('.pane.dock .dial')");
      const layout = await js<{ gaps: number[]; gutter: number; clipped: string[] }>(`(() => {
        const dock = document.querySelector('.pane.dock'), dial = dock.querySelector('.dial');
        const ticks = [...dial.querySelectorAll('button')].map(button => button.getBoundingClientRect());
        const rect = dock.getBoundingClientRect(), content = dock.querySelector('.conversation-scroll > div').getBoundingClientRect();
        return { gaps: ticks.slice(1).map((tick, i) => tick.top - ticks[i].bottom), gutter: dial.getBoundingClientRect().left - content.right,
          clipped: [...dock.querySelectorAll('.composer-bar button')].filter(button => button.offsetWidth).filter(button => { const b = button.getBoundingClientRect(); return b.left < rect.left || b.right > rect.right; }).map(button => button.getAttribute('aria-label')) };
      })()`);
      assert.ok(layout.gaps.every(gap => gap >= 5), JSON.stringify(layout));
      assert.ok(layout.gutter >= 8, JSON.stringify(layout));
      assert.deepEqual(layout.clipped, []);
      writeFileSync(join(output, `design-${theme}-${height}.png`), (await win.webContents.capturePage()).toPNG());
    }
    }
    console.log(`Home/Design background and narrow dial checks passed. Screenshots: ${output}`);
  } finally { win.destroy(); app.quit(); }
}
run().catch(error => { console.error(error); app.exit(1); });
