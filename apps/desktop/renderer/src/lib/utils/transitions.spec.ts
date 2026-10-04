// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { dialogIn, motionFade, motionFly, motionSlide } from './transitions';
import { reducedMotion } from './motion.svelte';
afterEach(() => { reducedMotion.value = false; });
describe('shared desktop motion', () => {
  it('keeps dialog text sharp throughout the animation', () => {
    const transition = dialogIn(document.createElement('div'));
    expect(transition.duration).toBe(200);
    const css = transition.css!(0.5, 0.5);
    expect(css).toContain('opacity:'); expect(css).toContain('transform:');
    expect(css).not.toMatch(/filter|width|height/);
  });
  it('disables every shared transition when reduced motion is enabled', () => {
    reducedMotion.value = true;
    const node = document.createElement('div');
    for (const transition of [dialogIn(node), motionFade(node, undefined), motionFly(node, undefined), motionSlide(node, undefined)]) expect(transition.duration).toBe(0);
  });
});
