// Real composed layout at narrow pane widths, in both themes, with an isolated profile.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();app.setPath('userData',mkdtempSync(join(tmpdir(),'agente-layout-')));
async function run(){
  await app.whenReady();
  const win=new BrowserWindow({show:false,width:1800,height:820,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  const errors:string[]=[];win.webContents.on('console-message',({level,message})=>{if(level==='error'){errors.push(message);console.error(message);}});
  const js=<T>(source:string)=>win.webContents.executeJavaScript(source) as Promise<T>;
  const pause=async()=>{win.webContents.invalidate();await win.webContents.executeJavaScript('new Promise(resolve=>{const timer=setTimeout(resolve,100);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve()}))})');await new Promise(resolve=>setTimeout(resolve,150));await win.webContents.executeJavaScript('document.getAnimations().forEach(animation=>animation.finish())');};
  const out='/tmp/agente-visual-qa';mkdirSync(out,{recursive:true});
  const capture=async(name:string)=>{win.webContents.invalidate();await win.webContents.capturePage();await pause();await writeFile(join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  try{
    await win.loadURL(`${process.env.AGENTE_DEV_URL || 'http://127.0.0.1:5173'}/?mock=1`);
    for(let i=0;i<100;i++){if(await js("document.documentElement.dataset.desktopReady==='true'"))break;await pause();}
    await js(`(async()=>{
      const {appStore}=await import('/src/lib/stores/app.svelte.ts');const {codeStore}=await import('/src/lib/features/code/code.svelte.ts');const {accessibilityStore}=await import('/src/lib/stores/accessibility.svelte.ts');
      accessibilityStore.update({reduceMotion:'on'});appStore.sidebarOpen=true;appStore.onboardingOpen=false;
      const now=Date.now();const project={id:'qa-project',rootName:'Layout QA',rootPath:'/qa',createdAt:now,updatedAt:now};await window.electronAPI.invoke('chat_db_save_code_project',{project});codeStore.projects=[project];codeStore.loaded=true;
      for(const id of ['a','b'])appStore.chats.push({id:'qa-'+id,title:'Layout '+id,projectId:project.id,contextMode:'code',createdAt:now,updatedAt:now,folderId:null,draft:'',messages:[],codeAgent:{instanceId:'agente',runtimeMode:'supervised'},modelSelection:{backendMode:'api',provider:'deepseek',model:id==='a'?'deepseek-chat':'deepseek-reasoner',localModel:'',localModelPath:'',localBaseUrl:''}});
      codeStore.openConversation('qa-a');await new Promise(resolve=>setTimeout(resolve,100));const {workspaceLayout}=await import('/src/lib/stores/workspace-layout.svelte.ts');if(!workspaceLayout.splitWith('qa-b','right',{x:0,y:0,...workspaceLayout.centreSize}))throw new Error('split refused');codeStore.openConversation('qa-b');
    })()`);await pause();
    win.setSize(1150, 820);await pause();
    for(const theme of ['dark','light']){
      await js(`(async()=>{(await import('/src/lib/stores/theme.svelte.ts')).themeStore.set('${theme}');})()`);await pause();
      const fit=await js<Array<{width:number;overflow:boolean;columns:string;model:string}>>(`[...document.querySelectorAll('[data-conversation-workspace]')].map(section=>({width:section.getBoundingClientRect().width,pane:section.closest('.pane').getBoundingClientRect().width,paneStyle:section.closest('.pane').getAttribute('style'),computed:{w:getComputedStyle(section.closest('.pane')).width,min:getComputedStyle(section.closest('.pane')).minWidth,max:getComputedStyle(section.closest('.pane')).maxWidth,transform:getComputedStyle(section.closest('.pane')).transform,animations:section.closest('.pane').getAnimations().map(animation=>animation.effect.getKeyframes()),display:getComputedStyle(section.closest('.pane')).display},surface:section.querySelector('.code-surface').getBoundingClientRect().width,host:section.querySelector('.workspace').getBoundingClientRect().width,main:section.querySelector('.workspace-main').getBoundingClientRect().width,overflow:[...section.querySelectorAll('.composer-bar button,.composer-secondary button')].filter(button=>button.offsetWidth).some(button=>{const b=button.getBoundingClientRect(),r=section.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1;}),columns:getComputedStyle(section.querySelector('.starter-grid')).gridTemplateColumns,model:section.querySelector('.model-trigger').textContent.trim()}))`);
      assert.equal(fit.length,2);
      assert.equal(await js(`document.querySelectorAll('[data-conversation-workspace] .local-model-library').length`),0,'Cloud conversations never show local-model browsing');
      const buttonsSmall=await js<boolean>(`[...document.querySelectorAll('[data-conversation-workspace] .composer-bar button')].filter(button=>button.offsetWidth).every(button=>button.getBoundingClientRect().height<=25)`);assert.equal(buttonsSmall,true,'Composer controls use one compact size: '+JSON.stringify(await js(`[...document.querySelectorAll('[data-conversation-workspace] .composer-bar button')].filter(button=>button.offsetWidth).map(b=>({name:b.getAttribute('aria-label'),class:b.className,height:b.getBoundingClientRect().height}))`)));
      const aligned=await js<boolean>(`[...document.querySelectorAll('[data-conversation-header]')].every(header=>{const title=header.querySelector('.title').getBoundingClientRect(),middle=title.y+title.height/2;return [...header.querySelectorAll('button')].every(button=>{const r=button.getBoundingClientRect();return Math.abs(r.y+r.height/2-middle)<2;});})`);assert.equal(aligned,true,'Title, panel actions, and close share one header row');
      const divider=await js<{line:string;grip:string}>(`(()=>{const node=document.querySelector('.panes > .divider .resize-handle');return {line:getComputedStyle(node,'::after').backgroundColor,grip:getComputedStyle(node,'::before').opacity};})()`);assert.notEqual(divider.line,'rgba(0, 0, 0, 0)');assert.ok(Number(divider.grip)>0,'Split indicator stays visible at rest');assert.ok(fit.every(item=>!item.overflow),JSON.stringify(fit));await capture('layout-bug-'+theme);assert.ok(fit.every(item=>item.columns.split(' ').length===1),JSON.stringify(fit));assert.notEqual(fit[0].model,fit[1].model);
      await capture('code-narrow-'+theme);
      await js(`document.querySelector('[data-conversation-workspace="qa-a"] .mode-trigger').click()`);await pause();
      assert.ok(await js<boolean>(`(()=>{const probe=document.createElement('div');probe.style.borderRadius='var(--float-radius)';document.body.append(probe);const expected=getComputedStyle(probe).borderRadius;probe.remove();return getComputedStyle(document.querySelector('.mode-menu')).borderRadius===expected;})()`),'Mode menu shares the UI radius token');assert.ok(await js<number>(`document.querySelector('.mode-menu').getBoundingClientRect().width`)<=260);await capture('mode-menu-'+theme);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await pause();
      await js(`document.querySelector('[data-conversation-workspace="qa-a"] .model-trigger').click()`);await pause();
      assert.equal(await js('document.querySelectorAll(".model-modal-root").length'),1,'One split opens one model picker');
      await js(`document.querySelector('.model-modal-root [aria-label="Close"]').click()`);await pause();
      await js(`(async()=>{const {appStore}=await import('/src/lib/stores/app.svelte.ts');const chat=appStore.chats.find(chat=>chat.id==='qa-a');chat.messages=[{id:'qa-prompt',role:'user',content:'A long prompt with enough lines to demonstrate the actions sit below it without being clipped by the next message.',createdAt:Date.now(),metadata:{codeConversationIndex:0}},{id:'qa-reply',role:'assistant',content:'A reply follows the actions.',createdAt:Date.now()}];})()`);await pause();
      const actionFit=await js<boolean>(`(()=>{const action=document.querySelector('[data-conversation-workspace="qa-a"] .prompt-actions'),bubble=action.previousElementSibling;return action.getBoundingClientRect().top>=bubble.getBoundingClientRect().bottom-1;})()`);assert.equal(actionFit,true);await capture('code-actions-'+theme);
      await js(`(async()=>{const {appStore}=await import('/src/lib/stores/app.svelte.ts');appStore.chats.find(chat=>chat.id==='qa-a').messages=[];})()`);
    }
    await js(`(async()=>{const {appStore}=await import('/src/lib/stores/app.svelte.ts');appStore.chats.find(chat=>chat.id==='qa-a').modelSelection.backendMode='local';})()`);await pause();
    assert.equal(await js(`document.querySelectorAll('[data-conversation-workspace="qa-a"] .local-model-library').length`),1,'Local models get a library icon');
    assert.equal(await js(`document.querySelector('[data-conversation-workspace="qa-a"] .local-model-library').textContent.trim()`),'','Local library action stays icon-only');
    for(const space of ['home','roleplay','bots']){
      await js(`(async()=>{const {appStore}=await import('/src/lib/stores/app.svelte.ts');if('${space}'==='bots'){appStore.showBots();}else{appStore.createChat('${space}');}})()`);await pause();
      if(space==='bots')await js(`(async()=>{const {botsStore}=await import('/src/lib/features/bots/bots.svelte.ts');await botsStore.load();if(botsStore.bots.length)await botsStore.select(botsStore.bots[0].handle);botsStore.routinesOpen=false;})()`);
      for(const theme of ['dark','light']){
        await js(`(async()=>{(await import('/src/lib/stores/theme.svelte.ts')).themeStore.set('${theme}');})()`);await pause();
        const centered=await js<{delta:number;overflow:number}>(`(()=>{const main=document.querySelector('.workspace-main').getBoundingClientRect();const node=document.querySelector('${space==='home'?'.composer-shell':space==='roleplay'?'.library-shelf':'[data-bots-surface] .bot-transcript > div, [data-bots-surface] > div'}');if(!node)return {delta:999,overflow:999};const r=node.getBoundingClientRect();return{delta:Math.abs(r.x+r.width/2-(main.x+main.width/2)),overflow:Math.max(0,r.right-main.right,main.left-r.left)};})()`);
        assert.ok(centered.delta<3&&centered.overflow<2,space+':'+JSON.stringify(centered));await capture(space+'-'+theme);
      }
    }
    assert.equal(errors.length,0,errors.join('\n'));console.log('responsive-layout smoke: ok (narrow splits, separate model pickers, prompt actions, centered Home/Roleplay/Bots, light/dark)');
  }finally{win.destroy();}
}
const timer=setTimeout(()=>{console.error('layout smoke timed out');app.exit(1)},180000);run().finally(()=>clearTimeout(timer)).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
