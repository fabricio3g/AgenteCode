// Real isolated overlay windows, kept hidden: this test never captures or
// operates the user's desktop. No model, permission grant or native input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { ComputerOverlayWindows } from '../../main/computer/overlay.ts';
import type { ComputerState } from '../../shared/computer.ts';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
const profile = path.join(process.cwd(), '.tmp', 'computer-overlay-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
app.setAppPath(process.cwd());
async function run() {
  await app.whenReady();
  const overlay = new ComputerOverlayWindows({ visible: false });
  const controls: string[] = [];
  ipcMain.handle('computer_overlay_ready', () => overlay.send());
  ipcMain.handle('computer_control', (event, { action }) => { assert.ok(overlay.isBar(event.sender)); controls.push(action); return { ok: true }; });
  const state: ComputerState = { phase: 'active', chatId: 'test', space: 'code', task: 'Test app', activity: 'Opening Settings', actions: 1, canResume: false, startedAt: Date.now(), pointer: { x: 150, y: 160 } };
  try {
    await overlay.present(state);
    const windows = BrowserWindow.getAllWindows().filter(win => win.getTitle().startsWith('Agente computer'));
    assert.equal(windows.length, screen.getAllDisplays().length + 1);
    const bar = windows.find(win => overlay.isBar(win.webContents))!;
    for (const win of windows) {
      assert.equal(win.isFocusable(), false); assert.equal(win.isAlwaysOnTop(), true); assert.equal(win.isVisible(), false);
    }
    const read = () => bar.webContents.executeJavaScript(`({status:document.querySelector('#status').textContent,activity:document.querySelector('#activity').textContent,takeover:!document.querySelector('#takeover').hidden,resume:!document.querySelector('#resume').hidden,disabled:document.querySelector('#resume').disabled})`);
    console.log('Overlay document:', await bar.webContents.executeJavaScript(`({bridge:typeof window.computerOverlay,status:document.querySelector('#status')?.textContent})`));
    // IPC delivery is async; wait on a DOM condition rather than a blind delay.
    await bar.webContents.executeJavaScript(`new Promise(resolve=>{const poll=()=>document.querySelector('#status')?.textContent==='Agente is using your computer'?resolve(true):setTimeout(poll,10);poll();})`);
    assert.equal((await read()).takeover, true);
    assert.match((await read()).activity, /Opening Settings/);
    await bar.webContents.executeJavaScript(`document.querySelector('#takeover').click()`);
    assert.deepEqual(controls, ['takeover']);
    await overlay.present({ ...state, phase: 'paused', canResume: true, pointer: undefined });
    await bar.webContents.executeJavaScript(`new Promise(resolve=>{const poll=()=>document.querySelector('#resume')?.hidden===false?resolve(true):setTimeout(poll,10);poll();})`);
    const paused = await read();
    assert.equal(paused.status, "You're in control"); assert.equal(paused.disabled, false); assert.equal(paused.takeover, false);
    await bar.webContents.executeJavaScript(`document.querySelector('#resume').click()`);
    assert.deepEqual(controls, ['takeover', 'resume']);
    await bar.webContents.executeJavaScript(`document.querySelector('#end').click()`);
    assert.deepEqual(controls, ['takeover', 'resume', 'end']);
    assert.ok(overlay.barBounds());
    overlay.dismiss();
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log('Computer overlay smoke passed: all displays, isolated preload, non-focusable windows, activity, takeover/resume/end, cleanup.');
  } finally { overlay.dismiss(); }
}
run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
