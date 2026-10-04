/** Actual Electron navigation costs with synthetic conversations, no provider calls. */
import { app, BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-navigation-')));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
 const win = new BrowserWindow({ width: 1200, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 try {
  await win.loadURL('http://127.0.0.1:5174/?mock=1');
  const report = await win.webContents.executeJavaScript(`(async () => {
   const {appStore}=await import(performance.getEntriesByType('resource').map(entry=>entry.name).find(url=>new URL(url).pathname==='/src/lib/stores/app.svelte.ts')||'/src/lib/stores/app.svelte.ts');
   const {codeStore}=await import(performance.getEntriesByType('resource').map(entry=>entry.name).find(url=>new URL(url).pathname==='/src/lib/features/code/code.svelte.ts')||'/src/lib/features/code/code.svelte.ts');
   const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
   for(let i=0;!appStore.ready&&i<400;i++)await new Promise(resolve=>setTimeout(resolve,50));
   if(!appStore.ready)throw new Error('Bootstrap timed out');
   await codeStore.load();
   codeStore.projects.push({id:'nav-project',rootPath:'/tmp',rootName:'tmp',createdAt:1,updatedAt:1});
   for(const mode of ['home','code'])appStore.chats.push({id:'nav-'+mode,title:'Navigation '+mode,contextMode:mode,projectId:mode==='code'?'nav-project':undefined,createdAt:1,updatedAt:1,folderId:null,draft:'',searchMode:'chat',composerMode:'agent',messages:Array.from({length:100},(_,i)=>({id:mode+i,role:i%2?'assistant':'user',content:('Readable **evidence**.\\n\\n').repeat(30),createdAt:i+1,done:true,status:'idle'}))});
   appStore.selectChat('nav-home');await frame();await frame();
   appStore.selectChat('nav-code');await frame();await frame();
   const invoke=window.electronAPI.invoke;let saves=0;
   window.electronAPI.invoke=(command,args)=>{if(command==='chat_db_save_session')saves++;return invoke(command,args);};
   const persist=appStore.persist;const rows=[];
   for(const legacy of [true,false]){
    appStore.persist=function(options){return persist.call(this,legacy?undefined:options);};
    saves=0;const timings=[];
    for(let i=0;i<12;i++){const start=performance.now();appStore.selectChat('nav-'+(i%2?'home':'code'));await frame();await frame();timings.push(performance.now()-start);}
    timings.sort((a,b)=>a-b);rows.push({mode:legacy?'full-save-on-switch':'navigation-only',p50Ms:timings[6],p95Ms:timings[11],transcriptSaves:saves});
   }
   appStore.persist=persist;window.electronAPI.invoke=invoke;
   if(rows[0].transcriptSaves!==12)throw new Error('Save benchmark did not exercise SQLite IPC');
   if(rows[1].transcriptSaves!==0)throw new Error('Navigation resaved unchanged transcripts');
   if(appStore.currentChat.id!=='nav-home')throw new Error('Wrong conversation selected');
   const viewport=document.getElementById('conversation-message-scroll');
   if(!viewport)throw new Error('Conversation viewport missing');
   viewport.scrollTop=0;viewport.dispatchEvent(new Event('scroll'));
   const first=document.querySelector('.message-slot');
   for(let i=0;i<30&&!first?.textContent.includes('Readable');i++)await frame();
   if(!first?.textContent.includes('Readable'))throw new Error('Older history did not reveal on scroll');
   const retained=first.querySelector('article');
   viewport.scrollTop=viewport.scrollHeight;viewport.dispatchEvent(new Event('scroll'));await frame();await frame();
   if(retained&&first.querySelector('article')!==retained)throw new Error('Revealed history was destroyed');
   for(const open of [false,true]){
    appStore.sidebarOpen=open;await frame();
    const outer=document.querySelector('.sidebar-outer');const sidebar=document.getElementById('app-sidebar');
    if(!outer||!sidebar)throw new Error('Sidebar missing');
    if(getComputedStyle(outer).transitionDuration!=='0s'||getComputedStyle(sidebar).transitionDuration!=='0s')throw new Error('Sidebar still animates');
    if(!open&&(outer.getBoundingClientRect().width!==0||getComputedStyle(sidebar).visibility!=='hidden'))throw new Error('Sidebar ghost remains after closing');
   }
   return {messagesPerChat:100,switchesPerMode:12,results:rows,historyRevealsAndSurvives:true,sidebarImmediate:true};
  })()`);
  console.log('PASS:', JSON.stringify(report));
 } catch(error) { console.error(error); process.exitCode=1; }
 finally { win.destroy(); app.exit(process.exitCode||0); }
});
