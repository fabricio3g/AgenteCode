// Bundle with esbuild (platform=node, format=cjs, external=electron), then run
// with Electron. Drives the real agent browser (WebContentsView + CDP) against
// a local page: open, snapshot refs, fill + submit, click, console capture,
// wait, back, screenshot, and the user-takeover lock.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { app, BrowserWindow } from 'electron';
import { setMainWindow } from '../../main/window-manager.ts';
import { panelSetBounds, panelSetTakeover } from '../../main/browser-panel.ts';
import { runBrowserAction } from '../../main/browser-actions.ts';

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const PAGE = `<!doctype html><title>Driver test</title>
<h1>Sign up</h1>
<label for="email">Email</label><input id="email" name="email">
<button id="go" onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('email').value; console.error('boom from page')">Continue</button>
<p id="out"></p>
<a href="/second">Next page</a>
<form action="/second"><input name="q" placeholder="Search"></form>`;

async function run() {
  await app.whenReady();
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url?.startsWith('/second') ? '<title>Second</title><p>Second page</p>' : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const win = new BrowserWindow({ show: process.env.SMOKE_SHOW === "1", width: 1200, height: 800 });
  setMainWindow(win);
  panelSetBounds({ x: 0, y: 0, width: 800, height: 700 });
  try {
    const opened = await runBrowserAction('open', { url });
    assert.equal(opened.ok, true, opened.text);
    assert.match(opened.text, /Page: Driver test/);
    const email = /(e\d+) textbox "Email"/.exec(opened.text)?.[1];
    const go = /(e\d+) button "Continue"/.exec(opened.text)?.[1];
    assert.ok(email && go, opened.text);

    const filled = await runBrowserAction('fill', { ref: email, text: 'ada@example.com' });
    assert.match(filled.text, /textbox "Email" value="ada@example.com"/);

    const clicked = await runBrowserAction('click', { ref: go });
    assert.match(clicked.text, /Hello ada@example.com/);
    assert.match(clicked.text, /1 new error\(s\)/);

    const consoleRead = await runBrowserAction('console', { level: 'error' });
    assert.match(consoleRead.text, /\[error\] boom from page/);

    const search = /(e\d+) textbox "Search"/.exec(clicked.text)?.[1];
    const submitted = await runBrowserAction('fill', { ref: search, text: 'cats', submit: true });
    assert.match(submitted.text, /Page: Second/);

    const waited = await runBrowserAction('wait', { text: 'Second page', timeoutMs: 3000 });
    assert.equal(waited.ok, true, waited.text);

    const back = await runBrowserAction('back');
    assert.match(back.text, /Page: Driver test/);

    const shot = await runBrowserAction('screenshot');
    if (process.env.SMOKE_SHOW === '1') {
      assert.equal(shot.ok, true, shot.text);
      assert.ok((shot.image?.data.length ?? 0) > 1000, 'screenshot has pixels');
    } else if (!shot.ok) {
      // A never-painted window cannot be captured: the agent gets told why.
      assert.match(shot.text, /must be visible/);
    }

    const stale = await runBrowserAction('click', { ref: 'e999' });
    assert.equal(stale.ok, false);
    assert.match(stale.text, /Take a new browser_snapshot/);

    panelSetTakeover(true);
    const blocked = await runBrowserAction('snapshot');
    assert.equal(blocked.ok, false);
    assert.match(blocked.text, /taken control/);
    panelSetTakeover(false);

    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = await runBrowserAction('open', { url: `http://127.0.0.1:${closedPort}/` });
    assert.equal(refused.ok, false);
    assert.match(refused.text, /nothing is listening there/);
    console.log('browser-driver smoke: ok');
  } finally {
    server.closeAllConnections();
    server.close();
    win.destroy();
  }
}

run().then(
  () => app.exit(0),
  (err) => {
    console.error(err);
    app.exit(1);
  }
);
