import { describe, expect, it } from 'vitest';
import {
  answerFor,
  buildStuckMessage,
  canAdvance,
  createLessonState,
  hintLadderStep,
  reduceLesson
} from '$lib/ui/components/lesson-runner';
import type { LessonBlock } from '$lib/types/chat';

const blocks: LessonBlock[] = [
  { type: 'choice', prompt: 'Which?', choices: [{ text: 'A', correct: true }, { text: 'B', why: 'No.' }] },
  { type: 'steps', prompt: 'Work', steps: [{ note: 'One.' }] },
  { type: 'summary', points: ['x'] }
];

describe('lesson runner', () => {
  it('has no score, points or streak in its state', () => {
    const state = createLessonState(0);
    expect(Object.keys(state).sort()).toEqual(['answers', 'hints', 'index', 'submitted']);
    expect(JSON.stringify(state)).not.toMatch(/score|points|streak|percent/i);
  });

  it('records an answer without ranking it', () => {
    let state = createLessonState(0);
    state = reduceLesson(state, { type: 'answer', index: 0, value: 'B', correct: false });
    expect(answerFor(state, 0)).toEqual({ value: 'B', correct: false });
    expect(Object.keys(answerFor(state, 0)!).sort()).toEqual(['correct', 'value']);
  });

  it('clamps navigation to the blocks that exist', () => {
    let state = createLessonState(0);
    state = reduceLesson(state, { type: 'back' });
    expect(state.index).toBe(0);
    state = reduceLesson(state, { type: 'next', count: blocks.length });
    state = reduceLesson(state, { type: 'next', count: blocks.length });
    state = reduceLesson(state, { type: 'next', count: blocks.length });
    expect(state.index).toBe(blocks.length - 1);
    state = reduceLesson(state, { type: 'goto', index: 99, count: blocks.length });
    expect(state.index).toBe(blocks.length - 1);
    state = reduceLesson(state, { type: 'restart' });
    expect(state.index).toBe(0);
    expect(state.answers).toEqual({});
  });

  it('advances past an answered question and holds an unanswered one', () => {
    let state = createLessonState(0);
    expect(canAdvance(state, blocks[0])).toBe(false);
    state = reduceLesson(state, { type: 'answer', index: 0, value: 'B', correct: false });
    expect(canAdvance(state, blocks[0])).toBe(true);
    expect(canAdvance(state, blocks[1])).toBe(true);
  });

  it('caps the help ladder at three steps', () => {
    let state = createLessonState(0);
    expect(hintLadderStep(state, 0)).toBe(0);
    for (let i = 0; i < 6; i += 1) state = reduceLesson(state, { type: 'hint', index: 0 });
    expect(hintLadderStep(state, 0)).toBe(3);
  });

  it('quotes the block and the answer when the reader is stuck', () => {
    let state = createLessonState(1);
    state = reduceLesson(state, { type: 'answer', index: 1, value: '3.5', correct: false });
    const message = buildStuckMessage({ title: 'Chain rule', index: 1, blocks, state, block: blocks[1] });
    expect(message).toContain('Chain rule');
    expect(message).toContain('block 2 of 3');
    expect(message).toContain('3.5');
    expect(message).toContain('do not create another lesson');
  });
});
