/** Real GGUF load + answer, isolated from the user's running app/config.
 * AGENTE_TEST_MODEL and AGENTE_TEST_RUNTIME are required; context defaults to
 * 4096, AGENTE_TEST_CONTEXT can reproduce a larger load. Uses port 31435.
 *   node --import tsx scripts/smoke-local-model.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const model = process.env.AGENTE_TEST_MODEL;
const runtime = process.env.AGENTE_TEST_RUNTIME;
if (!model || !runtime) throw new Error('Set AGENTE_TEST_MODEL and AGENTE_TEST_RUNTIME to the GGUF and llama-server paths.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-local-smoke-'));
const previousHome = process.env.AGENTE_HOME;
process.env.AGENTE_HOME = root;
const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: (name) => path.join(root, name) } } };
const { startLlama, stopLlama, getSupervisorStatus } = await import('../main/llm-runner.ts');
const { llamaSessionHeaders } = await import('../main/llama-session.ts');
const started = Date.now();
const port = 31435;
try {
  await startLlama({ model_path: model, runtime_path: runtime, port, host: '127.0.0.1',
    backend_mode: 'cpu', gpu_offload: 0, context_length: Number(process.env.AGENTE_TEST_CONTEXT || 4096),
    cpu_threads: Math.min(8, os.availableParallelism()), batch_size: 256, parallel: 1,
    mmap: true, keep_in_memory: false, thinking_mode: 'off' }, {
    isDestroyed: () => false,
    webContents: { send: (_channel, event) => {
      if (event.state || event.load_phase) console.log(JSON.stringify({ state: event.state, phase: event.load_phase, progress: event.load_progress }));
    } }
  });
  const status = await getSupervisorStatus();
  assert.equal(status.state, 'ready');
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { ...llamaSessionHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: path.basename(model), messages: [{ role: 'user', content: 'Reply with one word: ready' }],
      stream: false, max_tokens: 32, temperature: 0 }), signal: AbortSignal.timeout(120_000),
  });
  assert.ok(response.ok, `Completion HTTP ${response.status}`);
  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  assert.ok(typeof content === 'string' && content.trim(), 'the loaded model must produce a reply');
  console.log(JSON.stringify({ status: 'passed', model: path.basename(model), seconds: ((Date.now() - started) / 1000).toFixed(1), reply: content.trim().slice(0, 100) }));
} finally {
  await stopLlama(null);
  if (previousHome === undefined) delete process.env.AGENTE_HOME; else process.env.AGENTE_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
}
