// Bundle with esbuild (external=electron), run against the mock dev renderer.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { registerWindowHandlers } from '../../main/ipc/window-handlers.ts';
import { setConversationWindowFactory, setMainWindow } from '../../main/window-manager.ts';

app.disableHardwareAcceleration();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-splits-')));
async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.showInactive();
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') { errors.push(message); console.error('renderer:',message); } });
  const js = async <T>(source: string): Promise<T> => { try { return await win.webContents.executeJavaScript(source) as T; } catch(error) { console.error('Failed expression:',source.slice(0,500));throw error;} };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    await win.loadURL(process.env.AGENTE_RENDERER_URL ?? 'http://127.0.0.1:5173/?mock=1');
    for (let i = 0; i < 100; i++) { if (await js('!!document.querySelector("[data-desktop-shell]")')) break; await pause(); }
    await js(`(async () => {
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      const { codeStore } = await import('/src/lib/features/code/code.svelte.ts');
      const { workspaceLayout } = await import('/src/lib/stores/workspace-layout.svelte.ts');
      const now = Date.now();
      codeStore.projects = ['a','b'].map(id => ({ id:'project-'+id, rootName:'Project '+id, rootPath:'/project/'+id, createdAt:now, updatedAt:now }));
      codeStore.loaded = true;
      for (const project of codeStore.projects) await window.electronAPI.invoke('chat_db_save_code_project', { project });
      for (const id of ['a','b']) appStore.chats.push({ id:'split-'+id, title:'Conversation '+id, contextMode:'code', projectId:'project-'+id, createdAt:now, updatedAt:now, folderId:null, draft:'', codeAgent:{ instanceId:'agente', runtimeMode:'supervised' }, messages:[{ id:'message-'+id, role:'user', content:'Work in project '+id, createdAt:now }] });
      appStore.setActiveSpace('code'); codeStore.openConversation('split-a');
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!workspaceLayout.splitWith('split-b', 'right', { x:0,y:0,...workspaceLayout.centreSize })) throw new Error('split refused '+JSON.stringify({size:workspaceLayout.centreSize,panes:workspaceLayout.panes,rect:document.querySelector('.panes')?.getBoundingClientRect().toJSON()}));
      codeStore.openConversation('split-b');
    })()`);
    await pause();
    assert.equal(await js('document.querySelectorAll("[data-conversation-workspace]").length'), 2, errors.join('\n'));
    assert.equal(await js('document.querySelectorAll(".conversation-tools").length'), 2);
    assert.equal(await js(`!!document.querySelector('.pane-head .meta')`),false,'Header contains only title and close');
    // Keyboard click deliberately has no pointerdown: ownership must be explicit.
    await js(`document.querySelector('[data-conversation-workspace="split-a"] [data-panel-tab="changes"]').click()`);
    await pause();
    assert.equal(await js(`!!document.querySelector('[data-conversation-workspace="split-a"] [data-workspace-panel="changes"]:not([hidden])')`), true);
    assert.equal(await js(`!!document.querySelector('[data-conversation-workspace="split-b"] [data-workspace-panel="changes"]:not([hidden])')`), false);
    await js(`document.querySelector('[data-conversation-workspace="split-b"] [data-panel-tab="files"]').click()`);
    await pause();
    assert.equal(await js(`!!document.querySelector('[data-conversation-workspace="split-a"] [data-workspace-panel="changes"]:not([hidden])')`), true);
    assert.equal(await js(`!!document.querySelector('[data-conversation-workspace="split-b"] [data-workspace-panel="files"]:not([hidden])')`), true);
    const geometry = await js<{ panelsInside: boolean; readable: boolean }>(`(() => {
      const sections = [...document.querySelectorAll('[data-conversation-workspace]')];
      return { panelsInside: sections.every(section => {
        const r = section.getBoundingClientRect(); return [...section.querySelectorAll('[data-workspace-panel]:not([hidden])')].every(panel => { const p=panel.getBoundingClientRect();return p.left>=r.left && p.right<=r.right+1 && p.top>=r.top && p.bottom<=r.bottom+1; });
      }), readable: sections.every(section => section.querySelector('.workspace-main').getBoundingClientRect().width >= 320) };
    })()`);
    assert.deepEqual(geometry, { panelsInside: true, readable: true }, await js(`JSON.stringify([...document.querySelectorAll('[data-conversation-workspace]')].map(section=>({workspace:section.getBoundingClientRect().toJSON(),panels:[...section.querySelectorAll('[data-workspace-panel]:not([hidden])')].map(panel=>panel.getBoundingClientRect().toJSON())})))`));
    // One targeted draft reaches exactly one composer.
    await js(`window.dispatchEvent(new CustomEvent('code-composer-draft', { detail:{chatId:'split-a',text:'Only project A'} }))`);
    await pause();
    const drafts = await js<string[]>(`[...document.querySelectorAll('[data-conversation-workspace] textarea')].map(node => node.value)`);
    assert.ok(drafts.includes('Only project A')); assert.equal(drafts.filter(text => text==='Only project A').length, 1);
    assert.equal(await js(`(async () => (await import('/src/lib/stores/app.svelte.ts')).appStore.currentChatId)()`), 'split-a', 'Keyboard focus activates its conversation');
    // Both browsers stay mounted and exposed in the two split docks.
    for (const id of ['a','b']) {
      // The browser toggle lives in each pane's own strip, not in the project card.
      await js(`document.querySelector('[data-conversation-workspace="split-${id}"] [data-panel-tab="browser"]').click()`); await pause();
    }
    assert.equal(await js(`document.querySelectorAll('[data-workspace-panel="browser"]:not([hidden])').length`), 2);
    const browsers = await js<string[]>(`[...document.querySelectorAll('[data-workspace-panel="browser"] input')].map(input=>input.value)`);
    assert.equal(browsers.length, 2);
    // Canvas edits and selection are owned by each split.
    await js(`(async () => {
      const { canvasBoard } = await import('/src/lib/features/canvas/canvas-board.svelte.ts');
      const a=canvasBoard.forChat('split-a'), b=canvasBoard.forChat('split-b');
      a.addBoard('A',640,480); b.addBoard('B',800,600); a.color='#111827'; b.color='#3b82f6';
      if(a.doc.images[0].w!==640 || b.doc.images[0].w!==800) throw new Error('board ownership lost');
    })()`);
    // Hover metadata reads recorded history; project/folder DnD only changes organization.
    await js(`(async()=>{
      const {appStore}=await import('/src/lib/stores/app.svelte.ts');
      const {sidebarOrganization}=await import('/src/lib/features/code/sidebar-organization.svelte.ts');
      appStore.chats.find(chat=>chat.id==='split-a').messages.push({id:'model-note',role:'assistant',content:'Done',createdAt:Date.now(),metadata:{modelName:'model-a'}});
      await sidebarOrganization.createFolder('project-a','Release');
      const row=document.querySelector('[data-session-row="split-a"]'),folder=document.querySelector('[data-conversation-folder] .sidebar-row');
      const dataTransfer=new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));
      folder.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));
      folder.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
    })()`);await pause();
    assert.equal(await js(`(async()=>{const {appStore}=await import('/src/lib/stores/app.svelte.ts');const chat=appStore.chats.find(chat=>chat.id==='split-a');return chat.folderId===appStore.folders[0].id&&chat.projectId==='project-a';})()`),true,'Conversation drops into its folder');
    assert.equal(await js(`!!document.querySelector('[data-conversation-folder] [data-session-row="split-a"]')`),true);
    await js(`document.querySelector('[data-session-row="split-a"]').closest('.tooltip-anchor').dispatchEvent(new MouseEvent('mouseenter'))`);
    await new Promise(resolve=>setTimeout(resolve,650));
    const metadata=await js<string>(`document.querySelector('[data-session-metadata="split-a"]')?.textContent??''`);
    assert.ok(metadata.includes('Release')&&metadata.includes('model-a')&&metadata.includes('Created'),metadata);
    await js(`document.querySelector('[data-session-row="split-a"]').closest('.tooltip-anchor').dispatchEvent(new MouseEvent('mouseleave'))`);
    await js(`(async()=>{
      const {codeStore}=await import('/src/lib/features/code/code.svelte.ts');const {sidebarOrganization}=await import('/src/lib/features/code/sidebar-organization.svelte.ts');
      const source=document.querySelector('[data-sidebar-project="project-a"]>.sidebar-row'),target=document.querySelector('[data-sidebar-project="project-b"]>.sidebar-row');
      const dataTransfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
      if(sidebarOrganization.list('projects',codeStore.projects)[0].id!=='project-a')throw new Error('project order was not saved');
    })()`);
    // Compact project card adds scripts and permits its nested branch picker.
    await js(`document.querySelector('[data-conversation-workspace="split-a"] [aria-label="Project controls"]').click()`);await pause();
    await js(`document.querySelector('[data-project-controls="split-a"] [data-keep-open]').click()`);await pause();
    assert.equal(await js(`!!document.querySelector('[data-project-controls="split-a"] .script-form')`),true,'Add script stays in the project card');
    await js(`document.querySelector('[data-project-controls="split-a"] .script-form input').value='Dev';document.querySelector('[data-project-controls="split-a"] .script-form input').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-project-controls="split-a"] .script-form input+input').value='npm run dev';document.querySelector('[data-project-controls="split-a"] .script-form input+input').dispatchEvent(new Event('input',{bubbles:true}));`);
    await pause();await js(`document.querySelector('[data-project-controls="split-a"] .script-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);await pause();
    assert.equal(await js(`JSON.parse(localStorage.getItem('agente.projectScripts'))['project-a'][0].command`),'npm run dev');
    await js(`document.querySelector('[data-project-controls="split-a"] .branch-chip').click()`);await pause();
    assert.equal(await js(`!!document.querySelector('[data-project-controls="split-a"]')&&!!document.querySelector('.branch-menu')`),true,'Nested branch menu preserves its parent card');
    await js(`document.querySelector('.branch-menu [role="menuitem"]').click()`);await pause();
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    // Menu is available on the sidebar and the pane header.
    await js(`document.querySelector('.pane-head').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:550,clientY:90}))`); await pause();
    assert.ok(await js(`document.querySelector('[role="menu"]')?.textContent.includes('Open in a new window')`));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await win.webContents.debugger.attach('1.3');
    const divider = await js<{x:number;y:number}>(`(() => { const r=document.querySelector('.panes > .divider').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    const before = await js<number>(`document.querySelector('.pane').getBoundingClientRect().width`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...divider});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,x:divider.x+50,y:divider.y});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:divider.x+50,y:divider.y}); await pause();
    assert.ok(await js<number>(`document.querySelector('.pane').getBoundingClientRect().width`) > before+40, 'Real divider drag changes pane size');
    await writeFile('/tmp/agente-split-conversations.png',(await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('.pane:last-of-type .close').click()`); await pause();
    assert.equal(await js('document.querySelectorAll("[data-conversation-workspace]").length'), 1, 'Closing never reopens the pane');
    assert.equal(errors.length, 0, errors.join('\n'));
    // Test the actual IPC controls against two trusted windows.
    setMainWindow(win);
    let child: BrowserWindow | undefined;
    setConversationWindowFactory((chatId) => { assert.equal(chatId,'split-a'); child=new BrowserWindow({show:false}); return child; });
    let closed: BrowserWindow | null | undefined;
    registerWindowHandlers({ ipcMain, getMainWindow:()=>win, requestMainWindowClose:(target)=>{ closed=target; return{closed:true,prompted:false}; },setActiveWorkState:()=>{} });
    // A narrow isolated preload only exposes the trusted test's IPC calls.
    const preload = join(tmpdir(),'agente-split-window-preload.cjs');
    await writeFile(preload,`const { contextBridge, ipcRenderer }=require('electron');contextBridge.exposeInMainWorld('testIPC',{invoke:(channel,args)=>ipcRenderer.invoke(channel,args)});`);
    const caller=new BrowserWindow({show:false,webPreferences:{preload,sandbox:true,contextIsolation:true}});
    try {
      await caller.loadURL('data:text/html,window-test');
      const opened=await caller.webContents.executeJavaScript(`window.testIPC.invoke('window:open-conversation',{chatId:'split-a'})`);
      assert.equal(opened.windowId,child?.id);
      await caller.webContents.executeJavaScript(`window.testIPC.invoke('window:toggle-maximize')`);
      assert.equal(caller.isMaximized(),true); assert.equal(win.isMaximized(),false);
      await caller.webContents.executeJavaScript(`window.testIPC.invoke('window:request-close')`);
      assert.equal(closed,caller);
    } finally { caller.destroy(); child?.destroy(); }
    console.log('split-conversations smoke: ok (contained panels, narrow docks, focus, drafts, browser/canvas ownership, real resizing, close, window IPC, folder/project drops, metadata, script editor, nested menus)');
  } finally { win.destroy(); }
}
const deadline=setTimeout(()=>{console.error('split smoke timed out');app.exit(1)},60000);
run().finally(()=>clearTimeout(deadline)).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
