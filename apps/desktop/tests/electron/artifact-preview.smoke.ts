// Bundle with esbuild (platform=node, format=cjs, external=electron), then run
// with Electron. Exercises Chromium's real request and navigation boundaries.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { app, BrowserWindow, session } from 'electron';
import { createArtifactWindow, loadArtifactHtml, withArtifactTimeout } from '../../main/artifact-preview.ts';
import { generatePdf } from '../../main/generated-documents.ts';

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function run() {
  await app.whenReady();
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('unexpected'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  let win: BrowserWindow | undefined;
  try {
    await session.defaultSession.cookies.set({ url, name: 'app-secret', value: 'private' });
    win = createArtifactWindow(true);
    assert.notEqual(win.webContents.session, session.defaultSession);
    assert.deepEqual(await win.webContents.session.cookies.get({}), []);
    await withArtifactTimeout(loadArtifactHtml(win, `<h1>Local artifact</h1><script>document.body.dataset.ran = 'yes';</script>`, true));
    await win.webContents.executeJavaScript(`
      fetch('${url}/fetch').catch(() => {});
      new Image().src = '${url}/image';
      try { new WebSocket('ws://127.0.0.1:${port}/socket'); } catch {}
      window.open('${url}/popup');
      const form = document.createElement('form'); form.action = '${url}/form'; document.body.append(form); form.submit();
      void 0;
    `);
    const state = await win.webContents.executeJavaScript(`({ ran: document.body.dataset.ran, bridge: typeof window.electronAPI, node: typeof require, opener: window.opener })`);
    assert.deepEqual(state, { ran: 'yes', bridge: 'undefined', node: 'undefined', opener: null });
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    const originalUrl = win.webContents.getURL();
    await win.webContents.executeJavaScript(`location.href = '${url}/navigation'; void 0`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(win.webContents.getURL(), originalUrl);

    // Exercise the session boundary independently of CSP.
    await win.loadURL(`data:text/html,${encodeURIComponent(`<img src="${url}/without-csp"><script>fetch('${url}/without-csp-fetch').catch(()=>{})</script>`)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(requests, 0, 'Generated content must not reach the network');
    win.destroy();

    const pdf = await generatePdf({ html: `<h1>Private report</h1><p>Résumé · 日本語</p><img src="${url}/pdf">` });
    assert.equal(Buffer.from(pdf.bytes).subarray(0, 5).toString(), '%PDF-');
    assert.equal(BrowserWindow.getAllWindows().length, 0, 'PDF guest must be destroyed');
    assert.equal(requests, 0, 'PDF rendering must not reach the network');
    app.once('browser-window-created', (_event, guest) => {
      guest.webContents.printToPDF = async () => { throw new Error('Simulated print failure'); };
    });
    await assert.rejects(generatePdf({ html: '<h1>Must not silently fall back</h1>' }), /Simulated print failure/);
    assert.equal(BrowserWindow.getAllWindows().length, 0, 'Failed PDF guest must also be destroyed');
    await assert.rejects(withArtifactTimeout(new Promise(() => {}), 10), /timed out/);
    console.log('PASS: native preview isolation, scripts, blocked network/navigation/popups, PDF output, error cleanup and timeout');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    await session.defaultSession.cookies.remove(url, 'app-secret');
    server.close();
  }
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
