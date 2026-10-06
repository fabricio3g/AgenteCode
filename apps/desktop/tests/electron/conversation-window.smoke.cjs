// After build:main, run with the Vite dev renderer and an isolated real app profile.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const root = mkdtempSync(join(tmpdir(), 'agente-conversation-window-'));
for (const key of ['appData','home','userData']) { const path=join(root,key);mkdirSync(path);app.setPath(key,path); }
process.env.AGENTE_CONFIG_DIR=join(root,'core'); process.env.AGENTE_HOME=join(root,'runtime'); process.env.AGENTE_SMOKE_SOCKET=join(root,'runtime.sock');
const deadline=setTimeout(()=>{console.error('conversation-window smoke timed out');app.exit(1)},60000);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(test) { for(let i=0;i<200;i++){if(await test())return;await sleep(50)}throw new Error('Window did not reach expected state'); }
require(resolve('dist-electron/main/index.cjs'));
app.whenReady().then(async()=>{
  try {
    let first;
    await wait(()=>{first=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith('http:'));return first && !first.webContents.isLoading();});
    await wait(()=>first.webContents.executeJavaScript("document.documentElement.dataset.desktopReady === 'true'"));
    const errors=[];
    first.webContents.on('console-message',({level,message})=>{if(level==='error')errors.push(message)});
    await first.webContents.executeJavaScript(`(async()=>{
      const {appStore}=await import('/src/lib/stores/app.svelte.ts');
      const {codeStore}=await import('/src/lib/features/code/code.svelte.ts');
      const {saveCodeProjectToDb,saveChatStateToDb}=await import('/src/lib/utils/storage.ts');
      appStore.onboardingOpen=false;
      await window.electronAPI.invoke('update_config',{onboarding:{completed:true,completed_at:Date.now()}});
      const now=Date.now(),project={id:'window-project',rootName:'Window test',rootPath:${JSON.stringify(root)},createdAt:now,updatedAt:now};
      await saveCodeProjectToDb(project); await codeStore.load();
      const chat={id:'window-conversation',title:'Conversation in another window',projectId:project.id,contextMode:'code',createdAt:now,updatedAt:now,folderId:null,draft:'Keep this draft',messages:[{id:'window-prompt',role:'user',content:'Inspect the project',createdAt:now}],codeAgent:{instanceId:'agente',runtimeMode:'supervised'}};
      appStore.chats.push(chat); await saveChatStateToDb(chat); codeStore.openConversation(chat.id);
      const {openConversationWindow}=await import('/src/lib/features/shared/conversation-window.ts');await openConversationWindow(chat.id);
    })()`);
    let second;
    await wait(()=>{second=BrowserWindow.getAllWindows().find(win=>win!==first&&win.webContents.getURL().includes('conversation=window-conversation'));return second&&!second.webContents.isLoading();});
    await wait(()=>second.webContents.executeJavaScript("document.documentElement.dataset.desktopReady === 'true'"));
    await wait(()=>second.webContents.executeJavaScript("!!document.querySelector('[data-conversation-workspace=window-conversation] textarea')"));
    assert.equal(await second.webContents.executeJavaScript("document.querySelector('[data-conversation-workspace=window-conversation] textarea').value"),'Keep this draft');
    assert.equal(await second.webContents.executeJavaScript("document.querySelectorAll('[data-conversation-workspace]').length"),1);
    assert.equal(await first.webContents.executeJavaScript("document.querySelectorAll('[data-conversation-workspace]').length"),1);
    assert.equal(await second.webContents.executeJavaScript("(async()=>{const {appStore}=await import('/src/lib/stores/app.svelte.ts');return appStore.currentChatId})()"),'window-conversation');
    const originalSize=first.getBounds();
    await second.webContents.executeJavaScript("window.electronAPI.windowToggleMaximize()"); await sleep(100);
    assert.deepEqual(first.getBounds(),originalSize,'Second window controls leave the first alone');
    await second.webContents.executeJavaScript("window.electronAPI.windowToggleMaximize()");
    // Each registered renderer can reload after another app window is opened.
    first.reload(); await wait(()=>!first.webContents.isLoading());
    await wait(()=>first.webContents.executeJavaScript("document.documentElement.dataset.desktopReady === 'true'"));
    const closed=new Promise(resolve=>second.once('closed',resolve));
    await second.webContents.executeJavaScript("window.electronAPI.windowRequestClose()").catch(()=>{});await closed;
    assert.equal(first.isDestroyed(),false);
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('conversation-window smoke: ok (actual factory/preload, selected conversation, draft, independent centre, window controls, reload, close)');
    clearTimeout(deadline);app.exit(0);
  } catch(error) {console.error(error);clearTimeout(deadline);app.exit(1);}
});
