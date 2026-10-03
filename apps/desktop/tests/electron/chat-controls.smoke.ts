/** Real Electron clipboard and rendered attachment/compaction controls; no paid API calls. */
import { app, BrowserWindow, clipboard, ipcMain } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { registerWindowHandlers } from '../../main/ipc/window-handlers';
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-controls-')));
app.disableHardwareAcceleration();
async function run() {
 await app.whenReady();
 const win = new BrowserWindow({ width: 1100, height: 850, show: true, webPreferences: { preload: resolve('tests/electron/chat-controls-preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
 registerWindowHandlers({ ipcMain, getMainWindow: () => win, requestMainWindowClose: () => ({ closed: false, prompted: false }), setActiveWorkState: () => undefined });
 win.webContents.on('console-message', event => console.log('renderer:', event.message));
 try {
  await win.loadURL('http://127.0.0.1:5174/?mock=1');
  const report = await win.webContents.executeJavaScript(`(async () => {
   const wait = async test => { for(let i=0;i<200;i++){if(test())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Controls UI timed out'); };
   await wait(() => window.electronAPI); console.log('fixture bridge ready');
   const oldInvoke = window.electronAPI.invoke;
   window.electronAPI.invoke = (command,args) => command === 'clipboard_write' ? window.chatControlsTest.invoke(command,args) : command === 'agente_media_preview' ? Promise.resolve('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8WQAAAAASUVORK5CYII=') : oldInvoke(command,args);
   const { mount, unmount } = await import('/node_modules/.vite/deps/svelte.js');
   const { default: Transcript } = await import('/src/lib/features/code/CodeTranscript.svelte');
   const { default: Settings } = await import('/src/lib/features/code/CodeProjectDialog.svelte');
   const { appStore } = await import('/src/lib/stores/app.svelte.ts');
   await wait(() => appStore.ready); console.log('fixture store ready');
   const target = document.createElement('div'); target.style.cssText='position:fixed;inset:24px;background:var(--background);z-index:10;padding:24px;display:flex;flex-direction:column';document.body.appendChild(target);
   const text = 'Copied intact: café 日本語 '+ 'complete evidence '.repeat(1000);
   const transcript = mount(Transcript, { target, props: { chatId:'fixture-controls', messages:[
    {id:'image',role:'user',content:'Screenshot evidence',createdAt:1,done:true,metadata:{codeAttachments:[{kind:'image',path:'/stored/evidence.png',name:'evidence.png',mime:'image/png',bytes:1024}]}},
    {id:'answer',role:'assistant',content:text,createdAt:2,done:true,status:'idle'},
    {id:'report',role:'assistant',content:'',createdAt:3,done:true,metadata:{codeCompaction:{running:false,success:true,tokensBefore:12000,tokensAfter:4000,requestedSmart:true,smart:true,modelTokens:800}}}
   ] }});
   await wait(()=>target.querySelector('img[alt="evidence.png"]')); console.log('fixture thumbnail ready');
   await wait(()=>target.textContent.includes('800')); console.log('fixture report ready');
   const copy = [...target.querySelectorAll('button')].find(b=>b.textContent.trim()==='Copy' && b.closest('.group')?.textContent.includes('Copied intact'));
   if(!copy) throw new Error('Assistant Copy button missing'); copy.click();
   await new Promise(r=>setTimeout(r,150));
   await unmount(transcript);
   target.remove();
   const settingsTarget=document.createElement('div');document.body.appendChild(settingsTarget);
   mount(Settings,{target:settingsTarget,props:{chatId:'fixture-controls',section:'settings',onclose:()=>{}}});
   await wait(()=>document.body.textContent.includes('Trim locally'));
   if(!document.body.textContent.includes('Compact now'))throw new Error('Manual compaction missing');
   return { thumbnail:true, tokenReport:true, compactionControls:true, expectedClipboard:text };
  })()`);
  if (clipboard.readText() !== report.expectedClipboard) throw new Error('Native clipboard truncated or changed the message');
  delete report.expectedClipboard;
  await new Promise(resolve => setTimeout(resolve, 700));
  win.webContents.debugger.attach('1.3');
  const screenshot = await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png'});
  writeFileSync('/tmp/agente-chat-controls.png',Buffer.from(screenshot.data,'base64'));
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await win.webContents.executeJavaScript("import('/src/lib/stores/theme.svelte.ts').then(({themeStore}) => themeStore.set('light'))");
  await new Promise(resolve => setTimeout(resolve, 400));
  const light = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/agente-chat-controls-light.png', Buffer.from(light.data, 'base64'));
  console.log('PASS:',JSON.stringify({...report,nativeClipboard:true,lightAndReducedMotion:true}));
 } finally { win.destroy();app.quit(); }
}
run().catch(error=>{console.error(error);app.exit(1);});
