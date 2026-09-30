// Who a bot is, drawn: its silhouette, colours and temperament, derived from
// its handle so it looks and moves the same everywhere, every launch. The
// temperaments are the showcase's original cast; a bot borrows one and
// jitters it. Colours stay in the family of the tint the person picked.

import { clamp, seededRandom, type Form, type ShapeName } from './geometry';

export type FaceEvent = 'read' | 'search' | 'write' | 'run' | 'error' | 'done';

export interface Temperament {
  energy: number;
  bounce: number;
  gravity: number;
  curiosity: number;
  shyness: number;
  blinkRate: number;
  boilRate: number;
  /** Idle habits, picked at random every 7–14 s. */
  tics: string[];
  /** How this bot answers each kind of activity. */
  react: Record<FaceEvent, string>;
}

export interface FaceIdentity {
  key: string;
  shape: ShapeName;
  seed: number;
  /** light, mid, deep. */
  colors: [string, string, string];
  aspect: [number, number];
  form: Form;
  spark: boolean;
  t: Temperament;
  /** Deterministic variety between faces on one screen. */
  angle: number;
  hlA: number;
  light: number;
  bobPhase: number;
}

type Template = Omit<Temperament, 'tics' | 'react'> & { tics: string[]; react: Record<FaceEvent, string> };

/** The showcase cast's temperaments: a personality is data, never a branch. */
const TEMPERAMENTS: Template[] = [
  { energy: .95, bounce: 1.35, gravity: 1.0, curiosity: 1.0, shyness: .05, blinkRate: 1.2, boilRate: 1.1,
    tics: ['hop', 'doubleHop', 'wiggle', 'turnAway'], react: { read: 'scan', search: 'dart', write: 'scribble', run: 'vibrate', error: 'startle', done: 'celebrate' } },
  { energy: .55, bounce: .55, gravity: 1.25, curiosity: .7, shyness: .1, blinkRate: .55, boilRate: .8,
    tics: ['nods', 'tilt', 'blinkTwice'], react: { read: 'concentrate', search: 'concentrate', write: 'scribble', run: 'brace', error: 'nods', done: 'tilt' } },
  { energy: .22, bounce: .3, gravity: 1.4, curiosity: .35, shyness: .3, blinkRate: .35, boilRate: .5,
    tics: ['breathe', 'sway', 'blinkSlow'], react: { read: 'breathe', search: 'breathe', write: 'breathe', run: 'breathe', error: 'breathe', done: 'sway' } },
  { energy: .5, bounce: .6, gravity: 1.1, curiosity: .85, shyness: .95, blinkRate: 1.6, boilRate: 1.0,
    tics: ['peek', 'recoil', 'squint'], react: { read: 'scan', search: 'dart', write: 'peek', run: 'peek', error: 'recoil', done: 'hop' } },
  { energy: .9, bounce: 1.0, gravity: .9, curiosity: 1.0, shyness: 0, blinkRate: 1.4, boilRate: 1.3,
    tics: ['playfulBlink', 'wiggle', 'turnAway', 'shake'], react: { read: 'squint', search: 'dart', write: 'playfulBlink', run: 'wiggle', error: 'startle', done: 'sparkle' } },
  { energy: .6, bounce: .8, gravity: 1.0, curiosity: .95, shyness: .15, blinkRate: 1.1, boilRate: 1.0,
    tics: ['tilt', 'sway', 'blush'], react: { read: 'concentrate', search: 'dart', write: 'scribble', run: 'brace', error: 'startle', done: 'blush' } },
  { energy: .45, bounce: .45, gravity: 1.3, curiosity: .6, shyness: .2, blinkRate: .7, boilRate: .6,
    tics: ['drift', 'breathe', 'gaze'], react: { read: 'scan', search: 'gaze', write: 'concentrate', run: 'vibrate', error: 'sway', done: 'breathe' } },
  { energy: .3, bounce: .4, gravity: 1.45, curiosity: .3, shyness: .2, blinkRate: .5, boilRate: .45,
    tics: ['doze', 'doze', 'breathe'], react: { read: 'doze', search: 'doze', write: 'doze', run: 'doze', error: 'startle', done: 'hop' } }
];

const SHAPES: ShapeName[] = ['circle', 'squircle', 'triangle', 'flower', 'cloud', 'blob', 'drop', 'pebble', 'egg', 'wide'];

const REACTION_POOL: Record<FaceEvent, string[]> = {
  read: ['scan', 'concentrate', 'gaze'],
  search: ['dart', 'gaze', 'peek'],
  write: ['scribble', 'concentrate', 'brace'],
  run: ['vibrate', 'brace', 'wiggle'],
  error: ['startle', 'recoil', 'peek'],
  done: ['celebrate', 'sparkle', 'blush', 'nods']
};

/** Hue centres for the tints a person can pick (bots.color). */
const TINT_HUE: Record<string, number> = { blue: 218, green: 118, yellow: 38, red: 352 };

const cache = new Map<string, FaceIdentity>();

/**
 * The face for `key` (a bot's handle, or its title while it is being
 * created) in the family of `tint`. Cached: every avatar of one bot shares it.
 */
export function faceIdentity(key: string, tint = 'blue'): FaceIdentity {
  const id = `${key}\u0000${tint}`;
  const hit = cache.get(id);
  if (hit) return hit;

  const random = seededRandom(key || '?');
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const template = pick(TEMPERAMENTS);
  const t: Temperament = { ...template, tics: [...template.tics], react: { ...template.react } };
  for (const [trait, spread] of [['energy', .12], ['curiosity', .14], ['shyness', .12], ['blinkRate', .16], ['boilRate', .12]] as const) {
    const [min, max] = trait === 'blinkRate' ? [.25, 1.8] : [.05, 1.3];
    t[trait] = clamp(t[trait] + (random() * 2 - 1) * spread, min, max);
  }
  if (random() < .55) {
    const event = pick(Object.keys(REACTION_POOL) as FaceEvent[]);
    t.react[event] = pick(REACTION_POOL[event]);
  }
  if (random() < .45) t.tics[t.tics.length - 1] = pick(['sway', 'gaze', 'blinkSlow', 'tilt', 'breathe']);

  // The person's tint picks the family; the bot picks its exact shade.
  const hue = (TINT_HUE[tint] ?? TINT_HUE.blue) + (random() * 2 - 1) * 14;
  const sat = Math.floor(51 + random() * 24);
  const shape = pick(SHAPES);
  const index = Math.floor(random() * 1000);

  const identity: FaceIdentity = {
    key,
    shape,
    seed: 1 + Math.floor(random() * 1000000),
    colors: [`hsl(${hue + 9} ${sat}% 86%)`, `hsl(${hue} ${sat}% 68%)`, `hsl(${hue - 10} ${sat}% 53%)`],
    aspect: [.94 + random() * .12, .94 + random() * .12],
    form: { lobes: 2 + Math.floor(random() * 5), depth: .015 + random() * .045, bulge: (random() - .5) * .055, phase: random() * Math.PI * 2 },
    spark: shape === 'flower' && random() < .5,
    t,
    angle: 0.65 + (index * 0.41) % 1.5,
    hlA: 0.9 + (index * 0.5) % 1.3,
    light: -2.36 + (index % 4) * 0.14 - 0.21,
    bobPhase: (index * 1.7) % (Math.PI * 2)
  };
  cache.set(id, identity);
  return identity;
}
