/** Real Electron rendering benchmark; synthetic chats and an isolated profile. */
import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-renderer-perf-')));
app.disableHardwareAcceleration();
async function run() {
await app.whenReady();
console.log('perf: Electron ready');
const win = new BrowserWindow({ width: 1200, height: 800, show: false,
  webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
win.showInactive();
try {
  await win.loadURL(process.env.AGENTE_RENDERER_URL ?? 'http://127.0.0.1:5173/?mock=1');
  console.log('perf: renderer loaded');
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') console.error('renderer:', message); });
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Profiler.enable');
  await win.webContents.debugger.sendCommand('Profiler.start');
  const report = await win.webContents.executeJavaScript(`(async () => {
    const storeUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => new URL(url).pathname === '/src/lib/stores/app.svelte.ts');
    const { appStore } = await import(storeUrl || '/src/lib/stores/app.svelte.ts');
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    for (let i = 0; !appStore.ready && i < 300; i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (!appStore.ready) throw new Error('App initialization did not finish');
    const content = ('A **synthetic** response with a [link](https://example.com).\\n\\n' +
      '\\x60\\x60\\x60ts\\nconst example = 123;\\n\\x60\\x60\\x60\\n\\n').repeat(12);
    const now = Date.now();
    const chat = { id: 'perf-chat', title: 'Performance fixture', contextMode: 'home',
      messages: [], createdAt: now, updatedAt: now, folderId: null, draft: '' };
    appStore.chats.push(chat); appStore.setActiveSpace('home'); appStore.currentChatId = chat.id;
    await frame(); await frame();
    const results = [];
    for (const count of [40, 400]) {
      appStore.currentChat.messages = [];
      await frame(); await frame();
      const start = performance.now();
      appStore.currentChat.messages = Array.from({ length: count }, (_, i) => ({
        id: 'perf-message-' + i, role: i % 2 ? 'assistant' : 'user',
        content, status: 'complete', createdAt: now
      }));
      await frame(); await frame();
      const mountMs = performance.now() - start;
      const scroll = document.getElementById('conversation-message-scroll');
      if (!scroll) throw new Error('Conversation viewport did not mount');
      if (document.querySelectorAll('.message-slot').length !== count) throw new Error('Fixture lost its messages');
      const intervals = [];
      let last = performance.now();
      for (let i = 0; i < 90; i++) {
        scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * (1 - i / 90);
        scroll.dispatchEvent(new Event('scroll'));
        await frame();
        const time = performance.now(); intervals.push(time - last); last = time;
      }
      const typingStart = performance.now();
      for (let i = 0; i < 20; i++) appStore.updateComposer('synthetic draft ' + i);
      const typingMs = performance.now() - typingStart;
      intervals.sort((a, b) => a - b);
      results.push({ messages: count, mountMs, typing20UpdatesMs: typingMs, scrollFrameP50Ms: intervals[45],
        scrollFrameP95Ms: intervals[85], slowFrames: intervals.filter(x => x > 34).length,
        domNodes: document.querySelectorAll('*').length });
    }
    return results;
  })()`);
  const { profile } = await win.webContents.debugger.sendCommand('Profiler.stop');
  const output = process.env.AGENTE_PERF_OUTPUT ?? '/tmp/agente-renderer-performance.json';
  await writeFile(output, JSON.stringify(report, null, 2));
  await writeFile(output.replace('.json', '.cpuprofile'), JSON.stringify(profile));
  console.log(JSON.stringify(report, null, 2));
} finally { win.destroy(); app.quit(); }

}
run().catch(error => { console.error(error); app.exit(1); });
