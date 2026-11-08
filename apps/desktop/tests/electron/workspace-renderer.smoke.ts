// Run against the dev renderer (?mock=1) in an isolated Electron profile.
// Verifies composed AppShell behavior, including CSS resize affordances.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-workspace-smoke-')));
async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.showInactive();
  win.webContents.debugger.attach('1.3');
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => { console.log('renderer:', level, message); if (level === 'error') errors.push(message); });
  try {
    console.log('smoke: loading AppShell');
    await win.loadURL(process.env.AGENTE_RENDERER_URL ?? 'http://127.0.0.1:5173/?mock=1');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    console.log('smoke: page loaded');
    const run = <T>(expression: string) => win.webContents.executeJavaScript(expression) as Promise<T>;
    const capture = async (path: string) => {
      // An inactive test window may retain its previous compositor frame.
      win.webContents.invalidate();
      await win.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 150));
      await writeFile(path, (await win.webContents.capturePage()).toPNG());
    };
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await run<boolean>('!!document.querySelector("[data-desktop-shell]")')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await run<boolean>('!!document.querySelector("[data-desktop-shell]")'), true, errors.join('\n'));
    console.log('smoke: seeding conversations');
    await run(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      const { workspaceLayout } = await import('/src/lib/stores/workspace-layout.svelte.ts');
      const { browserPanelStore } = await import('/src/lib/stores/browser-panel.svelte.ts');
      const now = Date.now();
      for (const id of ['workspace-a', 'workspace-b']) appStore.chats.push({ id, title: id, contextMode: 'home', messages: [], createdAt: now, updatedAt: now, folderId: null, draft: '' });
      appStore.setActiveSpace('home'); appStore.currentChatId = 'workspace-a';
      await new Promise(resolve => setTimeout(resolve, 30));
      await browserPanelStore.openUrl('https://a.test');
      workspaceLayout.layout.rightWidth = 450; workspaceLayout.save();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await run<string>('document.getElementById("browser-address-input").value'), 'https://a.test');
    const opacity = await run<string>('getComputedStyle(document.querySelector(".workspace-divider .resize-handle"), "::before").opacity');
    assert.equal(opacity, '0', 'Resize cue is hidden at rest');
    await run(`(async () => { const { appStore } = await import('/src/lib/stores/app.svelte.ts'); appStore.currentChatId = 'workspace-b'; })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await run<boolean>('!document.querySelector("[data-workspace-panel=browser]:not([hidden])")'), true, 'Other conversation starts with its own hidden browser');
    await run(`(async () => { const { browserPanelStore } = await import('/src/lib/stores/browser-panel.svelte.ts'); await browserPanelStore.openUrl('https://b.test'); const { appStore } = await import('/src/lib/stores/app.svelte.ts'); appStore.currentChatId = 'workspace-a'; })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await run<string>('document.getElementById("browser-address-input").value'), 'https://a.test');
    const sizes = await run<{ a: number; b: number }>('(() => { const scopes = JSON.parse(localStorage.getItem("agente.workspaceLayout")).scopes; return { a: scopes["chat:workspace-a"].rightWidth, b: scopes["chat:workspace-b"].rightWidth }; })()');
    assert.equal(sizes.a, 450); assert.notEqual(sizes.b, 450);
    await run(`(async () => {
      window.__presentations = [];
      const invoke = window.electronAPI.invoke;
      window.electronAPI.invoke = (channel, args) => { if (channel === 'browser_panel_presentation') window.__presentations.push(args); return invoke(channel, args); };
      const { appStore } = await import('/src/lib/stores/app.svelte.ts'); appStore.openSettings('general');
    })()`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await run<boolean>(`window.__presentations.at(-1)?.exposed`), false, 'Settings explicitly hides the native browser');
    await run(`(async () => { const { appStore } = await import('/src/lib/stores/app.svelte.ts'); appStore.closeSettings(); })()`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await run<boolean>(`window.__presentations.at(-1)?.exposed`), true, 'Closing settings restores browser exposure');
    console.log('smoke: project conversations and hover');
    await run(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      const { codeStore } = await import('/src/lib/features/code/code.svelte.ts');
      const { accessibilityStore } = await import('/src/lib/stores/accessibility.svelte.ts');
      const now = Date.now();
      codeStore.projects = ['a', 'b'].map(id => ({ id: 'project-' + id, rootName: 'Project ' + id, rootPath: '/project/' + id, createdAt: now, updatedAt: now })); codeStore.loaded = true;
      for (const project of codeStore.projects) await window.electronAPI.invoke('chat_db_save_code_project', { project });
      for (const id of ['a', 'b']) appStore.chats.push({ id: 'code-' + id, projectId: 'project-' + id, title: 'Project ' + id, contextMode: 'code', messages: [], createdAt: now, updatedAt: now, folderId: null, draft: '' });
      accessibilityStore.update({ reduceMotion: 'on' });
      appStore.setActiveSpace('code'); appStore.currentChatId = 'code-a';
    })()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await run(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      appStore.findChat('code-a').messages.push({
        id: 'saved-tasks', role: 'assistant', content: 'I made a list.', createdAt: Date.now(), status: 'idle', done: true,
        metadata: { codeTodos: [{ content: 'Read the code', status: 'completed' }, { content: 'Verify the change', status: 'pending' }] }
      });
    })()`);
    const tasksButton = '[data-panel-tab=tasks]';
    const tasksPanel = '[data-workspace-panel=tasks]:not([hidden])';
    await run(`document.querySelector('${tasksButton}').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(await run<string>(`document.querySelector('${tasksPanel}').textContent`), /Verify the change/);
    assert.equal(await run<string>(`document.querySelector('${tasksPanel} [role=progressbar]').getAttribute('aria-valuenow')`), '1');
    assert.equal(await run<number>(`document.body.textContent.split('Verify the change').length - 1`), 1, 'Tasks render only in their panel');
    await run(`document.querySelector('${tasksButton}').click()`);
    assert.equal(await run<boolean>(`!document.querySelector('${tasksPanel}')`), true, 'Tasks toggle hides its panel');
    await run(`(async () => { const { workspaceLayout } = await import('/src/lib/stores/workspace-layout.svelte.ts'); workspaceLayout.show('changes'); })()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await run<boolean>('!!document.querySelector("[data-workspace-panel=changes]:not([hidden])")'), true);
    await run(`(async () => { const { appStore } = await import('/src/lib/stores/app.svelte.ts'); appStore.currentChatId = 'code-b'; })()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await run<boolean>('!document.querySelector("[data-workspace-panel=changes]:not([hidden])")'), true);
    await run(`(async () => { const { appStore } = await import('/src/lib/stores/app.svelte.ts'); appStore.currentChatId = 'code-a'; })()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await run<boolean>('!!document.querySelector("[data-workspace-panel=changes]:not([hidden])")'), true);
    win.webContents.invalidate();
    await win.webContents.capturePage();
    for (let attempt = 0; attempt < 30 && !(await run<boolean>('!!document.querySelector(".window-resize")')); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await run<boolean>('!!document.querySelector(".window-resize")'), true, 'Corner appears after layout measurement');
    assert.equal(await run<string>('getComputedStyle(document.querySelector(".window-resize.edge-nw .grip")).opacity'), '0');
    const corner = await run<{ x: number; y: number }>('(() => { const r = document.querySelector(".window-resize.edge-nw").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...corner });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(Number(await run<string>('getComputedStyle(document.querySelector(".window-resize.edge-nw .grip")).opacity')) > 0, 'Corner shows a cue on hover');
    const before = await run<{ width: number; top: number }>('(() => { const r = document.querySelector("[data-workspace-panel=changes]").getBoundingClientRect(); return { width: r.width, top: r.top }; })()');
    assert.ok(before.width > 0, 'Changes remains visible before dragging');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...corner });
    await new Promise(resolve => setTimeout(resolve, 30));
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: corner.x + 24, y: corner.y + 24 });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: corner.x + 24, y: corner.y + 24 });
    await new Promise(resolve => setTimeout(resolve, 100));
    const after = await run<{ width: number; top: number }>('(() => { const r = document.querySelector("[data-workspace-panel=changes]").getBoundingClientRect(); return { width: r.width, top: r.top }; })()');
    assert.equal(after.width, before.width - 24, 'Top corner resizes width');
    assert.equal(after.top, before.top + 24, 'Top corner resizes height from the top');
    const resizedCorner = await run<{ x: number; y: number }>('(() => { const r = document.querySelector(".window-resize.edge-nw").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...resizedCorner });
    await new Promise(resolve => setTimeout(resolve, 100));
    await capture(join(tmpdir(), 'agente-conversation-panels.png'));
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 });
    await run(`(async () => { const { themeStore } = await import('/src/lib/stores/theme.svelte.ts'); themeStore.set('light'); })()`);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await run<boolean>('document.documentElement.classList.contains("dark")'), false, 'Light theme is applied');
    assert.equal(await run<string>('getComputedStyle(document.querySelector(".window-resize.edge-nw .grip")).opacity'), '0');
    assert.ok(Number.parseFloat(await run<string>('getComputedStyle(document.querySelector(".window-resize.edge-nw .grip")).transitionDuration')) < .001, 'Reduced motion removes visible resize animation');
    await capture(join(tmpdir(), 'agente-conversation-panels-light.png'));
    // Hovering New chat must keep the preview interactive; clicking closes it.
    await run(`(async () => { const { appStore } = await import('/src/lib/stores/app.svelte.ts'); appStore.setActiveSpace('home'); appStore.sidebarOpen = false; })()`);
    const toggle = await run<{x:number;y:number}>(`(() => { const r = document.querySelector('[data-sidebar-toggle]').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...toggle });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await run<boolean>(`!!document.querySelector('.sidebar-view-full.preview')`), true);
    const newChat = await run<{x:number;y:number}>(`(() => { const r = document.querySelector('.sidebar-view-full .sidebar-row.is-emphasis').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseMoved', ...newChat });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await run<boolean>(`!!document.querySelector('.sidebar-view-full.preview')`), true, 'New chat hover retains the preview');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', buttons:1, clickCount:1, ...newChat });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', buttons:0, clickCount:1, ...newChat });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await run<boolean>(`!document.querySelector('.sidebar-view-full.preview')`), true, 'New chat dismisses preview');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('workspace-renderer smoke: ok (project/chat switching, isolated layout/browser, real corner dragging, hover-only cues, light/dark, reduced motion)');
  } finally { win.destroy(); }
}
const deadline = setTimeout(() => { console.error('UI smoke timed out'); app.exit(1); }, 60000);
run().finally(() => clearTimeout(deadline)).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
