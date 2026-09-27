/**
 * Story twists — the GM move you can throw at a scene.
 *
 * A table of vectors, not events. The specifics belong to *this* scene, so the
 * model supplies them and the roll only picks the shape of the trouble. That is
 * the whole reason this is not a list of ready-made events: a complication has
 * to land as a consequence of what just happened, not as something bolted on
 * from a table that knows nothing about the scene.
 */

export type TwistKind = 'complication' | 'reversal' | 'revelation' | 'pressure';
export type TwistIntensity = 'mild' | 'sharp' | 'brutal';

export interface TwistVector {
  id: string;
  kind: TwistKind;
  /** The shape of the trouble, phrased to go straight into the prompt. */
  text: string;
}

export interface StoryTwist {
  vector: TwistVector;
  intensity: TwistIntensity;
}

export const TWIST_VECTORS: readonly TwistVector[] = [
  { id: 'uninvited', kind: 'complication', text: 'someone arrives who was not invited' },
  { id: 'debt', kind: 'complication', text: 'a promise comes due' },
  { id: 'ground', kind: 'complication', text: 'the surroundings stop cooperating' },
  { id: 'misread', kind: 'reversal', text: 'something everyone believed turns out to be wrong' },
  { id: 'ally', kind: 'reversal', text: 'an ally needs something badly, right now' },
  { id: 'secret', kind: 'revelation', text: 'a secret surfaces' },
  { id: 'object', kind: 'revelation', text: 'an object is not what it seemed' },
  { id: 'clock', kind: 'pressure', text: 'time runs short on something unfinished' }
];

export const TWIST_INTENSITIES: readonly TwistIntensity[] = ['mild', 'sharp', 'brutal'];

export const TWIST_INTENSITY_LABELS: Record<TwistIntensity, string> = {
  mild: 'Mild',
  sharp: 'Sharp',
  brutal: 'Brutal'
};

/** How far the turn is expected to move. */
const INTENSITY_COPY: Record<TwistIntensity, string> = {
  mild: 'let it colour the turn without rearranging it',
  sharp: 'let it change what the characters are doing',
  brutal: 'let it upend the turn and leave them worse off'
};

/** Index in range, clamped so a stray roll can never pick off the end. */
function pickAt(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.floor(value * size)));
}

/**
 * Roll a twist. `random` is injected so the pick is unit-testable — same
 * contract as `group-turn.ts`.
 */
export function pickTwist(
  random: () => number = Math.random,
  vectors: readonly TwistVector[] = TWIST_VECTORS
): StoryTwist {
  const pool = vectors.length ? vectors : TWIST_VECTORS;
  return {
    vector: pool[pickAt(random(), pool.length)]!,
    intensity: TWIST_INTENSITIES[pickAt(random(), TWIST_INTENSITIES.length)]!
  };
}

/**
 * The instruction that travels with the turn.
 *
 * "As a consequence of what just happened" is load-bearing: it is what stops a
 * twist reading as a random interruption dropped onto the scene.
 */
export function twistInstruction(twist: StoryTwist, names: { char: string; user: string }): string {
  return [
    `[Story direction — ${twist.vector.text}.]`,
    `Let it arrive as a consequence of what just happened — growing out of the scene and out of ${names.char}'s own situation, not dropping in as an interruption.`,
    `${names.user} did not cause it and does not see it coming.`,
    `Make it land, and ${INTENSITY_COPY[twist.intensity]}.`,
    `Stay in the scene and let ${names.char} react.`
  ].join(' ');
}

/**
 * A turn the user did not write — a thrown twist, a beat of silence when the
 * moment passed. It travels with the next generation and leaves a chip on the
 * turn it landed on, so the story can be read back honestly.
 */
export interface StoryTurn {
  /** Sent to the model. */
  instruction: string;
  /** Shown on the chip above the turn it landed on. */
  label: string;
  kind?: TwistKind;
  intensity?: TwistIntensity;
}

export function makeTwistTurn(twist: StoryTwist, names: { char: string; user: string }): StoryTurn {
  return {
    instruction: twistInstruction(twist, names),
    label: twist.vector.text,
    kind: twist.vector.kind,
    intensity: twist.intensity
  };
}

/** The turn sent when a clocked choice runs out with nothing said. */
export function makeSilenceTurn(names: { char: string; user: string }): StoryTurn {
  return {
    instruction: [
      `[Story beat — ${names.user} says nothing; the moment passes.]`,
      `Let the silence land and carry the scene forward on its own.`,
      `${names.user} neither speaks nor acts this turn.`,
      `Stay in the scene and let ${names.char} respond to the quiet.`
    ].join(' '),
    label: `${names.user} says nothing`
  };
}
