/** Synthetic capture only: no microphone, network speech service or LLM calls. */
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
app.disableHardwareAcceleration();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-call-ui-')));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const deadline = setTimeout(() => app.exit(1), 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1000, height: 650, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await win.loadURL(process.env.AGENTE_RENDERER_URL ?? 'http://127.0.0.1:5173/?mock=1');
    const report = await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const ctx = new AudioContext(); await ctx.resume();
      let input;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable:true, value:async()=> { input = ctx.createMediaStreamDestination(); return input.stream; } });
      let requests = 0;
      window.electronAPI ??= {isElectron:true, invoke:async()=>({}), on:()=>()=>{}};
      const previousInvoke = window.electronAPI.invoke;
      window.electronAPI.invoke = async (channel,...args) => channel === 'stt_transcribe' ? (requests++, {text:requests === 1 ? 'Hello.' : 'How are you?'}) : previousInvoke(channel,...args);
      const { VoiceCall } = await import('/src/lib/features/chat/composer/voice-call.svelte.ts');
      let speech = 0, transcripts = [];
      const call = new VoiceCall({ onSpeech:()=>speech++, onText:text=>transcripts.push(text) });
      await call.start();
      const noise = ctx.createBufferSource(); const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      let random = 123; const samples = buffer.getChannelData(0);
      for(let i=0;i<samples.length;i++) { random=(1664525*random+1013904223)>>>0; samples[i]=(random/4294967296-.5)*.12; }
      noise.buffer=buffer; noise.loop=true; noise.connect(input); noise.start();
      await wait(1300);
      if (speech || requests || !call.noise) throw new Error('Noise triggered speech or transcription');
      noise.stop();
      const speak = async () => {
        const oscillators = [];
        for(let i=1;i<=8;i++) { const oscillator=ctx.createOscillator(); const gain=ctx.createGain(); gain.gain.value=.015; oscillator.frequency.value=180*i; oscillator.connect(gain); gain.connect(input); oscillator.start(); oscillators.push(oscillator); }
        await wait(650); oscillators.forEach(oscillator=>oscillator.stop());
      };
      await speak(); await wait(850);
      if(transcripts.length) throw new Error('A hesitation sent an incomplete prompt');
      await speak(); await wait(2600);
      if (speech !== 2 || requests !== 2 || transcripts.length !== 1 || transcripts[0] !== 'Hello. How are you?') throw new Error('Spoken parts were not combined: '+JSON.stringify({speech,requests,transcripts}));
      call.stop();
      const { mount, tick, unmount } = await import('/node_modules/.vite/deps/svelte.js');
      const { appStore } = await import('/src/lib/stores/app.svelte.ts');
      const { default: Panel } = await import('/src/lib/features/chat/composer/VoiceCallPanel.svelte');
      appStore.onboardingOpen=false; appStore.createChat('home'); appStore.setComposerMode('instant'); appStore.config={...appStore.config,tts:{...appStore.config.tts,backend_mode:'browser'}};
      const root=document.createElement('div'); root.style.cssText='position:fixed;top:80px;left:40px;width:720px;z-index:100000;background:var(--background);padding:12px'; document.body.append(root);
      const mounted=mount(Panel,{target:root,props:{onend:()=>{}}}); await tick(); await wait(100);
      const layouts=[];
      for (const dark of [false,true]) { document.documentElement.classList.toggle('dark',dark); for(const width of [720,300]) { root.style.width=width+'px'; await tick(); const panel=root.querySelector('.call-panel'); const rect=panel.getBoundingClientRect(); if(rect.height>70) throw new Error('Call controls still use a large card'); if(panel.scrollWidth>panel.clientWidth) throw new Error('Call controls overflow narrow layout'); if(panel.querySelectorAll('button').length!==4) throw new Error('Duplicate call controls'); layouts.push({dark,width,height:rect.height}); } }
      root.style.width='720px'; document.body.replaceChildren(root); await tick(); await wait(250);
      window.__voiceSmokeCleanup=async()=>{await unmount(mounted);root.remove();await ctx.close();};
      return {speech,requests,transcripts,layouts};
    })()`);
    assert.equal(report.requests, 2);
    console.log('voice-call smoke:', JSON.stringify(report));
    await new Promise(resolve=>setTimeout(resolve,250));
    writeFileSync('/tmp/agente-compact-call.png', (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('window.__voiceSmokeCleanup()');
  } finally { clearTimeout(deadline); win.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
