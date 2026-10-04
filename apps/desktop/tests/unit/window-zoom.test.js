import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerWindowZoom } from '../../main/window-zoom.ts';

function contents(setZoomMode) {
  const target = new EventEmitter();
  target.messages = [];
  target.send = (...args) => target.messages.push(args);
  if (setZoomMode) target.setZoomMode = setZoomMode;
  return target;
}
it('starts on Electron 41 without setZoomMode and forwards mouse/keyboard zoom', () => {
  const target = contents();
  assert.doesNotThrow(() => registerWindowZoom(target));
  target.emit('zoom-changed', {}, 'in');
  let prevented = false;
  target.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: '0', control: true, meta: false, alt: false });
  assert.equal(prevented, true);
  assert.deepEqual(target.messages, [['ui-zoom', 1], ['ui-zoom', 0]]);
  target.emit('before-input-event', { preventDefault: () => assert.fail('normal input blocked') }, { type: 'keyDown', key: 'a', control: false, meta: false, alt: false });
  assert.equal(target.messages.length, 2);
});
it('uses manual zoom when the runtime supplies the newer API', () => {
  const calls = [];
  const target = contents(mode => calls.push(mode));
  registerWindowZoom(target);
  assert.deepEqual(calls, ['manual']);
});
