// How a face moves: the five states, each state's rhythm, and a library of
// behaviours. Every behaviour is a pure function of normalised time (0..1)
// returning a pose delta; the engine schedules and blends them.

import { clamp, lerp, type ShapeName } from './geometry';

export type FaceState = 'idle' | 'thinking' | 'working' | 'waiting' | 'done';

export interface StateLook {
  boil: number;
  bob: number;
  bobAmp: number;
  sweep: number;
  hlAmp: number;
  tilt: number;
  blinkMul: number;
  gaze: [number, number];
  eye: [number, number];
  quizz: number;
  happy: number;
}

export const STATES: Record<FaceState, StateLook> = {
  idle: { boil: 3, bob: .7, bobAmp: .4, sweep: 0, hlAmp: 2, tilt: 0, blinkMul: 1, gaze: [0, 0], eye: [1, 1], quizz: 0, happy: 0 },
  thinking: { boil: 5, bob: 1.4, bobAmp: .7, sweep: .2, hlAmp: 4, tilt: 4.2, blinkMul: 1.8, gaze: [-2.5, -3.4], eye: [.9, 1.14], quizz: 0, happy: 0 },
  working: { boil: 6, bob: 2.1, bobAmp: .35, sweep: .4, hlAmp: 3, tilt: -2.2, blinkMul: .4, gaze: [.3, 1], eye: [1.07, .76], quizz: 0, happy: 0 },
  waiting: { boil: 3, bob: .4, bobAmp: .2, sweep: 0, hlAmp: 1.5, tilt: -4.5, blinkMul: 1.2, gaze: [1.8, -1.4], eye: [1.04, 1.1], quizz: .8, happy: 0 },
  done: { boil: 2, bob: .8, bobAmp: .7, sweep: 0, hlAmp: 2, tilt: 0, blinkMul: 99, gaze: [0, .6], eye: [1, 1], quizz: 0, happy: 1 }
};

/** A behaviour played when a face enters a state. */
export const STATE_ENTRANCE: Record<FaceState, string> = {
  idle: 'breathe', thinking: 'tilt', working: 'concentrate', waiting: 'peek', done: 'celebrate'
};

export interface Pose {
  sx: number; sy: number; rot: number; dx: number; dy: number;
  yaw: number; pitch: number; morph: number; morphTo: ShapeName | null;
  eyeSx: number; eyeSy: number; eyeDx: number; eyeDy: number; lid: number; wide: number;
  shadowSx: number; shadowO: number;
}

export type PoseDelta = Partial<Omit<Pose, 'morphTo'>>;

export function blankPose(): Pose {
  return {
    sx: 1, sy: 1, rot: 0, dx: 0, dy: 0, yaw: 0, pitch: 0, morph: 0, morphTo: null,
    eyeSx: 1, eyeSy: 1, eyeDx: 0, eyeDy: 0, lid: 0, wide: 1, shadowSx: 1, shadowO: 1
  };
}

/** Keys whose rest value is 1 (scales), not 0. */
const IDENTITY_ONE = new Set(['sx', 'sy', 'eyeSx', 'eyeSy', 'wide', 'shadowSx', 'shadowO']);

export function addDelta(p: Pose, d: PoseDelta, w: number): void {
  const pose = p as unknown as Record<string, number>;
  for (const key in d) {
    const v = (d as Record<string, number | undefined>)[key];
    if (v === undefined || !Number.isFinite(v) || !(key in pose)) continue;
    pose[key] += (v - (IDENTITY_ONE.has(key) ? 1 : 0)) * w;
  }
}

// ── timing helpers ─────────────────────────────────────────────────────

const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
const eIO = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const eOut = (x: number) => 1 - Math.pow(1 - x, 3);
const eIn = (x: number) => x * x * x;
/** 0 .. 1 .. 0 across [a, b]. */
const bump = (t: number, a: number, b: number) => Math.sin(Math.PI * seg(t, a, b));

export { eOut, seg };

/** Each state's own rhythm; the phase keeps a roster from moving in lockstep. */
export const STATE_MOTION: Record<FaceState, (t: number, phase: number) => PoseDelta> = {
  idle(t, phase) {
    const breath = Math.sin(t * 1.5 + phase);
    return { sy: 1 + .012 * breath, eyeSy: 1 - .025 * breath };
  },
  thinking(t, phase) {
    const thought = Math.sin(t * 1.35 + phase);
    return { rot: 2.4 * thought, eyeDx: 2.2 * thought, eyeDy: -.8 * thought, yaw: .1 * thought, dy: -.6 * (1 + thought) };
  },
  working(t, phase) {
    const sweep = Math.sin(t * 4.6 + phase);
    return { eyeDx: 3.8 * sweep, lid: .13, rot: .7 * Math.sin(t * 7 + phase), dy: .55 * Math.abs(sweep), sx: .975, sy: 1.02 };
  },
  waiting(t, phase) {
    const look = Math.sin(t * 1.7 + phase);
    return { eyeDx: 2.7 * look, eyeSy: 1 + .06 * (1 + look), rot: 2 * Math.sin(t * 1.2 + phase), sy: .975, dx: -.45 * look };
  },
  done(t, phase) {
    const float = .5 + .5 * Math.sin(t * 2.4 + phase);
    return { dy: -1.3 * float, rot: 1.3 * Math.sin(t * 1.8 + phase), sx: 1 + .015 * float, sy: 1 - .02 * float, shadowSx: 1 + .06 * float, shadowO: 1 - .1 * float };
  }
};

// ── the behaviour library ──────────────────────────────────────────────

function hop(t: number): PoseDelta {
  const A = 5.2; // a small, honest hop
  if (t < .16) { const x = eOut(seg(t, 0, .16)); return { sy: 1 - .06 * x, sx: 1 + .045 * x, shadowSx: 1 + .05 * x }; }
  if (t < .6) { const x = eOut(seg(t, .16, .6)); return { dy: -A * x, sy: 1 + .03 * (1 - x), shadowO: 1 - .2 * x, shadowSx: 1 - .1 * x }; }
  if (t < .8) { const x = eIn(seg(t, .6, .8)); return { dy: -A * (1 - x) }; }
  if (t < .93) { const x = eOut(seg(t, .8, .93)); return { sy: 1 - .07 * x, sx: 1 + .06 * x, shadowSx: 1 + .08 * x }; }
  const x = seg(t, .93, 1);
  return { sy: 1 + .07 * (1 - x), sx: 1 - .06 * (1 - x) };
}

const DART: Array<[number, number]> = [[-5.5, .1], [4, .2], [-2, .13], [5.5, .16], [0, .1], [-4, .14], [2, .13]];

export const BEHAVIOURS: Record<string, (t: number) => PoseDelta> = {
  hop,
  doubleHop(t) {
    const one = hop(t < .5 ? t * 2 : (t - .5) * 2);
    return { dy: (one.dy ?? 0) * .6, sy: 1 + ((one.sy ?? 1) - 1) * .7, sx: 1 + ((one.sx ?? 1) - 1) * .7, shadowO: one.shadowO ?? 1, shadowSx: one.shadowSx ?? 1 };
  },
  squashLand(t) {
    const x = bump(t, .25, .75);
    return { sy: 1 - .08 * x, sx: 1 + .07 * x, shadowSx: 1 + .09 * x, dy: 1.2 * x };
  },
  breathe(t) {
    const x = Math.sin(t * Math.PI * 2);
    return { sy: 1 + .022 * x, sx: 1 - .016 * x, dy: -.5 * x, shadowO: 1 - .06 * x, lid: .1 + .08 * (1 - x) };
  },
  sway(t) {
    const x = Math.sin(t * Math.PI * 2);
    return { rot: 2.0 * x, dy: .3 * x };
  },
  drift(t) {
    const x = Math.sin(t * Math.PI * 2);
    return { dy: -1.1 * x, rot: 1.1 * x, eyeDx: 1.8 * Math.sin(t * Math.PI * 2 + .8) };
  },
  gaze(t) {
    const x = lerp(-4.4, 3.4, eIO(seg(t, .05, .5))) * (1 - eIO(seg(t, .72, 1)));
    return { eyeDx: x, dy: -.3 * bump(t, 0, 1) };
  },
  nudge(t) {
    const x = bump(t, .12, .88);
    return { dy: -.7 * x, eyeSx: 1 + .04 * x, wide: 1 + .05 * x };
  },
  recoil(t) {
    const x = bump(t, 0, 1);
    return { dx: -1.3 * x, sx: 1 - .035 * x, sy: 1 + .03 * x, wide: 1 + .24 * x, eyeSy: 1 + .1 * x, lid: -.1 * x };
  },
  peek(t) {
    const x = bump(t, .15, .85);
    return { sx: 1 - .07 * x, sy: 1 + .04 * x, dy: 1.0 * x, lid: .3 * x, eyeDx: -2.6 * x };
  },
  squint(t) {
    const x = bump(t, .1, .9);
    return { lid: .48 * x, eyeSy: 1 - .12 * x, eyeSx: 1 + .07 * x };
  },
  wide(t) {
    const x = bump(t, .05, .95);
    return { wide: 1 + .28 * x, eyeSy: 1 + .15 * x, lid: -.08 * x, sy: 1 + .025 * x };
  },
  blinkTwice(t) {
    return { lid: bump(t, .15, .27) + bump(t, .42, .54) };
  },
  blinkSlow(t) {
    return { lid: bump(t, .2, .8) * .9 };
  },
  playfulBlink(t) {
    const x = bump(t, .1, .9);
    return { lid: .55 * x, eyeDx: 1.7 * x, wide: 1 + .08 * x, rot: -2 * x };
  },
  tilt(t) {
    const x = bump(t, .1, .9);
    return { rot: 5.5 * x, eyeDx: 1.2 * x, dy: -.4 * x };
  },
  blush(t) {
    const x = bump(t, .15, .85);
    return { eyeSx: 1 - .06 * x, eyeSy: 1 - .09 * x, rot: 2 * x, dy: -.4 * x };
  },
  nods(t) {
    const x = Math.sin(t * Math.PI * 2);
    return { rot: 2.2 * x, dy: .7 * x, lid: .2 };
  },
  concentrate(t) {
    const x = bump(t, .1, .9);
    return { lid: .32 * x, eyeSy: 1 - .08 * x, rot: -1.4 * x, dy: .5 * x };
  },
  /** Reading: the eye sweeps along a line, then back. */
  scan(t) {
    const a = eIO(seg(t, .05, .42)), b = eIO(seg(t, .45, .72)), c = eIO(seg(t, .75, .95));
    const x = t < .45 ? lerp(-5, 5, a) : t < .75 ? lerp(5, -3.5, b) : lerp(-3.5, 0, c);
    return { eyeDx: x, lid: .2, rot: x * .12 };
  },
  /** Searching: small quick saccades. */
  dart(t) {
    let t0 = 0, x = 0;
    for (const [v, d] of DART) {
      if (t < t0 + d) { x = v; break; }
      t0 += d;
    }
    return { eyeDx: x * (1 - seg(t, .92, 1)), wide: 1.06 };
  },
  /** Writing: small busy motions. */
  scribble(t) {
    const x = Math.sin(t * Math.PI * 6), y = Math.sin(t * Math.PI * 4 + 1);
    return { rot: 1.1 * x, dy: .7 * Math.abs(x), eyeDx: 1.6 * y, lid: .28 };
  },
  /** Running a command: focused and tense. */
  vibrate(t) {
    const x = Math.sin(t * Math.PI * 18);
    return { rot: .35 * x, dx: .22 * x, dy: .3 * Math.abs(x), lid: .28, wide: 1.04 };
  },
  brace(t) {
    const x = bump(t, .1, .9);
    return { sy: 1 - .04 * x, sx: 1 + .045 * x, dy: .9 * x, lid: .18 };
  },
  /** Over in a blink, and not a scream. */
  startle(t) {
    const pop = eOut(seg(t, 0, .18));
    const back = eIO(seg(t, .18, .6));
    return { sy: 1 + .08 * pop - .03 * back, sx: 1 - .05 * pop, dy: -1.6 * pop + .4 * back, wide: 1 + .3 * pop, eyeSy: 1 + .13 * pop, lid: -.1 * pop, rot: -1.8 * pop, shadowSx: 1 - .09 * pop, shadowO: 1 - .16 * pop };
  },
  doze(t) {
    const x = bump(t, .1, .95);
    return { lid: .96 * x, rot: 4 * x, dy: 1.6 * x, sy: 1 - .03 * x };
  },
  wiggle(t) {
    return { rot: 2.8 * Math.sin(t * Math.PI * 5) * (1 - seg(t, .8, 1)) };
  },
  shake(t) {
    return { dx: 1.2 * Math.sin(t * Math.PI * 8) * (1 - seg(t, .82, 1)), rot: .9 * Math.sin(t * Math.PI * 8) };
  },
  /** A small "hmph" over the shoulder. */
  turnAway(t) {
    const x = bump(t, .1, .9);
    return { yaw: -.55 * x, rot: -2.2 * x, lid: .3 * x, eyeDx: -2 * x };
  },
  celebrate(t) {
    const h = hop(Math.min(1, t * 1.1));
    return { dy: h.dy, sy: h.sy, sx: h.sx, shadowO: h.shadowO, shadowSx: h.shadowSx, wide: 1 + .12 * bump(t, 0, 1), rot: 2 * Math.sin(t * Math.PI * 3) * (1 - seg(t, .85, 1)) };
  },
  sparkle(t) {
    const x = bump(t, 0, 1);
    return { sy: 1 + .05 * x, sx: 1 - .035 * x, dy: -1.0 * x, wide: 1 + .16 * x, rot: 2 * x };
  }
};

/** Behaviours that borrow another silhouette while they run. */
export const MORPH: Record<string, ShapeName> = {
  startle: 'spiky', celebrate: 'wide', sparkle: 'flower', doze: 'egg',
  hop: 'drop', doubleHop: 'drop', squashLand: 'wide', breathe: 'circle',
  playfulBlink: 'flower', blush: 'cloud', wide: 'spiky'
};
