import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// esbuild can silently erase a missing TypeScript re-export. The production
// bundle alone therefore does not prove the before-quit cleanup is callable.
test('IPC entry exports the agent shutdown function used by before-quit', async () => {
  const result = await build({
    entryPoints: ['main/ipc-handlers.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
    metafile: true,
    logLevel: 'silent'
  });
  const output = result.outputFiles[0].text;
  assert.match(output, /function disposeAllSessions\(/);
  assert.match(output, /disposeAllSessions as disposeAllAgenteSessions/, 'shutdown export was erased from the bundle');
});
