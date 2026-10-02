// Bundle with esbuild (platform=node, format=cjs, external=electron) and run with Electron.
// Verifies real DOM zoom / native View alignment and presentation independent of openness.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { app, BrowserWindow, WebContentsView } from 'electron';
import { setMainWindow } from '../../main/window-manager.ts';
import { runBrowserAction } from '../../main/browser-actions.ts';
import { panelTab, panelSelectScope, panelListTabs, panelSetTakeover, panelIsTakenOver, withBrowserScope, panelOpenTab, panelSetPresentation, panelSetVisible, panelCloseAll } from '../../main/browser-panel.ts';

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
async function run() {
  console.log('smoke: waiting for Electron');
  await app.whenReady(); console.log('smoke: Electron ready');
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>Workspace page</title><input id="value" value="preserved">'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: true, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
  setMainWindow(win);
  try {
    console.log('smoke: loading renderer');
    await win.loadURL('data:text/html,' + encodeURIComponent('<style>body{margin:0}#box{position:absolute;left:40px;top:60px;width:300px;height:120px}</style><div id="box"></div>'));
    console.log('smoke: opening guest');
    await panelOpenTab(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const view = win.contentView.children.find((child): child is WebContentsView => child instanceof WebContentsView);
    assert.ok(view, 'Guest native view exists');
    const guestId = view.webContents.id;
    if (view.webContents.isLoading()) await new Promise<void>((resolve) => view.webContents.once('did-finish-load', () => resolve()));
    for (const zoom of [0.5, 1, 1.25, 1.5, 2]) {
      win.webContents.setZoomFactor(zoom);
      const rect = await win.webContents.executeJavaScript('(() => { const r = document.getElementById("box").getBoundingClientRect(); return {x:r.left,y:r.top,width:r.width,height:r.height}; })()');
      console.log('smoke: UI scale', zoom);
      await panelSetPresentation({ bounds: rect, exposed: true, occluded: false });
      assert.deepEqual(view.getBounds(), { x: Math.round(40 * zoom), y: Math.round(60 * zoom), width: Math.round(300 * zoom), height: Math.round(120 * zoom) });
      assert.equal(view.getVisible(), true);
    }
    const rect = { x: 40, y: 60, width: 300, height: 120 };
    await panelSetPresentation({ bounds: rect, exposed: false, occluded: false });
    assert.equal(view.getVisible(), false, 'Inactive workspace tab hides the native view');
    await panelSetPresentation({ bounds: rect, exposed: true, occluded: false });
    assert.equal(view.getVisible(), true, 'Tab activation exposes the same page');
    console.log('smoke: overlap');
    await panelSetPresentation({ bounds: rect, exposed: true, occluded: true });
    assert.equal(view.getVisible(), false, 'Floating overlap/drag occludes the native page');
    await panelSetPresentation({ bounds: rect, exposed: true, occluded: false });
    assert.equal(view.getVisible(), true);
    assert.equal(view.webContents.id, guestId); assert.equal(await view.webContents.executeJavaScript('document.getElementById("value").value'), 'preserved');
    panelSetVisible(false);
    await panelSetPresentation({ bounds: rect, exposed: true, occluded: false });
    assert.equal(view.getVisible(), false, 'Presentation cannot reopen a logically hidden browser');
    console.log('smoke: concurrent conversation browsers');
    win.webContents.setZoomFactor(1);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const [openedA, openedB] = await Promise.all([runBrowserAction('open', { url: url + '?owner=a' }, 'chat:a'), runBrowserAction('open', { url: url + '?owner=b' }, 'chat:b')]);
    assert.equal(openedA.ok, true, openedA.text); assert.equal(openedB.ok, true, openedB.text);
    const a = withBrowserScope('chat:a', () => panelTab()); const b = withBrowserScope('chat:b', () => panelTab());
    assert.notEqual(a.view.webContents.session, b.view.webContents.session, 'Cookies and storage belong to the conversation');
    await a.view.webContents.session.cookies.set({ url, name: 'owner', value: 'a' });
    assert.equal((await b.view.webContents.session.cookies.get({ url, name: 'owner' })).length, 0);
    await a.view.webContents.executeJavaScript('document.getElementById("value").value = "chat-a"');
    await b.view.webContents.executeJavaScript('document.getElementById("value").value = "chat-b"');
    assert.throws(() => withBrowserScope('chat:b', () => panelTab(a.id)), /No browser tab/);
    panelSelectScope('chat:a'); await withBrowserScope('chat:a', () => panelSetPresentation({ bounds: rect, exposed: true, occluded: false }));
    assert.equal(a.view.getVisible(), true); assert.equal(b.view.getVisible(), false);
    await runBrowserAction('open', { url: url + '?background=b' }, 'chat:b');
    await withBrowserScope('chat:b', () => panelSetPresentation({ bounds: rect, exposed: true, occluded: false }));
    assert.equal(a.view.getVisible(), true, 'Background navigation cannot steal presentation'); assert.equal(b.view.getVisible(), false);
    assert.match(a.view.webContents.getURL(), /owner=a/);
    withBrowserScope('chat:a', () => panelSetTakeover(true)); assert.equal(withBrowserScope('chat:b', panelIsTakenOver), false);
    panelSelectScope('chat:b'); assert.equal(a.view.getVisible(), false);
    await withBrowserScope('chat:b', () => panelSetPresentation({ bounds: rect, exposed: true, occluded: false })); assert.equal(b.view.getVisible(), true);
    panelSelectScope('chat:a'); await withBrowserScope('chat:a', () => panelSetPresentation({ bounds: rect, exposed: true, occluded: false }));
    assert.equal(await a.view.webContents.executeJavaScript('document.getElementById("value").value'), 'chat-a', 'Switching keeps the page and its input');
    withBrowserScope('chat:b', panelCloseAll); assert.equal(withBrowserScope('chat:a', panelListTabs).length, 1); assert.equal(a.view.getVisible(), true);
    console.log('workspace-panels smoke: ok (five UI scales, overlap, isolated tabs/storage, background tools, preserved page)');
  } finally { for (const scope of ['unassigned', 'chat:a', 'chat:b']) withBrowserScope(scope, panelCloseAll); server.closeAllConnections(); server.close(); win.destroy(); }
}
const deadline = setTimeout(() => { console.error('smoke: timed out'); app.exit(1); }, 45000);
run().finally(() => clearTimeout(deadline)).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
