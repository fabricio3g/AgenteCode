import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeAnimation, formatMs, frameOutline, frameTimes, motionReport } from '../../main/design/motion.ts';

const fade = {
  selector: 'button.primary',
  kind: 'transition',
  name: '',
  properties: ['background-color', 'transform'],
  durationMs: 180,
  delayMs: 0,
  iterations: 1,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  playState: 'finished'
};

test('frame instants start at 0, end at the span and are evenly spaced', () => {
  assert.deepEqual(frameTimes(4, 900), [0, 300, 600, 900]);
  assert.deepEqual(frameTimes(2, 1000), [0, 1000]);
});

test('frame count and span are clamped, with defaults for missing values', () => {
  assert.equal(frameTimes(99, 600).length, 8);
  assert.equal(frameTimes(1, 600).length, 2);
  assert.equal(frameTimes(undefined, undefined).length, 4);
  assert.equal(frameTimes(3, 50_000).at(-1), 3000);
  assert.equal(frameTimes(3, Number.NaN).at(-1), 600);
});

test('durations read as ms below a second and seconds above', () => {
  assert.equal(formatMs(180), '180ms');
  assert.equal(formatMs(1250), '1.25s');
  assert.equal(formatMs(2000), '2s');
});

test('an animation is described with its target, what changes, timing and repeats', () => {
  assert.equal(describeAnimation(fade), '- button.primary: transition of background-color, transform, 180ms, easing cubic-bezier(0.2, 0, 0, 1), plays once');
  const loop = { ...fade, selector: '.spinner', kind: 'animation', name: 'spin', properties: ['transform'], durationMs: 800, delayMs: 200, iterations: 'infinite' };
  assert.equal(describeAnimation(loop), '- .spinner: keyframe animation "spin" (transform), 800ms, after a 200ms delay, easing cubic-bezier(0.2, 0, 0, 1), repeats forever');
});

test('the report lists the animations and says when reduced motion was not checked', () => {
  const text = motionReport({ animations: [fade], reducedRunning: null, hovered: 'button.primary' });
  assert.match(text, /^1 animation\(s\) on the page after hovering button\.primary:/);
  assert.match(text, /Reduced motion: not checked\./);
});

test('the reduced-motion verdict names the animations that still run', () => {
  assert.match(motionReport({ animations: [], reducedRunning: [] }), /every animation stops/);
  const text = motionReport({ animations: [fade], reducedRunning: [fade] });
  assert.match(text, /1 animation\(s\) still run when the user prefers reduced motion/);
  assert.match(text, /prefers-reduced-motion: no-preference/);
});

test('a page with nothing animated says so', () => {
  assert.equal(motionReport({ animations: [], reducedRunning: null }).split('\n')[0], 'No animations or transitions on the page.');
});

const sample = (selector, y, opacity, transform = 'none') => ({ selector, box: { x: 10, y, width: 100, height: 40 }, opacity, transform });

test('the outline lists only the elements that moved, with their values at each instant', () => {
  const frames = [
    { t: 0, png: '', samples: [sample('h1', 40, '0'), sample('footer', 800, '1')] },
    { t: 300, png: '', samples: [sample('h1', 28, '0.5', 'matrix(1, 0, 0, 1, 0, -12)'), sample('footer', 800, '1')] },
    { t: 600, png: '', samples: [sample('h1', 40, '1'), sample('footer', 800, '1')] }
  ];
  const text = frameOutline(frames);
  assert.match(text, /^Captured 3 frames at 0ms, 300ms, 600ms\./);
  assert.match(text, /^- h1$/m);
  assert.doesNotMatch(text, /footer/);
  assert.match(text, /t=300ms: y=28 x=10 100×40 opacity=0\.5 transform=matrix\(1, 0, 0, 1, 0, -12\)/);
});

test('a still page reports that nothing moved', () => {
  const frames = [
    { t: 0, png: '', samples: [sample('p', 60, '1')] },
    { t: 500, png: '', samples: [sample('p', 60, '1')] }
  ];
  assert.match(frameOutline(frames), /Nothing moved: the page is still across these frames\./);
  assert.match(frameOutline(frames.slice(0, 1)), /Only one frame was captured/);
});
