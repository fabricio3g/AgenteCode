/**
 * Motion for the Design canvas, as pure arithmetic: how a duration token reads,
 * the curve an easing draws, the spring the presets carry, and the geometry of
 * the timeline's bars and scrubber. Nothing here touches the DOM or the page.
 */

export interface Point { x: number; y: number }

/** An easing preset the Inspector offers for an easing token. */
export interface EasingPreset { id: 'standard' | 'decelerate' | 'accelerate' | 'emphasized' | 'spring'; value: string }

/**
 * A damped spring from 0 to 1, as a `linear()` easing sampled over the time it
 * takes to settle. Under-damped springs overshoot; that overshoot is the point.
 */
export function springEasing(stiffness = 300, damping = 15, mass = 1, samples = 28): string {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = Math.min(0.999, damping / (2 * Math.sqrt(stiffness * mass)));
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const settle = 4 / (zeta * omega);
  const values = Array.from({ length: samples + 1 }, (_, index) => {
    const t = (settle * index) / samples;
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
  });
  values[values.length - 1] = 1;
  return `linear(${values.map((value) => Number(value.toFixed(3))).join(', ')})`;
}

export const EASING_PRESETS: readonly EasingPreset[] = [
  { id: 'standard', value: 'cubic-bezier(0.2, 0, 0, 1)' },
  { id: 'decelerate', value: 'cubic-bezier(0, 0, 0.2, 1)' },
  { id: 'accelerate', value: 'cubic-bezier(0.4, 0, 1, 1)' },
  { id: 'emphasized', value: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  { id: 'spring', value: springEasing() }
];

/** The CSS keywords, as the cubic-bezier each stands for, so a preview draws them too. */
const KEYWORDS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1]
};

/** A duration token in ms when it is a plain time (`250ms`, `0.25s`), otherwise null. */
export function durationMs(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s)$/i.exec(value.trim());
  if (!match) return null;
  return match[2].toLowerCase() === 's' ? Number(match[1]) * 1000 : Number(match[1]);
}

/** The duration as the token writes it: `250ms`. */
export const formatDurationToken = (ms: number) => `${Math.round(ms)}ms`;

/** The points a cubic-bezier(x1, y1, x2, y2) passes through, `steps` + 1 of them. */
function cubicPoints(x1: number, y1: number, x2: number, y2: number, steps = 32): Point[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    const u = 1 - t;
    return {
      x: 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t,
      y: 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t
    };
  });
}

/** A `linear(...)` list as points: each stop sits at its percentage, or evenly between the stops that have one. */
function linearPoints(body: string): Point[] | null {
  const stops = body.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const tokens = part.split(/\s+/);
    const y = Number(tokens[0]);
    if (!Number.isFinite(y)) return null;
    const positions = tokens.slice(1).filter((token) => token.endsWith('%')).map((token) => Number(token.slice(0, -1)) / 100).filter(Number.isFinite);
    return { y, positions };
  });
  if (stops.some((stop) => stop === null) || stops.length < 2) return null;
  const known = stops as Array<{ y: number; positions: number[] }>;
  // Each stop gets a position: its own percentage, or the even share between the neighbours that have one.
  const positions: Array<number | undefined> = known.map((stop, index) => (stop.positions.length ? stop.positions[0] : index === 0 ? 0 : index === known.length - 1 ? 1 : undefined));
  positions.forEach((position, index) => {
    if (position !== undefined) return;
    let from = index - 1;
    while (positions[from] === undefined) from -= 1;
    let to = index + 1;
    while (positions[to] === undefined) to += 1;
    positions[index] = (positions[from] as number) + (((positions[to] as number) - (positions[from] as number)) * (index - from)) / (to - from);
  });
  return known.map((stop, index) => ({ x: positions[index] as number, y: stop.y }));
}

/** The points an easing draws, from 0 to 1 in time, or null for a value it cannot read. */
export function easingPoints(value: string): Point[] | null {
  const text = value.trim().toLowerCase();
  if (text === 'linear') return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  if (KEYWORDS[text]) return cubicPoints(...KEYWORDS[text]);
  const bezier = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(text);
  if (bezier) return cubicPoints(Number(bezier[1]), Number(bezier[2]), Number(bezier[3]), Number(bezier[4]));
  const linear = /^linear\((.*)\)$/s.exec(text);
  return linear ? linearPoints(linear[1]) : null;
}

/**
 * The SVG path of an easing's curve inside a square of `size` px, with a little
 * room on every side. Overshoot is kept on the plot, so a spring shows its bounce.
 */
export function curvePath(value: string, size = 40, pad = 4): string | null {
  const points = easingPoints(value);
  if (!points || points.length < 2) return null;
  const low = Math.min(0, ...points.map((point) => point.y));
  const high = Math.max(1, ...points.map((point) => point.y));
  const span = high - low || 1;
  const width = size - pad * 2;
  return points
    .map((point, index) => {
      const x = pad + point.x * width;
      const y = size - pad - ((point.y - low) / span) * width;
      return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

/** The timeline's axis: from 0 to the end of the last animation (one pass of an endless one), at least 600ms, to the next 100ms. */
export function timelineSpan(items: ReadonlyArray<{ delay: number; duration: number; iterations: number | 'infinite' }>): number {
  const end = items.reduce((latest, item) => {
    const passes = item.iterations === 'infinite' ? 1 : Math.max(1, item.iterations);
    return Math.max(latest, item.delay + item.duration * passes);
  }, 0);
  return Math.max(600, Math.ceil(end / 100) * 100);
}

/** Where an animation's bar sits on the axis, in percent, with a sliver always visible. */
export function barGeometry(item: { delay: number; duration: number; iterations: number | 'infinite' }, span: number): { left: number; width: number } {
  const passes = item.iterations === 'infinite' ? 1 : Math.max(1, item.iterations);
  const left = Math.min(100, (item.delay / span) * 100);
  const width = Math.min(100 - left, Math.max(1, ((item.duration * passes) / span) * 100));
  return { left, width };
}

/** A time on the axis as the scrubber reads it: `0.42s`, `850ms`. */
export function formatTime(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** Playback speeds the timeline offers. */
export const TIMELINE_RATES = [0.25, 0.5, 1] as const;
