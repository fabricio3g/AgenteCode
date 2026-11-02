import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { loadDevelopmentRenderer } from '../../main/renderer-load.ts';

test('recovers from a transient network service failure', async () => {
  let calls = 0; const delays = [];
  await loadDevelopmentRenderer(async () => { if (++calls === 1) throw new Error('ERR_FAILED (-2)'); }, () => false, async ms => { delays.push(ms); });
  assert.equal(calls, 2); assert.deepEqual(delays, [500]);
});
test('reports persistent failures after a bounded retry', async () => {
  let calls = 0;
  await assert.rejects(() => loadDevelopmentRenderer(async () => { calls++; throw new Error('ERR_CONNECTION_REFUSED'); }, () => false, async () => {}), /REFUSED/);
  assert.equal(calls, 4);
});
test('does not retry certificate failures or a closed window', async () => {
  let calls = 0;
  await assert.rejects(() => loadDevelopmentRenderer(async () => { calls++; throw new Error('ERR_CERT_AUTHORITY_INVALID'); }, () => false), /CERT/);
  assert.equal(calls, 1);
  await loadDevelopmentRenderer(async () => { calls++; }, () => true);
  assert.equal(calls, 1);
});
test('loads when a development server becomes available during recovery', async () => {
  const server = createServer((_req, res) => res.end('renderer ready'));
  let ready = false;
  let url;
  try {
    await loadDevelopmentRenderer(async () => {
      if (!ready) throw new Error('ERR_CONNECTION_REFUSED');
      assert.equal(await (await fetch(url)).text(), 'renderer ready');
    }, () => false, async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${server.address().port}`; ready = true;
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
