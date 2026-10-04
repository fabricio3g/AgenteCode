/** Run after build:main, with the Vite dev server on port 5173:
 * electron --no-sandbox tests/electron/startup-zoom.smoke.cjs
 * Starts the actual application with an isolated profile and runtime socket.
 */
const { app, BrowserWindow, WebContentsView } = require('electron');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const root = mkdtempSync(join(tmpdir(), 'agente-startup-zoom-'));
for (const name of ['appData', 'home', 'userData']) { const path = join(root, name); mkdirSync(path); app.setPath(name, path); }
process.env.AGENTE_CONFIG_DIR = join(root, 'core');
process.env.AGENTE_HOME = join(root, 'runtime');
process.env.AGENTE_SMOKE_SOCKET = process.platform === 'win32' ? `\\\\.\\pipe\\agente-zoom-${root.split(/[\\/]/).pop()}` : join(root, 'runtime.sock');
const deadline = setTimeout(() => { console.error('FAIL: application startup timed out'); app.exit(1); }, 45000);
let exitCode = 0;
app.once('will-quit', () => app.exit(exitCode));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async test => { for (let i = 0; i < 200; i++) { if (await test()) return; await sleep(50); } throw new Error('Application or zoom did not reach expected state'); };
require(resolve('dist-electron/main/index.cjs'));
app.whenReady().then(async () => {
 try {
  let win;
  await wait(() => { win = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().startsWith('devtools:')); return win && !win.webContents.isLoading() && win.webContents.getURL().startsWith('http:'); });
  const waitForRenderer = () => wait(() => win.webContents.executeJavaScript("document.documentElement.dataset.desktopReady === 'true'"));
  await waitForRenderer();
  await win.webContents.executeJavaScript(`window.electronAPI.invoke('update_config', {onboarding:{completed:true,completed_at:Date.now()}})`);
  await win.webContents.executeJavaScript("localStorage.setItem('agente_accessibility', JSON.stringify({uiScale:1.25}));");
  win.reload(); await wait(() => !win.webContents.isLoading());
  await waitForRenderer();
  await wait(() => Math.abs(win.webContents.getZoomFactor() - 1.25) < 0.001);
  win.focus();
  win.webContents.sendInputEvent({ type:'keyDown', keyCode:'=', modifiers:['control'] });
  win.webContents.sendInputEvent({ type:'keyUp', keyCode:'=', modifiers:['control'] });
  await wait(() => Math.abs(win.webContents.getZoomFactor() - 1.5) < 0.001);
  const scale = await win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('agente_accessibility')).uiScale");
  assert.equal(scale, 1.5);
  win.reload(); await wait(() => !win.webContents.isLoading());
  await waitForRenderer();
  await wait(() => Math.abs(win.webContents.getZoomFactor() - 1.5) < 0.001);
  win.webContents.sendInputEvent({ type:'keyDown', keyCode:'-', modifiers:['control'] });
  win.webContents.sendInputEvent({ type:'keyUp', keyCode:'-', modifiers:['control'] });
  await wait(() => Math.abs(win.webContents.getZoomFactor() - 1.25) < 0.001);
  win.webContents.sendInputEvent({ type:'keyDown', keyCode:'0', modifiers:['control'] });
  win.webContents.sendInputEvent({ type:'keyUp', keyCode:'0', modifiers:['control'] });
  await wait(() => Math.abs(win.webContents.getZoomFactor() - 1) < 0.001);
  assert.equal(await win.webContents.executeJavaScript("!!document.querySelector('[data-desktop-shell]')"), true);
  for (const theme of ['light', 'dark']) {
    const color = theme === 'light' ? '#ffffff' : '#161616';
    await win.webContents.executeJavaScript(`(async () => { const { themeStore } = await import('/src/lib/stores/theme.svelte.ts'); themeStore.set('${theme}'); })()`);
    await wait(async () => (await win.webContents.executeJavaScript("getComputedStyle(document.documentElement).backgroundColor")) === (theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(22, 22, 22)'));
    await wait(() => win.getBackgroundColor().toLowerCase().includes(color.slice(1)));
    win.reload(); await wait(() => !win.webContents.isLoading()); await waitForRenderer();
    assert.equal(await win.webContents.executeJavaScript("document.documentElement.classList.contains('dark')"), theme === 'dark');
    assert.ok(win.getBackgroundColor().toLowerCase().includes(color.slice(1)));
  }
  const server = createServer((_req, response) => { response.setHeader('content-type', 'text/html'); response.end('<title>Overlap fixture</title><input id="preserved" value="keep this page">'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await win.webContents.executeJavaScript(`(async () => { const { appStore } = await import(performance.getEntriesByType('resource').map(entry => entry.name).findLast(url => new URL(url).pathname === '/src/lib/stores/app.svelte.ts') || '/src/lib/stores/app.svelte.ts'); appStore.onboardingOpen = false; appStore.setActiveSpace('home'); appStore.createChat('home'); })()`);
    await win.webContents.executeJavaScript(`document.querySelector('[role=dialog] button')?.click()`);
    await sleep(100);
    await win.webContents.executeJavaScript(`(async () => { const { browserPanelStore } = await import(performance.getEntriesByType('resource').map(entry => entry.name).findLast(url => new URL(url).pathname === '/src/lib/stores/browser-panel.svelte.ts') || '/src/lib/stores/browser-panel.svelte.ts'); await browserPanelStore.openUrl('http://127.0.0.1:${server.address().port}/'); })()`);
    let view;
    console.log('native browser fixture:', await win.webContents.executeJavaScript(`(async () => { const { browserPanelStore } = await import(performance.getEntriesByType('resource').map(entry => entry.name).findLast(url => new URL(url).pathname === '/src/lib/stores/browser-panel.svelte.ts') || '/src/lib/stores/browser-panel.svelte.ts'); return {scope:browserPanelStore.scope,open:browserPanelStore.open,tabs:browserPanelStore.tabs.length,panels:document.querySelectorAll('[data-workspace-panel=browser]:not([hidden])').length}; })()`));
    await wait(() => { view = win.contentView.children.find(child => child instanceof WebContentsView && child.getVisible()); return !!view && !view.webContents.isLoading(); });
    const guestId = view.webContents.id;
    await win.webContents.executeJavaScript(`(async () => { const { appStore } = await import(performance.getEntriesByType('resource').map(entry => entry.name).findLast(url => new URL(url).pathname === '/src/lib/stores/app.svelte.ts') || '/src/lib/stores/app.svelte.ts'); appStore.openSettings('general'); })()`);
    await wait(() => !view.getVisible());
    await win.webContents.executeJavaScript(`(async () => { const { appStore } = await import(performance.getEntriesByType('resource').map(entry => entry.name).findLast(url => new URL(url).pathname === '/src/lib/stores/app.svelte.ts') || '/src/lib/stores/app.svelte.ts'); appStore.closeSettings(); })()`);
    await wait(() => view.getVisible());
    assert.equal(view.webContents.id, guestId);
    assert.equal(await view.webContents.executeJavaScript("document.getElementById('preserved').value"), 'keep this page');
  } finally { server.closeAllConnections(); server.close(); }
  console.log('PASS: actual application startup, saved 125% scale, keyboard zoom in/out/reset, reload persistence, synchronized light/dark colors, native browser/settings overlap and preserved page');
  clearTimeout(deadline); app.quit();
 } catch (error) { console.error(error); for (const w of BrowserWindow.getAllWindows()) { console.log('views', w.contentView.children.map(v=>({visible:v.getVisible(),bounds:v.getBounds(),url:v.webContents?.getURL()}))); console.log('workspace ancestors', await w.webContents.executeJavaScript(`(() => {let n=document.querySelector('.workspace');const a=[];while(n){a.push({class:n.className,rect:JSON.stringify(n.getBoundingClientRect().toJSON()),display:getComputedStyle(n).display,flex:getComputedStyle(n).flex});n=n.parentElement;}return a})()`).catch(()=>null)); console.log('overlays', await w.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-workspace-panel], [data-overlay], .sidebar-view-full.preview, [role=dialog], [role=menu]')).map(n=>({class:n.className,hidden:n.hidden,rect:JSON.stringify(n.getBoundingClientRect().toJSON())}))`).catch(()=>null)); } clearTimeout(deadline); exitCode = 1; app.quit(); }
});
