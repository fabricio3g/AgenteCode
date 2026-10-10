/** Reference dialog buttons and neutral chat fields, in real Chromium. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'agente-ui-primitives-')));
app.disableHardwareAcceleration();
async function run() {
  await app.whenReady();
  const out = process.env.AGENTE_UI_OUTPUT || '/tmp/agente-ui-reference'; fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 700, height: 480, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message); });
  const js = (code: string) => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(`${process.env.AGENTE_DEV_URL || 'http://127.0.0.1:5178'}/tests/ingestion-harness.html`);
    await js(`(async()=>{
      await import('/src/app.css'); await import('/src/lib/i18n/index.ts');
      const {locale}=await import('/node_modules/.vite/deps/svelte-i18n.js');locale.set('es');
      const {mount,unmount}=await import('/node_modules/.vite/deps/svelte.js');
      const {default:Composer}=await import('/tests/fixtures/ComposerAppearance.svelte');
      const {default:Confirm}=await import('/src/lib/components/layout/ConfirmDialog.svelte');
      const {confirmStore}=await import('/src/lib/stores/confirm.svelte.ts');
      document.body.style='margin:0;display:grid;place-items:center;height:100vh';
      document.body.innerHTML='<main id="fixture"></main>';
      const composer=mount(Composer,{target:document.getElementById('fixture')});
      const confirm=mount(Confirm,{target:document.getElementById('fixture')});
      window.fixture={composer,confirm,mount,unmount,confirmStore,confirmed:0,cancelled:0};
    })()`);
    for (const profile of [{ name: 'light', dark: false, scale: 1, width: 700 }, { name: 'dark', dark: true, scale: 1, width: 700 }, { name: 'large-text', dark: false, scale: 2, width: 440 }]) {
      win.setSize(profile.width, 480);
      await js(`document.documentElement.classList.toggle('dark',${profile.dark});document.documentElement.style.setProperty('--reading-scale','${profile.scale}');`);
      await js('new Promise(resolve=>setTimeout(resolve,200))');
      await js('document.getAnimations().forEach(animation=>animation.finish())');
      const input = await js(`(async()=>{
        const text=document.querySelector('textarea');text.blur();const shell=document.querySelector('.ui-composer');
        const before=getComputedStyle(shell).boxShadow;text.focus();await new Promise(r=>setTimeout(r,30));
        const style=getComputedStyle(text);return{border:style.borderTopWidth,shadow:style.boxShadow,background:style.backgroundColor,outline:style.outlineWidth,stable:before===getComputedStyle(shell).boxShadow};
      })()`);
      assert.equal(input.border, '0px'); assert.equal(input.shadow, 'none'); assert.equal(input.background, 'rgba(0, 0, 0, 0)'); assert.equal(input.outline, '0px'); assert.equal(input.stable, true);
      await js(`window.fixture.confirmStore.show({title:'¿Eliminar chat?',message:'“Nuevo chat” — Esta acción no se puede deshacer.',cancelLabel:'Cancelar',confirmLabel:'Eliminar',danger:true,onConfirm:()=>window.fixture.confirmed++,onCancel:()=>window.fixture.cancelled++});`);
      await js('new Promise(resolve=>setTimeout(resolve,150))');
      await js('document.getAnimations().forEach(animation=>animation.finish())');
      const actions = await js(`(()=>{
        const dialog=document.querySelector('[role=alertdialog]'),buttons=[...dialog.querySelectorAll('button')],rect=dialog.getBoundingClientRect();
        return buttons.map(b=>{const s=getComputedStyle(b),r=b.getBoundingClientRect();return{text:b.textContent.trim(),height:r.height,bg:s.backgroundColor,fg:s.color,border:s.borderTopWidth,fits:r.left>=rect.left&&r.right<=rect.right};});
      })()`);
      assert.equal(actions.length, 2); assert.equal(actions[0].text, 'Cancelar'); assert.equal(actions[1].text, 'Eliminar'); assert.equal(actions[0].height, actions[1].height);
      assert.equal(actions[0].border, '1px'); assert.equal(actions[1].bg, 'rgb(220, 38, 38)'); assert.equal(actions[1].fg, 'rgb(255, 255, 255)'); assert.ok(actions.every((a: { fits: boolean }) => a.fits));
      win.webContents.invalidate(); fs.writeFileSync(path.join(out, `confirmation-${profile.name}.png`), (await win.webContents.capturePage()).toPNG());
      await js('document.querySelector("[role=alertdialog] button").click()');
      await js('new Promise(resolve=>setTimeout(resolve,150))');
    }
    const results = await js('({confirmed:window.fixture.confirmed,cancelled:window.fixture.cancelled})');
    assert.deepEqual(results, { confirmed: 0, cancelled: 3 }); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'validation.json'), JSON.stringify({ profiles: 3, dialogActions: true, borderlessComposer: true, callbacks: results }, null, 2));
    console.log(JSON.stringify({ status: 'passed', output: out, profiles: 3 }));
  } finally { win.destroy(); }
}
const timer = setTimeout(() => app.exit(1), 120_000);
run().finally(() => clearTimeout(timer)).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
