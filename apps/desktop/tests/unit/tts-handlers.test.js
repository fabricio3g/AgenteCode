import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTtsHandlers } from '../../main/ipc/tts-handlers.ts';

test('the voice IPC forwards request correlation and engine failures to the player', () => {
  const messages = [];
  let forward;
  registerTtsHandlers({
    ipcMain: { handle() {} }, getMainWindow: () => ({ webContents: { send: (channel, payload) => messages.push({ channel, payload }) } }),
    initTts: async () => [], generateTtsStream() {}, cancelTtsStream() {},
    onWorkerMessage: (listener) => { forward = listener; }
  });
  forward({ type: 'start', id: 19, requestId: 'read-message', total: 1 });
  forward({ type: 'chunk', id: 19, requestId: 'read-message', index: 0, total: 1, base64: 'AAA=' });
  forward({ type: 'error', id: 19, requestId: 'read-message', message: 'Voice engine could not load the model.' });
  assert.deepEqual(messages.map(message => message.channel), ['tts-start', 'tts-chunk', 'tts-error']);
  assert.ok(messages.every(message => message.payload.requestId === 'read-message'));
  assert.equal(messages[2].payload.message, 'Voice engine could not load the model.');
});
