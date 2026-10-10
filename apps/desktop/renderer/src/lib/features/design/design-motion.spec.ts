import { describe, expect, it } from 'vitest';
import { barGeometry, curvePath, durationMs, easingPoints, EASING_PRESETS, formatTime, springEasing, timelineSpan } from './design-motion';

describe('duration tokens', () => {
  it('reads ms and seconds, and nothing else', () => {
    expect(durationMs('250ms')).toBe(250);
    expect(durationMs(' 0.25s ')).toBe(250);
    expect(durationMs('var(--x)')).toBeNull();
    expect(durationMs('fast')).toBeNull();
  });
});

describe('springs', () => {
  const values = (easing: string) => easing.slice('linear('.length, -1).split(', ').map(Number);

  it('starts at 0, settles on 1, and overshoots when under-damped', () => {
    const v = values(springEasing(300, 15));
    expect(v[0]).toBe(0);
    expect(v.at(-1)).toBe(1);
    expect(Math.max(...v)).toBeGreaterThan(1);
  });

  it('is a linear() easing the Inspector can preview', () => {
    expect(springEasing()).toMatch(/^linear\(0, /);
    expect(easingPoints(springEasing())?.length).toBeGreaterThan(20);
  });

  it('ships a spring among the presets', () => {
    expect(EASING_PRESETS.map((preset) => preset.id)).toEqual(['standard', 'decelerate', 'accelerate', 'emphasized', 'spring']);
  });
});

describe('easing curves', () => {
  it('samples cubic-bezier and keywords through their endpoints', () => {
    const points = easingPoints('cubic-bezier(0.2, 0, 0, 1)') ?? [];
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)?.x).toBeCloseTo(1, 9);
    expect(points.at(-1)?.y).toBeCloseTo(1, 9);
    expect(easingPoints('ease-out')?.[0]).toEqual({ x: 0, y: 0 });
    expect(easingPoints('linear')).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('places linear() stops at their percentages, or evenly between the ones that have one', () => {
    const points = easingPoints('linear(0, 1.2 50%, 1)') ?? [];
    expect(points.map((point) => point.x)).toEqual([0, 0.5, 1]);
    expect(points[1].y).toBe(1.2);
  });

  it('returns null for what it cannot read', () => {
    expect(easingPoints('steps(4, end)')).toBeNull();
    expect(curvePath('var(--ease)')).toBeNull();
  });

  it('draws an SVG path inside its box, with the bounce kept on the plot', () => {
    const path = curvePath(springEasing(300, 15), 40, 4) ?? '';
    expect(path.startsWith('M4.0 ')).toBe(true);
    expect(path).toMatch(/^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+)+$/);
  });
});

describe('the timeline axis', () => {
  const item = (delay: number, duration: number, iterations: number | 'infinite' = 1) => ({ delay, duration, iterations });

  it('spans from 0 to the last end, at least 600ms, in 100ms steps', () => {
    expect(timelineSpan([item(0, 180)])).toBe(600);
    expect(timelineSpan([item(200, 900)])).toBe(1100);
    expect(timelineSpan([item(0, 300, 3)])).toBe(900);
    expect(timelineSpan([item(0, 2000, 'infinite')])).toBe(2000);
    expect(timelineSpan([])).toBe(600);
  });

  it('places each bar by its delay and length, always leaving a visible sliver', () => {
    expect(barGeometry(item(250, 500), 1000)).toEqual({ left: 25, width: 50 });
    expect(barGeometry(item(0, 1), 1000).width).toBe(1);
    expect(barGeometry(item(900, 500), 1000)).toEqual({ left: 90, width: 10 });
  });

  it('formats a time for the scrubber', () => {
    expect(formatTime(850)).toBe('850ms');
    expect(formatTime(1250)).toBe('1.25s');
  });
});
