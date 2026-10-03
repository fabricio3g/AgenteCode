/** Real Electron queue editor smoke using an isolated mock conversation. */
import { app, BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-queue-ui-')));
app.disableHardwareAcceleration();
async function run() {
 await app.whenReady();
 const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 win.show(); win.focus();
 try {
  await win.loadURL(process.env.AGENTE_RENDERER_URL ?? 'http://127.0.0.1:5174/?mock=1');
  const report = await win.webContents.executeJavaScript(`(async () => {
    const source = performance.getEntriesByType('resource').map(entry => entry.name).find(url => new URL(url).pathname === '/src/lib/stores/app.svelte.ts');
    const { appStore } = await import(source || '/src/lib/stores/app.svelte.ts');
    const wait = async (test) => { for (let i = 0; i < 200; i++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Queue UI timed out'); };
    await wait(() => appStore.ready);
    appStore.createChat('home');
    const chat = appStore.currentChat;
    chat.title = 'Queue editing fixture';
    chat.messages = [{ id: 'fixture', role: 'assistant', content: 'The current task is running. Your next prompts stay editable above the composer.', createdAt: Date.now(), done: true, status: 'idle' }];
    const controller = new AbortController();
    appStore.activeRunsByChat = { [chat.id]: { controller, messageId: 'fixture', backendMode: 'api', mode: 'agent', startedAt: Date.now() } };
    appStore.composer = 'Check the provider cache and include the full evidence.';
    await appStore.sendCurrentMessage();
    appStore.queuePrompt(chat.id, 'Then verify the result with a regression test.');
    await wait(() => document.querySelector('.prompt-queue'));
    const button = label => document.querySelector('.prompt-queue button[aria-label="' + label + '"]');
    button('Edit queued prompt').click();
    await wait(() => document.querySelector('.prompt-queue textarea'));
    const editor = document.querySelector('.prompt-queue textarea');
    const edited = 'Edited: check all configured providers and preserve the final evidence.';
    editor.value = edited; editor.dispatchEvent(new Event('input', { bubbles: true }));
    button('Send queued prompts now').click();
    await wait(() => controller.signal.aborted);
    if (chat.pendingPrompts[0].content !== edited) throw new Error('Send now lost the edit');
    if (chat.messages.length !== 1) throw new Error('Queue created premature bubbles');
    await wait(() => !document.querySelector('.prompt-queue textarea'));
    button('Remove queued prompt').click();
    await wait(() => chat.pendingPrompts.length === 1);
    appStore.queuePrompt(chat.id, 'Editable before sending; Escape cancels an edit.');
    button('Edit queued prompt').click();
    await wait(() => document.querySelector('.prompt-queue textarea'));
    const prose = document.querySelector('.markdown-body');
    return { savedBeforeSend: true, ownerInterrupted: true, removal: true, prematureBubbles: false, proseFont: prose ? getComputedStyle(prose).fontSize : null };
  })()`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  win.webContents.debugger.attach('1.3');
  const dark = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true });
  await (await import('node:fs/promises')).writeFile('/tmp/agente-queue-ui.png', Buffer.from(dark.data, 'base64'));
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const source = await win.webContents.executeJavaScript("performance.getEntriesByType('resource').map(entry => entry.name).find(url => new URL(url).pathname === '/src/lib/stores/theme.svelte.ts')");
  await win.webContents.executeJavaScript(`import(${JSON.stringify(source || '/src/lib/stores/theme.svelte.ts')}).then(({ themeStore }) => themeStore.set('light'))`);
  await new Promise(resolve => setTimeout(resolve, 500));
  const light = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true });
  await (await import('node:fs/promises')).writeFile('/tmp/agente-queue-ui-light.png', Buffer.from(light.data, 'base64'));
  console.log('PASS:', JSON.stringify(report));
 } finally { win.destroy(); app.quit(); }
}
run().catch(error => { console.error(error); app.exit(1); });
