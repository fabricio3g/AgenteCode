/** Real Electron Code rendering and streaming costs; all prompts are scripted. */
import { app, BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
app.setPath('userData',mkdtempSync(join(tmpdir(),'agente-code-render-')));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1200,height:850,show:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 try {
  await win.loadURL('http://127.0.0.1:5174/?mock=1');
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Performance.enable');
  const report=await win.webContents.executeJavaScript(`(async()=>{
   const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
   const {appStore}=await import('/src/lib/stores/app.svelte.ts');
   for(let i=0;!appStore.ready&&i<400;i++)await new Promise(resolve=>setTimeout(resolve,50));
   if(!appStore.ready)throw new Error('Bootstrap timed out');
   const {mount,unmount}=await import('/node_modules/.vite/deps/svelte.js');
   const {default:Transcript}=await import('/src/lib/features/code/CodeTranscript.svelte');
   const target=document.createElement('div');target.style.cssText='position:fixed;inset:24px;display:flex;flex-direction:column;z-index:10;background:#202020';document.body.appendChild(target);
   const content=('### Evidence\\n\\nA **precise** finding with enough text to wrap and a source.\\n\\n- first finding\\n- second finding\\n\\n').repeat(8);
   const messages=Array.from({length:400},(_,i)=>({id:'render-'+i,role:'assistant',content,createdAt:i+1,done:true,status:'idle'}));
   const transcript=mount(Transcript,{target,props:{messages,chatId:'render-fixture'}});
   await frame();await frame();await document.fonts.ready;
   const scroll=target.querySelector('.overflow-y-auto');if(!scroll)throw new Error('Transcript viewport missing');
   if(target.querySelectorAll('.code-message-slot').length!==400)throw new Error('Messages lost');
   const rows=[];
   for(const visible of [true,false]){
    for(const slot of target.querySelectorAll('.code-message-slot'))slot.style.contentVisibility=visible?'visible':'auto';
    scroll.scrollTop=scroll.scrollHeight;await frame();await frame();
    const intervals=[];let last=performance.now();
    for(let i=0;i<60;i++){scroll.scrollTop=(scroll.scrollHeight-scroll.clientHeight)*(1-i/60);scroll.dispatchEvent(new Event('scroll'));await frame();const now=performance.now();intervals.push(now-last);last=now;}
    intervals.sort((a,b)=>a-b);rows.push({containment:visible?'disabled':'enabled',p50Ms:intervals[30],p95Ms:intervals[57],slowFrames:intervals.filter(ms=>ms>34).length});
   }
   await unmount(transcript);target.remove();
   const callbacks=[];const oldOn=window.electronAPI.on;window.electronAPI.on=(name,callback)=>{if(name==='code_agent_event')callbacks.push(callback);return oldOn(name,callback);};
   const oldInvoke=window.electronAPI.invoke;window.electronAPI.invoke=(name,args)=>name==='agente_start_session'?Promise.resolve({sessionId:'render-session',resumed:false}):['agente_prompt','agente_set_model'].includes(name)?Promise.resolve({ok:true}):oldInvoke(name,args);
   const {codeStore}=await import('/src/lib/features/code/code.svelte.ts');
   const chat={id:'stream-fixture',title:'Stream',contextMode:'code',projectId:'stream-project',messages:[],draft:'',createdAt:1,updatedAt:1,codeAgent:{runtimeMode:'supervised',instanceId:'agente',driverKind:'agente',substrate:'native',updatedAt:1}};
   appStore.chats.push(chat);codeStore.projects.push({id:'stream-project',rootPath:'/tmp',rootName:'tmp',createdAt:1,updatedAt:1});await codeStore.send(chat.id,'Synthetic fixture');
   if(!callbacks.length||!codeStore.runFor(chat.id)?.running)throw new Error('Streaming fixture did not start');
   const emit=event=>callbacks.forEach(callback=>callback({chatId:chat.id,...event}));
   for(let i=0;i<8;i++){emit({type:'runtime_event',event:{type:'child_started',run_id:'child-'+i,kind:'explore',description:'Fixture'}});emit({type:'runtime_event',parentRunId:'child-'+i,event:{type:'assistant_delta',text:'evidence '.repeat(3600)}});}
   const run=codeStore.runFor(chat.id);const oldSnapshot=JSON.parse(JSON.stringify(run.children));
   const costs=[];
   for(const duplicate of [true,false]){const start=performance.now();for(let i=0;i<500;i++){emit({type:'text_delta',delta:'x'});if(duplicate)structuredClone(oldSnapshot);}costs.push({duplicateChildrenPerToken:duplicate,events:500,elapsedMs:performance.now()-start});}
   emit({type:'agent_end',stopReason:'stop'});
   const saved=appStore.findChat(chat.id).messages.at(-1);
   if(saved.metadata.codeChildren.length!==8||saved.content.length!==1000)throw new Error('Final streaming snapshot lost content');
   const {default:RichContent}=await import('/src/lib/ui/components/RichContent.svelte');
   const liveMessage=appStore.findChat(chat.id).messages.at(-1);
   const markdownCosts=[];
   for(const mode of ['idle','streaming']){
    liveMessage.status=mode;liveMessage.content=content.repeat(12)+'Growing tail';
    const root=document.createElement('div');root.style.cssText='position:fixed;inset:24px;overflow:auto;background:var(--background);z-index:20';document.body.appendChild(root);
    const view=mount(RichContent,{target:root,props:{get content(){return liveMessage.content;},get status(){return liveMessage.status;}}});
    await frame();await frame();
    const first=root.querySelector('h3');const intervals=[];let last=performance.now();
    for(let i=0;i<90;i++){liveMessage.content+=' more evidence';await frame();const now=performance.now();intervals.push(now-last);last=now;}
    const stablePrefix=root.querySelector('h3')===first;
    intervals.sort((a,b)=>a-b);markdownCosts.push({mode,p50Ms:intervals[45],p95Ms:intervals[85],stablePrefix});
    if(mode==='streaming'&&!stablePrefix)throw new Error('Streaming replaced settled markdown DOM');
    liveMessage.status='idle';await frame();await frame();
    if(!root.textContent.includes('more evidence'))throw new Error('Final markdown lost tail');
    await unmount(view);root.remove();
   }
   return {messages:400,scroll:rows,stream:costs,markdown:markdownCosts,fullFinalSnapshot:true};
  })()`);
  console.log('PASS:',JSON.stringify(report));
 }catch(error){console.error(error);process.exitCode=1;}finally{win.destroy();app.exit(process.exitCode||0);}
});
