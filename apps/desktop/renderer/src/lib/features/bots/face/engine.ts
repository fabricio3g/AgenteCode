// The avatar engine: builds one face's SVG and animates every face on the
// page from a single shared frame loop.
//
// Tuned for the app rather than a showcase page:
// - one requestAnimationFrame for all faces, running only while a face is
//   on screen, the window is visible and motion is allowed
// - offscreen faces (IntersectionObserver) are skipped entirely
// - an attribute is written only when its value changed
// - small faces drop the costly layers (grain, second ink, depth) and
//   redraw at half rate; their outlines use fewer points
// - `prefers-reduced-motion` draws one still pose, redrawn only on change
// - gradients live in each face's own <defs>, so a face is self-contained

import {
  clamp, CX, CY, DOODLES, eyePath, arcPath, f2, FLOOR, lerp, PIVOT, R,
  closedBezier, contourPoints, polyLen, ribbonPath, rimPath, type Doodle, type ShapeName
} from './geometry';
import { faceIdentity, type FaceEvent, type FaceIdentity } from './cast';
import {
  addDelta, BEHAVIOURS, blankPose, eOut, MORPH, seg, STATE_ENTRANCE, STATE_MOTION, STATES,
  type FaceState, type Pose, type PoseDelta
} from './motion';

export type { FaceEvent } from './cast';
export type { FaceState } from './motion';

const SVGNS = 'http://www.w3.org/2000/svg';
const VARIANTS = 3;
/** Lateral travel of the face layer for a full head turn, in viewBox units. */
const TURN = 7;
/** How far each layer travels for a full turn. */
const PARALLAX = { face: 1.0, art: 0.26, shade: 0.52, shadow: -0.14 };
/** Behaviours running at once across the page: a roster, not a circus. */
const MAX_LIVE = 2;
const PARTICLE_SLOTS = 3;

/** Below this a face drops grain, the second ink line and the depth plate. */
const LITE_BELOW = 28;
const GRAIN_FROM = 40;
/** Faces this small redraw at half the frame rate. */
const HALF_RATE_UP_TO = 32;

/** Which activity a tool call is, for the face's reaction. */
const EVENT_STATE: Record<FaceEvent, FaceState> = {
  read: 'thinking', search: 'thinking', write: 'working', run: 'working', error: 'waiting', done: 'done'
};
const EVENT_FALLBACK: Record<FaceEvent, string> = {
  read: 'scan', search: 'dart', write: 'scribble', run: 'vibrate', error: 'startle', done: 'celebrate'
};

// ── attribute writes, deduplicated ─────────────────────────────────────

const written = new WeakMap<Element, Map<string, string>>();

function set(node: Element, name: string, value: string): void {
  let attrs = written.get(node);
  if (!attrs) {
    attrs = new Map();
    written.set(node, attrs);
  }
  if (attrs.get(name) === value) return;
  attrs.set(name, value);
  node.setAttribute(name, value);
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVGNS, name);
  if (attrs) for (const key in attrs) node.setAttribute(key, String(attrs[key]));
  return node;
}

// ── per-bot, per-size pieces that never change with the pose ──────────

interface Variant { eyeL: string; eyeR: string; happyL: string; happyR: string }
interface Variants { sw: number; list: Variant[] }

const variantCache = new Map<string, Variants>();

function variantsFor(id: FaceIdentity, size: number): Variants {
  const key = `${id.seed}:${size}`;
  const hit = variantCache.get(key);
  if (hit) return hit;
  const list: Variant[] = [];
  for (let v = 0; v < VARIANTS; v++) {
    list.push({
      eyeL: eyePath(5.3, 8.8, id.seed + v * 13, 0.10),
      eyeR: eyePath(5.3, 8.8, id.seed + v * 13 + 4, 0.10),
      happyL: arcPath(5.0, 3.6, id.seed + v),
      happyR: arcPath(5.0, 3.6, id.seed + v + 4)
    });
  }
  const out = { sw: clamp((1.55 * 100) / size, 1.9, 3.4), list };
  variantCache.set(key, out);
  return out;
}

let uid = 0;

interface Particle { g: SVGGElement; node: SVGPathElement; on: boolean; t: number; dur: number; ax: number; rot: number }
interface Running { fn: (t: number) => PoseDelta; morph: ShapeName | null; t: number; dur: number; scale: number }

/** One reaction to play: a new `seq` plays it once. */
export type FaceCue = { event: FaceEvent; seq: number };

export interface FaceOptions {
  /** A stable key for the face (a bot's handle). */
  key: string;
  /** The tint family the person picked. */
  tint?: string;
  /** Pixel size of the square face. */
  size: number;
}

/** One animated face. Create with {@link mountFace}; call `destroy` when done. */
export class Face {
  readonly id: FaceIdentity;
  readonly size: number;
  readonly host: HTMLElement;
  readonly svg: SVGSVGElement;
  visible = true;

  #lite: boolean;
  #points: number;
  #variants: Variants;
  #n: {
    bob: SVGGElement; depth: SVGPathElement; face: SVGGElement; shadow: SVGEllipseElement;
    layers: SVGPathElement[]; rim: SVGPathElement; ribbon: SVGPathElement; ink: SVGPathElement; ink2: SVGPathElement | null;
    eyeL: SVGGElement; eyeR: SVGGElement; pupilL: SVGPathElement; pupilR: SVGPathElement; socketL: SVGPathElement; socketR: SVGPathElement;
    lin: SVGLinearGradientElement; rad: SVGRadialGradientElement; vig: SVGRadialGradientElement;
    turnLeft: SVGStopElement; turnRight: SVGStopElement;
  };
  #px: Particle[] = [];

  #state: FaceState = 'idle';
  #shape = { v: 0, sqx: 1, sqy: 1, mk: 0, morphTo: null as ShapeName | null };
  #lastShape = { v: -1, sqx: 0, sqy: 0, mk: -1, morphTo: null as ShapeName | null };
  #angle: number;
  #boilT = 0;
  #blink = 1;
  #blinkP = 1;
  #nextBlink: number;
  #nextTic: number;
  #gaze = { x: 0, y: 0 };
  #eyeScale = { x: 1, y: 1 };
  #quizz = 0;
  #happy = 0;
  #tilt = 0;
  #hover = 0;
  #hovered = false;
  #yaw = 0; #pitch = 0; #yawVel = 0; #pitchVel = 0; #lookX = 0; #lookY = 0;
  #box = { x: 0, y: 0, ok: false };
  #behaviours: Running[] = [];
  #skip = 0;
  #pending = 0;

  constructor(host: HTMLElement, options: FaceOptions) {
    this.host = host;
    this.size = options.size;
    this.id = faceIdentity(options.key, options.tint);
    this.#lite = this.size < LITE_BELOW;
    this.#points = this.size < LITE_BELOW ? 20 : this.size < GRAIN_FROM ? 26 : 32;
    this.#variants = variantsFor(this.id, this.size);
    this.#angle = this.id.angle;
    const phase = this.id.bobPhase;
    this.#nextBlink = 1.5 + (phase * 1.37) % 4;
    this.#nextTic = 2 + (phase * 1.9) % 6;

    const s = ++uid;
    const sw = this.#variants.sw;
    const svg = el('svg', { viewBox: '0 0 100 100', width: this.size, height: this.size, 'aria-hidden': 'true', focusable: 'false' });
    const defs = el('defs');
    svg.appendChild(defs);
    const g = this.#gradients(defs, s);

    const grain = this.size >= GRAIN_FROM;
    if (grain) {
      const filter = el('filter', { id: `grain-${s}`, x: '-6%', y: '-6%', width: '112%', height: '112%' });
      filter.innerHTML =
        '<feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="2" seed="7" result="n"/>'
        + '<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  .16 .16 .16 0 -.16" result="speck"/>'
        + '<feFlood flood-color="currentColor" result="col"/>'
        + '<feComposite in="col" in2="speck" operator="in" result="tinted"/>'
        + '<feComposite in="tinted" in2="SourceGraphic" operator="in"/>';
      defs.appendChild(filter);
    }

    // The shadow stays outside the body: the head moves, the floor does not.
    const shadow = el('ellipse', { cx: 50, cy: FLOOR + 2.5, rx: 16, ry: 4.2, fill: `url(#shd-${s})`, opacity: 0.9 });
    svg.appendChild(shadow);

    const bob = el('g');
    const depth = el('path', { d: '', fill: `url(#depth-${s})`, stroke: 'currentColor', 'stroke-width': f2(sw * .6), 'stroke-opacity': .25, opacity: this.#lite ? 0 : .88 });
    const art = el('g');
    const face = el('g');
    bob.append(depth, art, face);

    const layers = [
      el('path', { d: '', fill: `url(#lin-${s})` }),
      el('path', { d: '', fill: `url(#turn-${s})` }),
      el('path', { d: '', fill: `url(#vig-${s})` }),
      el('path', { d: '', fill: `url(#rad-${s})` })
    ];
    if (grain) layers.push(el('path', { d: '', class: 'grain', filter: `url(#grain-${s})` }));
    const rim = el('path', { d: '', class: 'rim', fill: 'none', 'stroke-width': f2(sw * .8), 'stroke-linecap': 'round', opacity: 0.5 });
    const ribbon = el('path', { d: '', class: 'ribbon', opacity: 0.22 });
    const ink2 = this.#lite ? null : el('path', { d: '', class: 'ink2', fill: 'none', stroke: 'currentColor', 'stroke-width': f2(sw * 1.15), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.13 });
    const ink = el('path', { d: '', class: 'ink', fill: 'none', stroke: 'currentColor', 'stroke-width': f2(sw), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    art.append(...layers, rim, ribbon, ...(ink2 ? [ink2] : []), ink);

    if (this.id.spark && !this.#lite) {
      const acc = el('g', { class: 'acc' });
      acc.append(
        el('path', { class: 'fx', d: DOODLES.star, opacity: .8, transform: 'translate(78,15) scale(.9)' }),
        el('path', { class: 'fx', d: DOODLES.star, opacity: .5, transform: 'translate(25,86) scale(.6)' })
      );
      art.appendChild(acc);
    }

    const eyeL = el('g', { class: 'eye' }), eyeR = el('g', { class: 'eye' });
    const socketL = el('path', { class: 'socket', d: '', transform: 'translate(0,1.4)' });
    const socketR = el('path', { class: 'socket', d: '', transform: 'translate(0,1.4)' });
    const pupilL = el('path', { d: '', 'stroke-width': f2(sw * .5) });
    const pupilR = el('path', { d: '', 'stroke-width': f2(sw * .5) });
    eyeL.append(socketL, pupilL);
    eyeR.append(socketR, pupilR);
    face.append(eyeL, eyeR);

    const fx = el('g', { class: 'fx' });
    for (let k = 0; k < PARTICLE_SLOTS; k++) {
      const pg = el('g', { opacity: 0 });
      const node = el('path', { d: DOODLES.spark });
      pg.appendChild(node);
      fx.appendChild(pg);
      this.#px.push({ g: pg, node, on: false, t: 0, dur: 1, ax: 12, rot: 0 });
    }
    svg.append(fx, bob);

    this.#n = {
      bob, depth, face, shadow, layers, rim, ribbon, ink, ink2,
      eyeL, eyeR, pupilL, pupilR, socketL, socketR,
      lin: g.lin, rad: g.rad, vig: g.vig, turnLeft: g.turnLeft, turnRight: g.turnRight
    };
    this.svg = svg;
    host.appendChild(svg);
    this.#applyFace();
  }

  #gradients(defs: SVGDefsElement, s: number) {
    const [light, mid, deep] = this.id.colors;
    const stops = (grad: SVGElement, list: Array<[string, string, number?]>) => {
      for (const [offset, color, opacity] of list) {
        grad.appendChild(el('stop', { offset, 'stop-color': color, ...(opacity === undefined ? {} : { 'stop-opacity': opacity }) }));
      }
    };
    const lin = el('linearGradient', { id: `lin-${s}`, gradientUnits: 'userSpaceOnUse', x1: 12, y1: 10, x2: 88, y2: 90 });
    stops(lin, [['0%', light], ['50%', mid], ['100%', deep]]);
    // The bounce light: a soft specular on the lit side.
    const rad = el('radialGradient', { id: `rad-${s}`, gradientUnits: 'userSpaceOnUse', cx: 36, cy: 27, r: 62 });
    stops(rad, [['0%', '#ffffff', .58], ['46%', '#ffffff', .10], ['100%', '#ffffff', 0]]);
    // The terminator: shadow gathering where the form turns away.
    const vig = el('radialGradient', { id: `vig-${s}`, gradientUnits: 'userSpaceOnUse', cx: 68, cy: 82, r: 66 });
    stops(vig, [['0%', '#2b1a2e', .26], ['46%', '#2b1a2e', .08], ['100%', '#2b1a2e', 0]]);
    // A terminator that turns with the face; the specular stays with the room light.
    const turn = el('linearGradient', { id: `turn-${s}`, gradientUnits: 'userSpaceOnUse', x1: 5, y1: 50, x2: 95, y2: 50 });
    const turnLeft = el('stop', { offset: '0%', 'stop-color': '#302033', 'stop-opacity': .08 });
    const turnRight = el('stop', { offset: '100%', 'stop-color': '#302033', 'stop-opacity': .08 });
    turn.append(turnLeft, el('stop', { offset: '50%', 'stop-color': '#302033', 'stop-opacity': 0 }), turnRight);
    const depth = el('linearGradient', { id: `depth-${s}`, gradientUnits: 'userSpaceOnUse', x1: 18, y1: 10, x2: 80, y2: 95 });
    stops(depth, [['0%', mid], ['65%', deep], ['100%', '#533b4a']]);
    // The contact shadow: a soft ellipse, no filter.
    const shd = el('radialGradient', { id: `shd-${s}`, gradientUnits: 'userSpaceOnUse', cx: 50, cy: 92, r: 21 });
    stops(shd, [['0%', '#241a2a', .22], ['58%', '#241a2a', .05], ['100%', '#241a2a', 0]]);
    defs.append(lin, rad, vig, turn, depth, shd);
    return { lin, rad, vig, turnLeft, turnRight };
  }

  get state(): FaceState {
    return this.#state;
  }

  /** Move to a state; an entrance behaviour plays when it changes. */
  setState(state: FaceState, animate = true): void {
    const changed = this.#state !== state;
    if (changed && this.#behaviours.length) {
      live -= this.#behaviours.length;
      this.#behaviours.length = 0;
    }
    this.#state = state;
    this.#happy = STATES[state].happy;
    this.#applyFace();
    if (changed && animate) this.play(STATE_ENTRANCE[state], state === 'done' ? 1.25 : .9);
    if (changed) requestStill(this);
  }

  /** React to something the bot did, in its own temperament. */
  react(event: FaceEvent, strength = 1): void {
    const t = this.id.t;
    this.setState(EVENT_STATE[event], false);
    this.play(t.react[event] || EVENT_FALLBACK[event], event === 'done' ? 1.5 : 1.0, strength * lerp(0.7, 1, t.energy));
    if (event === 'error') this.#spawn('drop');
    if (event === 'done') this.#spawn(t.react.done === 'blush' ? 'heart' : 'spark');
  }

  setHovered(hovered: boolean): void {
    this.#hovered = hovered;
  }

  play(name: string, dur?: number, scale = 1): void {
    const fn = BEHAVIOURS[name];
    if (!fn || !motionAllowed()) return;
    if (this.#behaviours.length >= 2) {
      this.#behaviours.shift();
      live--;
    }
    // Shy bots under-react, eager bots over-react.
    this.#behaviours.push({
      fn, morph: MORPH[name] ?? null, t: 0,
      dur: dur ?? 0.75 + Math.random() * 0.5,
      scale: clamp(scale * lerp(0.55, 1.25, this.id.t.energy), 0.3, 1.4)
    });
    live++;
    ensureLoop();
  }

  refreshBox(): void {
    const r = this.svg.getBoundingClientRect();
    this.#box = { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: r.width > 0 };
  }

  destroy(): void {
    live -= this.#behaviours.length;
    this.#behaviours.length = 0;
    this.svg.remove();
    unregister(this);
  }

  /** One frame. `moving` is false under reduced motion: a still, calm pose. */
  tick(dt: number, clock: number, moving: boolean): void {
    // Small faces redraw at half rate: accumulate time, draw every other frame.
    if (moving && this.size <= HALF_RATE_UP_TO) {
      this.#pending += dt;
      if ((this.#skip ^= 1) === 1) return;
      dt = this.#pending;
    }
    this.#pending = 0;
    this.#update(dt, clock, moving);
  }

  #spawn(kind: Doodle): void {
    if (!motionAllowed()) return;
    const slot = this.#px.find((p) => !p.on) ?? this.#px[0];
    slot.on = true;
    slot.t = 0;
    slot.dur = 0.85 + Math.random() * 0.45;
    slot.ax = 10 + Math.random() * 12;
    slot.rot = (Math.random() * 2 - 1) * 45;
    set(slot.node, 'd', DOODLES[kind]);
    set(slot.g, 'opacity', '1');
    ensureLoop();
  }

  #applyFace(): void {
    const V = this.#variants.list[this.#shape.v];
    const happy = this.#happy > 0.5;
    const n = this.#n;
    set(n.pupilL, 'd', happy ? V.happyL : V.eyeL);
    set(n.pupilR, 'd', happy ? V.happyR : V.eyeR);
    set(n.socketL, 'd', V.eyeL);
    set(n.socketR, 'd', V.eyeR);
    set(n.eyeL, 'class', happy ? 'eye happy' : 'eye');
    set(n.eyeR, 'class', happy ? 'eye happy' : 'eye');
  }

  /** The drawing is rebuilt only when the shape actually moved. */
  #refreshArt(): void {
    const s = this.#shape, l = this.#lastShape;
    if (Math.abs(s.sqx - l.sqx) < .0022 && Math.abs(s.sqy - l.sqy) < .0022
      && Math.abs(s.mk - l.mk) < .02 && s.v === l.v && s.morphTo === l.morphTo) return;
    Object.assign(l, s);
    const id = this.id;
    const [ax, ay] = id.aspect;
    const pts = contourPoints(id.seed, s.v, R, 0.075, ax, ay, id.shape, s.morphTo, s.mk, s.sqx, s.sqy, id.form, this.#points);
    const d = closedBezier(pts);
    const n = this.#n;
    for (const layer of n.layers) set(layer, 'd', d);
    set(n.depth, 'd', d);
    set(n.ink, 'd', d);
    const L = polyLen(pts);
    set(n.ink, 'stroke-dasharray', f2(L * .975) + ' ' + f2(L * .05));
    set(n.ink, 'stroke-dashoffset', f2(L * .31));
    set(n.rim, 'd', rimPath(pts, id.light, 0.85));
    const pts2 = contourPoints(id.seed + 501, s.v + 5, R * 1.030, 0.08, ax, ay, id.shape, s.morphTo, s.mk, s.sqx, s.sqy, id.form, this.#points);
    set(n.ribbon, 'd', ribbonPath(pts2, id.light, 1.45));
    if (n.ink2) {
      const L2 = polyLen(pts2);
      set(n.ink2, 'd', closedBezier(pts2));
      set(n.ink2, 'stroke-dasharray', f2(L2 * .56) + ' ' + f2(L2 * .5));
      set(n.ink2, 'stroke-dashoffset', f2(L2 * .12));
    }
  }

  #update(dt: number, clock: number, moving: boolean): void {
    const t = this.id.t, st = STATES[this.#state];
    const k = Math.min(1, dt * 7);
    const settle = !moving || dt === 0;

    const toward = (a: number, b: number, w: number) => (settle ? b : lerp(a, b, w));
    this.#eyeScale.x = toward(this.#eyeScale.x, st.eye[0], k);
    this.#eyeScale.y = toward(this.#eyeScale.y, st.eye[1], k);
    this.#quizz = toward(this.#quizz, st.quizz, k);
    this.#tilt = toward(this.#tilt, st.tilt, k);
    this.#happy = toward(this.#happy, st.happy, Math.min(1, dt * 6));
    this.#hover = moving ? lerp(this.#hover, this.#hovered ? 1 : 0, Math.min(1, dt * 6)) : 0;
    this.#gaze.x = toward(this.#gaze.x, st.gaze[0], Math.min(1, dt * 5));
    this.#gaze.y = toward(this.#gaze.y, st.gaze[1], Math.min(1, dt * 5));

    // Blink.
    this.#blink = 1;
    if (moving && st.blinkMul < 90) {
      this.#nextBlink -= dt * lerp(0.6, 1.6, t.blinkRate);
      if (this.#nextBlink <= 0 && this.#blinkP >= 1) this.#blinkP = 0;
      if (this.#blinkP < 1) {
        this.#blinkP += dt / (.16 / lerp(0.7, 1.5, t.blinkRate));
        this.#blink = 1 - .94 * Math.sin(Math.PI * clamp(this.#blinkP, 0, 1));
        if (this.#blinkP >= 1) this.#nextBlink = (1.6 + Math.random() * 4) * st.blinkMul;
      }
    }

    // The boil: a new drawing of the same shape.
    if (moving) {
      this.#boilT += dt * st.boil * t.boilRate;
      if (this.#boilT >= 1) {
        this.#boilT %= 1;
        this.#shape.v = (this.#shape.v + 1) % VARIANTS;
      }
    }

    // Idle habits: rare, and never more than a couple on screen at once.
    if (moving && this.#state === 'idle') {
      this.#nextTic -= dt;
      if (this.#nextTic <= 0) {
        this.#nextTic = 7 + Math.random() * 7;
        if (live < MAX_LIVE) this.play(t.tics[Math.floor(Math.random() * t.tics.length)]);
      }
    }

    for (let i = this.#behaviours.length - 1; i >= 0; i--) {
      const b = this.#behaviours[i];
      b.t += dt / (b.dur / b.scale);
      if (b.t >= 1) {
        this.#behaviours.splice(i, 1);
        live--;
      }
    }
    this.#tickParticles(dt);

    const p = this.#compose(dt, clock, moving);
    // Squash, stretch and morph land in the outline; size never changes.
    this.#shape.sqx = p.sx * (1 - Math.abs(p.yaw) * .055);
    this.#shape.sqy = p.sy * (1 + Math.abs(p.yaw) * .012 - Math.abs(p.pitch) * .035);
    this.#shape.mk = p.morph;
    this.#shape.morphTo = p.morph > 0.001 ? p.morphTo ?? this.#shape.morphTo : null;
    this.#refreshArt();
    this.#applyFace();
    this.#paintLight(dt, clock, moving);
    this.#applyPose(p);
  }

  #compose(dt: number, clock: number, moving: boolean): Pose {
    const t = this.id.t, st = STATES[this.#state], phase = this.id.bobPhase;
    const p = blankPose();
    p.eyeSx = this.#eyeScale.x;
    p.eyeSy = this.#eyeScale.y;
    p.rot = this.#tilt;
    p.eyeDx = this.#gaze.x;
    p.eyeDy = this.#gaze.y;
    if (moving) {
      p.dy = Math.sin(clock * st.bob + phase) * st.bobAmp;
      addDelta(p, STATE_MOTION[this.#state](clock, phase), 1);
      p.dy -= this.#hover * .85;
      p.wide += this.#hover * .05;
      p.shadowSx -= this.#hover * .04;
      p.shadowO -= this.#hover * .08;
    }
    for (const b of this.#behaviours) {
      const env = Math.max(0, Math.min(1, b.t / .14, (1 - b.t) / .14));
      addDelta(p, b.fn(clamp(b.t, 0, 1)), env);
      if (b.morph && env > 0) {
        p.morph = env;
        p.morphTo = b.morph;
      }
    }

    // The head turns toward the pointer; eyes lead, the body follows on a spring.
    let wantYaw = 0, wantPitch = 0;
    if (moving && pointer && this.#box.ok) {
      const dx = pointer.x - this.#box.x, dy = pointer.y - this.#box.y;
      const dist = Math.hypot(dx, dy) || 1;
      const attention = clamp(1 - dist / 640, 0, 1) * lerp(.85, 1, t.curiosity);
      wantYaw = clamp(dx / Math.max(65, dist), -1, 1) * attention;
      wantPitch = clamp(dy / Math.max(65, dist), -1, 1) * attention;
    }
    if (moving) {
      const follow = 1 - Math.exp(-dt * 19);
      this.#lookX = lerp(this.#lookX, wantYaw, follow);
      this.#lookY = lerp(this.#lookY, wantPitch, follow);
      const damping = Math.exp(-dt * 15);
      this.#yawVel = (this.#yawVel + (wantYaw - this.#yaw) * 120 * dt) * damping;
      this.#pitchVel = (this.#pitchVel + (wantPitch - this.#pitch) * 120 * dt) * damping;
      this.#yaw += this.#yawVel * dt;
      this.#pitch += this.#pitchVel * dt;
    } else {
      this.#lookX = this.#lookY = this.#yaw = this.#pitch = this.#yawVel = this.#pitchVel = 0;
    }
    p.yaw += this.#yaw * (0.85 + t.energy * 0.3);
    p.pitch += this.#pitch * (0.85 + t.energy * 0.3);
    p.eyeDx = clamp(p.eyeDx + this.#lookX * 4.2, -7, 7);
    p.eyeDy = clamp(p.eyeDy + this.#lookY * 3.1, -6, 6);
    p.rot += this.#yaw * 1.1;
    return p;
  }

  /** The specular drifts in busy states and barely follows the turn: the light is in the room. */
  #paintLight(dt: number, clock: number, moving: boolean): void {
    const st = STATES[this.#state];
    if (moving) this.#angle += dt * st.sweep;
    const c = Math.cos(this.#angle) * 62, s = Math.sin(this.#angle) * 62;
    const lin = this.#n.lin;
    set(lin, 'x1', f2(CX + c));
    set(lin, 'y1', f2(CY + s));
    set(lin, 'x2', f2(CX - c));
    set(lin, 'y2', f2(CY - s));
    const t = (moving ? clock * 0.9 : 0) + this.id.hlA;
    const r = st.hlAmp * (st.sweep > 0 ? 1 : 0.35);
    const u = this.#yaw * TURN, v = this.#pitch * TURN * .8;
    set(this.#n.rad, 'cx', f2(36 + Math.cos(t) * r - u * .42));
    set(this.#n.rad, 'cy', f2(27 + Math.sin(t * .8) * r - v * .32));
  }

  #applyPose(p: Pose): void {
    const n = this.#n;
    const u = p.yaw * TURN, v = p.pitch * TURN * 0.8;
    set(n.bob, 'transform', `translate(${f2(p.dx + u * PARALLAX.art)},${f2(p.dy)}) rotate(${f2(p.rot)},50,${PIVOT})`);
    set(n.depth, 'transform', `translate(${f2(-u * .55)},${f2(2 + v * .3)})`);
    set(n.turnLeft, 'stop-opacity', f2(.08 + Math.max(0, p.yaw) * .42));
    set(n.turnRight, 'stop-opacity', f2(.08 + Math.max(0, -p.yaw) * .42));
    set(n.face, 'transform', `translate(${f2(u * (PARALLAX.face - PARALLAX.art))},${f2(v * .12)})`);
    set(n.vig, 'cx', f2(68 + u * PARALLAX.shade));
    set(n.vig, 'cy', f2(82 + v * PARALLAX.shade));
    // The floor loses contact a little as the head comes off it.
    const lift = Math.max(0, -p.dy);
    set(n.shadow, 'transform', `translate(${f2(u * PARALLAX.shadow)},0) translate(50,${FLOOR}) scale(${f2(p.shadowSx * (1 + lift * .025))},1) translate(-50,-${FLOOR})`);
    set(n.shadow, 'opacity', f2(clamp(p.shadowO * (1 - lift * .045), 0, 1)));

    const sy = clamp(1 - p.lid, 0.07, 1.6) * this.#blink;
    const sx = p.wide * p.eyeSx;
    const exL = 40.5, exR = 59.5, ey = 46.5, q = this.#quizz;
    set(n.eyeL, 'transform', `translate(${f2(exL + p.eyeDx)},${f2(ey + p.eyeDy)}) scale(${f2(sx)},${f2(sy * p.eyeSy)})`);
    set(n.eyeR, 'transform', `translate(${f2(exR + p.eyeDx + q * .6)},${f2(ey + p.eyeDy - q * 3)}) scale(${f2(sx * (1 - q * .22))},${f2(sy * p.eyeSy * (1 - q * .35))})`);
  }

  #tickParticles(dt: number): void {
    for (const s of this.#px) {
      if (!s.on) continue;
      s.t += dt / s.dur;
      if (s.t >= 1) {
        s.on = false;
        set(s.g, 'opacity', '0');
        continue;
      }
      const x = s.ax * eOut(s.t);
      const y = -16 * eOut(s.t) + 6 * s.t * s.t;
      const sc = 0.5 + eOut(seg(s.t, 0, .25)) * 0.9;
      set(s.g, 'transform', `translate(${f2(x)},${f2(y)}) rotate(${f2(s.rot * s.t)}) scale(${f2(sc)})`);
      set(s.g, 'opacity', f2(1 - seg(s.t, .45, 1)));
    }
  }

  /** Whether this face still has something moving on its own. */
  get busy(): boolean {
    return this.#behaviours.length > 0 || this.#px.some((p) => p.on);
  }
}

// ── the shared loop ────────────────────────────────────────────────────

const faces = new Set<Face>();
let live = 0;
let raf = 0;
let last = 0;
let clock = 0;
let pointer: { x: number; y: number } | null = null;
let boxAge = Infinity;
let observer: IntersectionObserver | null = null;
let reduceQuery: MediaQueryList | null = null;
let listening = false;

function motionAllowed(): boolean {
  return !(reduceQuery?.matches ?? false);
}

function anyVisible(): boolean {
  for (const face of faces) if (face.visible) return true;
  return false;
}

function ensureLoop(): void {
  if (raf || typeof requestAnimationFrame !== 'function' || document.hidden || !motionAllowed() || !anyVisible()) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

function frame(now: number): void {
  raf = 0;
  if (document.hidden || !motionAllowed()) return;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
  last = now;
  clock += dt;
  // Boxes are cached; reading layout every frame would reflow on every tick.
  if (pointer && (boxAge += dt) > 0.4) {
    boxAge = 0;
    for (const face of faces) if (face.visible) face.refreshBox();
  }
  let visible = false;
  for (const face of faces) {
    if (!face.visible) continue;
    visible = true;
    face.tick(dt, clock, true);
  }
  if (visible) raf = requestAnimationFrame(frame);
}

/** Under reduced motion a face is drawn once, as a still, and on each change. */
function requestStill(face: Face): void {
  if (!motionAllowed()) face.tick(0, 0, false);
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  reduceQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  reduceQuery?.addEventListener('change', () => {
    for (const face of faces) requestStill(face);
    ensureLoop();
  });
  document.addEventListener('visibilitychange', ensureLoop);
  window.addEventListener('pointermove', (event) => {
    if (!pointer) boxAge = Infinity;
    pointer = { x: event.clientX, y: event.clientY };
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer = null; });
  window.addEventListener('scroll', () => { boxAge = Infinity; }, { passive: true, capture: true });
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const face = [...faces].find((f) => f.svg === entry.target);
        if (face) face.visible = entry.isIntersecting;
      }
      ensureLoop();
    });
  }
}

function unregister(face: Face): void {
  observer?.unobserve(face.svg);
  faces.delete(face);
}

/** Draw a face into `host` and keep it animated while it is on screen. */
export function mountFace(host: HTMLElement, options: FaceOptions): Face {
  listen();
  const face = new Face(host, options);
  faces.add(face);
  if (observer) {
    face.visible = false;
    observer.observe(face.svg);
  }
  face.tick(0, clock, false);
  host.addEventListener('pointerenter', () => face.setHovered(true));
  host.addEventListener('pointerleave', () => face.setHovered(false));
  ensureLoop();
  return face;
}

/** What a tool call is, for the face: reading, searching, writing or running. */
export function eventForTool(toolName: string): FaceEvent {
  const name = toolName.toLowerCase();
  if (/grep|search|find|glob|web_search|fetch|browse|lookup/.test(name)) return 'search';
  if (/write|edit|patch|create|replace|apply|todo|memory/.test(name)) return 'write';
  if (/bash|shell|run|exec|command|process|test|build/.test(name)) return 'run';
  return 'read';
}
