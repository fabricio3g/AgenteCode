import type { LessonBlock } from '$lib/types/chat';

/**
 * The lesson state machine, deliberately free of Svelte so it can be tested and
 * so nothing in it can grow into a scoreboard.
 *
 * There is no score, no streak, no accuracy and no timer here — only where the
 * reader is, what they answered, and how many times they asked for help (which
 * decides how much of an explanation to reveal next, and is never displayed).
 */

export interface LessonAnswer {
  /** What the reader chose/typed, kept so the "I'm stuck" message can quote it. */
  value: string | number;
  correct: boolean;
}

export interface LessonState {
  index: number;
  answers: Record<number, LessonAnswer>;
  hints: Record<number, number>;
  submitted: Record<number, boolean>;
}

export type LessonEvent =
  | { type: 'answer'; index: number; value: string | number; correct: boolean }
  | { type: 'hint'; index: number }
  | { type: 'next'; count: number }
  | { type: 'back' }
  | { type: 'goto'; index: number; count: number }
  | { type: 'restart' };

export function createLessonState(index = 0): LessonState {
  return { index: Math.max(0, Math.floor(index)), answers: {}, hints: {}, submitted: {} };
}

function clamp(index: number, count: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.floor(index)), Math.max(0, count - 1));
}

export function reduceLesson(state: LessonState, event: LessonEvent): LessonState {
  switch (event.type) {
    case 'answer':
      return {
        ...state,
        answers: { ...state.answers, [event.index]: { value: event.value, correct: event.correct } },
        submitted: { ...state.submitted, [event.index]: true }
      };
    case 'hint':
      return { ...state, hints: { ...state.hints, [event.index]: (state.hints[event.index] ?? 0) + 1 } };
    case 'next':
      return { ...state, index: clamp(state.index + 1, event.count) };
    case 'back':
      return { ...state, index: Math.max(0, state.index - 1) };
    case 'goto':
      return { ...state, index: clamp(event.index, event.count) };
    case 'restart':
      return createLessonState(0);
    default:
      return state;
  }
}

/** How much help to show for this block: 0 nothing yet, 1 the reason, 2 the hint, 3 the worked steps. */
export function hintLadderStep(state: LessonState, index: number): number {
  return Math.min(3, state.hints[index] ?? 0);
}

export function answerFor(state: LessonState, index: number): LessonAnswer | undefined {
  return state.answers[index];
}

/** Blocks that hold the reader until they answer; everything else just advances. */
export function isQuestion(block: LessonBlock | undefined): boolean {
  return !!block && ['pretest', 'choice', 'numeric', 'predict'].includes(block.type);
}

export function canAdvance(state: LessonState, block: LessonBlock | undefined): boolean {
  if (!isQuestion(block)) return true;
  return !!state.submitted[state.index] || !!state.answers[state.index]?.correct;
}

/**
 * The message the "I'm stuck" button sends. It carries the block, the answer so
 * far and the help already given, so the model that wrote this block can answer
 * the actual confusion instead of restating the lesson.
 */
export function buildStuckMessage(opts: {
  title: string;
  index: number;
  blocks: LessonBlock[];
  state: LessonState;
  block: LessonBlock | undefined;
}): string {
  const { title, index, blocks, state, block } = opts;
  const answer = state.answers[index];
  const promptText = block && 'prompt' in block && typeof block.prompt === 'string' ? block.prompt.trim() : '';
  const answerText = answer ? String(answer.value) : 'nothing yet';
  return [
    `In the lesson "${title}", block ${index + 1} of ${blocks.length}:`,
    promptText ? `"${promptText}"` : '',
    `My answer so far: ${answerText}.`,
    `I'm stuck. Explain this step in prose, briefly — do not create another lesson.`
  ].filter(Boolean).join('\n');
}
