// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { faceIdentity } from './cast';
import { eventForTool, mountFace } from './engine';
import { BEHAVIOURS, STATE_ENTRANCE, STATES } from './motion';

afterEach(() => { document.body.innerHTML = ''; });

describe('bot faces', () => {
  it('draws the same bot the same way every time', () => {
    const a = faceIdentity('writer-bot', 'green');
    const b = faceIdentity('writer-bot', 'green');
    expect(b).toBe(a);
    const fresh = faceIdentity('another-bot', 'green');
    expect([fresh.seed, fresh.shape]).not.toEqual([a.seed, a.shape]);
  });

  it('keeps the colours in the family of the picked tint', () => {
    const hue = (color: string) => Number(/hsl\(([\d.-]+)/.exec(color)?.[1]);
    const green = faceIdentity('same', 'green');
    const red = faceIdentity('same', 'red');
    expect(Math.abs(hue(green.colors[1]) - 118)).toBeLessThanOrEqual(14);
    expect(Math.abs(hue(red.colors[1]) - 352)).toBeLessThanOrEqual(14);
  });

  it('every reaction and entrance names a real behaviour', () => {
    for (const state of Object.keys(STATES) as Array<keyof typeof STATES>) {
      expect(BEHAVIOURS[STATE_ENTRANCE[state]]).toBeTypeOf('function');
    }
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      const t = faceIdentity(key).t;
      for (const name of [...t.tics, ...Object.values(t.react)]) expect(BEHAVIOURS[name], name).toBeTypeOf('function');
    }
  });

  it('reads tool calls as reading, searching, writing or running', () => {
    expect(eventForTool('read_file')).toBe('read');
    expect(eventForTool('grep')).toBe('search');
    expect(eventForTool('web_search')).toBe('search');
    expect(eventForTool('edit_file')).toBe('write');
    expect(eventForTool('bash')).toBe('run');
  });

  it('mounts a self-contained drawing and cleans up after itself', () => {
    const host = document.createElement('span');
    document.body.appendChild(host);
    const face = mountFace(host, { key: 'mounted', tint: 'blue', size: 48 });
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
    // Its own gradients and, at this size, its own grain filter.
    expect(svg.querySelectorAll('defs linearGradient').length).toBeGreaterThan(0);
    expect(svg.querySelector('defs filter')).not.toBeNull();
    // The outline is drawn on mount, not left empty until the first frame.
    expect(svg.querySelector('.ink')?.getAttribute('d')).toMatch(/^M/);
    face.setState('done');
    expect(svg.querySelectorAll('.eye.happy')).toHaveLength(2);
    face.destroy();
    expect(host.querySelector('svg')).toBeNull();
  });

  it('drops the costly layers on small faces', () => {
    const host = document.createElement('span');
    const face = mountFace(host, { key: 'tiny', size: 24 });
    expect(host.querySelector('filter')).toBeNull();
    expect(host.querySelector('.ink2')).toBeNull();
    face.destroy();
  });
});
